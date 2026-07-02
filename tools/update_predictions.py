#!/usr/bin/env python3
"""Snapshot everyone's predictions from the Google Sheet into predictions-data.js.

Why this exists
---------------
The leaderboard used to fetch every bracket LIVE from the Apps Script web app on
page load and `await` it before the first paint. That GET cold-starts,
302-redirects, and intermittently fails — so it was both the dominant load
latency and a single point of failure (a flaky call left an empty board).

This script (run by .github/workflows/update-results.yml alongside the results
updater, or by hand) mirrors the results pipeline: it GETs the Sheet once, bakes
the rows into a committed assets/predictions-data.js, and the browser hydrates
from that on first paint. The live fetch stays, but demoted to a best-effort
BACKGROUND refresh — so a bad GET can no longer blank the board.

The snapshot is deliberately PUBLIC (real names + picks): the Apps Script GET is
already open to anyone, so this exposes nothing new; it just caches it.

Design notes
------------
- Rows are stored in the SAME raw shape doGet() returns
  ({timestamp, predictor, submittedAt, "R32-1": …, …}), minus empty pick fields,
  so the browser's existing normalizePredictions() runs identically on the static
  snapshot and the live payload — one codepath, no drift.
- Idempotent: skips the write when the prediction rows are unchanged (only
  `generatedAt` would differ), so a frequent cron doesn't churn commits.
- Resilient + isolated: predictions are NON-CRITICAL. Any fetch/parse failure
  leaves the last-good file untouched and exits 0 with a warning, so it can never
  abort the results commit it shares a workflow with.

Stdlib only -- no pip install needed.
"""

import json
import re
import sys
import time
import datetime
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = REPO_ROOT / "assets" / "config.js"
OUTPUT_FILE = REPO_ROOT / "assets" / "predictions-data.js"

REQUEST_SPACING_S = 1.3     # backoff base (mirrors update_leaderboard.py)
MAX_RETRIES = 4


# --- Parse SCRIPT_URL out of config.js (a JS global, same trick as the results
# --- script uses on bracket-data.js) ---------------------------------------

def read_script_url():
    """Return the SCRIPT_URL string from assets/config.js, or None if unset."""
    if not CONFIG_FILE.exists():
        return None
    txt = CONFIG_FILE.read_text(encoding="utf-8")
    m = re.search(r'SCRIPT_URL\s*=\s*"([^"]*)"', txt)
    if not m:
        return None
    url = m.group(1).strip()
    return url or None


# --- HTTP (GET with exponential backoff, mirroring update_leaderboard.py) ----

def fetch_json(url):
    """GET a JSON document, following the Apps Script 302 redirect. Returns the
    parsed object, or None after MAX_RETRIES on any network/HTTP/parse error."""
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wc2026-bracket/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
            if not raw.strip():
                return {}
            return json.loads(raw)
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError) as e:
            last_err = e
            wait = REQUEST_SPACING_S * (2 ** attempt)
            print("  ! request failed (%s); retrying in %.1fs" % (e, wait), file=sys.stderr)
            time.sleep(wait)
    print("  ! giving up on %s (%s)" % (url, last_err), file=sys.stderr)
    return None


# --- Row shaping ------------------------------------------------------------

def clean_row(row):
    """Keep the fields the browser normalizer reads, dropping empty/None values.
    doGet() returns keys in header order (timestamp, predictor, submittedAt, then
    match ids); dict insertion order preserves that, so output is deterministic.
    Empty pick fields are dropped: the normalizer treats missing and empty
    identically (`row[id] || undefined`), so this is lossless and compact."""
    out = {}
    for k, v in row.items():
        if v is None:
            continue
        if isinstance(v, str) and v == "":
            continue
        out[k] = v
    return out


def read_existing_predictions():
    """Parse the `predictions` array out of the current predictions-data.js, or
    None. Same slice trick the results script uses on results-data.js."""
    if not OUTPUT_FILE.exists():
        return None
    txt = OUTPUT_FILE.read_text(encoding="utf-8")
    start = txt.find("{", txt.find("WC2026_PREDICTIONS"))
    end = txt.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(txt[start:end + 1]).get("predictions")
    except ValueError:
        return None


def write_predictions_js(predictions, generated_at):
    payload = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "predictions": predictions,
    }
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    header = (
        "// ============================================================\n"
        "// WC 2026 — embedded predictions snapshot  (GENERATED FILE — do not edit by hand)\n"
        "// ============================================================\n"
        "// Regenerated by tools/update_predictions.py from the Google Sheet (doGet).\n"
        "// The leaderboard hydrates from this on first paint, then does a best-effort\n"
        "// background refresh against SCRIPT_URL. Public by design — the Sheet's GET is\n"
        "// already open, so this snapshot exposes nothing new.\n"
        "window.WC2026_PREDICTIONS = "
    )
    OUTPUT_FILE.write_text(header + body + ";\n", encoding="utf-8")


def main():
    url = read_script_url()
    if not url:
        print("No SCRIPT_URL in assets/config.js; leaving %s untouched."
              % OUTPUT_FILE.relative_to(REPO_ROOT), file=sys.stderr)
        return 0

    data = fetch_json(url)
    # Any failure to get a well-formed {predictions: [...]} payload is non-fatal:
    # leave the last-good snapshot in place so a flaky GET never breaks the board
    # (or the results commit this shares a workflow with).
    if not isinstance(data, dict):
        print("Fetch failed or returned non-object; leaving %s untouched."
              % OUTPUT_FILE.relative_to(REPO_ROOT), file=sys.stderr)
        return 0
    if data.get("error"):
        print("Sheet returned an error (%s); leaving %s untouched."
              % (data["error"], OUTPUT_FILE.relative_to(REPO_ROOT)), file=sys.stderr)
        return 0
    rows = data.get("predictions")
    if not isinstance(rows, list):
        print("Payload had no `predictions` array; leaving %s untouched."
              % OUTPUT_FILE.relative_to(REPO_ROOT), file=sys.stderr)
        return 0

    predictions = [clean_row(r) for r in rows if isinstance(r, dict)]
    print("Fetched %d prediction row(s) from the Sheet." % len(predictions))

    # Skip the write (and thus a no-op git commit) when the rows are unchanged --
    # otherwise a frequent cron would churn `generatedAt` forever.
    existing = read_existing_predictions()
    if existing is not None and existing == predictions:
        print("No change in predictions; leaving %s untouched."
              % OUTPUT_FILE.relative_to(REPO_ROOT))
        return 0

    generated_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_predictions_js(predictions, generated_at)
    print("Wrote %s (%d brackets, generatedAt %s)."
          % (OUTPUT_FILE.relative_to(REPO_ROOT), len(predictions), generated_at))
    return 0


if __name__ == "__main__":
    sys.exit(main())
