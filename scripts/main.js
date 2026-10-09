/**
 * Ascandir - Rest Manager
 * Gemeinsame lange Rast mit Rationen / Lagervorräten für D&D 5e.
 * Foundry VTT v13/v14 · dnd5e 5.x
 */

const MOD = "ascandir-rest-manager";
const SOCKET = `module.${MOD}`;
const { ApplicationV2, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Standardwerte                               */
/* -------------------------------------------- */

const DEFAULT_SUPPLIES = {
  required: 1,          // benötigte Vorrats-Punkte pro Charakter
  partial: true,        // "Rations (1 day)" zählt auch für den Eintrag "Rations"
  deleteEmpty: false,   // Gegenstand löschen, wenn Menge 0 erreicht
  entries: [
    { name: "Rations", value: 1 },
    { name: "Rationen", value: 1 },
    { name: "Camp Supplies", value: 1 },
    { name: "Lagervorräte", value: 1 }
  ]
};

const DEFAULT_PENALTY = {
  denyRest: false,      // gar keine lange Rast
  noHP: false,          // keine Trefferpunkte zurück
  noHD: true,           // keine Trefferwürfel zurück
  noSlots: false,       // keine Zauberplätze zurück
  exhaustion: 1,        // zusätzliche Erschöpfungsstufen
  message: "{name} hatte nicht genug Vorräte und verbringt eine hungrige, unruhige Nacht."
};

/* -------------------------------------------- */
/*  Hilfsfunktionen                             */
/* -------------------------------------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").trim().toLowerCase();
const getDoc = (uuid) => (foundry.utils.fromUuid ?? globalThis.fromUuid)(uuid);

const getSupplies = () => foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SUPPLIES),
  game.settings.get(MOD, "supplyConfig") ?? {}, { inplace: false });
const getPenalty = () => foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_PENALTY),
  game.settings.get(MOD, "penaltyConfig") ?? {}, { inplace: false });
const getState = () => foundry.utils.deepClone(game.settings.get(MOD, "state") ?? { active: false });
const setState = (state) => game.settings.set(MOD, "state", state);

/** Wie viele Vorrats-Punkte ist ein Gegenstand pro Stück wert? 0 = kein Vorrat. */
function supplyValue(item) {
  const cfg = getSupplies();
  const name = norm(item?.name);
  const ident = norm(item?.system?.identifier);
  for (const e of cfg.entries ?? []) {
    const key = norm(e.name);
    if (!key) continue;
    if (name === key || ident === key || (cfg.partial && name.includes(key))) return Number(e.value) || 0;
  }
  return 0;
}

/** Summe der Vorrats-Punkte, die für einen Charakter ins Lager gelegt wurden. */
function suppliedFor(state, actorId) {
  return (state.pledges ?? []).filter((p) => p.toActorId === actorId)
    .reduce((sum, p) => sum + p.qty * p.value, 0);
}

/** Wie viele Stück eines Gegenstands sind schon verplant? */
function pledgedOf(state, itemUuid) {
  return (state.pledges ?? []).filter((p) => p.itemUuid === itemUuid).reduce((s, p) => s + p.qty, 0);
}

function maxExhaustion() {
  return CONFIG.DND5E?.conditionTypes?.exhaustion?.levels ?? 6;
}

/* -------------------------------------------- */
/*  Kommunikation Spieler -> SL                 */
/* -------------------------------------------- */

let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((err) => console.error(`${MOD} |`, err)));

/** Spieler schicken Wünsche an den aktiven SL, nur der SL ändert den Zustand. */
function request(action, data = {}) {
  const payload = { action, data, userId: game.user.id };
  if (game.user.isActiveGM) return enqueue(() => handleRequest(payload));
  if (!game.users.activeGM) return ui.notifications.warn("Rest Manager: Kein Spielleiter online.");
  game.socket.emit(SOCKET, payload);
}

function notifyUser(userId, msg) {
  if (userId === game.user.id) return ui.notifications.warn(msg);
  game.socket.emit(SOCKET, { action: "notify", target: userId, msg });
}

