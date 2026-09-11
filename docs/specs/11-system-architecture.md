# 11 — System architecture

Whole-system design for a fully functioning ASU Tempe map. Covers the three data
tiers, the database schemas and key design, the routing engine down to its data
structures and per-query budgets, the build and release pipeline, the client
runtime, and the constraints that shape each choice.

This supersedes nothing in `01-architecture.md`–`06-map-projection.md`; it is the layer above them.
Where it refines an earlier decision, that is called out explicitly and logged in
`08-decisions.md`.

---

# 1. Sizing first, because it determines everything else

Every architectural choice below follows from how big this graph actually is.
Derivation, so you can redo it when the numbers change:

| Quantity | Estimate | How |
|---|---|---|
| Walkable centerline, core campus | 25–40 km | Target C5, `04-validation-gates.md` |
| Raw OSM vertices | ~2,500–4,000 | One vertex per 8–15 m of footway |
| Nodes after noding + degree-2 collapse | ~3,000–5,000 | Collapse removes most intermediate vertices from the *node* set but keeps them as edge geometry |
| Entrance nodes | ~600 | ~280 buildings × ~2 doors |
| Crossing nodes | ~250 | Campus perimeter + internal service roads |
| Total nodes `V` | **~6,000** | |
| Edges `E` (undirected) | **~8,000** | Degree ≈ 2.7 typical for pedestrian networks |
| Directed arcs | ~16,000 | |
| Mean vertices per edge geometry | ~6 | |
| Total geometry positions | ~48,000 | |

Two conclusions fall straight out:

1. **This graph fits in a phone's memory with room to spare.** ~6k nodes is four
   orders of magnitude below the point where preprocessed routing (contraction
   hierarchies, ALT landmarks) earns its complexity.
2. **Routing belongs on the client.** A single Dijkstra here is a few
   milliseconds. Putting it behind an API buys nothing and costs the offline
   story, a server bill, and a latency floor of 80–150 ms on campus wifi.

**Current decision: no routing server for the outdoor graph.** The only server
components in this system are a static file host and, later, a small write-only
endpoint for problem reports.

---

# 2. The three data tiers

The single most important structural idea in this document. Confusing these
tiers is what produces systems where a construction closure requires a
redeployment of the routing graph.

```
┌──────────────────────────────────────────────────────────────────────┐
│ TIER 1 — AUTHORING           developer machine + CI                  │
│ SQLite/SpatiaLite `authoring.db`, regenerated from sources+overlays   │
│ Mutable, queryable, spatial SQL. Never shipped to a client.          │
│ Purpose: build the graph, run the gates, produce reports.            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ scripts/export-runtime.py
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ TIER 2 — RUNTIME ARTIFACTS   CDN, immutable, content-addressed       │
│ graph-{hash}.bin     binary CSR graph        ~600 KB gzipped         │
│ catalog-{hash}.json  building catalog        ~90 KB gzipped          │
│ footprints-{hash}.pmtiles  building polygons ~2 MB                   │
│ basemap-tempe-{v}.pmtiles  basemap           ~40 MB                  │
│ manifest.json        pointers, 60 s TTL      ~1 KB                   │
│ closures.json        active closures, 60 s   ~2 KB                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ fetch + cache
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ TIER 3 — CLIENT              browser, offline-capable                │
│ IndexedDB: artifacts, schedule, recent routes, outbox                │
│ OPFS: PMTiles cache                                                  │
│ Memory: typed arrays in a Web Worker + catalog on the main thread    │
└──────────────────────────────────────────────────────────────────────┘
```

### Why these boundaries

- **Tier 1 is a database because building the graph is a spatial join problem**,
  not a scripting problem. "Which edges pass inside a footprint", "what is the
  closest point on the network to this boundary", "cluster these vertices within
  1.5 m" are one-line spatial SQL and fifty lines of careful Python each. See §3.
- **Tier 2 has no database** because a read-only, versioned, immutable artifact
  served from a CDN is faster, cheaper, and more available than any database
  query, and it is the only design that works offline.
- **Closures are Tier 2 but separate**, with a short TTL, because they are the
  one thing that changes on a human timescale (a fence goes up on a Tuesday) and
  must not require a graph rebuild.

### Refinement of `03-graph-pipeline.md`

`03-graph-pipeline.md` specifies the builder in Python with union-find
clustering. That is still correct for Phase C and needs no infrastructure. This
document adds: **the builder writes into `authoring.db` as it goes**, so every
intermediate stage is inspectable with SQL and the validators query rather than
re-parse. If the overlay set grows past a few hundred entries or a second person
starts editing, migrate `authoring.db` from SQLite/SpatiaLite to Postgres/PostGIS
with no schema change. Logged as a decision.

---

# 3. Tier 1 — the authoring database

Full DDL in `contracts/authoring.sql`. This section explains the key design.

## 3.1 Key philosophy

Three different id families, each with a different stability contract. Getting
this wrong is the single most expensive mistake available in this system,
because it silently invalidates hand-curated work.

