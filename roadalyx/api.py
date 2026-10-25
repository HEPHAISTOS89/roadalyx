"""Read-only REST API over the processed crash records, plus the static portal.

Run locally:  uvicorn roadalyx.api:app --reload
On AWS:       Lambda handler `roadalyx.api.handler` behind a Lambda function URL.

Every data endpoint takes the same filters (county, severity, year_from, year_to,
road_class, factor, vru, street, location) and echoes them back, so a number is never
shown without the selection it was computed on.

How a request is served:
  Function URL -> Mangum (`handler`, bottom of this file) -> FastAPI route -> filters() validates
  the query -> Filters.apply() selects crashes from the in-memory dataset -> a metrics.* function
  -> JSON (or CSV). The middleware adds security headers and writes one log line to CloudWatch.

Sections: configuration, access log, filters, endpoints, interaction events, portal.
"""

from __future__ import annotations

import base64
import csv
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from mangum import Mangum
from pydantic import BaseModel, Field

from . import metrics, schemas
from .dataset import Dataset, load, slug
from .query import Filters

# Configuration -------------------------------------------------------------

# Where the processed dataset is: a local file by default, s3://... on Lambda (set by CloudFormation).
DATA_SOURCE = os.environ.get("ROADALYX_DATA", "data/processed/crashes.json.gz")
WEB_DIR = Path(os.environ.get("ROADALYX_WEB", Path(__file__).parent / "web"))
# Largest page of crash records one JSON request can ask for; the CSV export has no page limit.
MAX_PAGE = 1000

# The map basemap is the only third-party origin the portal talks to.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self' data:; "
       "connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; "
       "frame-ancestors 'none'; base-uri 'self'; form-action 'none'")
# Swagger UI (/api/docs) loads one pinned release from jsDelivr. Its CSP allows that path only,
# plus the page's own inline start-up script by hash (computed in api_docs below).
SWAGGER = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/"
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
    docs_url=None,  # served by api_docs() with a pinned Swagger UI
    redoc_url=None,
    openapi_url="/api/openapi.json",
)
# Compress responses over 1 KB: the map points and breakdowns shrink several times over the network.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# When this instance started and how long the dataset took to load, reported by /api/health.
STARTED = time.time()
LOADED: dict = {}


@lru_cache(maxsize=1)
def data() -> Dataset:
    """Loaded once per process: on Lambda, once per cold start."""
    started = time.perf_counter()
    dataset = load(DATA_SOURCE)
    LOADED["ms"] = round((time.perf_counter() - started) * 1000, 1)
    return dataset


# Access log -----------------------------------------------------------------

# User-Agent markers, checked in order (Edge and Opera also say "Chrome/", so they come first).
_OS = (("Windows", "Windows"), ("iPhone", "iOS"), ("iPad", "iOS"), ("Android", "Android"),
       ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))
_BROWSERS = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"),
             ("CriOS/", "Chrome"), ("Safari/", "Safari"))
_BOTS = ("bot", "crawl", "spider", "curl", "python", "wget", "headless", "go-http")


def client_of(user_agent: str) -> dict:
    """Operating system and browser family from the User-Agent; no IP or full string is kept."""
    if any(b in user_agent.lower() for b in _BOTS):
        return {"os": "bot", "browser": "bot"}
    os_name = next((name for key, name in _OS if key in user_agent), "other")
    browser = next((name for key, name in _BROWSERS if key in user_agent), "other")
    return {"os": os_name, "browser": browser}


