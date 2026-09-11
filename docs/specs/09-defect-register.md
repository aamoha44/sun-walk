# 09 — Defect register (prototype audit)

Measured findings from the discarded Phase-0 build, dated 2026-08-27. Every item
here is a real observed failure, not a hypothetical. Each maps to a gate, a spec
section, or a rule that now prevents it.

Prototype shape for context: 197 nodes (117 mall samples, 61 entrances,
19 junctions), 203 edges (106 mall, 97 connector), 277 buildings, one connected
component, no orphan nodes, every edge endpoint resolving. The structure was
fine. Everything below is about geometry, data hygiene, and process.

---

## Geometry

| # | Defect | Measurement | Prevented by |
|---|---|---|---|
| P-01 | Entire network was 11 hardcoded straight lines | 6,154 m of centerline, 5 N-S + 6 E-W, constant lat/lon each | `docs/03` (OSM-derived), gate C5 |
| P-02 | Mall centerlines pass through buildings | Within 2 m of the centroids of EDB, ENGRC, PSY, ART, ED, ISTB1, ISTB2, MU, PSF; within 6 m of COOR, LIB, NOBLE, PSYN, RBHL | **gate G3** |
| P-03 | Entrance nodes were building centroids, not doors | 61 of 61 | `docs/03` §5 |
| P-04 | Junctions attached to the nearest *sample*, not the true crossing point | 36 connector edges, mean 14.0 m, max 29.2 m, 504 m of fictional walking total | `docs/03` §2 (noding), §5.4 (split at projection) |
| P-05 | Entrance connectors ran absurdly long | median 30 m, p90 150 m, max 218 m (VDSJ) | gate G8 |
| P-06 | Detour ratio far above a grid baseline | median 1.50, p90 2.22, max 9.12 (Manhattan grid ≈ 1.27) | gates R1–R3 |
| P-07 | Graph covered only a 1,086 × 1,034 m box | MC buildings span ~2 × 2 km core plus remote sites to 11 km | D-003, gate G1 |

## Coverage

| # | Defect | Measurement | Prevented by |
|---|---|---|---|
| P-08 | Most buildings had no entrance and could not be routed | 61 of 277 routable (22%); 216 returned `null` | gate C1 |
| P-09 | Large buildings unreachable | 37 buildings ≥50k gsf were >220 m from the graph: USB 148k, SAF 137k, SCD 127k, VDDM 106k, VDSPS 490k, PS7 557k | gate C3 |
| P-10 | 23 buildings marked `featured` had no entrance node at all | picker showed 56 of 84 featured | gates C1, S3 |
| P-11 | Graph proximity was poor even in the core | 32% of buildings within 50 m, 42% within 100 m, 57% within 220 m | gate C2 |

## Data hygiene

| # | Defect | Measurement | Prevented by |
|---|---|---|---|
| P-12 | Three buildings at coordinates (0, 0) | `184`, `185`, `X96` — emitted to the map as dots at null island | gate G2, `docs/02` §1.1 |
| P-13 | 14 buildings silently lost to `dict[code] = row` | 291 fetched → 277 kept. 11 duplicate codes. STAD collapsed a 771,429 gsf record into a 56,466 gsf one | `docs/02` §1.4, gate S7 |
| P-14 | `FEATURED` whitelist contained nonexistent codes | `HLMK`, `LL` — silent no-ops. `HLMK` is one of the four codes the project brief tells you to spot-check | category from UFRM `Type`; gate S6 |
| P-15 | `featured = gsf >= 90000` swept in parking | PS1–PS8, RP01, RP02, VDSPS, then three name regexes to undo it | category from UFRM `Type` |
| P-16 | Flat-earth distance constants biased every length high | `M_LAT = 111320` is +0.37% vs WGS84 at 33.42°N; `M_LON = 93080` is +0.08% | `src/domain/geo.ts` haversine, gate G4 |
| P-17 | Building display names produced by regex title-casing | Required special cases for `Bldg` and `ASU`, applied inconsistently; UFRM names are internal ALL-CAPS strings anyway | `overlays/name-overrides.json` |

## Code

| # | Defect | Prevented by |
|---|---|---|
| P-18 | `if (!map.isStyleLoaded()) return` in the route effect silently dropped routes and never retried, because effect deps had not changed. Route correct in the store, absent from the screen | `docs/06` "the isStyleLoaded trap" |
| P-19 | `fitBounds` shared an effect with `session.showGraph`, so toggling the graph overlay re-framed the map | `docs/06` "camera control" |
| P-20 | `buildings`, `graph-nodes`, `graph-edges` sources were set once on `load` and never updated. Only `route` got `setData` | `docs/06` "sources" |
| P-21 | Every computed route was stored forever with no invalidation and no profile in the key | `docs/05` §8 |
| P-22 | One user action fired two store emits (route `put`, then session patch), double-rendering | `docs/01` "change notification" |
| P-23 | Dijkstra called `queue.sort()` on every pop, `O(E · V log V)` | `docs/05` §5, gate P3 |
| P-24 | `computeRoute` returned `null` for six distinct failure modes | `docs/05` §6 |
| P-25 | Basemap was a third-party free tile host, contradicting the committed PMTiles decision | D-004 |

## Process

| # | Defect | Prevented by |
|---|---|---|
| P-26 | **`validate-graph.py` read `data/graph/nodes.geojson` and `data/graph/edges.geojson`. Those paths did not exist.** The app loaded `data/graph-nodes.json`. The validator had never once run against real data and provided false confidence for the whole project | `docs/04` gate 0: validators import the app's loader |
| P-27 | `build-graph.py` raised `NotImplementedError` and was committed as if it were tooling | delete or implement, never both |
| P-28 | `seed-core-malls.py` hardcoded `/workspace/...` absolute paths | `AGENTS.md` hard rules |
| P-29 | `seed-core-malls.py` also wrote `buildings-catalog.json`, which its name does not suggest | `AGENTS.md` hard rules |
| P-30 | Two source-of-truth copies of the graph (`.json` for the app, `.geojson` for QGIS) written by one script with no sync check | single `build/graph.json`; GeoJSON derived on demand |
| P-31 | Graph described as "hand-curated" while also being script-generated. Any regeneration destroys the curation | `overlays/` |
| P-32 | No routing tests, no fixtures, no CI | `docs/04` CI wiring |

---

## The one-sentence version

The prototype's model was right and its data was invented. Nothing checked
whether the invented data resembled the campus, so nobody found out.
