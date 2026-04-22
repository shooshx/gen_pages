// -------- Field schema --------
// kind: text | long_text | date | place | ref | refs | bool
// optional: true  -> collapsed by default, has a checkbox to expand
// showIf: "key"   -> only shown when that bool field is true
const SCHEMA = [
  { key: "first_name",          label: "שם פרטי",                       kind: "text" },
  { key: "last_name",           label: "שם משפחה",                      kind: "text" },
  { key: "maiden_name",         label: "שם נעורים",                     kind: "text", optional: true },
  { key: "additional_last_name",label: "שם משפחה נוסף",                 kind: "text", optional: true },
  { key: "former_last_name",    label: "שם משפחה קודם",                 kind: "text", optional: true },
  { key: "hebrew_name",         label: "שם עברי",                       kind: "text", optional: true },
  { key: "nickname",            label: "כינוי",                         kind: "text", optional: true },
  { key: "other_names",         label: "שמות נוספים או איות אלטרנטיבי", kind: "text", optional: true },
  { key: "father",              label: "אב",                            kind: "ref"  },
  { key: "mother",              label: "אם",                            kind: "ref"  },
  { key: "siblings",            label: "אחים ואחיות",                   kind: "refs" },
  { key: "spouses",             label: "בני/בנות זוג",                  kind: "refs" },
  { key: "birth_date",          label: "תאריך לידה",                    kind: "date" },
  { key: "birth_place",         label: "מקום לידה",                     kind: "place" },
  { key: "deceased",            label: "נפטר",                          kind: "bool" },
  { key: "death_date",          label: "תאריך פטירה",                   kind: "date",  showIf: "deceased" },
  { key: "death_place",         label: "מקום פטירה",                    kind: "place", showIf: "deceased" },
  { key: "burial_place",        label: "מקום קבורה",                    kind: "place", showIf: "deceased" },
  { key: "children",            label: "ילדים",                         kind: "refs" },
  { key: "addresses",           label: "כתובות",                        kind: "long_text" },
  { key: "free_text",           label: "טקסט חופשי",                    kind: "richtext" },
];

// Per-field expanded state for `optional` fields. Set of keys.
const expanded = new Set();

// -------- API --------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({error: r.statusText}));
    throw new Error(err.error || "שגיאה");
  }
  return r.json();
}
const listPeople   = () => api("/api/people");
const getPerson    = (id) => api("/api/people/" + encodeURIComponent(id));
const getSettings  = () => api("/api/settings");
const putSettings  = (data) =>
  api("/api/settings", {method:"POST", headers:{"Content-Type":"application/json"},
                        body: JSON.stringify(data)});
const createPerson = (technical_id, data) =>
  api("/api/people", {method:"POST", headers:{"Content-Type":"application/json"},
                      body: JSON.stringify({technical_id, data})});
const savePerson   = (technical_id, data) =>
  api("/api/people/" + encodeURIComponent(technical_id) + "/save",
      {method:"POST", headers:{"Content-Type":"application/json"},
       body: JSON.stringify({data})});

// -------- State --------
let state = {
  people: [],           // list of {technical_id, display_he, display_en, ...}
  currentPerson: null,  // full person object
  viewingVersion: null, // version number being viewed
  draft: null,          // current editable data snapshot
  // draft.files = [{file?, data_url?, name?, mime?, comment}]
  cleanSnapshot: null,  // JSON string of draft right after load (for dirty detection)
  allData: [],          // full person objects for client-side search
  settings: { site_name: "מאגר אנשים" }, // loaded from /api/settings at startup
};

// -------- Settings --------
async function loadSettings() {
  try {
    const s = await getSettings();
    state.settings = Object.assign({}, state.settings, s);
  } catch (e) {
    console.warn("Failed to load settings:", e);
  }
  applySettings();
}

function applySettings() {
  const title = document.getElementById("site-title");
  if (title) title.textContent = state.settings.site_name || "מאגר אנשים";
  if (state.settings.site_name) document.title = state.settings.site_name;
}

function showSettingsDialog() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3 class="modal-h-neutral">הגדרות</h3>
      <div class="settings-row">
        <label for="settings-site-name">שם האתר (מופיע בכותרת):</label>
        <input type="text" id="settings-site-name" value="${escapeAttr(state.settings.site_name || "")}">
      </div>
      <div class="modal-actions">
        <button class="primary" id="settings-save">שמור</button>
        <button id="settings-cancel">ביטול</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#settings-site-name");
  setTimeout(() => { input.focus(); input.select(); }, 0);

  overlay.querySelector("#settings-cancel").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector("#settings-save").onclick = async () => {
    const newName = input.value.trim() || "מאגר אנשים";
    try {
      const saved = await putSettings({ site_name: newName });
      state.settings = Object.assign({}, state.settings, saved);
      applySettings();
      overlay.remove();
      flashMessage("ההגדרות נשמרו.");
    } catch (e) {
      alert("שגיאה בשמירת ההגדרות: " + e.message);
    }
  };
  // Allow Enter to save, Esc to cancel.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") overlay.querySelector("#settings-save").click();
    else if (e.key === "Escape") overlay.remove();
  });
}

// -------- Search helpers --------

/** Load every person's full JSON from the server (for client-side search). */
async function loadAllData() {
  state.allData = await api("/api/people/all");
}

/** Given a person object, return the display name from the latest version. */
function personDisplayName(person) {
  const versions = person.versions || [];
  if (!versions.length) return { he: "", en: "", tid: person.technical_id };
  const data = versions[versions.length - 1].data || {};
  let he = "", en = "";
  for (const key of ["first_name", "last_name"]) {
    const fld = data[key] || {};
    if (fld.he) he = (he + " " + fld.he).trim();
    if (fld.en) en = (en + " " + fld.en).trim();
  }
  return { he, en, tid: person.technical_id };
}

/**
 * Extract every searchable text string from a person's latest version data.
 * Each entry carries a label (field name) and the text value for excerpt display.
 */
function extractTexts(person) {
  const versions = person.versions || [];
  if (!versions.length) return [];
  const data = versions[versions.length - 1].data || {};
  const entries = []; // [{label, text}]

  // Also search the technical id itself
  entries.push({ label: "מזהה", text: person.technical_id });

  for (const f of SCHEMA) {
    const val = data[f.key];
    if (!val) continue;
    switch (f.kind) {
      case "text":
      case "place":
      case "long_text":
        if (val.he) entries.push({ label: f.label + " (עב)", text: val.he });
        if (val.en) entries.push({ label: f.label + " (EN)", text: val.en });
        if (val.comment) entries.push({ label: f.label + " (הערות)", text: val.comment });
        break;
      case "date":
        if (val.value) entries.push({ label: f.label, text: val.value });
        if (val.comment) entries.push({ label: f.label + " (הערות)", text: val.comment });
        break;
      case "ref":
        if (val.he) entries.push({ label: f.label + " (עב)", text: val.he });
        if (val.en) entries.push({ label: f.label + " (EN)", text: val.en });
        if (val.link_id) entries.push({ label: f.label + " (קישור)", text: val.link_id });
        if (val.comment) entries.push({ label: f.label + " (הערות)", text: val.comment });
        break;
      case "refs":
        if (!Array.isArray(val)) break;
        val.forEach((item, i) => {
          const n = i + 1;
          if (item.he) entries.push({ label: f.label + " " + n + " (עב)", text: item.he });
          if (item.en) entries.push({ label: f.label + " " + n + " (EN)", text: item.en });
          if (item.link_id) entries.push({ label: f.label + " " + n + " (קישור)", text: item.link_id });
          if (item.comment) entries.push({ label: f.label + " " + n + " (הערות)", text: item.comment });
        });
        break;
      case "richtext":
        // strip HTML tags for search indexing; handle both new (string) and legacy ({he,en}) formats
        if (typeof val === "string") {
          const plain = val.replace(/<[^>]*>/g, " ").trim();
          if (plain) entries.push({ label: f.label, text: plain });
        } else {
          if (val.he) entries.push({ label: f.label + " (עב)", text: val.he });
          if (val.en) entries.push({ label: f.label + " (EN)", text: val.en });
        }
        break;
    }
  }
  return entries;
}

/**
 * Search allData for a query string. Returns array of
 * { person, matches: [{ label, text, excerpt }] }.
 */
function searchAll(query) {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const results = [];
  for (const person of state.allData) {
    const texts = extractTexts(person);
    const matches = [];
    for (const { label, text } of texts) {
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // build excerpt: up to 40 chars before and after the match
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + 40);
      let excerpt = (start > 0 ? "…" : "") +
                    text.slice(start, idx) +
                    "\x00MARK_START\x00" + text.slice(idx, idx + q.length) + "\x00MARK_END\x00" +
                    text.slice(idx + q.length, end) +
                    (end < text.length ? "…" : "");
      matches.push({ label, text, excerpt });
    }
    if (matches.length > 0) {
      results.push({ person, matches });
    }
  }
  return results;
}

