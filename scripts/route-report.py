"""Route-quality report — the detour-ratio gates R1–R4.

04-validation-gates.md "Route quality": sample 500 deterministic pairs (seed
20260827) among routable buildings > 50 m apart, compute the detour ratio
(graph distance / haversine straight line), and assert R1 median <= 1.30,
R2 p90 <= 1.45, R3 max <= 3.00, R4 no null pair. R5 (golden routes) is Phase E.

Engine (Phase C plan review 2026-08-29, D2): a plain Python Dijkstra over the
`node` / `edge` tables in build/authoring.db, edge weight = `length_m`,
undirected, `link` edges included. A detour ratio only needs the geometric
shortest path — not the 05 §3 cost model, not the TS router. Multi-source over
the origin building's entrance nodes, multi-target over the destination's.

Writes one `build` row and 500 `route_sample` rows, and a "Route quality"
section into build/report.md. Default: report + exit 0. `--assert`: exit 1 on
any failing gate.

    <spatialite-python> scripts/route-report.py [--db build/authoring.db] [--pairs 500] [--seed 20260827] [--assert]
"""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.build.common import BUILD_DIR, haversine_m  # noqa: E402
from scripts.lib.db import connect  # noqa: E402

SEED = 20260827
PAIRS = 500
MIN_STRAIGHT_M = 50.0
R1_MAX, R2_MAX, R3_MAX = 1.30, 1.45, 3.00
_REPORT_MARK_START = "<!-- route-report:start -->"
_REPORT_MARK_END = "<!-- route-report:end -->"


def _load_graph(con):
    adj: dict[str, list[tuple[str, float]]] = {}
    for a, b, w in con.execute("SELECT from_node_id, to_node_id, length_m FROM edge"):
        adj.setdefault(a, []).append((b, w))
        adj.setdefault(b, []).append((a, w))
    return adj


def _load_buildings(con):
    """{building_id: (lon, lat, (entrance_node_id, ...))} for routable buildings."""
    ent: dict[str, list[str]] = {}
    for bid, nid in con.execute("SELECT building_id, node_id FROM entrance"):
        ent.setdefault(bid, []).append(nid)
    out = {}
    for bid, wkt in con.execute(
        "SELECT building_id, AsText(centroid) FROM building WHERE routable = 1"
    ):
        inner = wkt[wkt.index("(") + 1 : wkt.index(")")].split()
        lon, lat = float(inner[0]), float(inner[1])
        if ent.get(bid):
            out[bid] = (lon, lat, tuple(sorted(ent[bid])))
    return out


def _dijkstra(adj, sources: tuple[str, ...], targets: set[str]) -> tuple[float | None, int]:
    """Shortest cost from any source to any target, plus the hop count."""
    dist: dict[str, float] = {s: 0.0 for s in sources}
    hops: dict[str, int] = {s: 0 for s in sources}
    pq: list[tuple[float, str]] = [(0.0, s) for s in sources]
    heapq.heapify(pq)
    seen: set[str] = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u in targets:
            return d, hops[u]
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                hops[v] = hops[u] + 1
                heapq.heappush(pq, (nd, v))
    return None, 0


def _sample_pairs(buildings: dict, seed: int, count: int) -> list[tuple[str, str]]:
    rng = random.Random(seed)
    ids = sorted(buildings)
    pairs: list[tuple[str, str]] = []
    seen: set[frozenset] = set()
    guard = 0
    while len(pairs) < count and guard < count * 200:
        guard += 1
        a, b = rng.sample(ids, 2)
        key = frozenset((a, b))
        if key in seen:
            continue
        la, lo_a, _ = buildings[a]
        lb, lo_b, _ = buildings[b]
        if haversine_m((la, lo_a), (lb, lo_b)) < MIN_STRAIGHT_M:
            continue
        seen.add(key)
        pairs.append((a, b) if a < b else (b, a))
    return pairs


def _build_hash(con) -> str:
    h = hashlib.sha256()
    for row in con.execute("SELECT node_id FROM node ORDER BY node_id"):
        h.update(row[0].encode())
    for eid, a, b, w in con.execute(
        "SELECT edge_id, from_node_id, to_node_id, length_m FROM edge ORDER BY edge_id"
    ):
        h.update(f"{eid}|{a}|{b}|{w:.3f}".encode())
    return h.hexdigest()  # 64 hex — fits build.build_hash CHECK (16..64)


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = q * (len(s) - 1)
    lo = int(idx)
    frac = idx - lo
    return s[lo] if lo + 1 >= len(s) else s[lo] * (1 - frac) + s[lo + 1] * frac


