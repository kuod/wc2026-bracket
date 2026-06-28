# 2026 World Cup Knockout Predictor

**[https://kuod.github.io/wc2026-bracket/](https://kuod.github.io/wc2026-bracket/)**

A static, no-server bracket predictor for the FIFA World Cup 2026 knockout stage (Round of 32 → Final). Friends fill out picks at a link you share; picks are stored in a Google Sheet; the leaderboard scores everyone automatically as real results come in — no manual data entry.

## How it works

- **`index.html`** — the prediction form. Pick a winner in every Round of 32 match and the Round of 16, Quarterfinals, Semifinals, and Final fill themselves in as you go, just like a real bracket. **Submit** sends the picks straight to the pool's Google Sheet.
- **`score.html`** — the leaderboard. Pulls everyone's brackets from the Sheet, scores them against real results, and ranks the pool. Click any name to see their full bracket with ✓ / ✗ / pending marks; scroll down for pool-wide stats.
- **Results are automatic.** `tools/update_leaderboard.py` fetches real knockout results from [TheSportsDB](https://www.thesportsdb.com/) and writes them into `assets/results-data.js`. A GitHub Action runs it on a schedule during the tournament, so the live page always shows fresh scores with a "Results updated …" stamp. The browser never calls the results API itself — everyone sees the same leaderboard.

No database or build step: it's plain HTML/CSS/JS, which is all GitHub Pages needs.

## Repo layout

```
index.html  score.html          the two pages
assets/
  config.js                     SCRIPT_URL (your Apps Script web-app URL)
  bracket-data.js               bracket structure, team→flag codes, name aliases
  app.js                        predictions page logic
  score-app.js                  leaderboard + scoring logic
  results-data.js               GENERATED results (committed by the updater)
  results-overrides.js          hand corrections (penalty shootouts, etc.)
  style.css                     visual system
backend/
  apps-script.js                Google Apps Script — deploy to script.google.com
tools/
  update_leaderboard.py         fetches results from TheSportsDB → results-data.js
.github/workflows/
  update-results.yml            runs the updater on a schedule + on demand
```

## One-time setup (you, before sharing the link)

### 1. The Google Sheet backend

1. Create a Google Sheet (any blank one).
2. Extensions → **Apps Script**, delete the placeholder, and paste in **`backend/apps-script.js`**.
3. **Deploy → New deployment → Web app**, set *Execute as: Me* and *Who has access: Anyone*, then authorize.
4. Copy the deployment URL (`https://script.google.com/macros/s/…/exec`) into **`assets/config.js`** as `SCRIPT_URL`.

The script creates a `Predictions` sheet on first submit and stores one row per predictor (re-submits overwrite that person's row, so the latest bracket always wins).

### 2. GitHub Pages

Settings → Pages → Deploy from branch → `main` → `/ (root)`. Your link will be `https://your-username.github.io/your-repo-name/`.

### 3. Automatic results

The included GitHub Action (`.github/workflows/update-results.yml`) runs `update_leaderboard.py` on a schedule across the knockout window and commits any changed results. It needs no secrets — TheSportsDB is free and keyless. You can also trigger it any time from the **Actions** tab ("Run workflow"), or run it locally:

```bash
python3 tools/update_leaderboard.py   # stdlib only, no pip install
```

## Sharing it

Send friends `https://kuod.github.io/wc2026-bracket/`. They fill out the bracket and hit **Submit** — done. If automatic loading ever hiccups, the **"Copy JSON Instead"** button lets someone send you their picks any other way, and the leaderboard's collapsible *"paste them manually"* box accepts pasted JSON.

## Scoring

Points per round: **R32 = 1 · R16 = 2 · QF = 3 · SF = 5 · Final = 8**. Higher rounds are worth more, so the title pick matters most.

## Updating tournament data

`assets/bracket-data.js` has the Round of 32 matchups, dates, venues, and flag/alias data as of the finalized draw. If a matchup is wrong by kickoff, edit `teamA`/`teamB` in `ROUND_OF_32` — flags and every later round update automatically. New teams need an entry in `TEAM_CODES` (ISO country code, e.g. `"England": "gb-eng"`).

## Fixing a result by hand

TheSportsDB occasionally stores a penalty-shootout match as a bare draw without the deciding score. When that happens the match shows as "pending." To fix it, add one line to **`assets/results-overrides.js`** — e.g. `"QF-1": "Croatia"` — and commit. Overrides win over the fetched data and survive the next updater run. This is the only manual correction path; there's no in-app results editor, so the leaderboard stays the same for everyone.
