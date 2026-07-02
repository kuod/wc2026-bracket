#!/usr/bin/env python3
"""Regenerate assets/results-data.js from real World Cup results.

Why this exists
---------------
GitHub Pages is static, so the leaderboard can't run server code. This script
(run by .github/workflows/update-results.yml on a schedule, or by hand) fetches
real knockout results and bakes the resolved winners into assets/results-data.js.
The browser only ever reads that committed file -- it never calls an API itself,
so every visitor sees the same deterministic leaderboard and the page renders
fine even if a source is down.

Two sources, most-updated wins
------------------------------
We fetch BOTH ESPN's public scoreboard and TheSportsDB every day and merge them
per match, preferring whichever has FINALIZED the match. ESPN finalizes faster
(verified live: it had a knockout match at STATUS_FULL_TIME while TheSportsDB
still reported "2H") and exposes the winner directly (a per-competitor `winner`
boolean + `shootoutScore`), so in practice it wins most ties; TheSportsDB stays
in as redundancy. A day is only a hard failure when BOTH sources fail for it.

Why fetch day-by-day
--------------------
TheSportsDB's free tier CAPS eventsseason.php and eventsround.php at 5 events
(verified: the 64-match 2022 World Cup returns only 5). eventsday.php?d=DATE&l=ID
is NOT capped and includes the penalty fields, so we enumerate the known
tournament dates and pull each day in full. ESPN's scoreboard?dates=YYYYMMDD is
likewise per-day and uncapped.

How winners are resolved
------------------------
ESPN gives the winner directly. For TheSportsDB, penalty shootouts are
deterministic: when a match is level after regulation, intHomeScoreExtra/
intAwayScoreExtra hold the deciding score (verified: 2022 final, Argentina beat
France via extra 4-2, status "AP"). Both feeds are mapped to ONE normalized
event shape, then onto our stable match ids (R32-1..FINAL) by unordered team set
over the bracket's feeder graph -- never by a source's round codes, which are
inconsistent. A finished match we still can't resolve is logged to `warnings`,
but ONLY when it's a real bracket matchup (the day feeds also return group games
and pairings we don't model, which must never warn).

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

# Secondary source. ESPN's public scoreboard is keyless, uncapped, and marks
# matches final FASTER than TheSportsDB (verified live: it had a knockout match
# at STATUS_FULL_TIME while TheSportsDB still reported "2H"). It also exposes the
# winner directly via a per-competitor `winner` boolean and a `shootoutScore`
# field, so we don't have to infer the result from extra-time scores. We fetch
# both sources per day and prefer whichever has FINALIZED the match (see merge
# precedence in build()). `dates` takes a YYYYMMDD string.
ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"

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
#
# Both feeds are mapped onto ONE normalized event shape so build() doesn't care
# which source a match came from:
#   {home, away, rawHome, rawAway, completed (bool), winner (canon or None),
#    homeScore, awayScore, homeScoreExtra, awayScoreExtra, decidedBy, note,
#    date, eventId, source}
# `completed` is the source-agnostic "this match is final" flag; `winner` is the
# resolved canonical name (None if final-but-level or not yet final). build()
# merges the two feeds per match by preferring whichever has finalized it.

def _to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _norm_event(home, away, raw_home, raw_away, completed, winner,
                hs, as_, he, ae, decided_by, note, date, event_id, source,
                kickoff=None):
    return {
        "home": home, "away": away, "rawHome": raw_home, "rawAway": raw_away,
        "completed": completed, "winner": winner,
        "homeScore": hs, "awayScore": as_,
        "homeScoreExtra": he, "awayScoreExtra": ae,
        "decidedBy": decided_by, "note": note,
        # `date` feeds the long-standing `completedAt` (day-granular for TheSportsDB);
        # `kickoff` is the finer-grained kickoff time when the source provides one
        # (TheSportsDB strTimestamp / ESPN date) — used client-side to time-gate scoring.
        "date": date, "kickoff": kickoff, "eventId": event_id, "source": source,
    }


def normalize_sportsdb(ev, resolve):
    """Map one TheSportsDB event to the normalized shape (see module note)."""
    home = resolve(ev.get("strHomeTeam"))
    away = resolve(ev.get("strAwayTeam"))
    status = (ev.get("strStatus") or "").strip()
    completed = status in COMPLETED_STATUSES
    hs, as_ = ev.get("intHomeScore"), ev.get("intAwayScore")
    he, ae = ev.get("intHomeScoreExtra"), ev.get("intAwayScoreExtra")

    winner, note = None, "not completed"
    if completed:
        ihs, ias = _to_int(hs), _to_int(as_)
        ihe, iae = _to_int(he), _to_int(ae)
        # Extra-time / penalty score decides when present and not level.
        if ihe is not None and iae is not None and ihe != iae:
            winner, note = (home if ihe > iae else away), "decided by extra/penalties"
        elif ihs is not None and ias is not None and ihs != ias:
            winner, note = (home if ihs > ias else away), "decided in regulation"
        else:
            # Level score with no usable shootout field: cannot resolve automatically.
            note = "level score, winner undetermined"

    # strTimestamp is the full UTC kickoff datetime; dateEvent is only day-granular.
    return _norm_event(home, away, ev.get("strHomeTeam"), ev.get("strAwayTeam"),
                       completed, winner, hs, as_, he, ae,
                       status or "NS", note, ev.get("dateEvent"),
                       ev.get("idEvent"), "TheSportsDB",
                       kickoff=ev.get("strTimestamp") or ev.get("dateEvent"))


def normalize_espn(ev, resolve):
    """Map one ESPN scoreboard event to the normalized shape, or None if it
    can't be parsed. ESPN exposes the winner directly (a per-competitor `winner`
    boolean) plus `shootoutScore`, so we don't infer it from extra-time scores."""
    try:
        comp = (ev.get("competitions") or [])[0]
        competitors = comp.get("competitors") or []
        home_c = next(c for c in competitors if c.get("homeAway") == "home")
        away_c = next(c for c in competitors if c.get("homeAway") == "away")
    except (IndexError, StopIteration, AttributeError):
        return None

    status_type = (comp.get("status") or {}).get("type") or {}
    completed = bool(status_type.get("completed"))

    def team_name(c):
        team = c.get("team") or {}
        return team.get("displayName") or team.get("name") or team.get("location")

    raw_home, raw_away = team_name(home_c), team_name(away_c)
    home, away = resolve(raw_home), resolve(raw_away)
    hs, as_ = home_c.get("score"), away_c.get("score")
    # Penalty shootout counts, when the match went to a shootout.
    h_pen, a_pen = home_c.get("shootoutScore"), away_c.get("shootoutScore")

    winner, note = None, "not completed"
    if completed:
        if home_c.get("winner"):
            winner = home
        elif away_c.get("winner"):
            winner = away
        note = "decided" if winner else "level score, winner undetermined"

    # A compact decided-by label parallel to TheSportsDB's FT/AET/AP/NS, derived
    # from the ESPN status name (e.g. STATUS_FINAL_PEN -> AP) so the committed
    # record still says how it ended.
    name = (status_type.get("name") or "").upper()
    if not completed:
        decided_by = "NS"
    elif "PEN" in name:
        decided_by = "AP"
    elif "EXTRA" in name or "AET" in name:
        decided_by = "AET"
    else:
        decided_by = "FT"

    # ESPN's `date` is already a full ISO datetime, so it doubles as the kickoff.
    return _norm_event(home, away, raw_home, raw_away, completed, winner,
                       hs, as_, h_pen, a_pen, decided_by, note,
                       ev.get("date"), ev.get("id"), "ESPN",
                       kickoff=ev.get("date"))