/** Render the live search results below the search box. */
function renderSearchResults(query) {
  const container = document.getElementById("search-results");
  if (!container) return;
  if (!query || !query.trim()) {
    container.innerHTML = "";
    container.style.display = "none";
    // show the normal people list again
    const pl = document.getElementById("people-list-section");
    if (pl) pl.style.display = "";
    return;
  }
  const results = searchAll(query);
  // hide the normal list while search is active
  const pl = document.getElementById("people-list-section");
  if (pl) pl.style.display = "none";

  if (results.length === 0) {
    container.innerHTML = `<div class="empty">לא נמצאו תוצאות</div>`;
    container.style.display = "";
    return;
  }

  let html = "";
  for (const { person, matches } of results) {
    const dn = personDisplayName(person);
    const displayName = dn.he || dn.en || dn.tid;
    html += `<div class="sr-item" onclick="showPerson('${escapeAttr(person.technical_id)}')">
      <div class="sr-name">${escapeHtml(displayName)}
        <span class="sr-tid">${escapeHtml(person.technical_id)}</span>
      </div>`;
    // show up to 3 matching excerpts
    const shown = matches.slice(0, 3);
    for (const m of shown) {
      // escape HTML first, then inject <mark> tags around the match sentinels
      let exc = escapeHtml(m.excerpt)
        .replace(/\x00MARK_START\x00/g, "<mark>")
        .replace(/\x00MARK_END\x00/g, "</mark>");
      html += `<div class="sr-excerpt">
        <span class="sr-field-label">${escapeHtml(m.label)}:</span> ${exc}
      </div>`;
    }
    if (matches.length > 3) {
      html += `<div class="sr-excerpt"><span class="sr-field-label">...ועוד ${matches.length - 3} התאמות</span></div>`;
    }
    html += `</div>`;
  }
  container.innerHTML = html;
  container.style.display = "";
}

// -------- Unsaved-changes guard --------

/**
 * Compare current draft against the clean snapshot and return a list of
 * human-readable Hebrew field labels that were changed.
 */
function getChangedFieldLabels() {
  if (!state.cleanSnapshot || !state.draft) return [];
  const clean = JSON.parse(state.cleanSnapshot);
  const changed = [];

  for (const f of SCHEMA) {
    const a = JSON.stringify(clean[f.key] ?? null);
    const b = JSON.stringify(state.draft[f.key] ?? null);
    if (a !== b) changed.push(f.label);
  }

  // files (includes images, PDFs, and any other uploaded file)
  const cleanFiles = clean.files || clean.photos || [];
  const draftFiles = state.draft.files || [];
  const pa = JSON.stringify(cleanFiles.map(p => ({file: p.file, comment: p.comment})));
  const pb = JSON.stringify(draftFiles.map(p => ({file: p.file, data_url: p.data_url ? "(new)" : undefined, comment: p.comment})));
  if (pa !== pb) changed.push("תמונות וקבצים");

  return changed;
}

/**
 * Compare two saved-version data objects and return the list of Hebrew field
 * labels whose values differ between them. Used by the version-history modal.
 */
function diffFieldLabelsBetween(oldData, newData) {
  oldData = oldData || {};
  newData = newData || {};
  const changed = [];
  for (const f of SCHEMA) {
    const a = JSON.stringify(oldData[f.key] ?? null);
    const b = JSON.stringify(newData[f.key] ?? null);
    if (a !== b) changed.push(f.label);
  }
  const oldFiles = oldData.files || oldData.photos || [];
  const newFiles = newData.files || newData.photos || [];
  const pa = JSON.stringify(oldFiles.map(p => ({file: p.file, comment: p.comment})));
  const pb = JSON.stringify(newFiles.map(p => ({file: p.file, comment: p.comment})));
  if (pa !== pb) changed.push("תמונות וקבצים");
  return changed;
}

/** Sync rich-text editor content into draft (if editor is mounted). */
function syncRichText() {
  const el = document.getElementById("rt-editor");
  if (el) state.draft.free_text = el.innerHTML;
}

/** Returns true if the draft has unsaved changes compared to the clean snapshot. */
function isDirty() {
  syncRichText();
  return getChangedFieldLabels().length > 0;
}

/**
 * If the person page has unsaved changes, show a detailed modal listing the
 * changed fields. Returns a Promise that resolves to true (proceed) or false
 * (stay). If no unsaved changes, resolves immediately to true.
 */
