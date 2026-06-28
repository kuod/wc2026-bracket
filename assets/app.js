// ============================================================
// 2026 World Cup Knockout Predictor — predictor app logic
// ============================================================

const STORAGE_KEY = "wc2026-predictions-draft";

let picks = {};
let predictorName = "";

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    picks = parsed.picks || {};
    predictorName = parsed.name || "";
  } catch (e) { /* ignore corrupt draft */ }
}

function saveDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: predictorName, picks }));
}

// Resolve the two team names for a given match, given current picks.
// For R32 matches, teams are fixed. For later rounds, teams come from
// the winners picked in the matches listed in `from`.
function getMatchTeams(round, match) {
  if (round.key === "R32") {
    return [match.teamA, match.teamB];
  }
  const [fromA, fromB] = match.from;
  return [picks[fromA] || null, picks[fromB] || null];
}

function matchIsReady(round, match) {
  const [a, b] = getMatchTeams(round, match);
  return Boolean(a) && Boolean(b);
}

function roundCompletionCount(round) {
  let done = 0;
  round.matches.forEach(m => { if (picks[m.id]) done++; });
  return done;
}

function totalProgress() {
  const allMatches = ROUNDS.flatMap(r => r.matches);
  const total = allMatches.length;
  const done = allMatches.filter(m => picks[m.id]).length;
  return { done, total };
}

function clearDownstreamPicks(matchId) {
  // If a pick changes, any later-round pick that depended on it must clear.
  let changed = true;
  while (changed) {
    changed = false;
    for (const round of ROUNDS) {
      if (round.key === "R32") continue;
      for (const m of round.matches) {
        const teams = getMatchTeams(round, m);
        if (picks[m.id] && (!teams[0] || !teams[1] || (picks[m.id] !== teams[0] && picks[m.id] !== teams[1]))) {
          delete picks[m.id];
          changed = true;
        }
      }
    }
  }
}

function selectTeam(matchId, team) {
  picks[matchId] = team;
  clearDownstreamPicks(matchId);
  saveDraft();
  render();
}

function renderMatch(round, match) {
  const [teamA, teamB] = getMatchTeams(round, match);
  const picked = picks[match.id];

  const metaLine = round.key === "R32"
    ? `<span class="match-id-tag">${match.id}</span><span>${match.date} · ${match.venue}</span>`
    : `<span class="match-id-tag">${match.id}</span><span>Winners advance here</span>`;

  function teamBtnHtml(team) {
    if (!team) {
      return `<button class="team-btn empty" disabled>TBD</button>`;
    }
    const selected = picked === team ? "selected" : "";
    return `<button class="team-btn ${selected}" data-match="${match.id}" data-team="${escapeAttr(team)}">
      <span class="flag">${flag(team)}</span><span>${team}</span>
    </button>`;
  }

  return `
    <div class="match" data-match-id="${match.id}">
      <div class="meta">${metaLine}</div>
      <div class="team-options">
        ${teamBtnHtml(teamA)}
        <span class="vs-divider">VS</span>
        ${teamBtnHtml(teamB)}
      </div>
    </div>
  `;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function renderRound(round) {
  const done = roundCompletionCount(round);
  const total = round.matches.length;
  const lockedNote = round.key === "R32"
    ? ""
    : `<div class="round-locked-note">Matchups fill in automatically as you pick winners in earlier rounds.</div>`;

  return `
    <section class="round-section" id="round-${round.key}">
      <div class="round-header">
        <h2>${round.label}</h2>
        <span class="count">${done} / ${total} picked</span>
      </div>
      ${lockedNote}
      ${round.matches.map(m => renderMatch(round, m)).join("")}
    </section>
  `;
}

function render() {
  const root = document.getElementById("bracket-root");
  if (!root) return;
  root.innerHTML = ROUNDS.map(renderRound).join("");

  root.querySelectorAll(".team-btn[data-match]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectTeam(btn.getAttribute("data-match"), btn.getAttribute("data-team"));
    });
  });

  const { done, total } = totalProgress();
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  if (fill) fill.style.width = `${Math.round((done/total)*100)}%`;
  if (label) label.textContent = `${done} / ${total} picks made`;

  const submitBtn = document.getElementById("submit-btn");
  if (submitBtn) submitBtn.disabled = done < total || !document.getElementById("predictor-name").value.trim();

  const nameInput = document.getElementById("predictor-name");
  if (nameInput && nameInput.value !== predictorName) nameInput.value = predictorName;
}

function buildPredictionPayload() {
  return {
    schema: "wc2026-prediction-v1",
    submittedAt: new Date().toISOString(),
    predictor: predictorName,
    picks: { ...picks }
  };
}

async function submitToSheet(payload) {
  if (!SCRIPT_URL) {
    throw new Error("SCRIPT_URL is not configured in assets/config.js.");
  }
  // Apps Script web apps redirect POST requests, which causes browsers to lose
  // the body. Using no-cors avoids the preflight and lets the POST go through.
  // We can't read the response in this mode, so we assume success on resolve.
  await fetch(SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });
}

function initPredictorPage() {
  loadDraft();

  const nameInput = document.getElementById("predictor-name");
  nameInput.addEventListener("input", () => {
    predictorName = nameInput.value;
    saveDraft();
    render();
  });

  document.getElementById("submit-btn").addEventListener("click", async () => {
    const payload = buildPredictionPayload();
    const submitBtn = document.getElementById("submit-btn");
    const statusEl = document.getElementById("submit-status");

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    statusEl.textContent = "";
    statusEl.className = "";

    try {
      await submitToSheet(payload);
      document.getElementById("submit-json-preview").textContent = JSON.stringify(payload, null, 2);
      document.getElementById("submit-panel").style.display = "block";
      document.getElementById("submit-panel").scrollIntoView({ behavior: "smooth" });
      statusEl.textContent = "Your picks are in!";
      statusEl.className = "submit-status-ok";
    } catch (err) {
      statusEl.textContent = `Submission failed: ${err.message}. Copy your JSON below as a backup.`;
      statusEl.className = "submit-status-err";
      document.getElementById("submit-json-preview").textContent = JSON.stringify(payload, null, 2);
      document.getElementById("submit-panel").style.display = "block";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit My Bracket";
    }
  });

  document.getElementById("copy-json-btn").addEventListener("click", () => {
    const payload = buildPredictionPayload();
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    const btn = document.getElementById("copy-json-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("Clear all your picks and start over?")) return;
    picks = {};
    saveDraft();
    render();
  });

  render();
}
