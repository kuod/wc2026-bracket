// 2026 FIFA World Cup — Knockout Stage bracket data
// Round of 32 matchups confirmed as of June 28, 2026 (group stage complete).
// Source: FIFA / major outlets coverage of the finalized Round of 32 draw.

// ISO 3166-1 alpha-2 codes (lowercase) used to build flagcdn image URLs.
// Home nations (England/Scotland/Wales) use flagcdn's "gb-eng" style codes.
// Image flags render identically across Windows/Mac/iOS/Android, unlike
// Unicode flag emoji which Windows browsers show as bare letter boxes.
const TEAM_CODES = {
  "South Africa": "za",
  "Canada": "ca",
  "Brazil": "br",
  "Japan": "jp",
  "Germany": "de",
  "Paraguay": "py",
  "Netherlands": "nl",
  "Morocco": "ma",
  "Ivory Coast": "ci",
  "Norway": "no",
  "France": "fr",
  "Sweden": "se",
  "Mexico": "mx",
  "Ecuador": "ec",
  "England": "gb-eng",
  "DR Congo": "cd",
  "Belgium": "be",
  "Senegal": "sn",
  "United States": "us",
  "Bosnia and Herzegovina": "ba",
  "Spain": "es",
  "Austria": "at",
  "Switzerland": "ch",
  "Algeria": "dz",
  "Portugal": "pt",
  "Croatia": "hr",
  "Australia": "au",
  "Egypt": "eg",
  "Argentina": "ar",
  "Cape Verde": "cv",
  "Colombia": "co",
  "Ghana": "gh"
};

// FIFA three-letter team codes (trigrammes). Shown in the cramped Round-of-32
// columns of the symmetric bracket, where full names can't fit. Distinct from
// TEAM_CODES above, which holds ISO alpha-2 codes used only for flag image URLs.
const TEAM_SHORT = {
  "South Africa": "RSA", "Canada": "CAN", "Brazil": "BRA", "Japan": "JPN",
  "Germany": "GER", "Paraguay": "PAR", "Netherlands": "NED", "Morocco": "MAR",
  "Ivory Coast": "CIV", "Norway": "NOR", "France": "FRA", "Sweden": "SWE",
  "Mexico": "MEX", "Ecuador": "ECU", "England": "ENG", "DR Congo": "COD",
  "Belgium": "BEL", "Senegal": "SEN", "United States": "USA",
  "Bosnia and Herzegovina": "BIH", "Spain": "ESP", "Austria": "AUT",
  "Switzerland": "SUI", "Algeria": "ALG", "Portugal": "POR", "Croatia": "CRO",
  "Australia": "AUS", "Egypt": "EGY", "Argentina": "ARG", "Cape Verde": "CPV",
  "Colombia": "COL", "Ghana": "GHA"
};

// TheSportsDB (and other feeds) name some teams differently from our canonical
// display names. Map their spelling -> ours. Keys are matched after running
// normalizeTeam() on both sides, so accents/case/punctuation don't matter here.
const TEAMDB_ALIASES = {
  "usa": "United States",
  "united states of america": "United States",
  "cote divoire": "Ivory Coast",
  "cote d ivoire": "Ivory Coast",
  "ivory coast": "Ivory Coast",
  "cabo verde": "Cape Verde",
  "congo dr": "DR Congo",
  "democratic republic of the congo": "DR Congo",
  "dr congo": "DR Congo",
  "bosnia herzegovina": "Bosnia and Herzegovina",
  "bosnia and herzegovina": "Bosnia and Herzegovina"
};

// Each match has a stable id used as the key in prediction JSON.
// "slot" describes where the winner feeds into in the next round (R16 match id + side).
const ROUND_OF_32 = [
  { id: "R32-1",  date: "Jun 28", venue: "SoFi Stadium, Inglewood",        teamA: "South Africa",  teamB: "Canada" },
  { id: "R32-2",  date: "Jun 29", venue: "NRG Stadium, Houston",           teamA: "Brazil",         teamB: "Japan" },
  { id: "R32-3",  date: "Jun 29", venue: "Gillette Stadium, Foxborough",   teamA: "Germany",        teamB: "Paraguay" },
  { id: "R32-4",  date: "Jun 29", venue: "Estadio BBVA, Monterrey",        teamA: "Netherlands",    teamB: "Morocco" },
  { id: "R32-5",  date: "Jun 30", venue: "AT&T Stadium, Arlington",        teamA: "Ivory Coast",    teamB: "Norway" },
  { id: "R32-6",  date: "Jun 30", venue: "MetLife Stadium, East Rutherford", teamA: "France",       teamB: "Sweden" },
  { id: "R32-7",  date: "Jun 30", venue: "Estadio Azteca, Mexico City",    teamA: "Mexico",         teamB: "Ecuador" },
  { id: "R32-8",  date: "Jul 1",  venue: "Mercedes-Benz Stadium, Atlanta", teamA: "England",        teamB: "DR Congo" },
  { id: "R32-9",  date: "Jul 1",  venue: "Lumen Field, Seattle",           teamA: "Belgium",        teamB: "Senegal" },
  { id: "R32-10", date: "Jul 1",  venue: "Levi's Stadium, Santa Clara",    teamA: "United States",  teamB: "Bosnia and Herzegovina" },
  { id: "R32-11", date: "Jul 2",  venue: "SoFi Stadium, Inglewood",        teamA: "Spain",          teamB: "Austria" },
  { id: "R32-12", date: "Jul 2",  venue: "BC Place, Vancouver",            teamA: "Switzerland",    teamB: "Algeria" },
  { id: "R32-13", date: "Jul 2",  venue: "Toronto Stadium, Toronto",       teamA: "Portugal",       teamB: "Croatia" },
  { id: "R32-14", date: "Jul 3",  venue: "AT&T Stadium, Arlington",        teamA: "Australia",      teamB: "Egypt" },
  { id: "R32-15", date: "Jul 3",  venue: "Hard Rock Stadium, Miami Gardens", teamA: "Argentina",    teamB: "Cape Verde" },
  { id: "R32-16", date: "Jul 3",  venue: "Arrowhead Stadium, Kansas City", teamA: "Colombia",       teamB: "Ghana" }
];

