// Edeler Döner – kleine API für Website-Einstellungen und Admin-Bereich.
// Läuft als Netlify Function, Daten liegen in Netlify Blobs (kein eigener Server, keine Zusatz-Anbieter).
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
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
  const rec = (await getUsers(store)).users[name];
  return rec && String(rec.tv) === tv ? name : null;
}

/* ---------- Schutz vor Passwort-Raten ---------- */
const LOCK_AFTER = 5, LOCK_MIN = 10, IP_LIMIT = 30;
async function lockState(store, key) {
  const x = await store.get(`auth/fail/${sha256(key)}`, { type: "json" });
  return x && x.until > Date.now() ? Math.ceil((x.until - Date.now()) / 60000) : 0;
}
async function noteFailure(store, key, limit) {
  const k = `auth/fail/${sha256(key)}`;
  const x = (await store.get(k, { type: "json" })) || { count: 0, until: 0 };
  const count = x.until && x.until < Date.now() ? 1 : x.count + 1;
  await store.setJSON(k, { count, until: count >= limit ? Date.now() + LOCK_MIN * 60e3 : 0 });
}
const clearFailures = (store, key) => store.delete(`auth/fail/${sha256(key)}`);

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
    if (method === "GET" && (pm = /^photo\/([a-f0-9]{16,40})(-480)?\.webp$/.exec(path))) {
      const r = await store.getWithMetadata(`photo/${pm[1]}/${pm[2] ? "480" : "800"}`, { type: "arrayBuffer" });
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
      const ipLock = await lockState(store, `ip:${ip}`);
      if (ipLock) return fail(429, `Zu viele Versuche. Bitte in ${ipLock} Minuten erneut versuchen.`);
      const body = await readBody(req, 4096);
      const users = await getUsers(store);
      if (Object.keys(users.users).length) return fail(409, "Der Admin-Bereich ist bereits eingerichtet. Bitte normal anmelden.");
      const code = String(body.code || "").trim().toUpperCase();
      if (!safeEqual(sha256(code), SETUP_CODE_SHA256)) {
        await noteFailure(store, `ip:${ip}`, LOCK_AFTER);
        return fail(403, "Der Einrichtungs-Code ist falsch.");
      }
      const user = String(body.user || "").trim();
      if (!USER_RE.test(user)) return fail(400, "Benutzername: 3–30 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus oder Unterstrich.");
      const pwErr = checkNewPassword(body.password);
      if (pwErr) return fail(400, pwErr);
      const doc = { users: { [user]: { hash: await hashPassword(body.password), tv: 1, created: new Date().toISOString() } } };
      const res = await store.setJSON("auth/users", doc, { onlyIfNew: true });
      if (res && res.modified === false) return fail(409, "Der Admin-Bereich wurde gerade eingerichtet. Bitte normal anmelden.");
      return json({ ok: true, user }, 200, { "set-cookie": sessionCookie(makeToken(await getSecret(store), user, 1)) });
    }

    if (path === "auth/login" && method === "POST") {
      const body = await readBody(req, 4096);
      const user = String(body.user || "").trim();
      const lock = Math.max(await lockState(store, `user:${user.toLowerCase()}`), await lockState(store, `ip:${ip}`));
      if (lock) return fail(429, `Zu viele Fehlversuche. Bitte in ${lock} Minuten erneut versuchen.`);
      const rec = (await getUsers(store)).users[user];
      const ok = await checkPassword(String(body.password || ""), rec?.hash);   // läuft auch bei unbekanntem Namen (gleiche Dauer)
      if (!rec || !ok) {
        await noteFailure(store, `user:${user.toLowerCase()}`, LOCK_AFTER);
        await noteFailure(store, `ip:${ip}`, IP_LIMIT);
        return fail(401, "Benutzername oder Passwort ist falsch.");
      }
      await clearFailures(store, `user:${user.toLowerCase()}`);
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
      return saveSettings(store, old.data, `${me} (wiederhergestellt: Version ${old.version})`, Number(body.baseVersion) || 0);
    }

    if (path === "admin/password" && method === "POST") {
      const body = await readBody(req, 4096);
      const users = await getUsers(store);
      if (!(await checkPassword(String(body.current || ""), users.users[me].hash))) return fail(400, "Das aktuelle Passwort ist falsch.");
      const pwErr = checkNewPassword(body.next);
      if (pwErr) return fail(400, pwErr);
      users.users[me] = { ...users.users[me], hash: await hashPassword(body.next), tv: users.users[me].tv + 1 };
      await store.setJSON("auth/users", users);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(makeToken(await getSecret(store), me, users.users[me].tv)) });
    }

    if (path === "admin/users" && method === "POST") {
      const body = await readBody(req, 4096);
      const user = String(body.user || "").trim();
      const users = await getUsers(store);
      if (!USER_RE.test(user)) return fail(400, "Benutzername: 3–30 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus oder Unterstrich.");
      if (users.users[user]) return fail(409, "Diesen Benutzernamen gibt es schon.");
      if (Object.keys(users.users).length >= MAX_USERS) return fail(400, `Höchstens ${MAX_USERS} Zugänge möglich.`);
      const pwErr = checkNewPassword(body.password);
      if (pwErr) return fail(400, pwErr);
      users.users[user] = { hash: await hashPassword(body.password), tv: 1, created: new Date().toISOString(), by: me };
      await store.setJSON("auth/users", users);
      return json({ ok: true, users: Object.keys(users.users).sort() });
    }

    let um;
    if ((um = /^admin\/users\/([^/]+)(\/password)?$/.exec(path))) {
      const name = decodeURIComponent(um[1]);
      const users = await getUsers(store);
      if (!users.users[name]) return fail(404, "Diesen Zugang gibt es nicht.");
      if (method === "DELETE" && !um[2]) {
        if (name === me) return fail(400, "Du kannst deinen eigenen Zugang nicht löschen.");
        delete users.users[name];
        await store.setJSON("auth/users", users);
        return json({ ok: true, users: Object.keys(users.users).sort() });
      }
      if (method === "POST" && um[2]) {
        const body = await readBody(req, 4096);
        const pwErr = checkNewPassword(body.password);
        if (pwErr) return fail(400, pwErr);
        users.users[name] = { ...users.users[name], hash: await hashPassword(body.password), tv: users.users[name].tv + 1 };
        await store.setJSON("auth/users", users);
        return json({ ok: true });
      }
    }

    if (path === "admin/photo" && method === "POST") {
      const body = await readBody(req, 1600 * 1024);
      const large = decodeImage(body.large, "Großes Bild"), small = decodeImage(body.small, "Kleines Bild");
      const id = randomBytes(10).toString("hex");
      await store.set(`photo/${id}/800`, large.buf, { metadata: { type: large.type, by: me } });
      await store.set(`photo/${id}/480`, small.buf, { metadata: { type: small.type, by: me } });
      return json({ ok: true, photo: `/api/photo/${id}` });
    }

    return fail(404, "Unbekannte Anfrage.");
  } catch (e) {
    if (e && e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, "Interner Fehler – bitte später erneut versuchen.");
  }
}
