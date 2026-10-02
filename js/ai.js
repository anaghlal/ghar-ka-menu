// ai.js - optional Claude features, called directly from the phone with the family's own API key.
const URL_ = "https://api.anthropic.com/v1";
const H = key => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
  "anthropic-dangerous-direct-browser-access": "true" });

export async function listModels(key) {
  const r = await fetch(`${URL_}/models?limit=50`, { headers: H(key) });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data.map(m => ({ id: m.id, name: m.display_name || m.id }));
}

export async function ask({ key, model, system, prompt, maxTokens = 1500 }) {
  const r = await fetch(`${URL_}/messages`, { method: "POST", headers: H(key),
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.content.filter(c => c.type === "text").map(c => c.text).join("");
}

export function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); const s = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(s);
}

const FAMILY_CTX = cfg => `Indian family of four in Navi Mumbai. Members: ${cfg.members.map(m => `${m.name} (${m.age}, ${m.daily_targets.kcal} kcal, ${m.daily_targets.protein_g} g protein/day; ${JSON.stringify(m.constraints || {})})`).join("; ")}. ` +
  `Household rules: ${JSON.stringify({ veg_days: cfg.household.veg_only_days, limits: cfg.household.weekly_limits, excludes: cfg.household.exclude_ingredients })}. ` +
  `Kitchen: gas hob, pressure cooker, ${cfg.kitchen?.microwave || "convection microwave"} (modes ${(cfg.kitchen?.modes || []).join(", ")}); no conventional oven, no air fryer.`;

export async function suggestSwap({ key, model, cfg, slot, date, wish, candidates }) {
  const list = candidates.slice(0, 90).map(r => `${r.id}|${r.title}|${r.format}|${r.nutrition_per_serving.kcal}kcal|${r.nutrition_per_serving.protein_g}gP|${r.protein_kind}`).join("\n");
  const text = await ask({ key, model, maxTokens: 700,
    system: "You help an Indian family choose a home meal. Pick only from the given candidate ids. Reply with JSON only.",
    prompt: `${FAMILY_CTX(cfg)}\nMeal: ${slot} on ${date}. Request: "${wish || "something different that the family will enjoy"}".\nCandidates (id|title|format|kcal/serving|protein|protein kind):\n${list}\n\nReturn {"picks":[{"id":"...","why":"<12 words>"}]} with up to 3 picks, best first.` });
  return parseJson(text).picks || [];
}

export async function structureRecipe({ key, model, cfg, raw }) {
  const text = await ask({ key, model, maxTokens: 2500,
    system: "You convert recipe text into strict JSON for a family meal-planning app. Estimate nutrition per ONE serving/unit using Indian food composition values (IFCT). Reply with JSON only.",
    prompt: `${FAMILY_CTX(cfg)}\nRecipe text:\n"""${raw.slice(0, 6000)}"""\n\nReturn JSON with keys: title, diet (veg|egg|nonveg), format (complete_meal|needs_grain|breakfast_item|snack|drink|side|soup|sweet), slots (array of breakfast|lunch|dinner|snack), pairs (array from phulka|rice|paratha|dal|curd_raita|salad|fruit|chutney|sambar|bread_toast|milk_tea - what it is normally eaten with; empty if complete), unit (e.g. katori, plate, phulka, piece, bowl), portion (text), servings (number the ingredients make), nutrition_per_serving {kcal, protein_g, carbs_g, fat_g} per ONE unit, approx_minutes, prep_ahead (array of night-before tasks), ingredients (array of strings), method (array of short steps; use the gas hob/pressure cooker/microwave modes - no oven or air fryer), fit (1-5 for this family), kid (1-3).` });
  return parseJson(text);
}
