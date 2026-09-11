#!/usr/bin/env python3
"""Structural and geometric validation gates for a Sun Walk graph artifact.

Runs the gates from docs/specs/04-validation-gates.md:
    S1 schema          S2 edge endpoints resolve
    S3 entrance refs    S4 unique ids
    S5 geometry ends    S6 overlay refs        S7 fetched == kept + rejected
    S8 one component    G2 coord bounds / no (0,0)
    G4 lengthM vs geometry (<= 0.5 m)          G7 no two nodes < 0.5 m apart

Gate 0 (docs/specs/04): a validator that reads a path the application does not load is
a bug, not a validator (defect P-26). This script validates *the artifact the
domain layer loads*. With no argument that is `tests/fixtures/mini-graph.json`,
the graph `src/domain/load.ts` hydrates a `CampusStore` from
(`GRAPH_FIXTURE_PATH`). Pass an explicit path (e.g. `build/graph.json`) as the
first argument to validate a different artifact. It never opens a hand-written
alternate path and never reinterprets the schema: S1 runs
`contracts/graph.schema.json` itself.

Exit 0 when every gate passes; exit 1 otherwise. Every failure line names the
entity and the measurement.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# Must equal GRAPH_FIXTURE_PATH in src/domain/load.ts (asserted by a test).
DEFAULT_ARTIFACT = REPO_ROOT / "tests" / "fixtures" / "mini-graph.json"
# The contract schema.
SCHEMA_PATH = REPO_ROOT / "contracts" / "graph.schema.json"
OVERLAYS_DIR = REPO_ROOT / "overlays"
SOURCES_MANIFEST = REPO_ROOT / "sources" / "manifest.json"

EARTH_RADIUS_M = 6_371_008.8  # identical to src/domain/geo.ts

GATES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "G2", "G4", "G7"]

LON_RANGE = (-112.2, -111.7)
LAT_RANGE = (33.3, 33.5)


# --------------------------------------------------------------------- geometry

def haversine_m(a, b) -> float:
    """Great-circle distance in metres. `a`, `b` are [lon, lat]."""
    lon1, lat1 = a[0], a[1]
    lon2, lat2 = b[0], b[1]
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def polyline_length_m(coords) -> float:
    return sum(haversine_m(coords[i - 1], coords[i]) for i in range(1, len(coords)))


# ----------------------------------------------------- minimal JSON Schema (S1)

class SchemaUnsupported(Exception):
    """A schema keyword this checker does not implement — fail loudly, never pass."""


SUPPORTED_KEYWORDS = {
    "$schema", "$id", "title", "type", "required", "additionalProperties",
    "properties", "$defs", "$ref", "items", "minItems", "maxItems", "minimum",
    "maximum", "exclusiveMinimum", "pattern", "minLength", "enum", "const",
    "format", "allOf", "if", "then",
}


def _resolve_ref(ref: str, root: dict):
    if not ref.startswith("#/"):
        raise SchemaUnsupported(f"non-local $ref: {ref}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def _type_ok(inst, t: str) -> bool:
    if t == "object":
        return isinstance(inst, dict)
    if t == "array":
        return isinstance(inst, list)
    if t == "string":
        return isinstance(inst, str)
    if t == "integer":
        return isinstance(inst, int) and not isinstance(inst, bool)
    if t == "number":
        return isinstance(inst, (int, float)) and not isinstance(inst, bool)
    if t == "boolean":
        return isinstance(inst, bool)
    if t == "null":
        return inst is None
    raise SchemaUnsupported(f"unknown type {t!r}")


def validate_schema(inst, schema: dict, root: dict, path: str, errors: list) -> None:
    for kw in schema:
        if kw not in SUPPORTED_KEYWORDS:
            raise SchemaUnsupported(f"keyword {kw!r} at {path or '<root>'}")

    if "$ref" in schema:
        validate_schema(inst, _resolve_ref(schema["$ref"], root), root, path, errors)
        return

    for sub in schema.get("allOf", []):
        validate_schema(inst, sub, root, path, errors)

    if "if" in schema:
        branch: list = []
        validate_schema(inst, schema["if"], root, path, branch)
        if not branch and "then" in schema:
            validate_schema(inst, schema["then"], root, path, errors)

    where = path or "<root>"

    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_type_ok(inst, tt) for tt in types):
            errors.append(f"{where}: expected type {t}, got {type(inst).__name__}")
            return

    if "const" in schema and inst != schema["const"]:
        errors.append(f"{where}: expected {schema['const']!r}, got {inst!r}")
    if "enum" in schema and inst not in schema["enum"]:
        errors.append(f"{where}: {inst!r} not one of {schema['enum']}")

    if isinstance(inst, str):
        if "pattern" in schema and re.search(schema["pattern"], inst) is None:
            errors.append(f"{where}: {inst!r} does not match /{schema['pattern']}/")
        if "minLength" in schema and len(inst) < schema["minLength"]:
            errors.append(f"{where}: shorter than minLength {schema['minLength']}")

    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in schema and inst < schema["minimum"]:
            errors.append(f"{where}: {inst} < minimum {schema['minimum']}")
        if "maximum" in schema and inst > schema["maximum"]:
            errors.append(f"{where}: {inst} > maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and inst <= schema["exclusiveMinimum"]:
            errors.append(f"{where}: {inst} <= exclusiveMinimum {schema['exclusiveMinimum']}")

    if isinstance(inst, list):
        if "minItems" in schema and len(inst) < schema["minItems"]:
            errors.append(f"{where}: {len(inst)} items < minItems {schema['minItems']}")
        if "maxItems" in schema and len(inst) > schema["maxItems"]:
            errors.append(f"{where}: {len(inst)} items > maxItems {schema['maxItems']}")
        items = schema.get("items")
        if isinstance(items, list):  # tuple form
            for i, sub in enumerate(items):
                if i < len(inst):
                    validate_schema(inst[i], sub, root, f"{where}[{i}]", errors)
        elif isinstance(items, dict):
            for i, el in enumerate(inst):
                validate_schema(el, items, root, f"{where}[{i}]", errors)

    if isinstance(inst, dict):
        for req in schema.get("required", []):
            if req not in inst:
                errors.append(f"{where}: missing required property {req!r}")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in inst:
                child = f"{path}.{key}" if path else key
                validate_schema(inst[key], sub, root, child, errors)
        if schema.get("additionalProperties", True) is False:
            extra = sorted(set(inst) - set(props))
            if extra:
                errors.append(f"{where}: unexpected propert{'y' if len(extra) == 1 else 'ies'} {extra}")


# ----------------------------------------------------------------- result sink

class Results:
    def __init__(self) -> None:
        self.failures: dict[str, list[str]] = {}
        self.skips: dict[str, str] = {}
        self.ran: set[str] = set()

    def ran_ok(self, gate: str) -> None:
        self.ran.add(gate)

    def fail(self, gate: str, message: str) -> None:
        self.ran.add(gate)
        self.failures.setdefault(gate, []).append(message)

    def skip(self, gate: str, reason: str) -> None:
        self.ran.add(gate)
        self.skips[gate] = reason

    @property
    def ok(self) -> bool:
        return not self.failures

    def report(self) -> None:
        for gate in GATES:
            if gate in self.failures:
                print(f"{gate} FAIL")
                for m in self.failures[gate]:
                    print(f"     - {m}")
            elif gate in self.skips:
                print(f"{gate} SKIP  {self.skips[gate]}")
            else:
                print(f"{gate} PASS")
        total = sum(len(v) for v in self.failures.values())
        print()
        if self.failures:
            print(f"FAIL: {len(self.failures)} gate(s) failing, {total} problem(s)")
        else:
            print("PASS: all gates green")


# ----------------------------------------------------------------------- gates

def gate_s1(graph, schema, r: Results) -> None:
    errors: list[str] = []
    try:
        validate_schema(graph, schema, schema, "", errors)
    except SchemaUnsupported as ex:
        r.fail("S1", f"schema checker cannot run: unsupported {ex}")
        return
    for e in errors[:100]:
        r.fail("S1", e)
    if not errors:
        r.ran_ok("S1")


def gate_s2(graph, r: Results) -> None:
    r.ran_ok("S2")
    node_ids = {n["id"] for n in graph["nodes"]}
    for e in graph["edges"]:
        for end in ("fromNodeId", "toNodeId"):
            if e[end] not in node_ids:
                r.fail("S2", f"edge {e['id']}: {end} {e[end]!r} resolves to no node")


def gate_s3(graph, r: Results) -> None:
    r.ran_ok("S3")
    by_id = {n["id"]: n for n in graph["nodes"]}
    for b in graph["buildings"]:
        for eid in b.get("entranceIds", []):
            node = by_id.get(eid)
            if node is None:
                r.fail("S3", f"building {b['id']}: entranceId {eid!r} resolves to no node")
            elif node.get("type") != "entrance":
                r.fail(
                    "S3",
                    f"building {b['id']}: entranceId {eid!r} is a {node.get('type')!r} node, not an entrance",
                )


def gate_s4(graph, r: Results) -> None:
    r.ran_ok("S4")
    owner: dict[str, str] = {}
    for kind in ("nodes", "edges", "buildings"):
        singular = kind[:-1]
        seen: set[str] = set()
        for item in graph[kind]:
            i = item["id"]
            if i in seen:
                r.fail("S4", f"duplicate {singular} id {i!r}")
            seen.add(i)
            if i in owner and owner[i] != singular:
                r.fail("S4", f"id {i!r} is used by both a {owner[i]} and a {singular}")
            owner[i] = singular


def gate_s5(graph, r: Results, tol_m: float = 0.1) -> None:
    r.ran_ok("S5")
    by_id = {n["id"]: n for n in graph["nodes"]}
    for e in graph["edges"]:
        geom = e["geometry"]
        if len(geom) < 2:
            r.fail("S5", f"edge {e['id']}: geometry has {len(geom)} positions, need >= 2")
            continue
        fn = by_id.get(e["fromNodeId"])
        tn = by_id.get(e["toNodeId"])
        if fn is not None:
            d = haversine_m(geom[0], fn["position"])
            if d > tol_m:
                r.fail(
                    "S5",
                    f"edge {e['id']}: geometry start {tuple(geom[0])} is {d:.3f} m from "
                    f"fromNode {fn['id']} {tuple(fn['position'])} (tolerance {tol_m} m)",
                )
        if tn is not None:
            d = haversine_m(geom[-1], tn["position"])
            if d > tol_m:
                r.fail(
                    "S5",
                    f"edge {e['id']}: geometry end {tuple(geom[-1])} is {d:.3f} m from "
                    f"toNode {tn['id']} {tuple(tn['position'])} (tolerance {tol_m} m)",
                )


_REF_RE = re.compile(r"^(node|edge):[a-z2-7]{8,16}$")


def gate_s6(graph, r: Results) -> None:
    files = sorted(
        p for p in OVERLAYS_DIR.glob("*.json")
        if p.name != "allowed-components.json"
    ) if OVERLAYS_DIR.is_dir() else []
    if not files:
        r.skip("S6", "(no ref overlays in overlays/)")
        return
    r.ran_ok("S6")
    node_ids = {n["id"] for n in graph["nodes"]}
    edge_ids = {e["id"] for e in graph["edges"]}

    def walk(value, source: str) -> None:
        if isinstance(value, str) and _REF_RE.match(value):
            pool = node_ids if value.startswith("node:") else edge_ids
            if value not in pool:
                r.fail("S6", f"{source}: reference {value!r} resolves to nothing")
        elif isinstance(value, dict):
            for v in value.values():
                walk(v, source)
        elif isinstance(value, list):
            for v in value:
                walk(v, source)

    for f in files:
        try:
            walk(json.loads(f.read_text(encoding="utf-8")), f.name)
        except json.JSONDecodeError as ex:
            r.fail("S6", f"{f.name}: not valid JSON ({ex})")


def gate_s7(graph, r: Results) -> None:
    if not SOURCES_MANIFEST.is_file():
        r.skip("S7", "(no sources/manifest.json)")
        return
    r.ran_ok("S7")
    try:
        manifest = json.loads(SOURCES_MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as ex:
        r.fail("S7", f"sources/manifest.json is not valid JSON ({ex})")
        return

    # `fetch-ufrm.py` writes a single top-level reconciliation block.
    recons = []
    if isinstance(manifest.get("reconciliation"), dict):
        recons.append(("ufrm", manifest["reconciliation"]))
    # A per-source `sources` map (e.g. a future combined manifest) is also read.
    for name, entry in (manifest.get("sources") or {}).items():
        if isinstance(entry, dict) and {"fetched", "kept", "rejected"} <= entry.keys():
            recons.append((name, entry))

    if not recons:
        r.fail("S7", "sources/manifest.json has no reconciliation counts to check")
        return
    for name, rec in recons:
        f, k, x = rec.get("fetched"), rec.get("kept"), rec.get("rejected")
        if not all(isinstance(v, int) for v in (f, k, x)):
            r.fail("S7", f"source {name!r}: fetched/kept/rejected are not all integers")
        elif f != k + x:
            r.fail("S7", f"source {name!r}: fetched {f} != kept {k} + rejected {x}")


def gate_s8(graph, r: Results) -> None:
    r.ran_ok("S8")
    ids = [n["id"] for n in graph["nodes"]]
    pos = {nid: i for i, nid in enumerate(ids)}
    parent = list(range(len(ids)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in graph["edges"]:
        a, b = pos.get(e["fromNodeId"]), pos.get(e["toNodeId"])
        if a is not None and b is not None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

    comps: dict[int, set] = defaultdict(set)
    for i, nid in enumerate(ids):
        comps[find(i)].add(nid)
    if len(comps) <= 1:
        return

    allow_path = OVERLAYS_DIR / "allowed-components.json"
    allowed: list[set] = []
    if allow_path.is_file():
        try:
            data = json.loads(allow_path.read_text(encoding="utf-8"))
            allowed = [set(c.get("nodeIds", [])) for c in data.get("components", []) if c.get("reason")]
        except json.JSONDecodeError as ex:
            r.fail("S8", f"overlays/allowed-components.json is not valid JSON ({ex})")
            return

    largest = max(comps.values(), key=len)
    for comp in comps.values():
        if comp is largest:
            continue
        if not any(comp <= a for a in allowed):
            sample = ", ".join(sorted(comp)[:3])
            r.fail(
                "S8",
                f"connected component of {len(comp)} node(s) [{sample}...] is not listed "
                f"with a reason in overlays/allowed-components.json",
            )


def gate_g2(graph, r: Results) -> None:
    r.ran_ok("G2")

    def check(where: str, p) -> None:
        lon, lat = p[0], p[1]
        if lon == 0 and lat == 0:
            r.fail("G2", f"{where}: coordinate is (0, 0)")
            return
        if not (LON_RANGE[0] <= lon <= LON_RANGE[1] and LAT_RANGE[0] <= lat <= LAT_RANGE[1]):
            r.fail("G2", f"{where}: ({lon}, {lat}) outside lon {LON_RANGE} lat {LAT_RANGE}")

    for n in graph["nodes"]:
        check(f"node {n['id']}", n["position"])
    for b in graph["buildings"]:
        check(f"building {b['id']} centroid", b["centroid"])
    for e in graph["edges"]:
        for i, p in enumerate(e["geometry"]):
            check(f"edge {e['id']} geometry[{i}]", p)


def gate_g4(graph, r: Results, tol_m: float = 0.5) -> None:
    r.ran_ok("G4")
    for e in graph["edges"]:
        measured = polyline_length_m(e["geometry"])
        delta = abs(measured - e["lengthM"])
        if delta > tol_m:
            r.fail(
                "G4",
                f"edge {e['id']}: lengthM {e['lengthM']} but geometry measures "
                f"{measured:.2f} m (delta {delta:.2f} m > {tol_m} m)",
            )


def gate_g7(graph, r: Results, min_m: float = 0.5) -> None:
    r.ran_ok("G7")
    # Bucket to a ~1.1 m integer grid; compare only within the 3x3 neighbourhood.
    cells: dict[tuple, list] = defaultdict(list)

    def key(p) -> tuple:
        return (round(p[0] * 1e5), round(p[1] * 1e5))

    pts = [(n["id"], n["position"]) for n in graph["nodes"]]
    for nid, p in pts:
        cells[key(p)].append((nid, p))

    seen: set[tuple] = set()
    for nid, p in pts:
        kx, ky = key(p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for onid, op in cells.get((kx + dx, ky + dy), ()):
                    if onid == nid:
                        continue
                    pair = (nid, onid) if nid < onid else (onid, nid)
                    if pair in seen:
                        continue
                    seen.add(pair)
                    d = haversine_m(p, op)
                    if d < min_m:
                        r.fail("G7", f"nodes {pair[0]} and {pair[1]} are {d:.3f} m apart (min {min_m} m)")


# ------------------------------------------------------------------------ main

def main(argv: list[str]) -> int:
    artifact = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_ARTIFACT
    print(f"artifact: {artifact}")
    print(f"schema:   {SCHEMA_PATH}")
    print()

    if not artifact.is_file():
        print(f"FATAL: artifact not found: {artifact}")
        return 1
    if not SCHEMA_PATH.is_file():
        print(f"FATAL: schema not found: {SCHEMA_PATH}")
        return 1

    try:
        graph = json.loads(artifact.read_text(encoding="utf-8"))
    except json.JSONDecodeError as ex:
        print(f"FATAL: artifact is not valid JSON: {ex}")
        return 1
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    r = Results()
    gate_s1(graph, schema, r)

    if all(isinstance(graph.get(k), list) for k in ("nodes", "edges", "buildings")):
        gate_s2(graph, r)
        gate_s3(graph, r)
        gate_s4(graph, r)
        gate_s5(graph, r)
        gate_s6(graph, r)
        gate_s7(graph, r)
        gate_s8(graph, r)
        gate_g2(graph, r)
        gate_g4(graph, r)
        gate_g7(graph, r)
    else:
        for g in GATES[1:]:
            r.fail(g, "artifact missing nodes/edges/buildings arrays; structural gates skipped")

    r.report()
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
