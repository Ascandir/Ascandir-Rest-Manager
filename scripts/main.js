/**
 * Ascandir - Rest Manager
 * Gemeinsame lange Rast mit Rationen / Lagervorräten für D&D 5e.
 * Foundry VTT v14 · dnd5e 6.x
 */

const MOD = "ascandir-rest-manager";
/** Wird beim Veröffentlichen automatisch durch die Versionsnummer ersetzt. */
const CODE_VERSION = "__VERSION__";
const SOCKET = `module.${MOD}`;

/* -------------------------------------------- */
/*  Dateien versioniert laden                   */
/*  (sonst liefern Browser oder Proxys nach     */
/*  einem Update noch alte Fassungen aus)       */
/* -------------------------------------------- */

const ASSET_VERSION = CODE_VERSION.startsWith("__") ? String(Date.now()) : CODE_VERSION;

(function loadStylesheet() {
  if (document.querySelector("link[data-camp-rest]")) return;
  // Adresse relativ zu dieser Datei bilden (funktioniert auch hinter Proxys / Pfad-Präfixen)
  const href = new URL(`../styles/camp.css?v=${ASSET_VERSION}`, import.meta.url).href;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.campRest = ASSET_VERSION;
  link.addEventListener("error", () => {
    console.error(`${MOD} | Stylesheet konnte nicht geladen werden: ${href}`);
    Hooks.once("ready", () => ui.notifications.error(`Ascandir - Rest Manager: Design-Datei nicht gefunden (${href}).`, { permanent: true }));
  });
  document.head.append(link);
})();

let viewModule = null;
const loadView = () => (viewModule ??= import(`./view.js?v=${ASSET_VERSION}`));
loadView();
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
  malnutrition: false,  // Zustand "Unterernährt" setzen (dnd5e)
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