async function handleRequest({ action, data, userId }) {
  const user = game.users.get(userId);
  const state = getState();
  if (!user || !state.active) return;

  switch (action) {
    case "pledge": {
      const item = await getDoc(data.itemUuid);
      const owner = item?.parent;
      if (!item || !(owner instanceof Actor)) {
        return notifyUser(userId, "Nur Gegenstände aus dem Inventar eines Charakters können ins Lager gelegt werden.");
      }
      if (!owner.testUserPermission(user, "OWNER")) {
        return notifyUser(userId, "Du kannst nur Gegenstände deiner eigenen Charaktere abgeben.");
      }
      const value = supplyValue(item);
      if (value <= 0) return notifyUser(userId, `${item.name} zählt nicht als Ration oder Lagervorrat.`);
      if (!state.participants.some((p) => p.id === data.toActorId)) return;

      const qty = Math.max(1, Math.floor(Number(data.qty) || 1));
      const available = (Number(item.system.quantity) || 0) - pledgedOf(state, item.uuid);
      if (available < qty) {
        return notifyUser(userId, `Nicht genug ${item.name} übrig (noch ${Math.max(available, 0)} verfügbar).`);
      }
      const existing = state.pledges.find((p) => p.itemUuid === item.uuid && p.toActorId === data.toActorId);
      if (existing) existing.qty += qty;
      else state.pledges.push({
        id: foundry.utils.randomID(),
        itemUuid: item.uuid, itemName: item.name, img: item.img,
        fromActorId: owner.id, fromName: owner.name,
        toActorId: data.toActorId, qty, value
      });
      break;
    }

    case "unpledge": {
      const pledge = state.pledges.find((p) => p.id === data.pledgeId);
      if (!pledge) return;
      const from = game.actors.get(pledge.fromActorId);
      if (!user.isGM && !from?.testUserPermission(user, "OWNER")) {
        return notifyUser(userId, "Du kannst nur deine eigenen Vorräte wieder herausnehmen.");
      }
      pledge.qty -= 1;
      if (pledge.qty <= 0) state.pledges = state.pledges.filter((p) => p !== pledge);
      break;
    }

    case "togglePenalty": {
      if (!user.isGM) return;
      state.noPenalty ??= {};
      state.noPenalty[data.actorId] = !state.noPenalty[data.actorId];
      break;
    }

    default: return;
  }

  state.rev = (state.rev ?? 0) + 1;
  await setState(state);
}

/* -------------------------------------------- */
/*  Ablauf: Anfrage, Abschluss, Abbruch         */
/* -------------------------------------------- */

async function startRequest() {
  if (!game.user.isGM) return ui.notifications.warn("Nur der Spielleiter kann eine lange Rast anfragen.");
  if (getState().active) {
    CampRestApp.show();
    return ui.notifications.info("Es läuft bereits eine Rastanfrage.");
  }
  const chars = game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
  if (!chars.length) return ui.notifications.warn("Keine Spielercharaktere gefunden.");

  const content = `<p>Wer nimmt an der langen Rast teil?</p>
    <div class="camp-rest-pick">${chars.map((a) => `
      <label><input type="checkbox" name="p" value="${a.id}" checked>
      <img src="${esc(a.img)}" width="28" height="28"> ${esc(a.name)}</label>`).join("")}
    </div>`;

  const ids = await DialogV2.wait({
    window: { title: "Lange Rast anfragen", icon: "fa-solid fa-campground" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "ok", label: "Anfrage senden", icon: "fa-solid fa-paper-plane", default: true,
        callback: (event, button) => [...button.form.querySelectorAll('input[name="p"]:checked')].map((i) => i.value)
      },
      { action: "cancel", label: "Abbrechen", icon: "fa-solid fa-xmark" }
    ]
  });
  if (!Array.isArray(ids) || !ids.length) return;

  const participants = ids.map((id) => game.actors.get(id)).filter(Boolean)
    .map((a) => ({ id: a.id, name: a.name, img: a.img }));

  await setState({ active: true, id: foundry.utils.randomID(), participants, pledges: [], noPenalty: {}, rev: 1 });
  await ChatMessage.create({
    content: `<div class="camp-rest-chat"><h3><i class="fa-solid fa-campground"></i> Lange Rast angefragt</h3>
      <p>Legt eure Rationen und Lagervorräte ins Lager! Benötigt pro Person: <strong>${getSupplies().required}</strong>.</p></div>`
  });
}

async function cancelRequest() {
  const ok = await DialogV2.confirm({
    window: { title: "Rastanfrage abbrechen" },
    content: "<p>Die Anfrage abbrechen? Es werden keine Vorräte verbraucht.</p>",
    rejectClose: false
  });
  if (!ok) return;
  await setState({ active: false });
  await ChatMessage.create({ content: `<div class="camp-rest-chat"><p><i class="fa-solid fa-campground"></i> Die lange Rast wurde abgebrochen.</p></div>` });
}