| Family | Form | Stable across | Breaks when |
|---|---|---|---|
| **Natural** | `bldg:MU` | Everything. Forever. | UFRM renames a code (rare, ~1/yr) |
| **Content-derived** | `node:k7q2mf3xza` | Rebuilds where geometry is unchanged | OSM vertex moves >0.5 m |
| **Surrogate dense** | `int32` index 0..V-1 | One build only | Every build |

### Natural keys: `bldg:{CODE}`

`BLDG_CODE` is the only genuinely durable identifier in the system, and it is
**not unique** — 11 codes repeat across 14 extra UFRM features (`02-data-sources.md` §1.1).

Resolution: the primary key is `building_id TEXT`, with a `UNIQUE (code,
ordinal)` constraint. `ordinal = 0` is the primary record; splits become
`bldg:STAD#1`, `bldg:STAD#2`. The `ordinal` is assigned by descending `gsf`, so
it is deterministic across rebuilds as long as gsf does not change.

**Never `dict[code] = row`.** Defect P-13 lost 14 buildings that way, including
collapsing a 771,429 gsf Sun Devil Stadium record into a 56,466 gsf one.

### Content-derived keys: `node:{base32(blake2b(grid))}`

Defined in `03-graph-pipeline.md` §4. The property that matters: **a rebuild from unchanged
inputs produces byte-identical ids**, so overlays keyed by node id survive.

The failure mode, stated plainly because it will happen: an OSM contributor
nudges a footway vertex by 2 m, the node lands in a different 0.5 m grid cell,
the id changes, and every overlay referencing it fails to resolve. `03-graph-pipeline.md` §6
says the build fails in that case, which is correct but not sufficient — you now
have to re-pin the overlay by hand.

Mitigation is §3.2.

### Edge ids: do not hash the geometry

`03-graph-pipeline.md` §4 specifies `edge_id = hash(endpoints | geom_hash)`. **This is
revised.** Including the geometry hash means any vertex nudge anywhere along an
edge changes its id, which is far too brittle for a key that overlays reference.

Revised: `edge_id = "edge:" + base32(blake2b(f"{min(a,b)}|{max(a,b)}|{ord}"))`
where `ord` is the index of this edge among parallel edges between the same node
pair, sorted by ascending `lengthM`. Geometry changes no longer change identity;
only endpoint changes do. Parallel edges between the same two nodes are rare
(divided walkways around a planter) but real, hence `ord`.

`CHECK (from_node_id < to_node_id)` canonicalizes undirected edges so
`(a,b)` and `(b,a)` cannot both exist.

## 3.2 Overlay references — the part everyone gets wrong

An overlay says "this edge has stairs" or "this entrance is really 12 m north".
If it points at a key that moves, the correction silently evaporates.

A reference is a tagged union, resolved in this order:

```
1. osm:way/123456789@3..7     OSM way id + node index range
2. osm:node/987654321         OSM node id
3. node:k7q2mf3xza            content-derived, exact
4. edge:m3p8qw2vzt            content-derived, exact
5. geo:-111.93361,33.41942,r=8   spatial re-anchor, radius in metres
```

The builder resolves each and records **how** it resolved in
`overlay_ref.resolution`:

- `exact` — the id matched. Normal.
- `spatial` — the id did not match, the `geo:` fallback found exactly one
  candidate within the radius. **Warning.** The build succeeds and the report
  lists it for re-pinning.
- `ambiguous` — the fallback found more than one candidate. **Build fails.**
- `failed` — nothing matched. **Build fails.**

Every overlay written by a human should carry both a stable OSM reference *and*
a `geo:` fallback. `scripts/repin-overlays.py` rewrites `spatial` resolutions
back to `exact` ids after a build, so drift is repaired in one commit rather than
accumulating.

This subsystem is the reason hand-curation survives regeneration. Defect P-31
was exactly this problem with no solution at all.

## 3.3 Schema overview

Twelve tables. `contracts/authoring.sql` has the full DDL with every constraint
and index.

```
source_feature ──┐
                 ├─→ building ──→ building_alias
footprint ───────┘      │
                        └──→ entrance ──→ node
osm_way ──→ node ──→ edge ──→ edge_attr (folded into edge)
                       │
overlay_ref ───────────┘
closure ──→ closure_edge
build ──→ build_input
      └─→ build_metric
route_sample
```

### Notes on specific tables

**`source_feature`** holds every fetched upstream feature verbatim, including
the rejected ones, with `reject_reason`. This is what makes
`fetched == kept + rejected` (gate S7) checkable in SQL rather than by trusting a
script's counters. The `(0,0)` features and the duplicate codes live here with
their reasons attached.

**`node`** carries both `node_id TEXT PRIMARY KEY` and
`idx INTEGER NOT NULL UNIQUE`. `idx` is the dense 0..V-1 surrogate assigned at
export time, sorted by a Hilbert curve over the coordinates rather than by id.
Hilbert ordering puts spatially adjacent nodes at adjacent indices, which makes
the CSR adjacency array cache-friendly during Dijkstra. On a graph this small it
saves maybe 10–20% of query time; it costs one sort and is worth taking.

**`edge`** stores geometry as WKB in SpatiaLite (`GEOMETRY LINESTRING 4326`) with
an R-tree index, so gate G3 (`no edge interior more than 2 m inside a footprint`)
is:

