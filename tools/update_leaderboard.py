#!/usr/bin/env python3
"""Regenerate assets/results-data.js from real World Cup results.

Why this exists
---------------
GitHub Pages is static, so the leaderboard can't run server code. This script
(run by .github/workflows/update-results.yml on a schedule, or by hand) fetches
real knockout results from TheSportsDB and bakes the resolved winners into
assets/results-data.js. The browser only ever reads that committed file -- it
never calls the API itself, so every visitor sees the same deterministic
leaderboard and the page renders fine even if TheSportsDB is down.

Why fetch day-by-day
--------------------
TheSportsDB's free tier CAPS eventsseason.php and eventsround.php at 5 events
(verified: the 64-match 2022 World Cup returns only 5). eventsday.php?d=DATE&l=ID
is NOT capped and includes the penalty fields, so we enumerate the known
tournament dates and pull each day in full.

How winners are resolved
------------------------
Penalty shootouts are deterministic: when a match is level after regulation,
intHomeScoreExtra/intAwayScoreExtra hold the deciding (extra-time/penalty)
score (verified: 2022 final, Argentina beat France via extra 4-2, status "AP").
Events are mapped onto our stable match ids (R32-1..FINAL) by unordered team
set over the bracket's feeder graph -- never by TheSportsDB's round codes, which
are inconsistent. Unresolved names are logged to `warnings`, not guessed.

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

# --- Config -----------------------------------------------------------------

SPORTSDB_BASE = "https://www.thesportsdb.com/api/v1/json/3/"
LEAGUE_ID = "4429"          # FIFA World Cup (verified via lookupleague.php)
SEASON = "2026"

# The knockout window. We iterate every date in [START, END] inclusive; days
# with no matches simply return nothing, which is harmless. Widen the range if
# the schedule shifts -- extra empty days cost one (throttled) request each.
START_DATE = datetime.date(2026, 6, 28)
END_DATE = datetime.date(2026, 7, 19)

REQUEST_SPACING_S = 1.3     # throttle: free tier ~HTTP 1015 after rapid calls
MAX_RETRIES = 4

REPO_ROOT = Path(__file__).resolve().parent.parent
BRACKET_DATA = REPO_ROOT / "assets" / "bracket-data.js"
OUTPUT_FILE = REPO_ROOT / "assets" / "results-data.js"

COMPLETED_STATUSES = {"FT", "AET", "AP"}


# --- Parse the canonical bracket out of bracket-data.js ---------------------
# bracket-data.js is the single source of truth for matchups, the feeder graph,
# and team-name aliases. We read it rather than duplicating it so a change there
# (e.g. a corrected R32 matchup) flows through automatically.

def _read_bracket_js():
    return BRACKET_DATA.read_text(encoding="utf-8")


def _parse_object_map(js, var_name):
    """Extract a `const VAR = { "k": "v", ... }` string->string map."""
    m = re.search(re.escape(var_name) + r"\s*=\s*\{(.*?)\n\};", js, re.S)
    if not m:
        return {}
    body = m.group(1)
    out = {}
    for k, v in re.findall(r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"', body):
        out[k] = v
    return out


def _parse_round_of_32(js):
    """Return [{id, teamA, teamB}, ...] for the fixed first round."""
    m = re.search(r"ROUND_OF_32\s*=\s*\[(.*?)\n\];", js, re.S)
    if not m:
        raise SystemExit("Could not find ROUND_OF_32 in bracket-data.js")
    rows = []
    for obj in re.findall(r"\{(.*?)\}", m.group(1), re.S):
        def field(name):
            fm = re.search(name + r'\s*:\s*"((?:[^"\\]|\\.)*)"', obj)
            return fm.group(1) if fm else None
        mid = field("id")
        if not mid:
            continue
        rows.append({"id": mid, "teamA": field("teamA"), "teamB": field("teamB")})
    return rows


def _parse_feeder_round(js, var_name):
    """Return [{id, from:[id,id]}, ...] for a later round."""
    m = re.search(re.escape(var_name) + r"\s*=\s*\[(.*?)\n\];", js, re.S)
    if not m:
        raise SystemExit("Could not find %s in bracket-data.js" % var_name)
    rows = []
    for obj in re.findall(r"\{(.*?)\}", m.group(1), re.S):
        idm = re.search(r'id\s*:\s*"([^"]+)"', obj)
        fromm = re.search(r"from\s*:\s*\[([^\]]*)\]", obj)
        if not idm or not fromm:
            continue
        feeders = re.findall(r'"([^"]+)"', fromm.group(1))
        rows.append({"id": idm.group(1), "from": feeders})
    return rows


def load_bracket():
    js = _read_bracket_js()
    return {
        "team_codes": _parse_object_map(js, "TEAM_CODES"),
        "aliases": _parse_object_map(js, "TEAMDB_ALIASES"),
        "R32": _parse_round_of_32(js),
        "R16": _parse_feeder_round(js, "ROUND_OF_16"),
        "QF": _parse_feeder_round(js, "QUARTERFINALS"),
        "SF": _parse_feeder_round(js, "SEMIFINALS"),
        "FINAL": _parse_feeder_round(js, "FINAL"),
    }


# --- Team-name normalization (mirrors normalizeTeam/resolveTeamName in JS) ---

_COMBINING = re.compile(r"[̀-ͯ]")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_team(name):
    import unicodedata
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = _COMBINING.sub("", s)
    s = s.lower().replace("&", " and ")
    s = _NON_ALNUM.sub(" ", s)
    return s.strip()


def make_resolver(bracket):
    aliases = {normalize_team(k): v for k, v in bracket["aliases"].items()}
    canon_by_norm = {normalize_team(c): c for c in bracket["team_codes"].keys()}

    def resolve(name):
        norm = normalize_team(name)
        if not norm:
            return None
        if norm in aliases:
            return aliases[norm]
        return canon_by_norm.get(norm)

    return resolve


# --- HTTP -------------------------------------------------------------------

def fetch_json(url):
    """GET with simple exponential backoff for the free tier's rate limiter."""
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wc2026-bracket/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
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


