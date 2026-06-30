// ============================================================
// 2026 World Cup Knockout Predictor — version watcher
// ============================================================
// Defeats stale browser/CDN caches on a static GitHub Pages site, where we can't
// set custom HTTP headers and assets are cached for ~10 minutes. Both pages poll
// a tiny same-origin assets/version.json with cache:"no-store" (which bypasses
// the HTTP cache entirely) and react to two INDEPENDENT signals:
//
//   • resultsGeneratedAt — mirrors results-data.js's generatedAt; changes only
//     when match results change. The leaderboard hot-swaps the data in place
//     (no reload) so its split-flap animation shows the change.
//   • siteVersion — a content hash of the CODE/markup/style files (NOT results),
//     written by tools/stamp_version.py. Changes only on a real code push, so a
//     stale page can detect it's running old code and reload (score) or nudge
//     (predictor).
//
// We poll the Pages-hosted file, NOT raw.githubusercontent.com: raw is
// cross-origin, rate-limited, and can show a commit BEFORE Pages has deployed
// it — which would trigger a reload that just re-fetches stale assets.
//
// Loaded as a plain <script> before app.js / score-app.js; exposes globals
// (no modules, matching the rest of the site).

(function () {
  "use strict";

  var VERSION_URL = "assets/version.json";
  var RELOAD_GUARD_KEY = "wc2026-reloaded-for";

  // The siteVersion THIS page was built with — read from our own <script> tag's
  // ?v= query. Captured now, at top-level execution, while document.currentScript
  // is still valid. When the HTML is fresh the tag carries the new version (and
  // the new ?v= also busts this file's own cache); when the HTML is stale it
  // carries the old one, so a mismatch against version.json means "old code".
  // Empty when unstamped (e.g. local dev) — then site-version checks are skipped
  // so we never reload on a phantom mismatch.
  var loadedSiteVersion = "";
  try {
    var me = document.currentScript && document.currentScript.src;
    var mm = me && me.match(/[?&]v=([^&]+)/);
    if (mm) loadedSiteVersion = decodeURIComponent(mm[1]);
  } catch (e) { /* no currentScript (old browser) — skip site checks */ }

  // Per-tab state. lastResultsVersion advances ONLY when a results update is
  // actually applied (see poll()), so a failed fetch/apply is retried next tick
  // rather than silently skipped. notifiedSiteVersion stops us re-firing the
  // site-change callback every poll once we've already acted on a version.
  var lastResultsVersion = null;
  var notifiedSiteVersion = null;
  var applyingResults = false;   // true while a hot-swap is in flight (serializes applies)
  var started = false;

  // Reload at most once per siteVersion. Returns true if it triggered a reload,
  // false if we've already reloaded for this version (so the caller should fall
  // back to a manual nudge rather than loop — the HTML itself may still be cached
  // within its ~10-min freshness window, in which case reloading won't help yet).
  function reloadOnceForVersion(version) {
    try {
      if (sessionStorage.getItem(RELOAD_GUARD_KEY) === version) return false;
      sessionStorage.setItem(RELOAD_GUARD_KEY, version);
    } catch (e) {
      // No usable storage: we can't remember that we already reloaded, so an
      // auto-reload could loop while the HTML stays cached with the old ?v=.
      // Decline to reload and let the caller nudge instead.
      return false;
    }
    location.reload();
    return true;
  }

  // A small, dismissible "new version" banner. Built in JS (styled by
  // .update-nudge in style.css) so neither HTML page needs extra markup. Idempotent:
  // never stacks more than one.
  function showUpdateNudge(message) {
    if (document.getElementById("update-nudge")) return;
    var box = document.createElement("div");
    box.className = "update-nudge";
    box.id = "update-nudge";
    box.setAttribute("role", "status");

    var text = document.createElement("span");
    text.textContent = message || "A new version is available.";

    var refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "btn btn-primary";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", function () { location.reload(); });

    var close = document.createElement("button");
    close.className = "update-nudge-close";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = "&times;";
    close.addEventListener("click", function () { box.remove(); });

    box.appendChild(text);
    box.appendChild(refresh);
    box.appendChild(close);
    document.body.appendChild(box);
  }

  // One poll cycle. Network/parse errors are swallowed so the page keeps showing
  // the last-good data and simply retries on the next tick.
  function poll(opts) {
    var url = VERSION_URL + "?_=" + Date.now();   // belt-and-suspenders vs a proxy that ignores no-store
    return fetch(url, { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;

        // 1) Code change wins: it supersedes a data change (a reload/nudge will
        //    bring fresh data too). Only meaningful when we know our own version.
        if (data.siteVersion && loadedSiteVersion && data.siteVersion !== loadedSiteVersion) {
          if (data.siteVersion !== notifiedSiteVersion) {
            notifiedSiteVersion = data.siteVersion;
            if (typeof opts.onSiteChanged === "function") opts.onSiteChanged(data.siteVersion);
          }
          return;
        }

        // 2) Results change: act only when STRICTLY newer. generatedAt is an ISO
        //    UTC "…Z" string, so lexicographic order == chronological order; we
        //    never parse it into a Date or compare client clocks. The
        //    applyingResults gate serializes hot-swaps: overlapping polls (e.g. a
        //    visibilitychange firing during an in-flight interval apply) can't
        //    inject a second script or race the version backward.
        var ts = data.resultsGeneratedAt;
        if (ts && !applyingResults && (!lastResultsVersion || ts > lastResultsVersion)) {
          if (typeof opts.onResultsChanged === "function") {
            applyingResults = true;
            return Promise.resolve(opts.onResultsChanged(ts)).then(function (applied) {
              // Never lower the version: only advance, and only past what's
              // already applied (a late apply for an older ts is a no-op here).
              if (applied && (!lastResultsVersion || ts > lastResultsVersion)) lastResultsVersion = ts;
            }, function () { /* apply failed — leave lastResultsVersion, retry next tick */ })
              .then(function () { applyingResults = false; });
          }
          lastResultsVersion = ts;
        }
      })
      .catch(function () { /* offline / transient — retry next tick */ });
  }

  // Start watching. Options:
  //   onResultsChanged(ts)  -> truthy / Promise<truthy> when a hot-swap succeeded
  //   onSiteChanged(version)
  //   initialResultsVersion -> the generatedAt baked into the loaded results-data.js
  //   intervalMs            -> poll cadence (default 90s)
  function startVersionWatch(opts) {
    opts = opts || {};
    if (started) return;          // one watcher per tab
    started = true;
    lastResultsVersion = opts.initialResultsVersion || null;
    var intervalMs = opts.intervalMs || 90000;

    poll(opts);                                   // heal a stale first paint promptly
    setInterval(function () { poll(opts); }, intervalMs);
    // Phones suspend background tabs and skip timers; re-check the moment the tab
    // is shown again (this is the common "I switched back to check the score" path).
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) poll(opts);
    });
  }

  window.startVersionWatch = startVersionWatch;
  window.reloadOnceForVersion = reloadOnceForVersion;
  window.showUpdateNudge = showUpdateNudge;
})();
