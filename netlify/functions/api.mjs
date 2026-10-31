// Edeler Döner – kleine API für Website-Einstellungen und Admin-Bereich.
// Läuft als Netlify Function, Daten liegen in Netlify Blobs (kein eigener Server, keine Zusatz-Anbieter).
import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { validateSettings, ValidationError } from "./lib/validate.mjs";

export const config = { path: "/api/*" };

const scrypt = promisify(scryptCb);
// Einmal-Code für die erste Einrichtung des Admin-Bereichs. Hier steht nur der SHA-256-Hash.
const SETUP_CODE_SHA256 = "1a0cb9437b0fce96b9a6f21e6f4a65e2c9b10af64ca38ff91a4cce2c9dc84a2e";
const COOKIE = "__Host-edeler_admin";
const SESSION_HOURS = 12;
const MAX_USERS = 10;
const HISTORY_KEEP = 30;
const LIVE_HOSTS = new Set(["edeler-doener.de", "www.edeler-doener.de", "edeler.netlify.app"]);

/* ---------- Speicher: Live-Seite und Test-Vorschauen strikt getrennt ---------- */
async function openStore(req) {
  const host = new URL(req.url).hostname;
  const name = LIVE_HOSTS.has(host) ? "edeler-live" : "edeler-preview";
  if (globalThis.__EDELER_STORE__) return globalThis.__EDELER_STORE__(name);   // nur für lokale Tests
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name, consistency: "strong" });
}

/* ---------- Antworten ---------- */
const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex" };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

async function readBody(req, maxBytes) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw Object.assign(new Error("Die Daten sind zu groß."), { status: 413 });
  const raw = await req.text();
  if (raw.length > maxBytes) throw Object.assign(new Error("Die Daten sind zu groß."), { status: 413 });
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Ungültige Anfrage."), { status: 400 }); }
}

/* ---------- Kleine Krypto-Helfer ---------- */
const b64url = buf => Buffer.from(buf).toString("base64url");
const sha256 = s => createHash("sha256").update(s).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
async function hashPassword(pw, salt = randomBytes(16)) {
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(pw, stored) {
  const [, salt, key] = String(stored || "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$").split("$");
  const test = await hashPassword(pw, Buffer.from(salt, "base64"));
  return safeEqual(test, stored);
}

/* ---------- Zugänge & Sitzungen ---------- */
const USER_RE = /^[A-Za-z0-9äöüÄÖÜß._-]{3,30}$/;
function checkNewPassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Das Passwort muss mindestens 10 Zeichen lang sein.";
  if (pw.length > 128) return "Das Passwort ist zu lang.";
  return null;
}
async function getUsers(store) { return (await store.get("auth/users", { type: "json" })) || { users: {} }; }
/* Zugänge mit ETag laden/speichern, damit gleichzeitige Änderungen sich nicht überschreiben */
async function loadUsers(store) {
  const r = await store.getWithMetadata("auth/users", { type: "json" });
  return { users: r?.data || { users: {} }, etag: r?.etag };
}
async function storeUsers(store, users, etag) {
  const res = await store.setJSON("auth/users", users, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
  if (res && res.modified === false) throw Object.assign(new Error("Gleichzeitig geändert – bitte nochmal versuchen."), { status: 409 });
}
const userRec = (users, name) => (Object.hasOwn(users.users, name) ? users.users[name] : undefined);
// Zufälliger Startwert: ein gelöschter und neu angelegter Zugang mit gleichem Namen macht alte Cookies nicht wieder gültig
const newTv = () => randomInt(1, 2 ** 40);
async function getSecret(store) {
  let s = await store.get("auth/secret", { type: "json" });
  if (!s) {
    await store.setJSON("auth/secret", { key: randomBytes(32).toString("base64") }, { onlyIfNew: true });
    s = await store.get("auth/secret", { type: "json" });
  }
  return Buffer.from(s.key, "base64");
}
function makeToken(secret, user, tv) {
  const payload = `${b64url(user)}.${Date.now() + SESSION_HOURS * 3600e3}.${tv}`;
  return `${payload}.${b64url(createHmac("sha256", secret).update(payload).digest())}`;
}
const sessionCookie = token => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

async function currentUser(req, store) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-_]/g, "\\$&")}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 4) return null;
  const [u, exp, tv, sig] = parts;
  const secret = await getSecret(store);
  if (!safeEqual(sig, b64url(createHmac("sha256", secret).update(`${u}.${exp}.${tv}`).digest()))) return null;
  if (Number(exp) < Date.now()) return null;
  const name = Buffer.from(u, "base64url").toString();
  const rec = userRec(await getUsers(store), name);
  return rec && String(rec.tv) === tv ? name : null;
}

