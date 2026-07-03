// ============================================================
// 2026 World Cup Knockout Predictor — leaderboard & scoring
// ============================================================
// This page renders from committed snapshots first, so nothing gates the first
// paint on a live API. Results: tools/update_leaderboard.py bakes them into
// assets/results-data.js (run on a schedule by a GitHub Action), with
// assets/results-overrides.js for hand corrections. Predictions: a sibling cron
// (tools/update_predictions.py) snapshots the Google Sheet into
// assets/predictions-data.js; the browser hydrates from it, then does a
// best-effort BACKGROUND refresh against the live Sheet — so a flaky GET folds
// in late brackets when it works and is invisible when it doesn't. The page
// reads those globals, scores, and renders.
//
// The leaderboard is built around ONE persistent symmetric bracket (the same
// renderSymmetricBracket used by the predictor). By default it shows reality;
// clicking a name morphs it in place to that person's picks vs reality.

// Points per round — POSITIONAL ENCODING: each round owns TWO adjacent digit-places
// (a "lane pair"), so the total score reads right-to-left as your per-round correct
// counts, each with its OWN upset-boldness (🔥HEAT) digit interleaved directly beneath
// its count. Reading high→low the lanes are:
//   FINAL · FINAL🔥 · SF · SF🔥 · QF · QF🔥 · R16 · R16🔥 · R32 · R32🔥
// A score of 10,203,040,517 decodes as FINAL 1 (🔥0) · SF 2 (🔥0) · QF 3 (🔥0) ·
// R16 4 (🔥0) · R32 51 (🔥7) — i.e. read the pairs. Each round's count fits its base
// lane (R32≤16 spans TWO digits, R16≤8/QF≤4/SF≤2/FINAL≤1 each one digit) and each
// round's heat is a single digit 0–9 in the place just below it.
// Because heat is only earned on a CORRECT pick, a round's heat digit never rides
// without its count — so place value alone makes any later-round contribution
// outrank the ENTIRE block beneath it (strict tiers, never overlap; no floors needed).
// Nothing carries between lanes (see HEAT below + the digit-safety proof at
// scorePrediction). Max = 1·10000000000 + 9·1000000000 + 2·100000000 + 9·10000000
// + 4·1000000 + 9·100000 + 8·10000 + 9·1000 + 16·10 + 9·1 = 19,294,989,169.
const ROUND_POINTS = { R32: 10, R16: 10000, QF: 1000000, SF: 100000000, FINAL: 10000000000 };

// Upset HEAT — the game's boldness lanes. A CORRECT pick that few brackets backed
// earns heat sized by "rarity × round stakes": rarity = 1 − (winner's share among
// brackets that picked the match), stakes CLIMB each round so a late-round shock is
// worth dramatically more than an early one. Unlike the old single pooled lane, each
// round now has its OWN one-digit heat lane (place value HEAT_PLACE[round]) sitting
// just below that round's count — so a Final upset (billions place) mathematically
// dwarfs a whole sweep of R32 upsets (ones place). A round's heat digit is the sum of
// its per-match heat, capped at HEAT_MAX_DIGIT (9). Digit-safe by construction: a
// round's count+heat can't reach the next round's heat place — R32 tops out at
// 16·10 + 9 = 169 < 1000 (R16🔥), and every later round's count (≤8/4/2/1) + heat (≤9)
// stays well under its next-heat place. Heat is 0 for a near-consensus winner and only
// ever accrues on ON-TIME correct picks (late picks earn crowd-credit, no heat — see
// scorePrediction). Gated so a match too few people picked never scores (small samples
// make "rarity" meaningless).
const HEAT_PLACE       = { R32: 1, R16: 1000, QF: 100000, SF: 10000000, FINAL: 1000000000 };  // each round's heat-digit place value
const HEAT_MAX_DIGIT    = 9;    // per-round heat is a single digit (sum of per-match heat, capped)
const HEAT_MIN_ELIGIBLE = 6;    // need ≥6 brackets to have picked a match to score rarity
const HEAT_STAKE = { R32: 1, R16: 2, QF: 3, SF: 5, FINAL: 9 };  // per-match round stakes (1-digit-friendly)

// Cheating-aware "receipt credit". Submissions are open all tournament, so a pick
// made AFTER its match was decided (submission timestamp past the result's known-at
// time) can't earn full trust. Such a "late" correct pick keeps NO upset bonus and
// only earns credit scaled by how much the crowd also backed that winner — a chalk
// pick everyone made is harmless, a lone-wolf hindsight upset earns ≈0. See
// matchKnownAt()/lateShare()/scorePrediction() below.
const LATE_MIN_PICKERS  = 6;              // crowd sample needed before a share is meaningful (mirrors HEAT_MIN_ELIGIBLE)
const LATE_GUARD_CREDIT = 0.5;            // credit when neither crowd is big enough to judge
// Gated floor for late-but-correct picks: a pick the crowd substantially backed
// (share ≥ LATE_FLOOR_MIN_SHARE) is worth at least LATE_FLOOR — so a latecomer who
// "would have picked the obvious winner anyway" isn't docked to near-nothing. A late
// pick BELOW that share (a lone-wolf hindsight upset) keeps its raw low share, so
// peeking at an upset result still pays ≈0. This softens the harsh case without
// re-opening the cheat the receipt system exists to neutralize.
const LATE_FLOOR           = 0.5;
const LATE_FLOOR_MIN_SHARE = 1 / 3;
// Master switch for the adaptive late-pick penalty (everything the LATE_*/matchKnownAt/
// lateShare machinery drives). OFF for now — this is friends having fun, and at least
// one late-looking bracket was a genuine, authentic late entry we don't want to dock.
// The machinery is fully retained: flip to true to re-enable (e.g. if a score is ever
// contested) and every late correct pick reverts to crowd-credit + the 🕒 receipt UI.
// Guard OFF ≡ "no pick is ever late", which the digit-safe scoring already handles.
const CHEAT_GUARD_ENABLED = false;
// Grace window: submissions are only penalized once the Round of 32 is well under
// way. Concretely, the cutoff is the moment the FIRST 8 R32 matches had been played
// (half the round). The board was reset early (bad architecture) and a wave of
// people legitimately re-submitted around then; their rows carry that late re-submit
// timestamp with no history, so this amnesty scores them NORMALLY on every pick.
// Tying it to games-played (not a hardcoded date) self-adjusts to the real schedule
// and lands naturally in the same window. See graceUntilMs().
const LATE_GRACE_MATCHES = 8;
// Kickoff → "result is knowable" offsets. We don't have a true final-whistle time,
// so we approximate the finish from kickoff + a duration by how the match was decided,
// then add a generous buffer before a pick counts as "late".
const DUR_REGULATION_MS = (2 * 60 + 15) * 60 * 1000;  // FT      → +2h15m
const DUR_EXTRA_MS      = 3 * 60 * 60 * 1000;         // AET/AP  → +3h00m (also the lenient default when decided-by is unknown)
// A correct pick is only docked once it lands MORE THAN 24h after its match finished —
// people can still submit later and stay roughly balanced; only picks made a full day
// past a known result lose trust. Replaces the old 15m knife-edge grace.
const LATE_WINDOW_MS    = 24 * 60 * 60 * 1000;        // finish + 24h buffer

let actualResults = {};   // matchId -> winning team name (decided matches only)
let resultsMeta = null;   // the WC2026_RESULTS payload (for the "updated" stamp)
let predictions = [];         // scored brackets (submitted before the R32 close)
let lockedPredictions = [];   // brackets submitted after the close: shown, not scored
let selectedPredictor = null;   // null => canvas shows live results

// Escape a value for use inside a double-quoted HTML attribute. (escapeHtml in
// bracket-data.js handles element text; this is the attribute-context partner,
// kept local since app.js — which defines its own — isn't loaded on this page.)
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Pick singular/plural for a count, so copy reads "1 match" / "3 matches"
// instead of the templated "1 match(es)". pluralForm defaults to singular + "s".
function plural(n, singular, pluralForm) {
  return n === 1 ? singular : (pluralForm || singular + "s");
}

// Deterministically pick one option from a list, keyed to a stable string (a match
// id, a predictor's name). DETERMINISTIC on purpose: renderPoolStats() re-runs on
// every refresh, so Math.random() would reshuffle the copy on each render — this keeps
// each row's phrasing frozen while still varying it across the list. Just enough
// spread for a small list; not a cryptographic hash.
function pickFor(options, key) {
  const s = String(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return options[Math.abs(h) % options.length];
}
// Playful synonyms so the upset + lone-wolf lines don't read the same every time.
const UPSET_VERBS = ["beat", "slayed", "killed", "defeated", "owned", "stunned", "toppled", "downed"];
const LONE_PHRASES = ["alone on", "solo on", "all-in on", "riding", "backing", "betting on"];

// A submission timestamp as a short, human "Jun 28, 3:41 PM" (viewer's locale/zone).
// Prefer the trusted server-side write time; fall back to the client clock. Empty
// string when there's nothing parseable, so callers can omit the element entirely.
function formatSubmitted(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  // Fixed-width, locale-stable "Jun 20, 02:30 PM": 3-char month + 2-digit day and
  // 2-digit 12-hour clock, so every row is the same length and the mono column
  // lines up cleanly (a variable "Jun 1, 3:05 AM" wouldn't align). Forced to en-US
  // so the month-day-time order is consistent regardless of the viewer's locale.
  return d.toLocaleString("en-US", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true
  });
}

// ---- Motion: split-flap numbers + one-time bracket reveal --------------------
// Honor the OS "reduce motion" setting. Checked LIVE (not cached at load) so a
// preference flipped mid-session is respected by both effects below.
function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Split-flap (Solari board) number animation. A cell opts in with
// data-flip="<stableKey>"; after each render applyFlips() diffs its new text
// against the cached last value for that key and rolls only what changed. The
// first time a key is seen (cache miss) we set it silently — so flips never fire
// on initial paint, only on a genuine change (switching brackets, a results
// update). Survives the destructive innerHTML re-renders because the cache is
// keyed by a stable string, not by a DOM node.
const _flipCache = new Map();

