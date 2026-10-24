"""Read a TxDOT CRIS query export and turn its person rows into one record per crash.

A CRIS export has one row per *person* involved in a crash. Crash-level fields
(date, county, severity, contributing factors, location...) are repeated on every
person row of the same crash, so every crash metric must be computed on a table
with exactly one row per Crash ID. That table is what `build_crashes` returns.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

HEADER_START = '"Crash ID"'
# CRIS writes a missing value as text; these are the spellings found in the export.
MISSING = {"", "NO DATA", "NOT REPORTED"}
SEVERITIES = ("K", "A", "B", "C")
# Generous Texas bounding box: a coordinate outside it is a geocoding error, not a crash location.
TEXAS_BOUNDS = {"lat": (25.8, 36.6), "lon": (-106.7, -93.5)}
# Person Type codes (CRIS code list) that identify vulnerable road users.
VRU_PERSON_TYPES = {"3": "pedalcyclist", "4": "pedestrian", "5": "motorcyclist", "6": "motorcyclist"}

# Crash-level columns the pipeline keeps. Everything else is person or vehicle level.
CRASH_COLUMNS = [
    "Crash ID", "Crash Date", "Crash Time", "Crash Year", "County", "Crash Severity",
    "Crash Death Count", "Crash Suspected Serious Injury Count", "Crash Total Injury Count",
    "Contributing Factors", "Road Class", "Speed Limit", "Latitude", "Longitude",
    "Rural Flag", "Intersection Related", "At Intersection Flag", "Weather Condition",
    "Manner of Collision", "First Harmful Event", "Street Name", "Construction Zone Flag",
    "Active School Zone Flag", "TxDOT Reportable Flag",
]


@dataclass
class Export:
    """A parsed CRIS export: person rows plus what the file header says it contains."""

    persons: pd.DataFrame
    declared_crashes: int | None = None
    declared_units: int | None = None
    declared_persons: int | None = None
    filters: list[str] = field(default_factory=list)


def read_export(path: str | Path) -> Export:
    """Read the CSV, skipping the disclaimer lines CRIS writes above the header row."""
    path = Path(path)
    with path.open(encoding="utf-8-sig") as f:
        preamble = []
        for line in f:
            if line.startswith(HEADER_START):
                break
            preamble.append(line.strip().strip('"'))
        else:
            raise ValueError(f"{path}: no header row starting with {HEADER_START}")

    # dtype=str and keep_default_na=False: read every cell verbatim and decide what "missing" means ourselves.
    persons = pd.read_csv(path, skiprows=len(preamble), encoding="utf-8-sig",
                          dtype=str, keep_default_na=False)
    missing = [c for c in CRASH_COLUMNS + ["Person Type"] if c not in persons.columns]
    if missing:
        raise ValueError(f"{path}: missing expected CRIS columns: {', '.join(missing)}")

    export = Export(persons=persons)
    counts = next((re.search(r"([\d,]+) Crashes containing ([\d,]+) Units and ([\d,]+) Persons", line)
                   for line in preamble if "Crashes containing" in line), None)
    if counts:
        export.declared_crashes, export.declared_units, export.declared_persons = (
            int(n.replace(",", "")) for n in counts.groups())
    filters_at = next((i for i, line in enumerate(preamble) if line.startswith("Filters Applied")), None)
    if filters_at is not None:
        export.filters = [line for line in preamble[filters_at + 1:] if line]
    return export


def _text(value: str) -> str | None:
    text = " ".join(value.split()).upper()
    return None if text in MISSING else text


def _label(value: str) -> str | None:
    """'1 - CLEAR' -> 'CLEAR': drop the CRIS numeric code, keep the CRIS wording."""
    text = _text(value)
    return re.sub(r"^\d+\s*-\s*", "", text) if text else None


def _flag(value: str) -> bool | None:
    # The export mixes Yes/No, YES/NO and true/false across flag columns.
    return {"YES": True, "TRUE": True, "1": True, "NO": False, "FALSE": False, "0": False}.get(_text(value) or "")


def _int(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


def _coord(value: str, axis: str) -> float | None:
    try:
        number = float(value)
    except ValueError:
        return None
    low, high = TEXAS_BOUNDS[axis]
    return round(number, 6) if low <= number <= high else None


def _factors(value: str) -> list[str]:
    """Split 'A;B' and 'A; B' alike, normalise spacing and case, drop repeats, keep order."""
    out: list[str] = []
    for part in value.split(";"):
        token = _text(part)
        if token and token not in out:
            out.append(token)
    return out


def conflicting_crashes(persons: pd.DataFrame) -> int:
    """Number of crashes whose person rows disagree on a crash-level column (expected 0)."""
    varying = persons[CRASH_COLUMNS].groupby("Crash ID").nunique()
    return int((varying > 1).any(axis=1).sum())


def build_crashes(persons: pd.DataFrame) -> list[dict]:
    """Collapse person rows to one record per crash, with cleaned, typed fields."""
    people = persons.groupby("Crash ID").size()
    person_type = persons["Person Type"].str.split(" - ").str[0].map(VRU_PERSON_TYPES)
    vru = person_type.dropna().groupby(persons["Crash ID"]).agg(lambda s: sorted(set(s)))

    records = []
    for row in persons.drop_duplicates("Crash ID")[CRASH_COLUMNS].itertuples(index=False):
        r = dict(zip(CRASH_COLUMNS, row))
        crash_id = r["Crash ID"]
        date = pd.Timestamp(r["Crash Date"])
        hhmm = _int(r["Crash Time"])  # HHMM as an integer: 5 is 00:05, 1730 is 17:30
        if hhmm is not None and not (0 <= hhmm <= 2359 and hhmm % 100 < 60):
            hhmm = None
        speed = _int(r["Speed Limit"])
        severity = (_text(r["Crash Severity"]) or "")[:1]
        if severity not in SEVERITIES:
            raise ValueError(f"Crash {crash_id}: unexpected severity {r['Crash Severity']!r}")
        records.append({
            "id": int(crash_id),
            "date": date.date().isoformat(),
            "year": date.year,
            "month": date.month,
            "weekday": date.weekday(),  # 0 = Monday
            "hour": hhmm // 100 if hhmm is not None else None,
            "time": f"{hhmm // 100:02d}:{hhmm % 100:02d}" if hhmm is not None else None,
            "county": _text(r["County"]),
            "severity": severity,
            "deaths": _int(r["Crash Death Count"]) or 0,
            "serious_injuries": _int(r["Crash Suspected Serious Injury Count"]) or 0,
            "injuries": _int(r["Crash Total Injury Count"]) or 0,
            "people": int(people[crash_id]),
            "factors": _factors(r["Contributing Factors"]),
            "road_class": _text(r["Road Class"]),
            "speed_limit": speed if speed and speed > 0 else None,  # CRIS writes -1 for unknown
            "lat": _coord(r["Latitude"], "lat"),
            "lon": _coord(r["Longitude"], "lon"),
            "rural": _flag(r["Rural Flag"]),
            "intersection": _text(r["Intersection Related"]),
            "at_intersection": _flag(r["At Intersection Flag"]),
            "weather": _label(r["Weather Condition"]),
            "collision": _text(r["Manner of Collision"]),
            "first_event": _text(r["First Harmful Event"]),
            "street": _text(r["Street Name"]),
            "construction_zone": _flag(r["Construction Zone Flag"]),
            "school_zone": _flag(r["Active School Zone Flag"]),
            "reportable": _flag(r["TxDOT Reportable Flag"]),
            "vru": vru.get(crash_id, []),
        })
    records.sort(key=lambda c: (c["date"], c["time"] or "", c["id"]))
    return records