```sql
SELECT e.edge_id, b.building_id
FROM edge e
JOIN footprint f ON ST_Intersects(e.geom, f.geom)
JOIN building b  ON b.footprint_id = f.footprint_id
WHERE e.indoor = 0 AND e.tunnel = 0
  AND ST_Length(ST_Intersection(e.geom, f.geom), true) > 2.0;
```

That is the highest-value check in the project (defect P-02) and it is nine lines
of SQL. Hand-rolling it in Python is where you get it subtly wrong.

**`build`** is keyed by `build_hash` — the content hash of the exported graph.
`build_input` records the SHA-256 of every file that went in. Given any artifact
in production you can reconstruct exactly which inputs produced it. `build_metric`
stores every number from `04-validation-gates.md` so you can plot detour ratio over time and see
whether the graph is improving.

**`route_sample`** stores the 500 seeded pairs from `scripts/route-report.py`
with their results per build, so regressions are attributable to a specific
commit rather than noticed three weeks later.

## 3.4 SQLite gotchas that will bite you

- **`PRAGMA foreign_keys = ON;`** must be issued on every connection. SQLite
  defaults it **off**, silently, and your FKs do nothing. Put it in a connection
  hook, not in a script you might forget to run.
- SQLite has no native `ALTER TABLE ... DROP CONSTRAINT`. Migrations are
  table-rebuilds. Since `authoring.db` is regenerated from sources, **do not
  migrate it — delete and rebuild.** It is a derived artifact, gitignored.
- SpatiaLite requires `SELECT load_extension('mod_spatialite');` and
  `SELECT InitSpatialMetaData(1);` on a fresh file. Both go in
  `scripts/lib/db.py`.
- `ST_Length(geom, true)` (geodesic) vs `ST_Length(geom)` (degrees) is a silent
  factor-of-90,000 bug. Always pass `true`, or reproject. Guard it with a unit
  test that asserts a known 100 m segment measures 100 m ± 0.5.

---

# 4. Tier 2 — runtime artifacts

## 4.1 Binary graph format

JSON is the wrong shipping format. `graph.json` at this size is ~3.5 MB raw,
~1 MB gzipped, and costs 300–600 ms of `JSON.parse` on a mid-range Android phone,
during which the main thread is blocked. A typed-array format is ~600 KB gzipped
and parses in single-digit milliseconds because parsing is a set of
`new Float64Array(buffer, offset, count)` calls with no allocation per element.

`graph-{hash}.bin`, little-endian throughout:

```
offset  type        count      field
0       u8[8]       1          magic "SUNWALK1"
8       u32         1          formatVersion = 1
12      u32         1          V   node count
16      u32         1          E   edge count (undirected)
20      u32         1          P   total geometry positions
24      u8[32]      1          graphHash (blake2b-256 of everything after byte 56)
56      —           —          ---- section table: 8 × (u32 offset, u32 length)

NODES
  f64[V]            lon
  f64[V]            lat
  u8[V]             type        0 walkway, 1 entrance, 2 crossing
  u8[V]             flags       bit0 provisional, bit1 weak, bit2 signalized
  u32[V]            buildingIdx entrance only, 0xFFFFFFFF otherwise

CSR ADJACENCY  (directed, both directions materialised)
  u32[V+1]          rowOffset   rowOffset[V] == 2E
  u32[2E]           colTarget   destination node index
  u32[2E]           colEdge     edge index (for attribute lookup)

EDGES
  f32[E]            lengthM
  f32[E]            shadeIndex
  u8[E]             surface     enum
  u8[E]             type        enum
  u8[E]             flags       bit0 stairs, bit1 covered, bit2 indoor,
                                bit3 accessibleKnown, bit4 accessibleValue,
                                bit5 synthetic
  u16[E]            stepCount   0 = unknown
  u32[E]            nameIdx     index into the string table, 0xFFFFFFFF = null
  u32[E+1]          geomOffset  index into GEOMETRY
GEOMETRY
  f32[2P]           lon,lat interleaved, as offsets from a per-edge f64 origin
STRINGS
  u32               count
  u32[count+1]      offsets
  u8[...]           UTF-8 bytes
```

Details that matter:

- **`f32` for geometry, `f64` for node positions.** A float32 holds ~7 decimal
  digits; a longitude of -111.933610 needs 9. Storing raw f32 lon/lat gives you
  ~1 m of error. Storing an **offset from a per-edge f64 origin** keeps values
  under ~0.01 degrees where f32 gives ~1 mm. Node positions are f64 because
  entrances anchor everything and 1 mm is not worth the risk there.
- **`f32` for `lengthM`.** 7 digits on a value under 2000 m is millimetre
  precision. Fine.
- **CSR with both directions materialised** doubles the arc arrays (128 KB) and
  removes a branch from the inner loop. Worth it.
- **`rowOffset` is `u32[V+1]`**, the standard CSR trailing-length trick, so
  `degree(v) = rowOffset[v+1] - rowOffset[v]` with no bounds special case.
- No strings in the hot arrays. `node_id` and `edge_id` strings live in a
  **separate optional sidecar** `graph-ids-{hash}.bin`, fetched only when the
  debug overlay is enabled. Production clients never load them; they work in
  dense indices and translate at the API boundary via the catalog.