function applyFlips(scope) {
  if (!scope) return;
  scope.querySelectorAll("[data-flip]").forEach(el => {
    const key = el.getAttribute("data-flip");
    const next = el.textContent;
    const prev = _flipCache.get(key);
    _flipCache.set(key, next);
    if (prefersReducedMotion() || prev === undefined || prev === next) return;
    rollNumber(el, prev, next);
  });
}

// Roll `el` from prev → next: stack the two values in a clipped viewport and
// slide the reel up one cell, then settle back to plain text so the next diff
// starts clean. Whole-value (not per-digit) — scores are 1–2 chars.
function rollNumber(el, prev, next) {
  el.classList.add("flip-viewport");
  el.innerHTML =
    `<span class="flip-reel"><span class="flip-cell">${escapeHtml(prev)}</span>` +
    `<span class="flip-cell">${escapeHtml(next)}</span></span>`;
  const reel = el.firstChild;
  void reel.offsetHeight;                                  // commit the start state
  requestAnimationFrame(() => reel.classList.add("flip-go"));

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    el.classList.remove("flip-viewport");
    el.textContent = next;
  };
  reel.addEventListener("transitionend", settle, { once: true });
  setTimeout(settle, 700);                                  // fallback if the tab was hidden
}

// The bracket fans in round-by-round on the FIRST canvas paint only; every later
// render (row-click morphs) is instant so the flips own the motion from then on.
let _bracketRevealed = false;

// ---- Results: overrides win over embedded; nothing is fetched live ----------

function loadResults() {
  resultsMeta = (typeof window !== "undefined" && window.WC2026_RESULTS) || null;
  const overrides = (typeof window !== "undefined" && window.WC2026_RESULT_OVERRIDES) || {};

  const validMatchIds = new Set(ROUNDS.flatMap(r => r.matches.map(m => m.id)));

  const out = {};
  if (resultsMeta && resultsMeta.results) {
    for (const [matchId, r] of Object.entries(resultsMeta.results)) {
      if (r && r.winner) out[matchId] = r.winner;
    }
  }
  // Audited manual corrections take precedence over the embedded feed. Ignore
  // typos (unknown match id or a winner not in TEAM_CODES) so a bad override
  // can't silently inflate the "matches decided" count without scoring anyone.
  for (const [matchId, winner] of Object.entries(overrides)) {
    if (!winner) continue;
    if (!validMatchIds.has(matchId) || !TEAM_CODES[winner]) {
      console.warn(`Ignoring invalid result override: ${matchId} → ${winner}`);
      continue;
    }
    out[matchId] = winner;
  }

  // Legality pass (round order): a winner must be one of the two teams the
  // bracket can actually deliver to that match — R32's fixed pair, or the two
  // feeder winners for later rounds (read from `out`, so feeders set by other
  // overrides count). Drops e.g. `"R32-1": "Brazil"`, which would otherwise be
  // scored as winning South Africa vs Canada. Walking in round order means a
  // dropped feeder leaves the next match with an undecided slot; validation is
  // skipped while a feeder is still undecided, so a deliberate look-ahead
  // override isn't falsely rejected.
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const winner = out[m.id];
      if (!winner) continue;
      const legal = round.key === "R32"
        ? [m.teamA, m.teamB]
        : [out[m.from[0]], out[m.from[1]]];
      if (legal[0] && legal[1] && winner !== legal[0] && winner !== legal[1]) {
        console.warn(`Ignoring illegal result for ${m.id}: ${winner} can't appear in this match.`);
        delete out[m.id];
      }
    }
  }
  actualResults = out;
}

// The scoreline for a decided match, aligned to team NAME, or null. Reads the
// full embedded result (loadResults() keeps only the winner name), normalizing
// across the two feeds: TheSportsDB serves scores as strings, ESPN as ints, so
// Number() flattens both. Returns { [teamName]: { goals, pens } }.
function matchScore(matchId) {
  const r = resultsMeta && resultsMeta.results && resultsMeta.results[matchId];
  if (!r || r.status !== "complete") return null;   // skips scheduled/unformed
  // Only show a score when the embedded winner still matches the resolved
  // result, so a winner-only override (results-overrides.js) that flips the
  // winner never leaves a contradicting scoreline on screen.
  if (!r.winner || r.winner !== actualResults[matchId]) return null;
  const num = v => (v == null || v === "" ? null : Number(v)); // "0"/0 valid; ""/null -> none
  const home = num(r.homeScore), away = num(r.awayScore);
  if (home == null || away == null) return null;
  // homeScoreExtra/awayScoreExtra doubles as the extra-time score for AET, so
  // only read it as a shootout tally when the match was decided on penalties.
  const penH = r.decidedBy === "AP" ? num(r.homeScoreExtra) : null;
  const penA = r.decidedBy === "AP" ? num(r.awayScoreExtra) : null;
  // Goals key to homeTeam/awayTeam — NOT teamA/teamB or the winner.
  return {
    [r.homeTeam]: { goals: home, pens: penH },
    [r.awayTeam]: { goals: away, pens: penA },
  };
}

function decidedCount() {
  return Object.keys(actualResults).length;
}

// The round the tournament is CURRENTLY playing: the first round (in bracket
// order) that isn't fully decided yet. So the moment every R32 match is settled
// the cards advance to R16 — even before an R16 match has finished — rather than
// waiting on the next round's first result. Defaults to "R32" before any results
// are in (R32 isn't fully decided), and returns "FINAL" once everything is done.
// Lets the pool-stat cards stay topical on the round actually in play ("Most
// divisive R16", "Lone wolves QF") instead of lagging a round behind.
function currentRound() {
  for (const round of ROUNDS) {
    if (!round.matches.every(m => actualResults[m.id])) return round.key;
  }
  return ROUNDS[ROUNDS.length - 1].key;
}

// A short, human label for a round key, for stat-card titles ("R32", "R16",
// "QF", "SF", "Final"). Mirrors the keys used elsewhere; only FINAL is prettied.
function roundShortLabel(key) {
  return key === "FINAL" ? "Final" : key;
}

// The teams NOT yet eliminated — every R32 entrant minus the loser of each
// decided match. Drives the world map's "Likely" bar (share of survivors per
// continent). Starts from all 32 R32 teams and, for each decided match, resolves
// its two actual teams (R32 fixed pair, or the feeder winners for later rounds)
// and removes the one that didn't win. Skips a match whose teams aren't both
// resolved yet, or whose winner isn't one of the two — the same defensive guard
// loadResults() needs, since a look-ahead override can name a future-round winner
// before its feeders are known. Returns a Set of canonical team names.
function survivingTeams() {
  const alive = new Set();
  ROUND_OF_32.forEach(m => { alive.add(m.teamA); alive.add(m.teamB); });
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const winner = actualResults[m.id];
      if (!winner) continue;
      const [teamA, teamB] = actualMatchTeams(round.key, m);
      if (!teamA || !teamB) continue;
      if (winner !== teamA && winner !== teamB) continue;
      alive.delete(winner === teamA ? teamB : teamA);
    }
  }
  return alive;
}

// ---- Predictions: auto-fetched from the Google Sheet ------------------------

// Drop any pick that can't legally appear in its match under the CURRENT bracket
// graph, mutating `picks` in place and returning true if anything was removed.
// This is the leaderboard's counterpart to pruneInvalidPicks() in app.js: when
// the bracket topology is corrected, brackets submitted against the old graph
// carry now-impossible R16+ picks. Walking ROUNDS in order means a pruned feeder
// leaves the downstream match with an empty slot, so its orphaned pick is pruned
// in the same pass. Legal teams come from each match's resolved feeders (here,
// the submitter's own earlier picks) — the same "reachable, not necessarily a
// complete path" rule the form uses, so the two agree on what's stale.
function prunePredictionPicks(picks) {
  let removed = false;
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      if (!picks[m.id]) continue;
      const legal = round.key === "R32"
        ? [m.teamA, m.teamB]
        : [picks[m.from[0]], picks[m.from[1]]];
      if (picks[m.id] !== legal[0] && picks[m.id] !== legal[1]) {
        delete picks[m.id];
        removed = true;
      }
    }
  }
  return removed;
}

// Turn a raw `{predictions:[…]}` payload (from EITHER the static snapshot in
// predictions-data.js or the live Sheet GET — they share doGet()'s row shape)
// into the cleaned, de-duped, pruned array the leaderboard scores. Pure: no
// fetch, no globals mutated — so the static and live paths run byte-identical
// logic and can't drift.
function normalizePredictions(data) {
  const MATCH_IDS = ROUNDS.flatMap(r => r.matches.map(m => m.id));
  const rows = ((data && data.predictions) || []).map(row => ({
    predictor: row.predictor || "Unknown",
    submittedAt: row.submittedAt || "",
    timestamp: row.timestamp || "",
    picks: Object.fromEntries(
      MATCH_IDS.map(id => [id, row[id] || undefined]).filter(([, v]) => v)
    )
  }));

  // The backend upserts one row per predictor, so duplicates shouldn't occur in
  // normal use — but a manually-edited Sheet could carry two rows for one name,
  // which would double-count that person in standings AND pool stats. Collapse
  // to one entry per name, keeping the most recently written row (timestamp is
  // the server-side write time; submittedAt is the client clock as a fallback).
  const byName = new Map();
  for (const r of rows) {
    const prev = byName.get(r.predictor);
    if (!prev || (r.timestamp || r.submittedAt) > (prev.timestamp || prev.submittedAt)) {
      byName.set(r.predictor, r);
    }
  }

  // Prune picks the corrected bracket can't deliver and flag the entry so the
  // leaderboard can nudge that person to resubmit. Pruning AFTER the de-dupe so
  // it runs once per surviving row. Their still-legal picks (e.g. R32 winners,
  // whose matchups never changed) stay and keep scoring.
  const cleaned = Array.from(byName.values());
  for (const r of cleaned) {
    r.needsResubmit = prunePredictionPicks(r.picks);
  }
  return cleaned;
}

