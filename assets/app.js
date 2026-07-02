// ============================================================
// 2026 World Cup Knockout Predictor — predictor app logic
// ============================================================
// The bracket is drawn by renderSymmetricBracket() (in bracket-data.js, shared
// with the leaderboard). This file owns the interactive picking: the cascade,
// autosave, submit-to-Sheet, and progress — all keyed off the `from:[...]`
// feeder graph, which is never changed here.

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
    // If pruning dropped any now-illegal picks, persist the cleaned draft so
    // they don't silently reappear on the next reload.
    if (pruneInvalidPicks()) saveDraft();
  } catch (e) { /* ignore corrupt draft */ }
}

function saveDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: predictorName, picks }));
}

// Resolve the two team names for a match. R32 teams are fixed; later rounds get
// their teams from the winners picked in the matches listed in `from`.
function getMatchTeams(roundKey, match) {
  if (roundKey === "R32") {
    return [match.teamA, match.teamB];
  }
  const [fromA, fromB] = match.from;
  return [picks[fromA] || null, picks[fromB] || null];
}

// Drop any saved pick that's no longer legal in the current bracket — e.g. a
// stored R32 winner whose matchup was corrected after the draft was saved.
// ROUNDS is walked in order, so once a feeder pick is pruned the downstream
// match sees an empty slot and its now-orphaned pick is pruned in the same pass.
// Returns true if anything was removed.
function pruneInvalidPicks() {
  let removed = false;
  for (const round of ROUNDS) {
    for (const m of round.matches) {
      if (!picks[m.id]) continue;
      const [a, b] = getMatchTeams(round.key, m);
      if (picks[m.id] !== a && picks[m.id] !== b) { delete picks[m.id]; removed = true; }
    }
  }
  return removed;
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
        const teams = getMatchTeams(round.key, m);
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

function escapeAttr(s) {
  // Escape & before " so an existing entity isn't double-encoded and a value
  // can't break out of the double-quoted attribute context. (Mirrors the helper
  // in score-app.js.) Team names are controlled today, but keep it robust.
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// One match cell for the symmetric bracket: two pickable team rows. In the
// cramped Round-of-32 columns the visible label is the 3-letter code (full name
// in the tooltip); from R16 inward, where columns are wider, full names show.
function renderCard(roundKey, match, side) {
  const [teamA, teamB] = getMatchTeams(roundKey, match);
  const picked = picks[match.id];

  function teamRowHtml(team) {
    if (!team) {
      return `<div class="team-row empty"><span class="team-name">TBD</span></div>`;
    }
    const selected = picked === team ? " selected" : "";
    // Three-letter codes throughout the bracket; full name in the tooltip.
    const label = escapeHtml(shortCode(team));
    // The visible label is a 3-letter code, so give screen readers the full
    // team name + match as the accessible action ("Pick Canada for R32-1").
    const aria = escapeAttr(`Pick ${team} for ${match.id}`);
    return `<button class="team-row${selected}" data-match="${match.id}" data-team="${escapeAttr(team)}" title="${escapeAttr(team)}" aria-label="${aria}" aria-pressed="${picked === team}">
        ${flag(team)}<span class="team-name">${label}</span>
        <span class="pick-dot" aria-hidden="true"></span>
      </button>`;
  }

  return `<div class="match-card${picked ? " is-picked" : ""}">
      <div class="team-stack">
        ${teamRowHtml(teamA)}
        ${teamRowHtml(teamB)}
      </div>
    </div>`;
}

function render() {
  const root = document.getElementById("bracket-root");
  if (!root) return;
  root.innerHTML = renderSymmetricBracket({ renderCard });

  root.querySelectorAll(".team-row[data-match]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectTeam(btn.getAttribute("data-match"), btn.getAttribute("data-team"));
    });
  });

  const { done, total } = totalProgress();
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
  if (label) label.textContent = `${done} / ${total}`;

  const nameInput = document.getElementById("predictor-name");
  const submitBtn = document.getElementById("submit-btn");
  // Sync the input from state BEFORE the disabled check, and gate on
  // predictorName (the source of truth) rather than the live DOM value —
  // otherwise a restored complete draft loads with Submit stuck disabled,
  // because on first render the input hasn't been repopulated yet.
  if (nameInput && nameInput.value !== predictorName) nameInput.value = predictorName;
  // Submissions hard-close once the Round of 32 is complete (anti-cheat backstop).
  // After that the button stays disabled no matter how complete the bracket is,
  // and a hint explains why. (Client-clock check — UX only; the leaderboard is
  // the real enforcement, against the trusted server timestamp.)
  const closed = submissionsClosed();
  if (submitBtn) {
    submitBtn.disabled = closed || done < total || !predictorName.trim();
    if (closed) submitBtn.textContent = "Submissions closed";
  }
  const hint = document.getElementById("submit-hint");
  if (hint) hint.hidden = !closed;
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

function showToast(title, message, kind, payload) {
  const toast = document.getElementById("submit-toast");
  if (!toast) return;
  document.getElementById("submit-toast-title").textContent = title;
  const statusEl = document.getElementById("submit-status");
  statusEl.textContent = message;
  statusEl.className = kind === "err" ? "submit-status-err" : "submit-status-ok";
  document.getElementById("submit-json-preview").textContent = JSON.stringify(payload, null, 2);
  toast.hidden = false;
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
    // Backstop: never POST once submissions have closed, even if the button
    // somehow fired. render() keeps it disabled + relabeled past the cutoff.
    if (submissionsClosed()) { render(); return; }
    const payload = buildPredictionPayload();
    const submitBtn = document.getElementById("submit-btn");

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    try {
      await submitToSheet(payload);
      showToast("Bracket submitted!", "Your picks are in — saved to the pool's Google Sheet.", "ok", payload);
    } catch (err) {
      showToast("Submission failed", `${err.message}. Copy your JSON as a backup.`, "err", payload);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
      render();
    }
  });

  document.getElementById("submit-toast-close").addEventListener("click", () => {
    document.getElementById("submit-toast").hidden = true;
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

  // Watch for code pushes (version-check.js polls version.json). The predictor
  // doesn't render results, so it ignores results changes; on a code change we
  // only NUDGE rather than auto-reload — picks may be mid-edit. (Drafts live in
  // localStorage, so a refresh is safe, but a surprise reload is jarring.)
  if (typeof startVersionWatch === "function") {
    startVersionWatch({
      onSiteChanged: () => showUpdateNudge("A new version is available — refresh when you're ready.")
    });
  }
}