Endianness: every platform running this is little-endian. Assert it at load
(`new Uint8Array(new Uint32Array([1]).buffer)[0] === 1`) and fail loudly rather
than silently producing garbage.

## 4.2 Catalog

`catalog-{hash}.json` is the ~280-building list with `displayName`, `category`,
`centroid`, `entranceIdx[]`, `routable`, `imageUrl`. It stays JSON because it is
small (~90 KB gzipped), it is needed on the main thread for the picker, and it
is the only thing the UI searches over. Search is a linear scan with a normalized
prefix match; at 280 items that is microseconds and needs no index.

## 4.3 Footprints

Building polygons are ~2 MB as GeoJSON. Ship them as a **PMTiles vector tileset**
rather than a GeoJSON source, so MapLibre loads only what is in view. They are
never needed by the domain layer at runtime — the footprint-crossing check runs
at build time, not query time.

## 4.4 Closures

```json
{
  "generatedUtc": "2026-08-27T14:02:00Z",
  "graphHash": "9f2c…",
  "closures": [
    { "id": "closure:cady-mall-east-2026-08",
      "reason": "Utility trench, Cady Mall east of Palm Walk",
      "from": "2026-08-18T00:00:00Z", "to": "2026-10-01T00:00:00Z",
      "refs": ["edge:m3p8qw2vzt", "geo:-111.93340,33.42050,r=10"] }
  ]
}
```

`graphHash` is the guard: if the client's cached graph does not match, closures
that reference edge ids may not resolve. The client resolves what it can, drops
the rest, and shows a "some closures may be out of date" state rather than
routing through a trench.

TTL 60 s, `stale-while-revalidate`. A closure edit is: edit JSON, redeploy static
file, live in a minute. **No graph rebuild.** This is the payoff for keeping
closures out of Tier 2's immutable artifacts.

## 4.5 Release protocol

```
manifest.json  (Cache-Control: max-age=60, must-revalidate)
{
  "graph":      "graph-9f2c4a1e.bin",
  "catalog":    "catalog-9f2c4a1e.json",
  "footprints": "footprints-9f2c4a1e.pmtiles",
  "basemap":    "basemap-tempe-2026w34.pmtiles",
  "minAppVersion": 3
}
```

All hashed artifacts: `Cache-Control: public, max-age=31536000, immutable`.
They are never mutated; a new build produces new filenames. This means:

- No cache invalidation problem. Ever.
- Rollback is editing one line of `manifest.json`.
- A client mid-session keeps working on the old artifacts; it picks up the new
  ones on next cold start, or on an explicit "update available" prompt.
- Two clients on different graph versions cannot corrupt each other because
  there is no shared mutable state.

`minAppVersion` lets you force a client upgrade when the binary format changes.
The client compares, and if it is too old, shows an update prompt instead of
misparsing the file.

---

# 5. The routing engine

## 5.1 Where it runs

**In a dedicated Web Worker**, not on the main thread.

Rationale: a single route is 2–5 ms and would be fine on the main thread, but
three planned features are not — isochrones (one-to-all Dijkstra), batch
schedule routing (10–14 routes when a schedule is imported), and alternative
route generation. Doing any of those on the main thread drops frames during a
map interaction. Putting the graph in a worker from the start costs one
`postMessage` boundary and removes a whole class of future jank.

Split:

| Lives on main thread | Lives in the worker |
|---|---|
| Building catalog (280 items) | Node/edge typed arrays |
| Session object | CSR adjacency |
| MapLibre, all rendering | Dijkstra scratch buffers |
| Route GeoJSON (received from worker) | Spatial grid index |

The worker receives `{fromBuildingId, toBuildingId, profile, departAtUtc}` and
returns `{ok, route: {legs, lengthM, estimatedSec, shadedFraction, geometry}}`
where `geometry` is a `Float64Array` **transferred**, not copied. Transferables
matter: a 400-position route is 6.4 KB, and structured-clone of it is ~0.1 ms,
which is nothing — but the same discipline applied to isochrone results (tens of
thousands of positions) is the difference between smooth and not.

## 5.2 Data structures in the hot loop

The single biggest performance mistake available here is what the prototype did:
`Map<string, {edgeId, other, lengthM}[]>` adjacency, with string ids in the inner
loop. Every relaxation becomes a hash of a 20-character string plus a pointer
chase into a heap-allocated object. That is roughly 30–60× slower than the
alternative and it allocates.

```ts
// Persistent scratch, allocated once at graph load, reused across queries.
const dist   = new Float64Array(V);
const prevN  = new Int32Array(V);      // predecessor node
const prevE  = new Int32Array(V);      // predecessor edge
const stamp  = new Int32Array(V);      // generation stamp
let   gen    = 0;

// Binary heap over (key: f64, value: i32), no objects.
const heapKey = new Float64Array(V * 2);
const heapVal = new Int32Array(V * 2);
let   heapLen = 0;
```

**Generation stamps** replace clearing `dist` and `visited` between queries.
`gen++` at the start of a query; a node is "seen this query" iff
`stamp[v] === gen`. This turns an O(V) memset per query into O(1). At V = 6,000
the memset is ~5 µs, so this is a small win, but it also removes any chance of
stale state leaking between queries, which is the real reason to do it.

