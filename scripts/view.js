/**
 * Markup des Lagerfensters – ohne Foundry-Abhängigkeiten, damit es sich auch
 * außerhalb von Foundry (Vorschau) zeichnen lässt.
 */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString("de-DE");

/** Verzierungen, die einmalig über das ganze Fenster gelegt werden. */
export const DECO_HTML = `<div class="cr-deco" aria-hidden="true">
  <div class="cr-corners"></div>
  <div class="cr-banner"></div>
  <div class="cr-lantern"><span class="cr-glow"></span></div>
  <div class="cr-crates"></div>
</div>`;

function card(m, vm) {
  const pledges = m.pledges.map((x) => `<li data-tooltip="${esc(x.itemName)} von ${esc(x.fromName)}">
      <img src="${esc(x.img)}" alt=""><span>×${x.qty}</span>
      ${x.canRemove ? `<button type="button" class="cr-minus" data-action="unpledge" data-pledge-id="${esc(x.id)}"
        data-tooltip="Eins herausnehmen" aria-label="Eins herausnehmen"><i class="fa-solid fa-minus"></i></button>` : ""}
    </li>`).join("");

  const penalty = vm.isGM && !m.ok
    ? `<button type="button" class="cr-penalty ${m.waived ? "waived" : ""}" data-action="togglePenalty" data-actor-id="${esc(m.id)}">
        ${m.waived ? '<i class="fa-solid fa-dove"></i> Strafe erlassen' : '<i class="fa-solid fa-gavel"></i> Strafe droht'}</button>`
    : "";

  return `<section class="cr-card ${m.ok ? "ok" : "missing"}" data-actor-id="${esc(m.id)}">
    <div class="cr-portrait">
      <img src="${esc(m.img)}" alt="">
      ${m.ok ? '<span class="cr-badge" data-tooltip="Versorgt"><i class="fa-solid fa-check"></i></span>' : ""}
    </div>
    <div class="cr-plate">${esc(m.name)}</div>
    <div class="cr-count"><i class="fa-solid fa-bread-slice"></i> <b>${fmt(m.have)}/${fmt(vm.required)}</b></div>
    ${pledges ? `<ul class="cr-pledges">${pledges}</ul>` : ""}
    <div class="cr-drop"><i class="fa-solid fa-box-open"></i> Vorräte hineinziehen</div>
    ${penalty}
  </section>`;
}

/**
 * @param {object} vm
 * @param {boolean} vm.isGM
 * @param {number} vm.required
 * @param {Array} vm.members   {id,name,img,have,ok,waived,pledges:[{id,img,itemName,qty,fromName,canRemove}]}
 * @param {Array} vm.supplies  {uuid,img,name,left,owner}
 */
export function campView(vm) {
  const total = vm.members.length;
  const done = vm.members.filter((m) => m.ok).length;
  const allDone = total > 0 && done === total;

  const stores = vm.isGM
    ? `<h3>Lagerübersicht</h3>
       <p class="cr-hint">Die Spieler ziehen ihre Vorräte auf die Karten. Unversorgten kannst du die Strafe erlassen.</p>`
    : `<h3>Deine Vorräte</h3>
       ${vm.supplies.length
         ? `<div class="cr-supplies">${vm.supplies.map((s) => `
             <div class="cr-supply ${s.left <= 0 ? "empty" : ""}" draggable="${s.left > 0}" data-uuid="${esc(s.uuid)}"
               data-tooltip="${esc(s.name)} · ${esc(s.owner)}">
               <img src="${esc(s.img)}" alt=""><span class="cr-supply-name">${esc(s.name)}</span><b>${s.left}</b>
             </div>`).join("")}</div>`
         : `<p class="cr-hint">Keine Rationen oder Lagervorräte im Inventar.</p>`}`;

  const footer = vm.isGM
    ? `<div class="cr-footer-hint">${allDone ? "Alle sind versorgt – das Lager ist bereit." : "Noch nicht alle sind versorgt. Unversorgte erhalten die eingestellte Strafe."}</div>
       <div class="cr-footer-buttons">
         <button type="button" class="cr-btn" data-action="cancel"><i class="fa-solid fa-xmark"></i> Abbrechen</button>
         <button type="button" class="cr-btn cr-primary" data-action="finish"><i class="fa-solid fa-fire"></i> Rast starten</button>
       </div>`
    : `<div class="cr-footer-hint">${allDone ? "Alle sind versorgt – der Spielleiter kann die Rast starten." : "Der Spielleiter startet die Rast, sobald alle versorgt sind."}<br>Shift beim Ablegen = Anzahl wählen.</div>
       <div class="cr-footer-buttons">
         <button type="button" class="cr-btn cr-primary" disabled data-tooltip="Nur der Spielleiter kann die Rast starten">
           <i class="fa-solid fa-fire"></i> Rast starten</button>
       </div>`;

  return `
    <div class="cr-summary"><i class="fa-solid fa-fire-flame-curved"></i>
      <span><b>${done} von ${total} versorgt</b><span class="cr-dot">·</span>Benötigt pro Person: ${fmt(vm.required)}</span>
    </div>
    <section class="cr-stores">
      <div class="cr-sketch left"></div><div class="cr-sketch right"></div>
      <div class="cr-stores-body">${stores}</div>
    </section>
    <div class="cr-bar">
      <span class="cr-bar-title"><i class="fa-solid fa-users"></i> Wer benötigt Nahrung?</span>
      <span class="cr-bar-count">Versorgt: ${done} / ${total}</span>
    </div>
    <div class="cr-members">${vm.members.map((m) => card(m, vm)).join("")}</div>
    <footer class="cr-footer">${footer}</footer>`;
}
