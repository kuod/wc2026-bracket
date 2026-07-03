# 2026 World Cup Knockout Predictor

**[https://kuod.github.io/wc2026-bracket/](https://kuod.github.io/wc2026-bracket/)**

A static, no-server bracket predictor for the FIFA World Cup 2026 knockout stage (Round of 32 → Final). Friends fill out picks at a link you share; picks are stored in a Google Sheet; the leaderboard scores everyone automatically as real results come in — no manual data entry.

## How it works

- **`index.html`** — the prediction form. Pick a winner in every Round of 32 match and the Round of 16, Quarterfinals, Semifinals, and Final fill themselves in as you go, just like a real bracket. **Submit** sends the picks straight to the pool's Google Sheet.
- **`score.html`** — the leaderboard. Renders everyone's brackets (baked into a committed snapshot for a fast first paint, then quietly refreshed live from the Sheet), scores them against real results, and ranks the pool. Click any name to see their full bracket with ✓ / ✗ / pending marks; scroll down for pool-wide stats.
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
  predictions-data.js           GENERATED predictions snapshot (committed by the updater)
  style.css                     visual system
backend/
  apps-script.js                Google Apps Script — deploy to script.google.com
tools/
  update_leaderboard.py         fetches results from TheSportsDB → results-data.js
  update_predictions.py         snapshots the Sheet → predictions-data.js
.github/workflows/
  update-results.yml            runs both updaters on a schedule + on demand
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

Send friends `https://kuod.github.io/wc2026-bracket/`. They fill out the bracket and hit **Submit** — done. If a submission ever hiccups, the **"Copy JSON Instead"** button lets someone send you their picks any other way.

## Scoring

Scoring lives in `assets/score-app.js` (`scorePrediction()` and the constants above it). It's more than "count your correct picks" — three things stack:

- **Round weight.** Later rounds are worth exponentially more, so getting the champion right matters far more than a single Round of 32 upset. Each round's correct-pick count is encoded into its own decimal digit lane (R32, R16, QF, SF, Final, low → high place value), so a single correct Final pick outranks *any* number of correct picks in every round below it — no amount of R32 correctness can out-score one right Final call.
- **Upset heat (🔥).** A correct pick on a match few other brackets backed earns bonus "heat," sized by how rare the pick was (rarity = 1 − the winner's share among everyone who picked that match) times that round's stakes (later rounds again worth more). A near-unanimous pick earns no heat; a lone correct upset call earns the most. Heat only counts once at least `HEAT_MIN_ELIGIBLE` (6) brackets have picked a match, so tiny samples can't skew it, and it's stored in its own digit lane directly beneath that round's count so it can never bleed into a different round's score.
- **Late-pick guard (currently off).** The scorer can dock picks made suspiciously late — submitted more than 24 hours after the match actually finished (finish time is approximated from kickoff + a duration keyed off how the match was decided: regulation, extra time, or penalties) — replacing their credit with a "crowd-share" value (how much of the pool also picked that winner) instead of full points, so hindsight upset-calling doesn't pay off. A late pick still counts as "correct" for tie-breaking and the ✓ mark; only its point value changes. Brackets submitted before the first 8 Round of 32 matches were decided are always graced (never late), covering an early board-reset resubmit wave. This machinery is implemented but disabled (`CHEAT_GUARD_ENABLED = false` in `score-app.js`) for this friendly pool; flip it on if a score is ever contested.

Ties are broken by total correct-pick count, then alphabetically, and the leaderboard uses dense ranking (everyone tied on points shares one rank; the next distinct score takes the next consecutive rank).

## Updating tournament data

`assets/bracket-data.js` has the Round of 32 matchups, dates, venues, and flag/alias data as of the finalized draw. If a matchup is wrong by kickoff, edit `teamA`/`teamB` in `ROUND_OF_32` — flags and every later round update automatically. New teams need an entry in `TEAM_CODES` (ISO country code, e.g. `"England": "gb-eng"`).

## Fixing a result by hand

TheSportsDB occasionally stores a penalty-shootout match as a bare draw without the deciding score. When that happens the match shows as "pending." To fix it, add one line to **`assets/results-overrides.js`** — e.g. `"QF-1": "Croatia"` — and commit. Overrides win over the fetched data and survive the next updater run. This is the only manual correction path; there's no in-app results editor, so the leaderboard stays the same for everyone.
