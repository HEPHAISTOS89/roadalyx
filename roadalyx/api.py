"""Read-only REST API over the processed crash records, plus the static portal.

Run locally:  uvicorn roadalyx.api:app --reload
On AWS:       Lambda handler `roadalyx.api.handler` behind a Lambda function URL.

Every data endpoint takes the same filters (county, severity, year_from, year_to,
road_class, factor, vru) and echoes them back, so a number is never shown without
the selection it was computed on.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from mangum import Mangum

from . import metrics, schemas
from .dataset import Dataset, load, slug
from .query import Filters

DATA_SOURCE = os.environ.get("ROADALYX_DATA", "data/processed/crashes.json.gz")
WEB_DIR = Path(os.environ.get("ROADALYX_WEB", Path(__file__).parent / "web"))
MAX_PAGE = 1000

# The map basemap is the only third-party origin the portal talks to.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self' data:; "
       "connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; "
       "frame-ancestors 'none'; base-uri 'self'; form-action 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}

app = FastAPI(
    title="Roadalyx API",
    version="1.0.0",
    summary="Crash analytics for the TxDOT Lubbock District, from a TxDOT CRIS export.",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@lru_cache(maxsize=1)
def data() -> Dataset:
    """Loaded once per process: on Lambda, once per cold start."""
    return load(DATA_SOURCE)


@app.middleware("http")
async def headers_and_access_log(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    response.headers.update(SECURITY_HEADERS)
    if request.url.path.startswith("/api/") and "cache-control" not in response.headers:
        # The data changes only on redeploy: let browsers reuse answers for five minutes.
        response.headers["Cache-Control"] = "public, max-age=300"
    # One JSON line per request; CloudWatch Logs Insights can query these fields directly.
    print(json.dumps({"method": request.method, "path": request.url.path, "status": response.status_code,
                      "ms": round((time.perf_counter() - started) * 1000, 1)}))
    return response


# Filters -------------------------------------------------------------------

def _split(values: list[str]) -> list[str]:
    """Accept both ?county=lubbock&county=hale and ?county=lubbock,hale."""
    return [v.strip() for value in values for v in value.split(",") if v.strip()]


def _known(name: str, values: list[str], allowed: list[str]) -> frozenset[str]:
    chosen = {slug(v) for v in _split(values)}
    unknown = chosen - set(allowed)
    if unknown:
        raise HTTPException(422, {"parameter": name, "unknown": sorted(unknown), "allowed": allowed})
    return frozenset(chosen)


def filters(
    county: Annotated[list[str], Query(description="County name or slug, e.g. lubbock. Repeat or comma-separate.")] = [],
    severity: Annotated[list[str], Query(description="KABCO code: K, A, B or C. Repeat or comma-separate.")] = [],
    year_from: Annotated[int | None, Query(ge=1900, le=2100, description="First crash year, inclusive.")] = None,
    year_to: Annotated[int | None, Query(ge=1900, le=2100, description="Last crash year, inclusive.")] = None,
    road_class: Annotated[list[str], Query(description="CRIS road class or slug, e.g. interstate, city-street.")] = [],
    factor: Annotated[str | None, Query(max_length=120, description="Only crashes citing this contributing factor (name or slug).")] = None,
    vru: Annotated[list[str], Query(description="Crashes involving a pedestrian, pedalcyclist or motorcyclist.")] = [],
) -> Filters:
    opts = data().options
    if year_from is not None and year_to is not None and year_from > year_to:
        raise HTTPException(422, {"parameter": "year_from", "message": "year_from is after year_to"})
    factor_slug = None
    if factor:
        factor_slug = slug(factor)
        if factor_slug not in {o["value"] for o in opts["factor"]}:
            raise HTTPException(422, {"parameter": "factor", "unknown": [factor_slug],
                                      "message": "see /api/v1/meta for the factor list"})
    return Filters(
        county=_known("county", county, [o["value"] for o in opts["county"]]),
        severity=frozenset(s.upper() for s in _known("severity", severity, ["k", "a", "b", "c"])),
        road_class=_known("road_class", road_class, [o["value"] for o in opts["road_class"]]),
        vru=_known("vru", vru, opts["vru"]),
        year_from=year_from, year_to=year_to, factor=factor_slug,
    )


FilterDep = Annotated[Filters, Depends(filters)]


def _envelope(f: Filters, crashes: list[dict], payload: dict) -> dict:
    return {"filters": f.as_dict(), **payload, "total": len(crashes)}


# Endpoints -----------------------------------------------------------------

@app.get("/api/health", tags=["service"])
def health():
    d = data()
    return {"status": "ok", "crashes": len(d.crashes), "processed_at": d.meta.get("processed_at")}


@app.get("/api/v1/meta", tags=["service"], summary="Dataset provenance, coverage and valid filter values")
def meta():
    d = data()
    start, end = d.coverage
    return {
        "dataset": d.meta,
        "coverage": {"start": start.isoformat(), "end": end.isoformat()},
        "filters": d.options,
        "definitions": {
            "severity": metrics.SEVERITY_LABELS,
            "ka": "Fatal (K) plus suspected serious injury (A) crashes.",
            "crash_severity": "A crash takes the severity of its most seriously injured person.",
            "non_causal_factors": sorted(metrics.NON_CAUSAL_FACTORS),
            "scope": "The export holds K, A, B and C crashes only: no property-damage-only (O) crashes.",
        },
    }


@app.get("/api/v1/severity", response_model=schemas.SeverityResponse, tags=["metrics"],
         summary="Crash counts by KABCO severity")
def severity(f: FilterDep):
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.severity_counts(crashes))


@app.get("/api/v1/factors", response_model=schemas.FactorsResponse, tags=["metrics"],
         summary="Most frequent contributing factors")
def factors(f: FilterDep, limit: Annotated[int, Query(ge=1, le=100)] = 5):
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.top_factors(crashes, limit))


@app.get("/api/v1/trends", response_model=schemas.TrendResponse, tags=["metrics"],
         summary="Crash counts over time, split by severity")
def trends(f: FilterDep, by: Literal["year", "month", "hour", "weekday"] = "year"):
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.trend(crashes, by, data().coverage))


@app.get("/api/v1/heatmap", response_model=schemas.HeatmapResponse, tags=["metrics"],
         summary="Crashes by day of week and hour of day")
def heatmap(f: FilterDep):
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.weekday_hour(crashes))


@app.get("/api/v1/breakdown", response_model=schemas.BreakdownResponse, tags=["metrics"],
         summary="Crashes and severity mix per county, road class, weather...")
def breakdown(f: FilterDep,
              by: Literal["county", "road_class", "weather", "collision", "first_event",
                          "intersection", "speed_limit"] = "county",
              limit: Annotated[int | None, Query(ge=1, le=500)] = None):
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.breakdown(crashes, by, limit))


SORTS = {
    "newest": (lambda c: (c["date"], c["time"] or ""), True),
    "oldest": (lambda c: (c["date"], c["time"] or ""), False),
    "severity": (lambda c: ("KABC".index(c["severity"]), c["date"]), False),
}
CSV_FIELDS = list(schemas.Crash.model_fields)


def _csv_safe(value):
    """Text from police reports could start with = + - @: quote it so a spreadsheet never runs it as a formula."""
    return "'" + value if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


@app.get("/api/v1/crashes", response_model=schemas.CrashPage, tags=["records"],
         summary="Crash records, paginated (JSON) or all of them (CSV)",
         responses={200: {"content": {"text/csv": {}}}})
def crashes(f: FilterDep,
            limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 100,
            offset: Annotated[int, Query(ge=0)] = 0,
            sort: Literal["newest", "oldest", "severity"] = "newest",
            format: Literal["json", "csv"] = "json"):
    key, reverse = SORTS[sort]
    rows = sorted(f.apply(data().crashes), key=key, reverse=reverse)
    if format == "csv":
        # CSV is the export path: every matching crash, no paging.
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for c in rows:
            row = {**c, "factors": "; ".join(c["factors"]), "vru": "; ".join(c["vru"])}
            writer.writerow({k: _csv_safe(v) for k, v in row.items()})
        # Always gzipped: the full export is ~6 MB raw, the Lambda response limit. Browsers, pandas and
        # requests decode it transparently; curl needs --compressed.
        return Response(gzip.compress(out.getvalue().encode(), mtime=0), media_type="text/csv; charset=utf-8",
                        headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding",
                                 "Content-Disposition": 'attachment; filename="roadalyx-crashes.csv"'})
    return _envelope(f, rows, {"limit": limit, "offset": offset, "crashes": rows[offset:offset + limit]})


@app.get("/api/v1/crashes/{crash_id}", response_model=schemas.Crash, tags=["records"],
         summary="One crash by CRIS Crash ID")
def crash(crash_id: int):
    found = data().by_id.get(crash_id)
    if found is None:
        raise HTTPException(404, f"No crash {crash_id} in this dataset")
    return found


@app.get("/api/v1/points", response_model=schemas.PointsResponse, tags=["records"],
         summary="Located crashes as compact arrays, for maps")
def points(f: FilterDep):
    rows = f.apply(data().crashes)
    located = [c for c in rows if c["lat"] is not None and c["lon"] is not None]
    return _envelope(f, rows, {
        "located": len(located),
        "id": [c["id"] for c in located],
        "lon": [c["lon"] for c in located],
        "lat": [c["lat"] for c in located],
        "severity": "".join(c["severity"] for c in located),
    })


@app.get("/api/{rest:path}", include_in_schema=False)
def api_not_found(rest: str):
    return JSONResponse({"detail": f"No endpoint /api/{rest}. See /api/docs."}, status_code=404)


# Portal --------------------------------------------------------------------

if (WEB_DIR / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def portal(path: str):
        """Files from the built portal; any other path is a client-side route and gets index.html."""
        file = (WEB_DIR / path).resolve()
        if path and file.is_file() and file.is_relative_to(WEB_DIR.resolve()):
            return FileResponse(file)
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


handler = Mangum(app, lifespan="off")