# --- Main resolution over the feeder graph ----------------------------------

def _prefer_event(a, b):
    """Pick the better of two normalized events for the SAME team-set, coming
    from different sources. Most-updated wins: a finalized-with-winner result
    beats anything less settled, so whichever source marked the match final
    first (in practice ESPN) decides it. Ties favor the source that produced a
    winner; failing that, keep `a` (caller passes the incumbent first)."""
    a_decided = bool(a["completed"] and a["winner"])
    b_decided = bool(b["completed"] and b["winner"])
    if a_decided != b_decided:
        return a if a_decided else b
    if a["completed"] != b["completed"]:
        return a if a["completed"] else b
    return a


def build(bracket, events, prior_results=None):
    """Map normalized events (merged from both sources) onto our match ids.

    Returns (results, unmatched, warnings). Warnings are a property of REAL
    bracket matches, not of arbitrary feed events: eventsday/scoreboard return
    every World Cup game on a date, but we only model 32 knockout matchups, so a
    group-stage draw or a non-bracket pairing must never trip a warning.

    `prior_results` is the previously-committed results map (or None). It powers
    the sticky-winner guarantee: a knockout result, once committed, never reverts
    to undecided just because a source dropped out on a later run. Without it, a
    run where (say) ESPN had finalized a match but is now failing, while
    TheSportsDB succeeds yet still shows the match in-progress, would rebuild that
    match as scheduled and overwrite the committed winner -- un-scoring everyone's
    pick. A genuine *correction* (the feeds now agree on a DIFFERENT winner) still
    flows through, because that produces a winner this run so stickiness no-ops."""
    prior_results = prior_results or {}
    # Pool keyed by the unordered set of the two canonical team names. When both
    # sources report the same matchup, keep whichever is most settled.
    pool = {}            # frozenset({A,B}) -> normalized event
    unmatched = []       # raw record of every event a side of which didn't resolve
    warnings = []

    for ev in events:
        if ev["home"] is None or ev["away"] is None:
            unmatched.append({
                "eventId": ev["eventId"], "source": ev["source"],
                "home": ev["rawHome"], "away": ev["rawAway"],
                "resolvedHome": ev["home"], "resolvedAway": ev["away"],
            })
            continue
        key = frozenset((ev["home"], ev["away"]))
        pool[key] = _prefer_event(pool[key], ev) if key in pool else ev

    results = {}
    winner_by_match = {}   # match id -> winner canonical name (for feeder lookup)

    def record(match_id, round_key, team_a, team_b):
        meta = {"status": "scheduled", "round": round_key,
                "teamA": team_a, "teamB": team_b, "winner": None}
        if team_a and team_b:
            ev = pool.get(frozenset((team_a, team_b)))
            if ev:
                # "complete" once a winner is resolved; "played" only when the
                # match has actually finished but the winner is still undetermined
                # (e.g. a level score we couldn't auto-resolve); otherwise the
                # fixture exists in the feed but hasn't kicked off yet, so it's
                # still "scheduled" rather than mislabeled "played".
                if ev["winner"]:
                    status = "complete"
                elif ev["completed"]:
                    status = "played"
                else:
                    status = "scheduled"
                meta.update({
                    "status": status,
                    "winner": ev["winner"],
                    "homeTeam": ev["home"], "awayTeam": ev["away"],
                    "homeScore": ev["homeScore"], "awayScore": ev["awayScore"],
                    "homeScoreExtra": ev["homeScoreExtra"], "awayScoreExtra": ev["awayScoreExtra"],
                    "decidedBy": ev["decidedBy"], "sportsDbEventId": ev["eventId"],
                    "source": ev["source"], "completedAt": ev["date"],
                    "kickoffAt": ev["kickoff"],
                })

        # Sticky winner: if this run couldn't resolve a winner but a PRIOR run
        # committed one for this same matchup, keep the committed result rather
        # than regressing to undecided. Guard on the team-set so we never carry a
        # stale winner onto a match whose feeders have since resolved to a
        # different pairing. This is what makes a transient single-source outage
        # safe (the dropped source can't erase a result the other source -- or an
        # earlier run -- already locked in).
        if not meta["winner"]:
            prev = prior_results.get(match_id)
            if prev and prev.get("winner") and team_a and team_b \
                    and {prev.get("teamA"), prev.get("teamB")} == {team_a, team_b}:
                meta = dict(prev)

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

    # --- Warnings: STRICT bracket-only -------------------------------------
    # Now that the bracket graph is resolved, every entry in `results` whose two
    # teams are known is a real, formed bracket matchup. We warn ONLY about those
    # — the day feeds also return group-stage games and pairings we don't model
    # (e.g. a 3-3 Algeria vs Austria, or Jordan vs Argentina), and those must
    # never trip a warning. The deliberate tradeoff: if a real bracket team's
    # feed name fails to resolve, its match silently shows unscored rather than
    # warning; `unmatchedEvents` (returned raw, below) is where you'd spot that.
    for match_id, meta in results.items():
        a, b = meta["teamA"], meta["teamB"]
        if not (a and b):
            continue
        # A prior committed winner (carried forward above) means it's resolved —
        # don't warn even if the current live event is still level/in-progress.
        if meta.get("winner"):
            continue
        ev = pool.get(frozenset((a, b)))
        # A real bracket match that finished but we couldn't resolve a winner
        # (level score, no shootout data from either source) -> needs an override.
        if ev and ev["completed"] and not ev["winner"]:
            warnings.append({
                "type": "undetermined-winner",
                "match": "%s vs %s" % (a, b), "matchId": match_id,
                "eventId": ev["eventId"], "source": ev["source"], "detail": ev["note"],
            })

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
        "source": "ESPN + TheSportsDB",
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

    # Fetch BOTH sources per day and normalize each to the common event shape.
    # build() merges them per match (most-updated wins). A day "fails" only when
    # BOTH sources fail to return for it — one source covering for the other is
    # fine and is the whole point of running two.
    events = []
    failed_days = []
    for d in daterange(START_DATE, END_DATE):
        iso = d.isoformat()

        # TheSportsDB: day endpoint, league-filtered (uncapped, has penalty fields).
        sdb_url = "%seventsday.php?d=%s&l=%s" % (SPORTSDB_BASE, iso, LEAGUE_ID)
        sdb = fetch_json(sdb_url)
        time.sleep(REQUEST_SPACING_S)

        # ESPN: scoreboard for the date (YYYYMMDD), no key, finalizes faster.
        espn_url = "%s?dates=%s" % (ESPN_SCOREBOARD, d.strftime("%Y%m%d"))
        espn = fetch_json(espn_url)
        time.sleep(REQUEST_SPACING_S)

        # fetch_json returns None on a hard failure (after retries) but {} for a
        # legitimately empty day. Only None means that source is missing data.
        if sdb is None and espn is None:
            failed_days.append(iso)
            continue

        day = []
        for raw in (sdb.get("events") if isinstance(sdb, dict) else None) or []:
            day.append(normalize_sportsdb(raw, resolve))
        for raw in (espn.get("events") if isinstance(espn, dict) else None) or []:
            norm = normalize_espn(raw, resolve)
            if norm is not None:
                day.append(norm)
        if day:
            n_sdb = sum(1 for e in day if e["source"] == "TheSportsDB")
            print("  %s: %d event(s) (TheSportsDB %d, ESPN %d)"
                  % (iso, len(day), n_sdb, len(day) - n_sdb))
            events.extend(day)

    # If any day failed to fetch FROM BOTH sources, the event set is incomplete
    # and rebuilding from it could downgrade an already-decided match back to
    # "pending". Bail out WITHOUT writing so the last good results-data.js stays
    # committed; the next scheduled run (or a manual re-run) recovers.
    if failed_days:
        print("Aborting: %d day(s) failed to fetch from both sources (%s). Leaving %s untouched."
              % (len(failed_days), ", ".join(failed_days),
                 OUTPUT_FILE.relative_to(REPO_ROOT)), file=sys.stderr)
        sys.exit(1)

    print("Fetched %d total event(s) across both sources." % len(events))
    # Feed the previously-committed results in so a decided match never regresses
    # to undecided when a source drops out (see build()'s sticky-winner note).
    existing = read_existing_payload()
    prior_results = existing.get("results") if existing else None
    results, unmatched, warnings = build(bracket, events, prior_results)

    decided = sum(1 for r in results.values() if r.get("winner"))
    print("Resolved %d/%d matches; %d unmatched event(s); %d warning(s)."
          % (decided, len(results), len(unmatched), len(warnings)))
    for w in warnings:
        print("  warning:", json.dumps(w, ensure_ascii=False), file=sys.stderr)

    # Skip the write (and thus a no-op git commit) when nothing meaningful
    # changed -- otherwise a frequent cron would churn the timestamp forever.
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