Heap capacity `2V` is a safe bound for lazy-deletion Dijkstra (each node can be
pushed once per improving relaxation; in practice far below 2V, but the bound
avoids a growth check in the loop). Assert on overflow in dev builds.

## 5.3 Algorithm: bidirectional A\*

**Baseline: Dijkstra.** Correct, simple, and the reference implementation the
tests compare against. Keep it forever as `routeReference()` and assert that the
optimized path returns identical costs on the 500 sampled pairs. Any divergence
is a bug in the optimization, not in Dijkstra.

**Production: bidirectional A\* with a haversine heuristic.**

Admissibility argument, which must hold or the algorithm returns wrong answers:

```
cost(e) = (lengthM / (speed × surfaceFactor)) + stairsPen + crossingPen
          × (1 + shadeWeight × (1 - shadeIndex) × heatFactor)

surfaceFactor ≤ 1.0        so lengthM/(speed × sf) ≥ lengthM/speed
stairsPen, crossingPen ≥ 0
shade multiplier ≥ 1       since shadeWeight, (1-shadeIndex), heatFactor ≥ 0

⟹ cost(e) ≥ lengthM(e) / speedMax

h(v) = haversine(v, target) / speedMax   is admissible and consistent.
```

`speedMax` is the profile's `walkSpeedMps` (surfaceFactor never exceeds 1.0).
Write this as a comment above `heuristic()` and as a property test: for 10,000
random node pairs, assert `h(u) - h(v) ≤ cost(u,v)` (consistency). If someone
later adds a discount to the cost function — a "shaded paths are *faster*"
multiplier below 1.0 — this test fails immediately and tells them why.

Bidirectional termination is the classic trap. **Stop when
`topForward.key + topBackward.key ≥ μ`**, where `μ` is the best complete path
found so far, not when the searches first touch. Touching does not imply
optimality. Every implementation gets this wrong once; write the test that
catches it (a graph with one short-but-late-discovered edge).

Expected work at V = 6,000: plain Dijkstra settles ~all 6,000 nodes on a
cross-campus route. Bidirectional A\* settles roughly 400–1,200. That is the
difference between ~4 ms and ~0.4 ms.

**Explicitly rejected:**

- **Contraction Hierarchies.** Preprocessing bakes in edge weights. Our weights
  depend on profile, time of day, and active closures, all of which vary per
  query. Customizable CH handles this with a metric-independent phase, but its
  break-even is around 10^5–10^6 nodes. At 6,000 it is pure complexity.
- **ALT / landmarks.** Same conclusion. Precomputing 16 landmark distance tables
  is 16 × 6,000 × 8 bytes = 768 KB for maybe a 2× speedup over an already
  sub-millisecond query.
- **Precomputed all-pairs.** 6,000² × 4 bytes = 144 MB. No.

## 5.4 Multi-entrance origins and destinations

Origin and destination are buildings, and buildings have several doors. The
naive approach — route from door 0 — picks the wrong door constantly.

Correct formulation: **many-to-many shortest path**, solved as a single search.

- Seed the forward queue with **every** origin entrance at `dist = 0`.
- Seed the backward queue with **every** destination entrance at `dist = 0`.
- The result is the min over all (origin door, destination door) pairs, in one
  search rather than |O| × |D| searches.

Correctness note that trips people up: with multiple targets you may **not**
terminate when the first target is *relaxed*. You terminate on the standard
bidirectional condition. A target reached early via an expensive edge is not the
answer.

Optional refinement: seed each entrance with a small non-zero cost representing
the walk from inside the building to that door. Without data this is guesswork;
leave it at 0 and record it as a known approximation.

## 5.5 Time-dependence and the shade multiplier

`heatFactor(now)` makes cost time-varying. This is **not** a time-dependent
routing problem in the technical sense, because we evaluate the whole route at
departure time rather than evaluating each edge at its arrival time.

State the approximation honestly: a 20-minute walk beginning at 17:50 in June is
costed entirely at 17:50's heat factor, even though the last third happens after
sunset. The error is bounded by the difference in `heatFactor` across the walk
duration, which is small because `heatFactor` is a smooth hourly curve.

Doing it properly means a time-dependent Dijkstra where `cost(e)` takes arrival
time. That is a well-defined extension (the cost function is FIFO — leaving later
never gets you there earlier, since the multiplier is bounded and continuous), so
it stays correct with plain Dijkstra. It is not worth doing until someone
complains.

`hourBucket = floor(departure hour)` is part of the route cache key.

## 5.6 Closures

Active closures become a `Uint8Array(E)` mask rebuilt whenever `closures.json`
changes or the hour rolls over. In the inner loop:

```ts
if (blocked[edgeIdx]) continue;
```

One array lookup, one branch, no graph mutation. The mask is also what makes
"why can't I get there" answerable: if a route fails with closures applied but
succeeds without, the failure reason is `blocked_by_closure` with the closure id,
not `disconnected`.

## 5.7 Accessibility profile