/** Gemaltes Symbol für Rationen/Lagervorräte, sonst das Bild des Gegenstands. */
function chipImage(item) {
  const n = norm(item.name);
  if (/ration|proviant|essen|food/.test(n)) return `modules/${MOD}/assets/icon-bread.png?v=${CODE_VERSION}`;
  if (/camp|lager|vorrat|supplies/.test(n)) return `modules/${MOD}/assets/icon-crate.png?v=${CODE_VERSION}`;
  return item.img;
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
        itemUuid: item.uuid, itemName: item.name, img: chipImage(item),
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
  const companions = game.actors.filter((a) => a.type === "npc" && a.hasPlayerOwner);
  if (!chars.length && !companions.length) return ui.notifications.warn("Keine Spielercharaktere gefunden.");

  const row = (a, checked) => `
      <label><input type="checkbox" name="p" value="${a.id}" ${checked ? "checked" : ""}>
      <img src="${esc(a.img)}" width="28" height="28"> ${esc(a.name)}</label>`;
  const content = `<p>Wer nimmt an der langen Rast teil?</p>
    <div class="camp-rest-pick">
      ${chars.length ? `<h4>Charaktere</h4>${chars.map((a) => row(a, true)).join("")}` : ""}
      ${companions.length ? `<h4>Begleiter &amp; Reittiere</h4>${companions.map((a) => row(a, false)).join("")}` : ""}
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

/** Strafen, die beim nächsten Abschluss einer langen Rast angewendet werden (Akteur-ID -> Strafe). */
const pendingPenalty = new Map();

/**
 * dnd5e berechnet zuerst alle Erholungen und ruft dann "dnd5e.preRestCompleted" auf,
 * bevor irgendetwas gespeichert wird. Hier streichen wir die Erholungen, die die Strafe verbietet.
 */
function applyPenaltyToRest(actor, result) {
  const pen = pendingPenalty.get(actor.id);
  if (!pen || result?.type !== "long") return;
  const { flattenObject } = foundry.utils;

  const data = flattenObject(result.updateData ?? {});
  const drop = (re) => { for (const k of Object.keys(data)) if (re.test(k)) delete data[k]; };

  if (pen.noHP) {
    drop(/^system\.attributes\.hp\.value$/);
    if (result.deltas) result.deltas.hitPoints = 0;
  }
  if (pen.noHD) {
    drop(/^system\.attributes\.hd\.spent$/);           // Begleiter / NSC
    result.updateItems = (result.updateItems ?? []).map((u) => {
      const f = flattenObject(u);
      delete f["system.hd.spent"];                     // Klassen von Spielercharakteren
      return f;
    }).filter((u) => Object.keys(u).some((k) => k !== "_id"));
    if (result.deltas) result.deltas.hitDice = 0;
  }
  if (pen.noSlots) drop(/^system\.spells\.[^.]+\.value$/);

  const levels = Math.max(0, Math.floor(Number(pen.exhaustion) || 0));
  if (levels) {
    const base = data["system.attributes.exhaustion"] ?? (Number(actor.system.attributes?.exhaustion) || 0);
    data["system.attributes.exhaustion"] = Math.min(maxExhaustion(), Number(base) + levels);
  }
  result.updateData = data;
}

function penaltyEffects(pen) {
  const fx = [];
  const levels = Math.max(0, Math.floor(Number(pen.exhaustion) || 0));
  if (pen.denyRest) fx.push("erhält <strong>keine</strong> lange Rast");
  else {
    if (pen.noHP) fx.push("keine Trefferpunkte zurück");
    if (pen.noHD) fx.push("keine Trefferwürfel zurück");
    if (pen.noSlots) fx.push("keine Zauberplätze zurück");
  }
  if (levels) fx.push(`+${levels} Erschöpfung`);
  if (pen.malnutrition) fx.push("Zustand: Unterernährt");
  return fx;
}

/** Lange Rast mit Strafe. */
async function restWithPenalty(actor, pen) {
  if (pen.denyRest) {
    const levels = Math.max(0, Math.floor(Number(pen.exhaustion) || 0));
    if (levels) {
      const cur = Number(actor.system.attributes?.exhaustion) || 0;
      await actor.update({ "system.attributes.exhaustion": Math.min(maxExhaustion(), cur + levels) });
    }
  } else {
    pendingPenalty.set(actor.id, pen);
    try {
      await actor.longRest({ dialog: false, chat: true });
    } finally {
      pendingPenalty.delete(actor.id);
    }
  }
  // Unterernährung (dnd5e): verhindert, dass die nächste Rast Erschöpfung abbaut
  const statuses = CONFIG.statusEffects;
  const hasMalnutrition = Array.isArray(statuses) ? statuses.some((e) => e.id === "malnutrition") : !!statuses?.malnutrition;
  if (pen.malnutrition && hasMalnutrition) {
    await actor.toggleStatusEffect("malnutrition", { active: true });
  }
  return postPenalty(actor, pen, penaltyEffects(pen));
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
    classes: ["camp-rest", "camp-rest-window"],
    window: { title: "Lager für die lange Rast", icon: "fa-solid fa-campground", resizable: true },
    position: { width: 1100, height: "auto" },
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
      const actor = game.actors.get(p.id);
      const have = suppliedFor(state, p.id);
      return {
        id: p.id,
        name: actor?.name ?? p.name,
        img: actor?.img ?? p.img,
        have,
        ok: have >= required,
        waived: !!state.noPenalty?.[p.id],
        pledges: state.pledges.filter((x) => x.toActorId === p.id).map((x) => ({
          ...x, canRemove: isGM || !!game.actors.get(x.fromActorId)?.isOwner
        }))
      };
    });

    // Eigene Vorräte (alle eigenen Akteure, auch Begleiter oder ein Gruppenlager)
    const supplies = isGM ? [] : game.actors.filter((a) => a.isOwner)
      .flatMap((a) => a.items.contents.filter((i) => supplyValue(i) > 0).map((i) => ({
        uuid: i.uuid, img: chipImage(i), name: i.name, owner: a.name,
        left: (Number(i.system.quantity) || 0) - pledgedOf(state, i.uuid)
      })));

    const view = await loadView();
    this.viewMod = view;
    return view.campView({ isGM, required, members, supplies });
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender() {
    const el = this.element;
    if (!el.querySelector(":scope > .cr-deco") && this.viewMod) el.insertAdjacentHTML("beforeend", this.viewMod.DECO_HTML);

    el.querySelectorAll(".cr-supply[draggable='true']").forEach((s) => {
      s.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: s.dataset.uuid }));
      });
    });
    el.querySelectorAll(".cr-card").forEach((card) => {
      card.addEventListener("dragover", (ev) => { ev.preventDefault(); card.classList.add("drag-over"); });
      card.addEventListener("dragleave", (ev) => {
        if (!card.contains(ev.relatedTarget)) card.classList.remove("drag-over");
      });
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
    classes: ["camp-rest-config"],
    window: {
      title: "Rest Manager: Rationen & Lagervorräte",
      icon: "fa-solid fa-drumstick-bite",
      resizable: true,
      contentClasses: ["standard-form"]
    },
    position: { width: 520, height: "auto" },
    form: { handler: SupplyConfigApp.onSubmit, closeOnSubmit: true },
    actions: { addRow: SupplyConfigApp.onAddRow, removeRow: SupplyConfigApp.onRemoveRow, reset: SupplyConfigApp.onReset }
  };

  cfg = getSupplies();

  async _renderHTML() {
    const c = this.cfg;
    const rows = c.entries.map((e, i) => `
      <div class="form-group cr-entry">
        <div class="form-fields">
          <input type="text" name="name.${i}" value="${esc(e.name)}" placeholder="Name oder Identifier" aria-label="Gegenstand">
          <input type="number" name="value.${i}" value="${Number(e.value) || 0}" min="0" step="0.5" aria-label="Wert">
          <button type="button" class="icon fa-solid fa-trash" data-action="removeRow" data-index="${i}"
            data-tooltip="Entfernen" aria-label="Entfernen"></button>
        </div>
      </div>`).join("");
    return `
      <p class="hint">Diese Gegenstände zählen bei der langen Rast als Ration oder Lagervorrat.</p>
      <fieldset>
        <legend>Allgemein</legend>
        <div class="form-group">
          <label for="cr-required">Benötigte Punkte pro Charakter</label>
          <div class="form-fields"><input type="number" id="cr-required" name="required" value="${Number(c.required) || 0}" min="0" step="0.5"></div>
          <p class="hint">So viele Vorrats-Punkte braucht jeder Teilnehmer für eine lange Rast.</p>
        </div>
        <div class="form-group">
          <label for="cr-partial">Teilübereinstimmung erlauben</label>
          <div class="form-fields"><input type="checkbox" id="cr-partial" name="partial" ${c.partial ? "checked" : ""}></div>
          <p class="hint">„Rations (1 day)“ zählt dann auch für den Eintrag „Rations“.</p>
        </div>
        <div class="form-group">
          <label for="cr-delete">Leere Gegenstände löschen</label>
          <div class="form-fields"><input type="checkbox" id="cr-delete" name="deleteEmpty" ${c.deleteEmpty ? "checked" : ""}></div>
          <p class="hint">Sonst bleibt der Gegenstand mit Menge 0 im Inventar.</p>
        </div>
      </fieldset>
      <fieldset class="cr-entries">
        <legend>Gegenstände</legend>
        <div class="cr-entry-head"><span>Name oder Identifier</span><span>Wert</span><span></span></div>
        ${rows || '<p class="hint">Noch keine Gegenstände eingetragen.</p>'}
        <div class="cr-config-drop"><i class="fa-solid fa-file-import"></i> Gegenstand aus Seitenleiste oder Kompendium hierher ziehen</div>
        <button type="button" data-action="addRow"><i class="fa-solid fa-plus"></i> Zeile hinzufügen</button>
        <p class="hint">„Wert“ = wie viele Vorrats-Punkte ein Stück liefert.</p>
      </fieldset>
      <footer class="form-footer">
        <button type="button" data-action="reset"><i class="fa-solid fa-rotate-left"></i><span>Standard wiederherstellen</span></button>
        <button type="submit"><i class="fa-solid fa-floppy-disk"></i><span>Speichern</span></button>
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
    classes: ["camp-rest-config"],
    window: {
      title: "Rest Manager: Strafe bei fehlenden Vorräten",
      icon: "fa-solid fa-gavel",
      resizable: true,
      contentClasses: ["standard-form"]
    },
    position: { width: 520, height: "auto" },
    form: { handler: PenaltyConfigApp.onSubmit, closeOnSubmit: true }
  };

  async _renderHTML() {
    const p = getPenalty();
    const box = (name, label, hint) => `
      <div class="form-group">
        <label for="cr-${name}">${label}</label>
        <div class="form-fields"><input type="checkbox" id="cr-${name}" name="${name}" ${p[name] ? "checked" : ""}></div>
        ${hint ? `<p class="hint">${hint}</p>` : ""}
      </div>`;
    return `
      <p class="hint">Diese Strafe bekommt jeder Charakter, der zu wenig Vorräte im Lager hat.
        Im Lagerfenster kannst du sie für einzelne Charaktere erlassen.</p>
      <fieldset>
        <legend>Erholung</legend>
        ${box("denyRest", "Keine lange Rast", "Der Charakter erholt sich überhaupt nicht. Die drei Optionen darunter entfallen dann.")}
        ${box("noHP", "Keine Trefferpunkte zurück")}
        ${box("noHD", "Keine Trefferwürfel zurück")}
        ${box("noSlots", "Keine Zauberplätze zurück", "Gilt auch für Paktmagie-Plätze.")}
      </fieldset>
      <fieldset>
        <legend>Zusätzliche Folgen</legend>
        <div class="form-group">
          <label for="cr-exhaustion">Zusätzliche Erschöpfungsstufen</label>
          <div class="form-fields"><input type="number" id="cr-exhaustion" name="exhaustion" value="${Number(p.exhaustion) || 0}" min="0" max="6" step="1"></div>
          <p class="hint">Wird nach der Rast addiert. Die normale Rast senkt Erschöpfung vorher um 1.</p>
        </div>
        ${box("malnutrition", "Zustand „Unterernährt“ setzen", "Zustand aus dnd5e: Solange er besteht, baut eine lange Rast keine Erschöpfung ab. Entfernen musst du ihn selbst.")}
      </fieldset>
      <fieldset>
        <legend>Chatnachricht</legend>
        <div class="form-group stacked">
          <textarea name="message" rows="3" aria-label="Chatnachricht">${esc(p.message)}</textarea>
          <p class="hint">{name} wird durch den Namen des Charakters ersetzt. Leer lassen = keine Nachricht.</p>
        </div>
      </fieldset>
      <footer class="form-footer">
        <button type="submit"><i class="fa-solid fa-floppy-disk"></i><span>Speichern</span></button>
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
      malnutrition: get("malnutrition").checked,
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

/** Warnen, wenn ein Client noch alte Moduldateien aus dem Zwischenspeicher lädt. */
function checkStaleCache() {
  const installed = game.modules.get(MOD)?.version;
  if (!installed || CODE_VERSION.startsWith("__") || installed === CODE_VERSION) return;
  ui.notifications.warn(`Ascandir - Rest Manager: Dieser Client nutzt noch alte Dateien (${CODE_VERSION} statt ${installed}). `
    + "Bitte mit Strg+Shift+R bzw. Strg+F5 neu laden.", { permanent: true });
}

Hooks.once("ready", () => {
  checkStaleCache();
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

Hooks.on("dnd5e.preRestCompleted", (actor, result) => {
  try { applyPenaltyToRest(actor, result); }
  catch (err) { console.error(`${MOD} | Strafe konnte nicht angewendet werden`, err); }
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
