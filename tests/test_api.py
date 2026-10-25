"""API contract: endpoints, filters, validation errors, CSV export, headers, and the Lambda adapter."""

import base64
import gzip
import json

import pytest
from fastapi.testclient import TestClient

from roadalyx.api import app, handler

client = TestClient(app)


def get(path, **params):
    r = client.get(path, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_health_and_meta():
    health = get("/api/health")
    assert health["crashes"] == 4 and health["runtime"]["platform"] == "local"
    assert health["data_load_ms"] is not None
    meta = get("/api/v1/meta")
    assert meta["coverage"] == {"start": "2024-03-05", "end": "2025-12-31"}
    assert [c["value"] for c in meta["filters"]["county"]] == ["lubbock", "hale"]


def test_severity_and_filter_echo():
    body = get("/api/v1/severity", county="Lubbock")
    assert body["total"] == 3
    assert body["filters"]["county"] == ["lubbock"]
    assert {s["code"]: s["crashes"] for s in body["severity"]} == {"K": 0, "A": 1, "B": 1, "C": 1}


@pytest.mark.parametrize("params, total", [
    ({"severity": "k,a"}, 2),
    ({"severity": ["K", "A"]}, 2),
    ({"year_from": 2025}, 1),
    ({"road_class": "us-state-highways"}, 1),
    ({"road_class": "US & STATE HIGHWAYS"}, 1),
    ({"vru": "pedestrian"}, 1),
    ({"factor": "failed to control speed"}, 2),
    ({"county": "hale", "severity": "c"}, 0),
])
def test_filters(params, total):
    assert get("/api/v1/crashes", **params)["total"] == total


@pytest.mark.parametrize("params", [
    {"county": "dallas"}, {"severity": "O"}, {"year_from": 2026, "year_to": 2024},
    {"factor": "not a factor"}, {"vru": "truck"}, {"year_from": "abc"},
])
def test_invalid_filters_are_rejected_with_the_allowed_values(params):
    r = client.get("/api/v1/severity", params=params)
    assert r.status_code == 422


def test_unknown_county_lists_valid_ones():
    detail = client.get("/api/v1/severity", params={"county": "dallas"}).json()["detail"]
    assert detail == {"parameter": "county", "unknown": ["dallas"], "allowed": ["lubbock", "hale"]}


def test_factors_trends_heatmap_breakdown():
    assert get("/api/v1/factors", limit=1)["factors"][0]["factor"] == "FAILED TO CONTROL SPEED"
    years = get("/api/v1/trends", by="year")["buckets"]
    assert [(b["key"], b["crashes"]) for b in years] == [(2024, 3), (2025, 1)]
    assert get("/api/v1/trends", by="hour")["unknown"] == 1
    heat = get("/api/v1/heatmap")
    assert sum(map(sum, heat["crashes"])) == 3 and len(heat["crashes"]) == 7
    groups = get("/api/v1/breakdown", by="county")["groups"]
    assert [(g["value"], g["crashes"]) for g in groups] == [("LUBBOCK", 3), ("HALE", 1)]
    rural = get("/api/v1/breakdown", by="rural")["groups"]
    assert [(g["value"], g["crashes"]) for g in rural] == [(False, 3), (True, 1)]
    assert client.get("/api/v1/trends", params={"by": "decade"}).status_code == 422


def test_crash_records_paging_detail_and_points():
    page = get("/api/v1/crashes", limit=2, sort="oldest")
    assert [c["id"] for c in page["crashes"]] == [100, 102] and page["total"] == 4
    assert get("/api/v1/crashes", sort="severity")["crashes"][0]["severity"] == "K"
    assert get("/api/v1/crashes/101")["county"] == "HALE"
    assert client.get("/api/v1/crashes/999").status_code == 404
    assert client.get("/api/v1/crashes", params={"limit": 5000}).status_code == 422
    pts = get("/api/v1/points")
    assert pts["located"] == 2 and pts["severity"] == "CK" and len(pts["lat"]) == 2
    assert pts["start"] == "2024-03-05" and pts["day"] == [121, 666]  # 2024-07-04, 2025-12-31
    # each street name is sent once; every point points into that list (-1 when not recorded)
    assert len(pts["street"]) == 2 and all(-1 <= i < len(pts["streets"]) for i in pts["street"])
    assert pts["streets"] == sorted(set(pts["streets"]))


def test_breakdown_by_street_ranks_corridors():
    rows = get("/api/v1/breakdown", by="street")["groups"]
    assert sum(r["crashes"] for r in rows) == 4
    assert [r["crashes"] for r in rows if r["value"]] == sorted((r["crashes"] for r in rows if r["value"]), reverse=True)


def test_csv_export():
    r = client.get("/api/v1/crashes", params={"format": "csv", "county": "lubbock"})
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("id,date,time") and len(lines) == 4
    assert "FAILED TO CONTROL SPEED; UNSAFE SPEED" in r.text


def test_security_and_cache_headers():
    r = client.get("/api/v1/severity")
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "public, max-age=300"
    assert client.get("/api/nope").status_code == 404
    docs = client.get("/api/docs")
    csp = docs.headers["content-security-policy"]
    assert docs.status_code == 200 and "swagger-ui-dist@5.33.1/" in csp and "'sha256-" in csp
    assert "unsafe-inline" not in csp.split("style-src")[0]  # inline script allowed by hash only
    assert "cdn.jsdelivr.net" not in r.headers["content-security-policy"]
    # errors and liveness are never cached
    assert client.get("/api/v1/severity", params={"county": "dallas"}).headers["cache-control"] == "no-store"
    assert client.get("/api/health").headers["cache-control"] == "no-store"
    assert client.post("/api/v1/severity").status_code == 405  # read-only API


def test_lambda_function_url_event():
    event = {
        "version": "2.0", "routeKey": "$default", "rawPath": "/api/v1/severity",
        "rawQueryString": "county=lubbock", "headers": {"accept-encoding": "gzip", "host": "x.lambda-url.us-east-2.on.aws"},
        "requestContext": {"http": {"method": "GET", "path": "/api/v1/severity", "sourceIp": "1.2.3.4",
                                    "protocol": "HTTP/1.1"}, "stage": "$default"},
        "isBase64Encoded": False,
    }
    out = handler(event, None)
    assert out["statusCode"] == 200
    body = base64.b64decode(out["body"]) if out["isBase64Encoded"] else out["body"].encode()
    if out["headers"].get("content-encoding") == "gzip":
        body = gzip.decompress(body)
    assert json.loads(body)["total"] == 3


def test_csv_cells_cannot_become_spreadsheet_formulas():
    from roadalyx.api import _csv_safe
    assert _csv_safe("=HYPERLINK(1)") == "'=HYPERLINK(1)"
    assert _csv_safe("19TH ST") == "19TH ST" and _csv_safe(-1) == -1


def test_year_filter_clips_the_time_axis_instead_of_showing_zeros():
    years = get("/api/v1/trends", by="year", year_from=2025)["buckets"]
    assert [b["key"] for b in years] == [2025]
    months = get("/api/v1/trends", by="month", year_to=2024)["buckets"]
    assert months[0]["key"] == "2024-03" and months[-1]["key"] == "2024-12" and months[-1]["complete"]


@pytest.mark.parametrize("params", [{}, {"county": "lubbock"}, {"severity": "K,A"}, {"year_from": 2025}, {"county": "hale", "severity": "C"}])
def test_totals_reconcile_across_endpoints(params):
    total = get("/api/v1/severity", **params)["total"]
    assert sum(s["crashes"] for s in get("/api/v1/severity", **params)["severity"]) == total
    for by in ("year", "month", "hour", "weekday"):
        t = get("/api/v1/trends", by=by, **params)
        assert sum(b["crashes"] for b in t["buckets"]) + t["unknown"] == total
    heat = get("/api/v1/heatmap", **params)
    assert sum(map(sum, heat["crashes"])) + heat["unknown"] == total
    assert sum(g["crashes"] for g in get("/api/v1/breakdown", by="county", **params)["groups"]) == total
    assert get("/api/v1/crashes", **params)["total"] == total


def test_portal_explains_a_missing_build_and_serves_one_built_later(tmp_path, monkeypatch):
    import roadalyx.api as api
    monkeypatch.setattr(api, "WEB_DIR", tmp_path)
    r = client.get("/")
    assert r.status_code == 404 and "npm --prefix web run build" in r.json()["detail"]
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<p>portal</p>")
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    assert client.get("/").text == "<p>portal</p>"
    assert client.get("/analysis").text == "<p>portal</p>"          # client-side route
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert client.get("/assets/gone.js").status_code == 404                # old chunk: no HTML in its place
    assert client.get("/../roadalyx/api.py").text == "<p>portal</p>"  # never outside the build


def test_data_access_tab_opens_the_api_reference():
    r = client.get("/data-access", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/api/docs"
