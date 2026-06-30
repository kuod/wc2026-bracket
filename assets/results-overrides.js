// ============================================================
// WC 2026 — manual result overrides (audited, repo-level)
// ============================================================
// This is the ONLY way to correct a result by hand, and it is intentionally a
// committed file rather than an in-app editor: every change is a reviewable git
// diff, and the leaderboard stays identical for every visitor.
//
// Use it when TheSportsDB is wrong or hasn't caught up — e.g. a penalty
// shootout it failed to score, or a name it never matched. Map a match id to
// the canonical winning team name (must match a key in TEAM_CODES exactly).
// Overrides win over BOTH the embedded results and any live browser fetch.
//
// Example:
//   window.WC2026_RESULT_OVERRIDES = {
//     "R32-7": "Mexico",
//     "QF-1":  "Brazil"
//   };
//
// Leave it as an empty object when there's nothing to correct.
window.WC2026_RESULT_OVERRIDES = {
  // R32-5 (Ivory Coast vs Norway): Norway won 2-1 (full time). TheSportsDB was
  // still reporting the match as "2H" (in progress) well after the final
  // whistle, so the auto-updater couldn't resolve it. ESPN had it as final.
  // Safe to remove once the feed catches up — it agrees with the result.
  "R32-5": "Norway"
};
