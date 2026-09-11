# Contributing to Sun Walk

Sun Walk is a pedestrian navigation app for the ASU Tempe campus. This file
is the engineering contract: the rules that keep the graph trustworthy across
a builder pipeline, a domain layer, and a growing set of hand-authored
corrections.

Before changing anything under `scripts/build/` or `src/domain/`, read the
relevant spec in `docs/` — the code is younger than the spec and may be
wrong; don't infer the design from what's already written.

## Hard rules

### Layering
- `src/domain/**` must not import `maplibre-gl`, `react`, or anything from
  `src/map/**` or `src/ui/**`. It must run under plain `node --test`.
- `src/map/**` reads from the store via `project*()` methods only. It never
  mutates domain objects. It never computes distances or paths.
- `src/ui/**` mutates session by calling the functions in `src/domain/session.ts`,
  which set **ids only**. No object copies in session state, ever.

### Data directories
- `sources/` — written only by `scripts/fetch-*.py`. Read-only to everything else.
  Committed to git. Each file has an entry in `sources/manifest.json` with URL,
  query, fetch timestamp, and SHA-256.
- `overlays/` — hand-authored JSON. Committed. This is the only place a human
  corrects data.
- `build/` — written only by `scripts/build-graph.py`. In `.gitignore`.
  **If you are about to edit a file under `build/`, you are doing the wrong
  thing.** Fix the builder or write an overlay.

### Units and coordinates
- Distances: meters, float, field name ends in `M` (`lengthM`, `snapM`).
- Coordinates: `[longitude, latitude]`, WGS84 (EPSG:4326), 6 decimal places.
- Distance function: haversine on R = 6,371,008.8 m. Import it from
  `src/domain/geo.ts`. **Do not write flat-earth `meters-per-degree` constants.**
  The previous prototype used `M_LAT = 111320` and `M_LON = 93080`, which are
  0.37% and 0.08% high at this latitude and silently inflated every length.
- Time: ISO 8601, UTC, in all metadata. Local time (America/Phoenix, no DST)
  only in user-facing strings.

### Identity
- Every domain object has a stable `id` and a `kind`. See `src/domain/types.ts`.
- References between objects are **ids, never embedded copies**. If you find
  yourself writing `route.fromBuilding = building`, stop; it is
  `route.fromBuildingId`.
- Node and edge ids are content-derived (see `docs/specs/03-graph-pipeline.md` §4).
  Never introduce a positional id like `node:palm-walk:7`. The previous
  prototype did, and changing the sampling step silently reassigned every id.

### Testing
- Any change to `src/domain/route.ts` or `scripts/build-graph.py` requires the
  route-quality report (`scripts/route-report.py`) to be regenerated and the
  diff included in the PR description.
- Routing tests run against a frozen fixture in `tests/fixtures/`, not against
  `build/graph.json`. Otherwise a graph rebuild breaks unrelated tests.

## Definition of done for any change

- [ ] `npm run typecheck` clean, no `any`, no `@ts-expect-error` without a comment
- [ ] `python scripts/validate-graph.py` exits 0 (if the change touches data)
- [ ] New behaviour has a test; the test fails without the change
- [ ] No new file under `build/` is committed

## Things that will get a PR rejected

- A validator that reads a path the application does not load. The previous
  prototype's `validate-graph.py` checked `data/graph/nodes.geojson` while the
  app loaded `data/graph-nodes.json`. It had never once run against real data
  and gave false confidence for the entire project.
- A dict/Map keyed by a field that is not unique. `BLDG_CODE` has **11 duplicate
  values** in the UFRM source. `by_code[code] = row` silently dropped 14
  buildings, including collapsing Sun Devil Stadium's 771,429 gsf record into a
  56,466 gsf one.
- A script with hardcoded absolute paths (`/workspace/...`). Use paths relative
  to the repo root, resolved from `__file__`.
- A script whose name does not describe everything it writes.
- Two files that are both the source of truth for the same data.
- Silent `return null` on an unroutable request. Return a typed failure with a
  reason the UI can show. See `docs/specs/05-routing-and-cost.md` §6.