// Round of 16: each match's two slots are filled by winners of two R32 matches.
const ROUND_OF_16 = [
  { id: "R16-1", from: ["R32-1", "R32-2"] },
  { id: "R16-2", from: ["R32-3", "R32-4"] },
  { id: "R16-3", from: ["R32-5", "R32-6"] },
  { id: "R16-4", from: ["R32-7", "R32-8"] },
  { id: "R16-5", from: ["R32-9", "R32-10"] },
  { id: "R16-6", from: ["R32-11", "R32-12"] },
  { id: "R16-7", from: ["R32-13", "R32-14"] },
  { id: "R16-8", from: ["R32-15", "R32-16"] }
];

const QUARTERFINALS = [
  { id: "QF-1", from: ["R16-1", "R16-2"] },
  { id: "QF-2", from: ["R16-3", "R16-4"] },
  { id: "QF-3", from: ["R16-5", "R16-6"] },
  { id: "QF-4", from: ["R16-7", "R16-8"] }
];

const SEMIFINALS = [
  { id: "SF-1", from: ["QF-1", "QF-2"] },
  { id: "SF-2", from: ["QF-3", "QF-4"] }
];

const FINAL = [
  { id: "FINAL", from: ["SF-1", "SF-2"] }
];

const ROUNDS = [
  { key: "R32",   label: "Round of 32",   matches: ROUND_OF_32 },
  { key: "R16",   label: "Round of 16",   matches: ROUND_OF_16 },
  { key: "QF",    label: "Quarterfinals", matches: QUARTERFINALS },
  { key: "SF",    label: "Semifinals",    matches: SEMIFINALS },
  { key: "FINAL", label: "Final",         matches: FINAL }
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// Return an <img> flag for a team. Output is only ever injected as HTML content
// (never into an attribute value), so the inline markup is safe at every call
// site. Height 18 keeps it inline with text; flagcdn serves 2x for retina.
function flag(team) {
  const code = TEAM_CODES[team];
  if (!code) {
    return `<span class="flag flag-unknown" aria-hidden="true">🏳️</span>`;
  }
  const name = escapeHtml(team);
  return `<img class="flag" src="https://flagcdn.com/w40/${code}.png"` +
    ` srcset="https://flagcdn.com/w80/${code}.png 2x"` +
    ` width="27" height="18" loading="lazy" decoding="async" alt="${name} flag" title="${name}">`;
}

// Collapse a team name to a comparison key: strip accents, lowercase, turn
// "&" into "and", and reduce any run of non-alphanumerics to a single space.
// Both incoming feed names and alias-map keys pass through this, so cosmetic
// spelling differences ("Côte d'Ivoire" vs "Ivory Coast") line up exactly.
function normalizeTeam(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Map an external (e.g. TheSportsDB) team name to our canonical display name,
// or null if we can't confidently resolve it. Exact alias matching only — no
// fuzzy matching, so "Congo" can never silently resolve to the wrong country.
function resolveTeamName(externalName) {
  const norm = normalizeTeam(externalName);
  if (!norm) return null;
  if (TEAMDB_ALIASES[norm]) return TEAMDB_ALIASES[norm];
  // Fall back to matching against our own canonical names by normalized form.
  for (const canonical of Object.keys(TEAM_CODES)) {
    if (normalizeTeam(canonical) === norm) return canonical;
  }
  return null;
}

// The FIFA three-letter code for a team, for the tight Round-of-32 columns.
// Falls back to the first three letters uppercased if a team isn't mapped.
function shortCode(team) {
  if (!team) return "";
  return TEAM_SHORT[team] || team.slice(0, 3).toUpperCase();
}

// ============================================================
// Symmetric bracket layout (shared by the predictor + leaderboard)
// ============================================================
// A classic wall-chart bracket: the two halves of the draw fan in from the
// left and right edges and converge on a centered Final. The layout is derived
// entirely from the `from:[...]` feeder graph by walking it — it never assumes
// match ids are paired in a particular order — so if the bracket topology is
// ever corrected, the chart reshapes itself automatically.

// Index every match by id, tagging the round it belongs to.
const MATCH_BY_ID = {};
ROUNDS.forEach(r => r.matches.forEach(m => { MATCH_BY_ID[m.id] = { match: m, round: r.key }; }));

// All match ids in a subtree (a node + everything feeding it).
function _subtree(id, acc) {
  acc.add(id);
  const node = MATCH_BY_ID[id];
  if (node && node.match.from) node.match.from.forEach(f => _subtree(f, acc));
  return acc;
}
// SF-1's subtree is the left half of the draw; SF-2's is the right half.
const LEFT_MATCH_IDS = _subtree("SF-1", new Set());
const RIGHT_MATCH_IDS = _subtree("SF-2", new Set());

// Which grid column (1..9) a round sits in, per side. Final is the centre (5).
const _COL_LEFT  = { R32: 1, R16: 2, QF: 3, SF: 4, FINAL: 5 };
const _COL_RIGHT = { R32: 9, R16: 8, QF: 7, SF: 6, FINAL: 5 };

// Leaf (R32) matches of a subtree, in top-to-bottom visual order (feeder DFS).
function _leaves(id, acc) {
  const node = MATCH_BY_ID[id];
  if (!node.match.from) { acc.push(id); return acc; }
  node.match.from.forEach(f => _leaves(f, acc));
  return acc;
}

function sideOf(matchId) {
  if (RIGHT_MATCH_IDS.has(matchId)) return "right";
  if (LEFT_MATCH_IDS.has(matchId)) return "left";
  return "center"; // the Final
}

// Render the whole bracket as one CSS grid. `renderCard(roundKey, match, side)`
// returns the inner HTML of a single match cell (interactive on the predictor,
// read-only on the leaderboard). Cells are placed explicitly by grid-row/column:
// each R32 leaf gets two rows; every later match spans the union of its feeders'
// rows and centres within them, so a card always sits level with the gap between
// the two it draws from — which is what makes the connector elbows line up.
function renderSymmetricBracket({ renderCard }) {
  const leftLeaves = _leaves("SF-1", []);
  const rightLeaves = _leaves("SF-2", []);
  const rows = 2 * Math.max(leftLeaves.length, rightLeaves.length, 1);

  const slotOf = {};
  leftLeaves.forEach((id, i) => { slotOf[id] = i; });
  rightLeaves.forEach((id, i) => { slotOf[id] = i; });

  function rowSpan(id) {
    const node = MATCH_BY_ID[id];
    if (!node.match.from) {
      const s = slotOf[id] || 0;
      return { start: 2 * s + 1, end: 2 * s + 2 };
    }
    const spans = node.match.from.map(rowSpan);
    return {
      start: Math.min(...spans.map(s => s.start)),
      end: Math.max(...spans.map(s => s.end))
    };
  }

  const cells = [];
  for (const round of ROUNDS) {
    // A round divider — hidden on desktop (the grid places cells by column), but
    // shown on mobile where cells stack vertically, so it's always clear which
    // round you're looking at / picking in.
    cells.push(`<div class="sym-round-tag" data-round="${round.key}">${round.label}</div>`);
    for (const m of round.matches) {
      const side = sideOf(m.id);
      const col = side === "right" ? _COL_RIGHT[round.key] : _COL_LEFT[round.key];
      const span = rowSpan(m.id);
      const style = `grid-column:${col};grid-row:${span.start}/${span.end + 1};`;
      // sym-has-feeders drives the connector-elbow CSS; sym-leaf marks R32.
      const feeders = m.from ? " sym-has-feeders" : " sym-leaf";
      cells.push(
        `<div class="sym-cell sym-${round.key} sym-${side}${feeders}" data-match-id="${m.id}" style="${style}">` +
        renderCard(round.key, m, side) +
        `</div>`
      );
    }
  }

  // A single static label strip across the top — no sticky per-column headers
  // (those used to float over the cards). Mirrors L→R: R32 R16 QF SF · SF QF R16 R32.
  const labels = ["Round of 32", "Round of 16", "Quarters", "Semis", "Final",
                  "Semis", "Quarters", "Round of 16", "Round of 32"];
  const labelStrip = labels
    .map((t, i) => `<span class="sym-label" style="grid-column:${i + 1};">${t}</span>`)
    .join("");

  // The official high-res WC2026 vector logo floats in the centre column,
  // spanning only the TOP HALF of the grid (rows is always even). Centred within
  // that span, its midpoint lands at ~25% of the column height — halfway between
  // the top "Final" label and the centred Final card — and it can't reach down
  // far enough to overlap the Final box.
  const emblem =
    `<div class="sym-emblem" aria-hidden="true" style="grid-column:5;grid-row:1/${rows / 2 + 1};">` +
    `<img src="img/fifa-world-cup-2026-4.svg" alt="" width="200" height="220"></div>`;

  return `<div class="sym-labels">${labelStrip}</div>` +
    `<div class="sym-bracket" style="grid-template-rows:repeat(${rows},1fr);">${emblem}${cells.join("")}</div>`;
}
