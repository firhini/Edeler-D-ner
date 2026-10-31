/* Edeler Döner · Verwaltung
   Alles, was die Website anzeigt (Speisekarte, Preise, Extras, Lieferung, Zeiten, Kontakt, Impressum),
   wird hier bearbeitet und mit „Speichern“ über /api/admin/settings abgelegt. */
"use strict";

/* ---------------- Grundlagen ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const eur = n => typeof n === "number" ? n.toLocaleString("de-DE", {style:"currency", currency:"EUR"}) : "–";
const moneyStr = v => typeof v === "number" ? v.toFixed(2).replace(".", ",") : String(v ?? "");
function parseMoney(v){
  const s = String(v).replace(/[\s€]/g, "").replace(",", ".");
  if(s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : String(v);
}
const when = iso => iso ? new Date(iso).toLocaleString("de-DE", {dateStyle:"medium", timeStyle:"short", timeZone:"Europe/Berlin"}) : "–";

const CATS = [
  {key:"doener", label:"Döner", emoji:"🌯"}, {key:"lahmacun", label:"Lahmacun", emoji:"🫓"}, {key:"pizza", label:"Pizza", emoji:"🍕"},
  {key:"vegetarisch", label:"Vegetarisch", emoji:"🥗"}, {key:"fingerfood", label:"Fingerfood", emoji:"🍟"}, {key:"getraenke", label:"Getränke", emoji:"🥤"}
];
const catOf = k => CATS.find(c => c.key === k) || CATS[0];
const OPTIONS = [
  {key:"wrap",  label:"Zutaten abwählen + Soßen + Extras", hint:"Für Döner im Brot, Yufka, Lahmacun …"},
  {key:"box",   label:"Mit/ohne Salat + Soßen + Extras", hint:"Für Boxen und Überbackenes"},
  {key:"plate", label:"Soßen + Extras", hint:"Für Teller"},
  {key:"extra", label:"Nur Extras (z. B. Chili-Cheese, Schafskäse)", hint:"Für Pizza, Pommes, Fingerfood"},
  {key:"none",  label:"Keine Auswahl – direkt in den Warenkorb", hint:"Für Getränke"}
];
const TAGS = [{key:"halal", label:"Halal"}, {key:"vegetarisch", label:"Vegetarisch"}, {key:"scharf", label:"Scharf"}];
const DAYS = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
const WEEK = [1,2,3,4,5,6,0];
const PHOTO_LIBRARY = ["card-doener-brot","card-doener-klein","card-doener-yufka","card-doenerbox","card-ueberbacken","card-doenerteller",
  "card-lahmacun","card-lahmacun-salat","card-pizza-salami","card-pizza-sucuk","card-pizza-haehnchen","card-pizza-kalb",
  "card-nuggets","card-pommes-klein","card-pommes","gal-theke","gal-yufka","gal-teller","gal-lahmacun","gal-pizza","gal-brot","gal-yufkabrot"].map(n => "img/" + n);
const photoUrl = (p, small) => (p.startsWith("/") ? p : "/" + p) + (small ? "-480.webp" : ".webp");

const SECTIONS = [
  {key:"overview", label:"Übersicht"},
  {key:"menu", label:"Speisekarte"},
  {key:"extras", label:"Extras & Soßen"},
  {key:"delivery", label:"Lieferung"},
  {key:"hours", label:"Öffnungszeiten"},
  {key:"contact", label:"Kontakt"},
  {key:"legal", label:"Impressum"},
  {key:"users", label:"Zugänge"},
  {key:"history", label:"Verlauf"}
];

const state = {
  user:null, users:[], version:0, savedAt:null, by:null,
  saved:null, draft:null, defaults:null,
  sec:"overview", saving:false, error:"", resetUser:null,
  menuCat:"all", menuSearch:"", editIdx:null, newIds:new Set(), history:null
};

/* ---------------- Server ---------------- */
async function api(method, path, body){
  let r;
  try{
    r = await fetch("/api/" + path, {
      method, credentials:"same-origin", cache:"no-store",
      headers: Object.assign({"x-edeler-admin":"1"}, body !== undefined ? {"content-type":"application/json"} : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }catch(e){ throw Object.assign(new Error("Keine Verbindung – bitte Internet prüfen und nochmal versuchen."), {status:0}); }
  let data = {};
  try{ data = await r.json(); }catch(e){}
  if(r.status === 401 && data.relogin && state.user) openRelogin();
  if(!r.ok) throw Object.assign(new Error(data.error || `Fehler ${r.status}`), {status:r.status, data});
  return data;
}

/* ---------------- Pfad-Helfer (z. B. "delivery.zones.0.fee") ---------------- */
const getP = (path, obj = state.draft) => path.split(".").reduce((o, k) => o == null ? undefined : o[k], obj);
function setP(path, v){
  const ks = path.split("."), last = ks.pop();
  const o = ks.reduce((x, k) => x[k], state.draft);
  o[last] = v;
}

/* ---------------- Bausteine für Formulare ---------------- */
function fText(path, label, o = {}){
  const v = getP(path);
  const input = o.area
    ? `<textarea data-bind="${path}" data-type="text" maxlength="${o.max || 200}" rows="${o.rows || 3}" placeholder="${esc(o.ph || "")}">${esc(v)}</textarea>`
    : `<input type="${o.type || "text"}" data-bind="${path}" data-type="text" value="${esc(v)}" maxlength="${o.max || 200}" placeholder="${esc(o.ph || "")}"${o.attrs ? " " + o.attrs : ""}>`;
  return `<label class="fld"><span class="lbl">${label}${o.req ? "<em>*</em>" : ""}</span>${input}${o.hint ? `<small>${o.hint}</small>` : ""}</label>`;
}
function fMoney(path, label, o = {}){
  return `<label class="fld"><span class="lbl">${label}</span><span class="money"><input type="text" inputmode="decimal" data-bind="${path}" data-type="money" value="${esc(moneyStr(getP(path)))}" placeholder="0,00" autocomplete="off"></span>${o.hint ? `<small>${o.hint}</small>` : ""}</label>`;
}
function fTime(path, label, o = {}){
  return `<label class="fld"><span class="lbl">${label}</span><input type="time" data-bind="${path}" data-type="text" value="${esc(getP(path))}"${o.rerender ? " data-rerender" : ""}>${o.hint ? `<small>${o.hint}</small>` : ""}</label>`;
}
function fSwitch(path, title, sub = "", o = {}){
  const v = !!getP(path), on = o.inverse ? !v : v;
  return `<label class="switch"><input type="checkbox" data-bind="${path}" data-type="${o.inverse ? "boolnot" : "bool"}"${on ? " checked" : ""}${o.rerender ? " data-rerender" : ""}><span class="sw"></span><span class="sw-txt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span></label>`;
}
function fCheck(path, label, o = {}){
  return `<label class="check"><input type="checkbox" data-bind="${path}" data-type="bool"${getP(path) ? " checked" : ""}${o.rerender ? " data-rerender" : ""}> ${label}</label>`;
}
const listBtns = (path, i, n) =>
  `<button class="icon-btn" type="button" data-act="list-up" data-path="${path}" data-i="${i}" aria-label="Nach oben"${i === 0 ? " disabled" : ""}>↑</button>` +
  `<button class="icon-btn" type="button" data-act="list-down" data-path="${path}" data-i="${i}" aria-label="Nach unten"${i === n - 1 ? " disabled" : ""}>↓</button>` +
  `<button class="icon-btn danger" type="button" data-act="list-del" data-path="${path}" data-i="${i}" aria-label="Entfernen">✕</button>`;

/* ---------------- Was fehlt noch? ---------------- */
function todos(){
  const d = state.draft, L = d.legal, out = [];
  if(!L.owner) out.push({lvl:"must", t:"Impressum: Name des Inhabers", s:"Pflichtangabe – erscheint im Impressum und in der Datenschutzerklärung.", go:"legal.owner"});
  if(!L.email) out.push({lvl:"must", t:"Impressum: E-Mail-Adresse", s:"Pflichtangabe – Kunden und Behörden müssen euch schnell erreichen können.", go:"legal.email"});
  if(!L.legalForm) out.push({lvl:"must", t:"Impressum: Rechtsform", s:"Z. B. Einzelunternehmen oder GbR.", go:"legal.legalForm"});
  if(d.delivery.enabled){
    const pay = [d.delivery.payment.cash && "bar", d.delivery.payment.card && "Karte"].filter(Boolean).join(" und ") || "–";
    out.push({lvl:"check", t:"Lieferung: Zahlung beim Fahrer", s:`Aktuell: ${pay}. Kann der Fahrer auch Karte annehmen?`, go:"delivery.payment.card"});
    out.push({lvl:"check", t:"Lieferung: Mindestbestellwert", s:`Aktuell: ${d.delivery.minOrder > 0 ? eur(d.delivery.minOrder) : "keiner"}.`, go:"delivery.minOrder"});
    out.push({lvl:"check", t:"Lieferung: Letzte Lieferbestellung", s:`Aktuell: ${d.delivery.lastOrder ? d.delivery.lastOrder + " Uhr" : "bis Ladenschluss"}.`, go:"delivery.lastOrder"});
  }
  if(!L.vatId) out.push({lvl:"opt", t:"Umsatzsteuer-ID", s:"Nur eintragen, falls vorhanden.", go:"legal.vatId"});
  if(!L.registerNo) out.push({lvl:"opt", t:"Handelsregister-Nummer", s:"Nur nötig, wenn der Laden im Handelsregister steht.", go:"legal.registerNo"});
  if(!d.contact.instagram && !d.contact.facebook) out.push({lvl:"opt", t:"Instagram / Facebook", s:"Falls vorhanden – erscheint als Symbol unten auf der Website.", go:"contact.instagram"});
  if(state.users.length < 2) out.push({lvl:"opt", t:"Zweiten Zugang anlegen", s:"Z. B. für den Mitinhaber – jeder mit eigenem Passwort.", sec:"users"});
  return out;
}
const mustCount = () => todos().filter(t => t.lvl === "must").length;

/* ---------------- Bereiche ---------------- */
const R = {};

R.overview = () => {
  const d = state.draft, list = todos(), must = list.filter(t => t.lvl === "must").length;
  const off = d.menu.filter(m => m.available === false).length;
  const icon = {must:"!", check:"?", opt:"+"};
  return `
  <h1 class="sec-title">Hallo ${esc(state.user)} 👋</h1>
  <p class="sec-intro">Hier stellst du alles für die Website ein. Änderungen werden erst nach <b>„Speichern“</b> (unten) übernommen und sind dann nach wenigen Sekunden auf der Website sichtbar.</p>
  ${state.version === 0 ? `<p class="info warn">Es wurde noch nie gespeichert – die Website zeigt die Grundeinstellung. Sobald du einmal speicherst, gelten deine Angaben.</p>` : ""}
  <div class="card">
    <h2 class="card-h">Bestellungen</h2>
    <p class="hint">Bei Stress, Ausfall oder kurzfristig geschlossen: hier ausschalten. Kunden sehen dann einen Hinweis und können nicht per WhatsApp bestellen.</p>
    <div class="big-switch${d.shop.ordersOpen ? "" : " off"}">${fSwitch("shop.ordersOpen", "Online-Bestellungen annehmen", d.shop.ordersOpen ? "Kunden können über die Website per WhatsApp bestellen." : "AUS – Kunden sehen „Online-Bestellungen sind gerade pausiert“.", {rerender:true})}</div>
  </div>
  <div class="card">
    <h2 class="card-h">Hinweis auf der Website</h2>
    <p class="hint">Erscheint ganz oben auf der Startseite und im Warenkorb. Z. B. „Heute ab 18 Uhr geschlossen“ oder „Neu: Falafel-Teller!“.</p>
    <div class="stack">
      ${fSwitch("shop.notice.enabled", "Hinweis anzeigen", "", {rerender:true})}
      ${d.shop.notice.enabled ? fText("shop.notice.text", "Text des Hinweises", {area:true, max:200, rows:2, ph:"z. B. Heute wegen Familienfeier ab 18 Uhr geschlossen."}) : ""}
    </div>
  </div>
  <div class="card">
    <h2 class="card-h">${must ? `Noch auszufüllen (${must} Pflicht)` : "Alles Wichtige ist ausgefüllt ✓"}</h2>
    <p class="hint"><b>!</b> = Pflicht · <b>?</b> = bitte einmal prüfen · <b>+</b> = optional</p>
    <ul class="todo-list">${list.map(t => `<li class="${t.lvl}"><span class="ic" aria-hidden="true">${icon[t.lvl]}</span><div><b>${esc(t.t)}</b><small>${esc(t.s)}</small></div>
      <button class="btn btn-sm" type="button" data-act="goto" ${t.go ? `data-path="${t.go}"` : `data-sec="${t.sec}"`}>${t.lvl === "must" ? "Ausfüllen" : "Öffnen"}</button></li>`).join("")}</ul>
  </div>
  <div class="card">
    <h2 class="card-h">Auf einen Blick</h2>
    <div class="stats">
      <div class="stat"><b>${d.menu.length}</b><span>Gerichte auf der Karte</span></div>
      <div class="stat"><b>${off}</b><span>gerade nicht verfügbar</span></div>
      <div class="stat"><b>${d.delivery.enabled ? "An" : "Aus"}</b><span>Lieferung${d.delivery.enabled ? ` · ${d.delivery.zones.length} Zonen` : ""}</span></div>
      <div class="stat"><b>${state.users.length}</b><span>Zugänge</span></div>
    </div>
  </div>
  <div class="card">
    <h2 class="card-h">Gut zu wissen</h2>
    <ul class="hint">
      <li>Fehler gemacht? Unter <button class="linkbtn" type="button" data-act="goto" data-sec="history">Verlauf</button> kannst du jeden früheren Stand wiederherstellen.</li>
      <li>Ein Gericht ist aus? In der <button class="linkbtn" type="button" data-act="goto" data-sec="menu">Speisekarte</button> einfach „verfügbar“ ausschalten.</li>
      <li>Bestellungen kommen wie bisher per WhatsApp an die Nummer unter <button class="linkbtn" type="button" data-act="goto" data-sec="contact">Kontakt</button>.</li>
    </ul>
  </div>`;
};

/* ----- Speisekarte ----- */
function priceLine(m){
  if(m.variants && m.variants.length) return m.variants.map(v => `${v.label || "?"} ${typeof v.price === "number" ? eur(v.price) : "?"}`).join(" · ");
  return typeof m.price === "number" ? eur(m.price) : "Preis fehlt";
}
function itemRow(m, i, first, last){
  const c = catOf(m.cat);
  const tags = [m.popular && "⭐ Beliebt", ...(m.tags || []).map(t => (TAGS.find(x => x.key === t) || {}).label)].filter(Boolean).join(" · ");
  return `<div class="item${m.available === false ? " off" : ""}">
    <div class="moves">
      <button class="icon-btn" type="button" data-act="item-up" data-i="${i}" aria-label="${esc(m.name)} nach oben"${first ? " disabled" : ""}>↑</button>
      <button class="icon-btn" type="button" data-act="item-down" data-i="${i}" aria-label="${esc(m.name)} nach unten"${last ? " disabled" : ""}>↓</button>
    </div>
    <div class="thumb">${m.photo ? `<img src="${esc(photoUrl(m.photo, true))}" alt="" loading="lazy" width="54" height="54">` : c.emoji}</div>
    <div class="meta"><b>${esc(m.name || "(ohne Namen)")}</b><span>${esc(priceLine(m))}</span>${tags ? `<span class="tagline">${esc(tags)}</span>` : ""}</div>
    <div class="avail"><label class="switch"><input type="checkbox" data-bind="menu.${i}.available" data-type="bool"${m.available !== false ? " checked" : ""} data-rerender aria-label="${esc(m.name)} verfügbar"><span class="sw"></span><span class="sw-txt"><b>${m.available !== false ? "verfügbar" : "aus"}</b></span></label></div>
    <button class="btn btn-sm" type="button" data-act="item-edit" data-i="${i}">Bearbeiten</button>
  </div>`;
}
R.menu = () => {
  const d = state.draft, q = state.menuSearch.trim().toLowerCase();
  const show = CATS.filter(c => state.menuCat === "all" || state.menuCat === c.key);
  const groups = show.map(c => {
    const idx = d.menu.map((m, i) => m.cat === c.key ? i : -1).filter(i => i >= 0);
    const vis = idx.filter(i => !q || (d.menu[i].name + " " + d.menu[i].desc).toLowerCase().includes(q));
    if(q && !vis.length) return "";
    return `<h2 class="cat-h">${c.emoji} ${c.label} <small>(${idx.length})</small><span class="spacer"></span>
        <button class="btn btn-sm" type="button" data-act="item-new" data-cat="${c.key}">+ Neu in ${c.label}</button></h2>
      <div class="items">${vis.map(i => itemRow(d.menu[i], i, i === idx[0], i === idx[idx.length - 1])).join("") || `<p class="muted small">Noch keine Gerichte.</p>`}</div>`;
  }).join("");
  return `
  <h1 class="sec-title">Speisekarte</h1>
  <p class="sec-intro">Preise, Beschreibungen, Fotos und Reihenfolge. Ist etwas aus, schalte es auf „aus“ – es bleibt sichtbar, kann aber nicht bestellt werden.</p>
  <div class="toolbar"><input type="search" id="menuSearch" value="${esc(state.menuSearch)}" placeholder="Gericht suchen …" aria-label="Gericht suchen"></div>
  <div class="chips" role="group" aria-label="Kategorie">
    <button class="chip" type="button" data-act="menu-cat" data-cat="all" aria-pressed="${state.menuCat === "all"}">Alle</button>
    ${CATS.map(c => `<button class="chip" type="button" data-act="menu-cat" data-cat="${c.key}" aria-pressed="${state.menuCat === c.key}">${c.emoji} ${c.label}</button>`).join("")}
  </div>
  ${groups || `<p class="muted">Nichts gefunden.</p>`}`;
};

/* ----- Gericht bearbeiten (Dialog) ----- */
function itemDlgHtml(i){
  const m = state.draft.menu[i], p = `menu.${i}`, hasVar = !!(m.variants && m.variants.length);
  const photo = m.photo
    ? `<img src="${esc(photoUrl(m.photo, true))}" alt="Aktuelles Foto">`
    : `<span aria-hidden="true">${catOf(m.cat).emoji}</span>`;
  return `
  ${fText(p + ".name", "Name", {req:true, max:60, ph:"z. B. Döner Groß im Brot", attrs:`data-item-name="${i}"`})}
  <label class="fld"><span class="lbl">Kategorie</span><select data-bind="${p}.cat" data-type="text">${CATS.map(c => `<option value="${c.key}"${m.cat === c.key ? " selected" : ""}>${c.emoji} ${c.label}</option>`).join("")}</select></label>
  ${fText(p + ".desc", "Beschreibung", {area:true, max:220, rows:2, ph:"Kurz und lecker – was ist drin?"})}
  <div class="fld"><span class="lbl">Preis</span>
    <div class="seg" role="group" aria-label="Preisart">
      <button type="button" data-act="price-mode" data-mode="single" aria-pressed="${!hasVar}">Ein Preis</button>
      <button type="button" data-act="price-mode" data-mode="variants" aria-pressed="${hasVar}">Mehrere Varianten</button>
    </div>
    ${hasVar ? `<small>Z. B. Hähnchen / Kalb oder Klein / Groß – jede Variante mit eigenem Preis.</small>
      <div class="list" data-err="${p}.variants">${m.variants.map((v, j) => `<div class="li-row"><div class="grow"><div class="two">
          ${fText(`${p}.variants.${j}.label`, "Variante", {max:20, ph:"z. B. Hähnchen"})}
          ${fMoney(`${p}.variants.${j}.price`, "Preis")}
        </div></div><button class="icon-btn danger" type="button" data-act="var-del" data-j="${j}" aria-label="Variante entfernen">✕</button></div>`).join("")}</div>
      ${m.variants.length < 4 ? `<button class="btn btn-sm" type="button" data-act="var-add">+ Variante</button>` : ""}`
    : `<div class="money-w">${fMoney(p + ".price", "Preis")}</div>`}
  </div>
  <div class="fld"><span class="lbl">Foto</span>
    <div class="photo-pick">
      <div class="prev">${photo}</div>
      <div class="stack">
        <button class="btn btn-sm" type="button" data-act="photo-lib">Aus unseren Fotos wählen</button>
        <label class="btn btn-sm">Eigenes Foto hochladen<input type="file" accept="image/*" data-act-file="photo-upload" class="visually-hidden"></label>
        ${m.photo ? `<button class="btn btn-sm btn-ghost" type="button" data-act="photo-none">Ohne Foto (Zeichnung)</button>` : ""}
      </div>
    </div>
    <small id="photoMsg" role="status">Tipp: Querformat, gut beleuchtet. Das Foto wird automatisch zugeschnitten und verkleinert.</small>
  </div>
  <div class="fld"><span class="lbl">Merkmale</span>
    <div class="row">${TAGS.map(t => `<label class="check"><input type="checkbox" data-tag="${t.key}"${(m.tags || []).includes(t.key) ? " checked" : ""}> ${t.label}</label>`).join("")}</div>
  </div>
  ${fSwitch(p + ".popular", "Beliebt", "Mit Stern markieren und bei den Bestsellern auf der Startseite zeigen.")}
  ${fSwitch(p + ".available", "Verfügbar", "Aus = bleibt sichtbar, aber „Gerade nicht verfügbar“.")}
  <label class="fld"><span class="lbl">Auswahl beim Bestellen</span>
    <select data-bind="${p}.options" data-type="text" data-rerender>${OPTIONS.map(o => `<option value="${o.key}"${m.options === o.key ? " selected" : ""}>${o.label}</option>`).join("")}</select>
    <small>${esc((OPTIONS.find(o => o.key === m.options) || OPTIONS[3]).hint)}. Welche Zutaten, Soßen und Extras es gibt, stellst du unter „Extras &amp; Soßen“ ein.</small>
  </label>
  ${m.options !== "none" ? fSwitch(p + ".side", "Beilage wählen lassen", `Kunde muss eine Beilage wählen (${esc(state.draft.extras.sides.join(" oder "))}).`) : ""}`;
}
function openItem(i){
  state.editIdx = i;
  $("#itemDlgTitle").textContent = state.newIds.has(state.draft.menu[i].id) ? "Neues Gericht" : "Gericht bearbeiten";
  $("#itemDlgBody").innerHTML = itemDlgHtml(i);
  const dlg = $("#itemDlg");
  if(!dlg.open) dlg.showModal();
  $("#itemDlgBody").scrollTop = 0;
}
function rerenderItem(){
  if(state.editIdx === null) return;
  const body = $("#itemDlgBody"), top = body.scrollTop;
  body.innerHTML = itemDlgHtml(state.editIdx);
  body.scrollTop = top;
}

/* ----- Extras ----- */
R.extras = () => {
  const e = state.draft.extras;
  const simpleList = (path, items, ph, max) => `<div class="list" data-err="${path}">${items.map((x, i) =>
    `<div class="li-row"><div class="grow"><input type="text" data-bind="${path}.${i}" data-type="text" value="${esc(x)}" maxlength="30" placeholder="${ph}" aria-label="${ph}"></div>${listBtns(path, i, items.length)}</div>`).join("")}</div>
    ${items.length < max ? `<button class="btn btn-sm" type="button" data-act="list-add" data-path="${path}">+ Hinzufügen</button>` : ""}`;
  const priced = (k, title, sub, extra = "") => `<div class="card">
      ${fSwitch(`extras.${k}.enabled`, title, sub, {rerender:true})}
      ${e[k].enabled ? `<div class="grid2 mt10">${fMoney(`extras.${k}.price`, "Aufpreis")}</div>${extra}` : ""}
    </div>`;
  return `
  <h1 class="sec-title">Extras &amp; Soßen</h1>
  <p class="sec-intro">Das kann der Kunde beim Bestellen auswählen. Welches Gericht welche Auswahl hat, stellst du beim Gericht ein.</p>
  <div class="card"><h2 class="card-h">Soßen (gratis)</h2><p class="hint">Der Kunde kann mehrere wählen – oder „Ohne Soße“.</p>${simpleList("extras.sauces", e.sauces, "z. B. Knoblauchsoße", 12)}</div>
  <div class="card"><h2 class="card-h">Zutaten (abwählbar)</h2><p class="hint">Bei Döner, Yufka &amp; Co. ist alles dabei – der Kunde tippt weg, was er nicht möchte. Die Erklärung erscheint klein darunter.</p>
    <div class="list" data-err="extras.ingredients">${e.ingredients.map((x, i) => `<div class="li-row"><div class="grow"><div class="two">
      <input type="text" data-bind="extras.ingredients.${i}.name" data-type="text" value="${esc(x.name)}" maxlength="30" placeholder="Zutat, z. B. Tomaten" aria-label="Zutat">
      <input type="text" data-bind="extras.ingredients.${i}.hint" data-type="text" value="${esc(x.hint)}" maxlength="60" placeholder="Erklärung (optional)" aria-label="Erklärung zur Zutat">
    </div></div>${listBtns("extras.ingredients", i, e.ingredients.length)}</div>`).join("")}</div>
    ${e.ingredients.length < 20 ? `<button class="btn btn-sm" type="button" data-act="list-add" data-path="extras.ingredients">+ Hinzufügen</button>` : ""}</div>
  <div class="card"><h2 class="card-h">Beilagen zur Auswahl</h2><p class="hint">Für Gerichte mit „Beilage wählen lassen“ (z. B. Dönerbox, Dönerteller). Mindestens 2.</p>${simpleList("extras.sides", e.sides, "z. B. Pommes", 6)}</div>
  <h2 class="cat-h">Extras mit Aufpreis <small>– werden automatisch berechnet</small></h2>
  ${priced("chili", "🔥 Chili-Cheese-Soße", "Mit Wahl „mit/ohne Jalapeños“.", `<div class="mt10">${fSwitch("extras.chili.promo", "Als NEU-Aktion hervorheben", "Großes Banner auf der Startseite + „Neu“-Markierung.")}</div>`)}
  ${priced("feta", "Schafskäse", "")}
  ${priced("cup", "Extra-Soße im Becher", "Separat zum Mitnehmen, Preis pro Becher.")}
  <div class="card"><h2 class="card-h">Weitere Extras (nur zur Info)</h2><p class="hint">Stehen unter der Speisekarte. Der Kunde schreibt sie unter „Besondere Wünsche“, berechnet wird im Laden.</p>
    <div class="list" data-err="extras.more">${e.more.map((x, i) => `<div class="li-row"><div class="grow"><div class="two">
      <input type="text" data-bind="extras.more.${i}.name" data-type="text" value="${esc(x.name)}" maxlength="40" placeholder="z. B. Käse" aria-label="Name des Extras">
      <span class="money"><input type="text" inputmode="decimal" data-bind="extras.more.${i}.price" data-type="money" value="${esc(moneyStr(x.price))}" placeholder="0,00" aria-label="Preis des Extras"></span>
    </div></div>${listBtns("extras.more", i, e.more.length)}</div>`).join("")}</div>
    ${e.more.length < 20 ? `<button class="btn btn-sm" type="button" data-act="list-add" data-path="extras.more">+ Hinzufügen</button>` : ""}</div>`;
};

/* ----- Lieferung ----- */
R.delivery = () => {
  const d = state.draft.delivery;
  return `
  <h1 class="sec-title">Lieferung</h1>
  <p class="sec-intro">Liefergebiete, Gebühren und Regeln. Der Kunde wählt im Warenkorb seinen Ort – die Gebühr wird automatisch dazugerechnet.</p>
  <div class="card"><div class="big-switch${d.enabled ? "" : " off"}">${fSwitch("delivery.enabled", "Lieferung anbieten", d.enabled ? "Kunden können Lieferung wählen." : "AUS – Website zeigt „Lieferung gerade pausiert“, Abholung geht weiter.", {rerender:true})}</div></div>
  <p class="info">So kommt eine Lieferbestellung an: per WhatsApp mit Adresse, Gebühr, Zahlungsart und einem <b>Routen-Link für den Fahrer</b> (öffnet Google Maps oder Apple Karten). Einfach an den Fahrer weiterleiten.</p>
  <h2 class="cat-h">Liefergebiete</h2>
  <p class="hint">Jede Zone hat eine Gebühr und eine Liste von Orten. „Stadt für die Adresse“ nur ausfüllen, wenn der Ortsname kein eigener Ort ist (z. B. Mannheim-Rheinau → Mannheim) – sonst leer lassen.</p>
  <div data-err="delivery.zones">${d.zones.map((z, i) => `<div class="zone">
    <div class="zone-head">
      ${fText(`delivery.zones.${i}.label`, "Name der Zone", {max:20, ph:"z. B. bis 5 km"})}
      ${fMoney(`delivery.zones.${i}.fee`, "Liefergebühr")}
      <button class="icon-btn danger" type="button" data-act="list-del" data-path="delivery.zones" data-i="${i}" aria-label="Zone entfernen">✕</button>
    </div>
    <div class="town-h"><span>Ort</span><span>PLZ</span><span>Stadt für die Adresse (optional)</span><span></span></div>
    <div class="list" data-err="delivery.zones.${i}.towns">${z.towns.map((t, j) => `<div class="town">
      <input type="text" data-bind="delivery.zones.${i}.towns.${j}.name" data-type="text" value="${esc(t.name)}" maxlength="40" placeholder="Ort" aria-label="Ort">
      <input type="text" inputmode="numeric" data-bind="delivery.zones.${i}.towns.${j}.plz" data-type="text" value="${esc(t.plz)}" maxlength="5" placeholder="PLZ" aria-label="Postleitzahl">
      <input type="text" data-bind="delivery.zones.${i}.towns.${j}.city" data-type="text" value="${esc(t.city)}" maxlength="40" placeholder="Stadt (optional)" aria-label="Stadt für die Adresse">
      <button class="icon-btn danger" type="button" data-act="list-del" data-path="delivery.zones.${i}.towns" data-i="${j}" aria-label="Ort entfernen">✕</button>
    </div>`).join("")}</div>
    <button class="btn btn-sm" type="button" data-act="list-add" data-path="delivery.zones.${i}.towns">+ Ort hinzufügen</button>
  </div>`).join("")}</div>
  ${d.zones.length < 6 ? `<button class="btn" type="button" data-act="list-add" data-path="delivery.zones">+ Zone hinzufügen</button>` : ""}
  <h2 class="cat-h">Regeln</h2>
  <div class="card stack">
    <div class="grid2">
      ${fMoney("delivery.minOrder", "Mindestbestellwert", {hint:"0 = kein Mindestbestellwert. Gilt ohne Liefergebühr."})}
      <div class="fld">${fTime("delivery.lastOrder", "Letzte Lieferbestellung", {hint:"Leer = bis Ladenschluss. Danach geht nur noch Abholung."})}
        ${d.lastOrder ? `<button class="linkbtn small" type="button" data-act="clear" data-path="delivery.lastOrder">Uhrzeit löschen (bis Ladenschluss)</button>` : ""}</div>
    </div>
    <div class="fld" data-err="delivery.payment"><span class="lbl">Zahlung beim Fahrer</span>
      <div class="row">${fCheck("delivery.payment.cash", "Bar", {rerender:true})}${fCheck("delivery.payment.card", "Karte (EC/Kreditkarte)", {rerender:true})}</div>
      <small>Sind beide an, wählt der Kunde im Warenkorb – und es steht in der Bestellung.</small></div>
  </div>`;
};

/* ----- Öffnungszeiten ----- */
R.hours = () => {
  const h = state.draft.hours;
  return `
  <h1 class="sec-title">Öffnungszeiten</h1>
  <p class="sec-intro">Erscheinen auf der Website (inkl. „Jetzt geöffnet“) und bei Google. Schließt ihr nach Mitternacht, einfach z. B. 02:00 eintragen.</p>
  <div class="card" data-err="hours">
    ${WEEK.map(d => `<div class="hours-row">
      <span class="day">${DAYS[d]}</span>
      ${fSwitch(`hours.${d}.closed`, h[d].closed ? "Ruhetag" : "Geöffnet", "", {inverse:true, rerender:true})}
      ${h[d].closed ? `<span class="closed-note">Geschlossen</span>` : `<div class="times">
        <span>von</span><input type="time" data-bind="hours.${d}.open" data-type="text" value="${esc(h[d].open)}" aria-label="${DAYS[d]} öffnet um">
        <span>bis</span><input type="time" data-bind="hours.${d}.close" data-type="text" value="${esc(h[d].close)}" aria-label="${DAYS[d]} schließt um">
      </div>`}
    </div>`).join("")}
  </div>
  <button class="btn btn-sm wrap" type="button" data-act="hours-copy">Zeiten vom ersten geöffneten Tag für alle geöffneten Tage übernehmen</button>`;
};

/* ----- Kontakt ----- */
R.contact = () => {
  const c = state.draft.contact, wa = String(c.whatsapp || "").replace(/\D/g, "");
  return `
  <h1 class="sec-title">Kontakt</h1>
  <p class="sec-intro">Telefon und WhatsApp für Kunden. <b>An die WhatsApp-Nummer gehen alle Bestellungen.</b></p>
  <div class="card stack">
    ${fText("contact.whatsapp", "WhatsApp-Nummer für Bestellungen", {req:true, max:30, type:"tel", ph:"z. B. 0178 1804021", hint:"Egal ob mit 0 oder +49 – wird automatisch richtig umgewandelt."})}
    ${wa ? `<a class="btn btn-sm" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">Nummer in WhatsApp testen ↗</a>` : ""}
    ${fText("contact.phone", "Telefonnummer zum Anrufen", {req:true, max:30, type:"tel", ph:"z. B. 0178 1804021", hint:"Wird auf der Website, im Impressum und bei Google angezeigt."})}
  </div>
  <div class="card stack">
    <h2 class="card-h">Social Media (optional)</h2>
    ${fText("contact.instagram", "Instagram-Link", {type:"url", max:200, ph:"https://www.instagram.com/…", hint:"Leer lassen, wenn es keinen gibt."})}
    ${fText("contact.facebook", "Facebook-Link", {type:"url", max:200, ph:"https://www.facebook.com/…"})}
  </div>`;
};

/* ----- Impressum ----- */
R.legal = () => `
  <h1 class="sec-title">Impressum &amp; Datenschutz</h1>
  <p class="sec-intro">Gesetzliche Pflichtangaben. Sie erscheinen automatisch im <a href="/impressum.html" target="_blank" rel="noopener">Impressum</a> und in der <a href="/datenschutz.html" target="_blank" rel="noopener">Datenschutzerklärung</a>. Mit <em>*</em> = Pflicht.</p>
  <div class="card stack">
    ${fText("legal.owner", "Vor- und Nachname des Inhabers", {req:true, max:80, ph:"z. B. Max Mustermann", attrs:'autocomplete="name"', hint:"Bei mehreren Inhabern (GbR) alle Namen, z. B. „Ali Yilmaz und Mehmet Kaya“."})}
    ${fText("legal.email", "E-Mail-Adresse", {req:true, type:"email", max:120, ph:"z. B. info@edeler-doener.de", attrs:'autocomplete="email"', hint:"Pflicht im Impressum – muss regelmäßig gelesen werden."})}
    <label class="fld"><span class="lbl">Rechtsform<em>*</em></span><input type="text" list="legalForms" data-bind="legal.legalForm" data-type="text" value="${esc(state.draft.legal.legalForm)}" maxlength="60" placeholder="z. B. Einzelunternehmen">
      <datalist id="legalForms"><option value="Einzelunternehmen"><option value="GbR"><option value="e.K. (eingetragener Kaufmann)"><option value="UG (haftungsbeschränkt)"><option value="GmbH"></datalist>
      <small>Steht auf der Gewerbeanmeldung. Ein Inhaber ohne Handelsregister = meist „Einzelunternehmen“, zwei Inhaber = meist „GbR“.</small></label>
    ${fText("legal.responsible", "Verantwortlich für den Inhalt", {max:80, ph:"leer = Inhaber", hint:"Leer lassen, dann wird der Inhaber eingetragen."})}
  </div>
  <div class="card stack">
    <h2 class="card-h">Nur falls vorhanden</h2>
    ${fText("legal.vatId", "Umsatzsteuer-ID", {max:20, ph:"DE123456789", hint:"Steht im Schreiben vom Bundeszentralamt für Steuern. Nicht die normale Steuernummer!"})}
    ${fText("legal.registerNo", "Handelsregister-Nummer", {max:40, ph:"z. B. HRA 123456", hint:"Nur bei e.K., UG, GmbH. Sonst leer lassen – dann wird der Abschnitt ausgeblendet."})}
    ${fText("legal.registerCourt", "Registergericht", {max:80, ph:"Amtsgericht Mannheim"})}
  </div>`;

/* ----- Zugänge ----- */
R.users = () => `
  <h1 class="sec-title">Zugänge</h1>
  <p class="sec-intro">Jeder Inhaber bekommt einen eigenen Zugang. Jeder Zugang kann alles ändern – also nur an Personen geben, denen ihr voll vertraut. Im Verlauf steht, wer was gespeichert hat.</p>
  <div class="card">
    <h2 class="card-h">Alle Zugänge</h2>
    <ul class="users">${state.users.map(u => `<li><b>${esc(u)}${u === state.user ? ` <span class="badge gold">du</span>` : ""}</b>
      ${u !== state.user ? `<button class="btn btn-sm" type="button" data-act="user-reset" data-user="${esc(u)}">Passwort neu setzen</button>
      <button class="btn btn-sm btn-danger" type="button" data-act="user-del" data-user="${esc(u)}">Löschen</button>` : ""}
      ${state.resetUser === u ? `<form class="row full" data-form="user-reset">
        <input type="password" id="resetPw" autocomplete="new-password" placeholder="Neues Passwort (mind. 10 Zeichen)" aria-label="Neues Passwort für ${esc(u)}" class="grow-input">
        <button class="btn btn-sm btn-gold" type="submit">Setzen</button></form>` : ""}</li>`).join("")}</ul>
  </div>
  <form class="card stack" data-form="user-add">
    <h2 class="card-h">Neuen Zugang anlegen</h2>
    <div class="grid2">
      <label class="fld"><span class="lbl">Benutzername</span><input type="text" id="newUser" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="30" placeholder="z. B. mehmet"><small>3–30 Zeichen: Buchstaben, Ziffern, Punkt, Minus</small></label>
      <label class="fld"><span class="lbl">Passwort</span><input type="password" id="newUserPw" autocomplete="new-password" placeholder="mind. 10 Zeichen"></label>
    </div>
    <div><button class="btn btn-gold" type="submit">Zugang anlegen</button></div>
  </form>
  <form class="card stack" data-form="password">
    <h2 class="card-h">Dein Passwort ändern</h2>
    <label class="fld"><span class="lbl">Aktuelles Passwort</span><input type="password" id="pwCur" autocomplete="current-password"></label>
    <div class="grid2">
      <label class="fld"><span class="lbl">Neues Passwort</span><input type="password" id="pwNew" autocomplete="new-password" placeholder="mind. 10 Zeichen"></label>
      <label class="fld"><span class="lbl">Neues Passwort wiederholen</span><input type="password" id="pwNew2" autocomplete="new-password"></label>
    </div>
    <div><button class="btn btn-gold" type="submit">Passwort ändern</button></div>
    <small class="hint">Danach sind alle anderen Geräte mit deinem Zugang abgemeldet.</small>
  </form>`;

/* ----- Verlauf ----- */
R.history = () => {
  if(!state.history){ loadHistory(); return `<h1 class="sec-title">Verlauf</h1><p class="muted">Wird geladen …</p>`; }
  return `
  <h1 class="sec-title">Verlauf</h1>
  <p class="sec-intro">Die letzten 30 gespeicherten Stände. Wiederherstellen macht einen alten Stand wieder aktuell (als neue Version – nichts geht verloren).</p>
  ${state.history.length ? `<ul class="history">${state.history.map(h => `<li><div><b>Version ${h.version}</b>${h.version === state.version ? ` <span class="badge gold">aktuell</span>` : ""}
      <small>${esc(when(h.savedAt))} · von ${esc(h.by)}</small></div>
      ${h.version !== state.version ? `<button class="btn btn-sm" type="button" data-act="restore" data-v="${h.version}">Wiederherstellen</button>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">Noch nichts gespeichert.</p>`}`;
};
async function loadHistory(){
  try{ state.history = (await api("GET", "admin/history")).history; }
  catch(e){ state.history = []; toast(e.message, true); }
  if(state.sec === "history") render();
}

/* ---------------- Anzeige ---------------- */
/* Tabs nur einmal bauen und danach nur aktualisieren – sonst ginge ein Klick verloren, der direkt nach dem Tippen kommt */
function renderTabs(){
  const nav = $("#tabs"), must = mustCount();
  if(!nav.children.length) nav.innerHTML = SECTIONS.map(s =>
    `<button class="tab" type="button" data-act="tab" data-sec="${s.key}">${s.label}<span class="dot" hidden><span class="visually-hidden"> – Pflichtangaben fehlen</span></span></button>`).join("");
  nav.querySelectorAll(".tab").forEach(t => {
    const k = t.dataset.sec;
    if(k === state.sec) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    t.querySelector(".dot").hidden = !((k === "legal" || k === "overview") && must > 0);
  });
}
function render(){
  renderTabs();
  $("#main").innerHTML = R[state.sec]();
  updateSaveBar();
}
function focusPath(path){
  const el = document.querySelector(`[data-bind="${path}"]`);
  if(el){ el.focus({preventScroll:true}); el.scrollIntoView({block:"nearest"}); }
}
function go(sec, {scroll = true} = {}){
  state.sec = sec;
  state.resetUser = null;
  if(sec === "history") state.history = null;
  render();
  if(scroll) window.scrollTo(0, 0);
  const tab = document.querySelector(`.tab[data-sec="${sec}"]`);
  if(tab) tab.scrollIntoView({inline:"center", block:"nearest"});
}
const dirty = () => state.draft && JSON.stringify(state.draft) !== JSON.stringify(state.saved);
function updateSaveBar(){
  const d = dirty(), bar = $("#savebar");
  bar.classList.toggle("dirty", d);
  $("#saveBtn").disabled = !d || state.saving;
  $("#saveBtn").textContent = state.saving ? "Speichert …" : "Speichern";
  $("#discardBtn").hidden = !d || state.saving;
  let txt;
  if(state.error) txt = `<span class="bad">⚠ ${esc(state.error)}</span>`;
  else if(d) txt = `<b>Noch nicht gespeichert</b><span class="sb-long"> – erst nach „Speichern“ auf der Website.</span>`;
  else if(state.version) txt = `Alles gespeichert ✓<span class="muted sb-long"> · Version ${state.version} · ${esc(when(state.savedAt))}${state.by ? " · " + esc(state.by) : ""}</span>`;
  else txt = `Website zeigt die Grundeinstellung.`;
  $("#sbState").innerHTML = txt;
}

/* ---------------- Fehler an Feldern ---------------- */
function clearFieldErrors(){
  document.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute("aria-invalid"));
  document.querySelectorAll(".invalid").forEach(el => el.classList.remove("invalid"));
  document.querySelectorAll(".field-err").forEach(el => el.remove());
}
function findField(path){
  let p = path;
  while(p){
    const el = document.querySelector(`[data-bind="${p}"]`) || document.querySelector(`[data-err="${p}"]`);
    if(el) return el;
    p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
  }
  return null;
}
function sectionFor(path){
  const top = path.split(".")[0];
  return {shop:"overview", contact:"contact", hours:"hours", delivery:"delivery", extras:"extras", menu:"menu", legal:"legal"}[top] || "overview";
}
/* Zum Feld springen (aus der Übersicht oder bei einem Fehler) */
function gotoField(path, msg){
  const sec = sectionFor(path);
  if(state.sec !== sec) go(sec);
  if(sec === "menu" && /^menu\.\d+/.test(path)){
    const i = Number(path.split(".")[1]);
    state.menuCat = "all"; state.menuSearch = "";
    render();
    openItem(i);
  }
  requestAnimationFrame(() => {
    const el = findField(path);
    if(!el) return;
    if(msg){
      if(el.matches("input,select,textarea")) el.setAttribute("aria-invalid", "true"); else el.classList.add("invalid");
      const p = document.createElement("p");
      p.className = "field-err"; p.setAttribute("role", "alert"); p.textContent = msg;
      (el.closest(".fld, .li-row, .town, .zone-head, .hours-row") || el).insertAdjacentElement("afterend", p);
    }
    el.scrollIntoView({block:"center", behavior:"smooth"});
    if(el.matches("input,select,textarea")) el.focus({preventScroll:true});
  });
}

/* ---------------- Eingaben ---------------- */
function slug(s){
  return String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44);
}
function allIds(except){
  const ids = new Set();
  state.draft.menu.forEach(m => { if(m !== except){ ids.add(m.id); (m.variants || []).forEach(v => ids.add(v.id)); } });
  return ids;
}
function uniqueId(base, taken){
  base = slug(base) || "gericht";
  let id = base, n = 2;
  while(taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}
/* Neue Gerichte bekommen ihre interne Kennung aus dem Namen (bestehende behalten sie – wichtig für Warenkörbe) */
function refreshNewIds(m){
  if(!state.newIds.has(m.id)) return;
  state.newIds.delete(m.id);
  const taken = allIds(m);
  m.id = uniqueId(m.name || "gericht", taken);
  (m.variants || []).forEach((v, j) => { v.id = uniqueId(`${m.id}-${v.label || "v" + (j + 1)}`, taken); });
  state.newIds.add(m.id);
}
function readVal(el){
  switch(el.dataset.type){
    case "money": return parseMoney(el.value);
    case "bool": return el.checked;
    case "boolnot": return !el.checked;
    default: return el.value;
  }
}
function onInput(e){
  const el = e.target;
  if(el.id === "menuSearch"){ state.menuSearch = el.value; const pos = el.selectionStart; render(); const s = $("#menuSearch"); s.focus(); s.setSelectionRange(pos, pos); return; }
  if(el.dataset.tag && e.type === "change" && state.editIdx !== null){
    const m = state.draft.menu[state.editIdx], set = new Set(m.tags || []);
    el.checked ? set.add(el.dataset.tag) : set.delete(el.dataset.tag);
    m.tags = TAGS.map(t => t.key).filter(k => set.has(k));
    updateSaveBar();
    return;
  }
  if(el.dataset.actFile === "photo-upload" && e.type === "change"){ if(el.files[0]) uploadPhoto(el.files[0]); el.value = ""; return; }
  const path = el.dataset.bind;
  if(!path) return;
  const isToggle = el.type === "checkbox" || el.tagName === "SELECT";
  if(isToggle && e.type === "input") return;
  setP(path, readVal(el));
  if(el.getAttribute("aria-invalid")){
    el.removeAttribute("aria-invalid");
    const box = el.closest(".fld, .li-row, .town, .zone-head, .hours-row") || el;
    const err = box.nextElementSibling; if(err && err.classList.contains("field-err")) err.remove();
  }
  if(state.error){ state.error = ""; }
  // Kennung neuer Gerichte mitführen
  if(state.editIdx !== null && /^menu\.\d+\.(name|variants\.\d+\.label)$/.test(path)) refreshNewIds(state.draft.menu[state.editIdx]);
  if(el.hasAttribute("data-rerender") && e.type === "change"){
    if(el.closest("#itemDlg")) rerenderItem(); else { const y = window.scrollY; render(); window.scrollTo(0, y); }
  } else updateSaveBar();
  if(/^legal\.|^contact\.(instagram|facebook)/.test(path) && e.type === "change") renderTabs();
}

/* ---------------- Klicks ---------------- */
const listTemplate = path => {
  if(path === "extras.ingredients") return {name:"", hint:""};
  if(path === "extras.more") return {name:"", price:""};
  if(path === "delivery.zones") return {label:"", fee:"", towns:[{name:"", plz:"", city:""}]};
  if(/^delivery\.zones\.\d+\.towns$/.test(path)) return {name:"", plz:"", city:""};
  return "";
};
async function onClick(e){
  const b = e.target.closest("[data-act]");
  if(e.target.closest("[data-close-dlg]")){ e.target.closest("dialog").close(); return; }
  if(!b) return;
  const act = b.dataset.act, path = b.dataset.path, i = Number(b.dataset.i);
  const y = window.scrollY, rerender = () => { render(); window.scrollTo(0, y); };
  switch(act){
    case "tab": go(b.dataset.sec); break;
    case "goto": b.dataset.path ? gotoField(b.dataset.path) : go(b.dataset.sec); break;
    case "list-add": {
      const list = getP(path), tpl = listTemplate(path);
      list.push(tpl);
      const n = list.length - 1;
      rerender();
      focusPath(typeof tpl === "string" ? `${path}.${n}` : `${path}.${n}.${path === "delivery.zones" ? "label" : "name"}`);
      break;
    }
    case "list-del": {
      const list = getP(path), item = list[i];
      const label = typeof item === "string" ? item : (item && (item.name || item.label)) || "";
      if(label && !(await ask(`„${label}“ entfernen?`, "Entfernen"))) return;
      list.splice(i, 1); rerender(); break;
    }
    case "list-up": case "list-down": {
      const list = getP(path), j = act === "list-up" ? i - 1 : i + 1;
      if(j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]]; rerender(); break;
    }
    case "clear": setP(path, ""); rerender(); break;
    case "hours-copy": {
      const h = state.draft.hours, src = WEEK.map(d => h[d]).find(x => !x.closed);
      if(!src) return;
      WEEK.forEach(d => { if(!h[d].closed){ h[d].open = src.open; h[d].close = src.close; } });
      rerender(); toast("Zeiten übernommen – bitte speichern"); break;
    }
    case "menu-cat": state.menuCat = b.dataset.cat; render(); break;
    case "item-edit": openItem(i); break;
    case "item-up": case "item-down": {
      const menu = state.draft.menu, m = menu[i];
      const same = menu.map((x, k) => x.cat === m.cat ? k : -1).filter(k => k >= 0), pos = same.indexOf(i);
      const other = same[act === "item-up" ? pos - 1 : pos + 1];
      if(other === undefined) return;
      [menu[i], menu[other]] = [menu[other], menu[i]]; rerender(); break;
    }
    case "item-new": {
      const cat = b.dataset.cat, menu = state.draft.menu;
      const id = uniqueId("neues-gericht", allIds());
      const m = {id, cat, name:"", desc:"", price:"", tags:[], popular:false, available:true, photo:"", options: cat === "getraenke" ? "none" : "extra", side:false};
      let at = -1; menu.forEach((x, k) => { if(x.cat === cat) at = k; });
      at = at < 0 ? menu.length : at + 1;
      menu.splice(at, 0, m);
      state.newIds.add(id);
      render(); openItem(at); $("#itemDlgBody input").focus();
      break;
    }
    case "price-mode": {
      const m = state.draft.menu[state.editIdx];
      if(b.dataset.mode === "variants" && !(m.variants && m.variants.length)){
        const taken = allIds(m);
        m.variants = [{id:uniqueId(`${m.id}-haehnchen`, taken), label:"Hähnchen", price:m.price}, {id:uniqueId(`${m.id}-kalb`, taken), label:"Kalb", price:""}];
        delete m.price;
      } else if(b.dataset.mode === "single" && m.variants && m.variants.length){
        m.price = m.variants[0].price; delete m.variants;
      }
      rerenderItem(); updateSaveBar(); break;
    }
    case "var-add": {
      const m = state.draft.menu[state.editIdx];
      m.variants.push({id:uniqueId(`${m.id}-v${m.variants.length + 1}`, allIds()), label:"", price:""});
      rerenderItem(); updateSaveBar(); break;
    }
    case "var-del": {
      const m = state.draft.menu[state.editIdx];
      m.variants.splice(Number(b.dataset.j), 1);
      if(m.variants.length < 2){ m.price = m.variants.length ? m.variants[0].price : ""; delete m.variants; }
      rerenderItem(); updateSaveBar(); break;
    }
    case "photo-lib": openPhotoLib(); break;
    case "photo-none": state.draft.menu[state.editIdx].photo = ""; rerenderItem(); updateSaveBar(); break;
    case "photo-set": state.draft.menu[state.editIdx].photo = b.dataset.photo; $("#photoDlg").close(); rerenderItem(); updateSaveBar(); break;
    case "restore": restore(Number(b.dataset.v)); break;
    case "user-reset": state.resetUser = state.resetUser === b.dataset.user ? null : b.dataset.user; render(); if($("#resetPw")) $("#resetPw").focus(); break;
    case "user-del": deleteUser(b.dataset.user); break;
  }
}

/* ---------------- Gericht-Dialog: schließen / löschen ---------------- */
function onItemClose(){
  const i = state.editIdx;
  state.editIdx = null;
  const m = i === null ? null : state.draft.menu[i];
  // Neues, leeres Gericht wieder verwerfen
  if(m && state.newIds.has(m.id) && !m.name.trim() && !m.desc.trim() && (m.price === "" || m.price === undefined) && !m.variants){
    state.draft.menu.splice(i, 1); state.newIds.delete(m.id);
  }
  const y = window.scrollY; render(); window.scrollTo(0, y);
}
async function deleteItem(){
  const i = state.editIdx, m = state.draft.menu[i];
  if(!(await ask(`„${m.name || "Dieses Gericht"}“ von der Speisekarte löschen? (Wird erst mit „Speichern“ übernommen.)`, "Löschen"))) return;
  state.draft.menu.splice(i, 1);
  state.newIds.delete(m.id);
  state.editIdx = null;
  $("#itemDlg").close();
}

/* ---------------- Fotos ---------------- */
function openPhotoLib(){
  const m = state.draft.menu[state.editIdx];
  const used = state.draft.menu.map(x => x.photo).filter(p => p && p.startsWith("/api/photo/"));
  const all = [...new Set([...used, ...PHOTO_LIBRARY])];
  $("#photoDlgBody").innerHTML = `<p class="muted small">Tippe auf ein Foto, um es für „${esc(m.name || "dieses Gericht")}“ zu verwenden.</p>
    <div class="photo-grid">${all.map(p => `<button type="button" data-act="photo-set" data-photo="${esc(p)}" aria-pressed="${m.photo === p}" aria-label="Foto ${esc(p.split("/").pop())}">
      <img src="${esc(photoUrl(p, true))}" alt="" loading="lazy"></button>`).join("")}</div>`;
  $("#photoDlg").showModal();
}
function loadImage(file){
  return new Promise((ok, bad) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error("Dieses Bildformat wird nicht unterstützt – bitte ein JPG- oder PNG-Foto wählen."));
    img.src = url;
  });
}
async function encode(src, w, h){
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height, ratio = w / h;
  let cw = sw, ch = sw / ratio;
  if(ch > sh){ ch = sh; cw = sh * ratio; }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
  for(const q of [0.82, 0.72, 0.62, 0.5]){
    let url = c.toDataURL("image/webp", q);
    if(!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", Math.min(0.9, q + 0.05));
    if(url.length * 0.75 < 580 * 1024) return url;
  }
  throw new Error("Das Foto ist zu groß – bitte ein anderes wählen.");
}
async function uploadPhoto(file){
  const i = state.editIdx, msg = $("#photoMsg");
  const say = t => { if(msg) msg.textContent = t; };
  say("Foto wird vorbereitet …");
  try{
    if(file.size > 25 * 1024 * 1024) throw new Error("Die Datei ist sehr groß (über 25 MB) – bitte ein kleineres Foto wählen.");
    let src;
    try{ src = await createImageBitmap(file); }catch(e){ src = await loadImage(file); }
    const large = await encode(src, 800, 550), medium = await encode(src, 640, 440), small = await encode(src, 480, 330);
    say("Foto wird hochgeladen …");
    const r = await api("POST", "admin/photo", {large, medium, small});
    if(i !== null && state.draft.menu[i]) state.draft.menu[i].photo = r.photo;
    if(state.editIdx === i) rerenderItem();
    updateSaveBar();
    toast("Foto hochgeladen – bitte speichern");
  }catch(e){ say("⚠ " + e.message); toast(e.message, true); }
}

/* ---------------- Speichern ---------------- */
async function save(){
  if(state.saving || !dirty()) return;
  if(state.editIdx !== null) $("#itemDlg").close();
  state.saving = true; state.error = ""; clearFieldErrors(); updateSaveBar();
  try{
    const res = await api("PUT", "admin/settings", {baseVersion: state.version, settings: state.draft});
    state.newIds.clear();
    await loadState();
    toast(res.live === false ? "Gespeichert ✓ – auf der Website spätestens in 10 Minuten sichtbar" : "Gespeichert ✓ – in wenigen Sekunden auf der Website sichtbar");
  }catch(e){
    state.error = e.message;
    if(e.status === 422 && e.data && e.data.field) gotoField(e.data.field, e.message);
    else if(e.status !== 401) toast(e.message, true);
  }finally{
    state.saving = false; updateSaveBar();
  }
}
async function discard(){
  if(!(await ask("Alle ungespeicherten Änderungen verwerfen?", "Verwerfen"))) return;
  state.draft = clone(state.saved); state.error = ""; state.newIds.clear();
  render();
}
async function restore(v){
  const extra = dirty() ? " Deine ungespeicherten Änderungen gehen dabei verloren." : "";
  if(!(await ask(`Version ${v} wiederherstellen? Sie wird sofort auf der Website aktiv.${extra}`, "Wiederherstellen"))) return;
  try{
    await api("POST", "admin/restore", {version: v, baseVersion: state.version});
    await loadState();
    state.history = null; render();
    toast(`Version ${v} wiederhergestellt ✓`);
  }catch(e){ toast(e.message, true); }
}

/* ---------------- Zugänge ---------------- */
async function onSubmit(e){
  const f = e.target.closest("form[data-form]");
  if(!f) return;
  e.preventDefault();
  try{
    if(f.dataset.form === "password"){
      const cur = $("#pwCur").value, n1 = $("#pwNew").value, n2 = $("#pwNew2").value;
      if(n1 !== n2) throw new Error("Die neuen Passwörter stimmen nicht überein.");
      await api("POST", "admin/password", {current: cur, next: n1});
      f.reset(); toast("Passwort geändert ✓");
    }
    if(f.dataset.form === "user-add"){
      const user = $("#newUser").value.trim(), password = $("#newUserPw").value;
      const confirm = await askPassword(`Zur Sicherheit: Gib dein eigenes Passwort ein, um den Zugang „${user}“ anzulegen.`);
      if(confirm === null) return;
      const r = await api("POST", "admin/users", {user, password, confirm});
      state.users = r.users; render(); toast("Zugang angelegt ✓ – Benutzername und Passwort jetzt weitergeben");
    }
    if(f.dataset.form === "user-reset"){
      const u = state.resetUser, password = $("#resetPw").value;
      const confirm = await askPassword(`Zur Sicherheit: Gib dein eigenes Passwort ein, um das Passwort von „${u}“ neu zu setzen.`);
      if(confirm === null) return;
      await api("POST", `admin/users/${encodeURIComponent(u)}/password`, {password, confirm});
      state.resetUser = null; render(); toast(`Neues Passwort für ${u} gesetzt ✓`);
    }
  }catch(err){ toast(err.message, true); }
}
async function deleteUser(u){
  const confirm = await askPassword(`Zugang „${u}“ löschen? Diese Person kann sich dann nicht mehr anmelden. Zur Sicherheit: Gib dein eigenes Passwort ein.`);
  if(confirm === null) return;
  try{ state.users = (await api("DELETE", `admin/users/${encodeURIComponent(u)}`, {confirm})).users; render(); toast("Zugang gelöscht"); }
  catch(e){ toast(e.message, true); }
}

/* ---------------- Rückfrage & Meldungen ---------------- */
function ask(text, yes = "Ja"){
  return new Promise(resolve => {
    const d = $("#confirmDlg");
    $("#confirmText").textContent = text;
    $("#confirmYes").textContent = yes;
    const done = v => { d.close(); $("#confirmYes").onclick = $("#confirmNo").onclick = null; d.oncancel = null; resolve(v); };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
    d.oncancel = ev => { ev.preventDefault(); done(false); };
    d.showModal();
    $("#confirmNo").focus();
  });
}
/* Eigenes Passwort abfragen (für Zugänge verwalten). Ergebnis: Passwort oder null (abgebrochen) */
function askPassword(text){
  return new Promise(resolve => {
    const d = $("#pwDlg"), inp = $("#pwDlgInput");
    $("#pwDlgText").textContent = text;
    inp.value = "";
    const done = v => { d.close(); $("#pwDlgForm").onsubmit = $("#pwDlgNo").onclick = d.oncancel = null; inp.value = ""; resolve(v); };
    $("#pwDlgForm").onsubmit = ev => { ev.preventDefault(); if(inp.value) done(inp.value); else inp.focus(); };
    $("#pwDlgNo").onclick = () => done(null);
    d.oncancel = ev => { ev.preventDefault(); done(null); };
    d.showModal();
    inp.focus();
  });
}
let toastT;
function toast(text, bad = false){
  const t = $("#toast");
  t.textContent = text; t.classList.toggle("bad", bad); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3200);
}

/* ---------------- Anmelden / Einrichten ---------------- */
function show(id){
  ["#scrLoading", "#scrSetup", "#scrLogin", "#scrApp"].forEach(s => { $(s).hidden = s !== id; });
}
function formError(sel, msg){ const el = $(sel); el.textContent = msg; el.hidden = !msg; }
async function loadState(){
  const s = await api("GET", "admin/state");
  if(!state.defaults && !s.settings){
    const r = await fetch("/data/defaults.json", {cache:"no-store"});
    state.defaults = await r.json();
  }
  Object.assign(state, {user:s.user, users:s.users, version:s.version, savedAt:s.savedAt, by:s.by});
  state.saved = clone(s.settings || state.defaults);
  state.draft = clone(state.saved);
  state.error = "";
}
async function startApp(){
  await loadState();
  Object.assign(state, {sec:"overview", history:null, menuSearch:"", menuCat:"all", resetUser:null, editIdx:null});
  state.newIds.clear();
  show("#scrApp");
  render();
}
async function boot(){
  try{
    const st = await api("GET", "auth/status");
    if(!st.setupDone){ show("#scrSetup"); $("#suCode").focus(); return; }
    if(!st.user){ show("#scrLogin"); $("#liUser").focus(); return; }
    await startApp();
  }catch(e){
    show("#scrLoading");
    $("#scrLoading p").innerHTML = `${esc(e.message)} <button class="linkbtn" type="button" id="retryBtn">Nochmal versuchen</button>`;
    $("#retryBtn").onclick = () => location.reload();
  }
}
function openRelogin(){
  const d = $("#reloginDlg");
  if(d.open) return;
  $("#rlUser").value = state.user || "";
  formError("#reloginErr", "");
  d.showModal();
  $("#rlPass").focus();
}

document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("input", onInput);
  document.addEventListener("change", onInput);
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  $("#saveBtn").addEventListener("click", save);
  $("#discardBtn").addEventListener("click", discard);
  $("#itemDlg").addEventListener("close", onItemClose);
  $("#itemDelete").addEventListener("click", deleteItem);
  $("#reloginDlg").addEventListener("cancel", e => e.preventDefault());
  window.addEventListener("beforeunload", e => { if(dirty()){ e.preventDefault(); e.returnValue = ""; } });

  $("#setupForm").addEventListener("submit", async e => {
    e.preventDefault(); formError("#setupErr", "");
    if($("#suPass").value !== $("#suPass2").value) return formError("#setupErr", "Die Passwörter stimmen nicht überein.");
    try{
      await api("POST", "auth/setup", {code: $("#suCode").value, user: $("#suUser").value.trim(), password: $("#suPass").value});
      await startApp();
      toast("Willkommen! Dein Zugang ist eingerichtet ✓");
    }catch(err){ formError("#setupErr", err.message); }
  });
  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault(); formError("#loginErr", "");
    try{
      await api("POST", "auth/login", {user: $("#liUser").value.trim(), password: $("#liPass").value});
      $("#liPass").value = "";
      await startApp();
    }catch(err){ formError("#loginErr", err.message); $("#liPass").select(); }
  });
  $("#reloginForm").addEventListener("submit", async e => {
    e.preventDefault(); formError("#reloginErr", "");
    try{
      await api("POST", "auth/login", {user: $("#rlUser").value.trim(), password: $("#rlPass").value});
      $("#rlPass").value = "";
      $("#reloginDlg").close();
      toast("Wieder angemeldet ✓ – bitte die letzte Aktion wiederholen");
    }catch(err){ formError("#reloginErr", err.message); }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    if(dirty() && !(await ask("Es gibt ungespeicherte Änderungen. Trotzdem abmelden?", "Abmelden"))) return;
    try{ await api("POST", "auth/logout"); }catch(e){}
    state.saved = state.draft = null; state.user = null;
    show("#scrLogin"); $("#liUser").focus();
  });
  boot();
});