`requireAccessible` excludes edges where `stairs === true` or
`accessible === false`. `accessible === null` (unknown) is **included**, with a
flag on the resulting route so the UI can say "part of this route has unverified
accessibility". Excluding unknowns would make most of campus unroutable, since
OSM `wheelchair=*` coverage is sparse; including them silently would be
dishonest. Surfacing the uncertainty is the only defensible option.

If the destination becomes unreachable under the profile, return
`no_accessible_route` and offer the default-profile route as a labelled fallback.
Never return `null` (defect P-24).

## 5.8 Leg generation

After the path is recovered, walk it and emit legs. Boundary conditions:

- bearing change > 35° between consecutive edge tangents (measured over the
  first/last 10 m of each edge, not endpoint-to-endpoint, or curved paths
  generate phantom turns)
- `edge.name` changes and both are non-null
- an edge of type `crossing` is entered
- an edge of type `steps` is entered or left
- the final `link` edge into the entrance

Instruction text prefers path names. On a campus, "continue along Palm Walk, then
left onto Cady Mall" beats "in 140 m turn left" because students navigate by mall
names. Fall back to compass bearings only when `name` is null.

## 5.9 Alternatives

For "show me another way": the **penalty method**. Run the search, multiply the
cost of every edge on the returned path by 1.4, re-run, accept the second result
if it shares less than 70% of its length with the first, up to 3 attempts. Simple,
no preprocessing, ~4× the cost of one query, which is still under 2 ms. The
plateau method gives better alternatives but needs a full one-to-all search from
both ends.

## 5.10 Isochrones

"What can I reach in 8 minutes" — needed for the schedule feature and genuinely
useful for orientation. One-to-all Dijkstra from the origin entrances, capped at
the time budget, then take the reachable node set and build a concave hull
(alpha shape, α ≈ 60 m). ~8 ms including the hull. Worker only.

## 5.11 Nearest-edge snapping (for "route from my location")

Uniform grid, cell size 25 m. Campus 2,000 × 2,000 m ⟹ 80 × 80 = 6,400 cells,
`Int32Array` bucket storage in CSR form (same offsets trick). Each edge is
inserted into every cell its bounding box touches; at ~30 m mean edge length that
is 1–4 cells per edge, ~20,000 entries, 80 KB.

Query: scan the 3×3 cell neighbourhood, compute point-to-segment distance against
each candidate edge's segments, take the minimum. Typical candidate count 5–20,
so ~50 segment tests, under 20 µs. If the 3×3 ring is empty, expand to 5×5, then
give up at 125 m and return `too_far_from_network`.

An R-tree would also work and is not better at this size. The grid has no
allocation, no rebalancing, and is one flat array.

## 5.12 Runtime budget

Targets, measured on a mid-range Android (roughly a Pixel 6a) in a worker:

| Operation | Budget | Expected | Notes |
|---|---|---|---|
| Parse `graph.bin` | 20 ms | 3–8 ms | Typed-array views, no per-element work |
| Build grid index | 15 ms | 5 ms | Once at load |
| Single route, bidirectional A\* | **15 ms p99** | 0.4–2 ms | Gate P3 |
| Single route, reference Dijkstra | 30 ms | 3–6 ms | Test path only |
| Nearest edge | 1 ms | 20 µs | |
| Isochrone, 10 min | 40 ms | 8 ms | |
| Batch 14 schedule routes | 100 ms | 15 ms | Reuses scratch buffers |
| `setData` on route source | 8 ms | 2 ms | ~400 positions |
| `setData` on graph-edges source | — | **40–80 ms** | See §6.2. Do not do this often |

Every one of these has a benchmark in `tests/bench/` that runs in CI and fails
the build on a >30% regression. Benchmarks that are not enforced are decoration.

---

# 6. Tier 3 — the client

## 6.1 Cold start sequence

```
0 ms     HTML + app shell from service worker cache        (precached)
         └─ render map container + skeleton immediately
20 ms    fetch manifest.json (network, 60 s TTL)
         └─ if offline or slow: use last-known manifest from IndexedDB
40 ms    MapLibre init, basemap PMTiles from OPFS cache
         parallel: fetch catalog-{hash}.json  (cache hit → 0 ms)
         parallel: worker.postMessage(load graph-{hash}.bin)
120 ms   catalog resolved → picker interactive
180 ms   worker reports graph ready → routing enabled
250 ms   footprints + graph overlay tiles render
```

Budget: **interactive picker under 400 ms warm, under 2.5 s cold on 4G.**

The ordering matters. The picker is usable before the graph finishes loading,
because searching for "Coor Hall" only needs the catalog. Do not gate the UI on
the worker.

## 6.2 The `setData` cost, and why the earlier doc needs refining

`06-map-projection.md` says every source subscribes to the store. That is right in principle
and wrong if implemented naively, because `GeoJSONSource.setData` re-parses and
re-tiles the entire source synchronously on the main thread. For the graph-edges
source (~8,000 LineStrings, ~3 MB of GeoJSON) that is 40–80 ms — a visible
stutter, on every store change.

Refinement:

