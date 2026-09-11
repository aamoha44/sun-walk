#!/usr/bin/env python3
"""Fetch the OpenStreetMap pedestrian geometry for the Sun Walk service area.

Spec: docs/specs/02-data-sources.md §2.

LICENSING: OSM data is ODbL 1.0. D-001 was resolved 2026-08-28 (option A):
    accept ODbL, ship the derived graph under ODbL 1.0 with
    "© OpenStreetMap contributors" attribution, keep UFRM-derived building
    attributes in separate files. This script writes that licence string into
    `sources/manifest.json`. Canonical notice: /NOTICE.

Three input paths:
  1. Preferred, reproducible: a version-pinned Geofabrik Arizona `.osm.pbf`
     clipped with `osmium extract -p sources/service-area.geojson`. Requires the
     `osmium` CLI (not a Python dep). Pass the clipped file with `--pbf`.
  2. `--overpass-live`: build the query from the service-area bbox and POST it to
     the Overpass API. Not reproducible over time; the OSM data `@timestamp` and
     the exact query are recorded so a build is at least traceable. Interim until
     path 1 is available.
  3. `--overpass-json FILE`: a pre-fetched Overpass response (used by the tests).

Writes `sources/osm-tempe.geojson` + a `sources/manifest.json` entry with the
source URL, the query, the OSM data timestamp, the SHA-256, the ODbL licence
string, and the total centreline metres of candidate walkway (so C5 feasibility
is known before Phase C). `--allow-write` is required as a deliberate-action
guard — the fetch and summary run without it, only the file write is gated.

Stdlib only: json + hashlib + math + urllib.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EARTH_RADIUS_M = 6_371_008.8

GEOFABRIK_ARIZONA = "https://download.geofabrik.de/north-america/us/arizona-latest.osm.pbf"
# Pin a dated Geofabrik snapshot for reproducibility, e.g. arizona-260801.osm.pbf
GEOFABRIK_PINNED_HINT = "arizona-YYYYMMDD.osm.pbf"
OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

OSM_LICENSE = (
    "ODbL 1.0 (http://opendatacommons.org/licenses/odbl/1.0/); "
    "contents DbCL 1.0; © OpenStreetMap contributors"
)
OSM_ATTRIBUTION = "© OpenStreetMap contributors"

# §2 "Ways to keep"
PEDESTRIAN_HIGHWAY = {"footway", "path", "steps", "pedestrian", "corridor", "living_street"}
# §2.4 tags carried onto edges. `layer` and `bridge` are here because the noding
# stage (03-graph-pipeline.md §2.2) must NOT node two ways that only cross in
# plan view when they are grade-separated — different `layer`, or `bridge=yes` /
# `tunnel=yes`. 02 §2.4's prose list omitted them; amended 2026-08-28 (T-021).
EDGE_TAGS = [
    "surface", "smoothness", "incline", "covered", "tunnel", "bridge", "layer",
    "indoor", "width", "wheelchair", "access", "foot", "lit", "handrail",
    "step_count",
]
# §2 "Also keep" — node tags
NODE_KEEP_TAGS = ("highway", "entrance", "barrier")


def haversine_m(a, b) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def is_plaza(tags: dict) -> bool:
    """§2.1 plaza polygon — either tagging scheme. ASU maps its squares as
    `highway=pedestrian` + `area=yes`; `area:highway=footway` is the older
    scheme. Skeletonised into synthetic edges in Phase C (T-026)."""
    return tags.get("area:highway") == "footway" or (
        tags.get("highway") == "pedestrian" and tags.get("area") == "yes"
    )


def keep_way(tags: dict) -> bool:
    """§2 'Ways to keep'."""
    hw = tags.get("highway")
    if hw in PEDESTRIAN_HIGHWAY:
        return True
    if hw == "service" and tags.get("foot") != "no":
        return True
    if hw in ("residential", "tertiary"):
        # only where a sidewalk is NOT mapped and foot is explicitly yes
        return "sidewalk" not in tags and tags.get("foot") == "yes"
    if is_plaza(tags):
        return True
    return False


def keep_node(tags: dict) -> bool:
    """§2 'Also keep' — crossings, entrances, gates/bollards/kerbs, elevators."""
    if tags.get("highway") in ("crossing", "elevator"):
        return True
    if "entrance" in tags:
        return True
    if tags.get("barrier") in ("gate", "bollard", "kerb"):
        return True
    return False


def overpass_to_geojson(body: dict) -> dict:
    """Convert an Overpass 'out geom' JSON response to a FeatureCollection."""
    features: list[dict] = []
    ways = 0
    nodes = 0
    plazas = 0
    for el in body.get("elements", []):
        tags = el.get("tags") or {}
        if el["type"] == "way" and keep_way(tags):
            geom = el.get("geometry")
            if not geom or len(geom) < 2:
                continue
            coords = [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom]
            # A plaza is only usable as a polygon if the way closes into a ring.
            plaza = is_plaza(tags) and len(coords) >= 4 and coords[0] == coords[-1]
            plazas += plaza
            ways += 1
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon" if plaza else "LineString",
                    "coordinates": [coords] if plaza else coords,
                },
                "properties": {
                    "osmWayId": el["id"],
                    "highway": tags.get("highway"),
                    "synthetic": False,
                    "plaza": plaza,
                    "area": tags.get("area") if plaza else None,
                    **{k: tags[k] for k in EDGE_TAGS if k in tags},
                    "name": tags.get("name"),
                },
            })
        elif el["type"] == "node" and keep_node(tags):
            nodes += 1
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(el["lon"], 6), round(el["lat"], 6)]},
                "properties": {
                    "osmNodeId": el["id"],
                    **{k: tags[k] for k in NODE_KEEP_TAGS if k in tags},
                    "crossing": tags.get("crossing"),
                },
            })
    return {
        "type": "FeatureCollection",
        "features": features,
        "_counts": {"ways": ways, "nodes": nodes, "plazas": plazas},
    }


def centreline_metres(fc: dict) -> float:
    total = 0.0
    for f in fc["features"]:
        g = f["geometry"]
        if g["type"] == "LineString":
            pts = g["coordinates"]
            total += sum(haversine_m(pts[i - 1], pts[i]) for i in range(1, len(pts)))
    return total


def service_area_bbox(path: Path) -> tuple[float, float, float, float]:
    ring = json.loads(path.read_text(encoding="utf-8"))["features"][0]["geometry"]["coordinates"][0]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)  # west, south, east, north


def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    w, s, e, n = bbox
    b = f"{s},{w},{n},{e}"  # Overpass bbox order: south,west,north,east
    return (
        "[out:json][timeout:180];\n(\n"
        f'  way["highway"~"^(footway|path|steps|pedestrian|corridor|living_street)$"]({b});\n'
        f'  way["highway"="service"]["foot"!="no"]({b});\n'
        f'  way["highway"~"^(residential|tertiary)$"]["foot"="yes"][!"sidewalk"]({b});\n'
        f'  way["area:highway"="footway"]({b});\n'
        f'  way["highway"="pedestrian"]["area"="yes"]({b});\n'
        f'  node["highway"~"^(crossing|elevator)$"]({b});\n'
        f'  node["entrance"]({b});\n'
        f'  node["barrier"~"^(gate|bollard|kerb)$"]({b});\n'
        ");\nout geom qt;"
    )


def overpass_fetch(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(OVERPASS_ENDPOINT, data=data,
                                 headers={"User-Agent": "sunwalk-fetch-osm/1.0"})
    with urllib.request.urlopen(req, timeout=200) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pbf", help="a Geofabrik extract already clipped with `osmium extract`")
    src.add_argument("--overpass-live", action="store_true",
                     help="build the query from the service-area bbox and POST it to Overpass")
    src.add_argument("--overpass-json", help="a pre-fetched Overpass API JSON response (tests)")
    ap.add_argument("--service-area", default=str(REPO_ROOT / "sources" / "service-area.geojson"))
    ap.add_argument("--out", default=str(REPO_ROOT / "sources" / "osm-tempe.geojson"))
    ap.add_argument("--manifest", default=str(REPO_ROOT / "sources" / "manifest.json"))
    ap.add_argument("--allow-write", action="store_true",
                    help="deliberate-action guard: required before the geojson + manifest are written")
    args = ap.parse_args(argv)

    if args.pbf:
        print("--pbf requires the `osmium` toolchain and a Phase-C reader; not "
              "implemented here. Pin a Geofabrik snapshot "
              f"({GEOFABRIK_PINNED_HINT}, from {GEOFABRIK_ARIZONA}), run "
              "`osmium extract -p sources/service-area.geojson <snapshot>`, then "
              "feed the clipped file to the builder.", file=sys.stderr)
        return 2

    bbox = service_area_bbox(Path(args.service_area))
    query = overpass_query(bbox)
    if args.overpass_live:
        body = overpass_fetch(query)
        source = OVERPASS_ENDPOINT
    else:
        body = json.loads(Path(args.overpass_json).read_text(encoding="utf-8"))
        source = f"file://{args.overpass_json}"

    fc = overpass_to_geojson(body)
    metres = centreline_metres(fc)
    osm_timestamp = (body.get("osm3s") or {}).get("timestamp_osm_base")

    counts = fc.pop("_counts")
    fc["_meta"] = {"license": OSM_LICENSE, "attribution": OSM_ATTRIBUTION,
                   "source": source, "osmTimestamp": osm_timestamp}
    summary = {
        "ways": counts["ways"],
        "nodes": counts["nodes"],
        "plazas": counts["plazas"],
        "centrelineMetres": round(metres, 1),
        "osmTimestamp": osm_timestamp,
        "license": OSM_LICENSE,
    }
    print(json.dumps(summary, indent=2))

    if not args.allow_write:
        print("\nPass --allow-write to write sources/osm-tempe.geojson and update "
              "the manifest. (Fetch + summary above already ran.)")
        return 0

    out = Path(args.out)
    out.write_text(json.dumps(fc, indent=2) + "\n", encoding="utf-8")
    sha = hashlib.sha256(out.read_bytes()).hexdigest()

    mpath = Path(args.manifest)
    manifest = json.loads(mpath.read_text(encoding="utf-8")) if mpath.is_file() else {"entries": []}
    manifest.setdefault("entries", [])
    manifest["entries"] = [e for e in manifest["entries"] if e.get("file") != out.name]
    manifest["entries"].append({
        "file": out.name,
        "source": source,
        "query": query,
        "fetched": datetime.now(tz=timezone.utc).isoformat(),
        "osmTimestamp": osm_timestamp,
        "sha256": sha,
        "featureCount": counts["ways"] + counts["nodes"],
        "centrelineMetres": round(metres, 1),
        "license": OSM_LICENSE,
        "attribution": OSM_ATTRIBUTION,
        "notes": f"§2 pedestrian filter over the service-area bbox {bbox}; "
                 f"{counts['plazas']} plaza polygons flagged for Phase-C skeletonisation",
    })
    mpath.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\nwrote {out.name}  sha256={sha}  centreline={summary['centrelineMetres']} m")
    print(f"updated {mpath.name} with the osm-tempe entry (ODbL 1.0)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
