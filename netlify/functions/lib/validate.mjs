// Strenge Prüfung und Bereinigung der Einstellungen aus dem Admin-Bereich.
// Nur bekannte Felder werden übernommen; jede Fehlermeldung ist auf Deutsch und nennt das Feld.

export const CATEGORIES = ["doener", "lahmacun", "pizza", "vegetarisch", "fingerfood", "getraenke"];
export const OPTION_TYPES = ["wrap", "box", "plate", "extra", "none"];
export const TAGS = ["halal", "vegetarisch", "scharf"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PHOTO_RE = /^(img\/[a-z0-9-]{1,60}|\/api\/photo\/[a-f0-9]{16,40})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ValidationError extends Error {
  constructor(path, message) { super(message); this.path = path; }
}
const fail = (path, msg) => { throw new ValidationError(path, msg); };
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v, path, label) => (isObj(v) ? v : fail(path, `${label}: ungültige Angabe`));
const arr = (v, path, label, max) => {
  if (!Array.isArray(v)) fail(path, `${label}: ungültige Liste`);
  if (v.length > max) fail(path, `${label}: höchstens ${max} Einträge möglich`);
  return v;
};

/** Text: Steuerzeichen und spitze Klammern raus, Leerraum zusammenfassen, Länge prüfen. */
export function text(v, path, label, { max = 200, required = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string" && typeof v !== "number") fail(path, `${label}: ungültiger Text`);
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ")
    .replace(/[\u00ad\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")   // unsichtbare Zeichen / Schreibrichtungs-Tricks
    .replace(/\s+/g, " ").trim();
  if (required && !s) fail(path, `${label} fehlt`);
  if (s.length > max) fail(path, `${label} ist zu lang (höchstens ${max} Zeichen)`);
  return s;
}
/** Geldbetrag in Euro, auf Cent gerundet. */
export function money(v, path, label, { min = 0, max = 500 } = {}) {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n)) fail(path, `${label}: bitte einen Betrag eingeben`);
  if (n < min || n > max) fail(path, `${label}: Betrag muss zwischen ${min} und ${max} € liegen`);
  return Math.round(n * 100) / 100;
}
const bool = v => v === true;
function time(v, path, label, { allowEmpty = false } = {}) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s && allowEmpty) return "";
  if (!TIME_RE.test(s)) fail(path, `${label}: bitte eine Uhrzeit wie 11:00 eingeben`);
  return s;
}
const unique = (list, path, label) => {
  const seen = new Set();
  list.forEach((x, i) => { const k = x.toLowerCase(); if (seen.has(k)) fail(`${path}.${i}`, `${label} „${x}“ ist doppelt`); seen.add(k); });
  return list;
};

/** Telefonnummer zum Anrufen: Ziffern, optional mit + am Anfang. */
export function phone(v, path, label) {
  const raw = text(v, path, label, { max: 30, required: true });
  const s = raw.replace(/[\s\-/().]/g, "");
  if (!/^\+?\d{6,15}$/.test(s)) fail(path, `${label}: bitte nur Ziffern, z. B. 0178 1804021`);
  return s;
}
/** WhatsApp-Nummer international ohne + (0178… und +49 178… werden umgewandelt). */
export function whatsapp(v, path, label) {
  let s = text(v, path, label, { max: 30, required: true }).replace(/\D/g, "");
  if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) s = "49" + s.slice(1);
  if (!/^[1-9]\d{7,14}$/.test(s)) fail(path, `${label}: bitte eine gültige Handynummer eingeben, z. B. 0178 1804021`);
  return s;
}
function url(v, path, label, hosts) {
  const s = text(v, path, label, { max: 200 });
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { fail(path, `${label}: bitte einen vollständigen Link mit https:// eingeben`); }
  if (u.protocol !== "https:" || !hosts.some(h => u.hostname === h || u.hostname.endsWith("." + h)))
    fail(path, `${label}: nur Links zu ${hosts.join(" oder ")} erlaubt`);
  return u.href;
}