| Source | Update policy |
|---|---|
| `route` | `setData` on every route change. ~400 positions, ~2 ms. Fine |
| `buildings` | `setData` only when the catalog hash changes, i.e. essentially never |
| `graph-edges`, `graph-nodes` | Loaded once. Visibility toggled via `setLayoutProperty`, never re-set. Debug overlay only |
| `footprints` | PMTiles vector source. MapLibre handles it |
| `closures` | Small GeoJSON of blocked segments, `setData` on closure refresh |

Guard: every subscriber compares a **content hash** of its projection before
calling `setData`. A no-op update must cost a hash comparison, not a re-tile.

## 6.3 Storage

**IndexedDB** — database `sunwalk`, version-migrated:

| Store | Key | Contents |
|---|---|---|
| `artifacts` | `filename` | `ArrayBuffer` + `fetchedUtc`. LRU, keep 2 graph versions |
| `manifest` | `"current"` | Last-known-good manifest, for offline start |
| `schedule` | `courseId` | Parsed class schedule. **Never leaves the device** |
| `recent` | `routeId` | Last 20 routes for instant recall |
| `outbox` | `uuid` | Queued problem reports, drained when online |

**OPFS** (Origin Private File System) for PMTiles. Not the Cache API — PMTiles
works by HTTP range requests, and the Cache API stores whole responses, so range
requests through a service worker either bypass the cache or force you to store
the entire 40 MB file per range. `pmtiles.js` supports a custom source; point it
at an OPFS-backed reader.

Realistic offline plan: ship a **campus-only** basemap extract, zooms 14–18,
bounded by the service-area polygon. That is roughly 8–20 MB rather than 40, and
is small enough to prefetch on first run over wifi with a user prompt. The
full-Tempe extract stays online-only.

**Quota.** Chrome grants roughly 60% of free disk; Safari is far stingier and
evicts under pressure. Handle `QuotaExceededError` on every write, degrade to
network-only, and never assume a cached artifact is still there — always check
before use.

## 6.4 Service worker

- Precache: app shell, catalog, `manifest.json` fallback.
- Runtime: stale-while-revalidate for `manifest.json` and `closures.json`;
  cache-first-forever for hashed artifacts (they are immutable, so this is safe
  by construction).
- **Never** intercept PMTiles range requests. Let them through to OPFS.
- Update flow: new SW installs, waits, and the app shows an "update available"
  affordance rather than reloading under the user mid-navigation.

## 6.5 Privacy constraints

These are design constraints, not policy footnotes.

- **Class schedule never leaves the device.** It is education-record-adjacent
  data. Parsing is client-side, storage is IndexedDB, and there is no endpoint
  that accepts it. This also means no server-side "next class" push, ever.
  Accept that trade.
- **Geolocation is never transmitted.** `GeolocateControl` output stays in the
  browser and is used only for map centring and nearest-edge snapping.
- **Problem reports** include the route id, both building codes, the graph hash,
  and free text. They do **not** include position traces unless the user
  explicitly attaches one.
- Any aggregate telemetry (which building pairs are routed most, to prioritise
  ground-truthing) requires opt-in and is sent as coarse counts, not events.

---

# 7. The pipeline, end to end

```
  ┌─ ArcGIS FeatureServer  layer 0 (polygons) + layer 10 (points)
  │  scripts/fetch-ufrm.py     → sources/ufrm-*.geojson + manifest
  │
  ├─ Geofabrik Arizona .osm.pbf (version-pinned)
  │  scripts/fetch-osm.py      → sources/osm-tempe.pbf + manifest
  │
  └─ sources/service-area.geojson   (hand-drawn, committed)
                    │
                    ▼
        scripts/build-graph.py
        ├── stage 0  load, clip, reject-log        → source_feature
        ├── stage 1  way extraction                → osm_way
        ├── stage 2  noding, intersection split,
        │            1.5 m clustering              → node
        ├── stage 3  stub removal, degree-2
        │            collapse, components          → edge
        ├── stage 4  content-derived ids           → node.node_id, edge.edge_id
        ├── stage 5  entrance discovery + edge
        │            splitting at projection       → entrance
        ├── stage 6  overlay resolution            → overlay_ref.resolution
        └── stage 7  costs, shadeIndex, metrics    → build, build_metric
                    │
                    ▼            authoring.db  (SQLite + SpatiaLite)
                    │
        scripts/validate-graph.py   ← queries authoring.db, not files
        scripts/route-report.py     ← writes route_sample
                    │
                    ▼
        scripts/export-runtime.py
        ├── Hilbert-sort nodes → dense idx
        ├── build CSR
        ├── pack graph-{hash}.bin
        ├── emit catalog-{hash}.json
        ├── tippecanoe footprints → footprints-{hash}.pmtiles
        └── write manifest.json
                    │
                    ▼
             CDN (R2 / Pages) — immutable, hashed
```

## 7.1 Determinism

`build-graph.py --check` rebuilds into a temp directory and compares the
`graphHash`. CI runs it. Non-determinism in this pipeline comes from exactly four
places, and all four are worth naming because they will happen:

1. **Unordered iteration** over `dict`/`set` before emitting. Sort everything at
   every emit boundary.
2. **Floating-point accumulation order** in `polylineLengthM`. Sum in fixed
   coordinate order, and round to 0.1 m before hashing.
