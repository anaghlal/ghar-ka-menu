// app.js - Ghar Ka Menu: phone UI, shared-state sync (Google Drive) and optional Claude helpers.
import * as S from "./store.js";
import { Drive } from "./drive.js";
import * as AI from "./ai.js";
import { createEngine, SLOTS, addDays, isoDate, dayName } from "./planner.js";
import CONF from "./config.js";

const FILES = { recipes: "recipes.json", config: "config.json", plan: "plan.json", ratings: "ratings.json",
  custom: "custom_recipes.json", prefs: "prefs.json", shopping: "shopping.json" };
const SHARED = ["plan", "ratings", "custom", "prefs", "shopping"];          // family-editable state
const MERGE = { plan: S.mergePlan, ratings: S.mergeRatings, custom: (a, b) => S.mergeById(a, b, "recipes"),
  prefs: S.newer, shopping: (a, b) => S.mergeMap(a, b, "checked") };
const SLOT_LABEL = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };
const RATE = [[1, "Loved"], [0, "OK"], [-1, "Didn't work"]];

const today = () => isoDate(new Date());
const st = {
  recipes: [], config: null, plan: { version: 1, days: {} }, ratings: { version: 1, ratings: {} }, custom: { version: 1, recipes: [] },
  prefs: { version: 1 }, shopping: { version: 1, checked: {} }, engine: null, date: today(), tab: "today",
  me: S.ls("gkm.me") || "", clientId: S.ls("gkm.clientId") || CONF.GOOGLE_CLIENT_ID, folderName: S.ls("gkm.folder") || CONF.DRIVE_FOLDER,
  folderId: S.ls("gkm.folderId") || "", fileIds: JSON.parse(S.ls("gkm.fileIds") || "{}"), dirty: new Set(), syncing: false,
  apiKey: S.ls("gkm.apiKey") || "", model: S.ls("gkm.model") || "", shopDays: 3, recipeQuery: "", recipeFilter: "all",
};
let drive = new Drive(st.clientId);

