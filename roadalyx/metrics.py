"""Crash metrics computed on cleaned crash records (one dict per crash, see cris.build_crashes).

Pure Python on purpose: the same functions run in the CLI report, the tests and the
Lambda API, and the API does not need pandas at runtime.

Every function takes a list of crash records (already filtered by the API when a selection is
made) and returns plain dicts that the API returns as JSON. Counts are of crashes, not of people:
a crash with three injured people counts once.
"""

from __future__ import annotations

import calendar
from collections import Counter
from datetime import date

SEVERITIES = ("K", "A", "B", "C")
SEVERITY_LABELS = {
    "K": "Fatal injury",
    "A": "Suspected serious injury",
    "B": "Suspected minor injury",
    "C": "Possible injury",
}
# Tokens that record the absence of a coded cause, not a cause: kept in the data, left out of rankings.
NON_CAUSAL_FACTORS = {"NONE", "OTHER (EXPLAIN IN NARRATIVE)"}
# Time axes the trend endpoint accepts (/api/v1/trends?by=...).
TREND_AXES = ("year", "month", "hour", "weekday")
# Crash attributes the breakdown endpoint can group by (/api/v1/breakdown?by=...).
BREAKDOWN_FIELDS = ("county", "road_class", "rural", "weather", "collision", "first_event",
                    "intersection", "speed_limit", "street")


def _by_severity(crashes) -> dict[str, int]:
    """Crashes per KABCO code, with a zero for a code that does not occur."""
    counts = Counter(c["severity"] for c in crashes)
    return {s: counts.get(s, 0) for s in SEVERITIES}


def _ka_share(counts: dict[str, int], total: int) -> float | None:
    """Share of crashes that are fatal or suspected serious injury (K+A), the usual severe-crash measure."""
    return round((counts["K"] + counts["A"]) / total, 4) if total else None


def severity_counts(crashes: list[dict]) -> dict:
    """Crash counts by KABCO severity, plus the people killed and seriously injured."""
    counts = _by_severity(crashes)
    total = len(crashes)
    return {
        "total": total,
        "severity": [
            {"code": s, "label": SEVERITY_LABELS[s], "crashes": counts[s],
             "share": round(counts[s] / total, 4) if total else None}
            for s in SEVERITIES
        ],
        "ka_share": _ka_share(counts, total),
        "deaths": sum(c["deaths"] for c in crashes),
        "serious_injuries": sum(c["serious_injuries"] for c in crashes),
    }


def top_factors(crashes: list[dict], limit: int = 5) -> dict:
    """Most frequent contributing factors, counting each factor once per crash.

    A crash can list several factors, so shares do not add up to 100 %.
    """
    total = len(crashes)
    # For each factor: how many crashes cite it, and how many of those are K or A.
    crashes_with = Counter()
    severe_with = Counter()
    for c in crashes:
        for f in c["factors"]:
            if f in NON_CAUSAL_FACTORS:
                continue
            crashes_with[f] += 1
            if c["severity"] in ("K", "A"):
                severe_with[f] += 1
    # Crashes whose only entries are NONE or OTHER: reported, so the ranking's base is visible.
    no_coded_factor = sum(1 for c in crashes if not set(c["factors"]) - NON_CAUSAL_FACTORS)
    return {
        "total": total,
        "crashes_without_coded_factor": no_coded_factor,
        "factors": [
            {"rank": i, "factor": f, "crashes": n,
             "share": round(n / total, 4) if total else None,
             "ka_crashes": severe_with[f], "ka_share": round(severe_with[f] / n, 4)}
            # ties broken by name so the ranking is stable between runs
            for i, (f, n) in enumerate(sorted(crashes_with.items(), key=lambda kv: (-kv[1], kv[0]))[:limit], 1)
        ],
    }


def _months(start: date, end: date):
    """Every month from start to end as 'YYYY-MM', so a month with no crash still gets a bucket."""
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield f"{y}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def _month_start(key: str) -> date:
    return date(int(key[:4]), int(key[5:]), 1)


def _month_end(key: str) -> date:
    y, m = int(key[:4]), int(key[5:])
    return date(y, m, calendar.monthrange(y, m)[1])


def trend(crashes: list[dict], by: str, coverage: tuple[date, date]) -> dict:
    """Crash counts over one time axis, split by severity.

    `coverage` is the date range of the whole dataset: it fills empty buckets with zeros
    and marks years and months the data only partly covers, so a short year is not read
    as a drop in crashes.
    """
    if by not in TREND_AXES:
        raise ValueError(f"by must be one of {TREND_AXES}")
    start, end = coverage

    # Each axis defines: its buckets, which bucket a crash falls in, a label, and whether the
    # data covers the bucket fully (2026 stops in October, so it is flagged as a partial year).
    if by == "year":
        keys = list(range(start.year, end.year + 1))
        key = lambda c: c["year"]
        label = str
        complete = lambda k: date(k, 1, 1) >= start and date(k, 12, 31) <= end
    elif by == "month":
        keys = list(_months(start, end))
        key = lambda c: c["date"][:7]
        label = lambda k: f"{calendar.month_abbr[int(k[5:])]} {k[:4]}"
        complete = lambda k: _month_start(k) >= start and _month_end(k) <= end
    elif by == "hour":
        keys = list(range(24))
        key = lambda c: c["hour"]
        label = lambda k: f"{k:02d}:00"
        complete = lambda k: True
    else:
        keys = list(range(7))
        key = lambda c: c["weekday"]
        label = lambda k: calendar.day_name[k]
        complete = lambda k: True

    # Crashes with no usable value on this axis (a missing time, for the hour axis) are counted apart.
    buckets = {k: [] for k in keys}
    unknown = 0
    for c in crashes:
        k = key(c)
        if k in buckets:
            buckets[k].append(c)
        else:
            unknown += 1
    return {
        "by": by,
        "total": len(crashes),
        "unknown": unknown,
        "buckets": [
            {"key": k, "label": label(k), "complete": complete(k), "crashes": len(b), **_by_severity(b)}
            for k, b in buckets.items()
        ],
    }


def weekday_hour(crashes: list[dict]) -> dict:
    """7 x 24 grid of crash counts (rows Monday..Sunday, columns 00..23 h) for a heat map."""
    grid = [[0] * 24 for _ in range(7)]
    severe = [[0] * 24 for _ in range(7)]
    unknown = 0
    for c in crashes:
        if c["hour"] is None:
            unknown += 1
            continue
        grid[c["weekday"]][c["hour"]] += 1
        if c["severity"] in ("K", "A"):
            severe[c["weekday"]][c["hour"]] += 1
    return {"rows": list(calendar.day_name), "crashes": grid, "ka_crashes": severe, "unknown": unknown}


def breakdown(crashes: list[dict], by: str, limit: int | None = None) -> dict:
    """Crash counts and severity mix per value of one crash attribute, largest first."""
    if by not in BREAKDOWN_FIELDS:
        raise ValueError(f"by must be one of {BREAKDOWN_FIELDS}")
    groups: dict = {}
    for c in crashes:
        groups.setdefault(c[by], []).append(c)
    rows = []
    for value, group in groups.items():
        counts = _by_severity(group)
        rows.append({"value": value, "crashes": len(group), **counts,
                     "ka_share": _ka_share(counts, len(group)),
                     "deaths": sum(c["deaths"] for c in group)})
    # Largest groups first; an unknown value (None) always goes last, whatever its size.
    rows.sort(key=lambda r: (r["value"] is None, -r["crashes"], str(r["value"])))
    return {"by": by, "total": len(crashes), "groups": rows[:limit] if limit else rows}