async function fetchPredictionsFromSheet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return normalizePredictions(data);
}

// ---- Scoring ----------------------------------------------------------------

// A pick's state against reality: "correct", "wrong", or "pending" (match not
// decided yet, or the pick references a team that never reached this slot).
function pickState(matchId, guess) {
  const actual = actualResults[matchId];
  if (!guess || !actual) return "pending";
  return guess === actual ? "correct" : "wrong";
}

// Upset heat for a CORRECT pick in any round: the fewer brackets that backed the
// actual winner of that match, the bigger the reward, scaled by the round's stakes.
// heat = round(HEAT_STAKE[round] × rarity), rarity = 1 − (winner's share among
// brackets that picked this match) — a near-unanimous winner rounds to 0, a genuine
// long shot to the round's full stake (R32 1 … FINAL 9). Guarded so a match too few
// people picked never scores (small samples make "rarity" meaningless). Reuses
// tally() (hoisted below). Returned as raw PER-MATCH heat "points"; scorePrediction
// sums them per round and caps at one digit before applying the round's heat place.
function upsetHeat(matchId, winner, roundKey) {
  const dist = tally(matchId);
  const eligible = dist.reduce((s, d) => s + d.count, 0);
  if (eligible < HEAT_MIN_ELIGIBLE) return 0;
  const hit = dist.find(d => d.team === winner);
  const share = hit ? hit.share : 0;
  return Math.round((HEAT_STAKE[roundKey] || 0) * (1 - share));
}

// When a match's result became KNOWABLE, as epoch-ms — or null if we can't tell
// (in which case a pick is never treated as late; benefit of the doubt). We have
// no true final-whistle time, so we approximate: kickoff + a duration keyed off how
// the match was decided (decidedBy) + grace. Reads the full result row from
// resultsMeta (actualResults holds only the winner name). Prefers the precise
// kickoffAt the pipeline now writes, falling back to the older day-granular
// completedAt so already-committed data still works.
function matchKnownAt(matchId) {
  const r = resultsMeta && resultsMeta.results && resultsMeta.results[matchId];
  if (!r) return null;
  const kickoff = r.kickoffAt || r.completedAt;
  if (!kickoff) return null;
  // Day-granular value (no time-of-day): we can't reason about duration, so treat
  // the result as unknowable until the END of that UTC day, then add the same 24h
  // buffer — only a submission a full day past the day's end counts as late.
  if (/^\d{4}-\d{2}-\d{2}$/.test(kickoff)) {
    const day = Date.parse(kickoff);
    return isNaN(day) ? null : day + 24 * 60 * 60 * 1000 + LATE_WINDOW_MS;
  }
  const t = Date.parse(kickoff);
  if (isNaN(t)) return null;
  const by = r.decidedBy;
  // FT → regulation; AET/AP → the longer extra-time window. Anything else (a match
  // decided via override with no/NS decidedBy) uses the longer window too, so we
  // never falsely flag a match that may have run long. Add the 24h buffer on top of
  // the approximate finish so a pick is only late a full day after the result was known.
  const offset = by === "FT" ? DUR_REGULATION_MS : DUR_EXTRA_MS;
  return t + offset + LATE_WINDOW_MS;
}

// The grace cutoff, as epoch-ms: the moment the first LATE_GRACE_MATCHES (8) R32
// matches had all been played — i.e. the 8th-earliest knowable time among decided
// R32 matches. Any bracket submitted at/before this is scored normally (see the
// LATE_GRACE_MATCHES note). Returns Infinity until 8 R32 matches are decided, so
// while the round is still filling in, NOTHING is ever late — the whole early
// window (including the reset resubmit wave) is covered. Memoized per results load.
let _graceUntilCache = { key: null, val: null };
function graceUntilMs() {
  const key = (resultsMeta && resultsMeta.generatedAt) || "none";
  if (_graceUntilCache.key === key) return _graceUntilCache.val;
  const r32 = (ROUNDS.find(r => r.key === "R32") || { matches: [] }).matches;
  const times = [];
  for (const m of r32) {
    if (!actualResults[m.id]) continue;        // only decided R32 matches count
    const t = matchKnownAt(m.id);
    if (t != null) times.push(t);
  }
  times.sort((a, b) => a - b);
  // Not enough decided yet → grace still fully open (Infinity: no pick is late).
  const val = times.length >= LATE_GRACE_MATCHES ? times[LATE_GRACE_MATCHES - 1] : Infinity;
  _graceUntilCache = { key, val };
  return val;
}

// Receipt-credit share for a LATE correct pick: how much of the crowd also backed
// this winner, in [0,1]. Prefer the "on-time crowd" (brackets submitted before the
// result was knowable) — they're the untainted signal, and late brackets can't
// validate each other. Fall back to the whole-pool consensus (leave-one-out, so a
// picker can't inflate their own share) when the on-time crowd is too small, and to
// a neutral guard credit when neither crowd is big enough to mean anything. An
// even-split match lands near 0.5 naturally; a lone-wolf hindsight pick lands ≈0.
function lateShare(matchId, winner, knownAt) {
  // Gated floor: a well-backed pick (crowd share ≥ LATE_FLOOR_MIN_SHARE) is worth at
  // least LATE_FLOOR; a lightly-backed one keeps its raw share (so late lone-wolf
  // hindsight upsets stay ≈0). Applied to both crowd measures below.
  const floored = share => share >= LATE_FLOOR_MIN_SHARE ? Math.max(share, LATE_FLOOR) : share;

  // 1) On-time crowd: picks on this match submitted before it was knowable. The
  //    late scorer is excluded automatically (their own timestamp is past knownAt).
  let onTimeN = 0, onTimeWinner = 0;
  for (const p of predictions) {
    const g = p.picks[matchId];
    if (!g) continue;
    const ts = Date.parse(p.timestamp || p.submittedAt);
    if (isNaN(ts) || ts >= knownAt) continue;
    onTimeN++;
    if (g === winner) onTimeWinner++;
  }
  if (onTimeN >= LATE_MIN_PICKERS) return floored(onTimeWinner / onTimeN);

  // 2) Whole-pool consensus, leave-one-out (remove the scorer, who is a correct picker).
  const dist = tally(matchId);
  const totalPickers = dist.reduce((s, d) => s + d.count, 0);
  const others = totalPickers - 1;
  if (others >= LATE_MIN_PICKERS) {
    const hit = dist.find(d => d.team === winner);
    return floored(((hit ? hit.count : 0) - 1) / others);
  }

  // 3) Too few brackets either way — neither full trust nor zero.
  return LATE_GUARD_CREDIT;
}

// Digit-safety (nothing may carry between lanes — see ROUND_POINTS). Two mechanisms
// fold non-count credit into a round's own lane pair without breaching the next round:
//   • Upset heat: summed PER ROUND from on-time correct picks, capped at one digit
//     (min(9, Σ per-match heat)), then folded as heatDigit × HEAT_PLACE[round]. A
//     round's count + heat can't reach the next round's heat place: R32 = 16·10 + 9
//     = 169 < 1000 (R16🔥); R16 = 8·10000 + 9·1000 = 89000 < 100000 (QF🔥); and so on
//     up the ladder. Heat accrues on ON-TIME correct picks only.
//   • Receipt credit: per round we sum late shares (each ≤ 1) and fold them as whole
//     "units" via floor(sum + 0.5), so lateUnits ≤ lateCount. A round's COUNT lane
//     usage is onTimeCorrect + lateUnits ≤ matchesInRound: ≤16 for R32 (its two
//     digits), ≤8/4/2/1 for R16/QF/SF/FINAL. Late picks carry no heat.
// Every lane's contribution stays an integer multiple of its place value.
function scorePrediction(pred) {
  let score = 0;
  const breakdown = [];
  const roundSubtotals = {};
  const subTs = Date.parse(pred.timestamp || pred.submittedAt);
  // Grace: brackets submitted before the first 8 R32 matches were played are never
  // late (covers the early/reset resubmit wave). graceUntilMs() is Infinity until
  // 8 matches are decided, so everything is graced while the round is still filling.
  const graced = !isNaN(subTs) && subTs <= graceUntilMs();
  for (const round of ROUNDS) {
    let roundCorrect = 0, roundDecided = 0, roundHeatRaw = 0;
    let roundLateShares = 0, roundLateCount = 0;
    for (const match of round.matches) {
      const guess = pred.picks[match.id];
      const actual = actualResults[match.id];
      const state = pickState(match.id, guess);
      if (actual) roundDecided++;
      let bonus = 0, late = false, share = 0;
      if (state === "correct") {
        roundCorrect++;   // it IS a correct call; only its scoring changes when late
        const knownAt = matchKnownAt(match.id);
        late = CHEAT_GUARD_ENABLED && !graced && knownAt != null && !isNaN(subTs) && subTs > knownAt;
        if (late) {
          // Late: no base points inline, no upset heat — only crowd-share credit,
          // accumulated and folded in per round below to keep the digit encoding.
          share = lateShare(match.id, actual, knownAt);
          roundLateShares += share;
          roundLateCount++;
        } else {
          score += ROUND_POINTS[round.key];
          // Per-match upset heat; summed across the round and capped to one digit
          // below, then folded into THIS round's own heat lane (not added inline —
          // it rides the heat place just under the round's count).
          bonus = upsetHeat(match.id, actual, round.key);
          roundHeatRaw += bonus;
        }
      }
      breakdown.push({ matchId: match.id, round: round.key, guess, actual, state, bonus, late, share });
    }
    // Fold this round's heat digit (sum capped at 9) into its own heat lane.
    const heatDigit = Math.min(HEAT_MAX_DIGIT, roundHeatRaw);
    score += heatDigit * HEAT_PLACE[round.key];
    // Fold this round's receipt credit in as whole units × the round weight.
    const lateUnits = Math.floor(roundLateShares + 0.5);
    score += lateUnits * ROUND_POINTS[round.key];
    // roundSubtotals.bonus holds the CAPPED heat digit — exactly what landed in the
    // score — so the round strip's 🔥+N reads true against the total.
    roundSubtotals[round.key] = { correct: roundCorrect, decided: roundDecided, total: round.matches.length,
                                  bonus: heatDigit, lateCount: roundLateCount, lateUnits };
  }
  return { score, breakdown, roundSubtotals };
}

