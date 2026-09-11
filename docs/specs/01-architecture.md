# 01 — Architecture

Identity-first domain model. MapLibre is a projection of that model, never its
storage.

## The four protocols

1. **Identity.** Every object is reachable by `store.get(id)`. `id` is stable and
   globally unique across kinds.
2. **Reference.** Objects refer to each other by id. Never embed a copy of
   another object. A stale copy is the single most common source of "the route
   is right but the map is wrong".
3. **Projection.** The map layer receives GeoJSON produced by `project*()`
   methods on the store. Projections are derived, disposable, and regenerated
   whenever the underlying objects change.
4. **Session.** Live UI state is one object, `session:local`, containing ids and
   scalars only.

## Object kinds

| Kind | Id form | Notes |
|---|---|---|
| `building` | `bldg:{CODE}` | UFRM `BLDG_CODE`, uppercase, deduplicated |
| `node` | `node:{hash}` | Walkway vertex, entrance, or crossing. Content-derived id |
| `edge` | `edge:{hash}` | Walkable polyline between two nodes |
| `route` | `route:{fromId}>{toId}@{profile}` | Computed path, cached |
| `closure` | `closure:{slug}` | Dated blockage over edges or nodes |
| `session` | `session:local` | Singleton |

Full field definitions live in `types.ts`. That file is the contract;
this document explains intent.

### Building

A building has a `centroid` (from UFRM layer 10), a `footprintId` pointing at a
polygon stored separately, and `entranceIds: EntityId[]`. **Plural.** The
previous prototype allowed exactly one entrance per building, placed at the
centroid, which made the final leg of every route a straight line into the
middle of the building.

`category` comes from UFRM layer 0's `Type` field, not from a hardcoded list and
not from a floor-area threshold. The prototype used `gsf >= 90000`, which
classified eight parking structures as featured campus destinations and then
tried to filter them back out with three regexes over the display name.

`routable` is a computed boolean: true when the building has at least one
non-provisional entrance inside the service area. It is stored so the UI can
grey out unreachable destinations rather than letting the user pick one and get
nothing.

### Node

Three types:
- `walkway` — a vertex of the pedestrian network
- `entrance` — a door, on or adjacent to a building footprint boundary
- `crossing` — where a walkway meets a road; carries `signalized: boolean`

An entrance is a real door position. If the builder could not find one it emits
a projected candidate with `provisional: true`, and that candidate appears in the
manual work queue. Provisional entrances still route; they are just flagged as
unverified and are the first thing to fix during Phase E ground-truthing.

### Edge

An edge is a **polyline**: `geometry: [lon, lat][]` with at least two positions.
`fromNodeId` and `toNodeId` must equal the first and last positions. `lengthM` is
the haversine sum along the polyline and is computed by the builder, never
hand-entered.

The prototype's edges were implicit straight segments between two nodes. That
forced the graph to be a dense chain of sample points to approximate any curve,
which is why it had 106 edges to cover 6.2 km, and it made every drawn route a
polygonal approximation of the real path.

Edges carry routing attributes: `surface`, `stairs`, `covered`, `shadeIndex`,
`accessible`, `indoor`. See `05-routing-and-cost.md`.

Edges are undirected. Direction is expressed at routing time, not stored.

### Route

A route holds `nodeIds`, `edgeIds`, `lengthM`, `estimatedSeconds`, `legs[]`, and
the `profile` it was computed under. Routes are cached in the store keyed by
`from`, `to`, and profile hash, and are **invalidated wholesale** whenever the
graph or an overlay changes. The prototype cached routes forever with no
invalidation path.

### Closure

`closure:{slug}` names a set of edge ids or node ids plus a date range and a
reason. Closures live in `overlays/closures.json`, are loaded into the store, and
are applied by the cost function as an infinite penalty when active. They are
deliberately not baked into `build/graph.json` so that a construction update is a
one-line JSON edit and a redeploy, with no pipeline run.

## Store

`CampusStore` holds `Map<EntityId, Entity>`, an adjacency index, and a spatial
index (a simple uniform grid is sufficient at this scale) for
`nearestEdge(lon, lat)`. It exposes:

- `get(id)` / `require(id)` — identity
- `all(kind)` — enumeration
- `adjacency` — `Map<nodeId, {edgeId, otherNodeId, lengthM}[]>`
- `project*()` — GeoJSON for the map
- `subscribe(fn)` — change notification, **coalesced** (see below)

### Change notification

`emit()` must be batched with `queueMicrotask`. The prototype fired two separate
emits for a single user action (once when the route object was stored, once when
the session was patched), double-rendering every interaction. Wrap mutations in
`store.transaction(() => { ... })` and emit once at the end.

## What lives where

```
src/domain/
  types.ts      the five-ish kinds, all fields
  geo.ts        haversine, polyline length, point-to-segment projection
  store.ts      identity, indexes, projections
  route.ts      Dijkstra, cost function, leg generation
  session.ts    session object and its mutators
src/map/
  campus-map.tsx    MapLibre instance, sources, layers, event wiring
  layers.ts         layer definitions as data
src/ui/
  ...           picker, route card, settings
```

## Known drawbacks of this design

Stated honestly so nobody rediscovers them as surprises.

- **It is not a database.** In-memory maps hydrated from JSON. No persistence, no
  transactions across reloads, no multi-user. Fine for a single-device PWA;
  it becomes a rewrite if we ever add accounts or shared editing.
- **Projections can go stale.** Nothing enforces that a `setData` follows a
  mutation. Mitigation: the map subscribes to the store and re-projects the
  affected source, rather than setting sources once at load. The prototype set
  building, node, and edge sources once on `load` and never updated them.
- **Full re-projection on every change.** `projectBuildings()` walks every object
  each call. At 300 buildings and 5,000 edges this is fine. Above roughly 50,000
  objects it will need dirty-tracking.
- **Graph is loaded entirely into memory at boot.** A 25 km network is maybe
  1–2 MB of JSON, which is acceptable. A campus-wide indoor graph would not be.
