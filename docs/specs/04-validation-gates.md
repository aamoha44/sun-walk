# 04 — Validation gates

`scripts/validate-graph.py` runs against **the artifacts the application
actually loads**: `build/graph.json` and `build/footprints.geojson`. Nothing
else. The previous prototype's validator pointed at `data/graph/nodes.geojson`
and `data/graph/edges.geojson`, paths that did not exist, while the app loaded
`data/graph-nodes.json`. It had never run against real data.

**Gate 0 for this file: a validator that reads a path the app does not load is a
bug, not a validator.** The validator imports the same loader module the app
uses. It does not open files by hand-written path.

Exit code 0 = all `ERROR` gates pass. `WARN` gates print but do not fail; they
are tracked in `build/report.md`.

## Structural (ERROR)

| # | Gate |
|---|---|
| S1 | `graph.json` validates against `graph.schema.json` |
| S2 | Every `edge.fromNodeId` and `edge.toNodeId` resolves to a node |
| S3 | Every `building.entranceIds[]` resolves to a node with `type == "entrance"` |
| S4 | Every `node` id is unique; every `edge` id is unique; every `building` id is unique |
| S5 | Every edge geometry has ≥2 positions; first == `fromNode` coords, last == `toNode` coords, within 0.1 m |
| S6 | Every overlay entry's target id resolves |
| S7 | `fetched == kept + rejected` for each source |
| S8 | The graph has exactly one connected component, or every extra component is listed in `overlays/allowed-components.json` with a reason |

## Geometric (ERROR unless noted)

| # | Gate |
|---|---|
| G1 | Every coordinate lies inside `sources/service-area.geojson` |
| G2 | No coordinate is `(0, 0)` or outside `lon ∈ [-112.2, -111.7]`, `lat ∈ [33.3, 33.5]` |
| G3 | **No edge interior passes more than 2 m inside a building footprint**, unless the edge is tagged `indoor: true` or `tunnel: true` |
| G4 | `lengthM` matches the recomputed haversine polyline length within 0.5 m |
| G5 | No edge longer than 400 m without an intermediate vertex (WARN) |
| G6 | Every edge that crosses a road centerline has a `crossing` node at the intersection |
| G7 | No two nodes closer than 0.5 m to each other |
| G8 | No entrance node further than 40 m from its building's footprint (WARN at 25 m) |

**G3 is the single most valuable gate in this file.** It mechanically catches the
prototype's defining failure: mall centerlines passing within 2 m of the
centroids of Payne Hall, the Engineering Research Center, the Psychology
Building, the Art Building, Farmer Education, ISTB1, ISTB2, the Memorial Union,
and Bateman Physical Sciences F, and within 6 m of Coor Hall, Hayden Library,
Noble Library, Psychology North, and Ross-Blakley Hall. Routes were drawn through
buildings and nobody noticed because nothing checked.

## Coverage (ERROR at the listed threshold)

| # | Gate | Threshold | Prototype |
|---|---|---|---|
| C1 | Buildings in service area with ≥1 entrance | ≥ 95% | 22% |
| C2 | Buildings in service area within 50 m of the graph | ≥ 90% | 32% |
| C3 | Buildings ≥ 50,000 gsf that are unroutable | 0 | 37 |
| C4 | Every routable building reachable from `bldg:MAIN` | 100% | n/a |
| C5 | Total walkable centerline | ≥ 25 km | 6.2 km |
| C6 | Entrances still `provisional: true` | WARN, listed in report | n/a |

## Route quality (ERROR)

`scripts/route-report.py` samples 500 deterministic pairs (seeded RNG, fixed
seed 20260827) among routable buildings more than 50 m apart, computes the
detour ratio (graph distance ÷ haversine straight line), and asserts:

| # | Gate | Threshold | Prototype |
|---|---|---|---|
| R1 | Median detour ratio | ≤ 1.30 | 1.50 |
| R2 | p90 detour ratio | ≤ 1.45 | 2.22 |
| R3 | Max detour ratio | ≤ 3.00 | 9.12 |
| R4 | No pair returns `null` when both are `routable` | 0 | n/a |
| R5 | Golden routes match the committed fixture | exact | n/a |

The thresholds ratchet: once a build passes at a better number, update the
threshold to that number rounded up to the nearest 0.01. Never loosen a
threshold without recording why.

**Golden routes (R5)** are 10 hand-verified paths committed as
`tests/fixtures/golden-routes.json`, each with its node id sequence and expected
length within ±2 m. They come out of Phase-E walking. Until Phase E, R5 is
skipped and the report says so.

For reference, a pure Manhattan grid gives a median detour ratio near 1.27, so
R1 at 1.30 is close to the achievable floor.

## Performance (WARN)

| # | Gate | Threshold |
|---|---|---|
| P1 | `graph.json` gzipped size | ≤ 2 MB |
| P2 | Store hydration time, cold | ≤ 250 ms |
| P3 | p99 single route computation | ≤ 15 ms |

P3 requires a binary heap in Dijkstra. The prototype called `queue.sort()` on
every pop, which is correct but is `O(E · V log V)`. Acceptable at 197 nodes,
not at the 5,000–15,000 nodes this graph will have.

## CI wiring

```yaml
- python scripts/build-graph.py --check     # determinism
- python scripts/validate-graph.py          # gates above
- python scripts/route-report.py --assert   # R1..R5
- npm run typecheck
- node --test                               # domain tests, fixture-based
```

Every PR that touches `sources/`, `overlays/`, `scripts/`, or `src/domain/`
attaches the diff of `build/report.md` in the description.
