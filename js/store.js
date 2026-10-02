// store.js - tiny IndexedDB key-value cache (works offline) + merge helpers for shared state.
const DB = "ghar-ka-menu", ST = "kv";
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function get(k) {
  try { const d = await db(); return await new Promise((res, rej) => { const t = d.transaction(ST).objectStore(ST).get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
  catch { return undefined; }
}
export async function set(k, v) {
  try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction(ST, "readwrite"); t.objectStore(ST).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  catch (e) { console.warn("cache write failed", e); }
}
export function ls(k, v) {                       // small per-phone settings (API key, member, folder id)
  try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
  catch { return null; }
}

// ---- merge rules (last writer wins per small unit, so two phones rarely clobber each other)
const ts = x => (x && (x.updatedAt || x.at)) || 0;
export function mergePlan(a = {}, b = {}) {
  const out = { version: 1, days: {} };
  const days = new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})]);
  for (const d of days) {
    const A = a.days?.[d] || { meals: {} }, B = b.days?.[d] || { meals: {} };
    const meals = {};
    for (const s of new Set([...Object.keys(A.meals || {}), ...Object.keys(B.meals || {})]))
      meals[s] = ts(A.meals?.[s]) >= ts(B.meals?.[s]) ? A.meals?.[s] ?? B.meals?.[s] : B.meals?.[s];
    const prep = { ...(B.prepDone || {}), ...(A.prepDone || {}) };
    out.days[d] = { meals, prepDone: prep, updatedAt: Math.max(ts(A), ts(B)) };
  }
  return out;
}
export function mergeRatings(a = {}, b = {}) {
  const out = { version: 1, ratings: {} };
  for (const src of [b.ratings || {}, a.ratings || {}])
    for (const [rid, byM] of Object.entries(src))
      for (const [m, v] of Object.entries(byM)) {
        out.ratings[rid] = out.ratings[rid] || {};
        if (!out.ratings[rid][m] || ts(v) >= ts(out.ratings[rid][m])) out.ratings[rid][m] = v;
      }
  return out;
}
export function mergeById(a = {}, b = {}, key = "recipes") {
  const m = new Map();
  for (const x of [...(b[key] || []), ...(a[key] || [])]) if (!m.has(x.id) || ts(x) >= ts(m.get(x.id))) m.set(x.id, x);
  return { version: 1, [key]: [...m.values()] };
}
export function mergeMap(a = {}, b = {}, key = "checked") {
  const out = { ...(b[key] || {}) };
  for (const [k, v] of Object.entries(a[key] || {})) if (!out[k] || ts(v) >= ts(out[k])) out[k] = v;
  return { version: 1, [key]: out };
}
export const newer = (a = {}, b = {}) => (ts(a) >= ts(b) ? a : b);
