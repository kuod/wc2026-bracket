#!/usr/bin/env python3
"""Stamp assets/version.json and the HTML asset ?v= query strings.

Why this exists
---------------
GitHub Pages is static and serves both HTML and assets with ~10-minute cache
freshness we cannot override (no custom headers / no _headers file). So a pushed
update can keep showing stale in a browser. assets/version-check.js fixes this
at runtime by polling assets/version.json (cache:"no-store") for two signals:

  * resultsGeneratedAt -- mirrors results-data.js's generatedAt; the leaderboard
    hot-swaps results in place when it advances (no reload).
  * siteVersion -- a content hash of the CODE/markup/style files (NOT results);
    changes only on a real code push, so a stale page reloads (score) or nudges
    (predictor).

This script (run by the GitHub Actions, or by hand) keeps version.json honest
and rewrites the `?v=<siteVersion>` cache-buster on every asset <script>/<link>
in index.html and score.html -- EXCEPT results-data.js, whose plain tag stays so
the page paints instantly and then heals via the poll above.

Idempotent: siteVersion is computed over source bytes with any existing `?v=`
stripped, so stamping is a fixed point (re-running writes nothing). Stdlib only.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS = REPO_ROOT / "assets"
VERSION_FILE = ASSETS / "version.json"
RESULTS_FILE = ASSETS / "results-data.js"
HTML_FILES = [REPO_ROOT / "index.html", REPO_ROOT / "score.html"]

# Source files whose content defines siteVersion. results-data.js and
# version.json are deliberately EXCLUDED: results changes ride the separate
# resultsGeneratedAt signal, and version.json is this script's own output.
SOURCE_FILES = sorted([
    REPO_ROOT / "index.html",
    REPO_ROOT / "score.html",
    ASSETS / "app.js",
    ASSETS / "score-app.js",
    ASSETS / "version-check.js",
    ASSETS / "bracket-data.js",
    ASSETS / "config.js",
    ASSETS / "results-overrides.js",
    ASSETS / "style.css",
])

# The cache-buster we emit. siteVersion is a hex digest, so this pattern matches
# exactly what we write and never the `?v=${...}` template literal in JS.
VBUST_RE = re.compile(r"\?v=[0-9a-f]+")

# An asset reference in an HTML attribute: src="assets/foo.js" or href="...".
# Group 1 = attr+path (no query), group 2 = the bare path for the skip check.
ASSET_REF_RE = re.compile(r'((?:src|href)="(assets/[^"?]+))(?:\?v=[^"]*)?"')

# results-data.js keeps its plain (unversioned) tag: the page paints with the
# cached copy immediately, then version-check.js hot-swaps a fresh one.
NEVER_VERSION = {"assets/results-data.js"}


def compute_site_version():
    """Short sha256 over SOURCE_FILES with any existing ?v= stripped."""
    h = hashlib.sha256()
    for path in SOURCE_FILES:
        text = path.read_text(encoding="utf-8")
        h.update(VBUST_RE.sub("", text).encode("utf-8"))
        h.update(b"\0")          # delimiter so file boundaries can't blur together
    return h.hexdigest()[:12]


def read_results_generated_at():
    """Pull generatedAt out of results-data.js (same slice trick as the updater)."""
    if not RESULTS_FILE.exists():
        return None
    txt = RESULTS_FILE.read_text(encoding="utf-8")
    start = txt.find("{", txt.find("WC2026_RESULTS"))
    end = txt.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(txt[start:end + 1]).get("generatedAt")
    except ValueError:
        return None


def stamp_html(text, site_version):
    """Rewrite ?v= on every asset tag except results-data.js."""
    def repl(m):
        head, path = m.group(1), m.group(2)
        if path in NEVER_VERSION:
            return f'{head}"'                       # strip any stray ?v=, leave bare
        return f'{head}?v={site_version}"'
    return ASSET_REF_RE.sub(repl, text)


def write_if_changed(path, content):
    """Write only when content differs; return True if it wrote."""
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def main():
    site_version = compute_site_version()
    results_generated_at = read_results_generated_at()

    payload = {
        "schemaVersion": 1,
        "siteVersion": site_version,
        "resultsGeneratedAt": results_generated_at,
    }
    version_json = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    changed = []
    if write_if_changed(VERSION_FILE, version_json):
        changed.append(VERSION_FILE.relative_to(REPO_ROOT))
    for html in HTML_FILES:
        stamped = stamp_html(html.read_text(encoding="utf-8"), site_version)
        if write_if_changed(html, stamped):
            changed.append(html.relative_to(REPO_ROOT))

    if changed:
        print("Stamped siteVersion=%s, resultsGeneratedAt=%s; updated: %s"
              % (site_version, results_generated_at,
                 ", ".join(str(p) for p in changed)))
    else:
        print("Up to date (siteVersion=%s); nothing to write." % site_version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
