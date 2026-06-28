// ============================================================
// WC 2026 Bracket — Google Apps Script backend
// ============================================================
// Setup instructions:
//   1. Go to script.google.com → New project
//   2. Paste this entire file into the editor
//   3. In the editor, click Resources → Advanced Google Services (or use the
//      SpreadsheetApp directly — no extra services needed)
//   4. Deploy → New deployment → Web App
//      Execute as: Me
//      Who has access: Anyone
//   5. Authorize when prompted
//   6. Copy the deployment URL into assets/config.js
// ============================================================

const SHEET_NAME = "Predictions";

const MATCH_IDS = [
  "R32-1","R32-2","R32-3","R32-4","R32-5","R32-6","R32-7","R32-8",
  "R32-9","R32-10","R32-11","R32-12","R32-13","R32-14","R32-15","R32-16",
  "R16-1","R16-2","R16-3","R16-4","R16-5","R16-6","R16-7","R16-8",
  "QF-1","QF-2","QF-3","QF-4",
  "SF-1","SF-2",
  "FINAL"
];

const HEADERS = ["timestamp", "predictor", "submittedAt", ...MATCH_IDS];

// Bracket topology, mirrored from assets/bracket-data.js. The backend deploys
// separately (script.google.com) and can't import that file, so keep these two
// in sync if the bracket is ever corrected. R32_TEAMS holds each opener's fixed
// pair; FEEDERS lists the two earlier match ids whose picked winners are the
// only teams that can legally appear in a later match.
const R32_TEAMS = {
  "R32-1":  ["South Africa", "Canada"],
  "R32-2":  ["Brazil", "Japan"],
  "R32-3":  ["Germany", "Paraguay"],
  "R32-4":  ["Netherlands", "Morocco"],
  "R32-5":  ["Ivory Coast", "Norway"],
  "R32-6":  ["France", "Sweden"],
  "R32-7":  ["Mexico", "Ecuador"],
  "R32-8":  ["England", "DR Congo"],
  "R32-9":  ["Belgium", "Senegal"],
  "R32-10": ["United States", "Bosnia and Herzegovina"],
  "R32-11": ["Spain", "Austria"],
  "R32-12": ["Switzerland", "Algeria"],
  "R32-13": ["Portugal", "Croatia"],
  "R32-14": ["Australia", "Egypt"],
  "R32-15": ["Argentina", "Cape Verde"],
  "R32-16": ["Colombia", "Ghana"]
};

const FEEDERS = {
  "R16-1": ["R32-1", "R32-2"],   "R16-2": ["R32-3", "R32-4"],
  "R16-3": ["R32-5", "R32-6"],   "R16-4": ["R32-7", "R32-8"],
  "R16-5": ["R32-9", "R32-10"],  "R16-6": ["R32-11", "R32-12"],
  "R16-7": ["R32-13", "R32-14"], "R16-8": ["R32-15", "R32-16"],
  "QF-1": ["R16-1", "R16-2"], "QF-2": ["R16-3", "R16-4"],
  "QF-3": ["R16-5", "R16-6"], "QF-4": ["R16-7", "R16-8"],
  "SF-1": ["QF-1", "QF-2"], "SF-2": ["QF-3", "QF-4"],
  "FINAL": ["SF-1", "SF-2"]
};

// Return the id of the first pick that can't legally appear in its match, or ""
// if every present pick is legal. Empty slots are allowed (a partial draft is
// fine); the only thing rejected is a pick for a team the bracket path can't
// actually deliver to that match — exactly the value a hand-crafted POST would
// need to score impossible later-round points. MATCH_IDS is in round order, so
// when we reach a later match its feeder picks have already been read.
function firstIllegalPick(picks) {
  const val = id => String(picks[id] == null ? "" : picks[id]).trim();
  for (const id of MATCH_IDS) {
    const pick = val(id);
    if (!pick) continue;
    const legal = R32_TEAMS[id] || [val(FEEDERS[id][0]), val(FEEDERS[id][1])];
    if (pick !== legal[0] && pick !== legal[1]) return id;
  }
  return "";
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (payload.schema !== "wc2026-prediction-v1") {
      return respond({ error: "Invalid schema" });
    }
    // Reject picks the bracket path can't deliver (a legit complete bracket is
    // always legal; this only turns away a hand-crafted POST trying to score an
    // impossible later-round pick). Empty slots are fine.
    const bad = firstIllegalPick(payload.picks || {});
    if (bad) {
      return respond({ error: "Illegal pick for " + bad });
    }
    const sheet = getSheet();
    const row = buildRow(payload);
    const predictorCell = row[1];   // sanitized/trimmed name, matching what we store

    // Overwrite any existing row for this predictor so re-submits don't stack up.
    // Compare against the sanitized name so the upsert key matches the stored cell.
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === predictorCell) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return respond({ ok: true, updated: true });
      }
    }

    sheet.appendRow(row);
    return respond({ ok: true, updated: false });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

// Neutralize spreadsheet formula injection: a cell beginning with =, +, -, @,
// or a leading tab/carriage return is interpreted as a formula by Sheets (and
// by Excel if someone exports). Prefix those with an apostrophe so the value is
// always stored as literal text. Picks are canonical team names and never start
// with these, but a hand-crafted POST could smuggle one in.
function sanitizeCell(value) {
  const s = String(value == null ? "" : value).trim();
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function buildRow(payload) {
  const picks = payload.picks || {};
  return [
    new Date().toISOString(),
    sanitizeCell(payload.predictor || "Unknown"),
    sanitizeCell(payload.submittedAt || ""),
    ...MATCH_IDS.map(id => sanitizeCell(picks[id] || ""))
  ];
}

function doGet() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return respond({ predictions: [] });

  const [headers, ...rows] = values;
  const predictions = rows.map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i]]))
  );
  return respond({ predictions });
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
