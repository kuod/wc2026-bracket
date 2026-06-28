// ============================================================
// 2026 World Cup Knockout Predictor — leaderboard & scoring
// ============================================================
// This page is a PURE STATIC RENDERER. Results are not fetched here at view
// time: tools/update_leaderboard.py bakes them into assets/results-data.js
// (run on a schedule by a GitHub Action), and assets/results-overrides.js holds
// any hand corrections. The browser just reads those two globals, fetches
// everyone's predictions from the Google Sheet once, scores them, and renders.

// Points per round — later rounds worth more, like a real pick'em.
const ROUND_POINTS = { R32: 1, R16: 2, QF: 3, SF: 5, FINAL: 8 };

let actualResults = {};   // matchId -> winning team name (decided matches only)
let resultsMeta = null;   // the WC2026_RESULTS payload (for the "updated" stamp)
let predictions = [];

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

// ---- Rendering: ranked list + expandable per-person bracket -----------------

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
    return `
      <li class="lb-entry" data-idx="${i}">
        <button class="lb-row" aria-expanded="false">
          <span class="lb-rank ${medal}">${i + 1}</span>
          <span class="lb-name">${escapeHtml(p.predictor)}</span>
          <span class="lb-champ">${p.champion ? teamCell(p.champion) : ""}</span>
          <span class="lb-correct">${p.correctCount}<span class="muted">/${decided || "—"}</span></span>
          <span class="lb-score">${p.score}<span class="muted">pts</span></span>
          <span class="lb-caret" aria-hidden="true">▾</span>
        </button>
        <div class="lb-detail" hidden>${renderPersonBracket(p)}</div>
      </li>
    `;
  }).join("");

  root.innerHTML = `<ol class="lb-list">${rows}</ol>`;

  root.querySelectorAll(".lb-row").forEach(btn => {
    btn.addEventListener("click", () => {
      const entry = btn.closest(".lb-entry");
      const detail = entry.querySelector(".lb-detail");
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      detail.hidden = open;
      entry.classList.toggle("is-open", !open);
    });
  });
}

// One person's full bracket in round columns, each pick marked vs reality.
function renderPersonBracket(p) {
  const mark = { correct: "✓", wrong: "✗", pending: "·" };
  const cols = ROUNDS.map(round => {
    const sub = p.roundSubtotals[round.key];
    const cards = round.matches.map(match => {
      const guess = p.picks[match.id];
      const actual = actualResults[match.id];
      const state = pickState(match.id, guess);
      const showActual = state === "wrong" && actual;
      return `
        <div class="pb-pick pb-${state}">
          <span class="pb-mark">${mark[state]}</span>
          <span class="pb-guess">${guess ? teamCell(guess) : `<span class="muted">no pick</span>`}</span>
          ${showActual ? `<span class="pb-actual">→ ${teamCell(actual)}</span>` : ""}
        </div>
      `;
    }).join("");
    return `
      <div class="pb-col">
        <div class="pb-col-head">
          <span>${round.label}</span>
          <span class="muted">${sub.correct}/${sub.decided || 0}</span>
        </div>
        ${cards}
      </div>
    `;
  }).join("");
  return `<div class="pb-board">${cols}</div>`;
}

// ---- Pool stats -------------------------------------------------------------

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

  // Champion distribution (FINAL pick).
  const champs = tally("FINAL");
  const champBars = champs.map(c => statBar(c.team, c.count, c.share)).join("") ||
    `<p class="muted">No champion picks yet.</p>`;

  // Most common predicted Final matchup (unordered pair of FINAL feeders).
  const finalMatch = ROUNDS.find(r => r.key === "FINAL").matches[0];
  const finalPairs = {};
  for (const p of predictions) {
    const a = p.picks[finalMatch.from[0]];
    const b = p.picks[finalMatch.from[1]];
    if (!a || !b) continue;
    const key = [a, b].sort().join(" ‹vs› ");
    finalPairs[key] = (finalPairs[key] || 0) + 1;
  }
  const topFinal = Object.entries(finalPairs).sort((x, y) => y[1] - x[1])[0];
  const finalHtml = topFinal
    ? `<div class="stat-line"><strong>${escapeHtml(topFinal[0])}</strong><span class="muted">${topFinal[1]} of ${n}</span></div>`
    : `<p class="muted">Not enough finalist picks yet.</p>`;

  // Most divisive R32 match — closest to an even split (entropy-ish: min top share).
  let divisive = null;
  for (const m of ROUNDS[0].matches) {
    const t = tally(m.id);
    if (t.length < 2) continue;
    const topShare = t[0].share;
    if (!divisive || topShare < divisive.topShare) divisive = { match: m, t, topShare };
  }
  const divisiveHtml = divisive
    ? `<div class="stat-sub muted">${divisive.match.id}</div>` +
      divisive.t.map(c => statBar(c.team, c.count, c.share)).join("")
    : `<p class="muted">No picks yet.</p>`;

  // Contrarian-correct: a correct pick that ≤15% of the pool made.
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
            contrarian.push({ who: p.predictor, team: actual, matchId: m.id,
                              count: winnerStat.count });
          }
        }
      }
    }
  }
  const contrarianHtml = contrarian.length
    ? contrarian.slice(0, 8).map(c =>
        `<div class="stat-line"><span>${escapeHtml(c.who)} called ${flag(c.team)} <strong>${escapeHtml(c.team)}</strong></span><span class="muted">${c.matchId} · ${c.count} of ${n}</span></div>`
      ).join("")
    : `<p class="muted">No bold correct calls yet — check back as results come in.</p>`;

  // Score distribution summary.
  const board = computeLeaderboard();
  const scores = board.map(p => p.score).sort((a, b) => a - b);
  const avg = scores.length ? (scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
  const median = scores.length
    ? (scores.length % 2 ? scores[(scores.length - 1) / 2]
       : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : 0;

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <h3>Who they're backing for the title</h3>
        ${champBars}
      </div>
      <div class="stat-card">
        <h3>Most-predicted Final</h3>
        ${finalHtml}
        <h3 style="margin-top:18px;">Most divisive opener</h3>
        ${divisiveHtml}
      </div>
      <div class="stat-card">
        <h3>Boldest correct calls</h3>
        ${contrarianHtml}
      </div>
      <div class="stat-card stat-card-mini">
        <h3>Pool at a glance</h3>
        <div class="stat-line"><span>Brackets in</span><strong>${n}</strong></div>
        <div class="stat-line"><span>Matches decided</span><strong>${decidedCount()}</strong></div>
        <div class="stat-line"><span>Average score</span><strong>${avg.toFixed(1)}</strong></div>
        <div class="stat-line"><span>Median score</span><strong>${median}</strong></div>
        <div class="stat-line"><span>Top score</span><strong>${board.length ? board[0].score : 0}</strong></div>
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
  renderLeaderboard();
  renderPoolStats();

  const refresh = () => { renderLeaderboard(); renderPoolStats(); renderUpdatedStamp(); };

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
