# 06 — Map projection layer

MapLibre GL JS. The map is a **consumer**. It reads GeoJSON from
`store.project*()`, renders it, and forwards user gestures back as id-based
session mutations. It owns no data.

## Sources

| Source id | Produced by | Updated when |
|---|---|---|
| `buildings` | `store.projectBuildings()` | store change |
| `footprints` | `build/footprints.geojson`, fetched | once |
| `graph-edges` | `store.projectGraphEdges()` | store change |
| `graph-nodes` | `store.projectGraphNodes()` | store change |
| `route` | `store.projectRoute(activeRoute)` | session change |

**Every source subscribes to the store.** The prototype called `addSource` once
inside `map.on("load")` for buildings, nodes, and edges, and only ever called
`setData` on `route`. Any future change to a building or a closure would not have
appeared on screen, and the bug would have been mysterious.

Implementation: one `useEffect` that subscribes to `campusStore` and calls
`setData` on each source whose projection changed. Compare by projection content
hash, not by object identity, to avoid churn.

## The `isStyleLoaded` trap — read this before touching route rendering

Do **not** write:

```ts
if (!map?.isStyleLoaded() || !ready) return;   // WRONG
```

`isStyleLoaded()` returns `false` while any source or tile is still loading.
A route computed during that window is silently dropped, and because the effect's
dependencies have not changed, it never re-runs. The route is correct in the
store and absent from the screen. This was the prototype's most confusing bug and
it wasted real debugging time.

Correct pattern:

```ts
const pending = useRef<GeoJSON | null>(null);

function push(sourceId: string, data: GeoJSON) {
  const src = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (src) { src.setData(data); return; }
  pending.current = data;
  map.once("idle", () => { /* flush */ });
}
```

Or simpler: create all sources synchronously in the `style.load` handler, then
`setData` unconditionally afterwards. `setData` on an existing source is safe
regardless of tile-loading state.

## Camera control

`fitBounds` runs **only** when `session.activeRouteId` changes, and only when the
new route differs from the last one the camera framed. Keep it in its own effect
with `activeRouteId` as its sole dependency.

The prototype put `fitBounds` in an effect that also depended on
`session.showGraph`, so toggling the graph overlay re-framed the map underneath
the user.

Never `fitBounds` on a projection containing a `(0, 0)` coordinate. Gate G2 in
`04-validation-gates.md` should make this impossible, but the camera code
should also refuse bounds spanning more than 5 km and log instead.

## Layers

Defined as data in `src/map/layers.ts`, in this paint order:

1. `footprints-fill` — building polygons, low opacity, below everything
2. `graph-edges` — thin, `visibility` toggled by `session.showGraph`
3. `route-line-casing` — wide, light
4. `route-line` — ASU maroon `#8C1D40`, round cap and join
5. `buildings-dot` — circle, radius by category
6. `entrance-dot` — visible only at zoom ≥ 17, distinguishes provisional
7. `building-labels` — symbol, `text-field` from `displayName`, minzoom 15.4

Fonts must exist in the style's glyph set. `Noto Sans Regular` is present in the
OpenFreeMap Liberty style; verify again when moving to self-hosted PMTiles,
because glyph availability is a property of the tile bundle, not of MapLibre.

## Interaction

- Click `buildings-dot` or `footprints-fill` → `selectObject(id)`
- Click `route-line` → nothing (routes are not selectable)
- `GeolocateControl` with `trackUserLocation: true`
- `NavigationControl` with `visualizePitch: true`
- Heading-up rotation via DeviceOrientation is **progressive enhancement only**.
  North-up must always work. iOS permission behaviour is inconsistent and must
  never block the core flow.

## Cleanup

The map effect must be safe under React 18 StrictMode double-mounting: guard on a
ref, `map.remove()` in cleanup, null the ref, disconnect the `ResizeObserver`,
and reset the `ready` flag.

## Basemap

Dev: OpenFreeMap Liberty.
Production: self-hosted PMTiles extract. (basemap self-hosting timing was an open question during early development).
Do not soft-launch on a third-party free tile host.
