#!/usr/bin/env python3
"""Fetch the ASU UFRM CampusBuilding data for the Tempe (MC) campus.

Spec: docs/specs/02-data-sources.md §1 (and §1.1-§1.4).

Writes, all under `sources/` (override with --out):
  - ufrm-points.geojson      layer 10 point features, MC only, kept (non-null,
                             with the resolved bldg id + role per feature)
  - ufrm-footprints.geojson  layer 0 polygon features whose BLDG_CODE is in the
                             MC set (envelope-filtered, then joined)
  - rejected-features.json    every feature dropped, with a reason (the (0,0)
                             null-island points live here — never silently filtered)
  - ufrm-duplicates.json      every BLDG_CODE that repeats, and the §1.4
                             resolution applied to it
  - manifest.json             per-file url / params / fetch time / sha256 /
                             featureCount / license, plus the §1.3 freshness
                             stats (min/max/p50 of EditDate and ExtractDateTime)

Reconciliation (§1.4.3): the script FAILS (exit 1) unless
    fetched(layer 10) == kept + rejected
where `kept` counts every layer-10 feature that ended up inside a building record
(as its primary or as an entrance-search anchor). This is the P-13 guard: a
`dict[code] = row` would drop features and this assert would catch it.

Network is isolated in `fetch_layer`. `--offline DIR` reads DIR/layer10.json and
DIR/layer0.json instead (canned ArcGIS query responses) for tests. No third-party
packages: urllib + json + hashlib + math only.
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
SERVICE_ROOT = (
    "https://services5.arcgis.com/aYs2RC3pluEvAuE3/arcgis/rest/services/"
    "CampusBuilding/FeatureServer"
)
EARTH_RADIUS_M = 6_371_008.8  # identical to src/domain/geo.ts
PAGE_SIZE = 1000
WING_THRESHOLD_M = 150.0  # §1.4: within 150 m = wings of one facility

LAYER10_FIELDS = [
    "BLDG_CODE", "BLDG_NAME", "BLDG_NUMBER", "BLDG_CAMPUS_CODE", "BLDG_ADDRESS",
    "BLDG_GSF", "BLDG_HEIGHT_FT", "BLDG_MAP_NUMBER", "ExtractDateTime", "EditDate",
]
LAYER0_FIELDS = [
    "BLDG_CODE", "BLDG_NAME", "BLDG_NUMBER", "BLDG_ADDRESS", "Type",
    "Description", "map_name", "Image", "Shape__Area", "Shape__Length",
]


# --------------------------------------------------------------------- geometry

def haversine_m(a, b) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def polygon_bbox(ring) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


# --------------------------------------------------------------------- fetching

def fetch_layer(layer: int, params: dict) -> list[dict]:
    """The only function that touches the network. Pages with resultOffset."""
    features: list[dict] = []
    offset = 0
    while True:
        q = dict(params)
        q.update({"resultOffset": offset, "resultRecordCount": PAGE_SIZE, "f": "json"})
        url = f"{SERVICE_ROOT}/{layer}/query?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if "error" in body:
            raise RuntimeError(f"ArcGIS layer {layer}: {body['error']}")
        page = body.get("features", [])
        features.extend(page)
        if body.get("exceededTransferLimit") or len(page) == PAGE_SIZE:
            offset += PAGE_SIZE
            continue
        return features


def load_offline(path: Path) -> list[dict]:
    body = json.loads(path.read_text(encoding="utf-8"))
    return body.get("features", [])


# ------------------------------------------------------------------- transforms

def point_lonlat(feature: dict) -> tuple[float, float] | None:
    g = feature.get("geometry") or {}
    if "x" not in g or "y" not in g:
        return None
    return (g["x"], g["y"])


def attr(feature: dict, name: str):
    return (feature.get("attributes") or {}).get(name)


def is_null_island(feature: dict) -> bool:
    p = point_lonlat(feature)
    return p is not None and p[0] == 0 and p[1] == 0


def epoch_ms_to_iso(ms) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def freshness_stats(features: list[dict]) -> dict:
    def stats(field: str) -> dict:
        vals = sorted(
            v for v in (attr(f, field) for f in features) if isinstance(v, (int, float))
        )
        if not vals:
            return {"min": None, "max": None, "p50": None, "n": 0}
        p50 = vals[len(vals) // 2]
        return {
            "min": epoch_ms_to_iso(vals[0]),
            "max": epoch_ms_to_iso(vals[-1]),
            "p50": epoch_ms_to_iso(p50),
            "n": len(vals),
        }

    return {"EditDate": stats("EditDate"), "ExtractDateTime": stats("ExtractDateTime")}


def cluster_within(points: list[tuple[float, float]], threshold_m: float) -> list[list[int]]:
    """Union-find clustering: indices whose points are within `threshold_m`
    (transitively) land in one cluster."""
    n = len(points)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if haversine_m(points[i], points[j]) <= threshold_m:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def gsf_of(feature: dict) -> float:
    v = attr(feature, "BLDG_GSF")
    return float(v) if isinstance(v, (int, float)) else 0.0


def resolve_code_group(code: str, feats: list[dict]) -> tuple[list[dict], dict]:
    """§1.4. Returns (building_records, duplicates_entry).

    A building record: {id, code, primary, anchors:[...], summedGsf, resolution}.
    Singletons pass straight through with resolution "single"; only codes that
    actually repeat get an entry in the duplicates file.
    """
    pts = [point_lonlat(f) for f in feats]
    clusters = cluster_within(pts, WING_THRESHOLD_M)  # list of index lists
    # Order clusters by descending summed gsf so `bldg:CODE` is the biggest.
    clusters.sort(key=lambda idxs: -sum(gsf_of(feats[i]) for i in idxs))

    records: list[dict] = []
    cluster_reports: list[dict] = []
    multi_cluster = len(clusters) > 1

    for c_i, idxs in enumerate(clusters):
        members = sorted((feats[i] for i in idxs), key=gsf_of, reverse=True)
        primary = members[0]
        anchors = members[1:]
        summed = sum(gsf_of(m) for m in members)
        bldg_id = f"bldg:{code}" if c_i == 0 else f"bldg:{code}#{c_i + 1}"
        span = 0.0
        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                span = max(span, haversine_m(pts[idxs[a]], pts[idxs[b]]))
        resolution = (
            "single" if len(feats) == 1
            else "separate" if multi_cluster
            else "wings"
        )
        records.append({
            "id": bldg_id,
            "code": code,
            "primary": primary,
            "anchors": anchors,
            "summedGsf": summed,
            "resolution": resolution,
        })
        cluster_reports.append({
            "id": bldg_id,
            "memberCount": len(idxs),
            "primaryGsf": gsf_of(primary),
            "summedGsf": summed,
            "maxSpanM": round(span, 1),
            "resolution": resolution,
        })

    dup_entry = {}
    if len(feats) > 1:
        dup_entry = {
            "code": code,
            "featureCount": len(feats),
            "clusterCount": len(clusters),
            "policy": "§1.4.1 separate (>150 m)" if multi_cluster else "§1.4.2 wings (≤150 m)",
            "clusters": cluster_reports,
        }
    return records, dup_entry


# -------------------------------------------------------------------- pipeline

def build(layer10: list[dict], layer0: list[dict]) -> dict:
    fetched = len(layer10)

    # --- reject (0, 0) null-island points (§1.1) ---
    rejected: list[dict] = []
    kept_feats: list[dict] = []
    for f in layer10:
        if is_null_island(f):
            rejected.append({
                "layer": 10,
                "code": attr(f, "BLDG_CODE"),
                "number": attr(f, "BLDG_NUMBER"),
                "name": attr(f, "BLDG_NAME"),
                "reason": "null-island coordinates (0, 0) — see 02-data-sources.md §1.1",
            })
        elif point_lonlat(f) is None:
            rejected.append({
                "layer": 10,
                "code": attr(f, "BLDG_CODE"),
                "number": attr(f, "BLDG_NUMBER"),
                "name": attr(f, "BLDG_NAME"),
                "reason": "missing point geometry",
            })
        else:
            kept_feats.append(f)

    # --- group by code, resolve duplicates (§1.4) ---
    by_code: dict[str, list[dict]] = {}
    for f in kept_feats:
        by_code.setdefault(attr(f, "BLDG_CODE"), []).append(f)

    buildings: list[dict] = []
    duplicates: list[dict] = []
    kept = 0
    for code in sorted(by_code):
        records, dup_entry = resolve_code_group(code, by_code[code])
        for rec in records:
            kept += 1 + len(rec["anchors"])
        buildings.extend(records)
        if dup_entry:
            duplicates.append(dup_entry)

    # --- reconciliation (§1.4.3) ---
    if fetched != kept + len(rejected):
        raise SystemExit(
            f"RECONCILIATION FAILED: fetched {fetched} != kept {kept} + "
            f"rejected {len(rejected)} (a feature was dropped silently - P-13)"
        )

    mc_codes = {b["code"] for b in buildings}

    # --- layer 0 footprints: keep only codes in the MC set (§1.2) ---
    footprints = [f for f in layer0 if attr(f, "BLDG_CODE") in mc_codes]

    return {
        "fetched": fetched,
        "kept": kept,
        "rejected": rejected,
        "buildings": buildings,
        "duplicates": duplicates,
        "mc_codes": sorted(mc_codes),
        "kept_feats": kept_feats,
        "footprints": footprints,
        "freshness": freshness_stats(kept_feats),
    }


# ---------------------------------------------------------------------- output

def point_feature(f: dict, bldg_id: str, role: str) -> dict:
    lon, lat = point_lonlat(f)
    a = dict(f.get("attributes") or {})
    a["_bldgId"] = bldg_id
    a["_role"] = role  # "primary" | "anchor"
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": a,
    }


def polygon_feature(f: dict) -> dict:
    rings = (f.get("geometry") or {}).get("rings") or []
    coords = [[[round(x, 6), round(y, 6)] for x, y in ring] for ring in rings]
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords},
            "properties": dict(f.get("attributes") or {})}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def emit(result: dict, out_dir: Path, urls: dict, params: dict, offline: bool) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    point_features = []
    for b in result["buildings"]:
        point_features.append(point_feature(b["primary"], b["id"], "primary"))
        for anc in b["anchors"]:
            point_features.append(point_feature(anc, b["id"], "anchor"))

    points_path = out_dir / "ufrm-points.geojson"
    footprints_path = out_dir / "ufrm-footprints.geojson"
    rejected_path = out_dir / "rejected-features.json"
    duplicates_path = out_dir / "ufrm-duplicates.json"
    manifest_path = out_dir / "manifest.json"

    write_json(points_path, {"type": "FeatureCollection", "features": point_features})
    write_json(footprints_path, {
        "type": "FeatureCollection",
        "features": [polygon_feature(f) for f in result["footprints"]],
    })
    write_json(rejected_path, result["rejected"])
    write_json(duplicates_path, result["duplicates"])

    now = datetime.now(tz=timezone.utc).isoformat()
    manifest = {
        "generated": now,
        "source": "offline fixture" if offline else SERVICE_ROOT,
        "entries": [
            {
                "file": "ufrm-points.geojson",
                "url": urls["layer10"],
                "params": params["layer10"],
                "fetched": now,
                "sha256": sha256_file(points_path),
                "featureCount": len(point_features),
                "license": "ASU UFRM — redistribution unclear, see D-002",
                "notes": (
                    f"{result['fetched']} MC features fetched; "
                    f"{result['kept']} kept, {len(result['rejected'])} rejected; "
                    f"{len(result['duplicates'])} duplicate codes (see ufrm-duplicates.json)"
                ),
                "freshness": result["freshness"],
            },
            {
                "file": "ufrm-footprints.geojson",
                "url": urls["layer0"],
                "params": params["layer0"],
                "fetched": now,
                "sha256": sha256_file(footprints_path),
                "featureCount": len(result["footprints"]),
                "license": "ASU UFRM — redistribution unclear, see D-002",
                "notes": "layer 0 polygons, envelope-filtered to service-area bbox, joined on BLDG_CODE to the MC set",
            },
        ],
        "reconciliation": {
            "fetched": result["fetched"],
            "kept": result["kept"],
            "rejected": len(result["rejected"]),
            "ok": result["fetched"] == result["kept"] + len(result["rejected"]),
        },
    }
    write_json(manifest_path, manifest)

    print(f"points     {len(point_features):>5}  -> {points_path.name}")
    print(f"footprints {len(result['footprints']):>5}  -> {footprints_path.name}")
    print(f"rejected   {len(result['rejected']):>5}  -> {rejected_path.name}")
    print(f"duplicates {len(result['duplicates']):>5}  -> {duplicates_path.name}")
    print(f"reconcile  fetched {result['fetched']} == kept {result['kept']} + rejected {len(result['rejected'])}  OK")


# ------------------------------------------------------------------------ main

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(REPO_ROOT / "sources"),
                    help="output directory (default: sources/)")
    ap.add_argument("--offline", metavar="DIR",
                    help="read DIR/layer10.json and DIR/layer0.json instead of the network")
    ap.add_argument("--service-area",
                    default=str(REPO_ROOT / "sources" / "service-area.geojson"),
                    help="polygon whose bbox is the layer-0 envelope filter")
    args = ap.parse_args(argv)

    sa = json.loads(Path(args.service_area).read_text(encoding="utf-8"))
    ring = sa["features"][0]["geometry"]["coordinates"][0]
    xmin, ymin, xmax, ymax = polygon_bbox(ring)
    envelope = f"{xmin},{ymin},{xmax},{ymax}"

    params = {
        "layer10": {
            "where": "BLDG_CAMPUS_CODE='MC'",
            "outFields": ",".join(LAYER10_FIELDS),
            "outSR": "4326",
            "returnGeometry": "true",
        },
        "layer0": {
            "where": "1=1",
            "geometry": envelope,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": ",".join(LAYER0_FIELDS),
            "outSR": "4326",
            "returnGeometry": "true",
        },
    }
    urls = {
        "layer10": f"{SERVICE_ROOT}/10/query",
        "layer0": f"{SERVICE_ROOT}/0/query",
    }

    if args.offline:
        d = Path(args.offline)
        layer10 = load_offline(d / "layer10.json")
        layer0 = load_offline(d / "layer0.json")
    else:
        layer10 = fetch_layer(10, params["layer10"])
        layer0 = fetch_layer(0, params["layer0"])

    result = build(layer10, layer0)
    emit(result, Path(args.out), urls, params, offline=bool(args.offline))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