def daterange(start, end):
    d = start
    while d <= end:
        yield d
        d += datetime.timedelta(days=1)


# --- Winner resolution ------------------------------------------------------

def _to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def decide_winner(ev, resolve):
    """Return (home_canon, away_canon, winner_canon_or_None, status, note)."""
    home = resolve(ev.get("strHomeTeam"))
    away = resolve(ev.get("strAwayTeam"))
    status = (ev.get("strStatus") or "").strip()

    if status not in COMPLETED_STATUSES:
        return home, away, None, status, "not completed"

    hs, as_ = _to_int(ev.get("intHomeScore")), _to_int(ev.get("intAwayScore"))
    he, ae = _to_int(ev.get("intHomeScoreExtra")), _to_int(ev.get("intAwayScoreExtra"))

    # Extra-time / penalty score decides when present and not level.
    if he is not None and ae is not None and he != ae:
        winner = home if he > ae else away
        return home, away, winner, status, "decided by extra/penalties"

    if hs is not None and as_ is not None and hs != as_:
        winner = home if hs > as_ else away
        return home, away, winner, status, "decided in regulation"

    # Level score with no usable shootout field: cannot resolve automatically.
    return home, away, None, status, "level score, winner undetermined"


# --- Main resolution over the feeder graph ----------------------------------

def build(bracket, events, resolve):
    """Map fetched events onto our match ids; return (results, unmatched, warnings)."""
    # Pool keyed by the unordered set of the two canonical team names.
    pool = {}            # frozenset({A,B}) -> event meta dict
    unmatched = []
    warnings = []

    for ev in events:
        home, away, winner, status, note = decide_winner(ev, resolve)
        raw_home = ev.get("strHomeTeam")
        raw_away = ev.get("strAwayTeam")
        if home is None or away is None:
            unmatched.append({
                "eventId": ev.get("idEvent"),
                "home": raw_home, "away": raw_away,
                "resolvedHome": home, "resolvedAway": away,
            })
            for raw, res in ((raw_home, home), (raw_away, away)):
                if res is None and raw:
                    warnings.append({"type": "unmatched-team", "sportsDbName": raw,
                                     "eventId": ev.get("idEvent")})
            continue
        key = frozenset((home, away))
        pool[key] = {
            "eventId": ev.get("idEvent"),
            "home": home, "away": away,
            "homeScore": ev.get("intHomeScore"), "awayScore": ev.get("intAwayScore"),
            "homeScoreExtra": ev.get("intHomeScoreExtra"),
            "awayScoreExtra": ev.get("intAwayScoreExtra"),
            "status": status, "winner": winner, "note": note,
            "date": ev.get("dateEvent"),
        }
        if winner is None and status in COMPLETED_STATUSES:
            warnings.append({"type": "undetermined-winner", "match": "%s vs %s" % (home, away),
                             "eventId": ev.get("idEvent"), "detail": note})

    results = {}
    winner_by_match = {}   # match id -> winner canonical name (for feeder lookup)

    def record(match_id, round_key, team_a, team_b):
        meta = {"status": "scheduled", "round": round_key,
                "teamA": team_a, "teamB": team_b, "winner": None}
        if team_a and team_b:
            ev = pool.get(frozenset((team_a, team_b)))
            if ev:
                meta.update({
                    "status": "complete" if ev["winner"] else "played",
                    "winner": ev["winner"],
                    "homeTeam": ev["home"], "awayTeam": ev["away"],
                    "homeScore": ev["homeScore"], "awayScore": ev["awayScore"],
                    "homeScoreExtra": ev["homeScoreExtra"], "awayScoreExtra": ev["awayScoreExtra"],
                    "decidedBy": ev["status"], "sportsDbEventId": ev["eventId"],
                    "completedAt": ev["date"],
                })
        results[match_id] = meta
        if meta["winner"]:
            winner_by_match[match_id] = meta["winner"]

    # Round of 32: fixed matchups.
    for m in bracket["R32"]:
        record(m["id"], "R32", m["teamA"], m["teamB"])

    # Later rounds: teams are the winners of the two feeder matches, resolved in
    # order so each round can see the round before it.
    for round_key in ("R16", "QF", "SF", "FINAL"):
        for m in bracket[round_key]:
            a = winner_by_match.get(m["from"][0])
            b = winner_by_match.get(m["from"][1])
            record(m["id"], round_key, a, b)

    return results, unmatched, warnings


