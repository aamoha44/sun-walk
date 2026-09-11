#!/usr/bin/env python3
"""Normalize a hand-extracted City-of-Tempe building set into a `sources/` file.

The owner pulled a Tempe-wide GeoJSON from **City of Tempe open GIS**, extracted
the ASU Tempe campus buildings, and shaped them to look like
`sources/ufrm-footprints.geojson`. That hand file
is not a fetched artifact — `02-data-sources.md` §1 says everything in `sources/`
is script-written and never hand-edited — so it goes through here first.

This is a **supplementary** footprint source (§1.5). It is NOT a superset of the
UFRM layer-0 footprints: it adds ~29 codes UFRM lacks but is missing 42 UFRM has
(every Vista del Sol + Adelphi building). The merge in
`scripts/build/stage5_entrances.py` keeps the UFRM footprint whenever there is
one and only falls back to this file for the codes UFRM lacks.

SOLAR / CANOPY / INFRASTRUCTURE-named polygons are open-air shade structures,
not enclosed footprints — pedestrians route *under* them — so they are dropped
to the rejected file (leaving them in blows up the gate-G3 allowlist).

What this script does:
  1. Read the raw bytes, strip anything before the first `{` (the delivered file
     has a stray `sor` prefix), `json.loads`.
  2. Validate: FeatureCollection, every geometry Polygon/MultiPolygon, every
     `BLDG_CODE` matches ^[A-Z0-9]+$, rings closed, coordinates inside the ASU
     Tempe bbox (the graph.schema.json Position range).
  3. Join to the MC building set: keep only codes present as a `_role="primary"`
     record in `sources/ufrm-points.geojson`. Non-MC codes go to
     `sources/rejected-campus-buildings.json`, never silently dropped.
  4. Canonicalize each feature to the `ufrm-footprints.geojson` shape
     (`properties = {BLDG_CODE, BLDG_NAME, Type, Image: null, Shape__Area}`),
     round coordinates to 6 dp, sort features by (BLDG_CODE, ring centroid) so a
     re-run is byte-identical (gate B-020 / `--check`).
  5. Write `sources/asu-campus-buildings.geojson` and append (replace-or-add) a
     `sources/manifest.json` entry with the City-of-Tempe licence.

Stdlib only: json + hashlib + argparse + pathlib.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The valid ASU Tempe coordinate window — identical to graph.schema.json's
# Position bounds. A footprint vertex outside this is a reprojection / export bug.
LON_MIN, LON_MAX = -112.2, -111.7
LAT_MIN, LAT_MAX = 33.3, 33.5

_CODE_RE = re.compile(r"^[A-Z0-9]+$")
# Open-air shade canopies and campus-wide infrastructure easements — NOT enclosed
# building footprints. A pedestrian route goes *under / through* a solar canopy
# over Cady Mall (that shade is the point of Sun Walk), never around it. Dropped
# here so they never become gate-G3 "edge through a building" polygons; the
# building record still exists via UFRM and falls back to proxy / none.
_NOT_A_FOOTPRINT_RE = re.compile(r"\b(SOLAR|CANOPY|INFRASTRUCTURE)\b", re.IGNORECASE)
OUT_NAME = "asu-campus-buildings.geojson"
REJECT_NAME = "rejected-campus-buildings.json"
LICENSE = "City of Tempe — open GIS / open data (attribution requested)"
# TODO(owner): the exact City of Tempe dataset name + portal URL for provenance.
SOURCE = "City of Tempe open GIS (dataset URL: TODO — owner to supply)"


def _load_stripped(path: Path) -> dict:
    raw = path.read_bytes()
    brace = raw.find(b"{")
    if brace < 0:
        raise SystemExit(f"{path}: no JSON object found")
    if brace > 0:
        print(f"note: stripped {brace} leading byte(s) {raw[:brace]!r} before the JSON")
    return json.loads(raw[brace:].decode("utf-8"))


def _mc_codes(sources_dir: Path) -> set[str]:
    pts = json.loads((sources_dir / "ufrm-points.geojson").read_text(encoding="utf-8"))
    return {
        f["properties"]["BLDG_CODE"]
        for f in pts.get("features", [])
        if f.get("properties", {}).get("_role") == "primary" and f["properties"].get("BLDG_CODE")
    }


def _rings(geom: dict) -> list[list]:
    """Every linear ring in a Polygon / MultiPolygon."""
    t, c = geom.get("type"), geom.get("coordinates") or []
    if t == "Polygon":
        return list(c)
    if t == "MultiPolygon":
        return [ring for poly in c for ring in poly]
    return []


def _round_geom(geom: dict) -> dict:
    def r(x):
        return [round(x[0], 6), round(x[1], 6)]

    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return {"type": t, "coordinates": [[r(p) for p in ring] for ring in c]}
    return {"type": t, "coordinates": [[[r(p) for p in ring] for ring in poly] for poly in c]}


def _ring_centroid(geom: dict) -> tuple[float, float]:
    rings = _rings(geom)
    pts = rings[0] if rings else [[0.0, 0.0]]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (round(sum(xs) / len(xs), 6), round(sum(ys) / len(ys), 6))


def _validate(feats: list[dict]) -> list[str]:
    errs: list[str] = []
    for i, f in enumerate(feats):
        p = f.get("properties") or {}
        code = p.get("BLDG_CODE")
        g = f.get("geometry") or {}
        tag = f"feature[{i}] {code or '?'}"
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            errs.append(f"{tag}: geometry is {g.get('type')!r}, want Polygon/MultiPolygon")
            continue
        if not code or not _CODE_RE.match(str(code)):
            errs.append(f"{tag}: BLDG_CODE {code!r} does not match ^[A-Z0-9]+$")
        for ri, ring in enumerate(_rings(g)):
            if len(ring) < 4 or ring[0] != ring[-1]:
                errs.append(f"{tag}: ring {ri} is not a closed linear ring")
            for x, y in ring:
                if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
                    errs.append(f"{tag}: vertex ({x}, {y}) outside the ASU Tempe bbox")
                    break
    return errs


def normalize(in_path: Path, sources_dir: Path) -> dict:
    doc = _load_stripped(in_path)
    if doc.get("type") != "FeatureCollection":
        raise SystemExit(f"{in_path}: top-level type is {doc.get('type')!r}, want FeatureCollection")
    feats = doc.get("features", [])
    if not feats:
        raise SystemExit(f"{in_path}: no features")

    errs = _validate(feats)
    if errs:
        raise SystemExit("validation failed:\n  " + "\n  ".join(errs))

    mc = _mc_codes(sources_dir)
    kept: list[dict] = []
    rejected: list[dict] = []
    for f in feats:
        p = f["properties"]
        code = p["BLDG_CODE"]
        name = p.get("BLDG_NAME") or ""
        if code not in mc:
            rejected.append({
                "code": code,
                "name": name,
                "reason": "BLDG_CODE not in the ASU Tempe (MC) building set — see 02-data-sources.md §1.2",
            })
            continue
        if _NOT_A_FOOTPRINT_RE.search(name):
            rejected.append({
                "code": code,
                "name": name,
                "reason": "open-air shade canopy / infrastructure easement — not an enclosed footprint (routing goes under/through)",
            })
            continue
        kept.append({
            "type": "Feature",
            "geometry": _round_geom(f["geometry"]),
            "properties": {
                "BLDG_CODE": code,
                "BLDG_NAME": p.get("BLDG_NAME"),  # kept for reference; the builder never reads it (§1.5)
                "Type": p.get("Type"),
                "Image": None,
                "Shape__Area": p.get("Shape__Area"),
            },
        })

    kept.sort(key=lambda f: (f["properties"]["BLDG_CODE"], _ring_centroid(f["geometry"])))
    return {"kept": kept, "rejected": rejected, "mc_codes": mc}


def _coverage_delta(kept: list[dict], sources_dir: Path) -> str:
    new = {f["properties"]["BLDG_CODE"] for f in kept}
    try:
        ufrm = {
            f["properties"]["BLDG_CODE"]
            for f in json.loads((sources_dir / "ufrm-footprints.geojson").read_text(encoding="utf-8")).get("features", [])
        }
    except FileNotFoundError:
        return f"{len(new)} MC footprints kept"
    gained = sorted(new - ufrm)
    lost = sorted(ufrm - new)
    return (
        f"{len(kept)} MC footprints kept ({len(new)} distinct codes)\n"
        f"  +{len(gained)} codes UFRM footprints lack: {', '.join(gained) or 'none'}\n"
        f"  -{len(lost)} UFRM codes this file lacks (kept via UFRM in the merge): {', '.join(lost) or 'none'}"
    )


def emit(result: dict, out_dir: Path, in_path: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / OUT_NAME
    reject_path = out_dir / REJECT_NAME
    manifest_path = out_dir / "manifest.json"

    fc = {"type": "FeatureCollection", "features": result["kept"]}
    out_path.write_text(json.dumps(fc, indent=2) + "\n", encoding="utf-8")
    reject_path.write_text(json.dumps(result["rejected"], indent=2) + "\n", encoding="utf-8")

    sha = hashlib.sha256(out_path.read_bytes()).hexdigest()
    entry = {
        "file": OUT_NAME,
        "source": SOURCE,
        "derivedFrom": str(in_path.relative_to(REPO_ROOT)) if in_path.is_relative_to(REPO_ROOT) else str(in_path),
        "fetched": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sha256": sha,
        "featureCount": len(result["kept"]),
        "license": LICENSE,
        "notes": (
            "SUPPLEMENTARY building footprints (02-data-sources.md §1.5). Hand-extracted "
            "from a City of Tempe open-GIS Tempe-wide file, then run through "
            "scripts/normalize-campus-buildings.py (strip stray prefix, validate, "
            "join on BLDG_CODE to the MC set, canonicalize, 6-dp round, sort). "
            "NOT a superset of ufrm-footprints.geojson: fills ~29 codes UFRM "
            "layer 0 lacks; missing 42 UFRM codes (all Vista del Sol + Adelphi). "
            "SOLAR/CANOPY/INFRASTRUCTURE-named polygons (open-air shade canopies, "
            "not enclosed footprints) are dropped to the rejected file. "
            "`Type` is a coarse auto-fill, not authoritative — used only to fill "
            "UFRM's untyped rows. `Image` is always null. `BLDG_NAME` is retained "
            "but the builder never reads it (the ALL-CAPS UFRM name stays canonical)."
        ),
    }

    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {"entries": []}
    manifest.setdefault("entries", [])
    manifest["entries"] = [e for e in manifest["entries"] if e.get("file") != OUT_NAME]
    manifest["entries"].append(entry)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {out_path.name}  sha256={sha}  features={len(result['kept'])}")
    print(f"wrote {reject_path.name}  ({len(result['rejected'])} dropped: non-MC or not-a-footprint)")
    print(f"updated {manifest_path.name} with the {OUT_NAME} entry ({LICENSE})")
    print()
    print(_coverage_delta(result["kept"], out_dir))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="in_path", default=str(REPO_ROOT / "asu-campus-buildings-raw.geojson"),
                    help="raw hand-extracted GeoJSON (default: ./asu-campus-buildings-raw.geojson)")
    ap.add_argument("--out", default=str(REPO_ROOT / "sources"),
                    help="output directory (default: sources/)")
    args = ap.parse_args(argv)

    in_path = Path(args.in_path)
    out_dir = Path(args.out)
    if not in_path.is_file():
        raise SystemExit(f"{in_path} not found")

    result = normalize(in_path, out_dir)
    emit(result, out_dir, in_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
