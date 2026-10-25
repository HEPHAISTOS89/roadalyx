"""Build web/src/data/roads.json, the road network drawn on the District map.

Source: US Census Bureau TIGER/Line 2024 (public domain), from https://www2.census.gov/geo/tiger/TIGER2024/
  ROADS/tl_2024_48<county FIPS>_roads.zip          all roads, one file per county
  AREAWATER/tl_2024_48<county FIPS>_areawater.zip  lakes and playas, one file per county
  PLACE/tl_2024_48_place.zip                       city and town limits (Texas), kept inside the district

  python scripts/build_roads.py folder/with/the/17/zips

Uses only the standard library: a TIGER shapefile is a list of polylines plus a dBase table.
"""
import io
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "web/src/data/roads.json"


def read(zip_path):
    """Yield (record, [[lon, lat], ...] parts) for each polyline or polygon in a zipped shapefile."""
    z = zipfile.ZipFile(zip_path)
    name = next(n for n in z.namelist() if n.endswith(".shp"))[:-4]
    shp, dbf = io.BytesIO(z.read(name + ".shp")), io.BytesIO(z.read(name + ".dbf"))

    count, header, width = struct.unpack("<xxxxIHH", dbf.read(12))
    dbf.read(20)
    fields = []
    while (b := dbf.read(1)) != b"\r":
        rest = dbf.read(31)
        fields.append(((b + rest[:10]).split(b"\0")[0].decode(), rest[15]))
    dbf.seek(header)

    shp.seek(100)
    for _ in range(count):
        row = dbf.read(width)[1:]  # the first byte is the deletion flag
        rec, at = {}, 0
        for field, size in fields:
            rec[field] = row[at:at + size].decode("utf-8", "replace").strip()
            at += size
        _, length = struct.unpack(">II", shp.read(8))
        body = shp.read(length * 2)
        if struct.unpack("<i", body[:4])[0] not in (3, 5):  # 3 polyline, 5 polygon; 0 = null shape
            continue
        nparts, npoints = struct.unpack("<ii", body[36:44])
        starts = list(struct.unpack(f"<{nparts}i", body[44:44 + 4 * nparts])) + [npoints]
        xy = struct.unpack(f"<{2 * npoints}d", body[44 + 4 * nparts:44 + 4 * nparts + 16 * npoints])
        yield rec, [[(xy[2 * i], xy[2 * i + 1]) for i in range(a, b)] for a, b in zip(starts, starts[1:])]


def simplify(line, tol):
    """Douglas-Peucker in degrees; keeps the end points."""
    if len(line) < 3:
        return line
    (x0, y0), (x1, y1) = line[0], line[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
    far, at = 0.0, 0
    for i, (x, y) in enumerate(line[1:-1], 1):
        d = abs(dy * (x - x0) - dx * (y - y0)) / norm
        if d > far:
            far, at = d, i
    if far <= tol:
        return [line[0], line[-1]]
    return simplify(line[:at + 1], tol)[:-1] + simplify(line[at:], tol)


def kind(rec):
    """i interstate, u US highway, s state highway (SH, FM, loop, spur), l every other road."""
    name = rec["FULLNAME"]
    if rec["RTTYP"] == "I":
        return "i"
    if rec["RTTYP"] == "U" or rec["MTFCC"] == "S1100":  # a freeway under its local name is still a US route here
        return "u"
    if rec["RTTYP"] == "S" or name.startswith(("FM ", "Farm to Market", "Loop ", "State Loop", "Spur ", "State Spur")):
        return "s"
    return "l"


def ref(name):
    """'I- 27 N' -> 'I-27', 'US Hwy 84' -> 'US 84', 'State Hwy 114' -> 'SH 114'; None for other names."""
    m = re.match(r"(?:[NSEW] )?(I-|US Hwy|State Hwy) ?(\d+)\b", name)
    return m and {"I-": "I-", "US Hwy": "US ", "State Hwy": "SH "}[m[1]] + m[2]


def main(folder):
    roads = {"i": [], "u": [], "s": [], "l": []}
    routes = {}
    for path in sorted(Path(folder).glob("tl_2024_48*_roads.zip")):
        for rec, parts in read(path):
            # roads, ramps and streets; no trails, alleys, driveways or parking lots
            if rec["MTFCC"] not in ("S1100", "S1200", "S1400", "S1630"):
                continue
            k = kind(rec)
            roads[k].extend(simplify(part, 0.0003 if k == "l" else 0.0002) for part in parts)
            r = rec["RTTYP"] in ("I", "U", "S") and ref(rec["FULLNAME"])
            if r and not (r.startswith("SH") and len(r) > 6):  # 4-digit "State Hwy" entries are FM roads miscoded
                routes.setdefault(r, []).extend(p[len(p) // 2] for p in parts if len(p) > 4)
    # A route number every 65 km or so along each route, like the shields on a road map.
    labels = []
    for r, mids in sorted(routes.items()):
        if len(mids) < 3:  # a stray segment, not a route through the district
            continue
        kept = []
        for x, y in mids:
            if all((x - a) ** 2 + (y - b) ** 2 > 0.6 ** 2 for a, b in kept):
                kept.append((x, y))
        labels += [[r, round(x, 4), round(y, 4)] for x, y in kept]
    # Playa lakes and reservoirs larger than about 5 ha.
    water = [simplify(part, 0.0003) for path in sorted(Path(folder).glob("tl_2024_48*_areawater.zip"))
             for rec, parts in read(path) if int(rec["AWATER"] or 0) > 50_000 for part in parts[:1]]
    # Incorporated cities and towns whose centre lies in the district, labelled at their centre.
    xs = [x for line in roads["l"] for x, _ in line]
    ys = [y for line in roads["l"] for _, y in line]
    box = min(xs), min(ys), max(xs), max(ys)
    places, names = [], []
    for rec, parts in read(Path(folder) / "tl_2024_48_place.zip"):
        x, y = float(rec["INTPTLON"]), float(rec["INTPTLAT"])
        if rec["LSAD"] in ("25", "43", "47") and box[0] < x < box[2] and box[1] < y < box[3]:  # city, town, village
            places += [simplify(part, 0.0002) for part in parts]
            names.append([rec["NAME"], round(x, 4), round(y, 4), int(rec["ALAND"]) // 1_000_000])
    flat = lambda lines: [[c for x, y in line for c in (round(x, 4), round(y, 4))] for line in lines]
    # 4 decimals of a degree is about 10 m: plenty at map scale.
    out: dict[str, object] = {k: [[c for x, y in line for c in (round(x, 4), round(y, 4))] for line in lines] for k, lines in roads.items()}
    out["labels"] = labels
    out["water"], out["places"], out["towns"] = flat(water), flat(places), names
    out["source"] = "US Census Bureau, TIGER/Line Shapefiles 2024: roads, area water and places of the 17 district counties"
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print({k: len(v) for k, v in roads.items()}, len(water), "water", len(names), "towns", f"{OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main(sys.argv[1])
