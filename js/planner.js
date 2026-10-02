// planner.js - Family meal planning engine (runs on the phone; also testable in Node).
// Pure functions: no network, no DOM. All nutrition maths lives here.

export const SLOTS = ["breakfast", "lunch", "snack", "dinner"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ADDED_SUGAR = /\bsugar\b(?![- ]free)|brown sugar|jaggery|\bgur\b|honey|syrup|agave|condensed milk|chocolate|nutella|sweetened|ketchup|candied|\bjam\b/i;
const CHOL_HEAVY = /butter(?!milk)|\bghee\b|cream(?! cheese)|malai|egg yolks?/i;
const LUNCHBOX_BAD = /soup|shorba|rasam|smoothie|juice|drink|stew|kadhi/i;
const COUNT_UNITS = new Set(["phulka", "bhakri", "paratha", "idli", "dosa", "uttapam", "chilla", "egg", "omelette", "thepla", "sandwich", "piece", "slice", "fruit", "papad", "glass", "cup", "2 whites", "4 pieces"]);

// Accompaniment code -> preferred side recipe ids (first found wins)
const SIDE_PREF = {
  phulka: ["bau-phulka"], rice: ["bau-steamed-rice"], paratha: ["bau-plain-paratha"], dal: ["bau-plain-dal-toor-moong"],
  curd_raita: ["bau-curd-dahi", "bau-cucumber-raita"], salad: ["bau-kachumber-salad"], fruit: ["bau-seasonal-fruit"],
  chutney: ["bau-green-chutney", "bau-coconut-chutney"], sambar: ["bau-sambar"], bread_toast: ["bau-brown-bread-toast"],
  milk_tea: ["bau-glass-of-milk-no-sugar"],
};
// Always-allowed protein/balance add-ons per slot (on top of the dish's own pairs)
const SLOT_ADDONS = {
  breakfast: ["milk_tea", "fruit", "egg_whites", "boiled_egg", "curd_raita"],
  lunch: ["curd_raita", "salad"], dinner: ["curd_raita", "salad"],
  snack: ["fruit", "buttermilk", "roasted_chana", "nuts"],
};
const ADDON_IDS = { egg_whites: "bau-boiled-egg-whites", boiled_egg: "bau-boiled-egg", buttermilk: "bau-buttermilk-chaas",
  roasted_chana: "bau-roasted-chana", nuts: "bau-mixed-nuts" };

export function isoDate(d) { const z = new Date(d); z.setMinutes(z.getMinutes() - z.getTimezoneOffset()); return z.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDate(d); }
export function dayName(iso) { return DAYS[new Date(iso + "T12:00:00").getDay()]; }

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function createEngine(recipeList, config, opts = {}) {
  const R = new Map(recipeList.map(r => [r.id, r]));
  const hh = config.household || {};
  const limits = { ...(hh.weekly_limits || {}), ...((opts.prefs || {}).weekly_limits || {}) };
  const members = config.members;
  const strictSugar = members.some(m => ["none", "low"].includes((m.constraints || {}).added_sugar));
  const cholMember = members.find(m => (m.constraints || {}).cholesterol === "limit");
  const excl = [...(hh.exclude_ingredients || []), ...members.flatMap(m => m.excludes || []), ...((opts.prefs || {}).exclude || [])].map(e => new RegExp("\\b" + e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"));
  const ratings = opts.ratings || {};
  const sideOf = code => { for (const id of SIDE_PREF[code] || []) if (R.has(id)) return R.get(id); return recipeList.find(r => r.side_code === code); };
  const addonOf = code => SIDE_PREF[code] ? sideOf(code) : R.get(ADDON_IDS[code]);
  const text = r => (r.title + " | " + (r.ingredients || []).join(" | "));

  function ratingScore(id) {
    const rs = ratings[id]; if (!rs) return 0;
    const vals = Object.values(rs).map(x => x.v);
    if (!vals.length) return 0;
    if (vals.every(v => v < 0)) return -99;           // everyone disliked -> never auto-pick
    return vals.reduce((a, b) => a + b, 0) / vals.length * 1.6;
  }

  function slotsOf(r) {
    if (r.slots && r.slots.length) return r.slots;
    const mt = (r.meal_types || ["main"])[0];
    return { breakfast: ["breakfast"], snack: ["snack"], drink: ["snack"], main: ["lunch", "dinner"], salad: ["lunch", "snack"], soup: ["dinner"] }[mt] || [];
  }

  function baseOk(r) {
    const n = r.nutrition_per_serving || {};
    if (!n.kcal || n.protein_g == null) return false;
    if (r.kitchen_fit === "not_possible") return false;
    const t = text(r);
    if (excl.some(rx => rx.test(t))) return false;
    if (strictSugar && ADDED_SUGAR.test(t)) return false;
    if ((opts.prefs || {}).blocked && opts.prefs.blocked.includes(r.id)) return false;
    return ratingScore(r.id) > -50;
  }

  // Count usage in the 7-day window ending at `date` (excluding the slot being re-planned)
  function windowCounts(plan, date, skip) {
    const c = { fish: 0, chicken: 0, mutton: 0, paneer: 0, egg_breakfast: 0, exotic: 0, recent: new Map(), books: 0 };
    for (let i = -6; i <= 6; i++) {
      const d = addDays(date, i), day = plan.days?.[d]; if (!day) continue;
      for (const s of SLOTS) {
        const m = day.meals?.[s]; if (!m || !m.main || (skip && skip.date === d && skip.slot === s)) continue;
        const r = R.get(m.main); if (!r) continue;
        if (Math.abs(i) <= 6) c.recent.set(r.id, Math.min(c.recent.get(r.id) ?? 99, Math.abs(i)));
        if (i > 0 || i < -6) continue;      // limits look back over the last 7 days incl. today
        if (s === "lunch" || s === "dinner") { if (r.protein_kind in c) c[r.protein_kind]++; }
        if (s === "breakfast" && r.protein_kind === "egg") c.egg_breakfast++;
        if (r.hard_to_find) c.exotic++;
      }
    }
    return c;
  }

  function candidates(plan, date, slot, { ignoreLimits = false } = {}) {
    const dn = dayName(date), weekend = dn === "Saturday" || dn === "Sunday";
    const vegDay = (hh.veg_only_days || []).includes(dn);
    const lunchbox = slot === "lunch" && (hh.lunchbox_days || []).includes(dn);
    const lim = weekend ? hh.max_minutes_weekend ?? 999 : hh.max_minutes_weekday ?? 999;
    const wc = windowCounts(plan, date, { date, slot });
    const okFormats = { breakfast: ["breakfast_item", "complete_meal"], lunch: ["needs_grain", "complete_meal"],
      dinner: ["needs_grain", "complete_meal"], snack: ["snack", "drink"] }[slot];
    return recipeList.filter(r => {
      if (!baseOk(r) || !okFormats.includes(r.format) || !slotsOf(r).includes(slot)) return false;
      if (r.source === "everyday" && r.format === "side") return false;
      if (r.approx_minutes && r.approx_minutes > lim) return false;
      if (vegDay && (r.diet === "nonveg" || (r.diet === "egg" && !hh.egg_allowed_on_veg_days))) return false;
      if (lunchbox && LUNCHBOX_BAD.test(r.title)) return false;
      if ((wc.recent.get(r.id) ?? 99) < (hh.no_repeat_within_days ?? 7) && !(r.source === "everyday" && slot === "breakfast" && wc.recent.get(r.id) >= 4)) return false;
      if (ignoreLimits) return true;
      const k = r.protein_kind;
      if ((slot === "lunch" || slot === "dinner") && k in limits && wc[k] >= limits[k]) return false;
      if (slot === "breakfast" && k === "egg" && limits.egg_breakfast != null && wc.egg_breakfast >= limits.egg_breakfast) return false;
      if (r.hard_to_find && limits.exotic != null && wc.exotic >= limits.exotic) return false;
      if ((slot === "breakfast" || slot === "snack") && r.diet === "nonveg" && r.protein_kind !== "egg") return false;
      return true;
    });
  }

  function score(r, slot, dayPicks, rng) {
    const n = r.nutrition_per_serving; let s = 0;
    s += (r.fit ?? 3) * 0.7;
    s += ratingScore(r.id);
    s += Math.min(n.protein_g * 100 / Math.max(n.kcal, 1), 12) * 0.22;
    if (r.source === "everyday") s += 0.5;
    const books = dayPicks.filter(x => x.source === "book").length;
    if (r.source === "book" && books >= 2) s -= 2;
    if (r.source === "book" && books === 0 && slot !== "breakfast") s += 1.0;     // at least one recipe-book dish a day for variety
    s += ((r.kid ?? 2) - 2) * 0.4;
    if (r.hard_to_find) s -= 1.5;
    if (cholMember && CHOL_HEAVY.test(text(r))) s -= 0.8;
    if (n.fat_g != null && n.fat_g * 9 / Math.max(n.kcal, 1) > 0.38) s -= 1;
    if (r.kitchen_fit === "adapted") s -= 0.2;
    if (dayPicks.some(x => x.protein_kind === r.protein_kind && r.protein_kind !== "veg")) s -= 1.5;
    if (dayPicks.some(x => x.main_protein && x.main_protein === r.main_protein)) s -= 0.6;
    return s + rng() * 1.2;
  }

  // ---------- portions ----------
  function unitOptions(r, slot) {
    const u = (r.unit || "").toLowerCase();
    if (COUNT_UNITS.has(u)) {
      const max = u === "idli" ? 6 : u === "piece" ? 6 : u === "phulka" ? 5 : ["dosa", "chilla", "uttapam", "paratha", "thepla", "egg"].includes(u) ? 4 : 2;
      return Array.from({ length: max }, (_, i) => i + 1);
    }
    return slot === "snack" ? [0.5, 0.75, 1, 1.5, 2] : [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5];
  }

  function sideChoices(main, slot, dn, member) {
    const vegDay = (hh.veg_only_days || []).includes(dn);
    const cons = member.constraints || {};
    const codes = new Set([...(main.pairs || []), ...(SLOT_ADDONS[slot] || [])]);
    if (main.format === "needs_grain" && !["phulka", "rice", "paratha", "bread_toast"].some(c => codes.has(c))) codes.add("phulka");
    const out = [];
    for (const code of codes) {
      const r = addonOf(code); if (!r || !baseOk(r)) continue;
      if (vegDay && r.diet === "egg" && !hh.egg_allowed_on_veg_days) continue;
      if (code === "boiled_egg" && cons.cholesterol === "limit") continue;
      if (main.protein_kind === "egg" && (code === "boiled_egg" || code === "egg_whites")) continue;
      let qty;
      if (code === "phulka") qty = [0, 1, 2, 3, 4, 5];
      else if (code === "paratha") qty = [0, 1, 2];
      else if (code === "rice") qty = [0, 0.5, 1, 1.5];
      else if (code === "chutney") qty = [1];
      else if (code === "fruit" || code === "egg_whites" || code === "bread_toast") qty = [0, 1, 2];
      else if (code === "sambar") qty = [0, 1, 1.5];
      else qty = [0, 1];
      out.push({ code, r, qty, grain: ["phulka", "rice", "paratha", "bread_toast"].includes(code) });
    }
    return out;
  }

  function portionFor(member, slot, main, date) {
    const tgt = member.per_meal_targets[slot]; const kt = tgt.kcal, pt = tgt.protein_g;
    const cons = member.constraints || {}; const child = (member.age ?? 30) < 18;
    const dn = dayName(date);
    const sides = sideChoices(main, slot, dn, member);
    const mn = main.nutrition_per_serving; const mf = mn.fat_g ?? mn.kcal * 0.3 / 9;
    const needGrain = main.format === "needs_grain";
    let best = null;
    const mainOpts = unitOptions(main, slot);
    // enumerate side quantity combinations (bounded)
    const combos = [[]];
    for (const sd of sides) {
      const next = [];
      for (const c of combos) for (const q of sd.qty) next.push(q ? [...c, [sd, q]] : c);
      combos.length = 0; combos.push(...next.slice(0, 6000));
    }
    for (const mq of mainOpts) {
      for (const combo of combos) {
        const grains = combo.filter(([sd]) => sd.grain);
        if (needGrain && !grains.length) continue;
        if (grains.length > 1 && !(grains.length === 2 && grains.some(([sd]) => sd.code === "rice"))) continue;
        let k = mn.kcal * mq, p = mn.protein_g * mq, f = mf * mq, items = 0;
        for (const [sd, q] of combo) { const n = sd.r.nutrition_per_serving; k += n.kcal * q; p += n.protein_g * q; f += (n.fat_g ?? 0) * q; items += q; }
        let cost = 1.5 * Math.abs(k - kt) / kt + 1.6 * Math.max(0, pt - p) / Math.max(pt, 1) + 0.25 * Math.max(0, p - 1.5 * pt) / Math.max(pt, 1);
        if (cons.fat_pct_max) cost += 2 * Math.max(0, f * 9 / Math.max(k, 1) - cons.fat_pct_max / 100);
        if ((slot === "lunch" || slot === "dinner") && mn.kcal * mq < 0.3 * k) cost += 0.4;     // keep the dish the hero of the plate
        cost += 0.02 * items + (child && mq < 0.75 ? 0.15 : 0);
        if (!best || cost < best.cost) best = { cost, mq, combo, k, p, f };
      }
    }
    return {
      main: best.mq,
      sides: best.combo.map(([sd, q]) => ({ id: sd.r.id, code: sd.code, qty: q })),
      kcal: Math.round(best.k), protein: Math.round(best.p * 10) / 10, fat: Math.round(best.f * 10) / 10,
      notes: memberNotes(member, main),
    };
  }

  function memberNotes(member, r) {
    const c = member.constraints || {}, t = text(r), notes = [];
    if (c.cholesterol === "limit") {
      if (r.protein_kind === "egg") notes.push("max 1 whole egg; rest egg whites");
      if (/butter(?!milk)|\bghee\b|cream|malai/i.test(t)) notes.push("serve before adding ghee/butter/cream");
    }
    if (c.added_sugar === "none" && /sweet|kheer|halwa|ladoo/i.test(r.title)) notes.push("no sweet portion");
    if (c.fat_pct_max && c.fat_pct_max <= 25 && /\bfry\b|fried|butter(?!milk)|cream/i.test(t)) notes.push("lighter oil in his portion");
    return notes;
  }

  function buildMeal(date, slot, main, extra = {}) {
    const portions = {};
    for (const m of members) portions[m.name] = portionFor(m, slot, main, date);
    const sideIds = [...new Set(Object.values(portions).flatMap(p => p.sides.filter(s => s.qty > 0).map(s => s.id)))];
    return { main: main.id, sides: sideIds, portions, locked: false, status: "planned", ...extra };
  }

  // ---------- public API ----------
  function planSlot(plan, date, slot, seed = 0) {
    const rng = mulberry32(hashStr(date + slot + seed));
    const day = plan.days?.[date] || { meals: {} };
    const dayPicks = SLOTS.filter(s => s !== slot && day.meals?.[s]?.main).map(s => R.get(day.meals[s].main)).filter(Boolean);
    let cands = candidates(plan, date, slot);
    if (!cands.length) cands = candidates(plan, date, slot, { ignoreLimits: true });
    if (!cands.length) return null;
    let best = null, bs = -1e9;
    for (const r of cands) { const s = score(r, slot, dayPicks, rng); if (s > bs) { bs = s; best = r; } }
    return best;
  }

  function planDay(plan, date, { seed = 0, keepLocked = true, by = "" } = {}) {
    plan.days = plan.days || {};
    const day = plan.days[date] || { meals: {} };
    plan.days[date] = day;
    for (const slot of ["lunch", "dinner", "breakfast", "snack"]) {
      const cur = day.meals[slot];
      if (keepLocked && cur && (cur.locked || cur.status === "cooked")) continue;
      delete day.meals[slot];
      const r = planSlot(plan, date, slot, seed);
      if (r) day.meals[slot] = buildMeal(date, slot, r, { by, updatedAt: Date.now() });
    }
    day.updatedAt = Date.now();
    return day;
  }

  function planRange(plan, start, nDays, opts2 = {}) {
    for (let i = 0; i < nDays; i++) {
      const d = addDays(start, i);
      if (opts2.onlyMissing && plan.days?.[d] && SLOTS.every(s => plan.days[d].meals?.[s])) continue;
      planDay(plan, d, opts2);
    }
    return plan;
  }

  function alternatives(plan, date, slot, n = 8, seed = 1) {
    const rng = mulberry32(hashStr(date + slot + "alt" + seed));
    const day = plan.days?.[date] || { meals: {} };
    const dayPicks = SLOTS.filter(s => s !== slot && day.meals?.[s]?.main).map(s => R.get(day.meals[s].main)).filter(Boolean);
    const cur = day.meals?.[slot]?.main;
    return candidates(plan, date, slot).filter(r => r.id !== cur)
      .map(r => ({ r, s: score(r, slot, dayPicks, rng) })).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.r);
  }

  function setMain(plan, date, slot, recipeId, by = "") {
    const r = R.get(recipeId); if (!r) throw new Error("unknown recipe " + recipeId);
    plan.days[date] = plan.days[date] || { meals: {} };
    const prev = plan.days[date].meals[slot] || {};
    plan.days[date].meals[slot] = buildMeal(date, slot, r, { locked: true, by, updatedAt: Date.now(), status: prev.status === "cooked" ? "planned" : prev.status || "planned" });
    plan.days[date].updatedAt = Date.now();
    return plan.days[date].meals[slot];
  }

  function dayTotals(day) {
    const t = {};
    for (const m of members) t[m.name] = { kcal: 0, protein: 0, target_kcal: m.daily_targets.kcal, target_protein: m.daily_targets.protein_g };
    for (const s of SLOTS) { const meal = day?.meals?.[s]; if (!meal || meal.status === "skipped") continue;
      for (const m of members) { const p = meal.portions?.[m.name]; if (p) { t[m.name].kcal += p.kcal; t[m.name].protein += p.protein; } } }
    for (const k in t) t[k].protein = Math.round(t[k].protein);
    return t;
  }

  // Cooking quantities for the family: main servings + side units (sum over members)
  function cookList(meal) {
    const r = R.get(meal.main); const total = { main: 0, sides: {} };
    for (const p of Object.values(meal.portions || {})) {
      total.main += p.main;
      for (const s of p.sides) total.sides[s.id] = (total.sides[s.id] || 0) + s.qty;
    }
    return { recipe: r, mainQty: Math.round(total.main * 100) / 100, sides: Object.entries(total.sides).filter(([, q]) => q > 0).map(([id, q]) => ({ recipe: R.get(id), qty: q })) };
  }

  function prepFor(plan, date) {          // tasks to do the evening before `date`
    const day = plan.days?.[date]; if (!day) return [];
    const tasks = [];
    for (const s of SLOTS) {
      const meal = day.meals?.[s]; if (!meal) continue;
      const all = [meal.main, ...(meal.sides || [])].map(id => R.get(id)).filter(Boolean);
      for (const r of all) for (const t of r.prep_ahead || []) tasks.push({ text: `${r.title}: ${t}`, slot: s });
      const r = R.get(meal.main);
      if (r && (s === "breakfast" || s === "lunch") && !["Saturday", "Sunday"].includes(dayName(date)) && (r.approx_minutes || 0) >= 25)
        tasks.push({ text: `${r.title}: chop vegetables / make masala or dough tonight`, slot: s });
      const ad = (r?.kitchen_adaptations || []).find(a => /Convection|Grill|Slim Fry/.test(a.use));
      if (ad) tasks.push({ text: `${r.title}: microwave ${ad.use.split(" - ").pop()} - keep rack/dish ready`, slot: s });
    }
    const seen = new Set(); return tasks.filter(t => !seen.has(t.text) && seen.add(t.text));
  }

  function shopping(plan, start, nDays) {
    const agg = new Map(), pantry = new Set();
    for (let i = 0; i < nDays; i++) {
      const day = plan.days?.[addDays(start, i)]; if (!day) continue;
      for (const s of SLOTS) {
        const meal = day.meals?.[s]; if (!meal || meal.status === "skipped") continue;
        const cl = cookList(meal);
        const add = (r, q) => { if (!r) return; for (const it of r.shop_per_serving || []) {
          const k = it.item; const cur = agg.get(k) || { item: k, cat: it.cat, g: 0 }; cur.g += it.g * q; agg.set(k, cur); }
          for (const p of r.pantry || []) pantry.add(p); };
        add(cl.recipe, cl.mainQty);
        for (const sd of cl.sides) add(sd.recipe, sd.qty * ((sd.recipe.servings || 4) ? 1 : 1));
      }
    }
    return { items: [...agg.values()].filter(x => x.g >= 5).sort((a, b) => a.cat.localeCompare(b.cat) || a.item.localeCompare(b.item)), pantry: [...pantry].sort() };
  }

  return { R, members, candidates, planSlot, planDay, planRange, alternatives, setMain, dayTotals, cookList, prepFor, shopping, buildMeal, limits };
}

export function fmtQty(q, unit) {
  const u = unit || "serving";
  const n = Number.isInteger(q) ? String(q) : q === 0.5 ? "½" : q === 0.25 ? "¼" : q === 0.75 ? "¾" : q === 1.5 ? "1½" : q === 2.5 ? "2½" : q === 1.25 ? "1¼" : String(q);
  return `${n} ${u}`;
}
