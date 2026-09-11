"""Re-pin drifted overlay references — 11-system-architecture.md §3.2 (T-033).

After a build, every `overlay_ref` row whose `resolution = 'spatial'` was
recovered only by its `geo:` fallback — its `ref_primary` no longer matches
because OSM (or the graph) drifted. This script rewrites each such entry's
`ref_primary` in the *source* overlay file to the content id it resolved to, so
the drift is repaired in one commit instead of accumulating. The `geo:` fallback
is left in place as the ongoing safety net.

    <spatialite-python> scripts/repin-overlays.py [--db build/authoring.db]
                                                  [--overlays-dir overlays] [--allow-write]

Without `--allow-write` it reports what it would change and writes nothing.

Overlay file shape (finalised by T-027; this script only touches the reference):
    { "entries": [ { "id": "<overlay_id>",
                     "ref": "osm:way/123@3..7"  |  { "primary": "...", "fallback": "geo:..." },
                     ... kind-specific payload ... } ] }
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.build.common import BUILD_DIR, REPO_ROOT  # noqa: E402
from scripts.lib.db import connect  # noqa: E402


def _set_primary(entry: dict, content_id: str) -> bool:
    ref = entry.get("ref")
    if isinstance(ref, str):
        entry["ref"] = {"primary": content_id, "fallback": None} if ref.startswith("geo:") \
            else content_id
        return True
    if isinstance(ref, dict) and "primary" in ref:
        ref["primary"] = content_id
        return True
    return False


def run(db_path: Path, overlays_dir: Path, allow_write: bool) -> dict:
    con = connect(db_path)
    try:
        rows = con.execute(
            "SELECT overlay_id, file, resolved_to FROM overlay_ref "
            "WHERE resolution = 'spatial' ORDER BY file, overlay_id"
        ).fetchall()
    finally:
        con.close()

    by_file: dict[str, list[tuple[str, str]]] = {}
    for overlay_id, file, resolved_to in rows:
        by_file.setdefault(file, []).append((overlay_id, resolved_to))

    repinned: list[dict] = []
    skipped: list[dict] = []
    files_written: list[str] = []

    for file, entries in by_file.items():
        path = overlays_dir / Path(file).name
        if not path.is_file():
            for oid, _rt in entries:
                skipped.append({"overlay_id": oid, "file": file, "why": "file not found"})
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        index = {e.get("id"): e for e in doc.get("entries", []) if isinstance(e, dict)}
        changed = False
        for oid, resolved_to in entries:
            if not (resolved_to or "").startswith(("node:", "edge:")):
                skipped.append({"overlay_id": oid, "file": file,
                                "why": f"resolved_to {resolved_to!r} is not a content id"})
                continue
            entry = index.get(oid)
            if entry is None or not _set_primary(entry, resolved_to):
                skipped.append({"overlay_id": oid, "file": file, "why": "entry / ref not found"})
                continue
            repinned.append({"overlay_id": oid, "file": file, "ref_primary": resolved_to})
            changed = True
        if changed and allow_write:
            path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
            files_written.append(str(path))

    return {
        "spatial_rows": len(rows),
        "repinned": repinned,
        "skipped": skipped,
        "files_written": files_written,
        "dry_run": not allow_write,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Re-pin drifted overlay references (spatial -> exact).")
    ap.add_argument("--db", type=Path, default=BUILD_DIR / "authoring.db")
    ap.add_argument("--overlays-dir", type=Path, default=REPO_ROOT / "overlays")
    ap.add_argument("--allow-write", action="store_true",
                    help="deliberate-action guard: without it, report only and write nothing")
    args = ap.parse_args(argv)
    if not Path(args.db).exists():
        raise SystemExit(f"{args.db} not found — run build-graph.py first.")

    result = run(args.db, args.overlays_dir, args.allow_write)
    print(json.dumps(result, indent=2))
    if result["dry_run"] and result["repinned"]:
        print(f"\n{len(result['repinned'])} reference(s) would be re-pinned — "
              "pass --allow-write to rewrite the overlay files.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
