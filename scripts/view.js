/**
 * Markup des Lagerfensters – ohne Foundry-Abhängigkeiten, damit es sich auch
 * außerhalb von Foundry (Vorschau) zeichnen lässt.
 */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString("de-DE");

/** Gemalte Verzierungen, die einmalig über das ganze Fenster gelegt werden. */
export const DECO_HTML = `<div class="cr-deco" aria-hidden="true">
  <div class="cr-post left"></div><div class="cr-post right"></div>
  <div class="cr-curtain left"></div>
  <div class="cr-curtain right"></div>
  <div class="cr-corner tl"></div>
  <div class="cr-corner br"></div>
  <div class="cr-banner"></div>
  <div class="cr-lantern"><span class="cr-glow"></span></div>
</div>`;

function card(m, vm) {
  const pledges = m.pledges.map((x) => `<li data-tooltip="${esc(x.itemName)} von ${esc(x.fromName)}">
      <span class="cr-token"><img src="${esc(x.img)}" alt=""></span><span class="cr-qty">x${x.qty}</span>
      ${x.canRemove ? `<button type="button" class="cr-minus" data-action="unpledge" data-pledge-id="${esc(x.id)}"
        data-tooltip="Eins herausnehmen" aria-label="Eins herausnehmen"></button>` : ""}
    </li>`).join("");

  const penalty = vm.isGM && !m.ok
    ? `<button type="button" class="cr-penalty ${m.waived ? "waived" : ""}" data-action="togglePenalty" data-actor-id="${esc(m.id)}">
        ${m.waived ? '<i class="fa-solid fa-dove"></i> Strafe erlassen' : '<i class="fa-solid fa-gavel"></i> Strafe droht'}</button>`
    : "";

  return `<section class="cr-card ${m.ok ? "ok" : "missing"}" data-actor-id="${esc(m.id)}">
    <span class="cr-check ${m.ok ? "on" : ""}" data-tooltip="${m.ok ? "Versorgt" : "Noch nicht versorgt"}"></span>
    <div class="cr-portrait"><img src="${esc(m.img)}" alt=""></div>
    <div class="cr-plate">${esc(m.name)}</div>
    <div class="cr-count"><span class="cr-bread"></span><b>${fmt(m.have)}/${fmt(vm.required)}</b></div>
    ${pledges ? `<ul class="cr-pledges">${pledges}</ul>` : ""}
    <div class="cr-drop"><span class="cr-sack"></span>Vorräte hineinziehen</div>
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

  const chips = vm.isGM
    ? ""
    : vm.supplies.map((s) => `
        <div class="cr-supply ${s.left <= 0 ? "empty" : ""}" draggable="${s.left > 0}" data-uuid="${esc(s.uuid)}"
          data-tooltip="${esc(s.name)} · ${esc(s.owner)}">
          <img src="${esc(s.img)}" alt=""><span class="cr-supply-name">${esc(s.name)}</span><b>${s.left}</b>
        </div>`).join("");

  const storesText = vm.isGM
    ? `<h3>Lagerübersicht</h3><p>Spieler ziehen ihre Vorräte auf die Karten. Unversorgten kannst du die Strafe erlassen.</p>`
    : `<h3>Deine Vorräte</h3><p>${vm.supplies.length ? "Rationen und Lagergüter im Inventar." : "Keine Rationen oder Lagervorräte im Inventar."}</p>`;

  const footer = vm.isGM
    ? `<div class="cr-footer-hint">${allDone
        ? "Alle sind versorgt – das Lager ist bereit."
        : "Noch nicht alle sind versorgt.<br>Unversorgte erhalten die eingestellte Strafe."}</div>
       <div class="cr-footer-buttons">
         <button type="button" class="cr-btn cr-cancel" data-action="cancel">Abbrechen</button>
         <button type="button" class="cr-btn cr-start" data-action="finish"><span class="cr-campfire"></span>Rast starten</button>
       </div>`
    : `<div class="cr-footer-hint">Der Spielleiter startet die Rast, sobald alle benötigten Tokens ausgewählt und versorgt sind.<br>Shift beim Ablegen = Anzahl wählen.</div>
       <div class="cr-footer-buttons">
         <button type="button" class="cr-btn cr-start" disabled data-tooltip="Nur der Spielleiter kann die Rast starten">
           <span class="cr-campfire"></span>Rast starten</button>
       </div>`;

  return `
    <div class="cr-summary"><span class="cr-flame"></span>
      <span><em>${done}</em> <b>von ${total} versorgt</b><span class="cr-dot">·</span><b>Benötigt pro Person: ${fmt(vm.required)}</b></span>
    </div>
    <section class="cr-stores">
      <div class="cr-stores-head"><span class="cr-sack big"></span><div>${storesText}</div></div>
      <div class="cr-supplies">${chips}</div>
      <div class="cr-sketch"></div>
    </section>
    <div class="cr-bar">
      <span class="cr-bar-title"><span class="cr-group"></span>Wer benötigt Nahrung?</span>
      <span class="cr-bar-count">Ausgewählt: ${done} / ${total}</span>
    </div>
    <div class="cr-members">${vm.members.map((m) => card(m, vm)).join("")}</div>
    <footer class="cr-footer">${footer}</footer>`;
}
