"""The processed dataset: crash records plus provenance, stored as one gzipped JSON file.

The pipeline writes it once; the API reads it at start-up from a local path or from S3.
About 900 KB compressed, it fits in Lambda memory, which is why the API needs no database:
it loads the file on a cold start and answers every request from memory after that.
"""

from __future__ import annotations

import gzip
import json
import re
from functools import lru_cache
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile

# Bumped if the record layout changes, so an API never reads a file it does not understand.
SCHEMA_VERSION = 1
# Vulnerable road users, as flagged per crash by cris.build_crashes.
VRU_TYPES = ("pedestrian", "pedalcyclist", "motorcyclist")


@lru_cache(maxsize=4096)  # a few hundred distinct labels, compared on every request
def slug(value) -> str:
    """'US & STATE HIGHWAYS' -> 'us-state-highways'. Filters compare slugs, so case and punctuation never matter."""
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


@dataclass
class Dataset:
    """The crash records in memory, checked once, with the lookups every request reuses."""

    crashes: list[dict]
    meta: dict

    def __post_init__(self):
        # Refuse an empty or duplicated dataset rather than serve wrong totals.
        if not self.crashes:
            raise ValueError("The dataset contains no crash records.")
        if len({c["id"] for c in self.crashes}) != len(self.crashes):
            raise ValueError("The dataset contains a duplicate Crash ID.")
        dates = [c["date"] for c in self.crashes]
        self.coverage = (date.fromisoformat(min(dates)), date.fromisoformat(max(dates)))
        # Direct lookup for /api/v1/crashes/{id}, the record behind a point on the map.
        self.by_id = {c["id"]: c for c in self.crashes}
        # Days since the first date, for timeline playback; computed once, not per request.
        self.day = {c["id"]: (date.fromisoformat(c["date"]) - self.coverage[0]).days for c in self.crashes}
        # The valid value of each filter, served by /api/v1/meta so the portal's menus are built from the data.
        self.options = {
            "county": _choices(c["county"] for c in self.crashes),
            "road_class": _choices(c["road_class"] for c in self.crashes),
            "factor": _choices(f for c in self.crashes for f in c["factors"]),
            "year": sorted({c["year"] for c in self.crashes}),
            "severity": ["K", "A", "B", "C"],
            "vru": list(VRU_TYPES),
        }
        # Street filter values: 1,300+ names, so they are checked here rather than listed in /meta.
        self.streets = {slug(c["street"]) for c in self.crashes if c["street"]}


def _choices(values) -> list[dict]:
    """Distinct values with their slug and crash count, most frequent first."""
    counts: dict[str, int] = {}
    for v in values:
        if v is not None:
            counts[v] = counts.get(v, 0) + 1
    return [{"value": slug(v), "label": v, "crashes": n}
            for v, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def save(path: str | Path, crashes: list[dict], meta: dict) -> Path:
    """Write the dataset as compact, gzipped JSON, replacing any previous file only once it is complete."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"schema_version": SCHEMA_VERSION, "meta": meta, "crashes": crashes}
    payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
    temporary = None
    try:
        # Same directory: replace is atomic, so a failed write cannot destroy the previous dataset.
        with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as temp:
            temporary = Path(temp.name)
            # Omit the temporary name and timestamp from the gzip header for deterministic output.
            with gzip.GzipFile(filename="", mode="wb", fileobj=temp, mtime=0) as f:
                f.write(payload)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path


def load(source: str) -> Dataset:
    """Load from a local path or an s3://bucket/key URI."""
    if source.startswith("s3://"):
        import boto3  # present in the Lambda runtime; only needed when reading from S3

        bucket, _, key = source[5:].partition("/")
        raw = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
    else:
        raw = Path(source).read_bytes()
    # Same format either way: gzipped JSON with a schema version, the provenance and the records.
    body = json.loads(gzip.decompress(raw))
    if body.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"{source}: schema version {body.get('schema_version')}, expected {SCHEMA_VERSION}")
    return Dataset(crashes=body["crashes"], meta=body["meta"])