async function finishRest() {
  const state = getState();
  if (!state.active) return;
  const required = Number(getSupplies().required) || 0;
  const penalty = getPenalty();

  const rows = state.participants.map((p) => {
    const have = suppliedFor(state, p.id);
    const short = have < required;
    const punished = short && !state.noPenalty?.[p.id];
    return { ...p, have, short, punished };
  });

  const list = rows.map((r) => `<li>${esc(r.name)}: ${r.have}/${required}
    ${r.punished ? "<strong>– Strafe</strong>" : r.short ? "– unterversorgt, Strafe erlassen" : "✔"}</li>`).join("");
  const ok = await DialogV2.confirm({
    window: { title: "Lange Rast durchführen" },
    content: `<p>Die lange Rast jetzt durchführen? Die eingelegten Vorräte werden verbraucht.</p><ul>${list}</ul>`,
    rejectClose: false
  });
  if (!ok) return;

  // 1) Vorräte abziehen
  const byItem = new Map();
  for (const p of state.pledges) byItem.set(p.itemUuid, (byItem.get(p.itemUuid) ?? 0) + p.qty);
  const deleteEmpty = getSupplies().deleteEmpty;
  for (const [uuid, used] of byItem) {
    const item = await getDoc(uuid);
    if (!item) continue;
    const left = Math.max(0, (Number(item.system.quantity) || 0) - used);
    if (left === 0 && deleteEmpty) await item.delete();
    else await item.update({ "system.quantity": left });
  }

  // 2) Fenster bei allen schließen
  await setState({ active: false });

  // 3) Rasten
  for (const r of rows) {
    const actor = game.actors.get(r.id);
    if (!actor) continue;
    try {
      if (r.punished) await restWithPenalty(actor, penalty);
      else await actor.longRest({ dialog: false, chat: true });
    } catch (err) {
      console.error(`${MOD} | Rast für ${actor.name} fehlgeschlagen`, err);
      ui.notifications.error(`Lange Rast für ${actor.name} fehlgeschlagen – siehe Konsole (F12).`);
    }
  }
}

/** Lange Rast mit Strafe: vorher Werte merken, rasten, dann gewählte Werte zurücksetzen. */
async function restWithPenalty(actor, pen) {
  const effects = [];
  const exLevels = Math.max(0, Math.floor(Number(pen.exhaustion) || 0));

  if (pen.denyRest) {
    effects.push("erhält <strong>keine</strong> lange Rast");
    if (exLevels) {
      const cur = Number(actor.system.attributes?.exhaustion) || 0;
      await actor.update({ "system.attributes.exhaustion": Math.min(maxExhaustion(), cur + exLevels) });
      effects.push(`+${exLevels} Erschöpfung`);
    }
    return postPenalty(actor, pen, effects);
  }

  // Momentaufnahme vor der Rast
  const src = actor._source.system;
  const snap = {
    hp: src.attributes?.hp?.value,
    spells: Object.fromEntries(Object.entries(src.spells ?? {})
      .filter(([, v]) => typeof v?.value === "number").map(([k, v]) => [k, v.value])),
    hd: actor.itemTypes.class.map((c) => (c._source.system.hd?.spent !== undefined)
      ? { _id: c.id, "system.hd.spent": c._source.system.hd.spent }
      : { _id: c.id, "system.hitDiceUsed": c._source.system.hitDiceUsed ?? 0 })
  };

  await actor.longRest({ dialog: false, chat: true });

  const update = {};
  if (pen.noHP && typeof snap.hp === "number") {
    update["system.attributes.hp.value"] = snap.hp;
    effects.push("keine Trefferpunkte zurück");
  }
  if (pen.noSlots) {
    for (const [k, v] of Object.entries(snap.spells)) update[`system.spells.${k}.value`] = v;
    effects.push("keine Zauberplätze zurück");
  }
  if (exLevels) {
    const cur = Number(actor.system.attributes?.exhaustion) || 0;
    update["system.attributes.exhaustion"] = Math.min(maxExhaustion(), cur + exLevels);
    effects.push(`+${exLevels} Erschöpfung`);
  }
  if (Object.keys(update).length) await actor.update(update);
  if (pen.noHD && snap.hd.length) {
    await actor.updateEmbeddedDocuments("Item", snap.hd);
    effects.push("keine Trefferwürfel zurück");
  }
  return postPenalty(actor, pen, effects);
}

