// ============================================================
// 2026 World Cup Knockout Predictor — leaderboard & scoring
// ============================================================
// This page is a PURE STATIC RENDERER. Results are not fetched here at view
// time: tools/update_leaderboard.py bakes them into assets/results-data.js
// (run on a schedule by a GitHub Action), and assets/results-overrides.js holds
// any hand corrections. The browser just reads those two globals, fetches
// everyone's predictions from the Google Sheet once, scores them, and renders.
//
// The leaderboard is built around ONE persistent symmetric bracket (the same
// renderSymmetricBracket used by the predictor). By default it shows reality;
// clicking a name morphs it in place to that person's picks vs reality.

// Points per round — later rounds worth more, like a real pick'em.
const ROUND_POINTS = { R32: 1, R16: 2, QF: 3, SF: 5, FINAL: 8 };

let actualResults = {};   // matchId -> winning team name (decided matches only)
let resultsMeta = null;   // the WC2026_RESULTS payload (for the "updated" stamp)
let predictions = [];
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

async function fetchPredictionsFromSheet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const MATCH_IDS = ROUNDS.flatMap(r => r.matches.map(m => m.id));
  const rows = (data.predictions || []).map(row => ({
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

// ---- Scoring ----------------------------------------------------------------

// A pick's state against reality: "correct", "wrong", or "pending" (match not
// decided yet, or the pick references a team that never reached this slot).
function pickState(matchId, guess) {
  const actual = actualResults[matchId];
  if (!guess || !actual) return "pending";
  return guess === actual ? "correct" : "wrong";
}

function scorePrediction(pred) {
  let score = 0;
  const breakdown = [];
  const roundSubtotals = {};
  for (const round of ROUNDS) {
    let roundCorrect = 0, roundDecided = 0;
    for (const match of round.matches) {
      const guess = pred.picks[match.id];
      const actual = actualResults[match.id];
      const state = pickState(match.id, guess);
      if (actual) roundDecided++;
      if (state === "correct") {
        score += ROUND_POINTS[round.key];
        roundCorrect++;
      }
      breakdown.push({ matchId: match.id, round: round.key, guess, actual, state });
    }
    roundSubtotals[round.key] = { correct: roundCorrect, decided: roundDecided, total: round.matches.length };
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
//    a correct pick, badged with the points it earned (+1 … +8).
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
    // Points earned on a correct pick, shown on the right alongside the ✓.
    const pts = opts.points
      ? `<span class="pick-points" title="Points earned">+${opts.points}</span>` : "";
    const actual = opts.actual
      ? `<span class="pick-actual" title="Actual winner">→ ${escapeHtml(shortCode(opts.actual))}</span>` : "";
    // Share chip on the pool's favored side (e.g. "64%" of score-weighted pool).
    const share = opts.favored && opts.share != null
      ? `<span class="proj-share" title="How much of the pool — weighted toward the sharpest brackets — backs this team to win">${Math.round(opts.share * 100)}%</span>` : "";
    const titleSuffix = opts.projected ? " — pool projection" : (opts.favored ? " — pool favorite" : "");
    return `<div class="team-row${cls}" title="${escapeAttr(team)}${titleSuffix}">
        ${flag(team)}<span class="team-name">${escapeHtml(shortCode(team))}</span>
        ${mark ? `<span class="pick-mark">${mark}</span>` : ""}${pts}${actual}${share}
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
    const slot = (real, side) => {
      if (winner) return row(real, { win: winner === real });   // decided
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
  // the points badge, and (when wrong) the actual winner; the other team — the
  // one they predicted would lose here — is shown plain.
  const guess = pred.picks[match.id];
  const state = pickState(match.id, guess);
  const points = state === "correct" ? ROUND_POINTS[roundKey] : 0;
  const showActual = state === "wrong" && actual ? actual : null;
  const [teamA, teamB] = predMatchTeams(pred, roundKey, match);

  const personRow = team => {
    if (!team) return row(null);
    if (team === guess) {
      // "chosen" marks their pick even when pending, so it reads as their pick
      // (not dimmed like the old subtractive view) before a result is in.
      const opts = state === "pending"
        ? { chosen: true }
        : { state, points, actual: showActual };
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
        `<span class="ch-stat-num" data-flip="canvas:score">${pred.score}</span>` +
        `<span class="ch-stat-label">${plural(pred.score, "point", "points")}</span>` +
      `</span>` +
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

  if (board.length === 0) {
    root.innerHTML = `<p class="lb-empty">No brackets loaded yet.</p>`;
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
    return `
      <li class="lb-entry${active}${medal ? " medal-" + medal : ""}" data-name="${escapeAttr(p.predictor)}">
        <button type="button" class="lb-row" aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`Show ${p.predictor}'s bracket`)}">
          <span class="lb-rank ${medal}" data-flip="rank:${escapeAttr(p.predictor)}">${p.rank}</span>
          <span class="lb-name"><span class="lb-name-text">${escapeHtml(p.predictor)}</span>${resubmit}</span>
          <span class="lb-champ">${p.champion ? teamCell(p.champion) : ""}</span>
          <span class="lb-correct">${p.correctCount}<span class="muted">/${decided || "—"}</span></span>
          <span class="lb-score"><span data-flip="score:${escapeAttr(p.predictor)}">${p.score}</span><span class="muted">${plural(p.score, "pt", "pts")}</span></span>
          <span class="lb-caret" aria-hidden="true">${active ? "●" : "▸"}</span>
        </button>
      </li>
    `;
  }).join("");

  root.innerHTML = `<ol class="lb-list">${rows}</ol>`;

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

  // 3) Most divisive — the current round's match closest to an even split.
  let divisive = null;
  for (const m of curRoundMatches) {
    const t = tally(m.id);
    if (t.length < 2) continue;
    const topShare = t[0].share;
    if (!divisive || topShare < divisive.topShare) divisive = { match: m, t, topShare };
  }
  const divisiveHtml = divisive
    ? `<div class="stat-sub muted">${divisive.match.id}</div>` +
      divisive.t.slice(0, 2).map(c => statBar(c.team, c.count, c.share)).join("")
    : `<p class="muted">No picks yet.</p>`;

  // 4) Most Shocking — upsets in the current round: the weaker team (higher FIFA
  //    rank number) beating the stronger one. Sorted by the size of the ranking
  //    gap so the biggest stunner leads.
  const upsets = [];
  for (const m of curRoundMatches) {
    const winner = actualResults[m.id];
    if (!winner) continue;
    const [teamA, teamB] = actualMatchTeams(curRound, m);
    if (!teamA || !teamB) continue;
    const loser = winner === teamA ? teamB : teamA;
    const gap = rankOf(winner) - rankOf(loser);   // >0 means a weaker side won
    if (gap > 0) upsets.push({ winner, loser, gap, matchId: m.id });
  }
  upsets.sort((a, b) => b.gap - a.gap || a.matchId.localeCompare(b.matchId));
  const upsetHtml = upsets.length
    ? upsets.slice(0, 6).map(u => {
        // Fire scales with the ranking gap: every upset earns one 🔥, +1 per ~10
        // spots jumped, capped at 5 so a giant-killing can't overflow the row.
        const fire = "🔥".repeat(Math.min(5, 1 + Math.floor(u.gap / 10)));
        return `<div class="stat-line"><span>${flag(u.winner)} <strong title="${escapeAttr(u.winner)}">${escapeHtml(shortCode(u.winner))}</strong> beat ${flag(u.loser)} <strong title="${escapeAttr(u.loser)}">${escapeHtml(shortCode(u.loser))}</strong> <span class="upset-fire" title="Upset rating: +${u.gap} ranking spots">${fire}</span></span><span class="muted">${u.matchId}</span></div>`;
      }).join("")
    : `<p class="muted">No upsets yet in ${curRoundLabel} — chalk is holding.</p>`;

  // 5) Lone wolves — picks that exactly ONE person made (the boldest contrarian
  //    standing calls). Anchored to the current round, but if the pool is in full
  //    consensus there, cascade forward (R16 → QF → … → Final) and show the first
  //    later round that HAS a solo pick — so the card is never a dead end. Each
  //    row's match id makes the borrowed round self-evident; the title stays the
  //    current round. Works before any results are in.
  const solosInRound = (round) => {
    const out = [];
    for (const m of round.matches) {
      for (const s of tally(m.id)) {
        if (s.count === 1) {
          const who = predictions.find(p => p.picks[m.id] === s.team);
          if (who) out.push({ who: who.predictor, team: s.team, matchId: m.id });
        }
      }
    }
    return out;
  };
  let lone = [];
  const curRoundIdx = ROUNDS.findIndex(r => r.key === curRound);
  for (const round of ROUNDS.slice(Math.max(0, curRoundIdx))) {
    lone = solosInRound(round);
    if (lone.length) break;   // first round with any solo pick wins
  }
  // Boldest first: the lowest-ranked team someone backed alone (rankOf is a FIFA
  // rank number, higher = weaker), then match id, then name — deterministic.
  lone.sort((a, b) => rankOf(b.team) - rankOf(a.team)
                      || a.matchId.localeCompare(b.matchId)
                      || a.who.localeCompare(b.who));
  const loneHtml = lone.length
    ? lone.slice(0, 6).map(c =>
        `<div class="stat-line"><span>${escapeHtml(c.who)} alone on ${flag(c.team)} <strong title="${escapeAttr(c.team)}">${escapeHtml(shortCode(c.team))}</strong></span><span class="muted">${c.matchId}</span></div>`
      ).join("")
    : `<p class="muted">No solo picks anywhere yet — the pool is in lockstep.</p>`;

  // 6) Pool at a glance + "chalk score" (how herd-like the pool is: average
  //    top-pick share across all matches that have any picks).
  const board = computeLeaderboard();
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
  // the denominator (29 right now: 3 R32 results have knocked 3 teams out).
  const survivors = survivingTeams();
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
  const CONTINENT_POS = {
    "North America": { left: 17, top: 19 },
    "South America": { left: 23, top: 70 },
    "Europe":        { left: 65, top: 15 },
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
        <h3>Most Shocking ${curRoundLabel}</h3>
        ${upsetHtml}
      </div>
      <div class="stat-card">
        <h3>Lone wolves · ${curRoundLabel}</h3>
        ${loneHtml}
      </div>
      <div class="stat-card stat-card-mini">
        <h3>Pool at a glance</h3>
        <div class="stat-line"><span>Brackets in</span><strong data-flip="pool:bracketsIn">${n}</strong></div>
        <div class="stat-line"><span>Matches decided</span><strong data-flip="pool:decided">${decidedCount()}</strong></div>
        <div class="stat-line"><span>Average score</span><strong data-flip="pool:avg">${avg.toFixed(1)}</strong></div>
        <div class="stat-line"><span>Median / top</span><strong data-flip="pool:medianTop">${median} / ${board.length ? board[0].score : 0}</strong></div>
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
  renderBracketCanvas();
  renderLeaderboard();
  renderPoolStats();

  const refresh = () => { renderBracketCanvas(); renderLeaderboard(); renderPoolStats(); renderUpdatedStamp(); };

  // Everyone's predictions are auto-loaded from the Google Sheet — the only
  // data path. If it fails, we surface the error and the bracket still renders
  // live results; a later reload retries.
  if (typeof SCRIPT_URL === "string" && SCRIPT_URL) {
    renderStatus("Loading brackets…");
    try {
      predictions = await fetchPredictionsFromSheet(SCRIPT_URL);
      renderStatus(`Loaded ${predictions.length} ${plural(predictions.length, "bracket")}.`, "ok");
      refresh();
    } catch (e) {
      renderStatus(`Couldn't load brackets right now (${e.message}). Try reloading in a moment.`, "err");
    }
  } else {
    renderStatus("No Sheet URL configured — set SCRIPT_URL in assets/config.js.", "err");
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
