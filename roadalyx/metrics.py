"""Crash metrics computed on cleaned crash records (one dict per crash, see cris.build_crashes).

Pure Python on purpose: the same functions run in the CLI report, the tests and the
Lambda API, and the API does not need pandas at runtime.
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
TREND_AXES = ("year", "month", "hour", "weekday")
BREAKDOWN_FIELDS = ("county", "road_class", "rural", "weather", "collision", "first_event",
                    "intersection", "speed_limit")


def _by_severity(crashes) -> dict[str, int]:
    counts = Counter(c["severity"] for c in crashes)
    return {s: counts.get(s, 0) for s in SEVERITIES}


def _ka_share(counts: dict[str, int], total: int) -> float | None:
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
    crashes_with = Counter()
    severe_with = Counter()
    for c in crashes:
        for f in c["factors"]:
            if f in NON_CAUSAL_FACTORS:
                continue
            crashes_with[f] += 1
            if c["severity"] in ("K", "A"):
                severe_with[f] += 1
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
    for c in crashes:
        if c["hour"] is None:
            continue
        grid[c["weekday"]][c["hour"]] += 1
        if c["severity"] in ("K", "A"):
            severe[c["weekday"]][c["hour"]] += 1
    return {"rows": list(calendar.day_name), "crashes": grid, "ka_crashes": severe}


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
    rows.sort(key=lambda r: (r["value"] is None, -r["crashes"], str(r["value"])))
    return {"by": by, "total": len(crashes), "groups": rows[:limit] if limit else rows}