@app.middleware("http")
async def headers_and_access_log(request: Request, call_next):
    """Runs around every request: security headers, cache rules, and one JSON log line."""
    started = time.perf_counter()
    response = await call_next(request)
    response.headers.update({k: v for k, v in SECURITY_HEADERS.items() if k not in response.headers})
    path = request.url.path
    if (path.startswith("/api/v1/") and 200 <= response.status_code < 300
            and "cache-control" not in response.headers):
        # The data changes only on redeploy: let browsers reuse answers for five minutes.
        response.headers["Cache-Control"] = "public, max-age=300"
    elif path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")  # errors and liveness are never cached
    # One JSON line per request; CloudWatch Logs Insights can query these fields directly.
    # The referrer keeps only its host (where the visitor came from), never the full URL.
    try:
        referrer = (urlsplit(request.headers.get("referer", "")).hostname or "")[:100] or None
    except ValueError:  # a malformed Referer must not turn the response into an error
        referrer = "invalid"
    # The query string is the selection (filters, page, axis) on API calls; it carries nothing about the visitor.
    query = request.url.query[:400] if path.startswith("/api/") and request.url.query else None
    print(json.dumps({"method": request.method, "path": request.url.path, "status": response.status_code,
                      "ms": round((time.perf_counter() - started) * 1000, 1),
                      **client_of(request.headers.get("user-agent", "")), "from": referrer, "q": query}))
    return response


# Filters -------------------------------------------------------------------

def _split(values: list[str]) -> list[str]:
    """Accept both ?county=lubbock&county=hale and ?county=lubbock,hale."""
    return [v.strip() for value in values for v in value.split(",") if v.strip()]


def _known(name: str, values: list[str], allowed: list[str]) -> frozenset[str]:
    """Slugs of the chosen values; any value not in the data is a 422 that lists the allowed ones."""
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
    street: Annotated[list[str], Query(description="CRIS street name or slug, e.g. US0084, slide-rd. Repeat or comma-separate.")] = [],
    location: Annotated[Literal["intersection", "segment", "driveway"] | None,
                        Query(description="Intersection or intersection-related, segment (non-intersection), or driveway access.")] = None,
) -> Filters:
    """The query string as one Filters object. FastAPI calls it for every data endpoint (FilterDep),
    so validation and error messages are the same everywhere."""
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
        street=_streets(street), location=location,
    )


def _streets(values: list[str]) -> frozenset[str]:
    """Streets are checked against the 1,300+ names in the data instead of a list in /meta."""
    chosen = {slug(v) for raw in values for v in raw.split(",") if v.strip()}
    unknown = chosen - data().streets
    if unknown:
        raise HTTPException(422, {"parameter": "street", "unknown": sorted(unknown),
                                  "message": "no crash on this street; see /api/v1/breakdown?by=street"})
    return frozenset(chosen)


FilterDep = Annotated[Filters, Depends(filters)]


def _envelope(f: Filters, crashes: list[dict], payload: dict) -> dict:
    """Every filtered response has the same frame: the filters applied, the result, the crash total."""
    return {"filters": f.as_dict(), **payload, "total": len(crashes)}


# Endpoints -----------------------------------------------------------------

@app.get("/api/docs", include_in_schema=False)
def api_docs():
    """Interactive API reference (Swagger UI), with its own stricter CSP built from the page's scripts."""
    page = get_swagger_ui_html(openapi_url=app.openapi_url, title="Roadalyx API",
                               swagger_js_url=SWAGGER + "swagger-ui-bundle.js",
                               swagger_css_url=SWAGGER + "swagger-ui.css", swagger_favicon_url="/favicon.svg")
    html = page.body.decode()
    inline = [m.group(1) for m in re.finditer(r"<script>(.*?)</script>", html, re.S)]
    hashes = " ".join(f"'sha256-{base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()}'" for s in inline)
    page.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src {SWAGGER} {hashes}; style-src {SWAGGER}; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'")
    return page


