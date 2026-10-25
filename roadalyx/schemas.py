"""Response models. They document the API (OpenAPI at /api/docs) and validate what it returns."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["K", "A", "B", "C"]


class AppliedFilters(BaseModel):
    county: list[str]
    severity: list[Severity]
    road_class: list[str]
    vru: list[str]
    year_from: int | None
    year_to: int | None
    factor: str | None


class Filtered(BaseModel):
    filters: AppliedFilters = Field(description="The filters as the server applied them (slugs).")
    total: int = Field(description="Crashes matching the filters.")


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


class Crash(BaseModel):
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


class PointsResponse(Filtered):
    located: int = Field(description="Crashes with coordinates (the arrays below).")
    start: str = Field(description="First date of the dataset; `day` counts days from it.")
    id: list[int]
    lon: list[float]
    lat: list[float]
    severity: str = Field(description="One KABC letter per point, same order as the arrays.")
    day: list[int] = Field(description="Crash date as days since `start`.")
    streets: list[str] = Field(description="Street names in this response, as CRIS writes them (US0084, SLIDE RD).")
    street: list[int] = Field(description="Index into `streets` per point; -1 when the street is not recorded.")
