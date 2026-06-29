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

// ---- Predictions: auto-fetched from the Google Sheet ------------------------

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
  return Array.from(byName.values());
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

// One match cell, used for BOTH views so they read identically:
//  - Reality (no pred): both teams of the real matchup; actual winner gold.
//  - Person (pred set): both teams of THEIR predicted matchup, with the team
//    they picked to advance marked correct / wrong / pending vs reality and, on
//    a correct pick, badged with the points it earned (+1 … +8).
function canvasCard(roundKey, match, side, pred) {
  function row(team, opts) {
    opts = opts || {};
    if (!team) return `<div class="team-row empty"><span class="team-name">TBD</span></div>`;
    // pick-state styling (person view, decided) wins; otherwise the gold
    // "selected" highlight marks either the reality winner (opts.win) or a
    // person's still-pending pick (opts.chosen) — same look as the predictor.
    const cls = opts.state ? ` pick-${opts.state}` : (opts.win || opts.chosen ? " selected" : "");
    const mark = opts.state === "correct" ? "✓" : opts.state === "wrong" ? "✗" : "";
    // Points earned on a correct pick, shown on the right alongside the ✓.
    const pts = opts.points
      ? `<span class="pick-points" title="Points earned">+${opts.points}</span>` : "";
    const actual = opts.actual
      ? `<span class="pick-actual" title="Actual winner">→ ${escapeHtml(shortCode(opts.actual))}</span>` : "";
    return `<div class="team-row${cls}" title="${escapeAttr(team)}">
        ${flag(team)}<span class="team-name">${escapeHtml(shortCode(team))}</span>
        ${mark ? `<span class="pick-mark">${mark}</span>` : ""}${pts}${actual}
      </div>`;
  }

  const actual = actualResults[match.id];

  if (!pred) {
    // Reality: show the real matchup (resolved from feeder winners) and
    // highlight the actual winner once it's decided; both rows are "TBD" until
    // the feeders fill in. This keeps both teams visible for a known-but-unplayed
    // match instead of collapsing to a single TBD row.
    const winner = actual || null;
    const [teamA, teamB] = actualMatchTeams(roundKey, match);
    return `<div class="match-card">
      <div class="team-stack">
        ${row(teamA, { win: !!teamA && winner === teamA })}
        ${row(teamB, { win: !!teamB && winner === teamB })}
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
  const pred = selectedPredictor
    ? computeLeaderboard().find(p => p.predictor === selectedPredictor) || null
    : null;

  root.innerHTML = renderSymmetricBracket({
    renderCard: (rk, m, side) => canvasCard(rk, m, side, pred)
  });

  // Canvas header reflects what's shown.
  const title = document.getElementById("canvas-title");
  const score = document.getElementById("canvas-score");
  if (pred) {
    title.textContent = pred.predictor;
    score.textContent = `${pred.score} pts · ${pred.correctCount}/${pred.decidedCount || 0} correct · rank #${pred.rank}`;
  } else {
    title.textContent = "Live Results";
    score.textContent = `${decidedCount()} match(es) decided`;
  }
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
    return `
      <li class="lb-entry${active}" data-name="${escapeAttr(p.predictor)}">
        <button type="button" class="lb-row" aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`Show ${p.predictor}'s bracket`)}">
          <span class="lb-rank ${medal}">${p.rank}</span>
          <span class="lb-name">${escapeHtml(p.predictor)}</span>
          <span class="lb-champ">${p.champion ? teamCell(p.champion) : ""}</span>
          <span class="lb-correct">${p.correctCount}<span class="muted">/${decided || "—"}</span></span>
          <span class="lb-score">${p.score}<span class="muted">pts</span></span>
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

  // 1) Champion distribution (FINAL pick).
  const champs = tally("FINAL");
  const champBars = champs.slice(0, 5).map(c => statBar(c.team, c.count, c.share)).join("") ||
    `<p class="muted">No champion picks yet.</p>`;

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
    .sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))   // count, then pair name
    .slice(0, 4);
  const finalHtml = topFinals.length
    ? topFinals.map(([pair, info]) =>
        `<div class="stat-line"><strong title="${escapeAttr(pair)}">${escapeHtml(shortCode(info.a))} ‹vs› ${escapeHtml(shortCode(info.b))}</strong><span class="muted">${info.count} of ${n}</span></div>`
      ).join("")
    : `<p class="muted">Not enough finalist picks yet.</p>`;

  // 3) Most divisive opener — R32 match closest to an even split.
  let divisive = null;
  for (const m of ROUNDS[0].matches) {
    const t = tally(m.id);
    if (t.length < 2) continue;
    const topShare = t[0].share;
    if (!divisive || topShare < divisive.topShare) divisive = { match: m, t, topShare };
  }
  const divisiveHtml = divisive
    ? `<div class="stat-sub muted">${divisive.match.id}</div>` +
      divisive.t.slice(0, 2).map(c => statBar(c.team, c.count, c.share)).join("")
    : `<p class="muted">No picks yet.</p>`;

  // 4) Boldest correct calls — a correct pick that ≤15% of the pool made.
  const contrarian = [];
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const actual = actualResults[m.id];
      if (!actual) continue;
      const t = tally(m.id);
      const winnerStat = t.find(x => x.team === actual);
      if (winnerStat && winnerStat.share > 0 && winnerStat.share <= 0.15) {
        for (const p of predictions) {
          if (p.picks[m.id] === actual) {
            contrarian.push({ who: p.predictor, team: actual, matchId: m.id, count: winnerStat.count });
          }
        }
      }
    }
  }
  const contrarianHtml = contrarian.length
    ? contrarian.slice(0, 6).map(c =>
        `<div class="stat-line"><span>${escapeHtml(c.who)} called ${flag(c.team)} <strong title="${escapeAttr(c.team)}">${escapeHtml(shortCode(c.team))}</strong></span><span class="muted">${c.matchId}</span></div>`
      ).join("")
    : `<p class="muted">No bold correct calls yet — check back as results come in.</p>`;

  // 5) Lone wolves — picks that exactly ONE person in the pool made (the most
  //    contrarian standing calls). Works before any results are in.
  const lone = [];
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      const t = tally(m.id);
      for (const s of t) {
        if (s.count === 1) {
          const who = predictions.find(p => p.picks[m.id] === s.team);
          if (who) lone.push({ who: who.predictor, team: s.team, matchId: m.id, round: round.key });
        }
      }
    }
  }
  // Surface the boldest (latest-round) lone calls first.
  const roundOrder = { R32: 0, R16: 1, QF: 2, SF: 3, FINAL: 4 };
  lone.sort((a, b) => roundOrder[b.round] - roundOrder[a.round]);
  const loneHtml = lone.length
    ? lone.slice(0, 6).map(c =>
        `<div class="stat-line"><span>${escapeHtml(c.who)} alone on ${flag(c.team)} <strong title="${escapeAttr(c.team)}">${escapeHtml(shortCode(c.team))}</strong></span><span class="muted">${c.matchId}</span></div>`
      ).join("")
    : `<p class="muted">No solo picks — the pool agrees so far.</p>`;

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

  // 7) Title picks by continent — fold every champion (FINAL) pick into its
  //    geographic continent, then float each share over a mini world map (and
  //    list them below as a fallback read). Shares sum to 100% of resolved picks.
  const contCounts = {};
  for (const p of predictions) {
    const c = continentOf(p.picks["FINAL"]);
    if (c) contCounts[c] = (contCounts[c] || 0) + 1;
  }
  const contTotal = Object.values(contCounts).reduce((s, x) => s + x, 0);
  // Sorted desc by count, then name — deterministic regardless of pool order.
  const contSorted = Object.entries(contCounts)
    .map(([name, count]) => ({ name, count, share: count / contTotal }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  // Each continent's centroid on the world-mini.svg (dot-matrix) viewBox, as
  // map %. Measured from the generated dot positions, not eyeballed.
  const CONTINENT_POS = {
    "North America": { left: 19, top: 28 },
    "South America": { left: 29, top: 73 },
    "Europe":        { left: 54, top: 25 },
    "Africa":        { left: 55, top: 55 },
    "Asia":          { left: 75, top: 30 },
    "Oceania":       { left: 86, top: 77 }
  };
  const continentHtml = contTotal
    ? `<div class="continent-map">
         <img src="img/world-mini.svg" alt="" aria-hidden="true">
         ${contSorted.map((c, i) => {
           const pos = CONTINENT_POS[c.name] || { left: 50, top: 50 };
           const pct = Math.round(c.share * 100);
           return `<span class="cont-chip${i === 0 ? " leader" : ""}" style="left:${pos.left}%;top:${pos.top}%;" title="${escapeAttr(c.name)}">${continentGlyph(c.name)}<b>${pct}%</b></span>`;
         }).join("")}
       </div>
       ${contSorted.map(c => continentBar(c.name, c.count, c.share)).join("")}`
    : `<p class="muted">No title picks yet.</p>`;

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
        <h3>Most divisive opener</h3>
        ${divisiveHtml}
      </div>
      <div class="stat-card">
        <h3>Boldest correct calls</h3>
        ${contrarianHtml}
      </div>
      <div class="stat-card">
        <h3>Lone wolves</h3>
        ${loneHtml}
      </div>
      <div class="stat-card stat-card-mini">
        <h3>Pool at a glance</h3>
        <div class="stat-line"><span>Brackets in</span><strong>${n}</strong></div>
        <div class="stat-line"><span>Matches decided</span><strong>${decidedCount()}</strong></div>
        <div class="stat-line"><span>Average score</span><strong>${avg.toFixed(1)}</strong></div>
        <div class="stat-line"><span>Median / top</span><strong>${median} / ${board.length ? board[0].score : 0}</strong></div>
        <div class="stat-line"><span>Chalk score</span><strong>${chalk}%</strong></div>
      </div>
      <div class="stat-card stat-card-wide">
        <h3>Title picks by continent</h3>
        ${continentHtml}
      </div>
    </div>
  `;
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

// Like statBar, but for a continent: an inline-SVG globe glyph instead of a flag.
function continentBar(name, count, share) {
  const pct = Math.round(share * 100);
  return `
    <div class="stat-bar">
      <span class="stat-bar-label">${continentGlyph(name)}<span>${escapeHtml(name)}</span></span>
      <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${pct}%"></span></span>
      <span class="stat-bar-val">${pct}% <span class="muted">(${count})</span></span>
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
      ? `Showing ${decided} result(s).`
      : "No results in yet — the bracket fills in as knockout matches finish.";
    return;
  }
  const when = new Date(resultsMeta.generatedAt);
  const nice = isNaN(when) ? resultsMeta.generatedAt
    : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  el.textContent = `Results updated ${nice} · ${decided} match(es) decided`;
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
      renderStatus(`Loaded ${predictions.length} bracket(s).`, "ok");
      refresh();
    } catch (e) {
      renderStatus(`Couldn't load brackets right now (${e.message}). Try reloading in a moment.`, "err");
    }
  } else {
    renderStatus("No Sheet URL configured — set SCRIPT_URL in assets/config.js.", "err");
  }
}