function computeLeaderboard() {
  const board = predictions
    .map(pred => {
      const { score, breakdown, roundSubtotals } = scorePrediction(pred);
      const correctCount = breakdown.filter(b => b.state === "correct").length;
      const decidedCount = breakdown.filter(b => b.actual).length;
      return { ...pred, score, breakdown, roundSubtotals, correctCount, decidedCount,
               champion: pred.picks["FINAL"] || null };
    })
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount
                    || a.predictor.localeCompare(b.predictor));

  // Dense ranking by score: everyone on the same points shares one rank, and the
  // next distinct score takes the next consecutive number (7 tied on 1pt → all
  // rank 1, the next group is rank 2). correctCount/name still order people
  // *within* a tied group, but never split the shared rank.
  let rank = 0, prevScore = null;
  for (const p of board) {
    if (p.score !== prevScore) { rank += 1; prevScore = p.score; }
    p.rank = rank;
  }
  return board;
}

// ---- The bracket canvas (reality <-> selected person) -----------------------

// Resolve a match's two real teams. R32 teams are fixed; later rounds derive
// from the actual winners of their feeder matches — so a match whose feeders
// are both decided shows the real matchup (e.g. CAN vs JPN) instead of "TBD",
// even before that match itself has been played. Mirrors getMatchTeams() in
// app.js, but sourced from actualResults rather than a person's picks.
function actualMatchTeams(roundKey, match) {
  if (roundKey === "R32") return [match.teamA, match.teamB];
  const [fromA, fromB] = match.from;
  return [actualResults[fromA] || null, actualResults[fromB] || null];
}

// The same resolver, but for ONE person's predicted bracket: a later-round
// match's two teams are the winners THEY picked in its feeder matches. This is
// what lets the person view keep the full two-team card shape of the reality
// view (rather than collapsing to a single pick row).
function predMatchTeams(pred, roundKey, match) {
  if (roundKey === "R32") return [match.teamA, match.teamB];
  const [fromA, fromB] = match.from;
  return [pred.picks[fromA] || null, pred.picks[fromB] || null];
}

// ---- Pool consensus projection ----------------------------------------------
// For matches reality hasn't decided yet, show what the POOL collectively thinks
// will happen — a transparent, score-weighted favorite per match. Heavier weight
// to more accurate predictors: weight = score + 1, so before anyone has points
// it's a plain popular vote, then it tilts toward whoever's been right as scores
// spread. Computed once per render and cascaded through the feeder graph (the
// projected winner of a feeder becomes a team in the next round), exactly like
// actualMatchTeams() does for real results.

// Score-weighted favorite for one match: the team carrying the most predictor
// weight, with its share of the total. Returns null when nobody picked the match.
function consensusPick(matchId, board) {
  const weight = {};
  let total = 0;
  for (const p of board) {
    const g = p.picks[matchId];
    if (!g) continue;
    const w = (p.score || 0) + 1;
    weight[g] = (weight[g] || 0) + w;
    total += w;
  }
  let best = null;
  for (const [team, w] of Object.entries(weight)) {
    // Ties broken by name so the projection is stable across reloads.
    if (!best || w > best.w || (w === best.w && team < best.team)) best = { team, w };
  }
  return best ? { team: best.team, share: total ? best.w / total : 0 } : null;
}

// The pool's projected winner for every match, resolved in bracket order so each
// round can read the round before it. Reality wins wherever it's known: a slot's
// projected winner is the ACTUAL winner if decided, else the consensus favorite.
// This keeps the projection from ever contradicting a real result, and lets a
// later-round projection build on real earlier-round outcomes.
function computeConsensus(board) {
  const projected = {};   // matchId -> { team, share } | null
  const winnerOf = {};    // matchId -> projected winning team (actual if decided)
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const [teamA, teamB] = round.key === "R32"
        ? [m.teamA, m.teamB]
        : [winnerOf[m.from[0]] || null, winnerOf[m.from[1]] || null];
      const actual = actualResults[m.id];
      if (actual) {
        winnerOf[m.id] = actual;
        projected[m.id] = null;          // decided — no projection needed
        continue;
      }
      // Only project a favorite that can actually reach this match (one of the
      // two teams the bracket delivers here). Once the matchup is known we narrow
      // the pool's pick to it; before that we still surface the raw favorite.
      const pick = consensusPick(m.id, board);
      let team = pick ? pick.team : null;
      if (team && teamA && teamB && team !== teamA && team !== teamB) team = null;
      projected[m.id] = team ? { team, share: pick.share } : null;
      winnerOf[m.id] = team || null;
    }
  }
  return { projected, winnerOf };
}

// The projected team for one slot of a match (side 0 = teamA, 1 = teamB) when
// reality hasn't filled it. R32 slots are literal and always present, so they're
// never projected; a later-round slot is the pool's projected winner of its
// feeder match. Returns null when there's no projection (e.g. feeder has no picks).
function projFeederTeam(roundKey, match, side, consensus) {
  if (roundKey === "R32" || !consensus) return null;
  return consensus.winnerOf[match.from[side]] || null;
}

// One match cell, used for BOTH views so they read identically:
//  - Reality (no pred): both teams of the real matchup; actual winner gold.
//  - Person (pred set): both teams of THEIR predicted matchup, with the team
//    they picked to advance marked correct / wrong / pending vs reality and, on
//    a correct pick that beat the pool, badged with its 🔥 upset heat.
function canvasCard(roundKey, match, pred, consensus) {
  function row(team, opts) {
    opts = opts || {};
    if (!team) return `<div class="team-row empty"><span class="team-name">TBD</span></div>`;
    // Two independent style axes for the reality view's undecided matches:
    //   projected — the team is the pool's drafted-in feeder winner, not a real
    //     result yet; drawn as a dashed "pencil sketch" so it never reads as fact.
    //   favored   — the pool's score-weighted pick to win THIS match; gets the
    //     pool tint + a share chip. Applies to a real-but-unplayed team too, so a
    //     known matchup still shows who the pool backs.
    // pick-state styling (person view, decided) and the gold reality "selected"
    // win over both, since a real result outranks any projection.
    const cls = opts.state ? ` pick-${opts.state}`
      : (opts.win || opts.chosen ? " selected"
      : `${opts.projected ? " projected" : ""}${opts.favored ? " proj-favored" : ""}`);
    const mark = opts.state === "correct" ? "✓" : opts.state === "wrong" ? "✗" : "";
    // Upset flame: shown on any correct pick that earned upset heat (few brackets
    // backed this winner). Just the 🔥 next to the ✓ — a flag, not a number; the
    // numeric heat (🔥+N) lives only in the round strip under a person's score, so
    // the bracket stays clean and reads "✓🔥" = "you called this bold one right".
    const pts = opts.bonus
      ? `<span class="pick-points" title="Bold pick — few brackets backed this winner">🔥</span>` : "";
    // Late chip: a correct pick submitted AFTER its result was known. A late pick
    // never carries an upset bonus, so 🕒 slots into the same place 🔥 would have.
    const receipt = opts.receipt
      ? `<span class="pick-receipt" title="Late pick — submitted after the result was known, so it earns crowd-credit (${Math.round((opts.share || 0) * 100)}% of the pool), no upset bonus">🕒</span>` : "";
    // Share chip on the pool's favored side (e.g. "64%" of score-weighted pool).
    const share = opts.favored && opts.share != null
      ? `<span class="proj-share" title="How much of the pool — weighted toward the sharpest brackets — backs this team to win">${Math.round(opts.share * 100)}%</span>` : "";
    const titleSuffix = opts.projected ? " — pool projection" : (opts.favored ? " — pool favorite" : "");
    // Final scoreline (reality view, decided match only): the team's goals, and
    // — when the match went to penalties — its shootout tally in parentheses, so
    // a shootout reads as "1(4)".
    const score = opts.score
      ? `<span class="team-score">${opts.score.goals}${
          opts.score.pens != null ? `<span class="pen">(${opts.score.pens})</span>` : ""
        }</span>` : "";
    return `<div class="team-row${cls}" title="${escapeAttr(team)}${titleSuffix}">
        ${flag(team)}<span class="team-name">${escapeHtml(shortCode(team))}</span>
        ${mark ? `<span class="pick-mark">${mark}</span>` : ""}${pts}${receipt}${share}${score}
      </div>`;
  }

  const actual = actualResults[match.id];

  if (!pred) {
    // Reality: show the real matchup (resolved from feeder winners) and
    // highlight the actual winner once it's decided. Where reality hasn't filled
    // a slot yet, draw in the pool's score-weighted projection (the projected
    // winner of that feeder) instead of a bare "TBD". Either way, the side the
    // pool favours to WIN this match gets the tint + share chip. Real results
    // always win, so a decided match shows neither projection nor favorite mark.
    const winner = actual || null;
    const [teamA, teamB] = actualMatchTeams(roundKey, match);
    const proj = consensus ? consensus.projected[match.id] : null;
    const favTeam = proj ? proj.team : null;
    const sc = matchScore(match.id);   // per-team scoreline, or null
    const slot = (real, side) => {
      if (winner) return row(real, { win: winner === real, score: sc && sc[real] });  // decided
      const team = real || projFeederTeam(roundKey, match, side, consensus);
      if (!team) return row(null);                              // genuine TBD
      const favored = !!favTeam && team === favTeam;
      return row(team, { projected: !real, favored, share: proj && proj.share });
    };
    return `<div class="match-card">
      <div class="team-stack">
        ${slot(teamA, 0)}
        ${slot(teamB, 1)}
      </div></div>`;
  }

  // Person view: same two-team card as reality, populated from THEIR picks. The
  // team they chose to advance carries the correct/wrong/pending styling, the ✓,
  // and the points badge; a wrong pick reads as a strikethrough + red ✗ (the real
  // winner is obvious from the highlighted card, so it isn't spelled out). The
  // other team — the one they predicted would lose here — is shown plain.
  const guess = pred.picks[match.id];
  const state = pickState(match.id, guess);
  // Per-pick upset heat, read from the breakdown computed at scoring time (non-zero
  // on any correct pick the crowd under-backed). Used to badge the pick with 🔥+N.
  const bd = pred.breakdown && pred.breakdown.find(b => b.matchId === match.id);
  const bonus = state === "correct" && bd ? (bd.bonus || 0) : 0;
  // Receipt state for this pick (correct but submitted late → crowd-credit only).
  const receipt = state === "correct" && bd ? !!bd.late : false;
  const receiptShare = bd ? (bd.share || 0) : 0;
  const [teamA, teamB] = predMatchTeams(pred, roundKey, match);

  const personRow = team => {
    if (!team) return row(null);
    if (team === guess) {
      // "chosen" marks their pick even when pending, so it reads as their pick
      // (not dimmed like the old subtractive view) before a result is in.
      const opts = state === "pending"
        ? { chosen: true }
        : { state, bonus, receipt, share: receiptShare };
      return row(team, opts);
    }
    return row(team, {});
  };

  return `<div class="match-card">
    <div class="team-stack">
      ${personRow(teamA)}
      ${personRow(teamB)}
    </div></div>`;
}

