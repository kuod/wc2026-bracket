// ============================================================
// 2026 World Cup Knockout Predictor — scoring logic
// ============================================================

// Points per round — later rounds worth more, like a real pick'em.
const ROUND_POINTS = { R32: 1, R16: 2, QF: 3, SF: 5, FINAL: 8 };

const RESULTS_STORAGE_KEY = "wc2026-actual-results"; // local override stored in this browser

let actualResults = {};   // matchId -> winning team name (only what's known so far)
let predictions = [];     // [{ predictor, picks, issueUrl, submittedAt }]

function roundForMatch(matchId) {
  return ROUNDS.find(r => r.matches.some(m => m.id === matchId));
}

function loadLocalResults() {
  try {
    const raw = localStorage.getItem(RESULTS_STORAGE_KEY);
    if (raw) actualResults = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

function saveLocalResults() {
  localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(actualResults));
}

// Extract the fenced ```json ... ``` block from a GitHub issue body and parse it.
function parsePredictionFromIssueBody(body) {
  const match = body.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    if (payload.schema !== "wc2026-prediction-v1") return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function fetchPredictionsFromGithub(repo) {
  const perPage = 100;
  let page = 1;
  let all = [];
  while (true) {
    const url = `https://api.github.com/repos/${repo}/issues?labels=prediction&state=all&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { "Accept": "application/vnd.github+json" } });
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < perPage) break;
    page++;
    if (page > 10) break; // safety valve
  }

  const parsed = [];
  for (const issue of all) {
    const payload = parsePredictionFromIssueBody(issue.body || "");
    if (!payload) continue;
    parsed.push({
      predictor: payload.predictor || issue.user?.login || "Unknown",
      picks: payload.picks || {},
      submittedAt: payload.submittedAt || issue.created_at,
      issueUrl: issue.html_url,
      issueNumber: issue.number
    });
  }
  return parsed;
}

function loadPredictionsFromPastedJson(text) {
  // Accepts either a single payload object, or an array of payload objects,
  // one per line or as a JSON array — be forgiving.
  const out = [];
  const tryParseOne = (obj) => {
    if (obj && obj.schema === "wc2026-prediction-v1") {
      out.push({
        predictor: obj.predictor || "Unknown",
        picks: obj.picks || {},
        submittedAt: obj.submittedAt,
        issueUrl: null
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

function scorePrediction(pred) {
  let score = 0;
  const breakdown = [];
  for (const round of ROUNDS) {
    for (const match of round.matches) {
      const guess = pred.picks[match.id];
      const actual = actualResults[match.id];
      if (!guess || !actual) continue;
      const correct = guess === actual;
      if (correct) score += ROUND_POINTS[round.key];
      breakdown.push({ matchId: match.id, round: round.key, guess, actual, correct });
    }
  }
  return { score, breakdown };
}

function computeLeaderboard() {
  return predictions
    .map(pred => {
      const { score, breakdown } = scorePrediction(pred);
      const correctCount = breakdown.filter(b => b.correct).length;
      const scoredCount = breakdown.length;
      return { ...pred, score, breakdown, correctCount, scoredCount };
    })
    .sort((a, b) => b.score - a.score);
}

function renderResultsEditor() {
  const root = document.getElementById("results-editor-root");
  if (!root) return;
  root.innerHTML = ROUNDS.map(round => `
    <div class="round-section" style="margin-top:28px;">
      <div class="round-header"><h2>${round.label}</h2></div>
      ${round.matches.map(match => {
        const teams = match.from
          ? [actualResults[match.from[0]] || null, actualResults[match.from[1]] || null]
          : [match.teamA, match.teamB];
        const current = actualResults[match.id] || "";
        return `
          <div class="match" data-match-id="${match.id}">
            <div class="meta"><span class="match-id-tag">${match.id}</span><span>Winner</span></div>
            <div class="team-options">
              ${renderResultBtn(match.id, teams[0], current)}
              <span class="vs-divider">VS</span>
              ${renderResultBtn(match.id, teams[1], current)}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `).join("");

  root.querySelectorAll(".team-btn[data-match]").forEach(btn => {
    btn.addEventListener("click", () => {
      const matchId = btn.getAttribute("data-match");
      const team = btn.getAttribute("data-team");
      if (actualResults[matchId] === team) {
        delete actualResults[matchId]; // toggle off
      } else {
        actualResults[matchId] = team;
      }
      saveLocalResults();
      renderResultsEditor();
      renderLeaderboard();
    });
  });
}

function renderResultBtn(matchId, team, current) {
  if (!team) return `<button class="team-btn empty" disabled>TBD</button>`;
  const selected = current === team ? "selected" : "";
  return `<button class="team-btn ${selected}" data-match="${matchId}" data-team="${team.replace(/"/g,'&quot;')}">
    <span class="flag">${flag(team)}</span><span>${escapeHtml(team)}</span>
  </button>`;
}

function renderLeaderboard() {
  const root = document.getElementById("leaderboard-root");
  if (!root) return;
  const board = computeLeaderboard();

  if (board.length === 0) {
    root.innerHTML = `<p style="color:rgba(246,243,234,0.6); font-size:14px;">No predictions loaded yet. Load them from GitHub Issues or paste JSON above.</p>`;
    return;
  }

  root.innerHTML = `
    <table class="leaderboard">
      <thead>
        <tr><th>Rank</th><th>Predictor</th><th>Score</th><th>Correct picks</th><th></th></tr>
      </thead>
      <tbody>
        ${board.map((p, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>${escapeHtml(p.predictor)}${p.issueUrl ? ` <a href="${p.issueUrl}" target="_blank" class="badge">issue #${p.issueNumber}</a>` : ""}</td>
            <td class="score">${p.score} pts</td>
            <td>${p.correctCount} / ${p.scoredCount || "—"}</td>
            <td><button class="btn btn-ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleDetail(${i})">Details</button></td>
          </tr>
          <tr id="detail-${i}" style="display:none;">
            <td colspan="5">
              ${renderDetailRows(p.breakdown)}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderDetailRows(breakdown) {
  if (breakdown.length === 0) return `<span style="color:rgba(246,243,234,0.5); font-size:13px;">No matches scored yet.</span>`;
  return `
    <div style="display:flex; flex-direction:column; gap:4px; padding:8px 0;">
      ${breakdown.map(b => `
        <div style="font-family:var(--font-mono); font-size:12px; display:flex; gap:10px; color:${b.correct ? 'var(--gold-bright)' : 'rgba(246,243,234,0.45)'};">
          <span style="width:60px;">${b.matchId}</span>
          <span style="width:24px;">${b.correct ? "✓" : "✗"}</span>
          <span>picked ${flag(b.guess)} ${escapeHtml(b.guess)} — actual ${flag(b.actual)} ${escapeHtml(b.actual)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function toggleDetail(i) {
  const row = document.getElementById(`detail-${i}`);
  if (row) row.style.display = row.style.display === "none" ? "table-row" : "none";
}

async function initScorePage() {
  loadLocalResults();
  renderResultsEditor();
  renderLeaderboard();

  document.getElementById("load-github-btn").addEventListener("click", async () => {
    const repoInput = document.getElementById("repo-input");
    const repo = repoInput.value.trim();
    const statusEl = document.getElementById("load-status");
    if (!repo) { statusEl.textContent = "Enter a repo first, like username/wc2026-bracket."; return; }
    statusEl.textContent = "Loading predictions from GitHub Issues…";
    try {
      predictions = await fetchPredictionsFromGithub(repo);
      statusEl.textContent = `Loaded ${predictions.length} prediction(s) from ${repo}.`;
      renderLeaderboard();
    } catch (e) {
      statusEl.textContent = `Couldn't load issues: ${e.message}`;
    }
  });

  document.getElementById("load-paste-btn").addEventListener("click", () => {
    const text = document.getElementById("paste-json-input").value;
    const statusEl = document.getElementById("load-status");
    try {
      const fromPaste = loadPredictionsFromPastedJson(text);
      // merge, replacing any existing entries with the same predictor name
      const byName = new Map(predictions.map(p => [p.predictor, p]));
      fromPaste.forEach(p => byName.set(p.predictor, p));
      predictions = Array.from(byName.values());
      statusEl.textContent = `Loaded ${fromPaste.length} prediction(s) from pasted JSON. Total: ${predictions.length}.`;
      renderLeaderboard();
    } catch (e) {
      statusEl.textContent = e.message;
    }
  });

  document.getElementById("clear-results-btn").addEventListener("click", () => {
    if (!confirm("Clear all entered match results?")) return;
    actualResults = {};
    saveLocalResults();
    renderResultsEditor();
    renderLeaderboard();
  });
}
