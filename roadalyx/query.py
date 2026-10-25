"""Filters shared by every API endpoint."""

from __future__ import annotations

from dataclasses import dataclass

from .dataset import slug

# Crash location in HSM terms, from the CRIS "Intersection Related" field.
LOCATIONS = {"intersection": {"INTERSECTION", "INTERSECTION RELATED"}, "segment": {"NON INTERSECTION"},
             "driveway": {"DRIVEWAY ACCESS"}}


@dataclass(frozen=True)
class Filters:
    """Empty sets and None mean "no restriction". Categorical values are slugs (see dataset.slug)."""

    county: frozenset[str] = frozenset()
    severity: frozenset[str] = frozenset()
    road_class: frozenset[str] = frozenset()
    vru: frozenset[str] = frozenset()
    year_from: int | None = None
    year_to: int | None = None
    factor: str | None = None
    street: frozenset[str] = frozenset()
    location: str | None = None

    def matches(self, c: dict) -> bool:
        return ((not self.county or slug(c["county"]) in self.county)
                and (not self.severity or c["severity"] in self.severity)
                and (not self.road_class or slug(c["road_class"]) in self.road_class)
                and (not self.vru or not self.vru.isdisjoint(c["vru"]))
                and (self.year_from is None or c["year"] >= self.year_from)
                and (self.year_to is None or c["year"] <= self.year_to)
                and (self.factor is None or self.factor in {slug(f) for f in c["factors"]})
                and (not self.street or (c["street"] is not None and slug(c["street"]) in self.street))
                and (self.location is None or c["intersection"] in LOCATIONS[self.location]))

    def apply(self, crashes: list[dict]) -> list[dict]:
        return [c for c in crashes if self.matches(c)]

    def as_dict(self) -> dict:
        """The filters as applied, echoed in every response so a result is never ambiguous."""
        return {"county": sorted(self.county), "severity": [s for s in "KABC" if s in self.severity],
                "road_class": sorted(self.road_class), "vru": sorted(self.vru),
                "year_from": self.year_from, "year_to": self.year_to, "factor": self.factor,
                "street": sorted(self.street), "location": self.location}