@app.get("/api/health", tags=["service"], summary="Liveness, data freshness and where this instance runs")
def health():
    """Used by the deploy script's smoke test: proves the function runs and the dataset loaded."""
    d = data()
    env = os.environ
    return {
        "status": "ok",
        "crashes": len(d.crashes),
        "processed_at": d.meta.get("processed_at"),
        "data_source": "s3" if DATA_SOURCE.startswith("s3://") else "file",
        "data_load_ms": LOADED.get("ms"),
        "instance_age_s": round(time.time() - STARTED),
        "runtime": {
            "platform": "aws-lambda" if "AWS_LAMBDA_FUNCTION_NAME" in env else "local",
            "region": env.get("AWS_REGION"),
            "function": env.get("AWS_LAMBDA_FUNCTION_NAME"),
            "memory_mb": int(env["AWS_LAMBDA_FUNCTION_MEMORY_SIZE"]) if "AWS_LAMBDA_FUNCTION_MEMORY_SIZE" in env else None,
            "python": env.get("AWS_EXECUTION_ENV") or f"python{sys.version_info.major}.{sys.version_info.minor}",
        },
    }


@app.get("/api/v1/meta", tags=["service"], summary="Dataset provenance, coverage and valid filter values")
def meta():
    """What the dataset is and what each filter accepts. The portal builds its menus from this."""
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
    """Required metric 1: K, A, B and C crash counts, the K+A share, people killed and seriously injured."""
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.severity_counts(crashes))


@app.get("/api/v1/factors", response_model=schemas.FactorsResponse, tags=["metrics"],
         summary="Most frequent contributing factors")
def factors(f: FilterDep, limit: Annotated[int, Query(ge=1, le=100)] = 5):
    """Required metric 2: the top contributing factors (5 by default), each with its K+A share."""
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.top_factors(crashes, limit))


@app.get("/api/v1/trends", response_model=schemas.TrendResponse, tags=["metrics"],
         summary="Crash counts over time, split by severity")
def trends(f: FilterDep, by: Literal["year", "month", "hour", "weekday"] = "year"):
    """Required metric 3: crashes per year, month, hour of day or day of week, split by severity."""
    crashes = f.apply(data().crashes)
    # Periods outside the requested years are not zeros, they are out of scope: clip the axis to them.
    start, end = data().coverage
    if f.year_from is not None:
        start = max(start, date(f.year_from, 1, 1))
    if f.year_to is not None:
        end = min(end, date(f.year_to, 12, 31))
    return _envelope(f, crashes, metrics.trend(crashes, by, (start, end)))


@app.get("/api/v1/heatmap", response_model=schemas.HeatmapResponse, tags=["metrics"],
         summary="Crashes by day of week and hour of day")
def heatmap(f: FilterDep):
    """When crashes happen within the week: a 7 x 24 grid, for the day-and-hour chart."""
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.weekday_hour(crashes))


@app.get("/api/v1/breakdown", response_model=schemas.BreakdownResponse, tags=["metrics"],
         summary="Crashes and severity mix per county, road class, weather...")
def breakdown(f: FilterDep,
              by: Literal["county", "road_class", "rural", "weather", "collision", "first_event",
                          "intersection", "speed_limit", "street"] = "county",
              limit: Annotated[int | None, Query(ge=1, le=500)] = None):
    """Crashes grouped by one attribute; by=street ranks corridors, by=intersection feeds the Location filter."""
    crashes = f.apply(data().crashes)
    return _envelope(f, crashes, metrics.breakdown(crashes, by, limit))


# Sort orders for the crash list: (sort key, descending?). Severity sorts K first, then by date.
SORTS = {
    "newest": (lambda c: (c["date"], c["time"] or ""), True),
    "oldest": (lambda c: (c["date"], c["time"] or ""), False),
    "severity": (lambda c: ("KABC".index(c["severity"]), c["date"]), False),
}
# The CSV has the same columns as a JSON crash record, in the same order.
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
    """The crash records behind the figures: a page of JSON for the table, or every match as CSV."""
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
    """The full record of one crash, opened from a map point or a table row."""
    found = data().by_id.get(crash_id)
    if found is None:
        raise HTTPException(404, f"No crash {crash_id} in this dataset")
    return found


