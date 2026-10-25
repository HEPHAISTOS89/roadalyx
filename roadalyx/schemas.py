"""Response models. They document the API (OpenAPI at /api/docs) and validate what it returns.

One model per endpoint, named after it. Every response that depends on a selection extends
`Filtered`, so it carries the filters the server applied and the number of matching crashes.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["K", "A", "B", "C"]


# Shared by every filtered response --------------------------------------------

class AppliedFilters(BaseModel):
    county: list[str]
    severity: list[Severity]
    road_class: list[str]
    vru: list[str]
    year_from: int | None
    year_to: int | None
    factor: str | None
    street: list[str]
    location: str | None


class Filtered(BaseModel):
    filters: AppliedFilters = Field(description="The filters as the server applied them (slugs).")
    total: int = Field(description="Crashes matching the filters.")


# /api/v1/severity: the KABCO counts ----------------------------------------------

class SeverityRow(BaseModel):
    code: Severity
    label: str
    crashes: int
    share: float | None


class SeverityResponse(Filtered):
    severity: list[SeverityRow]
    ka_share: float | None = Field(description="Share of crashes that are fatal (K) or serious injury (A).")
    deaths: int = Field(description="People killed (Crash Death Count).")
    serious_injuries: int = Field(description="People with a suspected serious injury.")


# /api/v1/factors: the contributing-factor ranking ---------------------------------

class FactorRow(BaseModel):
    rank: int
    factor: str
    crashes: int = Field(description="Crashes that cite this factor (counted once per crash).")
    share: float | None = Field(description="crashes / total. A crash can cite several factors.")
    ka_crashes: int
    ka_share: float = Field(description="Share of this factor's crashes that are K or A.")


class FactorsResponse(Filtered):
    crashes_without_coded_factor: int = Field(description="Crashes citing only NONE or OTHER (EXPLAIN IN NARRATIVE).")
    factors: list[FactorRow]


# /api/v1/trends and /api/v1/heatmap: crashes over time --------------------------

class TrendBucket(BaseModel):
    key: int | str
    label: str
    complete: bool = Field(description="False when the data only partly covers this year or month.")
    crashes: int
    K: int
    A: int
    B: int
    C: int


class TrendResponse(Filtered):
    by: Literal["year", "month", "hour", "weekday"]
    unknown: int = Field(description="Crashes with no usable value on this axis (e.g. invalid time).")
    buckets: list[TrendBucket]


class HeatmapResponse(Filtered):
    rows: list[str] = Field(description="Monday..Sunday")
    crashes: list[list[int]] = Field(description="7 x 24 counts, columns are hours 0..23.")
    ka_crashes: list[list[int]]
    unknown: int = Field(description="Crashes without a usable time, left out of the grid.")


# /api/v1/breakdown: crashes per county, road class, street, location... --------

class BreakdownRow(BaseModel):
    value: str | int | bool | None
    crashes: int
    K: int
    A: int
    B: int
    C: int
    ka_share: float | None
    deaths: int


class BreakdownResponse(Filtered):
    by: str
    groups: list[BreakdownRow]


# /api/v1/crashes: the individual crash records ------------------------------------

class Crash(BaseModel):
    """One cleaned crash record, the same fields cris.build_crashes writes."""

    id: int
    date: str
    time: str | None
    year: int
    month: int
    weekday: int = Field(description="0 = Monday")
    hour: int | None
    county: str | None
    severity: Severity
    deaths: int
    serious_injuries: int
    injuries: int = Field(description="People injured but not killed (CRIS Crash Total Injury Count).")
    people: int = Field(description="Person rows in the export for this crash.")
    factors: list[str]
    road_class: str | None
    speed_limit: int | None
    lat: float | None
    lon: float | None
    rural: bool | None
    intersection: str | None
    at_intersection: bool | None
    weather: str | None
    collision: str | None
    first_event: str | None
    street: str | None
    construction_zone: bool | None
    school_zone: bool | None
    reportable: bool | None
    vru: list[str]


class CrashPage(Filtered):
    limit: int
    offset: int
    crashes: list[Crash]


# /api/v1/points: every located crash, for the maps --------------------------------

class PointsResponse(Filtered):
    """Parallel arrays rather than one object per crash: the 23,400 located crashes stay small enough to send at once."""

    located: int = Field(description="Crashes with coordinates (the arrays below).")
    start: str = Field(description="First date of the dataset; `day` counts days from it.")
    id: list[int]
    lon: list[float]
    lat: list[float]
    severity: str = Field(description="One KABC letter per point, same order as the arrays.")
    day: list[int] = Field(description="Crash date as days since `start`.")
    streets: list[str] = Field(description="Street names in this response, as CRIS writes them (US0084, SLIDE RD).")
    street: list[int] = Field(description="Index into `streets` per point; -1 when the street is not recorded.")