3. **Tie-breaking** in nearest-edge and duplicate-code resolution. Every
   comparator must have a total order — break ties on the id, never leave two
   items equal.
4. **Timestamps** leaking into hashed content. `generatedUtc` lives in the
   manifest, which is **excluded** from `graphHash`.

## 7.2 CI

```yaml
on: [pull_request, push]
jobs:
  build:
    - python scripts/build-graph.py                 # writes authoring.db
    - python scripts/build-graph.py --check         # determinism
    - python scripts/validate-graph.py              # 04-validation-gates.md gates, SQL-backed
    - python scripts/route-report.py --assert       # R1..R5
    - npm run typecheck
    - node --test                                   # domain, fixture-based
    - node --test tests/bench --bench-assert        # §5.12 budgets
    - python scripts/export-runtime.py --dry-run    # format packs cleanly
  artifacts:
    - build/report.md                               # posted as a PR comment
```

The PR comment showing detour-ratio and coverage deltas is what makes graph
quality visible per change rather than discovered at a milestone.

---

# 8. Extension: transit and shuttles

Sketched, not specified, so the model does not have to be redesigned later.

ASU Tempe has Orbit circulators, the Valley Metro light rail on Apache, and
inter-campus shuttles. Walking-plus-transit is a genuinely different problem.

**Do not model it as a time-expanded graph with Dijkstra.** That is the naive
approach and it produces a graph two to three orders of magnitude larger (one
node per stop per departure) for no benefit.

Use **RAPTOR** (Round-bAsed Public Transit Optimized Router) or **CSA**
(Connection Scan Algorithm) over a GTFS feed, with the pedestrian graph used only
for the first-mile, last-mile, and transfer legs. Structure:

```
walk(origin → stops within 400 m)   ← pedestrian Dijkstra, multi-target
RAPTOR over GTFS, ≤3 rounds
walk(stops → destination)           ← pedestrian Dijkstra, multi-source
```

This keeps the two graphs separate, which is what lets you update a GTFS feed
weekly without touching the walking graph. GTFS for Valley Metro is published;
ASU shuttle schedules may need scraping, which is a data-availability question
before it is an engineering one.

Scope it as its own phase. The walking product must be trustworthy first.

---

# 9. Constraint summary

The things that will actually bite, collected in one place.

| # | Constraint | Consequence |
|---|---|---|
| K-01 | `BLDG_CODE` is not unique (11 duplicates) | Composite key `(code, ordinal)`, never `dict[code]` |
| K-02 | Content-derived ids move when geometry moves | Overlay reference resolution with OSM-id and spatial fallbacks (§3.2) |
| K-03 | SQLite FKs are off by default | `PRAGMA foreign_keys=ON` in the connection hook |
| K-04 | `ST_Length` without `true` returns degrees | Unit test asserting a known 100 m segment |
| K-05 | f32 cannot hold WGS84 coordinates | Per-edge f64 origin, f32 offsets |
| K-06 | `GeoJSONSource.setData` re-tiles synchronously | Content-hash guard; never re-set the graph-edges source |
| K-07 | `isStyleLoaded()` is false during tile loads | Never guard on it; pending-flush pattern (defect P-18) |
| K-08 | Cache API cannot serve HTTP range requests usefully | PMTiles goes in OPFS, service worker does not intercept it |
| K-09 | Safari evicts storage aggressively | Every cached artifact read must handle a miss |
| K-10 | Bidirectional search must not stop on first touch | Terminate on `fwd.top + bwd.top ≥ μ`; test it |
| K-11 | A\* heuristic breaks if any cost multiplier drops below 1 | Consistency property test over 10k random pairs |
| K-12 | Multi-target search must not stop on first relaxation | Same termination condition; test it |
| K-13 | Schedule data is education-record-adjacent | Client-only, no endpoint accepts it |
| K-14 | ODbL share-alike on the derived database | D-001 resolved 2026-08-28 (option A): ship `graph.json` under ODbL 1.0, attribute OSM, keep UFRM attrs separate. See `/NOTICE` |
| K-15 | Non-determinism from unordered iteration | Sort at every emit boundary; `--check` in CI |
| K-16 | `heatFactor` is evaluated at departure, not arrival | Documented approximation; FIFO so plain Dijkstra stays correct |
| K-17 | `accessible === null` is common in OSM | Include unknowns, flag the route, never silently exclude |
| K-18 | Closures referencing a stale `graphHash` | Resolve what you can, drop the rest, tell the user |

---

# 10. What this architecture deliberately does not do

- **No server-side routing.** Costs the offline story for no gain at this size.
- **No user accounts or sync.** Adds a backend, a privacy surface, and an
  ops burden to a tool whose entire state is one schedule and twenty recent
  routes.
- **No real-time anything.** No live shuttle positions, no crowd density. Each
  would require a backend and a data source that does not currently exist.
- **No indoor routing.** No data source. Do not fake it; a wrong indoor path in
  an unfamiliar building is worse than no indoor path.
- **No preprocessed routing indices.** 6,000 nodes.
- **No graph mutation at runtime.** Closures are a mask, not an edit. The graph
  is immutable for the lifetime of a session, which removes every consistency
  question between the router, the map, and the cache.
