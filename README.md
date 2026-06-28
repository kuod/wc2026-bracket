# 2026 World Cup Knockout Predictor

A static, no-backend bracket predictor for the FIFA World Cup 2026 knockout stage (Round of 32 → Final). Friends fill out picks at a link you share; their picks get stored as GitHub Issues (the "backend"); you score it on a separate leaderboard page once results come in.

## How it works

- **`index.html`** — the prediction form. Pick a winner in every Round of 32 match; your picks automatically populate the Round of 16, Quarterfinals, Semifinals, and Final as you go. Hitting **Submit** opens a pre-filled GitHub Issue containing the picks as JSON.
- **`score.html`** — the leaderboard. Pulls all Issues labeled `prediction` from the repo via the public GitHub API, parses out each person's picks, and scores them against results you enter by hand as games finish.
- **`assets/bracket-data.js`** — the bracket structure (matchups, flags, round point values' structure). This is the single source of truth both pages read from.

No server, database, or build step required — it's plain HTML/CSS/JS, which is all GitHub Pages needs.

## One-time setup (you, before sharing the link)

1. **Create a public GitHub repo** at `kuod/wc2026-bracket` (Issues won't work on private repos for people without write access, so keep it public — there's no sensitive data here, just picks).
2. Push these files to the repo's root (or `docs/` if you prefer, then point Pages at that folder).
3. `assets/app.js` is already set to:
   ```js
   const GITHUB_REPO = "kuod/wc2026-bracket";
   ```
   Double check this matches the repo you actually pushed to.
4. **Enable Issues** on the repo (Settings → General → Features → Issues, if not already on).
5. **Create the `prediction` label** (Issues → Labels → New label → name it exactly `prediction`). It doesn't have to be the only label, but the scoring page filters on it, so it must exist and match.
6. **Enable GitHub Pages** (Settings → Pages → Deploy from branch → `main` → `/ (root)`). Your link will be `https://your-username.github.io/your-repo-name/`.
7. Visit the live `index.html` once yourself to confirm the Submit button opens a correctly pre-filled GitHub Issue.

## Sharing it

Send friends: `https://kuod.github.io/wc2026-bracket/`

They fill out the bracket and hit Submit, which opens a GitHub issue pre-filled with their name and JSON picks — they just need to click "Submit new issue" in GitHub (a free GitHub account is required to open an issue). If someone doesn't want a GitHub account, they can use the **"Copy JSON Instead"** button and send you the text any other way (text, email, Discord) — you can paste it into the leaderboard page's "Load From Pasted JSON" box later.

## Scoring as the tournament goes

On `score.html`:
1. Paste in your repo name and click **Load Predictions from GitHub Issues** to pull everyone's picks.
2. As each match finishes, click the actual winner in the results editor. Later rounds' matchups fill in automatically once their feeder matches are marked.
3. The leaderboard recalculates live. Points: Round of 32 = 1, Round of 16 = 2, Quarterfinals = 3, Semifinals = 5, Final = 8.

Results you enter are saved in your browser's local storage. If you want them to persist across browsers/devices, the simplest option is to also commit a `results.json` snapshot to the repo periodically — ask Claude to wire that up if you want it later.

## Updating the bracket data

`assets/bracket-data.js` has the confirmed Round of 32 matchups, dates, venues, and flag emojis as of June 28, 2026 (group stage just concluded). If a matchup listed as a "projection" anywhere turns out to be wrong by kickoff, just edit the `teamA`/`teamB` values in `ROUND_OF_32` — everything downstream (flags, later-round slots) updates automatically.
