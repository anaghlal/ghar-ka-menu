# Ghar Ka Menu – setup (one time, ~30 min)

The app is a web app you install on Android from Chrome. The **code** sits on GitHub Pages (public, no data).
The **family data** (recipes, targets, plan, ratings) lives as JSON files in one **Google Drive folder** shared between
Anagh and Abhilasha. Planning runs on the phone. Claude features use your own Anthropic API key, stored only on each phone.

## 1. Google Cloud – allow the app to use Drive (10 min)
1. Go to https://console.cloud.google.com → create project **ghar-ka-menu**.
2. *APIs & Services → Library* → enable **Google Drive API**.
3. *APIs & Services → OAuth consent screen* → User type **External** → app name "Ghar Ka Menu", your email →
   Scopes: add `.../auth/drive` → **Test users: add Anagh's and Abhilasha's Gmail addresses**. Leave it in *Testing*.
4. *Credentials → Create credentials → OAuth client ID* → **Web application** →
   Authorized JavaScript origins: `https://<your-github-username>.github.io` → Create → copy the **Client ID**.
5. Paste it into `js/config.js` (`GOOGLE_CLIENT_ID: "…apps.googleusercontent.com"`).
   (Because the app is in Testing mode, Google shows an "unverified app" screen – tap *Continue*. Only test users can sign in.)

## 2. GitHub Pages – host the app code (10 min)
1. Create a GitHub account if needed, then a **public** repo named `ghar-ka-menu`.
2. Upload everything in this `app` folder **except `data/`** (it is in .gitignore) – via `git push` or the web "Upload files" button.
3. Repo *Settings → Pages* → Source: *Deploy from a branch* → `main` / root → Save.
4. After ~1 min the app is at `https://<username>.github.io/ghar-ka-menu/`.

## 3. Shared Drive folder + data (5 min)
1. On the laptop, rebuild the data whenever recipes change:
   `python scripts\build_recipes.py` then `python scripts\export_app_data.py` → creates `app\data\recipes.json` and `app\data\config.json`.
2. Open the app URL in Chrome on the laptop → *Settings* → paste nothing else, tap **Sign in & sync** (creates folder `GharKaMenu` in your Drive).
3. In *Settings → Load / upload data files* pick `app\data\recipes.json` and `app\data\config.json` – they are uploaded to the folder.
4. In Google Drive, **share the `GharKaMenu` folder with Abhilasha as Editor**. (Son 1 gets the menu via the WhatsApp share button.)

## 4. Phones (2 min each)
1. Open the app URL in **Chrome on Android** → menu ⋮ → **Add to Home screen / Install app**.
2. *Settings* → choose who you are → **Sign in & sync** (Abhilasha: the shared folder appears automatically; if not, type the same folder name).
3. Optional: paste an **Anthropic API key** (create one at console.anthropic.com, set a monthly spend limit) → *Load models* → pick a model
   (a Haiku/Sonnet-class model is plenty). Enables “Ask Claude” in Swap and “Structure with Claude” in Add recipe.

## Everyday use
* **Today**: the rolling 7-day plan is created automatically. Swap / lock / mark cooked / skip / rate / edit portions.
  Locked and cooked meals are never re-planned.
* **Prep this evening**: checklist for the next day (soaking, marinating, setting curd, chopping for lunchboxes).
* **Shopping**: next 1–7 days, tick items off; both phones see the same ticks.
* **Ratings**: Loved / OK / Didn't work per person. “Didn't work” from everyone removes a dish from auto-planning;
  “Loved” makes it come up more often.
* **Weekly limits** (fish/chicken/mutton/paneer/egg breakfasts/exotic): Settings.
* **Share on WhatsApp**: sends the day's menu to the family group.

## Adding recipes
* On the phone: *Recipes → Add recipe* (paste text; Claude structures it) – saved to `custom_recipes.json` on Drive.
* On the laptop: add entries to `data\custom\*.json` (same shape as `bau_everyday.json`), re-run the two scripts, upload `recipes.json`.

## Files in the Drive folder
| File | Written by | Purpose |
|---|---|---|
| recipes.json | laptop (upload) | all recipes with labels, nutrition, kitchen adaptations |
| config.json | laptop (upload) | family targets, household rules, weekly limits |
| plan.json | phones | rolling plan (per day/meal, last edit wins per meal) |
| ratings.json | phones | per recipe, per person ratings |
| custom_recipes.json | phones | recipes added in the app |
| prefs.json | phones | weekly-limit overrides |
| shopping.json | phones | ticked shopping items |
