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
