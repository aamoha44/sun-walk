# 03 — Graph pipeline

`scripts/build-graph.py` turns `sources/` + `overlays/` into `build/graph.json`.
It is deterministic: same inputs, byte-identical output. It is the only writer of
`build/`.

```
sources/                          overlays/
  ufrm-facilities.geojson           entrances.json
  ufrm-footprints.geojson           edge-overrides.json
  osm-tempe.pbf                     closures.json
  service-area.geojson              name-overrides.json
        │                                 │
        └────────────► build-graph.py ◄───┘
                            │
                            ▼
                    build/graph.json
                    build/footprints.geojson
                    build/manifest.json
                    build/report.md
```

## Stage 0 — Load and reject

Read sources. Apply the service-area polygon. Every feature that is dropped is
written to `build/rejected.json` with `{id, reason, coords}`. **Nothing is
dropped silently.** The report counts must reconcile:

```
fetched == kept + rejected
```

The builder exits non-zero if they do not.

## Stage 1 — Extract the raw line network

From the OSM extract, emit a list of ways, each a coordinate sequence plus tags.
Discard ways whose tags fail the filter in `02-data-sources.md` §2.

## Stage 2 — Noding

This is the stage that makes the network a graph rather than a pile of lines.

1. **Split at shared OSM nodes.** Every position that appears in two or more ways
   becomes a graph node, and both ways are split there.
2. **Split at geometric intersections.** Two ways can cross without sharing a
   node (common where a mall is mapped as one long way). Compute all segment
   intersections. At each, insert a node into both ways — **unless** the crossing
   is a bridge/tunnel pair, i.e. the ways have different `layer` values or one
   has `bridge=yes` / `tunnel=yes`. Grade separation is real; the University
   Drive pedestrian bridge is the obvious local case.
3. **Cluster near-coincident vertices.** Union-find over all candidate nodes with
   a 1.5 m linking radius. Each cluster becomes one node at the cluster centroid.
   Do this **before** assigning ids, not after; quantizing first would split two
   points 0.4 m apart across a grid boundary.
4. **Rebuild edges** from the split ways, with the clustered node ids as endpoints
   and the full intermediate coordinate sequence as `geometry`.

## Stage 3 — Cleanup

In order:

1. **Drop degree-1 stubs shorter than 8 m** unless an endpoint is an entrance
   node or a barrier. These are OSM driveway remnants and mapping noise.
2. **Collapse degree-2 chains** where both edges share identical routing
   attributes. Merge them into one polyline edge. This is what keeps edge count
   proportional to network complexity rather than to vertex count. Do **not**
   collapse across an entrance, crossing, or attribute change.
3. **Remove duplicate edges** between the same node pair where geometries are
   within 1 m of each other for their whole length; keep the one with more tags.
4. **Connected components.** Keep the largest. Write every dropped component to
   `build/report.md` with its node count, total length, and bounding box centre.
   A dropped component larger than 100 m of centerline is a **warning that must
   be reviewed**, not an acceptable outcome; it usually means a missing crossing.

## Stage 4 — Identity

Node ids are content-derived so that rebuilds are idempotent and overlays keyed
by node id survive regeneration.

```
def node_id(lon, lat):
    # quantize to a 0.5 m grid using WGS84 local scale at campus latitude
    gx = round(lon * M_LON_LOCAL / 0.5)
    gy = round(lat * M_LAT_LOCAL / 0.5)
    h  = blake2b(f"{gx}:{gy}".encode(), digest_size=6).digest()
    return "node:" + base32_lower(h)          # e.g. node:k7q2mf3xza
```

Edge ids hash the ordered pair of endpoint ids plus a hash of the rounded
geometry, so a geometry change produces a new id and any overlay referencing the
old id fails loudly:

```
edge_id = "edge:" + base32(blake2b(f"{min(a,b)}|{max(a,b)}|{geom_hash}"))
```

Building ids are `bldg:{BLDG_CODE}` with the duplicate policy from
`02-data-sources.md` §1.4.

**Never use positional ids.** The prototype used `node:palm-walk:7`; changing the
sampling step from 55 m silently reassigned the meaning of every id in the file.

## Stage 5 — Entrances

For each building in the service area, in descending gsf order:

1. **OSM entrances.** Collect nodes tagged `entrance=main|yes|service` that lie
   within the footprint or within 3 m of its boundary. `entrance=main` sorts
   first. These are `provisional: false`.
2. **Projection fallback.** If none found, for each walkway edge whose closest
   approach to the footprint is under 60 m, project the footprint boundary onto
   that edge and take the nearest boundary point as a candidate door. Keep up to
   3 candidates on distinct sides of the building. Mark `provisional: true`.
3. **No candidate within 60 m.** Retry at 120 m and mark
   `provisional: true, weak: true`. If still nothing, the building is
   `routable: false` with reason `no_walkway_within_120m`, and it appears in the
   report's work queue.
4. **Link edges.** Connect each entrance node to the network by **splitting the
   target edge at the projection point** and creating a `link` edge from the
   entrance to that new node.

Step 4 is the fix for the prototype's largest systematic error. It snapped each
building to the *nearest pre-existing sample point*, which was up to 27.5 m from
the true closest point on the path. Across 36 junction connectors that averaged
14 m of fictional walking each, and entrance connectors ran to a median of 30 m
and a maximum of 218 m.

Link edges get `surface` and `shadeIndex` inherited from the edge they attach to,
`accessible` unknown until ground-truthed.

## Stage 6 — Overlays

Applied last, after everything generated. Each overlay entry names the object id
it modifies. **If an id does not resolve, the build fails.** A silently ignored
overlay is worse than no overlay, because you believe the correction is live.

- `overlays/entrances.json` — add, move, delete, or promote entrances to
  `provisional: false`. This is the output of Phase-E walking.
- `overlays/edge-overrides.json` — set attributes (`stairs`, `shadeIndex`,
  `accessible`, `covered`), or `blocked: true` for permanent removals.
- `overlays/name-overrides.json` — display names. UFRM names are ALL CAPS and
  often internal (`BATEMAN PHYSICAL SCIENCES CENTER F`). This file maps codes to
  what students actually call the building. **Do not** solve this with a
  title-case function; the prototype's regex-based `titleCase` mangled acronyms
  and required special cases for `Bldg` and `ASU` that it then applied
  inconsistently.
- `overlays/closures.json` — loaded by the app at runtime, **not** baked into the
  graph, so a construction update is a JSON edit and a redeploy.

## Stage 7 — Costs and emit

Compute `lengthM` per edge as the haversine sum along its polyline. Compute
`shadeIndex` (see `05-routing-and-cost.md` §3). Emit:

- `build/graph.json` — manifest, nodes, edges, buildings. Validated against
   `graph.schema.json`.
- `build/footprints.geojson` — polygons, loaded separately by the map so the
  domain does not carry them.
- `build/manifest.json` — source SHAs, overlay SHAs, builder git rev, UTC
  timestamp, all counts, and a content hash of `graph.json`.
- `build/report.md` — human-readable: counts, dropped components, the provisional
  entrance work queue ordered by building size, and the route-quality table.

## Reproducibility

`build-graph.py --check` rebuilds into a temp dir and diffs against the committed
`build/manifest.json` content hash. CI runs this. If it differs, either an input
changed without the manifest being updated, or the builder is non-deterministic
(usually an unsorted dict iteration or a set that leaked into output order).
Sort everything before emitting.