// ---------------- utils
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const R = id => st.engine?.R.get(id);
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function frac(q) { const m = { 0.25: "¼", 0.5: "½", 0.75: "¾", 1.25: "1¼", 1.5: "1½", 1.75: "1¾", 2.5: "2½", 3.5: "3½" }; return m[q] || String(Math.round(q * 100) / 100); }
function qty(q, unit) { const u = unit || "serving"; return /^\d/.test(u) ? `${frac(q)} × ${u}` : `${frac(q)} ${u}`; }
function fmtDate(iso) { const d = new Date(iso + "T12:00:00"); return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }); }
function grams(item, g) {
  if (/^egg/.test(item)) return `${Math.ceil(g / 50)} eggs`;
  if (/milk|buttermilk|coconut water|stock/.test(item)) return g >= 1000 ? `${(g / 1000).toFixed(1)} L` : `${Math.round(g / 10) * 10} ml`;
  return g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.max(10, Math.round(g / 10) * 10)} g`;
}

// ---------------- data / engine
function rebuild() {
  if (!st.recipes.length || !st.config) { st.engine = null; return; }
  const custom = (st.custom.recipes || []).filter(r => !r.deleted);
  const ids = new Set(custom.map(r => r.id));
  st.engine = createEngine([...st.recipes.filter(r => !ids.has(r.id)), ...custom], st.config, { ratings: st.ratings.ratings, prefs: st.prefs });
}
function ensurePlan() {
  if (!st.engine) return;
  const before = JSON.stringify(Object.keys(st.plan.days || {}).filter(d => d >= today()));
  st.engine.planRange(st.plan, today(), CONF.PLAN_DAYS, { onlyMissing: true, by: st.me });
  if (JSON.stringify(Object.keys(st.plan.days).filter(d => d >= today())) !== before) save("plan");
}
async function save(key) {
  st[key].updatedAt = Date.now();
  await S.set(key, st[key]);
  if (SHARED.includes(key)) { st.dirty.add(key); schedulePush(); }
}
function schedulePush() { clearTimeout(schedulePush.t); schedulePush.t = setTimeout(push, 1500); }

// ---------------- Drive sync
function setSync(cls, title) { const b = $("#syncBtn"); b.className = "sync " + cls; b.title = title; b.textContent = cls === "busy" ? "◌ syncing" : cls === "ok" ? "● synced" : cls === "err" ? "● sync error" : "○ offline"; }
async function ensureFolder(interactive) {
  if (st.folderId) return st.folderId;
  if (!drive.signedIn) await drive.signIn(interactive);
  const found = await drive.findFolder(st.folderName);
  if (found.length) st.folderId = found[0].id;
  else { if (!interactive) throw new Error("folder not found"); st.folderId = (await drive.createFolder(st.folderName)).id; toast(`Created Drive folder “${st.folderName}” - share it with family`); }
  S.ls("gkm.folderId", st.folderId);
  return st.folderId;
}
async function refreshFileIds() {
  const files = await drive.list(st.folderId);
  st.fileIds = {};
  for (const f of files) for (const [k, name] of Object.entries(FILES)) if (f.name === name) st.fileIds[k] = f.id;
  S.ls("gkm.fileIds", JSON.stringify(st.fileIds));
}
async function pull(interactive = false) {
  if (!st.clientId) return setSync("", "Not connected");
  if (!drive.signedIn && !interactive) return setSync("", "Tap to sign in");
  st.syncing = true; setSync("busy", "Syncing");
  try {
    await ensureFolder(interactive); await refreshFileIds();
    for (const k of ["recipes", "config"]) if (st.fileIds[k]) { st[k] = k === "recipes" ? (await drive.readJson(st.fileIds[k])).recipes : await drive.readJson(st.fileIds[k]); await S.set(k, st[k]); }
    for (const k of SHARED) if (st.fileIds[k]) { const remote = await drive.readJson(st.fileIds[k]); st[k] = MERGE[k](st[k], remote); await S.set(k, st[k]); }
    rebuild(); ensurePlan(); render();
    if (st.dirty.size) await push(); else setSync("ok", "Synced " + new Date().toLocaleTimeString());
  } catch (e) { console.error(e); setSync("err", e.message); if (interactive) toast(e.message, 5000); }
  finally { st.syncing = false; }
}
async function push() {
  if (!st.dirty.size || !drive.signedIn || !st.folderId) { if (st.dirty.size) setSync("", "Changes saved on this phone - will sync"); return; }
  setSync("busy", "Saving");
  try {
    for (const k of [...st.dirty]) {
      let merged = st[k];
      if (st.fileIds[k]) { try { merged = MERGE[k](st[k], await drive.readJson(st.fileIds[k])); } catch { } }
      const res = await drive.writeJson(st.folderId, FILES[k], merged, st.fileIds[k]);
      st.fileIds[k] = res.id; st[k] = merged; await S.set(k, merged); st.dirty.delete(k);
    }
    S.ls("gkm.fileIds", JSON.stringify(st.fileIds));
    rebuild(); setSync("ok", "Synced " + new Date().toLocaleTimeString()); render();
  } catch (e) { console.error(e); setSync("err", e.message); }
}
async function uploadDataFiles(files) {
  for (const f of files) {
    const obj = JSON.parse(await f.text());
    const key = Array.isArray(obj.recipes) && obj.version === 2 ? "recipes" : obj.members ? "config" : null;
    if (!key) { toast(`Skipped ${f.name}: not recipes.json or config.json`); continue; }
    st[key] = key === "recipes" ? obj.recipes : obj; await S.set(key, st[key]);
    if (drive.signedIn && st.folderId) { const r = await drive.writeJson(st.folderId, FILES[key], obj, st.fileIds[key]); st.fileIds[key] = r.id; S.ls("gkm.fileIds", JSON.stringify(st.fileIds)); }
    toast(`Loaded ${FILES[key]}` + (drive.signedIn ? " and uploaded to Drive" : " on this phone"));
  }
  rebuild(); ensurePlan(); render();
}

// ---------------- rendering
function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === st.tab));
  const v = $("#view");
  if (!st.engine && st.tab !== "settings") {
    v.innerHTML = `<div class="empty"><p><b>Welcome!</b></p><p>Connect Google Drive or load the data files to start.</p>
      <button class="btn pri" data-act="tab" data-tab="settings">Open Settings</button></div>`; return;
  }
  ({ today: renderToday, week: renderWeek, shop: renderShop, recipes: renderRecipes, settings: renderSettings })[st.tab](v);
}

function dayStrip() {
  const vegDays = st.config?.household?.veg_only_days || [];
  let h = `<div class="days">`;
  for (let i = -1; i < CONF.PLAN_DAYS; i++) {
    const d = addDays(today(), i), dt = new Date(d + "T12:00:00");
    h += `<button class="day ${d === st.date ? "on" : ""} ${vegDays.includes(dayName(d)) ? "veg" : ""}" data-act="date" data-date="${d}">
      ${dt.toLocaleDateString("en-IN", { weekday: "short" })}<b>${dt.getDate()}</b></button>`;
  }
  return h + `</div>`;
}

function sidesChips(meal) {
  const cl = st.engine.cookList(meal);
  return cl.sides.map(s => `<span class="chip">+ ${esc(s.recipe.title)} · ${esc(qty(s.qty, s.recipe.unit))}</span>`).join("");
}

function mealCard(date, slot, meal) {
  if (!meal) return `<div class="card"><div class="slot">${SLOT_LABEL[slot]}</div><div class="empty small">No dish - <button class="btn" data-act="replan-slot" data-date="${date}" data-slot="${slot}">Suggest one</button></div></div>`;
  const r = R(meal.main); if (!r) return "";
  const cl = st.engine.cookList(meal);
  const dn = dayName(date), hh = st.config.household;
  const tags = [];
  if (slot === "lunch" && (hh.lunchbox_days || []).includes(dn)) tags.push(`<span class="chip">Lunchbox</span>`);
  const ad = (r.kitchen_adaptations || [])[0]; if (ad) tags.push(`<span class="chip">${esc(ad.use.split(" - ").pop().split(" (")[0])}</span>`);
  if (r.source === "book") tags.push(`<span class="chip">Book</span>`);
  if (meal.status === "cooked") tags.push(`<span class="chip ok">Cooked</span>`);
  if (meal.status === "skipped") tags.push(`<span class="chip warn">Skipped</span>`);
  const myR = st.ratings.ratings?.[r.id] || {}; const rated = Object.keys(myR).length;
  const rows = st.engine.members.map(m => {
    const p = meal.portions[m.name]; if (!p) return "";
    const parts = [qty(p.main, r.unit), ...p.sides.filter(s => s.qty > 0).map(s => `${qty(s.qty, R(s.id)?.unit)} ${R(s.id)?.title || ""}`)];
    return `<div class="prow"><div><b>${esc(m.name)}</b><div class="small">${esc(parts.join(" · "))}</div>${p.notes.map(n => `<div class="tiny" style="color:var(--warn)">• ${esc(n)}</div>`).join("")}</div>
      <div class="small mute" style="text-align:right;white-space:nowrap">${p.kcal} kcal<br>${Math.round(p.protein)} g P</div></div>`;
  }).join("");
  return `<div class="card status-${meal.status}">
    <div class="slot"><span>${SLOT_LABEL[slot]}${meal.locked ? " · 🔒" : ""}</span><span class="tiny">${meal.by ? "by " + esc(meal.by) : ""}</span></div>
    <div class="dish" data-act="recipe" data-id="${esc(r.id)}">${esc(r.title)}</div>
    <div class="small mute">Cook ${esc(qty(cl.mainQty, r.unit))} for the family${r.approx_minutes ? ` · ~${r.approx_minutes} min` : ""}</div>
    <div class="sides">${sidesChips(meal)}</div>
    <div class="row">${tags.join("")}</div>
    <details class="portions"><summary>Portions for each person</summary>${rows}</details>
    <div class="actions">
      <button class="btn" data-act="swap" data-date="${date}" data-slot="${slot}">Swap</button>
      <button class="btn" data-act="status" data-date="${date}" data-slot="${slot}" data-v="${meal.status === "cooked" ? "planned" : "cooked"}">${meal.status === "cooked" ? "Undo cooked" : "Cooked"}</button>
      <button class="btn" data-act="status" data-date="${date}" data-slot="${slot}" data-v="${meal.status === "skipped" ? "planned" : "skipped"}">${meal.status === "skipped" ? "Undo skip" : "Skip"}</button>
      <button class="btn" data-act="rate" data-id="${esc(r.id)}">Rate${rated ? ` (${rated})` : ""}</button>
      <button class="btn" data-act="portions" data-date="${date}" data-slot="${slot}">Edit portions</button>
      <button class="btn ghost" data-act="lock" data-date="${date}" data-slot="${slot}">${meal.locked ? "Unlock" : "Lock"}</button>
    </div></div>`;
}

function renderToday(v) {
  const d = st.date, day = st.plan.days?.[d];
  let h = dayStrip();
  h += `<div class="spread"><h2>${fmtDate(d)}${(st.config.household.veg_only_days || []).includes(dayName(d)) ? ` <span class="chip ok">Veg day</span>` : ""}</h2>
    <button class="btn" data-act="share" data-date="${d}">Share on WhatsApp</button></div>`;
  if (!day) { v.innerHTML = h + `<div class="empty"><button class="btn pri" data-act="plan-day" data-date="${d}">Plan this day</button></div>`; return; }
  const tot = st.engine.dayTotals(day);
  h += `<div class="card"><div class="totals">` + Object.entries(tot).map(([n, t]) => {
    const pk = Math.min(100, t.kcal / t.target_kcal * 100), pp = Math.min(100, t.protein / t.target_protein * 100);
    return `<div><div class="small"><b>${esc(n)}</b></div><div class="tiny mute">${t.kcal} / ${t.target_kcal} kcal</div><div class="bar ${Math.abs(t.kcal - t.target_kcal) <= t.target_kcal * 0.1 ? "ok" : ""}"><i style="width:${pk}%"></i></div>
      <div class="tiny mute">${t.protein} / ${t.target_protein} g protein</div><div class="bar ${t.protein >= t.target_protein * 0.9 ? "ok" : ""}"><i style="width:${pp}%"></i></div></div>`;
  }).join("") + `</div></div>`;
  for (const s of SLOTS) h += mealCard(d, s, day.meals?.[s]);
  // tonight's prep for the next day
  const nd = addDays(d, 1), tasks = st.engine.prepFor(st.plan, nd), done = st.plan.days?.[nd]?.prepDone || {};
  h += `<div class="card"><div class="slot">Prep this evening (${esc(st.config.household.prep_reminder_time || "")}) for ${fmtDate(nd)}</div>` +
    (tasks.length ? tasks.map((t, i) => `<label class="check ${done[t.text] ? "done" : ""}"><input type="checkbox" data-act="prep" data-date="${nd}" data-k="${esc(t.text)}" ${done[t.text] ? "checked" : ""}><span>${esc(t.text)}</span></label>`).join("")
      : `<div class="small mute">Nothing special - set curd if needed.</div>`) + `</div>`;
  h += `<div class="row" style="margin-top:8px"><button class="btn" data-act="plan-day" data-date="${d}">Re-plan unlocked meals</button></div>`;
  v.innerHTML = h;
}

function renderWeek(v) {
  let h = `<div class="spread"><h2>Next ${CONF.PLAN_DAYS} days</h2><button class="btn" data-act="plan-week">Re-plan unlocked</button></div>`;
  for (let i = 0; i < CONF.PLAN_DAYS; i++) {
    const d = addDays(today(), i), day = st.plan.days?.[d];
    h += `<div class="card" data-act="goto" data-date="${d}"><div class="spread"><b>${fmtDate(d)}</b>${(st.config.household.veg_only_days || []).includes(dayName(d)) ? `<span class="chip ok">Veg</span>` : ""}</div>` +
      SLOTS.map(s => { const m = day?.meals?.[s]; const r = m && R(m.main); return `<div class="small"><span class="mute">${SLOT_LABEL[s]}:</span> ${r ? esc(r.title) : "-"}${m?.status === "cooked" ? " ✓" : ""}</div>`; }).join("") + `</div>`;
  }
  v.innerHTML = h;
}

function renderShop(v) {
  const start = st.date >= today() ? st.date : today();
  const { items, pantry } = st.engine.shopping(st.plan, start, st.shopDays);
  const ck = st.shopping.checked || {};
  let h = `<div class="spread"><h2>Shopping</h2><select data-act="shopdays" style="width:auto">${[1, 2, 3, 5, 7].map(n => `<option value="${n}" ${n === st.shopDays ? "selected" : ""}>${n} day${n > 1 ? "s" : ""}</option>`).join("")}</select></div>
    <div class="small mute">From ${fmtDate(start)} · approximate quantities for the whole family</div>`;
  let cat = "";
  for (const it of items) {
    if (it.cat !== cat) { if (cat) h += `</div>`; cat = it.cat; h += `<div class="card"><div class="slot">${esc(cat)}</div>`; }
    const key = `${start}|${it.item}`;
    h += `<label class="check ${ck[key]?.v ? "done" : ""}"><input type="checkbox" data-act="shopck" data-k="${esc(key)}" ${ck[key]?.v ? "checked" : ""}><span>${esc(it.item)} - <b>${grams(it.item, it.g)}</b></span></label>`;
  }
  if (cat) h += `</div>`;
  if (pantry.length) h += `<div class="card"><div class="slot">Pantry check</div><div class="small">${esc(pantry.slice(0, 60).join(", "))}</div></div>`;
  v.innerHTML = h;
}

function renderRecipes(v) {
  const q = st.recipeQuery.toLowerCase(), f = st.recipeFilter;
  const all = [...st.engine.R.values()].filter(r => r.format !== "side" || r.source !== "everyday" || f === "everyday");
  const list = all.filter(r => (!q || r.title.toLowerCase().includes(q) || (r.ingredients || []).join(" ").toLowerCase().includes(q)) &&
    (f === "all" || (f === "everyday" && r.source === "everyday") || (f === "book" && r.source === "book") || (f === "custom" && r.source === "custom") || (r.slots || []).includes(f)))
    .sort((a, b) => (b.fit ?? 3) - (a.fit ?? 3) || a.title.localeCompare(b.title));
  const chips = ["all", "everyday", "book", "custom", "breakfast", "lunch", "dinner", "snack"];
  v.innerHTML = `<div class="spread"><h2>Recipes <span class="mute small">(${list.length})</span></h2><button class="btn pri" data-act="add-recipe">Add recipe</button></div>
    <input type="text" placeholder="Search dish or ingredient" value="${esc(st.recipeQuery)}" data-act="rq">
    <div class="row" style="margin:8px 0">${chips.map(c => `<button class="btn ${c === f ? "pri" : ""}" data-act="rf" data-v="${c}">${c}</button>`).join("")}</div>
    ${list.slice(0, 80).map(r => { const n = r.nutrition_per_serving; const rt = Object.values(st.ratings.ratings?.[r.id] || {}).map(x => x.v);
      return `<button class="list-btn" data-act="recipe" data-id="${esc(r.id)}"><b>${esc(r.title)}</b>
      <div class="tiny mute">${esc(r.source === "book" ? r.book : r.source)} · ${n.kcal} kcal · ${n.protein_g} g P per ${esc(r.unit || "serving")}${rt.length ? ` · rating ${(rt.reduce((a, b) => a + b, 0) / rt.length).toFixed(1)}` : ""}${r.hard_to_find ? " · hard to find" : ""}</div></button>`; }).join("")}
    ${list.length > 80 ? `<div class="small mute">Showing 80 - refine the search.</div>` : ""}`;
}

function renderSettings(v) {
  const names = (st.config?.members || []).map(m => m.name);
  const lim = { ...(st.config?.household?.weekly_limits || {}), ...(st.prefs.weekly_limits || {}) };
  v.innerHTML = `<h2>Settings</h2>
  <div class="card"><div class="slot">Who is using this phone?</div>
    <select data-act="me"><option value="">-</option>${[...names, "Other"].map(n => `<option ${n === st.me ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
    <div class="tiny mute">Used to label edits and ratings.</div></div>
  <div class="card"><div class="slot">Google Drive (shared family data)</div>
    <label>Google OAuth Client ID</label><input type="text" data-act="clientId" value="${esc(st.clientId)}" placeholder="xxxx.apps.googleusercontent.com">
    <label>Drive folder name</label><input type="text" data-act="folder" value="${esc(st.folderName)}">
    <div class="actions"><button class="btn pri" data-act="connect">${drive.signedIn ? "Sync now" : "Sign in & sync"}</button>
      <button class="btn" data-act="signout">Sign out</button></div>
    <div class="tiny mute">${st.folderId ? "Folder connected." : "Not connected."} Data files found: ${Object.keys(st.fileIds).join(", ") || "none"}</div>
    <label>Load / upload data files (recipes.json, config.json from the laptop)</label>
    <input type="file" accept="application/json,.json" multiple data-act="upload"></div>
  <div class="card"><div class="slot">Claude (optional smart features)</div>
    <label>Anthropic API key (stored only on this phone)</label><input type="password" data-act="apikey" value="${esc(st.apiKey)}" placeholder="sk-ant-...">
    <label>Model</label><div class="row"><select data-act="model" style="flex:1">${st.model ? `<option>${esc(st.model)}</option>` : `<option value="">Load models first</option>`}</select>
      <button class="btn" data-act="models">Load models</button></div>
    <div class="tiny mute">Use a dedicated key with a monthly spend limit. Each request costs a few cents or less.</div></div>
  <div class="card"><div class="slot">Weekly limits (main protein at lunch/dinner)</div>
    ${["fish", "chicken", "mutton", "paneer", "egg_breakfast", "exotic"].map(k => `<div class="spread"><span>${k.replace("_", " ")}</span>
      <span class="stepper"><button data-act="lim" data-k="${k}" data-d="-1">−</button><b>${lim[k] ?? "-"}</b><button data-act="lim" data-k="${k}" data-d="1">+</button></span></div>`).join("")}
    <div class="tiny mute">Applies to new and re-planned meals. Ratings also steer choices.</div></div>
  <div class="card"><div class="slot">Data</div><div class="actions">
    <button class="btn" data-act="plan-week">Re-plan next ${CONF.PLAN_DAYS} days (unlocked)</button>
    <button class="btn" data-act="backup">Download backup</button></div></div>
  <p class="tiny mute">Ghar Ka Menu · v2 · ${st.recipes.length} recipes</p>`;
}

// ---------------- sheets
function sheet(html) { const s = $("#sheet"); s.querySelector(".sheet-body").innerHTML = html; s.hidden = false; }
function closeSheet() { $("#sheet").hidden = true; }

function openRecipe(id) {
  const r = R(id); if (!r) return;
  const n = r.nutrition_per_serving, src = r.nutrition_source || {};
  const rts = st.ratings.ratings?.[id] || {};
  sheet(`<div class="spread"><h3>${esc(r.title)}</h3><button class="btn ghost" data-act="close">Close</button></div>
    <div class="small mute">${esc(r.source === "book" ? `${r.book}, p.${r.page}` : r.source)} · per ${esc(r.portion || r.unit || "serving")}: ${n.kcal} kcal (${esc(src.kcal || "")}), ${n.protein_g} g protein</div>
    <div class="sides">${(r.pairs || []).map(p => `<span class="chip">goes with ${esc(p.replace("_", " / "))}</span>`).join("")}${r.hard_to_find ? `<span class="chip warn">hard to find</span>` : ""}</div>
    ${Object.keys(rts).length ? `<div class="small">Ratings: ${Object.entries(rts).map(([m, x]) => `${esc(m)} ${x.v > 0 ? "Loved" : x.v < 0 ? "Didn't work" : "OK"}`).join(" · ")}</div>` : ""}
    ${(r.prep_ahead || []).length ? `<div class="adapt"><b>Night before:</b> ${esc(r.prep_ahead.join("; "))}</div>` : ""}
    <h3 style="margin-top:12px">Ingredients <span class="small mute">(makes ${r.servings || r.servings_assumed || "?"})</span></h3><ul>${(r.ingredients || []).map(i => `<li>${esc(i)}</li>`).join("")}</ul>
    <h3>Method</h3><ol>${(r.method || []).map(i => `<li>${esc(i)}</li>`).join("")}</ol>
    ${(r.kitchen_adaptations || []).map(a => `<div class="adapt"><b>Your kitchen · step ${esc(a.step)} → ${esc(a.use)}</b><br>${esc(a.how)}</div>`).join("")}
    <div class="actions"><button class="btn" data-act="rate" data-id="${esc(id)}">Rate</button>
      ${["breakfast", "lunch", "snack", "dinner"].filter(s => (r.slots || []).includes(s)).map(s => `<button class="btn" data-act="use" data-id="${esc(id)}" data-slot="${s}">Use for ${s} (${fmtDate(st.date)})</button>`).join("")}</div>`);
}

function openSwap(date, slot) {
  const alts = st.engine.alternatives(st.plan, date, slot, 8, Date.now() % 1000);
  const line = r => `<button class="list-btn" data-act="pick" data-id="${esc(r.id)}" data-date="${date}" data-slot="${slot}"><b>${esc(r.title)}</b>
    <div class="tiny mute">${esc(r.source)} · ${r.nutrition_per_serving.kcal} kcal · ${r.nutrition_per_serving.protein_g} g P · ${esc(r.protein_kind)}</div></button>`;
  sheet(`<div class="spread"><h3>Swap ${SLOT_LABEL[slot].toLowerCase()} · ${fmtDate(date)}</h3><button class="btn ghost" data-act="close">Close</button></div>
    <input type="text" placeholder="Search all suitable dishes…" data-act="swapq" data-date="${date}" data-slot="${slot}">
    <div id="swapres">${alts.map(line).join("") || `<div class="empty">No other dishes fit the rules for this slot.</div>`}</div>
    ${st.apiKey && st.model ? `<label>Ask Claude (e.g. “something light with paneer”)</label><div class="row"><input type="text" id="wish" style="flex:1"><button class="btn pri" data-act="askswap" data-date="${date}" data-slot="${slot}">Ask</button></div><div id="aires"></div>` : `<div class="tiny mute" style="margin-top:8px">Add an Anthropic key in Settings to ask Claude for ideas.</div>`}`);
  openSwap.line = line;
}

function openRate(id) {
  const r = R(id), rts = st.ratings.ratings?.[id] || {};
  sheet(`<div class="spread"><h3>Rate: ${esc(r.title)}</h3><button class="btn ghost" data-act="close">Done</button></div>
    <div class="small mute">How did it go for each person? Dishes everyone marks “Didn't work” stop being suggested.</div>` +
    st.engine.members.map(m => `<div style="margin-top:10px"><b>${esc(m.name)}</b><div class="rate">${RATE.map(([v, l]) =>
      `<button class="btn ${rts[m.name]?.v === v ? "sel" : ""}" data-act="setrate" data-id="${esc(id)}" data-m="${esc(m.name)}" data-v="${v}">${l}</button>`).join("")}</div></div>`).join(""));
}

function openPortions(date, slot) {
  const meal = st.plan.days[date].meals[slot], r = R(meal.main);
  const isCount = u => /^(phulka|bhakri|paratha|idli|dosa|uttapam|chilla|egg|omelette|thepla|sandwich|piece|slice|fruit|papad)$/.test(u || "");
  sheet(`<div class="spread"><h3>Portions · ${esc(r.title)}</h3><button class="btn ghost" data-act="close">Done</button></div>` +
    st.engine.members.map(m => { const p = meal.portions[m.name];
      const items = [{ id: r.id, q: p.main, main: true }, ...p.sides.map(s => ({ id: s.id, q: s.qty }))];
      return `<div class="card"><div class="spread"><b>${esc(m.name)}</b><span class="small mute">${p.kcal} kcal · ${Math.round(p.protein)} g P</span></div>` +
        items.map(it => { const x = R(it.id); const step = isCount(x.unit) ? 1 : 0.25;
          return `<div class="spread small" style="padding:4px 0"><span>${esc(x.title)} <span class="mute">(${esc(x.unit || "serving")})</span></span>
          <span class="stepper"><button data-act="pq" data-date="${date}" data-slot="${slot}" data-m="${esc(m.name)}" data-id="${esc(it.id)}" data-d="${-step}">−</button><b>${frac(it.q)}</b>
          <button data-act="pq" data-date="${date}" data-slot="${slot}" data-m="${esc(m.name)}" data-id="${esc(it.id)}" data-d="${step}">+</button></span></div>`; }).join("") + `</div>`;
    }).join(""));
}

function openAddRecipe() {
  sheet(`<div class="spread"><h3>Add a recipe</h3><button class="btn ghost" data-act="close">Close</button></div>
    <div class="small mute">Paste a recipe (from WhatsApp, a website, or type Mom's version). ${st.apiKey ? "Claude will structure it and estimate nutrition." : "Add an API key in Settings to let Claude structure it; otherwise fill the basics."}</div>
    <label>Recipe text</label><textarea id="rawrec"></textarea>
    ${st.apiKey && st.model ? `<div class="actions"><button class="btn pri" data-act="ai-recipe">Structure with Claude</button></div>` : ""}
    <details ${st.apiKey ? "" : "open"}><summary class="small">Or enter basics manually</summary>
      <label>Title</label><input type="text" id="mt">
      <label>Meal</label><select id="ms"><option value="breakfast">Breakfast</option><option value="lunch,dinner">Lunch / dinner</option><option value="snack">Snack</option></select>
      <label>Type</label><select id="mf"><option value="needs_grain">Curry / dal / sabzi (eaten with roti or rice)</option><option value="complete_meal">One-dish meal (biryani, khichdi, wrap…)</option><option value="breakfast_item">Breakfast item</option><option value="snack">Snack</option></select>
      <label>Diet</label><select id="md"><option>veg</option><option>egg</option><option>nonveg</option></select>
      <label>Per serving: kcal / protein g</label><div class="row"><input type="number" id="mk" style="flex:1" placeholder="kcal"><input type="number" id="mp" style="flex:1" placeholder="protein g"></div>
      <div class="actions"><button class="btn pri" data-act="manual-recipe">Save</button></div></details>
    <div id="recprev"></div>`);
}

function previewRecipe(rec) {
  openAddRecipe.pending = rec;
  $("#recprev").innerHTML = `<div class="card"><b>${esc(rec.title)}</b><div class="small mute">${esc(rec.diet)} · ${esc(rec.format)} · ${esc((rec.slots || []).join(", "))} · ${rec.nutrition_per_serving?.kcal} kcal, ${rec.nutrition_per_serving?.protein_g} g P per ${esc(rec.unit)}</div>
    <div class="small">${(rec.ingredients || []).length} ingredients · ${(rec.method || []).length} steps · goes with ${esc((rec.pairs || []).join(", ") || "nothing extra")}</div>
    <div class="actions"><button class="btn pri" data-act="save-recipe">Save to family recipes</button></div></div>`;
}

async function saveCustom(rec) {
  const id = "custom-" + rec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const full = { servings: 4, unit: "serving", pairs: [], slots: ["lunch", "dinner"], fit: 4, kid: 2, prep_ahead: [], ingredients: [], method: [], ...rec,
    id, source: "custom", book: "Family recipes", protein_kind: rec.protein_kind || guessKind(rec), hard_to_find: false,
    nutrition_source: { kcal: "estimated", protein_g: "estimated" }, by: st.me, updatedAt: Date.now(), shop_per_serving: [], pantry: [] };
  st.custom.recipes = [...(st.custom.recipes || []).filter(r => r.id !== id), full];
  await save("custom"); rebuild(); closeSheet(); toast("Recipe saved - it can now appear in plans"); render();
}
function guessKind(r) { const t = (r.title + " " + (r.ingredients || []).join(" ")).toLowerCase();
  return /fish|prawn|surmai|pomfret|bangda/.test(t) ? "fish" : /mutton|lamb|keema/.test(t) ? "mutton" : /chicken/.test(t) ? "chicken" : /\begg/.test(t) ? "egg" : /paneer/.test(t) ? "paneer" : "veg"; }

function shareText(d) {
  const day = st.plan.days?.[d]; if (!day) return "";
  let t = `*${fmtDate(d)} - Ghar Ka Menu*\n`;
  for (const s of SLOTS) { const m = day.meals?.[s]; if (!m) continue; const r = R(m.main); const cl = st.engine.cookList(m);
    t += `\n*${SLOT_LABEL[s]}:* ${r.title}` + (cl.sides.length ? ` + ${cl.sides.map(x => x.recipe.title).join(", ")}` : "") + (m.status === "skipped" ? " (skipped)" : ""); }
  return t;
}

// ---------------- events
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, d = el.dataset.date, s = el.dataset.slot;
  if (el.closest(".tabs") && el.dataset.tab) { st.tab = el.dataset.tab; render(); return; }
  try {
    switch (a) {
      case "tab": st.tab = el.dataset.tab; render(); break;
      case "date": st.date = d; render(); break;
      case "goto": st.date = d; st.tab = "today"; render(); break;
      case "close": closeSheet(); render(); break;
      case "recipe": openRecipe(el.dataset.id); break;
      case "swap": openSwap(d, s); break;
      case "pick": st.engine.setMain(st.plan, d, s, el.dataset.id, st.me); await save("plan"); closeSheet(); render(); toast("Swapped and locked"); break;
      case "use": st.engine.setMain(st.plan, st.date, s, el.dataset.id, st.me); await save("plan"); closeSheet(); st.tab = "today"; render(); break;
      case "status": { const m = st.plan.days[d].meals[s]; m.status = el.dataset.v; m.updatedAt = Date.now(); m.by = st.me; await save("plan"); render();
        if (m.status === "cooked") { toast("Marked cooked - tap Rate to record how it went"); } break; }
      case "lock": { const m = st.plan.days[d].meals[s]; m.locked = !m.locked; m.updatedAt = Date.now(); await save("plan"); render(); break; }
      case "rate": openRate(el.dataset.id); break;
      case "setrate": { const id = el.dataset.id; st.ratings.ratings[id] = st.ratings.ratings[id] || {};
        st.ratings.ratings[id][el.dataset.m] = { v: +el.dataset.v, by: st.me, at: Date.now() }; await save("ratings"); rebuild(); openRate(id); break; }
      case "portions": openPortions(d, s); break;
      case "pq": { const meal = st.plan.days[d].meals[s], p = meal.portions[el.dataset.m], id = el.dataset.id, dd = +el.dataset.d;
        if (id === meal.main) p.main = Math.max(0, +(p.main + dd).toFixed(2));
        else { const sd = p.sides.find(x => x.id === id); if (sd) sd.qty = Math.max(0, +(sd.qty + dd).toFixed(2)); }
        let k = R(meal.main).nutrition_per_serving.kcal * p.main, pr = R(meal.main).nutrition_per_serving.protein_g * p.main;
        for (const sd of p.sides) { const n = R(sd.id).nutrition_per_serving; k += n.kcal * sd.qty; pr += n.protein_g * sd.qty; }
        p.kcal = Math.round(k); p.protein = Math.round(pr * 10) / 10; meal.updatedAt = Date.now(); meal.by = st.me;
        await save("plan"); openPortions(d, s); break; }
      case "plan-day": st.engine.planDay(st.plan, d, { seed: Date.now() % 997, by: st.me }); await save("plan"); render(); toast("Re-planned (locked and cooked meals kept)"); break;
      case "plan-week": for (let i = 0; i < CONF.PLAN_DAYS; i++) st.engine.planDay(st.plan, addDays(today(), i), { seed: Date.now() % 997, by: st.me }); await save("plan"); st.tab = "week"; render(); toast("Next week re-planned"); break;
      case "replan-slot": { const r = st.engine.planSlot(st.plan, d, s, Date.now() % 997); if (r) { st.engine.setMain(st.plan, d, s, r.id, st.me); await save("plan"); render(); } break; }
      case "share": { const t = shareText(d); if (navigator.share) { try { await navigator.share({ text: t }); } catch { } } else window.open("https://wa.me/?text=" + encodeURIComponent(t)); break; }
      case "rf": st.recipeFilter = el.dataset.v; render(); break;
      case "add-recipe": openAddRecipe(); break;
      case "ai-recipe": { const raw = $("#rawrec").value.trim(); if (!raw) return toast("Paste the recipe text first");
        el.disabled = true; el.textContent = "Thinking…";
        try { previewRecipe(await AI.structureRecipe({ key: st.apiKey, model: st.model, cfg: st.config, raw })); }
        finally { el.disabled = false; el.textContent = "Structure with Claude"; } break; }
      case "save-recipe": await saveCustom(openAddRecipe.pending); break;
      case "manual-recipe": { const t = $("#mt").value.trim(); if (!t) return toast("Give it a title");
        await saveCustom({ title: t, slots: $("#ms").value.split(","), format: $("#mf").value, diet: $("#md").value,
          nutrition_per_serving: { kcal: +$("#mk").value || 250, protein_g: +$("#mp").value || 8 }, ingredients: $("#rawrec").value.split("\n").filter(Boolean), method: [] }); break; }
      case "askswap": { const out = $("#aires"); out.innerHTML = `<div class="small mute">Asking Claude…</div>`;
        const cands = st.engine.candidates(st.plan, d, s, { ignoreLimits: false });
        const picks = await AI.suggestSwap({ key: st.apiKey, model: st.model, cfg: st.config, slot: s, date: d, wish: $("#wish").value, candidates: cands });
        out.innerHTML = picks.filter(p => R(p.id)).map(p => openSwap.line(R(p.id)).replace("</b>", `</b><div class="tiny">${esc(p.why)}</div>`)).join("") || `<div class="small mute">No suitable picks.</div>`; break; }
      case "connect": drive = new Drive(st.clientId); await pull(true); render(); break;
      case "signout": drive.signOut(); st.folderId = ""; S.ls("gkm.folderId", null); setSync("", "Signed out"); render(); break;
      case "models": { if (!st.apiKey) return toast("Enter the API key first"); const ms = await AI.listModels(st.apiKey);
        const sel = document.querySelector('[data-act="model"]'); sel.innerHTML = ms.map(m => `<option value="${esc(m.id)}" ${m.id === st.model ? "selected" : ""}>${esc(m.name)}</option>`).join("");
        if (!st.model && ms[0]) { st.model = ms[0].id; S.ls("gkm.model", st.model); } toast(`${ms.length} models available`); break; }
      case "lim": { const k = el.dataset.k; const base = { ...(st.config.household.weekly_limits || {}), ...(st.prefs.weekly_limits || {}) };
        st.prefs.weekly_limits = { ...(st.prefs.weekly_limits || {}), [k]: Math.max(0, (base[k] ?? 0) + +el.dataset.d) };
        await save("prefs"); rebuild(); render(); break; }
      case "backup": { const blob = new Blob([JSON.stringify({ plan: st.plan, ratings: st.ratings, custom: st.custom, prefs: st.prefs }, null, 1)], { type: "application/json" });
        const u = URL.createObjectURL(blob); const l = document.createElement("a"); l.href = u; l.download = `ghar-ka-menu-backup-${today()}.json`; l.click(); break; }
      case "syncbtn": await pull(true); break;
    }
  } catch (err) { console.error(err); toast(err.message || String(err), 5000); }
});
document.addEventListener("change", async e => {
  const el = e.target, a = el.dataset.act; if (!a) return;
  if (a === "prep") { const day = st.plan.days[el.dataset.date] = st.plan.days[el.dataset.date] || { meals: {} };
    day.prepDone = { ...(day.prepDone || {}), [el.dataset.k]: el.checked }; day.updatedAt = Date.now(); await save("plan"); render(); }
  if (a === "shopck") { st.shopping.checked[el.dataset.k] = { v: el.checked, at: Date.now() }; await save("shopping"); render(); }
  if (a === "shopdays") { st.shopDays = +el.value; render(); }
  if (a === "me") { st.me = el.value; S.ls("gkm.me", st.me); }
  if (a === "clientId") { st.clientId = el.value.trim(); S.ls("gkm.clientId", st.clientId); drive = new Drive(st.clientId); }
  if (a === "folder") { st.folderName = el.value.trim() || CONF.DRIVE_FOLDER; S.ls("gkm.folder", st.folderName); st.folderId = ""; S.ls("gkm.folderId", null); }
  if (a === "apikey") { st.apiKey = el.value.trim(); S.ls("gkm.apiKey", st.apiKey || null); }
  if (a === "model") { st.model = el.value; S.ls("gkm.model", st.model); }
  if (a === "upload") { await uploadDataFiles([...el.files]); }
});
document.addEventListener("input", e => {
  const el = e.target, a = el.dataset.act;
  if (a === "rq") { st.recipeQuery = el.value; clearTimeout(el._t); el._t = setTimeout(() => { render(); const i = $('[data-act="rq"]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); }
  if (a === "swapq") { const q = el.value.toLowerCase(); const list = st.engine.candidates(st.plan, el.dataset.date, el.dataset.slot, { ignoreLimits: true })
      .filter(r => !q || r.title.toLowerCase().includes(q)).slice(0, 25);
    $("#swapres").innerHTML = list.map(openSwap.line).join("") || `<div class="empty small">No match.</div>`; }
});
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") { closeSheet(); render(); } });
$("#syncBtn").addEventListener("click", () => pull(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden && drive.signedIn) pull(false); });

// ---------------- boot
(async function boot() {
  for (const k of Object.keys(FILES)) { const v = await S.get(k); if (v) st[k] = v; }
  if (!Array.isArray(st.recipes)) st.recipes = st.recipes?.recipes || [];
  st.ratings.ratings = st.ratings.ratings || {}; st.shopping.checked = st.shopping.checked || {};
  rebuild(); ensurePlan(); render();
  setSync("", drive.signedIn ? "Signed in" : "Offline / not signed in");
  if (drive.signedIn) pull(false);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
})();
