// Paste your deployed Google Apps Script URL here.
// In Apps Script: Deploy → New deployment → Web App → copy the URL.
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzmH9j7pPqTuW7OsPk-fgy-4vOKPFZYyItF3jG2Jbe33dnplb_4v-lW3UAj80lIJaI_tg/exec";

// Results are NOT fetched in the browser. tools/update_leaderboard.py pulls them
// from TheSportsDB and bakes the winners into assets/results-data.js (run on a
// schedule by .github/workflows/update-results.yml, or by hand). The leaderboard
// just renders that embedded snapshot, so every visitor sees the same scores and
// nothing depends on a live API call at view time.
