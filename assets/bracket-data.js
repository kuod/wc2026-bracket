// 2026 FIFA World Cup — Knockout Stage bracket data
// Round of 32 matchups confirmed as of June 28, 2026 (group stage complete).
// Source: FIFA / major outlets coverage of the finalized Round of 32 draw.

const FLAGS = {
  "South Africa": "🇿🇦",
  "Canada": "🇨🇦",
  "Brazil": "🇧🇷",
  "Japan": "🇯🇵",
  "Germany": "🇩🇪",
  "Paraguay": "🇵🇾",
  "Netherlands": "🇳🇱",
  "Morocco": "🇲🇦",
  "Ivory Coast": "🇨🇮",
  "Norway": "🇳🇴",
  "France": "🇫🇷",
  "Sweden": "🇸🇪",
  "Mexico": "🇲🇽",
  "Ecuador": "🇪🇨",
  "England": "🏴",
  "DR Congo": "🇨🇩",
  "Belgium": "🇧🇪",
  "Senegal": "🇸🇳",
  "United States": "🇺🇸",
  "Bosnia and Herzegovina": "🇧🇦",
  "Spain": "🇪🇸",
  "Austria": "🇦🇹",
  "Switzerland": "🇨🇭",
  "Algeria": "🇩🇿",
  "Portugal": "🇵🇹",
  "Croatia": "🇭🇷",
  "Australia": "🇦🇺",
  "Egypt": "🇪🇬",
  "Argentina": "🇦🇷",
  "Cape Verde": "🇨🇻",
  "Colombia": "🇨🇴",
  "Ghana": "🇬🇭"
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

function flag(team) {
  return FLAGS[team] || "🏳️";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