def run(db_path: Path, *, seed: int, count: int) -> dict:
    con = connect(db_path)
    try:
        if con.execute("SELECT count(*) FROM edge").fetchone()[0] == 0:
            raise SystemExit(f"{db_path}: no edges — run build-graph.py through stage 4 first.")
        adj = _load_graph(con)
        buildings = _load_buildings(con)
        if len(buildings) < 2:
            raise SystemExit(f"{db_path}: fewer than 2 routable buildings with entrances.")

        pairs = _sample_pairs(buildings, seed, count)
        bh = _build_hash(con)
        con.execute(
            "INSERT OR IGNORE INTO build (build_hash, generated_utc, git_rev, builder_ver) VALUES (?, ?, ?, ?)",
            (bh, datetime.now(tz=timezone.utc).isoformat(), "uncommitted", "route-report/1"),
        )
        con.execute("DELETE FROM route_sample WHERE build_hash = ?", (bh,))

        ratios: list[float] = []
        failures = 0
        for a, b in pairs:
            la, lo_a, ea = buildings[a]
            lb, lo_b, eb = buildings[b]
            straight = haversine_m((la, lo_a), (lb, lo_b))
            graph_m, hops = _dijkstra(adj, ea, set(eb))
            if graph_m is None:
                failures += 1
                con.execute(
                    "INSERT INTO route_sample (build_hash, from_bldg, to_bldg, graph_m, straight_m, "
                    "detour_ratio, hops, failure) VALUES (?, ?, ?, NULL, ?, NULL, NULL, 'disconnected')",
                    (bh, a, b, straight),
                )
                continue
            ratio = graph_m / straight if straight else None
            if ratio is not None:
                ratios.append(ratio)
            con.execute(
                "INSERT INTO route_sample (build_hash, from_bldg, to_bldg, graph_m, straight_m, "
                "detour_ratio, hops, failure) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                (bh, a, b, graph_m, straight, ratio, hops),
            )
        con.commit()
    finally:
        con.close()

    r1 = _percentile(ratios, 0.5)
    r2 = _percentile(ratios, 0.9)
    r3 = max(ratios) if ratios else 0.0
    gates = {
        "R1_median": {"value": round(r1, 3), "max": R1_MAX, "pass": r1 <= R1_MAX},
        "R2_p90": {"value": round(r2, 3), "max": R2_MAX, "pass": r2 <= R2_MAX},
        "R3_max": {"value": round(r3, 3), "max": R3_MAX, "pass": r3 <= R3_MAX},
        "R4_failures": {"value": failures, "max": 0, "pass": failures == 0},
        "R5_golden": "skipped — golden routes are Phase E",
    }
    return {
        "ok": all(g["pass"] for k, g in gates.items() if isinstance(g, dict)),
        "build_hash": bh,
        "pairs": len(pairs),
        "routed": len(ratios),
        "gates": gates,
        "p50": round(r1, 3),
        "p90": round(r2, 3),
        "max": round(r3, 3),
    }


def _write_report(result: dict) -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    path = BUILD_DIR / "report.md"
    g = result["gates"]
    section = (
        f"{_REPORT_MARK_START}\n"
        f"## Route quality\n\n"
        f"{result['routed']} / {result['pairs']} pairs routed "
        f"(seed {SEED}, > {MIN_STRAIGHT_M:.0f} m apart, detour = graph ÷ straight line).\n\n"
        f"| Gate | Value | Threshold | |\n|---|---|---|---|\n"
        f"| R1 median | {g['R1_median']['value']} | ≤ {R1_MAX} | {'PASS' if g['R1_median']['pass'] else 'FAIL'} |\n"
        f"| R2 p90 | {g['R2_p90']['value']} | ≤ {R2_MAX} | {'PASS' if g['R2_p90']['pass'] else 'FAIL'} |\n"
        f"| R3 max | {g['R3_max']['value']} | ≤ {R3_MAX} | {'PASS' if g['R3_max']['pass'] else 'FAIL'} |\n"
        f"| R4 failures | {g['R4_failures']['value']} | 0 | {'PASS' if g['R4_failures']['pass'] else 'FAIL'} |\n"
        f"| R5 golden | — | — | skipped (Phase E) |\n\n"
        f"_generated by scripts/route-report.py; build_hash {result['build_hash'][:16]}…_\n"
        f"{_REPORT_MARK_END}\n"
    )
    if path.exists():
        text = path.read_text(encoding="utf-8")
        if _REPORT_MARK_START in text and _REPORT_MARK_END in text:
            pre = text[: text.index(_REPORT_MARK_START)]
            post = text[text.index(_REPORT_MARK_END) + len(_REPORT_MARK_END) :].lstrip("\n")
            path.write_text(pre + section + ("\n" + post if post else ""), encoding="utf-8")
            return
        path.write_text(text.rstrip("\n") + "\n\n" + section, encoding="utf-8")
    else:
        path.write_text("# build report\n\n" + section, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Route-quality report — R1–R4 detour-ratio gates.")
    ap.add_argument("--db", type=Path, default=BUILD_DIR / "authoring.db")
    ap.add_argument("--pairs", type=int, default=PAIRS)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--assert", dest="hard", action="store_true", help="exit 1 on any failing gate")
    args = ap.parse_args(argv)
    if not Path(args.db).exists():
        raise SystemExit(f"{args.db} not found — run build-graph.py first.")

    result = run(args.db, seed=args.seed, count=args.pairs)
    _write_report(result)
    print(json.dumps(result, indent=2))
    print(
        f"R1 {result['p50']} / R2 {result['p90']} / R3 {result['max']} — "
        f"{'PASS' if result['ok'] else 'FAIL'} (report mode)"
        if not args.hard
        else f"R1 {result['p50']} / R2 {result['p90']} / R3 {result['max']}",
        file=sys.stderr,
    )
    return 1 if (args.hard and not result["ok"]) else 0


if __name__ == "__main__":
    sys.exit(main())