function postPenalty(actor, pen, effects) {
  const text = esc(pen.message || "").replaceAll("{name}", esc(actor.name));
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="camp-rest-chat penalty"><h3><i class="fa-solid fa-drumstick-bite"></i> Zu wenig Vorräte</h3>
      ${text ? `<p>${text}</p>` : ""}
      ${effects.length ? `<p><em>${effects.join(" · ")}</em></p>` : ""}</div>`
  });
}

/* -------------------------------------------- */
/*  Lagerfenster                                */
/* -------------------------------------------- */

class CampRestApp extends ApplicationV2 {
  static instance = null;
  static lastRequestId = null;

  static DEFAULT_OPTIONS = {
    id: "camp-rest-app",
    classes: ["camp-rest"],
    window: { title: "Lager für die lange Rast", icon: "fa-solid fa-campground", resizable: true },
    position: { width: 620, height: "auto" },
    actions: {
      unpledge: CampRestApp.onUnpledge,
      togglePenalty: CampRestApp.onTogglePenalty,
      finish: () => finishRest(),
      cancel: () => cancelRequest()
    }
  };

  static show() {
    this.instance ??= new CampRestApp();
    this.instance.render({ force: true });
  }

  static refresh() {
    if (this.instance?.rendered) this.instance.render();
  }

  static hide() {
    if (this.instance?.rendered) this.instance.close();
  }

  async _renderHTML() {
    const state = getState();
    const required = Number(getSupplies().required) || 0;
    const isGM = game.user.isGM;

    const members = (state.participants ?? []).map((p) => {
      const have = suppliedFor(state, p.id);
      const ok = have >= required;
      const waived = !!state.noPenalty?.[p.id];
      const pledges = state.pledges.filter((x) => x.toActorId === p.id).map((x) => {
        const from = game.actors.get(x.fromActorId);
        const canRemove = isGM || from?.isOwner;
        return `<li>
          <img src="${esc(x.img)}"><span class="cr-item">${esc(x.itemName)} ×${x.qty}</span>
          <span class="cr-from">von ${esc(x.fromName)}</span>
          ${canRemove ? `<button type="button" class="cr-icon" data-action="unpledge" data-pledge-id="${x.id}"
            data-tooltip="Eins herausnehmen"><i class="fa-solid fa-minus"></i></button>` : ""}
        </li>`;
      }).join("");

      return `<section class="cr-member ${ok ? "ok" : "missing"}" data-actor-id="${p.id}">
        <header>
          <img src="${esc(p.img)}">
          <span class="cr-name">${esc(p.name)}</span>
          <span class="cr-status">${ok ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-xmark"></i>'} ${have}/${required}</span>
        </header>
        <ul class="cr-pledges">${pledges}</ul>
        <div class="cr-drop"><i class="fa-solid fa-hand-holding"></i> Vorräte hier hineinziehen</div>
        ${isGM && !ok ? `<button type="button" class="cr-penalty ${waived ? "waived" : ""}" data-action="togglePenalty" data-actor-id="${p.id}">
          ${waived ? '<i class="fa-solid fa-dove"></i> Strafe erlassen' : '<i class="fa-solid fa-gavel"></i> Strafe wird angewendet'}</button>` : ""}
      </section>`;
    }).join("");

    // Eigene Vorräte des Spielers als Ziehquelle
    let mine = "";
    if (!isGM) {
      const items = game.actors.filter((a) => a.isOwner && a.type === "character")
        .flatMap((a) => a.items.contents.filter((i) => supplyValue(i) > 0).map((i) => ({ a, i })));
      mine = `<div class="cr-mine"><h4>Deine Vorräte</h4>${items.length
        ? items.map(({ a, i }) => {
          const left = (Number(i.system.quantity) || 0) - pledgedOf(state, i.uuid);
          return `<div class="cr-supply ${left <= 0 ? "empty" : ""}" draggable="${left > 0}" data-uuid="${i.uuid}"
            data-tooltip="${esc(a.name)}"><img src="${esc(i.img)}"> ${esc(i.name)} <b>${left}</b></div>`;
        }).join("")
        : "<p class='cr-hint'>Keine Rationen oder Lagervorräte im Inventar.</p>"}</div>`;
    }

    const done = (state.participants ?? []).filter((p) => suppliedFor(state, p.id) >= required).length;
    const footer = isGM
      ? `<footer class="cr-footer">
          <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Anfrage abbrechen</button>
          <button type="button" class="cr-primary" data-action="finish"><i class="fa-solid fa-moon"></i> Lange Rast durchführen</button>
        </footer>`
      : `<footer class="cr-footer"><p class="cr-hint">Der Spielleiter startet die Rast, sobald alle bereit sind. Shift beim Ablegen = Anzahl wählen.</p></footer>`;

    return `<div class="cr-summary"><i class="fa-solid fa-fire"></i> ${done} von ${(state.participants ?? []).length} versorgt
      · benötigt pro Person: ${required}</div>
      ${mine}
      <div class="cr-members">${members}</div>
      ${footer}`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender() {
    const el = this.element;
    el.querySelectorAll(".cr-supply[draggable='true']").forEach((s) => {
      s.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: s.dataset.uuid }));
      });
    });
    el.querySelectorAll(".cr-member").forEach((card) => {
      card.addEventListener("dragover", (ev) => { ev.preventDefault(); card.classList.add("drag-over"); });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", (ev) => this.#onDrop(ev, card));
    });
  }

  async #onDrop(event, card) {
    event.preventDefault();
    card.classList.remove("drag-over");
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Bitte einen Gegenstand hineinziehen.");

    let qty = 1;
    if (event.shiftKey) {
      qty = await DialogV2.prompt({
        window: { title: "Wie viele?" },
        content: `<input type="number" name="qty" value="1" min="1" step="1" autofocus>`,
        ok: { label: "Ablegen", callback: (e, button) => Number(button.form.elements.qty.value) },
        rejectClose: false
      });
      if (!qty || qty < 1) return;
    }
    request("pledge", { itemUuid: data.uuid, toActorId: card.dataset.actorId, qty });
  }

  static onUnpledge(event, target) {
    request("unpledge", { pledgeId: target.dataset.pledgeId });
  }

  static onTogglePenalty(event, target) {
    request("togglePenalty", { actorId: target.dataset.actorId });
  }
}

/* -------------------------------------------- */
/*  Einstellungs-Menüs                          */
/* -------------------------------------------- */

class SupplyConfigApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "camp-rest-supplies",
    tag: "form",
    classes: ["camp-rest", "camp-rest-config"],
    window: { title: "Rest Manager: Rationen & Lagervorräte", icon: "fa-solid fa-drumstick-bite", resizable: true },
    position: { width: 520, height: "auto" },
    form: { handler: SupplyConfigApp.onSubmit, closeOnSubmit: true },
    actions: { addRow: SupplyConfigApp.onAddRow, removeRow: SupplyConfigApp.onRemoveRow, reset: SupplyConfigApp.onReset }
  };

  cfg = getSupplies();

  async _renderHTML() {
    const c = this.cfg;
    const rows = c.entries.map((e, i) => `<tr>
      <td><input type="text" name="name.${i}" value="${esc(e.name)}" placeholder="Name des Gegenstands"></td>
      <td><input type="number" name="value.${i}" value="${Number(e.value) || 0}" min="0" step="0.5"></td>
      <td><button type="button" class="cr-icon" data-action="removeRow" data-index="${i}"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join("");
    return `
      <p class="cr-hint">Diese Gegenstände zählen als Ration/Lagervorrat. „Wert“ = wie viele Vorrats-Punkte ein Stück liefert.
        Gegenstände kannst du auch aus der Seitenleiste oder einem Kompendium hierher ziehen.</p>
      <div class="form-group"><label>Benötigte Punkte pro Charakter</label>
        <input type="number" name="required" value="${Number(c.required) || 0}" min="0" step="0.5"></div>
      <div class="form-group"><label>Teilübereinstimmung erlauben</label>
        <input type="checkbox" name="partial" ${c.partial ? "checked" : ""}>
        <p class="hint">„Rations (1 day)“ zählt dann auch für den Eintrag „Rations“.</p></div>
      <div class="form-group"><label>Leere Gegenstände löschen</label>
        <input type="checkbox" name="deleteEmpty" ${c.deleteEmpty ? "checked" : ""}>
        <p class="hint">Sonst bleibt der Gegenstand mit Menge 0 im Inventar.</p></div>
      <table class="cr-table"><thead><tr><th>Gegenstand</th><th>Wert</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="cr-drop cr-config-drop"><i class="fa-solid fa-plus"></i> Gegenstand hierher ziehen</div>
      <footer class="cr-footer">
        <button type="button" data-action="reset"><i class="fa-solid fa-rotate-left"></i> Standard</button>
        <button type="button" data-action="addRow"><i class="fa-solid fa-plus"></i> Zeile</button>
        <button type="submit" class="cr-primary"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
      </footer>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  _onRender() {
    const drop = this.element.querySelector(".cr-config-drop");
    drop?.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("drag-over"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop?.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
      if (data?.type !== "Item" || !data.uuid) return;
      const item = await getDoc(data.uuid);
      if (!item) return;
      this.#readForm();
      this.cfg.entries.push({ name: item.name, value: 1 });
      this.render();
    });
  }

  /** Aktuelle Eingaben übernehmen, damit beim Neuzeichnen nichts verloren geht. */
  #readForm() {
    const f = this.element;
    const n = this.cfg.entries.length;
    const entries = [];
    for (let i = 0; i < n; i++) {
      const name = f.querySelector(`[name="name.${i}"]`)?.value ?? "";
      const value = Number(f.querySelector(`[name="value.${i}"]`)?.value) || 0;
      entries.push({ name, value });
    }
    this.cfg = {
      required: Number(f.querySelector('[name="required"]')?.value) || 0,
      partial: !!f.querySelector('[name="partial"]')?.checked,
      deleteEmpty: !!f.querySelector('[name="deleteEmpty"]')?.checked,
      entries
    };
  }

  static onAddRow() { this.#readForm(); this.cfg.entries.push({ name: "", value: 1 }); this.render(); }

  static onRemoveRow(event, target) {
    this.#readForm();
    this.cfg.entries.splice(Number(target.dataset.index), 1);
    this.render();
  }

  static onReset() { this.cfg = foundry.utils.deepClone(DEFAULT_SUPPLIES); this.render(); }

  static async onSubmit() {
    this.#readForm();
    this.cfg.entries = this.cfg.entries.filter((e) => e.name.trim());
    await game.settings.set(MOD, "supplyConfig", this.cfg);
    ui.notifications.info("Rest Manager: Vorräte gespeichert.");
  }
}

class PenaltyConfigApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "camp-rest-penalty",
    tag: "form",
    classes: ["camp-rest", "camp-rest-config"],
    window: { title: "Rest Manager: Strafe bei fehlenden Vorräten", icon: "fa-solid fa-gavel", resizable: true },
    position: { width: 520, height: "auto" },
    form: { handler: PenaltyConfigApp.onSubmit, closeOnSubmit: true }
  };

  async _renderHTML() {
    const p = getPenalty();
    const box = (name, label, hint) => `<div class="form-group"><label>${label}</label>
      <input type="checkbox" name="${name}" ${p[name] ? "checked" : ""}>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
    return `
      <p class="cr-hint">Diese Strafe bekommt jeder Charakter, der zu wenig Vorräte im Lager hat.
        Im Lagerfenster kannst du sie für einzelne Charaktere trotzdem erlassen.</p>
      ${box("denyRest", "Keine lange Rast", "Der Charakter erhält überhaupt keine Erholung. Die anderen Optionen außer Erschöpfung entfallen dann.")}
      ${box("noHP", "Keine Trefferpunkte zurück")}
      ${box("noHD", "Keine Trefferwürfel zurück")}
      ${box("noSlots", "Keine Zauberplätze zurück", "Gilt auch für Paktmagie-Plätze.")}
      <div class="form-group"><label>Zusätzliche Erschöpfungsstufen</label>
        <input type="number" name="exhaustion" value="${Number(p.exhaustion) || 0}" min="0" max="6" step="1">
        <p class="hint">Wird nach der Rast addiert (die normale Rast senkt Erschöpfung vorher um 1).</p></div>
      <div class="form-group stacked"><label>Chatnachricht</label>
        <textarea name="message" rows="3">${esc(p.message)}</textarea>
        <p class="hint">{name} wird durch den Namen des Charakters ersetzt. Leer lassen = keine Nachricht.</p></div>
      <footer class="cr-footer">
        <button type="submit" class="cr-primary"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
      </footer>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  static async onSubmit(event, form) {
    const get = (n) => form.querySelector(`[name="${n}"]`);
    await game.settings.set(MOD, "penaltyConfig", {
      denyRest: get("denyRest").checked,
      noHP: get("noHP").checked,
      noHD: get("noHD").checked,
      noSlots: get("noSlots").checked,
      exhaustion: Math.max(0, Math.floor(Number(get("exhaustion").value) || 0)),
      message: get("message").value
    });
    ui.notifications.info("Rest Manager: Strafe gespeichert.");
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

function onStateChange(state) {
  if (!game.ready) return;
  if (state?.active) {
    if (state.id !== CampRestApp.lastRequestId) {
      CampRestApp.lastRequestId = state.id;
      CampRestApp.show();
    } else CampRestApp.refresh();
  } else CampRestApp.hide();
}

Hooks.once("init", () => {
  game.settings.register(MOD, "supplyConfig", {
    scope: "world", config: false, type: Object, default: DEFAULT_SUPPLIES,
    onChange: () => CampRestApp.refresh()
  });
  game.settings.register(MOD, "penaltyConfig", {
    scope: "world", config: false, type: Object, default: DEFAULT_PENALTY
  });
  game.settings.register(MOD, "state", {
    scope: "world", config: false, type: Object, default: { active: false },
    onChange: onStateChange
  });

  game.settings.registerMenu(MOD, "supplyMenu", {
    name: "Rationen & Lagervorräte",
    label: "Vorräte festlegen",
    hint: "Was zählt als Ration oder Lagervorrat, und wie viel braucht jeder Charakter für eine lange Rast?",
    icon: "fa-solid fa-drumstick-bite",
    type: SupplyConfigApp,
    restricted: true
  });
  game.settings.registerMenu(MOD, "penaltyMenu", {
    name: "Strafe bei fehlenden Vorräten",
    label: "Strafe festlegen",
    hint: "Was passiert mit Charakteren, die nicht genug Vorräte im Lager haben?",
    icon: "fa-solid fa-gavel",
    type: PenaltyConfigApp,
    restricted: true
  });
});

/** Einstellungen aus der alten Modulversion ("rest-manager-by-ascandir") übernehmen. */
async function migrateOldSettings() {
  if (!game.user.isActiveGM) return;
  const OLD = "rest-manager-by-ascandir";
  const stored = game.settings.storage.get("world");
  const isStored = (key) => !!stored?.find((s) => s.key === key);
  let moved = 0;
  for (const name of ["supplyConfig", "penaltyConfig"]) {
    if (isStored(`${MOD}.${name}`)) continue;            // schon eigene Werte vorhanden
    const old = stored?.find((s) => s.key === `${OLD}.${name}`);
    if (!old) continue;
    let value = old.value;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (!value || typeof value !== "object") continue;
    await game.settings.set(MOD, name, value);
    moved++;
  }
  if (moved) ui.notifications.info("Ascandir - Rest Manager: Einstellungen aus der alten Version übernommen.");
}

Hooks.once("ready", () => {
  migrateOldSettings().catch((err) => console.warn(`${MOD} | Übernahme alter Einstellungen fehlgeschlagen`, err));

  game.socket.on(SOCKET, (payload) => {
    if (payload?.action === "notify") {
      if (payload.target === game.user.id) ui.notifications.warn(payload.msg);
      return;
    }
    if (game.user.isActiveGM) enqueue(() => handleRequest(payload));
  });

  game.modules.get(MOD).api = { startRequest, open: () => CampRestApp.show(), finishRest, cancelRequest };

  const state = getState();
  if (state.active) {
    CampRestApp.lastRequestId = state.id;
    CampRestApp.show();
  }
});

// Knopf in der Akteure-Seitenleiste
Hooks.on("renderActorDirectory", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if (!target || target.querySelector(".camp-rest-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "camp-rest-btn";
  btn.innerHTML = game.user.isGM
    ? '<i class="fa-solid fa-campground"></i> Lange Rast anfragen'
    : '<i class="fa-solid fa-campground"></i> Lager öffnen';
  btn.addEventListener("click", () => {
    if (game.user.isGM) return startRequest();
    if (getState().active) return CampRestApp.show();
    ui.notifications.info("Gerade ist keine lange Rast angefragt.");
  });
  target.append(btn);
});

// Ändert sich ein Inventar, die "Deine Vorräte"-Anzeige aktualisieren
for (const hook of ["updateItem", "createItem", "deleteItem"]) {
  Hooks.on(hook, (item) => { if (item.parent?.isOwner) CampRestApp.refresh(); });
}