/* ---------- Schutz vor Passwort-Raten ---------- */
// Jeder Versuch wird VOR der (langsamen) Passwort-Prüfung atomar gezählt – so helfen auch parallele Anfragen nicht.
// Grenzen je 15-Minuten-Fenster: 5 je Name+IP, 30 je IP, 100 je Name (verteilte Angriffe). Erfolg setzt die Zähler zurück.
const WINDOW_MIN = 15, LOCK_MIN = 10;
const LIMIT = { userIp: 5, ip: 30, user: 100, setup: 5, confirm: 5 };
async function countAttempt(store, key, limit) {
  const k = `auth/fail/${sha256(key)}`;
  for (let i = 0; i < 8; i++) {
    const cur = await store.getWithMetadata(k, { type: "json" });
    const now = Date.now();
    let x = cur?.data;
    if (x && x.until > now) return Math.ceil((x.until - now) / 60000);
    if (!x || x.until || now - x.first > WINDOW_MIN * 60e3) x = { count: 0, first: now, until: 0 };
    x.count += 1;
    if (x.count > limit) x.until = now + LOCK_MIN * 60e3;
    const res = await store.setJSON(k, x, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res && res.modified === false) continue;            // gleichzeitig gezählt → nochmal lesen
    return x.until ? LOCK_MIN : 0;
  }
  return LOCK_MIN;                                         // zu viel Andrang → sicherheitshalber sperren
}
const clearAttempts = (store, ...keys) => Promise.all(keys.map(key => store.delete(`auth/fail/${sha256(key)}`)));

/* ---------- Einstellungen ---------- */
async function loadCurrent(store) { return store.getWithMetadata("settings/current", { type: "json" }); }

