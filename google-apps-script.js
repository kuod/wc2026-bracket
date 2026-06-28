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
    const sheet = getSheet();

    // Overwrite any existing row for this predictor so re-submits don't stack up.
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === payload.predictor) {
        const row = buildRow(payload);
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return respond({ ok: true, updated: true });
      }
    }

    sheet.appendRow(buildRow(payload));
    return respond({ ok: true, updated: false });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function buildRow(payload) {
  return [
    new Date().toISOString(),
    payload.predictor || "Unknown",
    payload.submittedAt || "",
    ...MATCH_IDS.map(id => payload.picks[id] || "")
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