function renderBracketCanvas() {
  const root = document.getElementById("bracket-canvas-root");
  if (!root) return;
  const board = computeLeaderboard();
  const pred = selectedPredictor
    ? board.find(p => p.predictor === selectedPredictor) || null
    : null;

  // Pool consensus only decorates the live-results view (not a person's bracket),
  // and only once predictions have loaded — before that, undecided slots stay TBD.
  const consensus = (!pred && board.length) ? computeConsensus(board) : null;

  root.innerHTML = renderSymmetricBracket({
    renderCard: (rk, m) => canvasCard(rk, m, pred, consensus)
  });

  // First paint only: fan the wallchart in round-by-round (R32 → Final) via the
  // per-round transition delays in CSS. Every later render (a row-click morph)
  // skips the gate so it's instant, leaving the flips to own the motion.
  if (!_bracketRevealed && !prefersReducedMotion()) {
    root.classList.add("reveal");
    void root.offsetHeight;                  // commit the hidden start state
    requestAnimationFrame(() => root.classList.add("revealed"));
    _bracketRevealed = true;
  }

  renderCanvasHead(pred, !!consensus);
}

// The per-round breakdown, as a row of scoreboard chips: one per round, each
// showing correct/total, tinted progressively toward gold as the round's stakes
// climb (R32 cool → FINAL gold) so the score's shape reads at a glance. Every
// round's chip shows its PURE correct count and appends "🔥+N" when that round
// earned upset heat (the capped heat DIGIT that landed in that round's heat lane —
// so the number reads true against the total). This is the ONLY place the numeric
// heat shows; bracket cards just flag it with 🔥. Rounds with nothing decided yet
// are dimmed but still shown.
function roundStrip(subs) {
  if (!subs) return "";
  const chips = ROUNDS.map(r => {
    const s = subs[r.key] || { correct: 0, total: r.matches.length, decided: 0, bonus: 0, lateCount: 0 };
    const live = s.decided > 0;
    const fire = s.bonus > 0
      ? `<span class="rc-fire" title="Upset heat earned this round">🔥+${s.bonus}</span>` : "";
    // Late glyph: some of this round's correct picks were submitted late and
    // scored on crowd-credit. Muted so it flags the fact without shouting.
    const receipt = s.lateCount > 0
      ? `<span class="rc-receipt" title="${s.lateCount} ${plural(s.lateCount, "pick")} scored late — submitted after the result was known">🕒</span>` : "";
    return `<span class="round-chip rc-${r.key.toLowerCase()}${live ? "" : " is-dim"}${s.correct ? " has-hits" : ""}">` +
             `<span class="rc-label">${roundShortLabel(r.key)}</span>` +
             `<span class="rc-count">${s.correct}<span class="rc-slash">/${s.total}</span></span>${fire}${receipt}` +
           `</span>`;
  }).join("");
  return `<span class="round-strip">${chips}</span>`;
}

// The hero header reads as a stadium scoreboard: a featured stat (big number +
// small label) plus a secondary line, swapping between the live-results and the
// per-person views. The featured number carries data-flip so it rolls (split-flap)
// when it changes — e.g. switching from one bracket to another.
function renderCanvasHead(pred, hasConsensus) {
  const head = document.querySelector(".canvas-head");
  const title = document.getElementById("canvas-title");
  const score = document.getElementById("canvas-score");
  if (!title || !score) return;

  // The projection legend sits UNDER the bracket (its static element lives in
  // score.html), shown only in the live-results view and only once a consensus
  // is actually drawn — so it appears and disappears with the marks it explains.
  const note = document.getElementById("canvas-proj-note");
  if (note) {
    const show = !pred && hasConsensus;
    note.hidden = !show;
    if (show) note.innerHTML = `<b>Dashed</b> = projected winners for spots not set yet, leaning toward the best pickers so far<br><b>%</b> = how much of the pool backs that team`;
  }

  if (pred) {
    title.textContent = pred.predictor;
    const decided = pred.decidedCount || 0;
    // Same nudge as the ranked-list badge, for the per-person hero view.
    const resubmit = pred.needsResubmit
      ? ` · <span class="ch-resubmit">please resubmit</span>` : "";
    score.innerHTML =
      `<span class="ch-stat">` +
        `<span class="ch-stat-num ch-bignum" data-flip="canvas:score">${pred.score.toLocaleString()}</span>` +
        `<span class="ch-stat-label">${plural(pred.score, "point", "points")}</span>` +
      `</span>` +
      roundStrip(pred.roundSubtotals) +
      `<span class="ch-stat-sec">${pred.correctCount}/${decided || "—"} correct · rank #${pred.rank}${resubmit}</span>`;
  } else {
    title.textContent = "Live Results";
    const d = decidedCount();
    score.innerHTML =
      `<span class="ch-stat">` +
        `<span class="ch-stat-num" data-flip="canvas:decided">${d}</span>` +
        `<span class="ch-stat-label">${plural(d, "match", "matches")} decided</span>` +
      `</span>`;
  }
  applyFlips(head);
}

// ---- Ranked list (a selector that drives the canvas) ------------------------

function teamCell(team) {
  if (!team) return `<span class="lb-team muted">—</span>`;
  // 3-letter code to match the bracket; full name in the tooltip.
  return `<span class="lb-team" title="${escapeAttr(team)}">${flag(team)}<span>${escapeHtml(shortCode(team))}</span></span>`;
}