# --- Output -----------------------------------------------------------------

def read_existing_payload():
    """Parse the JSON object out of the current results-data.js, or None."""
    if not OUTPUT_FILE.exists():
        return None
    txt = OUTPUT_FILE.read_text(encoding="utf-8")
    start = txt.find("{", txt.find("WC2026_RESULTS"))
    end = txt.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(txt[start:end + 1])
    except ValueError:
        return None


def write_results_js(results, unmatched, warnings, generated_at):
    payload = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "source": "TheSportsDB",
        "sourceLeagueId": LEAGUE_ID,
        "sourceSeason": SEASON,
        "results": results,
        "unmatchedEvents": unmatched,
        "warnings": warnings,
    }
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    header = (
        "// ============================================================\n"
        "// WC 2026 — embedded match results  (GENERATED FILE — do not edit by hand)\n"
        "// ============================================================\n"
        "// Regenerated by tools/update_leaderboard.py. To correct a result by hand,\n"
        "// edit assets/results-overrides.js instead (it survives regeneration).\n"
        "window.WC2026_RESULTS = "
    )
    OUTPUT_FILE.write_text(header + body + ";\n", encoding="utf-8")


def main():
    bracket = load_bracket()
    resolve = make_resolver(bracket)
    print("Parsed bracket: %d R32 matchups, %d teams known."
          % (len(bracket["R32"]), len(bracket["team_codes"])))

    events = []
    failed_days = []
    for d in daterange(START_DATE, END_DATE):
        iso = d.isoformat()
        url = "%seventsday.php?d=%s&l=%s" % (SPORTSDB_BASE, iso, LEAGUE_ID)
        data = fetch_json(url)
        time.sleep(REQUEST_SPACING_S)
        # fetch_json returns None on a hard failure (after retries) but {} for a
        # legitimately empty day. Only None means we're missing real data.
        if data is None:
            failed_days.append(iso)
            continue
        day_events = data.get("events") or []
        if day_events:
            print("  %s: %d event(s)" % (iso, len(day_events)))
            events.extend(day_events)

    # If any day failed to fetch, the event set is incomplete and rebuilding from
    # it could downgrade an already-decided match back to "pending". Bail out
    # WITHOUT writing so the last good results-data.js stays committed; the next
    # scheduled run (or a manual re-run) recovers once the API responds.
    if failed_days:
        print("Aborting: %d day(s) failed to fetch (%s). Leaving %s untouched."
              % (len(failed_days), ", ".join(failed_days),
                 OUTPUT_FILE.relative_to(REPO_ROOT)), file=sys.stderr)
        sys.exit(1)

    print("Fetched %d total event(s)." % len(events))
    results, unmatched, warnings = build(bracket, events, resolve)

    decided = sum(1 for r in results.values() if r.get("winner"))
    print("Resolved %d/%d matches; %d unmatched event(s); %d warning(s)."
          % (decided, len(results), len(unmatched), len(warnings)))
    for w in warnings:
        print("  warning:", json.dumps(w, ensure_ascii=False), file=sys.stderr)

    # Skip the write (and thus a no-op git commit) when nothing meaningful
    # changed -- otherwise a frequent cron would churn the timestamp forever.
    existing = read_existing_payload()
    if existing is not None and existing.get("results") == results \
            and existing.get("unmatchedEvents") == unmatched \
            and existing.get("warnings") == warnings:
        print("No change in resolved results; leaving %s untouched."
              % OUTPUT_FILE.relative_to(REPO_ROOT))
        return

    generated_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_results_js(results, unmatched, warnings, generated_at)
    print("Wrote %s (generatedAt %s)." % (OUTPUT_FILE.relative_to(REPO_ROOT), generated_at))


if __name__ == "__main__":
    main()
