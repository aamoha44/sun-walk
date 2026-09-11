#!/usr/bin/env python3
"""How many MC buildings have a UFRM layer-0 footprint polygon? (T-012 / D-006)

Reads the two artifacts written by `fetch-ufrm.py`:
  - sources/ufrm-points.geojson       (one Point per building record; `_role`
                                       "primary" is the building, "anchor" is an
                                       extra wing centroid)
  - sources/ufrm-footprints.geojson   (layer-0 polygons, joined to the MC set)

Writes `sources/footprint-coverage.json` and prints the headline number. Exit is
always 0 — this is a report, not a gate. `03-graph-pipeline.md` §5 entrance
placement assumes footprints exist; where they do not, the builder (T-025) must
fall back to a `sqrt(gsf)` proxy square marked `footprintSource: "proxy"` and
excluded from gate G3 (D-006 provisional default).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_features(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8")).get("features", [])


def _codes(features: list[dict]) -> set[str]:
    out = {(f.get("properties") or {}).get("BLDG_CODE") for f in features}
    out.discard(None)
    return out


def report(points_path: Path, footprints_path: Path, supplemental_path: Path | None = None) -> dict:
    points = load_features(points_path)
    footprints = load_features(footprints_path)

    footprint_codes = _codes(footprints)

    primaries = [
        f for f in points if (f.get("properties") or {}).get("_role") == "primary"
    ]

    covered, missing = [], []
    for f in primaries:
        p = f["properties"]
        row = {
            "id": p.get("_bldgId"),
            "code": p.get("BLDG_CODE"),
            "name": p.get("BLDG_NAME"),
            "gsf": p.get("BLDG_GSF") or 0,
        }
        (covered if p.get("BLDG_CODE") in footprint_codes else missing).append(row)

    missing.sort(key=lambda r: -r["gsf"])
    total = len(primaries)
    distinct_codes = {p["properties"]["BLDG_CODE"] for p in primaries}
    distinct_covered = distinct_codes & footprint_codes

    out = {
        "buildingRecords": total,
        "withFootprint": len(covered),
        "withoutFootprint": len(missing),
        "coveragePct": round(100 * len(covered) / total, 1) if total else 0.0,
        "distinctCodes": len(distinct_codes),
        "distinctCodesWithFootprint": len(distinct_covered),
        "withoutFootprintZeroGsf": sum(1 for r in missing if r["gsf"] == 0),
        "withoutFootprintOver50kGsf": [r["code"] for r in missing if r["gsf"] >= 50_000],
        "missing": missing,
    }

    # T-012.1 / 02 §1.5 — merge the City-of-Tempe supplementary footprints
    # (UFRM wins ties; the supplemental set only fills the codes UFRM lacks).
    if supplemental_path is not None and supplemental_path.is_file():
        supp_codes = _codes(load_features(supplemental_path))
        merged_codes = footprint_codes | supp_codes
        merged_missing = [r for r in missing if r["code"] not in supp_codes]
        merged_missing.sort(key=lambda r: -r["gsf"])
        gained = sorted((distinct_codes & supp_codes) - footprint_codes)
        out["combined"] = {
            "withFootprint": total - len(merged_missing),
            "coveragePct": round(100 * (total - len(merged_missing)) / total, 1) if total else 0.0,
            "gainedFromSupplemental": gained,
            "supplementalLacksUfrmHas": sorted(footprint_codes - supp_codes),
            "stillUncovered": [r["code"] for r in merged_missing],
            "stillUncoveredZeroGsf": sum(1 for r in merged_missing if r["gsf"] == 0),
            "newProxyOrNoneCount": len(merged_missing),
        }

    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--points", default=str(REPO_ROOT / "sources" / "ufrm-points.geojson"))
    ap.add_argument("--footprints", default=str(REPO_ROOT / "sources" / "ufrm-footprints.geojson"))
    ap.add_argument("--supplemental", nargs="?", const=str(REPO_ROOT / "sources" / "asu-campus-buildings.geojson"),
                    default=None, help="City-of-Tempe supplementary footprints (02 §1.5); "
                    "bare flag uses sources/asu-campus-buildings.geojson")
    ap.add_argument("--out", default=str(REPO_ROOT / "sources" / "footprint-coverage.json"))
    args = ap.parse_args(argv)

    supp = Path(args.supplemental) if args.supplemental else None
    r = report(Path(args.points), Path(args.footprints), supp)
    Path(args.out).write_text(json.dumps(r, indent=2) + "\n", encoding="utf-8")

    print(
        f"footprint coverage (UFRM): {r['withFootprint']}/{r['buildingRecords']} "
        f"building records = {r['coveragePct']}%  "
        f"({r['withoutFootprint']} without; {r['withoutFootprintZeroGsf']} of those have gsf=0; "
        f"{len(r['withoutFootprintOver50kGsf'])} are >=50k gsf: "
        f"{', '.join(r['withoutFootprintOver50kGsf']) or 'none'})"
    )
    if "combined" in r:
        c = r["combined"]
        print(
            f"footprint coverage (UFRM + City of Tempe): {c['withFootprint']}/{r['buildingRecords']} "
            f"= {c['coveragePct']}%  (+{len(c['gainedFromSupplemental'])} codes from the supplement; "
            f"{c['newProxyOrNoneCount']} still proxy/none)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