function validateMenu(list) {
  arr(list, "menu", "Speisekarte", 200);
  if (!list.length) fail("menu", "Die Speisekarte braucht mindestens ein Gericht");
  const ids = new Set();
  const useId = (id, path) => {
    if (typeof id !== "string" || !ID_RE.test(id)) fail(path, "Interne Kennung ist ungültig");
    if (ids.has(id)) fail(path, "Interne Kennung ist doppelt");
    ids.add(id);
    return id;
  };
  return list.map((raw, i) => {
    const p = `menu.${i}`;
    const it = obj(raw, p, "Gericht");
    const name = text(it.name, `${p}.name`, "Name des Gerichts", { max: 60, required: true });
    const out = {
      id: useId(it.id, `${p}.id`),
      cat: CATEGORIES.includes(it.cat) ? it.cat : fail(`${p}.cat`, `${name}: bitte eine Kategorie wählen`),
      name,
      desc: text(it.desc, `${p}.desc`, `${name}: Beschreibung`, { max: 220 })
    };
    if (Array.isArray(it.variants) && it.variants.length) {
      arr(it.variants, `${p}.variants`, `${name}: Varianten`, 4);
      out.variants = it.variants.map((rv, j) => {
        const v = obj(rv, `${p}.variants.${j}`, "Variante");
        const vp = `${p}.variants.${j}`;
        return {
          id: useId(v.id, `${vp}.id`),
          label: text(v.label, `${vp}.label`, `${name}: Name der Variante`, { max: 20, required: true }),
          price: money(v.price, `${vp}.price`, `${name}: Preis`, { min: 0, max: 500 })
        };
      });
      unique(out.variants.map(v => v.label), `${p}.variants`, `${name}: Variante`);
    } else {
      out.price = money(it.price, `${p}.price`, `${name}: Preis`, { min: 0, max: 500 });
    }
    out.tags = Array.isArray(it.tags) ? TAGS.filter(t => it.tags.includes(t)) : [];
    out.popular = bool(it.popular);
    out.available = it.available !== false;
    const photo = typeof it.photo === "string" ? it.photo.trim() : "";
    if (photo && !PHOTO_RE.test(photo)) fail(`${p}.photo`, `${name}: Foto ist ungültig`);
    out.photo = photo;
    out.options = OPTION_TYPES.includes(it.options) ? it.options : fail(`${p}.options`, `${name}: bitte die Auswahl beim Bestellen festlegen`);
    out.side = out.options !== "none" && bool(it.side);   // Beilagen-Wahl nur bei Gerichten mit Auswahl
    return out;
  });
}

function validateExtras(e) {
  obj(e, "extras", "Extras");
  const ingredients = arr(e.ingredients, "extras.ingredients", "Zutaten", 20).map((r, i) => {
    const x = obj(r, `extras.ingredients.${i}`, "Zutat");
    return { name: text(x.name, `extras.ingredients.${i}.name`, "Zutat", { max: 30, required: true }),
             hint: text(x.hint, `extras.ingredients.${i}.hint`, "Erklärung zur Zutat", { max: 60 }) };
  });
  unique(ingredients.map(x => x.name), "extras.ingredients", "Zutat");
  const sauces = unique(arr(e.sauces, "extras.sauces", "Soßen", 12)
    .map((s, i) => text(s, `extras.sauces.${i}`, "Soße", { max: 30, required: true })), "extras.sauces", "Soße");
  const sides = unique(arr(e.sides, "extras.sides", "Beilagen", 6)
    .map((s, i) => text(s, `extras.sides.${i}`, "Beilage", { max: 30, required: true })), "extras.sides", "Beilage");
  if (sides.length < 2) fail("extras.sides", "Für die Beilagen-Wahl braucht es mindestens 2 Beilagen (z. B. Pommes und Reis)");
  const priced = (k, label) => {
    const x = obj(e[k], `extras.${k}`, label);
    return { enabled: bool(x.enabled), price: money(x.price, `extras.${k}.price`, `${label}: Preis`, { max: 20 }) };
  };
  const chili = { ...priced("chili", "Chili-Cheese-Soße"), promo: bool(obj(e.chili, "extras.chili", "Chili-Cheese-Soße").promo) };
  const more = arr(e.more, "extras.more", "Weitere Extras", 20).map((r, i) => {
    const x = obj(r, `extras.more.${i}`, "Extra");
    return { name: text(x.name, `extras.more.${i}.name`, "Name des Extras", { max: 40, required: true }),
             price: money(x.price, `extras.more.${i}.price`, "Preis des Extras", { max: 50 }) };
  });
  return { ingredients, sauces, sides, chili, feta: priced("feta", "Schafskäse"), cup: priced("cup", "Extra-Soße im Becher"), more };
}

function validateDelivery(d) {
  obj(d, "delivery", "Lieferung");
  const enabled = bool(d.enabled);
  const pay = obj(d.payment, "delivery.payment", "Zahlungsarten");
  const payment = { cash: bool(pay.cash), card: bool(pay.card) };
  if (enabled && !payment.cash && !payment.card) fail("delivery.payment", "Bitte mindestens eine Zahlungsart für die Lieferung wählen");
  const names = [];
  const zones = arr(d.zones, "delivery.zones", "Liefergebiet", 6).map((rz, i) => {
    const z = obj(rz, `delivery.zones.${i}`, "Zone"), zp = `delivery.zones.${i}`;
    const label = text(z.label, `${zp}.label`, "Name der Zone", { max: 20, required: true });
    const towns = arr(z.towns, `${zp}.towns`, `Zone „${label}“: Orte`, 40).map((rt, j) => {
      const t = obj(rt, `${zp}.towns.${j}`, "Ort"), tp = `${zp}.towns.${j}`;
      const name = text(t.name, `${tp}.name`, "Ortsname", { max: 40, required: true });
      const plz = text(t.plz, `${tp}.plz`, `${name}: Postleitzahl`, { max: 5, required: true });
      if (!/^\d{5}$/.test(plz)) fail(`${tp}.plz`, `${name}: Postleitzahl muss 5 Ziffern haben`);
      names.push(name);
      return { name, plz, city: text(t.city, `${tp}.city`, `${name}: Stadt für die Adresse`, { max: 40 }) };
    });
    if (!towns.length) fail(`${zp}.towns`, `Zone „${label}“ braucht mindestens einen Ort`);
    return { label, fee: money(z.fee, `${zp}.fee`, `Zone „${label}“: Liefergebühr`, { max: 50 }), towns };
  });
  unique(names, "delivery.zones", "Ort");
  if (enabled && !zones.length) fail("delivery.zones", "Für die Lieferung braucht es mindestens eine Zone mit Orten");
  return {
    enabled,
    minOrder: money(d.minOrder, "delivery.minOrder", "Mindestbestellwert", { max: 200 }),
    lastOrder: time(d.lastOrder, "delivery.lastOrder", "Letzte Lieferbestellung", { allowEmpty: true }),
    payment,
    zones
  };
}