function renderLeaderboard() {
  const root = document.getElementById("leaderboard-root");
  if (!root) return;
  const board = computeLeaderboard();

  // Brackets submitted after the R32 hard-close: shown as a locked, unscored tail
  // group so a late submitter sees WHY they're not on the board, rather than
  // silently vanishing. Built once here and appended after the ranked list.
  const lockedHtml = renderLockedGroup();

  if (board.length === 0) {
    root.innerHTML = lockedHtml || `<p class="lb-empty">No brackets loaded yet.</p>`;
    return;
  }

  const decided = decidedCount();
  const rows = board.map((p) => {
    // Medal follows the (dense) rank, not list position, so everyone sharing
    // rank 1/2/3 shares the medal styling rather than only the first listed.
    const medal = p.rank === 1 ? "gold" : p.rank === 2 ? "silver" : p.rank === 3 ? "bronze" : "";
    const active = p.predictor === selectedPredictor ? " is-active" : "";
    // The bracket was corrected after this person submitted: their now-impossible
    // R16+ picks were pruned on load, so prompt them to fill it in again.
    const resubmit = p.needsResubmit
      ? `<span class="lb-resubmit" title="The bracket was corrected — your later-round picks were cleared. Please resubmit.">Please Resubmit</span>`
      : "";
    // Submission time (server clock preferred) — its own slim column just left of
    // the champion flag. Same trusted timestamp receipt-scoring uses, so the board
    // explains its own fairness.
    const submitted = formatSubmitted(p.timestamp || p.submittedAt);
    // Only claim "cheating-aware" when the guard is actually on; otherwise the chip is
    // a plain submission-time receipt (see CHEAT_GUARD_ENABLED).
    const submittedTitle = CHEAT_GUARD_ENABLED
      ? "Bracket submitted (server time) — scoring is cheating-aware"
      : "Bracket submitted (server time)";
    const submittedEl = submitted
      ? `<span class="lb-submitted" title="${escapeAttr(submittedTitle)}">🕒 ${escapeHtml(submitted)}</span>`
      : `<span class="lb-submitted"></span>`;
    return `
      <li class="lb-entry${active}${medal ? " medal-" + medal : ""}" data-name="${escapeAttr(p.predictor)}">
        <button type="button" class="lb-row" aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`Show ${p.predictor}'s bracket`)}">
          <span class="lb-rank ${medal}" data-flip="rank:${escapeAttr(p.predictor)}">${p.rank}</span>
          <span class="lb-name"><span class="lb-name-text">${escapeHtml(p.predictor)}</span>${resubmit}</span>
          ${submittedEl}
          <span class="lb-champ">${p.champion ? teamCell(p.champion) : ""}</span>
          <span class="lb-correct"><span class="lb-correct-n">${p.correctCount}</span><span class="muted">/${decided || "—"}</span></span>
          <span class="lb-score"><span data-flip="score:${escapeAttr(p.predictor)}">${p.score.toLocaleString()}</span><span class="muted">${plural(p.score, "pt", "pts")}</span></span>
          <span class="lb-caret" aria-hidden="true">${active ? "●" : "▸"}</span>
        </button>
      </li>
    `;
  }).join("");

  root.innerHTML = `<ol class="lb-list">${rows}</ol>${lockedHtml}`;

  root.querySelectorAll(".lb-entry").forEach(entry => {
    entry.querySelector(".lb-row").addEventListener("click", () => {
      const name = entry.getAttribute("data-name");
      // Toggle: click the active person again to return to live results.
      selectedPredictor = (selectedPredictor === name) ? null : name;
      renderLeaderboard();
      renderBracketCanvas();
    });
  });

  applyFlips(root);
}

// The locked, unscored tail: brackets submitted after the R32 hard-close. Purely
// informational (no rank, no score, not clickable) — they're excluded from every
// scoring/consensus/stats path upstream. Returns "" when there are none.
function renderLockedGroup() {
  if (!lockedPredictions.length) return "";
  const items = lockedPredictions
    .slice()
    .sort((a, b) => a.predictor.localeCompare(b.predictor))
    .map(p => {
      const submitted = formatSubmitted(p.timestamp || p.submittedAt);
      const submittedEl = submitted
        ? `<span class="lb-submitted">🔒 ${escapeHtml(submitted)}</span>` : `<span class="lb-submitted"></span>`;
      // Locked rows skip computeLeaderboard, so derive champion straight from picks.
      const champion = p.picks && p.picks["FINAL"] ? p.picks["FINAL"] : null;
      return `
        <li class="lb-entry lb-locked">
          <div class="lb-row" aria-disabled="true">
            <span class="lb-rank">🔒</span>
            <span class="lb-name"><span class="lb-name-text">${escapeHtml(p.predictor)}</span></span>
            ${submittedEl}
            <span class="lb-champ">${champion ? teamCell(champion) : ""}</span>
            <span class="lb-correct muted">—</span>
            <span class="lb-score muted">too late 🔒</span>
            <span class="lb-caret" aria-hidden="true"></span>
          </div>
        </li>`;
    }).join("");
  return `<p class="lb-locked-note">🔒 Rolled in after the Round of 32 wrapped — here for the record, not for points.</p>` +
         `<ol class="lb-list lb-locked-list">${items}</ol>`;
}

// ---- Pool stats (6 cards) ---------------------------------------------------

function tally(matchId) {
  // Returns [{team, count, share}] sorted desc for one match across all picks.
  const counts = {};
  let n = 0;
  for (const p of predictions) {
    const g = p.picks[matchId];
    if (!g) continue;
    counts[g] = (counts[g] || 0) + 1;
    n++;
  }
  return Object.entries(counts)
    .map(([team, count]) => ({ team, count, share: n ? count / n : 0 }))
    // Break count ties by team name so the order is deterministic regardless of
    // Sheet row order (otherwise equally-popular teams can swap places on reload).
    .sort((a, b) => b.count - a.count || a.team.localeCompare(b.team));
}

function renderPoolStats() {
  const root = document.getElementById("pool-stats-root");
  if (!root) return;
  if (predictions.length === 0) { root.innerHTML = ""; return; }

  const n = predictions.length;

  // The furthest round reached drives the round-aware cards below, so they stay
  // topical as the tournament advances (R32 → R16 → … → Final).
  const curRound = currentRound();
  const curRoundLabel = roundShortLabel(curRound);
  const curRoundMatches = (ROUNDS.find(r => r.key === curRound) || ROUNDS[0]).matches;

  // Shared across several cards below: the scored leaderboard, the set of teams
  // still alive, and a name→score lookup (drives the Lone wolves ordering). Hoisted
  // here so the lone-wolves block can reuse them; the Pool-at-a-glance and continent
  // cards read the same consts further down.
  const board = computeLeaderboard();
  const survivors = survivingTeams();
  const scoreByPredictor = new Map(board.map(p => [p.predictor, p.score]));

  // 1) Champion distribution (FINAL pick). Only teams with genuine pool backing
  //    (2+ entries) earn a bar — a lone champion pick overstates "backing" and is
  //    already surfaced by the Lone wolves card below.
  const champs = tally("FINAL");
  const backed = champs.filter(c => c.count > 1);
  const champBars = champs.length === 0
    ? `<p class="muted">No champion picks yet.</p>`
    : backed.length === 0
      ? `<p class="muted">No team has more than one backer yet.</p>`
      : backed.slice(0, 5).map(c => statBar(c.team, c.count, c.share)).join("");

  // 2) Predicted Final matchups — tally every unordered pair of FINAL feeders
  //    across the pool and surface the top 4 distinct matchups with counts.
  const finalMatch = ROUNDS.find(r => r.key === "FINAL").matches[0];
  const finalPairs = {};
  for (const p of predictions) {
    const a = p.picks[finalMatch.from[0]];
    const b = p.picks[finalMatch.from[1]];
    if (!a || !b) continue;
    // Key by the sorted full-name pair (counting is unaffected); keep the two
    // names so we can render 3-letter codes while tooltipping the full pair.
    const [n1, n2] = [a, b].sort();
    const key = `${n1} ‹vs› ${n2}`;
    if (!finalPairs[key]) finalPairs[key] = { count: 0, a: n1, b: n2 };
    finalPairs[key].count += 1;
  }
  const topFinals = Object.entries(finalPairs)
    .filter(([, info]) => info.count > 1)   // only matchups more than one person backs
    .sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))   // count, then pair name
    .slice(0, 4);
  const finalHtml = topFinals.length
    ? topFinals.map(([pair, info]) =>
        // Flags flank the codes: <flag> ARG ‹vs› FRA <flag>.
        `<div class="stat-line"><strong title="${escapeAttr(pair)}">${flag(info.a)} ${escapeHtml(shortCode(info.a))} ‹vs› ${escapeHtml(shortCode(info.b))} ${flag(info.b)}</strong><span class="muted">${info.count} of ${n}</span></div>`
      ).join("")
    : `<p class="muted">Not enough finalist picks yet.</p>`;

  // 3) Most divisive — the current round's UPCOMING match closest to an even split.
  //    Skips matches already decided so the card always previews a match still to be
  //    played; since curRound is the earliest-incomplete round, once it finishes
  //    currentRound() advances and this auto-populates the next round's showdown.
  let divisive = null;
  for (const m of curRoundMatches) {
    if (actualResults[m.id]) continue;   // decided already — not an upcoming showdown
    const t = tally(m.id);
    if (t.length < 2) continue;
    const topShare = t[0].share;
    if (!divisive || topShare < divisive.topShare) divisive = { match: m, t, topShare };
  }
  const divisiveHtml = divisive
    ? `<div class="stat-sub muted">${divisive.match.id}</div>` +
      divisive.t.slice(0, 2).map(c => statBar(c.team, c.count, c.share)).join("")
    : `<p class="muted">No upcoming matches to split on yet.</p>`;

  // 4) Most Shocking — the tournament's biggest stunners SO FAR, across every decided
  //    round (not just the current one), so past giant-killings stay on the wall.
  //    Two independent notions of "shock", summed:
  //      (a) FIFA-rank upset — a weaker side (higher rank number) beat a stronger one;
  //          the component is the ranking gap.
  //      (b) Pool upset — the crowd's favorite between the TWO TEAMS THAT ACTUALLY
  //          PLAYED lost (head-to-head, so later-round picks for teams that never
  //          reached the slot don't distort it); the component is the head-to-head
  //          margin the loser was favored by, in points.
  //    A result qualifies if EITHER axis fires; the summed shock ranks them.
  const allUpsets = [];
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const winner = actualResults[m.id];
      if (!winner) continue;
      const [teamA, teamB] = actualMatchTeams(round.key, m);
      if (!teamA || !teamB) continue;
      const loser = winner === teamA ? teamB : teamA;

      // (a) FIFA-ranking gap (>0 means a weaker side won).
      const rankGap = rankOf(winner) - rankOf(loser);
      const rankComponent = Math.max(0, rankGap);

      // (b) Head-to-head pool lean between the two actual participants.
      const counts = {};
      for (const c of tally(m.id)) counts[c.team] = c.count;
      const winCount = counts[winner] || 0;
      const loseCount = counts[loser] || 0;
      const h2h = winCount + loseCount;
      const loseShare = h2h ? loseCount / h2h : 0;   // crowd's backing of the loser
      const isPoolUpset = loseCount > winCount;       // the pool's pick lost
      const poolComponent = isPoolUpset ? Math.round((loseShare - (h2h ? winCount / h2h : 0)) * 100) : 0;

      if (rankComponent === 0 && !isPoolUpset) continue;   // not shocking on either axis
      allUpsets.push({ winner, loser, matchId: m.id, roundKey: round.key, rankGap,
                       isPoolUpset, loseShare, shock: rankComponent + poolComponent });
    }
  }
  allUpsets.sort((a, b) => b.shock - a.shock || a.matchId.localeCompare(b.matchId));
  // Show the top 6 by shock, but GUARANTEE at least one from every round that produced
  // an upset — so a lone R16 stunner isn't buried under six R32 giant-killings. Reserve
  // each round's biggest shock first (only 5 rounds, so this never uses more than the
  // cap of 6), then fill the rest by overall shock; dedupe by match, re-sort so the
  // biggest stunner still leads.
  const SHOCK_CAP = 6;
  const picked = new Map();   // matchId -> upset
  for (const round of ROUNDS) {
    const top = allUpsets.find(u => u.roundKey === round.key);   // allUpsets is shock-sorted
    if (top) picked.set(top.matchId, top);
  }
  for (const u of allUpsets) {
    if (picked.size >= SHOCK_CAP) break;
    picked.set(u.matchId, u);
  }
  const upsets = [...picked.values()].sort((a, b) => b.shock - a.shock || a.matchId.localeCompare(b.matchId));
  const upsetHtml = upsets.length
    ? upsets.slice(0, 6).map(u => {
        // Fire scales with the combined shock: every upset earns one 🔥, +1 per ~20
        // shock points (rank spots + pool margin), capped at 5 so it can't overflow.
        const fire = "🔥".repeat(Math.min(5, 1 + Math.floor(u.shock / 20)));
        // Tooltip spells out whichever axes fired.
        const bits = [];
        if (u.rankGap > 0) bits.push(`+${u.rankGap} FIFA ranking spots`);
        if (u.isPoolUpset) bits.push(`${Math.round(u.loseShare * 100)}% of head-to-head picks backed ${shortCode(u.loser)}`);
        const upsetTitle = `Upset: ${bits.join(" · ")}`;
        // Playful verb, keyed to the match so it stays put across re-renders.
        const verb = pickFor(UPSET_VERBS, u.matchId);
        return `<div class="stat-line"><span>${flag(u.winner)} <strong title="${escapeAttr(u.winner)}">${escapeHtml(shortCode(u.winner))}</strong> ${verb} ${flag(u.loser)} <strong title="${escapeAttr(u.loser)}">${escapeHtml(shortCode(u.loser))}</strong> <span class="upset-fire" title="${escapeAttr(upsetTitle)}">${fire}</span></span><span class="muted">${u.matchId}</span></div>`;
      }).join("")
    : `<p class="muted">No upsets yet — chalk is holding.</p>`;

  // 5) Lone wolves — picks that exactly ONE person made AND whose team is still
  //    alive (a solo bet on an eliminated team is dead weight, so we drop it). We
  //    project OUTWARD from the current round through every later round (R16 → QF
  //    → SF → Final), gathering every legal solo, so the card shows the pool's
  //    boldest standing calls no matter how deep they run — not just the nearest
  //    round. A deep solo (e.g. one person riding a team all the way to the Final)
  //    reads as a solo at each of those rounds, so we collapse to ONE row per
  //    person at their EARLIEST divergence — the round they first stood alone —
  //    keyed by ROUNDS index (never the match-id string: "FINAL" sorts before
  //    "QF"/"R16" alphabetically). Rows lead with the highest-scoring backer —
  //    the spiciest signal is the pool leader going against the grain. The title
  //    is round-agnostic; each row's match id names where the call diverged. Works
  //    before any results are in (survivingTeams() then holds all 32, so nothing
  //    is filtered out).
  const curRoundIdx = ROUNDS.findIndex(r => r.key === curRound);
  const soloEarliest = new Map();   // predictor → their earliest-round legal solo
  for (let ri = Math.max(0, curRoundIdx); ri < ROUNDS.length; ri++) {
    for (const m of ROUNDS[ri].matches) {
      for (const s of tally(m.id)) {
        if (s.count !== 1 || !survivors.has(s.team)) continue;
        const who = predictions.find(p => p.picks[m.id] === s.team);
        if (!who) continue;
        const cur = soloEarliest.get(who.predictor);
        // Keep the earliest round; within one round, prefer the bolder team, then
        // the lower match id — deterministic, and never overwrites a nearer round.
        const better = !cur || ri < cur.roundIdx
          || (ri === cur.roundIdx && (rankOf(s.team) > rankOf(cur.team)
              || (rankOf(s.team) === rankOf(cur.team) && m.id.localeCompare(cur.matchId) < 0)));
        if (better) soloEarliest.set(who.predictor, { who: who.predictor, team: s.team, matchId: m.id, roundIdx: ri });
      }
    }
  }
  const lone = [...soloEarliest.values()];
  // Spiciest first: the backer's current leaderboard score (highest going against
  // the grain leads), then boldest team (rankOf is a FIFA rank number, higher =
  // weaker), then earliest round, then name — deterministic. `?? 0` guards the
  // (never in practice) case of a backer absent from the board without a NaN.
  lone.sort((a, b) => (scoreByPredictor.get(b.who) ?? 0) - (scoreByPredictor.get(a.who) ?? 0)
                      || rankOf(b.team) - rankOf(a.team)
                      || a.roundIdx - b.roundIdx
                      || a.who.localeCompare(b.who));
  const loneHtml = lone.length
    ? lone.slice(0, 6).map(c => {
        // Playful phrasing, keyed to the person so their line stays put across re-renders.
        const phrase = pickFor(LONE_PHRASES, c.who);
        return `<div class="stat-line"><span>${escapeHtml(c.who)} ${phrase} ${flag(c.team)} <strong title="${escapeAttr(c.team)}">${escapeHtml(shortCode(c.team))}</strong></span><span class="muted">${c.matchId}</span></div>`;
      }).join("")
    : `<p class="muted">No live solo picks yet — the pool is in lockstep.</p>`;

  // 6) Pool at a glance + "chalk score" (how herd-like the pool is: average
  //    top-pick share across all matches that have any picks). Uses the hoisted
  //    `board` from the top of the function.
  const scores = board.map(p => p.score).sort((a, b) => a - b);
  const avg = scores.length ? (scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
  const median = scores.length
    ? (scores.length % 2 ? scores[(scores.length - 1) / 2]
       : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : 0;
  let shareSum = 0, shareN = 0;
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const t = tally(m.id);
      if (t.length) { shareSum += t[0].share; shareN++; }
    }
  }
  const chalk = shareN ? Math.round((shareSum / shareN) * 100) : 0;

  // 7) Title picks by continent — TWO bars per continent. "Predicted" is the
  //    share of the pool's champion (FINAL) picks landing in that continent;
  //    "Likely" is the share of teams still alive (not yet eliminated) there,
  //    which moves as results come in. The faint world map floats the Predicted
  //    shares as chips above the split-bar list.
  const contCounts = {};
  for (const p of predictions) {
    const c = continentOf(p.picks["FINAL"]);
    if (c) contCounts[c] = (contCounts[c] || 0) + 1;
  }
  const contTotal = Object.values(contCounts).reduce((s, x) => s + x, 0);

  // "Likely": fold the surviving teams into their continents. totalSurvivors is
  // the denominator (29 right now: 3 R32 results have knocked 3 teams out). Uses
  // the hoisted `survivors` set from the top of the function.
  const likeCounts = {};
  for (const team of survivors) {
    const c = continentOf(team);
    if (c) likeCounts[c] = (likeCounts[c] || 0) + 1;
  }
  const totalSurvivors = survivors.size;

  // Predicted ranking drives the map chips (the leader chip is gold).
  const contSorted = Object.entries(contCounts)
    .map(([name, count]) => ({ name, count, share: count / contTotal }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // The split-bar list spans every continent with a champion pick OR a live team,
  // ordered by Likely share (always present once any team survives), then by
  // Predicted, then name — deterministic regardless of pool/Set iteration order.
  const contNames = new Set([...Object.keys(contCounts), ...Object.keys(likeCounts)]);
  const contRows = Array.from(contNames).map(name => ({
    name,
    predPct: contTotal ? Math.round((contCounts[name] || 0) / contTotal * 100) : 0,
    predCount: contCounts[name] || 0,
    likePct: totalSurvivors ? Math.round((likeCounts[name] || 0) / totalSurvivors * 100) : 0,
    likeCount: likeCounts[name] || 0
  })).sort((a, b) => b.likePct - a.likePct || b.predPct - a.predPct || a.name.localeCompare(b.name));

  // Each continent's centroid on the world-mini.svg (dot-matrix) viewBox, as
  // map %. Emitted by tools/gen_dotmap.py (mean of each continent's dots in the
  // Winkel-Tripel projection) — regenerate both together, never eyeball these.
  // EXCEPTION: Europe is a deliberate manual override, NOT the generated centroid.
  // The dot-mean sits ~{left:65,top:15}, dragged east/north by Russia's landmass,
  // so the label floated over Russia. We anchor it instead near the Caucasus
  // (~42.5°N, 44°E → left 58%, top 29% via the same projection; see the printout
  // from tools/gen_dotmap.py / the one-off probe), nudged up into the European
  // band so it reads as Europe without overlapping Russia.
  const CONTINENT_POS = {
    "North America": { left: 17, top: 19 },
    "South America": { left: 23, top: 70 },
    "Europe":        { left: 58, top: 22 },
    "Africa":        { left: 50, top: 55 },
    "Asia":          { left: 72, top: 36 },
    "Oceania":       { left: 90, top: 79 }
  };
  // Map chips carry BOTH numbers — gold Predicted | cyan Likely — so the gap
  // between what the pool believes and what's surviving reads straight off the
  // globe. The two-colour split is the legend; the header strip names it once.
  const mapHtml = contRows.length
    ? `<div class="continent-map">
         <img src="img/world-mini.svg" alt="" aria-hidden="true">
         ${contRows.map(c => {
           const pos = CONTINENT_POS[c.name] || { left: 50, top: 50 };
           return `<span class="cont-chip" style="left:${pos.left}%;top:${pos.top}%;" title="${escapeAttr(c.name)}: predicted ${c.predPct}%, still alive ${c.likePct}%"><b class="pred">${c.predPct}%</b><i class="sep" aria-hidden="true">|</i><b class="like">${c.likePct}%</b></span>`;
         }).join("")}
       </div>`
    : "";
  const barsHtml = contRows.length
    ? `<div class="cont-split-head"><span class="h-pred">Predicted</span><span class="h-like">Likely</span></div>` +
      contRows.map(c => continentSplitBar(c)).join("")
    : `<p class="muted">No title picks yet.</p>`;
  const continentHtml = mapHtml + barsHtml;

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <h3>Title backers</h3>
        ${champBars}
      </div>
      <div class="stat-card">
        <h3>Most-predicted Final</h3>
        ${finalHtml}
      </div>
      <div class="stat-card">
        <h3>Most divisive ${curRoundLabel}</h3>
        ${divisiveHtml}
      </div>
      <div class="stat-card">
        <h3>David ‹vs› Goliath</h3>
        ${upsetHtml}
      </div>
      <div class="stat-card">
        <h3>Lone wolves</h3>
        ${loneHtml}
      </div>
      <div class="stat-card stat-card-mini">
        <h3>Pool at a glance</h3>
        <div class="stat-line"><span>Brackets in</span><strong data-flip="pool:bracketsIn">${n}</strong></div>
        <div class="stat-line"><span>Matches decided</span><strong data-flip="pool:decided">${decidedCount()}</strong></div>
        <div class="stat-line"><span>Average score</span><strong data-flip="pool:avg">${avg.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong></div>
        <div class="stat-line"><span>Median / top</span><strong data-flip="pool:medianTop">${median.toLocaleString()} / ${(board.length ? board[0].score : 0).toLocaleString()}</strong></div>
        <div class="stat-line"><span>Chalk score</span><strong data-flip="pool:chalk">${chalk}%</strong></div>
      </div>
      <div class="stat-card stat-card-wide">
        <h3>Title picks by continent</h3>
        ${continentHtml}
      </div>
    </div>
  `;

  applyFlips(root);
}

function statBar(team, count, share) {
  const pct = Math.round(share * 100);
  // 3-letter code to match the bracket; full name in the label's tooltip.
  return `
    <div class="stat-bar">
      <span class="stat-bar-label" title="${escapeAttr(team)}">${flag(team)}<span>${escapeHtml(shortCode(team))}</span></span>
      <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${pct}%"></span></span>
      <span class="stat-bar-val">${pct}% <span class="muted">(${count})</span></span>
    </div>
  `;
}

// One continent row with TWO bars side by side: Predicted (pool's champion-pick
// share, gold) on the left and Likely (share of surviving teams, cool) on the
// right, each with its own %. `c` carries the pre-rounded percentages and raw
// counts; the counts ride along in the value cell and tooltips. A continent with
// no champion picks still appears if it has live teams (predPct 0), and vice
// versa — so the row set is the union, matching the map+bars intent.
function continentSplitBar(c) {
  return `
    <div class="cont-split">
      <span class="stat-bar-label">${continentGlyph(c.name)}<span>${escapeHtml(c.name)}</span></span>
      <span class="cont-split-pred">
        <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${c.predPct}%"></span></span>
        <span class="stat-bar-val" title="Predicted by the pool">${c.predPct}% <span class="muted">(${c.predCount})</span></span>
      </span>
      <span class="cont-split-div" aria-hidden="true"></span>
      <span class="cont-split-like">
        <span class="stat-bar-track"><span class="stat-bar-fill like" style="width:${c.likePct}%"></span></span>
        <span class="stat-bar-val" title="Teams still alive">${c.likePct}% <span class="muted">(${c.likeCount})</span></span>
      </span>
    </div>
  `;
}

// ---- Status stamp -----------------------------------------------------------

function renderStatus(message, kind) {
  const el = document.getElementById("lb-status");
  if (!el) return;
  el.textContent = message || "";
  // Keep the base .lb-status styling; layer the ok/err color modifier on top.
  el.className = kind ? `lb-status lb-status-${kind}` : "lb-status";
}

function renderUpdatedStamp() {
  const el = document.getElementById("results-stamp");
  if (!el) return;
  const decided = decidedCount();
  if (!resultsMeta || !resultsMeta.generatedAt) {
    el.textContent = decided
      ? `Showing ${decided} ${plural(decided, "result")}.`
      : "No results in yet — the bracket fills in as knockout matches finish.";
    return;
  }
  const when = new Date(resultsMeta.generatedAt);
  const nice = isNaN(when) ? resultsMeta.generatedAt
    : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  el.textContent = `Results updated ${nice} · ${decided} ${plural(decided, "match", "matches")} decided`;
}

// ---- Live updates: hot-swap fresh results without a reload ------------------
// GitHub Pages caches the <script src="results-data.js"> by URL, so neither a
// phone refresh nor an open tab reliably picks up a freshly-committed results
// file. version-check.js polls assets/version.json (cache:"no-store") and calls
// this when results-data.js's generatedAt advances. We re-fetch results-data.js
// under a cache-busting URL, let it overwrite window.WC2026_RESULTS, then re-run
// the existing render path — the _flipCache split-flap animates the changes.

// Re-inject results-data.js?v=<ts> and resolve true once window.WC2026_RESULTS
// reflects a STRICTLY newer generatedAt than what we're showing (guards against
// a brief version.json-vs-Pages CDN skew handing us a not-yet-updated file).
// Resolves false (don't advance the "seen" version) on load error or stale body.
function applyFreshResults(ts) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `assets/results-data.js?v=${encodeURIComponent(ts)}`;
    s.onload = () => {
      s.remove();
      // Compare against the CURRENTLY rendered generatedAt (read here, not
      // captured at call time) so a late-completing load can't render older
      // results than what's already on screen.
      const cur = (resultsMeta && resultsMeta.generatedAt) || "";
      const fresh = (window.WC2026_RESULTS && window.WC2026_RESULTS.generatedAt) || "";
      if (!fresh || (cur && fresh <= cur)) { resolve(false); return; }  // CDN lag served stale — retry next tick
      loadResults();
      renderBracketCanvas();
      renderLeaderboard();
      renderPoolStats();
      renderUpdatedStamp();
      resolve(true);
    };
    s.onerror = () => { s.remove(); resolve(false); };   // transient — retry next tick
    document.head.appendChild(s);
  });
}

