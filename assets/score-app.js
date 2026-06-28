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
  actualResults = out;
}

function decidedCount() {
  return Object.keys(actualResults).length;
}

// ---- Predictions: auto-fetch from the Sheet; paste box as fallback ----------

async function fetchPredictionsFromSheet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const MATCH_IDS = ROUNDS.flatMap(r => r.matches.map(m => m.id));
  return (data.predictions || []).map(row => ({
    predictor: row.predictor || "Unknown",
    submittedAt: row.submittedAt || "",
    picks: Object.fromEntries(
      MATCH_IDS.map(id => [id, row[id] || undefined]).filter(([, v]) => v)
    )
  }));
}

function loadPredictionsFromPastedJson(text) {
  const out = [];
  const tryParseOne = (obj) => {
    if (obj && obj.schema === "wc2026-prediction-v1") {
      out.push({
        predictor: obj.predictor || "Unknown",
        picks: obj.picks || {},
        submittedAt: obj.submittedAt
      });
    }
  };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Couldn't parse that as JSON. Paste one prediction object or a JSON array of them.");
  }
  if (Array.isArray(data)) data.forEach(tryParseOne);
  else tryParseOne(data);
  if (out.length === 0) throw new Error("No valid wc2026-prediction-v1 payloads found in that text.");
  return out;
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
  return predictions
    .map(pred => {
      const { score, breakdown, roundSubtotals } = scorePrediction(pred);
      const correctCount = breakdown.filter(b => b.state === "correct").length;
      const decidedCount = breakdown.filter(b => b.actual).length;
      return { ...pred, score, breakdown, roundSubtotals, correctCount, decidedCount,
               champion: pred.picks["FINAL"] || null };
    })
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount
                    || a.predictor.localeCompare(b.predictor));
}

// ---- The bracket canvas (reality <-> selected person) -----------------------

// One match cell. In "reality" mode it shows the actual winner; in "person"
// mode it shows that predictor's pick, styled correct / wrong / pending.
function canvasCard(roundKey, match, side, pred) {
  function row(team, opts) {
    if (!team) return `<div class="team-row empty"><span class="team-name">TBD</span></div>`;
    const cls = opts && opts.state ? ` pick-${opts.state}` : (opts && opts.win ? " selected" : "");
    const mark = opts && opts.state === "correct" ? "✓" : opts && opts.state === "wrong" ? "✗" : "";
    const actual = opts && opts.actual
      ? `<span class="pick-actual" title="Actual winner">→ ${escapeHtml(shortCode(opts.actual))}</span>` : "";
    return `<div class="team-row${cls}" title="${escapeAttr(team)}">
        ${flag(team)}<span class="team-name">${escapeHtml(shortCode(team))}</span>
        ${mark ? `<span class="pick-mark">${mark}</span>` : ""}${actual}
      </div>`;
  }

  const actual = actualResults[match.id];

  if (!pred) {
    // Reality: highlight the actual winner; the loser shown muted; TBD if undecided.
    const winner = actual || null;
    if (roundKey === "R32") {
      return `<div class="match-card">
        <div class="team-stack">
          ${row(match.teamA, { win: winner === match.teamA })}
          ${row(match.teamB, { win: winner === match.teamB })}
        </div></div>`;
    }
    // Later rounds in reality view: show the winner (if known) on top, else TBD.
    return `<div class="match-card">
      <div class="team-stack">
        ${row(winner, { win: !!winner })}
        ${row(null)}
      </div></div>`;
  }

  // Person view: show this predictor's pick for the match, marked vs reality.
  const guess = pred.picks[match.id];
  const state = pickState(match.id, guess);
  const showActual = state === "wrong" && actual ? actual : null;
  // Show only the predictor's pick (one row) so the canvas reads as their path.
  return `<div class="match-card">
    <div class="team-stack">
      ${row(guess, { state, actual: showActual })}
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
    const board = computeLeaderboard();
    const rank = board.findIndex(p => p.predictor === pred.predictor) + 1;
    title.textContent = pred.predictor;
    score.textContent = `${pred.score} pts · ${pred.correctCount}/${pred.decidedCount || 0} correct · rank #${rank}`;
  } else {
    title.textContent = "Live Results";
    score.textContent = `${decidedCount()} match(es) decided`;
  }
}

// ---- Ranked list (a selector that drives the canvas) ------------------------

function teamCell(team) {
  if (!team) return `<span class="lb-team muted">—</span>`;
  return `<span class="lb-team">${flag(team)}<span>${escapeHtml(team)}</span></span>`;
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
  const rows = board.map((p, i) => {
    const medal = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    const active = p.predictor === selectedPredictor ? " is-active" : "";
    return `
      <li class="lb-entry${active}" data-name="${escapeAttr(p.predictor)}">
        <button class="lb-row">
          <span class="lb-rank ${medal}">${i + 1}</span>
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
    .sort((a, b) => b.count - a.count);
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
    const key = [a, b].sort().join(" ‹vs› ");
    finalPairs[key] = (finalPairs[key] || 0) + 1;
  }
  const topFinals = Object.entries(finalPairs).sort((x, y) => y[1] - x[1]).slice(0, 4);
  const finalHtml = topFinals.length
    ? topFinals.map(([pair, count]) =>
        `<div class="stat-line"><strong>${escapeHtml(pair)}</strong><span class="muted">${count} of ${n}</span></div>`
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
        `<div class="stat-line"><span>${escapeHtml(c.who)} called ${flag(c.team)} <strong>${escapeHtml(c.team)}</strong></span><span class="muted">${c.matchId}</span></div>`
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
        `<div class="stat-line"><span>${escapeHtml(c.who)} alone on ${flag(c.team)} <strong>${escapeHtml(c.team)}</strong></span><span class="muted">${c.matchId}</span></div>`
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
    </div>
  `;
}

function statBar(team, count, share) {
  const pct = Math.round(share * 100);
  return `
    <div class="stat-bar">
      <span class="stat-bar-label">${flag(team)}<span>${escapeHtml(team)}</span></span>
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

  // Auto-load everyone's predictions from the Google Sheet.
  if (typeof SCRIPT_URL === "string" && SCRIPT_URL) {
    renderStatus("Loading brackets…");
    try {
      predictions = await fetchPredictionsFromSheet(SCRIPT_URL);
      renderStatus(`Loaded ${predictions.length} bracket(s).`, "ok");
      refresh();
    } catch (e) {
      renderStatus(`Couldn't load brackets automatically (${e.message}). Paste JSON below instead.`, "err");
    }
  } else {
    renderStatus("No Sheet URL configured — paste bracket JSON below to score.", "err");
  }

  const pasteBtn = document.getElementById("load-paste-btn");
  if (pasteBtn) {
    pasteBtn.addEventListener("click", () => {
      const text = document.getElementById("paste-json-input").value;
      try {
        const fromPaste = loadPredictionsFromPastedJson(text);
        const byName = new Map(predictions.map(p => [p.predictor, p]));
        fromPaste.forEach(p => byName.set(p.predictor, p));
        predictions = Array.from(byName.values());
        renderStatus(`Added ${fromPaste.length} bracket(s) from pasted JSON. Total: ${predictions.length}.`, "ok");
        refresh();
      } catch (e) {
        renderStatus(e.message, "err");
      }
    });
  }
}