function validateHours(h) {
  obj(h, "hours", "Öffnungszeiten");
  const DAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  const out = {};
  for (let d = 0; d < 7; d++) {
    const x = obj(h[String(d)], `hours.${d}`, DAYS[d]);
    const closed = bool(x.closed);
    const open = time(x.open, `hours.${d}.open`, `${DAYS[d]}: Öffnung`);
    const close = time(x.close, `hours.${d}.close`, `${DAYS[d]}: Schließung`);
    // Schließzeit vor der Öffnungszeit = geöffnet bis nach Mitternacht (höchstens bis 06:00 am Folgetag)
    if (!closed && (open === close || (close < open && close > "06:00")))
      fail(`hours.${d}.close`, `${DAYS[d]}: Schließzeit muss nach der Öffnungszeit liegen (nach Mitternacht höchstens bis 06:00)`);
    out[String(d)] = { closed, open, close };
  }
  if (Object.values(out).every(x => x.closed)) fail("hours", "Mindestens ein Tag muss geöffnet sein");
  return out;
}

function validateLegal(l) {
  obj(l, "legal", "Impressum");
  const email = text(l.email, "legal.email", "E-Mail-Adresse", { max: 120 });
  if (email && !/^[^\s@?&#%"'\\]+@[^\s@?&#%"'\\]+\.[a-z]{2,}$/i.test(email)) fail("legal.email", "E-Mail-Adresse sieht nicht richtig aus");
  const vatId = text(l.vatId, "legal.vatId", "Umsatzsteuer-ID", { max: 20 }).replace(/\s/g, "").toUpperCase();
  if (vatId && !/^DE\d{9}$/.test(vatId)) fail("legal.vatId", "Umsatzsteuer-ID: Format DE + 9 Ziffern, z. B. DE123456789");
  return {
    owner: text(l.owner, "legal.owner", "Name des Inhabers", { max: 80 }),
    email,
    legalForm: text(l.legalForm, "legal.legalForm", "Rechtsform", { max: 60 }),
    registerCourt: text(l.registerCourt, "legal.registerCourt", "Registergericht", { max: 80 }),
    registerNo: text(l.registerNo, "legal.registerNo", "Registernummer", { max: 40 }),
    vatId,
    responsible: text(l.responsible, "legal.responsible", "Verantwortlich für den Inhalt", { max: 80 })
  };
}

/** Prüft das komplette Einstellungs-Objekt und gibt eine bereinigte Kopie zurück. */
export function validateSettings(input) {
  const s = obj(input, "", "Einstellungen");
  const shop = obj(s.shop, "shop", "Laden");
  const notice = obj(shop.notice, "shop.notice", "Hinweis");
  const contact = obj(s.contact, "contact", "Kontakt");
  const out = {
    schema: 1,
    shop: {
      ordersOpen: shop.ordersOpen !== false,
      notice: { enabled: bool(notice.enabled), text: text(notice.text, "shop.notice.text", "Hinweis-Text", { max: 200 }) }
    },
    contact: {
      phone: phone(contact.phone, "contact.phone", "Telefonnummer"),
      whatsapp: whatsapp(contact.whatsapp, "contact.whatsapp", "WhatsApp-Nummer"),
      instagram: url(contact.instagram, "contact.instagram", "Instagram-Link", ["instagram.com"]),
      facebook: url(contact.facebook, "contact.facebook", "Facebook-Link", ["facebook.com"])
    },
    hours: validateHours(s.hours),
    delivery: validateDelivery(s.delivery),
    extras: validateExtras(s.extras),
    menu: validateMenu(s.menu),
    legal: validateLegal(s.legal)
  };
  if (out.shop.notice.enabled && !out.shop.notice.text) fail("shop.notice.text", "Bitte einen Hinweis-Text eingeben oder den Hinweis ausschalten");
  return out;
}