// ---- Init -------------------------------------------------------------------

async function initScorePage() {
  loadResults();
  renderUpdatedStamp();

  const refresh = () => { renderBracketCanvas(); renderLeaderboard(); renderPoolStats(); renderUpdatedStamp(); };

  // Split off brackets submitted after the R32 hard-close: they're shown as a
  // locked, unscored group and must NOT enter `predictions`, so they never
  // contribute to scoring, ranking, consensus, or pool stats.
  const applyPredictions = (all) => {
    predictions = all.filter(p => !submittedAfterClose(p.timestamp || p.submittedAt));
    lockedPredictions = all.filter(p => submittedAfterClose(p.timestamp || p.submittedAt));
  };
  const loadedStatus = () => {
    const lockNote = lockedPredictions.length
      ? ` (${lockedPredictions.length} locked — submitted after the R32 close)` : "";
    return `Loaded ${predictions.length} ${plural(predictions.length, "bracket")}${lockNote}.`;
  };

  // Predictions load in TWO stages so the flaky Sheet GET can never gate or blank
  // the board: (1) hydrate synchronously from the committed snapshot baked into
  // predictions-data.js and paint the REAL board on first frame; (2) fire a
  // best-effort background refresh against the live Sheet to fold in anything
  // submitted since the last snapshot. If the snapshot is absent (local dev, or
  // before the first cron run) we fall back to the original await-the-live-fetch
  // so nothing breaks.
  const snapshot = (typeof window !== "undefined" && window.WC2026_PREDICTIONS) || null;
  const haveSnapshot = !!(snapshot && Array.isArray(snapshot.predictions));

  if (haveSnapshot) {
    applyPredictions(normalizePredictions(snapshot));
    renderStatus(loadedStatus(), "ok");
  } else if (typeof SCRIPT_URL === "string" && SCRIPT_URL) {
    renderStatus("Loading brackets…");
  } else {
    renderStatus("No Sheet URL configured — set SCRIPT_URL in assets/config.js.", "err");
  }

  // First paint: the real board when we have the snapshot, else the empty shell
  // (exactly as before) while the live fetch runs.
  renderBracketCanvas();
  renderLeaderboard();
  renderPoolStats();

  // Live Sheet fetch: a NON-BLOCKING background refresh once the snapshot is up
  // (failures stay invisible — the snapshot is already on screen), or the sole
  // data path when there was no snapshot to hydrate from.
  if (typeof SCRIPT_URL === "string" && SCRIPT_URL) {
    if (haveSnapshot) {
      fetchPredictionsFromSheet(SCRIPT_URL).then(all => {
        // Don't let a suspicious empty/broken GET wipe a good snapshot: if we're
        // showing brackets and the live call yields none, keep what's on screen.
        // (A genuine full-Sheet wipe surfaces on the next load's fresh snapshot.)
        if (!all.length && predictions.length) return;
        applyPredictions(all);
        // The selected person may have vanished (renamed, removed, or now in the
        // locked tail). Clear the selection so the canvas doesn't silently revert
        // to live results while the ranked list shows no active row.
        if (selectedPredictor && !predictions.some(p => p.predictor === selectedPredictor)) {
          selectedPredictor = null;
        }
        renderStatus(loadedStatus(), "ok");
        refresh();
      }).catch(() => { /* snapshot already shown — a flaky live call is a no-op */ });
    } else {
      try {
        applyPredictions(await fetchPredictionsFromSheet(SCRIPT_URL));
        renderStatus(loadedStatus(), "ok");
        refresh();
      } catch (e) {
        renderStatus(`Couldn't load brackets right now (${e.message}). Try reloading in a moment.`, "err");
      }
    }
  }

  // Watch for fresh results (hot-swap, no reload) and code pushes (reload once,
  // else nudge). Seeded with the generatedAt we loaded so the first poll only
  // fires on something genuinely newer.
  if (typeof startVersionWatch === "function") {
    startVersionWatch({
      initialResultsVersion: (resultsMeta && resultsMeta.generatedAt) || null,
      onResultsChanged: applyFreshResults,
      onSiteChanged: (version) => {
        if (!reloadOnceForVersion(version)) {
          showUpdateNudge("Updated leaderboard available — refresh for the latest.");
        }
      }
    });
  }
}