function guardUnsavedChanges() {
  if (!state.currentPerson || !isEditable()) return Promise.resolve(true);
  const changed = getChangedFieldLabels();
  if (changed.length === 0) return Promise.resolve(true);

  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const items = changed.map(l => `<li>${escapeHtml(l)}</li>`).join("");
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>יש שינויים שלא נשמרו!</h3>
        <p>השדות הבאים שונו מאז השמירה האחרונה:</p>
        <ul>${items}</ul>
        <p>אם תמשיך, השינויים האלה יאבדו.</p>
        <div class="modal-actions">
          <button class="primary" id="modal-stay">חזרה לעריכה</button>
          <button class="success" id="modal-save">שמור גרסה חדשה והמשך</button>
          <button class="danger" id="modal-leave">המשך בלי לשמור</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector("#modal-stay").onclick = () => {
      overlay.remove();
      resolve(false);
    };
    overlay.querySelector("#modal-save").onclick = async () => {
      overlay.remove();
      try {
        await saveDraft();
        resolve(true);
      } catch (e) {
        console.error("Save from unsaved-changes modal failed:", e);
        alert("שגיאה בשמירה: " + (e && e.message ? e.message : e));
        resolve(false);
      }
    };
    overlay.querySelector("#modal-leave").onclick = () => {
      overlay.remove();
      resolve(true);
    };
    // clicking the dark backdrop = stay
    overlay.addEventListener("click", e => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

// -------- List view --------
async function showList() {
  if (!await guardUnsavedChanges()) return;
  state.currentPerson = null;
  state.cleanSnapshot = null;
  const view = document.getElementById("view");
  view.innerHTML = "<div>טוען...</div>";
  try {
    const [people] = await Promise.all([
      listPeople(),
      state.allData.length ? Promise.resolve() : loadAllData(),
    ]);
    state.people = people;
  } catch (e) { view.innerHTML = "שגיאה: " + e.message; return; }
  renderListView();
  pushViewState({ view: "list" });
}

function renderListView() {
  const view = document.getElementById("view");
  let html = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <h2 style="flex:1; margin:0;">רשימת אנשים</h2>
      <button class="primary" onclick="showNewPersonDialog()">+ הוסף אדם חדש</button>
    </div>

    <div class="search-bar">
      <input type="text" id="search-input" placeholder="חיפוש..." oninput="renderSearchResults(this.value)">
      <button onclick="refreshSearch()">🔄 רענן נתונים</button>
    </div>
    <div id="search-results" class="search-results" style="display:none;"></div>

    <div id="people-list-section" class="people-list">
  `;
  if (state.people.length === 0) {
    html += `<div class="empty">אין אנשים במאגר. לחץ "הוסף אדם חדש" כדי להתחיל.</div>`;
  } else {
    for (const p of state.people) {
      html += `
        <div class="row" onclick="showPerson('${p.technical_id}')">
          <div style="flex:1;">
            <span class="name-he">${escapeHtml(p.display_he || "(ללא שם)")}</span>${p.display_en ? `<span class="name-en">${escapeHtml(p.display_en)}</span>` : ""}
          </div>
          <div class="row-meta">
            <span class="tid">${escapeHtml(p.technical_id)}</span>
            <span class="inline-note">${p.version_count} גרסאות</span>
          </div>
        </div>`;
    }
  }
  html += `</div>`;
  view.innerHTML = html;
}

async function refreshSearch() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = "טוען...";
  try {
    await loadAllData();
    state.people = await listPeople();
    // re-run current search if any
    const input = document.getElementById("search-input");
    if (input && input.value.trim()) {
      renderSearchResults(input.value);
    }
    flashMessage("הנתונים עודכנו.");
  } catch (e) {
    alert("שגיאה: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 רענן נתונים";
  }
}

function showNewPersonDialog() {
  const tid = prompt("הזן מזהה טכני (אותיות לטיניות, ספרות, - או _):");
  if (tid === null) return;
  const t = tid.trim();
  if (!/^[A-Za-z0-9_\-]+$/.test(t)) { alert("מזהה לא חוקי"); return; }
  if (state.people.some(p => p.technical_id === t)) {
    alert("מזהה זה כבר קיים."); return;
  }
  // Don't persist anything yet. Create an in-memory draft; first save = v1.
  state.currentPerson = { technical_id: t, versions: [], _new: true };
  state.viewingVersion = null;
  state.draft = {};
  for (const f of SCHEMA) state.draft[f.key] = defaultForKind(f.kind);
  state.draft.files = [];
  expanded.clear();
  state.cleanSnapshot = JSON.stringify(state.draft);
  renderPerson();
}

function defaultForKind(kind) {
  switch (kind) {
    case "text":      return { he: "", en: "", comment: "" };
    case "long_text": return { he: "", en: "", comment: "" };
    case "place":     return { he: "", en: "", comment: "" };
    case "date":      return { value: "", year_only: false, comment: "" };
    case "ref":       return { mode: "text", he: "", en: "", link_id: "", comment: "" };
    case "refs":      return [];
    case "bool":      return { value: false };
    case "richtext":  return "";
  }
}

// Decide whether a field has any user-entered content (used to auto-expand
// optional fields when loading a saved version).
function hasContent(kind, val) {
  if (val == null) return false;
  switch (kind) {
    case "text":
    case "long_text":
    case "place":     return !!(val.he || val.en || val.comment);
    case "date":      return !!(val.value || val.comment);
    case "ref":
      return val.mode === "link" ? !!val.link_id
                                 : !!(val.he || val.en || val.comment);
    case "refs":      return Array.isArray(val) && val.length > 0;
    case "bool":      return !!val.value;
    case "richtext":  return typeof val === "string" ? val.replace(/<[^>]*>/g,"").trim().length > 0 : !!(val && (val.he || val.en));
  }
  return false;
}

// -------- Person view --------
async function showPerson(tid) {
  if (!await guardUnsavedChanges()) return;
  const view = document.getElementById("view")
  // Try the in-memory cache first; fall back to server only if missing.
  let person = state.allData.find(p => p.technical_id === tid);
  if (!person) {
    view.innerHTML = "<div>טוען...</div>";
    try {
      person = await getPerson(tid);
      // Also add to cache so subsequent navigations are instant.
      state.allData.push(person);
    } catch (e) { view.innerHTML = "שגיאה: " + e.message; return; }
  }
  state.currentPerson = person;
  state.viewingVersion = person.versions[person.versions.length - 1].version;
  loadVersionIntoDraft(state.viewingVersion);
  renderPerson();
  pushViewState({ view: "person", tid });
}

function loadVersionIntoDraft(v) {
  const ver = state.currentPerson.versions.find(x => x.version === v);
  // deep clone
  state.draft = JSON.parse(JSON.stringify(ver.data || {}));

  // Legacy migration: brothers + sisters -> siblings
  if (!Array.isArray(state.draft.siblings)) {
    const merged = [];
    if (Array.isArray(state.draft.brothers)) merged.push(...state.draft.brothers);
    if (Array.isArray(state.draft.sisters))  merged.push(...state.draft.sisters);
    state.draft.siblings = merged;
  }
  delete state.draft.brothers;
  delete state.draft.sisters;

  // ensure every field exists
  for (const f of SCHEMA) if (state.draft[f.key] === undefined) state.draft[f.key] = defaultForKind(f.kind);

  // Legacy migration: single "photo" -> "photos" array -> "files" array
  if (!Array.isArray(state.draft.files)) {
    if (Array.isArray(state.draft.photos)) {
      state.draft.files = state.draft.photos;
    } else if (state.draft.photo && state.draft.photo.file) {
      state.draft.files = [{ file: state.draft.photo.file, comment: state.draft.photo.comment || "" }];
    } else {
      state.draft.files = [];
    }
  }
  delete state.draft.photo;
  delete state.draft.photos;

  // Legacy migration: free_text from {he, en} object to single HTML string
  if (state.draft.free_text && typeof state.draft.free_text === "object") {
    const parts = [];
    if (state.draft.free_text.he) parts.push(state.draft.free_text.he);
    if (state.draft.free_text.en) parts.push(state.draft.free_text.en);
    state.draft.free_text = parts.join("\n");
  }

  // Auto-expand optional fields that already have content.
  expanded.clear();
  for (const f of SCHEMA) {
    if (f.optional && hasContent(f.kind, state.draft[f.key])) {
      expanded.add(f.key);
    }
  }

  // Snapshot used for dirty-checking.
  state.cleanSnapshot = JSON.stringify(state.draft);
}

function renderPerson() {
  const p = state.currentPerson;
  const isNew = !!p._new;
  const versions = p.versions || [];
  const latestV = versions.length ? versions[versions.length - 1].version : null;
  const viewed = versions.find(x => x.version === state.viewingVersion);
  const isLatest = isNew || state.viewingVersion === latestV;

  // Derive display name from the data being viewed
  const draftData = state.draft || {};
  const nameHe = [(draftData.first_name||{}).he, (draftData.last_name||{}).he].filter(Boolean).join(" ");
  const nameEn = [(draftData.first_name||{}).en, (draftData.last_name||{}).en].filter(Boolean).join(" ");
  const displayTitle = nameHe || nameEn || p.technical_id;
  const displaySub = (nameHe && nameEn) ? nameEn : "";

  // Top-left save button (matches the one in the bottom bar). Hidden when
  // viewing a read-only older version. The Print button sits beside it and
  // is available for any already-saved person (not for an unsaved draft).
  let topSaveBtnHtml = "";
  if (isNew) {
    topSaveBtnHtml = `<button class="primary person-top-save" onclick="saveDraft()">💾 שמור (יצירת גרסה ראשונה)</button>`;
  } else if (isLatest) {
    topSaveBtnHtml = `<button class="primary person-top-save" onclick="saveDraft()">💾 שמור גרסה חדשה</button>`;
  }
  const topPrintBtnHtml = isNew
    ? ""
    : `<button class="person-top-print" onclick="showPersonPrint()">🖨️ הדפס</button>`;
  const topActionsHtml = `<div class="person-top-actions">${topSaveBtnHtml}${topPrintBtnHtml}</div>`;

  let topHtml = `
    ${topActionsHtml}
    <div class="person-title">
      ${escapeHtml(displayTitle)}
      ${displaySub ? `<span class="person-title-en">${escapeHtml(displaySub)}</span>` : ""}
    </div>`;

  if (isNew) {
    topHtml += `
      <div class="version-info">
        <strong>מזהה:</strong> <code>${escapeHtml(p.technical_id)}</code> &nbsp;
        <span style="color:#c0392b;">טיוטה חדשה — לא נשמרה עדיין</span>
      </div>`;
  } else {
    const versionOptions = versions.map(v =>
      `<option value="${v.version}" ${v.version === state.viewingVersion ? "selected" : ""}>גרסה ${v.version} — ${v.saved_at}</option>`
    ).join("");
    topHtml += `
      <div class="version-info">
        <strong>מזהה:</strong> <code>${escapeHtml(p.technical_id)}</code> &nbsp;
        <strong>גרסה:</strong> ${viewed.version} / ${latestV} &nbsp;
        <strong>נשמר:</strong> ${escapeHtml(viewed.saved_at)}
        ${isLatest ? "" : ` <span style="color:#c0392b;">(צפייה בגרסה ישנה — קריאה בלבד)</span>`}
      </div>
      <label>החלף גרסה:
        <select onchange="switchVersion(this.value)">${versionOptions}</select>
      </label>
      <a href="#" class="version-details-link" onclick="showVersionDetails(); return false;">פרטי גרסאות</a>`;
  }

  let bottomHtml;
  if (isNew) {
    bottomHtml = `
      <button class="primary" onclick="saveDraft()">💾 שמור (יצירת גרסה ראשונה)</button>
      <button onclick="discardNewPerson()">בטל</button>`;
  } else if (isLatest) {
    bottomHtml = `
      <button class="primary" onclick="saveDraft()">💾 שמור גרסה חדשה</button>
      <button onclick="showList()">חזרה לרשימה</button>`;
  } else {
    bottomHtml = `
      <button class="primary" onclick="restoreVersion()">שחזר את הגרסה הזו כגרסה חדשה</button>
      <button onclick="showList()">חזרה לרשימה</button>`;
  }

  document.getElementById("view").innerHTML = `
    <div class="person-top">${topHtml}</div>
    <div class="person-body">
      <div class="fields-col" id="fields-col"></div>
      <div class="photo-col" id="photo-col"></div>
    </div>
    <div class="free-text-col" id="free-text-col"></div>
    <div class="bottom-bar">${bottomHtml}</div>
  `;
  renderFields(isLatest);
  renderPhotos(isLatest);
  renderFreeText(isLatest);
}

async function discardNewPerson() {
  if (!await guardUnsavedChanges()) return;
  // guardUnsavedChanges passed — force navigate (skip the guard a second time)
  state.currentPerson = null;
  state.cleanSnapshot = null;
  const view = document.getElementById("view");
  view.innerHTML = "<div>טוען...</div>";
  try {
    const [people] = await Promise.all([
      listPeople(),
      state.allData.length ? Promise.resolve() : loadAllData(),
    ]);
    state.people = people;
  } catch (e) { view.innerHTML = "שגיאה: " + e.message; return; }
  // Re-render list (inline to avoid re-triggering guard)
  renderListView();
}

async function switchVersion(v) {
  if (!await guardUnsavedChanges()) {
    // Reset the dropdown to the current version since user chose to stay.
    const sel = document.querySelector(".person-top select");
    if (sel) sel.value = state.viewingVersion;
    return;
  }
  state.viewingVersion = parseInt(v, 10);
  loadVersionIntoDraft(state.viewingVersion);
  renderPerson();
}

function restoreVersion() {
  // keep draft as it is (already loaded from old version), but switch to latest for editing
  const latestV = state.currentPerson.versions[state.currentPerson.versions.length - 1].version;
  state.viewingVersion = latestV;
  // draft is already loaded from selected older version -> saving will create a new version with that content
  renderPerson();
  alert("הערכים מהגרסה הישנה טעונים. לחץ 'שמור גרסה חדשה' כדי ליצור גרסה חדשה עם תוכן זה.");
}

/**
 * Switch to a print-friendly read-only view of the currently loaded person.
 * Suppresses editing controls and only renders fields that contain content.
 */
function showPersonPrint() {
  if (!state.currentPerson) return;
  renderPersonPrintView();
  pushViewState({ view: "print", tid: state.currentPerson.technical_id });
}

/** Exit the print view and return to the normal (editable) person view. */
function exitPersonPrint() {
  renderPerson();
  if (state.currentPerson) {
    pushViewState({ view: "person", tid: state.currentPerson.technical_id });
  }
}

/** Format a text-kind value (text / place / long_text) for the print view. */
function printFmtText(val) {
  if (!val) return "";
  const parts = [];
  if (val.he) parts.push(`<span class="pv-he">${escapeHtml(val.he)}</span>`);
  if (val.en) parts.push(`<span class="pv-en">${escapeHtml(val.en)}</span>`);
  if (val.comment) parts.push(`<span class="pv-comment">(${escapeHtml(val.comment)})</span>`);
  return parts.join(" ");
}

/** Format a long_text value preserving line breaks. */
function printFmtLongText(val) {
  if (!val) return "";
  const parts = [];
  if (val.he) parts.push(`<div class="pv-he pv-long">${escapeHtml(val.he).replace(/\n/g,"<br>")}</div>`);
  if (val.en) parts.push(`<div class="pv-en pv-long">${escapeHtml(val.en).replace(/\n/g,"<br>")}</div>`);
  if (val.comment) parts.push(`<div class="pv-comment">(${escapeHtml(val.comment)})</div>`);
  return parts.join("");
}

/** Format a date value. */
function printFmtDate(val) {
  if (!val) return "";
  const parts = [];
  if (val.value) {
    parts.push(`<span class="pv-he">${escapeHtml(val.value)}</span>`);
    if (val.year_only) parts.push(`<span class="pv-note">(שנה בלבד)</span>`);
  }
  if (val.comment) parts.push(`<span class="pv-comment">(${escapeHtml(val.comment)})</span>`);
  return parts.join(" ");
}

/** Format a single ref entry (either link or free text). */
function printFmtRef(val) {
  if (!val) return "";
  if (val.mode === "link" && val.link_id) {
    const target = state.people.find(p => p.technical_id === val.link_id);
    const name = target ? (target.display_he || target.technical_id) : val.link_id;
    const nameEn = target ? (target.display_en || "") : "";
    let html = `<span class="pv-he">${escapeHtml(name)}</span>`;
    if (nameEn) html += ` <span class="pv-en">${escapeHtml(nameEn)}</span>`;
    if (val.comment) html += ` <span class="pv-comment">(${escapeHtml(val.comment)})</span>`;
    return html;
  }
  return printFmtText(val);
}

/** Format a refs array as a vertical list. */
function printFmtRefs(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return `<ul class="pv-refs">${arr.map(v => `<li>${printFmtRef(v)}</li>`).join("")}</ul>`;
}

/** Build a single row (label + value) for a schema field. */
function printRenderField(f, val) {
  let valueHtml = "";
  switch (f.kind) {
    case "text":
    case "place":     valueHtml = printFmtText(val); break;
    case "long_text": valueHtml = printFmtLongText(val); break;
    case "date":      valueHtml = printFmtDate(val); break;
    case "ref":       valueHtml = printFmtRef(val); break;
    case "refs":      valueHtml = printFmtRefs(val); break;
    case "bool":      valueHtml = val && val.value ? "כן" : ""; break;
    case "richtext":  valueHtml = (typeof val === "string") ? val : ""; break;
  }
  if (!valueHtml) return "";
  return `
    <div class="pv-row">
      <div class="pv-label">${escapeHtml(f.label)}</div>
      <div class="pv-value">${valueHtml}</div>
    </div>`;
}

/** Build the side-column photos block. Only image files are shown; other
 *  file types (PDFs etc.) are intentionally omitted from the print view. */
function printRenderPhotosCol(files, tid) {
  if (!files || !files.length) return "";
  const imgs = [];
  for (const p of files) {
    if (classifyFile(p) !== "image") continue;
    const src = p.data_url ? p.data_url : `/files/${encodeURIComponent(tid)}/${encodeURIComponent(p.file)}`;
    imgs.push(`
      <figure class="pv-photo">
        <img src="${escapeAttr(src)}" alt="">
        ${p.comment ? `<figcaption>${escapeHtml(p.comment)}</figcaption>` : ""}
      </figure>`);
  }
  if (!imgs.length) return "";
  return `<div class="print-photos-col">${imgs.join("")}</div>`;
}

function renderPersonPrintView() {
  const p = state.currentPerson;
  const data = state.draft || {};
  const tid = p.technical_id;

  const nameHe = [(data.first_name||{}).he, (data.last_name||{}).he].filter(Boolean).join(" ");
  const nameEn = [(data.first_name||{}).en, (data.last_name||{}).en].filter(Boolean).join(" ");
  const displayTitle = nameHe || nameEn || tid;

  const versions = p.versions || [];
  const viewed = versions.find(x => x.version === state.viewingVersion);
  const versionLine = viewed ? `גרסה ${viewed.version} · נשמר: ${escapeHtml(viewed.saved_at)}` : "";

  // Render each schema field that has content (first_name / last_name are
  // already shown in the header, skip them there).
  const headerKeys = new Set(["first_name", "last_name"]);
  let rowsHtml = "";
  for (const f of SCHEMA) {
    if (headerKeys.has(f.key)) continue;
    if (f.showIf) {
      const gate = data[f.showIf];
      if (!gate || !gate.value) continue;
    }
    if (!hasContent(f.kind, data[f.key])) continue;
    rowsHtml += printRenderField(f, data[f.key]);
  }
  const photosColHtml = printRenderPhotosCol(data.files || [], tid);

  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="print-view">
      <div class="print-actions no-print">
        <button class="primary" onclick="window.print()">🖨️ הדפס</button>
        <button onclick="exitPersonPrint()">חזור לעריכה</button>
      </div>
      <div class="print-header">
        <div class="print-name-he">${escapeHtml(displayTitle)}</div>
        ${nameEn && nameHe ? `<div class="print-name-en">${escapeHtml(nameEn)}</div>` : ""}
        <div class="print-meta">${escapeHtml(tid)}${versionLine ? " · " + versionLine : ""}</div>
      </div>
      <div class="print-body">
        <div class="print-fields">
          ${rowsHtml || `<div class="inline-note">אין נתונים להצגה.</div>`}
        </div>
        ${photosColHtml}
      </div>
    </div>
  `;
}

/**
 * Open a modal listing every saved version of the current person, newest
 * first. Each entry shows a link to switch to that version plus the list of
 * field labels that changed compared with the previous version.
 */
function showVersionDetails() {
  const p = state.currentPerson;
  if (!p || !p.versions || !p.versions.length) return;
  const versions = p.versions;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  // Newest first
  const entriesHtml = versions.slice().reverse().map(v => {
    const realIdx = versions.findIndex(x => x.version === v.version);
    const isFirst = realIdx === 0;
    const prevData = isFirst ? null : (versions[realIdx - 1].data || {});
    const currData = v.data || {};
    const changed = isFirst ? [] : diffFieldLabelsBetween(prevData, currData);

    let fieldsHtml;
    if (isFirst) {
      fieldsHtml = `<li><em>גרסה ראשונה</em></li>`;
    } else if (changed.length === 0) {
      fieldsHtml = `<li><em>ללא שינויים בשדות</em></li>`;
    } else {
      fieldsHtml = changed.map(l => `<li>${escapeHtml(l)}</li>`).join("");
    }

    const isViewed = v.version === state.viewingVersion;
    return `
      <div class="version-entry${isViewed ? ' viewed' : ''}">
        <div class="version-entry-header">
          <a href="#" onclick="return goToVersionFromDetails(${v.version})">
            גרסה ${v.version}
          </a>
          <span class="version-entry-ts">${escapeHtml(v.saved_at)}</span>
          ${isViewed ? `<span class="version-entry-current">(נצפית כעת)</span>` : ""}
        </div>
        <ul class="version-entry-fields">${fieldsHtml}</ul>
      </div>
    `;
  }).join("");

  overlay.innerHTML = `
    <div class="modal-box modal-box-wide">
      <h3 class="modal-h-neutral">היסטוריית גרסאות</h3>
      <div class="versions-list">${entriesHtml}</div>
      <div class="modal-actions">
        <button class="primary" id="vdet-close">סגור</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#vdet-close").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  window._versionDetailsOverlay = overlay;
}

/**
 * Invoked from a version-details link click. Closes the modal (if any) and
 * switches to the selected version, going through the unsaved-changes guard.
 */
async function goToVersionFromDetails(v) {
  if (window._versionDetailsOverlay) {
    window._versionDetailsOverlay.remove();
    window._versionDetailsOverlay = null;
  }
  await switchVersion(v);
  return false;
}

function renderFields(editable) {
  const col = document.getElementById("fields-col");
  let html = "";
  const optionalKeys = SCHEMA.filter(f => f.optional).map(f => f.key);
  const lastOptionalKey = optionalKeys[optionalKeys.length - 1];

  for (const f of SCHEMA) {
    if (f.key === "free_text") continue; // rendered separately, full width, below

    // showIf gating (e.g. death_* only when deceased=true)
    if (f.showIf) {
      const gate = state.draft[f.showIf];
      if (!gate || !gate.value) continue;
    }

    // Optional fields: only render the full control when expanded; otherwise
    // they are represented by a single "הוסף שם נוסף" adder after the last
    // optional field in the schema.
    if (f.optional) {
      const isOpen = expanded.has(f.key);
      if (isOpen) {
        html += `<div class="field"><div class="field-label">
          <span>${escapeHtml(f.label)}</span>
          ${editable ? `<button type="button" class="small danger optional-remove" title="הסר שדה" onclick="toggleOptional('${f.key}', false)">×</button>` : ""}
        </div>`;
        html += renderFieldControl(f, state.draft[f.key], editable, f.key);
        if (f.kind === "ref" || f.kind === "refs") html += getFieldWarningHtml(f.key);
        html += `</div>`;
      }
      // After processing the last optional field in the schema, emit the
      // single "add another name" adder covering every unexpanded optional.
      if (f.key === lastOptionalKey && editable) {
        const unused = optionalKeys.filter(k => !expanded.has(k));
        if (unused.length > 0) {
          const options = unused.map(k => {
            const field = SCHEMA.find(x => x.key === k);
            return `<option value="${escapeAttr(k)}">${escapeHtml(field.label)}</option>`;
          }).join("");
          html += `<div class="field optional-adder">
            <span class="optional-adder-label">+ הוסף שם נוסף:</span>
            <select class="optional-adder-select" onchange="addOptionalName(this.value)">
              <option value="">— בחר סוג שם —</option>
              ${options}
            </select>
          </div>`;
        }
      }
      continue;
    }

    html += `<div class="field"><div class="field-label">${escapeHtml(f.label)}</div>`;
    html += renderFieldControl(f, state.draft[f.key], editable, f.key);
    if (f.kind === "ref" || f.kind === "refs") html += getFieldWarningHtml(f.key);
    html += `</div>`;
  }
  col.innerHTML = html;
}

/** Expand an optional field by key, chosen from the adder combobox. */
function addOptionalName(key) {
  if (!key) return;
  expanded.add(key);
  renderFields(isEditable());
}

function toggleOptional(key, on) {
  if (on) expanded.add(key); else expanded.delete(key);
  // If turned off, also clear the field so it doesn't carry stray data.
  if (!on) {
    const f = SCHEMA.find(x => x.key === key);
    if (f) state.draft[key] = defaultForKind(f.kind);
  }
  renderFields(isEditable());
}

function renderFreeText(editable) {
  const col = document.getElementById("free-text-col");
  if (!col) return;
  const val = state.draft.free_text || "";
  const html = typeof val === "string" ? val : "";

  if (!editable) {
    col.innerHTML = `
      <div class="field"><div class="field-label">טקסט חופשי</div>
        <div class="rt-content-readonly">${html || '<span class="inline-note">אין טקסט.</span>'}</div>
      </div>`;
    return;
  }

  col.innerHTML = `
    <div class="field"><div class="field-label">טקסט חופשי</div>
      <div class="rt-toolbar" id="rt-toolbar">
        <button type="button" title="Bold" onmousedown="event.preventDefault()" onclick="rtExec('bold')"><b>B</b></button>
        <button type="button" title="Italic" onmousedown="event.preventDefault()" onclick="rtExec('italic')"><i>I</i></button>
        <button type="button" title="Underline" onmousedown="event.preventDefault()" onclick="rtExec('underline')"><u>U</u></button>
        <span class="rt-sep"></span>
        <select id="rt-size-select" title="גודל טקסט">
          <option value="" selected>גודל</option>
          <option value="8">8pt</option>
          <option value="10">10pt</option>
          <option value="12">12pt</option>
          <option value="14">14pt</option>
          <option value="16">16pt</option>
          <option value="20">20pt</option>
          <option value="24">24pt</option>
        </select>
        <span class="rt-sep"></span>
        <div class="rt-color-wrap">
          <button type="button" class="rt-color-btn" id="rt-fg-btn" title="צבע טקסט" onmousedown="event.preventDefault()" onclick="rtTogglePalette('fg', event)">
            <span class="rt-color-letter">A</span><span class="rt-color-bar" id="rt-fg-bar" style="background:#000000"></span>
          </button>
        </div>
        <div class="rt-color-wrap">
          <button type="button" class="rt-color-btn" id="rt-bg-btn" title="צבע רקע" onmousedown="event.preventDefault()" onclick="rtTogglePalette('bg', event)">
            <span class="rt-color-letter rt-hl-icon">🖍</span><span class="rt-color-bar" id="rt-bg-bar" style="background:#ffff00"></span>
          </button>
        </div>
      </div>
      <div class="rt-editor" id="rt-editor" contenteditable="true" dir="rtl">${html}</div>
    </div>`;

  const editor = document.getElementById("rt-editor");
  editor.addEventListener("input", function() {
    state.draft.free_text = editor.innerHTML;
  });

  // Size select: apply exact pt size on change (selection is tracked continuously)
  const sizeSelect = document.getElementById("rt-size-select");
  sizeSelect.addEventListener("change", function() {
    if (!this.value) return;
    rtRestoreSelection();
    rtApplyFontSizePt(this.value + "pt");
    rtSyncSizeSelect();
    editor.focus();
  });

  // Custom color palette: click-outside to close
  document.addEventListener("mousedown", rtMaybeClosePalette);

  // Continuously track the last valid selection inside the editor AND
  // auto-update size dropdown based on caret position.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (el && editor.contains(el)) {
      _rtSavedRange = sel.getRangeAt(0).cloneRange();
      rtSyncSizeSelect();
    }
  });
}

/* Inspect the caret/selection position and set the size <select>
   to the matching pt size if it corresponds to one of the options. */
function rtSyncSizeSelect() {
  const select = document.getElementById("rt-size-select");
  const editor = document.getElementById("rt-editor");
  if (!select || !editor) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  let node = sel.getRangeAt(0).startContainer;
  // If we're in a text node, go up to its parent element
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editor.contains(node)) return;

  // getComputedStyle returns font-size in px
  const px = parseFloat(window.getComputedStyle(node).fontSize);
  if (!isFinite(px)) return;
  // Convert px to pt (1pt = 1/72 in, 1in = 96px -> 1pt = 96/72 = 1.3333 px)
  const pt = Math.round(px * 72 / 96);

  // Only set if that pt value matches one of the dropdown options
  const options = Array.from(select.options).map(o => o.value);
  if (options.includes(String(pt))) {
    select.value = String(pt);
  } else {
    select.selectedIndex = 0;  // "גודל" placeholder
  }
}

/* Preset palette colors. Customize freely; kept small for a tidy popup. */
const RT_PALETTE = [
  "#000000", "#444444", "#888888", "#bbbbbb", "#ffffff",
  "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5",
  "#5e35b1", "#d81b60", "#795548", "#00acc1", "#7cb342",
];
const RT_HILITE_PALETTE = [
  "transparent", "#ffff00", "#ffd54f", "#ffab91", "#f48fb1",
  "#ce93d8", "#90caf9", "#80deea", "#a5d6a7", "#fff59d",
];

let _rtPaletteOpenFor = null; // "fg" | "bg" | null

/* Toggle a custom color palette popup anchored ABOVE the button so it
   never obscures the editor below. */
function rtTogglePalette(which, ev) {
  if (ev) ev.stopPropagation();
  const existing = document.getElementById("rt-palette");
  if (existing) existing.remove();
  if (_rtPaletteOpenFor === which) { _rtPaletteOpenFor = null; return; }
  _rtPaletteOpenFor = which;

  const btn = document.getElementById(which === "fg" ? "rt-fg-btn" : "rt-bg-btn");
  const palette = which === "fg" ? RT_PALETTE : RT_HILITE_PALETTE;

  const pop = document.createElement("div");
  pop.id = "rt-palette";
  pop.className = "rt-palette";
  // Prevent clicks inside the popup from closing it / stealing focus
  pop.addEventListener("mousedown", e => e.preventDefault());

  const grid = document.createElement("div");
  grid.className = "rt-palette-grid";
  palette.forEach(color => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "rt-swatch";
    sw.title = color;
    if (color === "transparent") {
      sw.classList.add("rt-swatch-none");
      sw.textContent = "✕";
    } else {
      sw.style.background = color;
    }
    sw.addEventListener("click", e => {
      e.stopPropagation();
      rtApplyColor(which, color);
      rtClosePalette();
    });
    grid.appendChild(sw);
  });
  pop.appendChild(grid);

  // Optional "more colors..." button opens the native picker as fallback
  const more = document.createElement("button");
  more.type = "button";
  more.className = "rt-more-colors";
  more.textContent = "צבעים נוספים…";
  more.addEventListener("click", e => {
    e.stopPropagation();
    const tmp = document.createElement("input");
    tmp.type = "color";
    tmp.value = which === "fg" ? "#000000" : "#ffff00";
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    tmp.style.left = "-9999px";
    document.body.appendChild(tmp);
    tmp.addEventListener("change", () => {
      rtApplyColor(which, tmp.value);
      tmp.remove();
      rtClosePalette();
    });
    tmp.click();
  });
  pop.appendChild(more);

  // Position the popup ABOVE the button
  document.body.appendChild(pop);
  const btnRect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = btnRect.left + window.scrollX;
  const top = btnRect.top + window.scrollY - popRect.height - 6;
  // Keep within viewport horizontally
  const maxLeft = window.scrollX + window.innerWidth - popRect.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  pop.style.left = left + "px";
  pop.style.top = Math.max(window.scrollY + 8, top) + "px";
}

function rtClosePalette() {
  const p = document.getElementById("rt-palette");
  if (p) p.remove();
  _rtPaletteOpenFor = null;
}

function rtMaybeClosePalette(e) {
  const pop = document.getElementById("rt-palette");
  if (!pop) return;
  if (pop.contains(e.target)) return;
  // Clicking either color button is handled by rtTogglePalette (which also closes)
  if (e.target.closest && e.target.closest(".rt-color-btn")) return;
  rtClosePalette();
}

function rtApplyColor(which, color) {
  rtRestoreSelection();
  if (which === "fg") {
    document.getElementById("rt-fg-bar").style.background = color;
    document.execCommand("foreColor", false, color);
  } else {
    document.getElementById("rt-bg-bar").style.background = color === "transparent" ? "#ffffff" : color;
    // "transparent" clears highlight — use hiliteColor with transparent
    document.execCommand("hiliteColor", false, color === "transparent" ? "transparent" : color);
  }
  const editor = document.getElementById("rt-editor");
  if (editor) {
    state.draft.free_text = editor.innerHTML;
    editor.focus();
  }
}

/* ---- Rich-text helpers ---- */
let _rtSavedRange = null;
function rtSaveSelection() {
  const sel = window.getSelection();
  _rtSavedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
}
function rtRestoreSelection() {
  if (!_rtSavedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(_rtSavedRange);
}
function rtExec(cmd) {
  document.execCommand(cmd, false, null);
  document.getElementById("rt-editor").focus();
}

/* Apply an explicit pt font-size to the current selection.
   - If a range is selected, wrap it in a <span style="font-size: Xpt">.
   - If the caret is collapsed, insert an empty styled span at the caret
     so subsequent typed text picks up the new size. */
function rtApplyFontSizePt(ptSize) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const span = document.createElement("span");
  span.style.fontSize = ptSize;
  try {
    if (range.collapsed) {
      // Insert an empty span with a zero-width space so the caret can sit inside
      span.appendChild(document.createTextNode("\u200B"));
      range.insertNode(span);
      // Place caret inside the span, after the ZWSP
      const newRange = document.createRange();
      newRange.setStart(span.firstChild, 1);
      newRange.setEnd(span.firstChild, 1);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } else {
      span.appendChild(range.extractContents());
      range.insertNode(span);
      // Re-select the wrapped content
      sel.removeAllRanges();
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      sel.addRange(newRange);
    }
    // Notify editor of change
    const editor = document.getElementById("rt-editor");
    if (editor) state.draft.free_text = editor.innerHTML;
  } catch (e) {
    console.error("rtApplyFontSizePt failed:", e);
  }
}

function renderFieldControl(f, val, editable, path) {
  const disabled = editable ? "" : "disabled";
  switch (f.kind) {
    case "text":
    case "place":
      return `
        <div class="field-row">
          <div class="he"><label>עברית</label>
            <input ${disabled} value="${escapeAttr(val.he||"")}" oninput="updateField('${path}','he',this.value)"></div>
          <div class="en"><label>English</label>
            <input ${disabled} value="${escapeAttr(val.en||"")}" oninput="updateField('${path}','en',this.value)"></div>
          <div class="comment"><label>הערות</label>
            <input ${disabled} value="${escapeAttr(val.comment||"")}" oninput="updateField('${path}','comment',this.value)"></div>
        </div>`;
    case "long_text":
      return `
        <div class="field-row">
          <div class="he"><label>עברית</label>
            <textarea ${disabled} oninput="updateField('${path}','he',this.value)">${escapeHtml(val.he||"")}</textarea></div>
          <div class="en"><label>English</label>
            <textarea ${disabled} oninput="updateField('${path}','en',this.value)">${escapeHtml(val.en||"")}</textarea></div>
          <div class="comment"><label>הערות</label>
            <textarea ${disabled} oninput="updateField('${path}','comment',this.value)">${escapeHtml(val.comment||"")}</textarea></div>
        </div>`;
    case "date":
      return `
        <div class="field-row">
          <div><label>תאריך${val.year_only ? " (שנה בלבד)" : ""}</label>
            <input ${disabled} value="${escapeAttr(val.value||"")}"
              placeholder="${val.year_only ? "1952" : "YYYY-MM-DD או טקסט"}"
              oninput="updateField('${path}','value',this.value)"></div>
          <div><label>
              <input type="checkbox" ${disabled} ${val.year_only?"checked":""}
                onchange="updateField('${path}','year_only',this.checked)"> שנה בלבד
            </label></div>
          <div class="comment"><label>הערות</label>
            <input ${disabled} value="${escapeAttr(val.comment||"")}" oninput="updateField('${path}','comment',this.value)"></div>
        </div>`;
    case "ref":
      return renderRef(val, editable, path);
    case "refs":
      return renderRefs(val, editable, path);
    case "bool":
      return `
        <label class="inline-note" style="font-size:14px; color:#222;">
          <input type="checkbox" ${disabled} ${val.value?"checked":""}
            onchange="updateBool('${path}', this.checked)">
          סמן אם רלוונטי
        </label>`;
  }
}

function updateBool(path, checked) {
  setAtPath(path + ".value", checked);
  // Re-render so showIf-dependent fields appear/disappear immediately.
  renderFields(isEditable());
}

function renderRef(val, editable, path) {
  const disabled = editable ? "" : "disabled";
  const modeControls = `
    <div class="ref-mode">
      <label><input type="radio" name="mode-${path}" ${disabled}
        ${val.mode==="text"?"checked":""} onchange="updateField('${path}','mode','text')"> טקסט</label>
      <label><input type="radio" name="mode-${path}" ${disabled}
        ${val.mode==="link"?"checked":""} onchange="updateField('${path}','mode','link')"> קישור לאדם אחר</label>
    </div>`;
  if (val.mode === "link") {
    const target = state.people.find(p => p.technical_id === val.link_id);
    const label = target ? `${target.display_he || target.technical_id}` : (val.link_id || "(לא נבחר)");
    return modeControls + `
      <div class="field-row">
        <div><label>קישור</label>
          ${editable
            ? `<select onchange="updateField('${path}','link_id',this.value)">
                 <option value="">— בחר —</option>
                 ${state.people.filter(p => !state.currentPerson || p.technical_id !== state.currentPerson.technical_id).map(p => `<option value="${escapeAttr(p.technical_id)}" ${p.technical_id===val.link_id?"selected":""}>${escapeHtml(p.display_he || p.technical_id)} (${escapeHtml(p.technical_id)})</option>`).join("")}
               </select>`
            : `<span class="ref-link-display" onclick="showPerson('${escapeAttr(val.link_id)}')">${escapeHtml(label)} ↩</span>`}
        </div>
        <div class="ref-open-cell">
          <label>&nbsp;</label>
          ${val.link_id ? `<button type="button" class="small" onclick="showPerson('${escapeAttr(val.link_id)}')">פתח</button>` : ""}
        </div>
        <div class="comment"><label>הערות</label>
          <input ${disabled} value="${escapeAttr(val.comment||"")}" oninput="updateField('${path}','comment',this.value)"></div>
      </div>`;
  } else {
    return modeControls + `
      <div class="field-row">
        <div class="he"><label>שם (עברית)</label>
          <input ${disabled} value="${escapeAttr(val.he||"")}" oninput="updateField('${path}','he',this.value)"></div>
        <div class="en"><label>Name (English)</label>
          <input ${disabled} value="${escapeAttr(val.en||"")}" oninput="updateField('${path}','en',this.value)"></div>
        <div class="comment"><label>הערות</label>
          <input ${disabled} value="${escapeAttr(val.comment||"")}" oninput="updateField('${path}','comment',this.value)"></div>
      </div>`;
  }
}

function renderRefs(arr, editable, path) {
  const items = (arr || []).map((item, i) => `
    <div class="subfield">
      ${renderRef(item, editable, path + "[" + i + "]")}
      ${editable ? `<div class="subfield-actions">
        <button type="button" class="small danger" onclick="removeRef('${path}',${i})">הסר</button>
      </div>` : ""}
    </div>
  `).join("");
  return `<div class="subfield-list">${items || "<div class='inline-note'>לא הוזנו עדיין.</div>"}</div>
    ${editable ? `<button type="button" class="small" onclick="addRef('${path}')" style="margin-top:6px;">+ הוסף</button>` : ""}`;
}

// -------- Updates --------
function setAtPath(path, value) {
  // path like "father.he" or "children[0].link_id"
  const parts = path.match(/[^.\[\]]+/g);
  let obj = state.draft;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (obj[k] === undefined) obj[k] = isNaN(parts[i+1]) ? {} : [];
    obj = obj[k];
  }
  obj[parts[parts.length - 1]] = value;
}
function getAtPath(path) {
  const parts = path.match(/[^.\[\]]+/g);
  let obj = state.draft;
  for (const p of parts) { if (obj == null) return undefined; obj = obj[p]; }
  return obj;
}

function updateField(path, subkey, value) {
  setAtPath(path + "." + subkey, value);
  // re-render when mode or link_id changes (mode switches controls,
  // link_id updates inline relationship warnings)
  if (subkey === "mode" || subkey === "link_id") {
    renderFields(isEditable());
  }
}
function addRef(path) {
  const arr = getAtPath(path) || [];
  arr.push({ mode: "text", he: "", en: "", link_id: "", comment: "" });
  setAtPath(path, arr);
  renderFields(isEditable());
}
function removeRef(path, i) {
  const arr = getAtPath(path);
  arr.splice(i, 1);
  renderFields(isEditable());
}
function isEditable() {
  const p = state.currentPerson;
  if (p._new || !p.versions || p.versions.length === 0) return true;
  const latestV = p.versions[p.versions.length - 1].version;
  return state.viewingVersion === latestV;
}

// -------- Photos (gallery) --------
/* Classify a filename or MIME type into "image" | "pdf" | "other". */
function classifyFile(p) {
  const name = (p.file || p.name || "").toLowerCase();
  const mime = (p.mime || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  return "other";
}

/* Icon (unicode) for non-image files. */
function fileIconFor(kind, name) {
  if (kind === "pdf") return "📄";
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return "🗜";
  if (/\.(docx?|odt|rtf)$/i.test(name)) return "📝";
  if (/\.(xlsx?|ods|csv|tsv)$/i.test(name)) return "📊";
  if (/\.(pptx?|odp)$/i.test(name)) return "📽";
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(name)) return "🎵";
  if (/\.(mp4|mov|avi|mkv|webm)$/i.test(name)) return "🎬";
  if (/\.(txt|md|log)$/i.test(name)) return "📃";
  return "📎";
}

function renderPhotos(editable) {
  const col = document.getElementById("photo-col");
  const files = state.draft.files || [];
  const tid = state.currentPerson.technical_id;

  let html = `<div class="field-label">תמונות וקבצים</div>`;
  if (files.length === 0) {
    html += `<div class="photo-placeholder">אין קבצים</div>`;
  } else {
    for (let i = 0; i < files.length; i++) {
      const p = files[i];
      const src = p.data_url
        ? p.data_url
        : `/files/${encodeURIComponent(tid)}/${encodeURIComponent(p.file)}`;
      const kind = classifyFile(p);
      const displayName = p.file || p.name || "קובץ";
      const openable = kind === "image" || kind === "pdf";
      // For new (unsaved) files, only openable for images — we have a data URL.
      // PDFs uploaded but not yet saved don't have a servable URL.
      const canOpen = openable && (kind === "image" ? true : !p.data_url);

      let preview = "";
      if (kind === "image") {
        preview = canOpen
          ? `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt=""></a>`
          : `<img src="${src}" alt="">`;
      } else {
        const icon = fileIconFor(kind, displayName);
        const label = `<span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(displayName)}</span>`;
        preview = canOpen
          ? `<a class="file-link" href="${src}" target="_blank" rel="noopener">${label}</a>`
          : `<span class="file-link">${label}</span>`;
      }

      const canMoveUp = i > 0;
      const canMoveDown = i < files.length - 1;
      html += `
        <div class="photo-item">
          ${preview}
          ${editable
            ? `<input type="text" placeholder="הערות לקובץ"
                value="${escapeAttr(p.comment || "")}"
                oninput="updatePhotoComment(${i}, this.value)">
               <div class="photo-actions">
                 <button class="small danger" onclick="removePhotoAt(${i})">הסר</button>
                 <button class="small" title="הזז למעלה" ${canMoveUp ? "" : "disabled"} onclick="moveFileUp(${i})">▲</button>
                 <button class="small" title="הזז למטה" ${canMoveDown ? "" : "disabled"} onclick="moveFileDown(${i})">▼</button>
               </div>`
            : (p.comment ? `<div class="inline-note">${escapeHtml(p.comment)}</div>` : "")}
          ${p.data_url ? `<div class="inline-note">קובץ חדש — יישמר בעת השמירה.</div>` : ""}
        </div>`;
    }
  }
  if (editable) {
    html += `
      <div>
        <input type="file" id="photo-input" multiple onchange="onPhotosSelected(event)">
        <div class="inline-note">ניתן לבחור מספר קבצים בו-זמנית (תמונות, PDF, או כל סוג אחר).</div>
      </div>`;
  }
  col.innerHTML = html;
}

function updatePhotoComment(i, value) {
  if (!state.draft.files[i]) return;
  state.draft.files[i].comment = value;
}

function removePhotoAt(i) {
  state.draft.files.splice(i, 1);
  renderPhotos(isEditable());
}

function moveFileUp(i) {
  if (i <= 0 || !state.draft.files[i]) return;
  const arr = state.draft.files;
  [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
  renderPhotos(isEditable());
}

function moveFileDown(i) {
  const arr = state.draft.files;
  if (i < 0 || i >= arr.length - 1) return;
  [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
  renderPhotos(isEditable());
}

function onPhotosSelected(ev) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  let pending = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      state.draft.files.push({
        data_url: reader.result,
        name: file.name,
        mime: file.type || "",
        comment: ""
      });
      pending--;
      if (pending === 0) renderPhotos(isEditable());
    };
    reader.readAsDataURL(file);
  });
  // reset input so selecting the same file again still triggers change
  ev.target.value = "";
}

// -------- Reciprocal relationships --------

/** Extract all link_ids from a ref field (single ref) or refs field (array). */
function extractLinkIds(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.filter(v => v && v.mode === "link" && v.link_id).map(v => v.link_id);
  }
  if (val.mode === "link" && val.link_id) return [val.link_id];
  return [];
}

/** Collect all relationship link_ids from a person data object. */
function collectRelationshipLinks(data) {
  return {
    father:   extractLinkIds(data.father),
    mother:   extractLinkIds(data.mother),
    siblings: extractLinkIds(data.siblings),
    spouses:  extractLinkIds(data.spouses),
    children: extractLinkIds(data.children),
  };
}

/**
 * Compute reciprocal updates needed when sourceTid's relationships changed.
 *
 *   A.father   added B  →  B.children  gets A
 *   A.mother   added B  →  B.children  gets A
 *   A.siblings added B  →  B.siblings  gets A
 *   A.spouses  added B  →  B.spouses   gets A
 *   A.children added B  →  can't auto-set father/mother (ambiguous);
 *                          covered when user sets B.father/mother = A.
 */
function computeReciprocalUpdates(sourceTid, oldLinks, newLinks) {
  const updates = [];
  function added(field) {
    const oldSet = new Set(oldLinks[field] || []);
    return (newLinks[field] || []).filter(id => !oldSet.has(id) && id !== sourceTid);
  }
  for (const tid of added("father"))   updates.push({ targetTid: tid, field: "children", sourceTid });
  for (const tid of added("mother"))   updates.push({ targetTid: tid, field: "children", sourceTid });
  for (const tid of added("siblings")) updates.push({ targetTid: tid, field: "siblings", sourceTid });
  for (const tid of added("spouses"))  updates.push({ targetTid: tid, field: "spouses",  sourceTid });
  return updates;
}

/**
 * Apply a single reciprocal update: add sourceTid as a link inside the
 * target person's field array, then save as a new version via normal /save.
 */
async function applyReciprocalUpdate({ targetTid, field, sourceTid }) {
  const target = state.allData.find(p => p.technical_id === targetTid);
  if (!target || !target.versions || !target.versions.length) return;

  const latestData = JSON.parse(JSON.stringify(
    target.versions[target.versions.length - 1].data || {}
  ));

  if (!Array.isArray(latestData[field])) latestData[field] = [];

  // Already present? → nothing to do
  const already = latestData[field].some(
    item => item && item.mode === "link" && item.link_id === sourceTid
  );
  if (already) return;

  latestData[field].push({
    mode: "link", link_id: sourceTid, he: "", en: "", comment: ""
  });

  try {
    const updatedObj = await savePerson(targetTid, latestData);
    const idx = state.allData.findIndex(p => p.technical_id === targetTid);
    if (idx >= 0) state.allData[idx] = updatedObj;
    else state.allData.push(updatedObj);
  } catch (e) {
    console.error("Failed to save reciprocal for " + targetTid + "." + field + ":", e);
  }
}

// -------- Removed-relationship warning --------

/** Hebrew labels for relationship fields. */
const REL_LABELS = {
  father: "אב", mother: "אם", siblings: "אחים ואחיות",
  spouses: "בני/בנות זוג", children: "ילדים",
};

/** The reciprocal field on the OTHER person that would reference us back. */
const RECIPROCAL_FIELD = {
  father: "children", mother: "children",
  siblings: "siblings", spouses: "spouses",
  // children→parent is ambiguous; check both father and mother
};

/**
 * For a given relationship field, compute inline warnings about removed links
 * whose target person still has a back-reference to us. Uses only allData (no
 * server calls). Returns HTML string (empty if no warnings).
 */
function getFieldWarningHtml(fieldKey) {
  if (!state.currentPerson || !state.cleanSnapshot) return "";
  const tid = state.currentPerson.technical_id;
  const oldData = JSON.parse(state.cleanSnapshot);
  const oldIds = new Set(extractLinkIds(oldData[fieldKey]));
  const newIds = new Set(extractLinkIds(state.draft[fieldKey]));

  // IDs that were removed or replaced (present in old, absent in new)
  const removed = [...oldIds].filter(id => !newIds.has(id) && id !== tid);
  if (!removed.length) return "";

  // For each removed ID, check if target still references us back
  const recipField = RECIPROCAL_FIELD[fieldKey]; // may be undefined for children
  const dangling = [];

  for (const targetTid of removed) {
    const target = state.allData.find(p => p.technical_id === targetTid);
    if (!target || !target.versions || !target.versions.length) continue;
    const targetData = target.versions[target.versions.length - 1].data || {};
    const dn = personDisplayName(target);
    const displayName = dn.he || dn.en || targetTid;

    if (fieldKey === "children") {
      // check target's father and mother
      const fLinks = extractLinkIds(targetData.father);
      const mLinks = extractLinkIds(targetData.mother);
      let recipLabel = "";
      if (fLinks.includes(tid)) recipLabel = "אב";
      else if (mLinks.includes(tid)) recipLabel = "אם";
      if (recipLabel) dangling.push({ displayName, targetTid, recipLabel });
    } else if (recipField) {
      const backLinks = extractLinkIds(targetData[recipField]);
      if (backLinks.includes(tid)) {
        dangling.push({ displayName, targetTid, recipLabel: REL_LABELS[recipField] || recipField });
      }
    }
  }

  if (!dangling.length) return "";

  const lines = dangling.map(d =>
    `<strong>${escapeHtml(d.displayName)}</strong> (${escapeHtml(d.targetTid)}) — ` +
    `השדה <em>${escapeHtml(d.recipLabel)}</em> עדיין מכיל קישור לדף הזה`
  ).join("<br>");
  return `<div class="rel-warning">⚠ הדפים הבאים לא יעודכנו אוטומטית:<br>${lines}</div>`;
}

// -------- Save --------
async function saveDraft() {
  // Capture current rich-text editor content before saving
  syncRichText();
  // Treat empty-looking HTML as truly empty
  if (typeof state.draft.free_text === "string") {
    const stripped = state.draft.free_text.replace(/<br\s*\/?>/gi, "").replace(/<div>\s*<\/div>/gi, "").trim();
    if (stripped === "") state.draft.free_text = "";
  }

  const data = JSON.parse(JSON.stringify(state.draft));
  // files: pass through; server will materialize data_url into files on disk
  data.files = (state.draft.files || []).map(p => p.data_url
    ? { data_url: p.data_url, name: p.name || "", mime: p.mime || "", comment: p.comment || "" }
    : { file: p.file, comment: p.comment || "" });
  delete data.photo;
  delete data.photos;

  // Snapshot old relationship links BEFORE saving.
  const tid = state.currentPerson.technical_id;
  const oldLinks = state.cleanSnapshot
    ? collectRelationshipLinks(JSON.parse(state.cleanSnapshot))
    : { father: [], mother: [], siblings: [], spouses: [], children: [] };

  try {
    const obj = state.currentPerson._new
      ? await createPerson(tid, data)
      : await savePerson(tid, data);
    state.currentPerson = obj;
    state.viewingVersion = obj.versions[obj.versions.length - 1].version;
    loadVersionIntoDraft(state.viewingVersion);
    // Update the in-memory cache immediately.
    const idx = state.allData.findIndex(p => p.technical_id === obj.technical_id);
    if (idx >= 0) state.allData[idx] = obj;
    else state.allData.push(obj);

    // Compute and apply reciprocal relationship updates.
    const savedLinks = collectRelationshipLinks(
      obj.versions[obj.versions.length - 1].data || {}
    );
    const reciprocals = computeReciprocalUpdates(tid, oldLinks, savedLinks);
    if (reciprocals.length > 0) {
      await Promise.all(reciprocals.map(applyReciprocalUpdate));
    }

    state.people = await listPeople();
    renderPerson();
    flashMessage("נשמר בהצלחה.");
  } catch (e) { alert("שגיאה בשמירה: " + e.message); }
}

function flashMessage(msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = "position:fixed; top:70px; left:50%; transform:translateX(-50%); background:#27ae60; color:#fff; padding:10px 20px; border-radius:4px; z-index:9999;";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// -------- Utilities --------
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// -------- Browser history / deep-linking --------
// URL scheme:
//   /                 -> list
//   /#<tid>           -> person <tid>
//   /#<tid>/print     -> print view of <tid>
//
// When _isPopping is true we are currently handling a browser back/forward
// or hashchange event and must NOT push a new entry onto the history stack.
let _isPopping = false;

function _stateKey(s) {
  if (!s) return "list|";
  return (s.view || "list") + "|" + (s.tid || "");
}

/** Parse the current location.hash into a view state object. */
function _parseHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  if (!raw) return { view: "list" };
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return { view: "list" };
  let tid;
  try { tid = decodeURIComponent(parts[0]); }
  catch (e) { return { view: "list" }; }
  if (!tid) return { view: "list" };
  if (parts[1] === "print") return { view: "print", tid };
  return { view: "person", tid };
}

/** Build the URL (pathname + hash) for a given view state. */
function _stateToUrl(s) {
  let url = location.pathname;
  if (s && s.view === "person" && s.tid) {
    url += "#" + encodeURIComponent(s.tid);
  } else if (s && s.view === "print" && s.tid) {
    url += "#" + encodeURIComponent(s.tid) + "/print";
  }
  return url;
}

/**
 * Push a new history entry for the given state unless we are already
 * handling a popstate / hashchange event, or the entry would duplicate the
 * current one.
 */
function pushViewState(s) {
  if (_isPopping) return;
  const cur = history.state;
  if (cur && _stateKey(cur) === _stateKey(s)) return;
  history.pushState(s, "", _stateToUrl(s));
}

/**
 * Render the given view state without pushing onto history. Used by the
 * popstate, hashchange, and initial-load paths.
 */
async function _navigateToState(s) {
  _isPopping = true;
  try {
    if (s && s.view === "print" && s.tid) {
      if (!state.currentPerson || state.currentPerson.technical_id !== s.tid) {
        await showPerson(s.tid);
      }
      renderPersonPrintView();
    } else if (s && s.view === "person" && s.tid) {
      await showPerson(s.tid);
    } else {
      await showList();
    }
  } finally {
    _isPopping = false;
  }
}

window.addEventListener("popstate", async (e) => {
  const s = e.state || _parseHash();
  await _navigateToState(s);
});

// Also handle the case where the user edits the hash portion of the URL
// directly in the address bar — the browser does NOT reload the page in
// that case; it only fires hashchange.
window.addEventListener("hashchange", async () => {
  const s = _parseHash();
  // If this hashchange corresponds to a history entry we already pushed
  // ourselves, the state is already correct — don't re-render.
  if (history.state && _stateKey(history.state) === _stateKey(s)) return;
  history.replaceState(s, "", _stateToUrl(s));
  await _navigateToState(s);
});

// -------- Init --------
// Seed the initial history entry so the first view after load has a known
// state. If the URL already contains a hash, route into that view directly.
(function initialLoad() {
  // Fetch site settings first so the header/title are correct before any
  // view is rendered. Errors are non-fatal — the default name stays.
  loadSettings();
  const s = _parseHash();
  history.replaceState(s, "", _stateToUrl(s));
  _navigateToState(s);
})();
