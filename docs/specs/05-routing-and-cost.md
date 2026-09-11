# 05 — Routing and cost

## 1. Separation of concerns

`lengthM` is geometry. It never changes based on preference.
`costOf(edge, profile, now)` is policy. It is the only thing Dijkstra minimizes.

Keeping these apart is why shade routing, accessibility routing, and closures can
all be added without touching the graph.

## 2. Profile

```ts
type Profile = {
  id: string;              // stable, hashed into route ids
  walkSpeedMps: number;    // default 1.35
  avoidStairs: boolean;    // default false
  requireAccessible: boolean;
  shadeWeight: number;     // 0 = ignore shade, 1 = strongly prefer shade
  crossingPenaltySec: number; // default 20 for unsignalized, 45 signalized
};
```

Default profile id: `walk-default`. Accessible profile: `walk-accessible`
(`requireAccessible: true`, `avoidStairs: true`).

## 3. Cost function

```
cost(edge) = timeSeconds(edge) × multiplier(edge)

timeSeconds(edge) = edge.lengthM / (profile.walkSpeedMps × surfaceFactor(edge))
                  + stairsPenalty(edge)
                  + crossingPenalty(edge)

multiplier(edge)  = 1 + profile.shadeWeight × (1 - edge.shadeIndex) × heatFactor(now)
```

- `surfaceFactor`: paved 1.0, gravel 0.9, grass 0.85, sand 0.7, unknown 0.95
- `stairsPenalty`: `step_count × 0.9 s`, or 12 s if step count is unknown.
  If `profile.avoidStairs`, multiply the whole edge cost by 4 instead of
  excluding it, so a stairs-only building is still reachable rather than
  unroutable.
- `requireAccessible: true` excludes `stairs: true` and `accessible: false` edges
  outright. If that disconnects the destination, return a typed failure with
  reason `no_accessible_route`, **not** `null`.
- `crossingPenalty`: applied at `crossing` nodes, folded into the incoming edge.
- `heatFactor(now)`: 0 when `shadeWeight` is 0. Otherwise a function of local
  time and month, 0 at night and in winter, up to 1.0 at 13:00–17:00
  May–September. America/Phoenix, no DST.

Cost is **time**, not distance, so the UI's ETA and the optimization target are
the same quantity.

## 4. shadeIndex

A per-edge float in `[0, 1]`, 1 = fully shaded.

Phase C initial assignment, deliberately crude:
- `covered=yes` / `tunnel=yes` / `indoor=yes` → 1.0
- Within 6 m of a mapped tree row or `natural=tree_row` → 0.7
- Within 8 m of a building footprint on the south/east side → 0.5
- Otherwise → 0.15

This is a placeholder. The honest version needs either a canopy raster or manual
survey, and it should be treated as a Phase-F project, not something to fake
precision on. Store the assignment method per edge as
`shadeSource: "covered" | "treerow" | "adjacency" | "default" | "survey"` so the
UI can avoid overclaiming and so a later survey can replace only the defaults.

## 5. Algorithm

Dijkstra with a **binary heap**, over `store.adjacency`. A* with a haversine
heuristic is a valid optimization later; do not start there, because the shade
multiplier makes the heuristic non-admissible unless you scale it by the minimum
possible multiplier.

Origin and destination are **buildings**, not nodes. Resolution:

1. Take all `entranceIds` of the origin building. Seed the priority queue with
   all of them at cost 0. Same for the destination as a multi-target search.
   This makes "which door" an outcome of the search rather than an assumption.
2. The chosen entrance is reported in the route so the UI can say
   "enter through the north door".

## 6. Failure is typed, never null

```ts
type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: RouteFailure; detail?: string };

type RouteFailure =
  | "unknown_building"
  | "same_building"
  | "no_entrance"           // building has no entrance node at all
  | "out_of_service_area"
  | "no_accessible_route"   // reachable, but not under this profile
  | "disconnected";         // graph gap; this is a data bug, log it
```

The prototype returned `null` for all of these. The UI rendered nothing and the
student had no idea whether they had mistyped, whether the app was broken, or
whether the building genuinely could not be reached. 216 of 277 buildings hit
this path.

Every `disconnected` result in production is a graph defect and should be
reported through the feedback channel automatically.

## 7. Legs and instructions

A route carries `legs[]`, each `{ edgeIds, instruction, distanceM, bearing }`.
Leg boundaries occur where the bearing changes by more than 35°, at a named-path
change, at a crossing, and at the final entrance.

Instruction text is generated from edge `name` where present ("Continue along
Palm Walk"), and from bearing otherwise ("Head northeast for 60 m"). Named paths
matter more than turn counts on a campus; students navigate by mall names.

## 8. Caching

Routes are cached in the store keyed by `{fromId, toId, profileId, hourBucket}`.
`hourBucket` is needed because `heatFactor` is time-dependent. The whole cache is
**cleared** on any graph reload or overlay change. The prototype cached routes
forever under `route:{FROM}->{TO}` with no invalidation and no profile in the key.

## 9. What is deliberately not here

- Turn-by-turn re-routing from live GPS. Phase F.
- Multi-stop / schedule chaining. Phase F.
- Indoor traversal through buildings as shortcuts. Requires indoor data; the
  MU and Hayden Library cut-throughs are genuinely useful and genuinely
  unavailable as data. Do not fake them.