@app.get("/api/v1/points", response_model=schemas.PointsResponse, tags=["records"],
         summary="Located crashes as compact arrays, for maps")
def points(f: FilterDep):
    """Coordinates, severity and date of every located crash in the selection, for both maps.
    `total` still counts the crashes without coordinates, so the portal can say how many are missing."""
    rows = f.apply(data().crashes)
    located = [c for c in rows if c["lat"] is not None and c["lon"] is not None]
    # Street names repeat across thousands of crashes: send each once, and an index per point.
    streets = sorted({c["street"] for c in located if c["street"]})
    index = {name: i for i, name in enumerate(streets)}
    return _envelope(f, rows, {
        "located": len(located),
        "start": data().coverage[0].isoformat(),
        "id": [c["id"] for c in located],
        "lon": [c["lon"] for c in located],
        "lat": [c["lat"] for c in located],
        "severity": "".join(c["severity"] for c in located),
        "day": [data().day[c["id"]] for c in located],
        "streets": streets,
        "street": [index.get(c["street"], -1) for c in located],
    })


# Interaction events ------------------------------------------------------------
# The portal (web/src/lib/track.ts) reports what a visitor does: pages, clicks, filters, map zoom.
# Strict sizes and a pattern on the id keep the endpoint from being used to flood the logs.

class _Event(BaseModel):
    t: int = Field(ge=0, le=86_400_000)  # ms since the page loaded
    a: str = Field(max_length=40)         # action: page, click, change, zoom, drag, hover, scroll, tab…
    d: str = Field("", max_length=200)    # what it acted on: a control's label, a chart, a map
    p: str = Field("", max_length=120)    # the page and selection it happened on
    n: int = Field(1, ge=1, le=10_000)    # repeats merged into one line (hovers, wheel steps)


class _Events(BaseModel):
    s: str = Field(pattern=r"^[a-z0-9]{6,16}$")  # random per browser tab, not tied to a person
    e: list[_Event] = Field(max_length=100)


@app.post("/api/v1/events", status_code=204, include_in_schema=False)
def events(batch: _Events, request: Request):
    """Anonymous interaction log from the portal: what was clicked, filtered, zoomed or hovered, in order."""
    client = client_of(request.headers.get("user-agent", ""))
    for e in batch.e:
        print(json.dumps({"event": e.a, "detail": e.d, "page": e.p, "t": e.t, "n": e.n, "s": batch.s, **client}))
    return Response(status_code=204)


@app.get("/api/{rest:path}", include_in_schema=False)
def api_not_found(rest: str):
    return JSONResponse({"detail": f"No endpoint /api/{rest}. See /api/docs."}, status_code=404)


@app.get("/data-access", include_in_schema=False)
def data_access():
    """The portal's "Data access" tab: the interactive API reference."""
    return RedirectResponse("/api/docs")


# Portal --------------------------------------------------------------------

# Checked on every request, so a frontend built while the server runs is served without a restart.
@app.get("/{path:path}", include_in_schema=False)
def portal(path: str):
    """Files from the built portal; any other path is a client-side route and gets index.html."""
    index = WEB_DIR / "index.html"
    if not index.is_file():
        return JSONResponse({"detail": "The API is running, but the frontend is not built. Open /api/docs, "
                                       "or build it with: npm --prefix web ci && npm --prefix web run build"},
                            status_code=404)
    file = (WEB_DIR / path).resolve()
    if path and file.is_file() and file.is_relative_to(WEB_DIR.resolve()):
        return FileResponse(file)
    if path.startswith("assets/"):  # a missing build file, e.g. a chunk from the previous release
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


# The Lambda entry point (Handler: roadalyx.api.handler in infra/template.yaml). Mangum turns the
# Function URL event into an ASGI request for FastAPI and the response back into what Lambda returns,
# so the same app runs under uvicorn locally and on Lambda without changes.
handler = Mangum(app, lifespan="off")
