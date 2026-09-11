"""scripts/build-graph.py — orchestrates the Sun Walk graph builder.

Stage modules live in scripts/build/ (Phase C plan review 2026-08-28, Q2). This
script rebuilds build/authoring.db from scratch and runs the implemented stages
in order. authoring.db is a derived, gitignored artifact — never migrated,
always rebuilt.

Usage:
  python scripts/build-graph.py [--service-area PATH] [--only STAGE | --from STAGE]
  python scripts/build-graph.py --check     # determinism: build twice, diff every table

Requires the SpatiaLite-capable interpreter (C:\\msys64\\ucrt64\\bin\\python3.exe).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.build.common import BuildContext, add_common_args  # noqa: E402
from scripts.build.stage0_load import run as stage0_run  # noqa: E402
from scripts.build.stage2_cluster import run as stage2b_run  # noqa: E402
from scripts.build.stage2_node import run as stage2_run  # noqa: E402
from scripts.build.stage2_plaza import run as stage2p_run  # noqa: E402
from scripts.build.stage3_cleanup import run as stage3_run  # noqa: E402
from scripts.build.stage4_identity import run as stage4_run  # noqa: E402
from scripts.build.stage5_clip import run as stage5c_run  # noqa: E402
from scripts.build.stage5_entrances import run as stage5_run  # noqa: E402
from scripts.build.stage6_overlays import run as stage6_run  # noqa: E402
from scripts.build.stage7_emit import run as stage7_run  # noqa: E402
from scripts.lib.db import connect  # noqa: E402

# (name, description, run-callable). Extend as stages land (T-026 …).
STAGES: list[tuple[str, str, object]] = [
    ("stage0_load", "load sources, clip to service area, reject log", stage0_run),
    ("stage2_node", "clip ways to the boundary, split at same-grade crossings", stage2_run),
    ("stage2_cluster", "cluster segment endpoints within 1.5 m", stage2b_run),
    ("stage2_plaza", "skeletonise plaza polygons into synthetic edges", stage2p_run),
    ("stage3_cleanup", "stubs, degree-2 collapse, dedup, largest component", stage3_run),
    ("stage4_identity", "content-derived node/edge ids; populate node + edge", stage4_run),
    ("stage5_entrances", "buildings, footprints, entrances, projection, link edges", stage5_run),
    ("stage5_clip", "reroute edges out of footprint interiors (G3)", stage5c_run),
    ("stage6_overlays", "apply overlays/*.json (entrances, edge-overrides, names)", stage6_run),
    ("stage7_emit", "shadeIndex + emit graph.json / footprints / manifest / report", stage7_run),
]

# Tables hashed for the --check determinism diff, with the ORDER BY that makes
# the row sequence stable. Only tables a stage actually writes belong here.
# T-028 (D8): the contract tables + overlay_ref, so the emit's inputs are covered.
_DIGEST_TABLES = {
    "source_feature": "source, upstream_id",
    "stage_way": "way_id, part",
    "stage_segment": "grade, way_id, seg",
    "stage_vertex": "vertex_id",
    "stage_edge": "grade, way_id, seg",
    "node": "node_id",
    "edge": "edge_id",
    "building": "building_id",
    "footprint": "footprint_id",
    "entrance": "building_id, ordinal",
    "overlay_ref": "overlay_id",
}


def _select_stages(only: str | None, frm: str | None):
    names = [s[0] for s in STAGES]
    if only:
        if only not in names:
            raise SystemExit(f"--only {only}: unknown stage (have {names})")
        return [s for s in STAGES if s[0] == only]
    if frm:
        if frm not in names:
            raise SystemExit(f"--from {frm}: unknown stage (have {names})")
        return STAGES[names.index(frm):]
    return STAGES


def _run_pipeline(db_path: Path, ctx: BuildContext, stages) -> dict:
    stage_ctx = BuildContext(
        db_path=db_path,
        service_area_path=ctx.service_area_path,
        sources_dir=ctx.sources_dir,
    )
    con = connect(db_path)
    try:
        results: dict[str, dict] = {}
        for name, _desc, run in stages:
            res = run(con, stage_ctx)
            results[name] = res
            if not res.get("ok", False):
                return {"ok": False, "failed_stage": name, "stages": results}
        con.commit()
        return {"ok": True, "stages": results}
    finally:
        con.close()


def _digest(db_path: Path) -> str:
    con = connect(db_path)
    h = hashlib.blake2b(digest_size=16)
    present = {
        r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    for table, order_by in sorted(_DIGEST_TABLES.items()):
        if table not in present:
            continue
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
        payload = [c for c in cols if c != f"{table}_id"]
        h.update(f"\n== {table} ({','.join(payload)}) ==\n".encode())
        for row in con.execute(f"SELECT {','.join(payload)} FROM {table} ORDER BY {order_by}"):
            h.update(repr(row).encode())
            h.update(b"\n")
    con.close()
    return h.hexdigest()


def _fresh_db(path: Path) -> None:
    for p in (path, path.with_suffix(path.suffix + "-wal"), path.with_suffix(path.suffix + "-shm")):
        p.unlink(missing_ok=True)


def _check(ctx: BuildContext, stages) -> int:
    digests: list[str] = []
    graph_hashes: list[str | None] = []
    for i in range(2):
        with tempfile.TemporaryDirectory(prefix="sunwalk-check-") as td:
            db_path = Path(td) / "authoring.db"
            res = _run_pipeline(db_path, ctx, stages)
            if not res["ok"]:
                print(json.dumps(res, indent=2))
                print(f"--check: pipeline failed on run {i + 1}")
                return 1
            digests.append(_digest(db_path))
            emit = res["stages"].get("stage7_emit", {})
            graph_hashes.append(emit.get("graph_hash"))
    if digests[0] != digests[1]:
        print(f"--check: NON-DETERMINISTIC — run 1 {digests[0]} != run 2 {digests[1]}")
        return 1
    if graph_hashes[0] != graph_hashes[1]:
        print(f"--check: NON-DETERMINISTIC graph.json — {graph_hashes[0]} != {graph_hashes[1]}")
        return 1
    gh = f", graphHash {graph_hashes[0][:16]}" if graph_hashes[0] else ""
    print(f"--check: deterministic across two runs (digest {digests[0]}{gh})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    add_common_args(ap)
    ap.add_argument("--check", action="store_true", help="build twice into temp dirs and diff every table")
    ap.add_argument("--only", metavar="STAGE", help="run just this stage")
    ap.add_argument("--from", dest="frm", metavar="STAGE", help="run from this stage onward")
    args = ap.parse_args(argv)

    ctx = BuildContext(
        db_path=Path(args.db),
        service_area_path=Path(args.service_area),
        sources_dir=Path(args.sources),
    )
    stages = _select_stages(args.only, args.frm)

    if args.check:
        return _check(ctx, stages)

    if str(ctx.db_path) != ":memory:":
        ctx.db_path.parent.mkdir(parents=True, exist_ok=True)
        if args.frm is None and args.only is None:
            _fresh_db(ctx.db_path)  # full build = rebuild from scratch

    res = _run_pipeline(ctx.db_path, ctx, stages)
    print(json.dumps(res, indent=2))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