async function saveSettings(store, data, by, baseVersion) {
  const cur = await loadCurrent(store);
  const curVersion = cur?.data?.version || 0;
  if (baseVersion !== curVersion) {
    return fail(409, "Jemand anderes hat in der Zwischenzeit gespeichert. Bitte Seite neu laden – deine Eingaben bitte danach erneut machen.", { version: curVersion });
  }
  const doc = { version: curVersion + 1, savedAt: new Date().toISOString(), by, data };
  const res = await store.setJSON("settings/current", doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  if (res && res.modified === false) return fail(409, "Gleichzeitig gespeichert – bitte Seite neu laden.");
  await store.setJSON(`settings/history/${String(doc.version).padStart(6, "0")}`, doc);
  const index = ((await store.get("settings/index", { type: "json" })) || []).filter(x => x.version !== doc.version);
  index.unshift({ version: doc.version, savedAt: doc.savedAt, by });
  for (const old of index.splice(HISTORY_KEEP)) await store.delete(`settings/history/${String(old.version).padStart(6, "0")}`);
  await store.setJSON("settings/index", index);
  return json({ ok: true, version: doc.version, savedAt: doc.savedAt });
}

/* ---------- Fotos ---------- */
const IMG_TYPES = { "image/webp": b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
                    "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff };
function decodeImage(dataUrl, label) {
  const m = /^data:(image\/(?:webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw Object.assign(new Error(`${label}: nur WebP- oder JPEG-Bilder erlaubt.`), { status: 400 });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 600 * 1024) throw Object.assign(new Error(`${label}: Bild ist zu groß.`), { status: 413 });
  if (!IMG_TYPES[m[1]](buf)) throw Object.assign(new Error(`${label}: Datei ist kein gültiges Bild.`), { status: 400 });
  return { type: m[1], buf };
}

/* ---------- Router ---------- */
export default async function handler(req, context) {
  try {
    const store = await openStore(req);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const method = req.method;
    const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";

    // Öffentlich: aktuelle Einstellungen für die Website (kurz im CDN zwischengespeichert)
    if (path === "settings" && method === "GET") {
      const cur = await loadCurrent(store);
      const cache = { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, durable, s-maxage=10, stale-while-revalidate=60", "x-robots-tag": "noindex" };
      if (!cur) return json({ version: 0, savedAt: null, settings: null }, 200, cache);   // noch nie gespeichert → Website nutzt Grundeinstellung
      return json({ version: cur.data.version, savedAt: cur.data.savedAt, settings: cur.data.data }, 200, cache);
    }
    // Öffentlich: hochgeladene Fotos
    let pm;
    if (method === "GET" && (pm = /^photo\/([a-f0-9]{16,40})(?:-(480|640))?\.webp$/.exec(path))) {
      // 640 = Handy-Größe (fehlt sie bei älteren Fotos, wird die große Version geliefert)
      let r = await store.getWithMetadata(`photo/${pm[1]}/${pm[2] || "800"}`, { type: "arrayBuffer" });
      if (!r && pm[2] === "640") r = await store.getWithMetadata(`photo/${pm[1]}/800`, { type: "arrayBuffer" });
      if (!r) return new Response("Nicht gefunden", { status: 404 });
      return new Response(r.data, { headers: { "content-type": r.metadata?.type || "image/webp", "cache-control": "public, max-age=31536000, immutable" } });
    }

    // Ab hier nur Admin: Schutz gegen Fremd-Seiten (CSRF)
    if (method !== "GET" && req.headers.get("x-edeler-admin") !== "1") return fail(403, "Anfrage abgelehnt.");

    if (path === "auth/status" && method === "GET") {
      const users = await getUsers(store);
      return json({ setupDone: Object.keys(users.users).length > 0, user: await currentUser(req, store) });
    }

    if (path === "auth/setup" && method === "POST") {
      const ipLock = await countAttempt(store, `setup:${ip}`, LIMIT.setup);
      if (ipLock) return fail(429, `Zu viele Versuche. Bitte in ${ipLock} Minuten erneut versuchen.`);
      const body = await readBody(req, 4096);
      const users = await getUsers(store);
      if (Object.keys(users.users).length) return fail(409, "Der Admin-Bereich ist bereits eingerichtet. Bitte normal anmelden.");
      const code = String(body.code || "").trim().toUpperCase();
      if (!safeEqual(sha256(code), SETUP_CODE_SHA256)) return fail(403, "Der Einrichtungs-Code ist falsch.");
      const user = String(body.user || "").trim();
      if (!USER_RE.test(user)) return fail(400, "Benutzername: 3–30 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus oder Unterstrich.");
      const pwErr = checkNewPassword(body.password);
      if (pwErr) return fail(400, pwErr);
      const tv = newTv();
      const doc = { users: { [user]: { hash: await hashPassword(body.password), tv, created: new Date().toISOString() } } };
      const res = await store.setJSON("auth/users", doc, { onlyIfNew: true });
      if (res && res.modified === false) return fail(409, "Der Admin-Bereich wurde gerade eingerichtet. Bitte normal anmelden.");
      return json({ ok: true, user }, 200, { "set-cookie": sessionCookie(makeToken(await getSecret(store), user, tv)) });
    }

    if (path === "auth/login" && method === "POST") {
      const body = await readBody(req, 4096);
      const user = String(body.user || "").trim().slice(0, 60);
      const lc = user.toLowerCase();
      const lock = (await countAttempt(store, `ip:${ip}`, LIMIT.ip)) || (await countAttempt(store, `userip:${lc}|${ip}`, LIMIT.userIp))
        || (await countAttempt(store, `user:${lc}`, LIMIT.user));
      if (lock) return fail(429, `Zu viele Fehlversuche. Bitte in ${lock} Minuten erneut versuchen.`);
      const rec = userRec(await getUsers(store), user);
      const ok = await checkPassword(String(body.password || ""), rec?.hash);   // läuft auch bei unbekanntem Namen (gleiche Dauer)
      if (!rec || !ok) return fail(401, "Benutzername oder Passwort ist falsch.");
      await clearAttempts(store, `ip:${ip}`, `userip:${lc}|${ip}`, `user:${lc}`);
      return json({ ok: true, user }, 200, { "set-cookie": sessionCookie(makeToken(await getSecret(store), user, rec.tv)) });
    }

    if (path === "auth/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie });

    // Ab hier: angemeldet sein
    const me = await currentUser(req, store);
    if (!me) return fail(401, "Bitte neu anmelden.", { relogin: true });

    if (path === "admin/state" && method === "GET") {
      const cur = await loadCurrent(store);
      const users = await getUsers(store);
      return json({ user: me, users: Object.keys(users.users).sort(), version: cur?.data?.version || 0,
                    savedAt: cur?.data?.savedAt || null, by: cur?.data?.by || null, settings: cur?.data?.data || null });
    }

    if (path === "admin/settings" && method === "PUT") {
      const body = await readBody(req, 400 * 1024);
      let clean;
      try { clean = validateSettings(body.settings); }
      catch (e) { if (e instanceof ValidationError) return fail(422, e.message, { field: e.path }); throw e; }
      return saveSettings(store, clean, me, Number(body.baseVersion) || 0);
    }

    if (path === "admin/history" && method === "GET") return json({ history: (await store.get("settings/index", { type: "json" })) || [] });

    if (path === "admin/restore" && method === "POST") {
      const body = await readBody(req, 4096);
      const old = await store.get(`settings/history/${String(Number(body.version) || 0).padStart(6, "0")}`, { type: "json" });
      if (!old) return fail(404, "Diese Version gibt es nicht mehr.");
      let clean;
      try { clean = validateSettings(old.data); }
      catch (e) { if (e instanceof ValidationError) return fail(422, `Diese Version passt nicht mehr zu den aktuellen Regeln: ${e.message}`, { field: e.path }); throw e; }
      return saveSettings(store, clean, `${me} (wiederhergestellt: Version ${old.version})`, Number(body.baseVersion) || 0);
    }

    // Eigenes Passwort zur Bestätigung (Passwort ändern, Zugänge verwalten) – mit Versuchs-Grenze
    const confirmOwn = async (users, pw) => {
      const lock = await countAttempt(store, `confirm:${me}`, LIMIT.confirm);
      if (lock) throw Object.assign(new Error(`Zu viele Fehlversuche. Bitte in ${lock} Minuten erneut versuchen.`), { status: 429 });
      if (!(await checkPassword(String(pw || ""), userRec(users, me)?.hash)))
        throw Object.assign(new Error("Dein Passwort zur Bestätigung ist falsch."), { status: 403 });
      await clearAttempts(store, `confirm:${me}`);
    };

    if (path === "admin/password" && method === "POST") {
      const body = await readBody(req, 4096);
      const { users, etag } = await loadUsers(store);
      try { await confirmOwn(users, body.current); }
      catch (e) { if (e.status === 403) return fail(400, "Das aktuelle Passwort ist falsch."); throw e; }
      const pwErr = checkNewPassword(body.next);
      if (pwErr) return fail(400, pwErr);
      users.users[me] = { ...users.users[me], hash: await hashPassword(body.next), tv: users.users[me].tv + 1 };
      await storeUsers(store, users, etag);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(makeToken(await getSecret(store), me, users.users[me].tv)) });
    }

    if (path === "admin/users" && method === "POST") {
      const body = await readBody(req, 4096);
      const user = String(body.user || "").trim();
      const { users, etag } = await loadUsers(store);
      if (!USER_RE.test(user)) return fail(400, "Benutzername: 3–30 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus oder Unterstrich.");
      if (Object.keys(users.users).some(n => n.toLowerCase() === user.toLowerCase())) return fail(409, "Diesen Benutzernamen gibt es schon.");
      if (Object.keys(users.users).length >= MAX_USERS) return fail(400, `Höchstens ${MAX_USERS} Zugänge möglich.`);
      const pwErr = checkNewPassword(body.password);
      if (pwErr) return fail(400, pwErr);
      await confirmOwn(users, body.confirm);
      users.users[user] = { hash: await hashPassword(body.password), tv: newTv(), created: new Date().toISOString(), by: me };
      await storeUsers(store, users, etag);
      return json({ ok: true, users: Object.keys(users.users).sort() });
    }

    let um;
    if ((um = /^admin\/users\/([^/]+)(\/password)?$/.exec(path))) {
      let name;
      try { name = decodeURIComponent(um[1]); } catch { return fail(400, "Ungültiger Name."); }
      const { users, etag } = await loadUsers(store);
      if (!USER_RE.test(name) || !userRec(users, name)) return fail(404, "Diesen Zugang gibt es nicht.");
      if (method === "DELETE" && !um[2]) {
        if (name === me) return fail(400, "Du kannst deinen eigenen Zugang nicht löschen.");
        const body = await readBody(req, 4096);
        await confirmOwn(users, body.confirm);
        delete users.users[name];
        await storeUsers(store, users, etag);
        return json({ ok: true, users: Object.keys(users.users).sort() });
      }
      if (method === "POST" && um[2]) {
        const body = await readBody(req, 4096);
        const pwErr = checkNewPassword(body.password);
        if (pwErr) return fail(400, pwErr);
        await confirmOwn(users, body.confirm);
        users.users[name] = { ...users.users[name], hash: await hashPassword(body.password), tv: users.users[name].tv + 1 };
        await storeUsers(store, users, etag);
        return json({ ok: true });
      }
    }

    if (path === "admin/photo" && method === "POST") {
      const body = await readBody(req, 2400 * 1024);
      const large = decodeImage(body.large, "Großes Bild"), small = decodeImage(body.small, "Kleines Bild");
      const medium = body.medium ? decodeImage(body.medium, "Mittleres Bild") : null;   // vorher prüfen, damit nichts halb gespeichert wird
      const id = randomBytes(10).toString("hex");
      await store.set(`photo/${id}/800`, large.buf, { metadata: { type: large.type, by: me } });
      await store.set(`photo/${id}/480`, small.buf, { metadata: { type: small.type, by: me } });
      if (medium) await store.set(`photo/${id}/640`, medium.buf, { metadata: { type: medium.type, by: me } });
      return json({ ok: true, photo: `/api/photo/${id}` });
    }

    return fail(404, "Unbekannte Anfrage.");
  } catch (e) {
    if (e && e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, "Interner Fehler – bitte später erneut versuchen.");
  }
}
