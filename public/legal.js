/* Impressum & Datenschutz: Angaben aus dem Admin-Bereich einsetzen (Name, E-Mail, Rechtsform, Register, USt-ID, Telefon).
   Ohne JavaScript bleiben die Platzhalter aus dem HTML stehen. */
(function(){
  "use strict";
  function get(url){
    return fetch(url, {credentials:"omit"}).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  }
  function phoneIntl(p){
    p = String(p || "").replace(/[^\d+]/g, "");
    if(p.charAt(0) === "+") return p;
    if(p.indexOf("00") === 0) return "+" + p.slice(2);
    return "+49" + p.replace(/^0/, "");
  }
  function phoneNat(p){
    var i = phoneIntl(p);
    if(i.indexOf("+49") !== 0) return i;
    return ("0" + i.slice(3)).replace(/^(01\d{2}|0\d{4})(\d+)$/, "$1 $2");
  }
  function apply(s){
    if(!s || !s.legal) return;
    var L = s.legal;
    if(!L.responsible && L.owner) L.responsible = L.owner;
    document.querySelectorAll("[data-legal]").forEach(function(el){
      var v = L[el.getAttribute("data-legal")];
      if(!v) return;
      el.classList.remove("todo");
      if(el.getAttribute("data-legal") === "email"){
        var a = document.createElement("a");
        a.href = "mailto:" + v; a.textContent = v;
        el.replaceChildren(a);
      } else el.textContent = v;
    });
    // Register und USt-ID nur zeigen, wenn vorhanden
    document.querySelectorAll("[data-legal-section]").forEach(function(sec){
      sec.hidden = !L[sec.getAttribute("data-legal-section")];
    });
    var c = s.contact || {};
    document.querySelectorAll('[data-contact="tel"]').forEach(function(a){
      if(!c.phone) return;
      a.href = "tel:" + phoneIntl(c.phone); a.textContent = phoneNat(c.phone);
    });
    document.querySelectorAll('[data-contact="wa"]').forEach(function(a){
      if(!c.whatsapp) return;
      var n = String(c.whatsapp).replace(/\D/g, "");
      a.href = "https://wa.me/" + n;
      a.textContent = n.indexOf("49") === 0 ? "+49 " + n.slice(2, 5) + " " + n.slice(5) : "+" + n;
    });
  }
  get("/api/settings").then(function(live){
    if(live && live.settings) return live.settings;
    return get("/data/defaults.json");
  }).then(apply);
})();
