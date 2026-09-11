# 02 — Data sources

Everything in `sources/` is pulled by a script, recorded in
`sources/manifest.json`, and never hand-edited. Corrections go in `overlays/`.

## Manifest format

`sources/manifest.json`:

```json
{
  "generated": "2026-08-27T18:00:00Z",
  "entries": [
    {
      "file": "ufrm-footprints.geojson",
      "url": "https://services5.arcgis.com/.../FeatureServer/0/query",
      "params": { "where": "1=1", "geometry": "...", "outSR": "4326" },
      "fetched": "2026-08-27T17:58:12Z",
      "sha256": "…",
      "featureCount": 291,
      "license": "ASU UFRM",
      "notes": "Layer reports Data Last Edit Date 2021-08-19; see §1.3"
    }
  ]
}
```

The builder writes the manifest's `sha256` values into the build manifest so any
`build/graph.json` can be traced to exact inputs.

---

## 1. ASU UFRM ArcGIS FeatureServer

Service root:
`https://services5.arcgis.com/aYs2RC3pluEvAuE3/arcgis/rest/services/CampusBuilding/FeatureServer`

Copyright: ASU University Facility Records Management (UFRM). Internal
university data published without an explicit open license. Treat as
"use permitted, redistribution unclear" — see D-002.

### 1.1 Layer 10 — `ASU Facilities` (points)

- Geometry: `esriGeometryPoint`, building centroids
- Filter: `BLDG_CAMPUS_CODE='MC'` → 291 features
- Fields used: `BLDG_CODE`, `BLDG_NAME`, `BLDG_NUMBER`, `BLDG_CAMPUS_CODE`,
  `BLDG_ADDRESS`, `BLDG_GSF`, `BLDG_HEIGHT_FT`, `BLDG_MAP_NUMBER`,
  `ExtractDateTime`, `EditDate`
- `maxRecordCount` is 2000, so one request covers MC. Do not assume this for
  future all-campus queries; implement `resultOffset` paging anyway.

**Known dirt in this layer, which the fetcher must handle explicitly:**

- Three features have coordinates `(0, 0)`: `184` (Recreation Storage Building),
  `185` (Multipurpose Arena), `X96` (University Drive Pedestrian Bridge). The
  layer's own declared extent is `XMin -118.49, YMin 0, XMax 0, YMax 38.90`,
  confirming the nulls are upstream. Drop them into
  `sources/rejected-features.json` with a reason. Do not silently filter.
- **`BLDG_CODE` is not unique.** 11 codes repeat across 14 extra features:
  `INTDSA`×2, `IRISH`×3, `MB`×3, `MSHAL`×2, `PABLO`×2, `PSC`×2, `SCOB`×2,
  `STAD`×2, `STAUF`×2, `TOWER`×2, `X80`×3. Some are genuine multi-wing
  facilities with different gsf (MB: 18,835 / 19,300 / 48,188). `STAD` pairs a
  771,429 gsf record with a 56,466 gsf record roughly 100 m apart. Resolution
  policy is in §1.4.

### 1.2 Layer 0 — `Building` (polygons) — **use this, the prototype did not**

- Geometry: `esriGeometryPolygon` — actual footprints
- Fields: `BLDG_CODE`, `BLDG_NAME`, `BLDG_NUMBER`, `BLDG_ADDRESS`, `Type`,
  `Description`, `map_name`, **`Image`**, `Shape__Area`, `Shape__Length`
- **No `BLDG_CAMPUS_CODE` field.** You cannot filter by campus. Filter by
  envelope (`geometryType=esriGeometryEnvelope`, `inSR=4326`,
  `spatialRel=esriSpatialRelIntersects`) over the service-area bbox, then join
  to layer 10 on `BLDG_CODE` and keep only codes present in the MC set.
- The declared extent spans `-114.32 … -111.08`, `33.29 … 34.47`, so a
  bbox filter is mandatory or you will pull other campuses and remote sites.

Why footprints matter:
- Entrances can be placed **on a boundary** instead of at a centroid.
- The "does this edge cut through a building" validator becomes possible. That
  single check would have caught the prototype's malls running through Hayden
  Library, the MU, Payne Hall, ISTB1, and eleven others.
- `Type` gives real categories (Academic / Housing / Athletics / Library /
  Student Services / Research / Administrative), replacing the gsf heuristic.
- `Image` gives building photos, which is exactly the asset the Phase-F
  "familiarity cue" feature needs. Verify the URLs resolve before depending on it.

### 1.3 Freshness

Both layer 0 and layer 10 report `Data Last Edit Date: 8/19/2021` in service
metadata, while layer 10's description claims the source "updates GIS nightly"
from UFRM CAD. These contradict each other. Evidence suggests per-feature data is
newer than the service metadata: `ISTB7` is present in the MC extract despite
opening after 2021.

**Task for the fetcher:** record `min`, `max`, and `p50` of `EditDate` and
`ExtractDateTime` across fetched features into the manifest. Then spot-check
three buildings known to be recent against reality. Do not assume the data is
current, and do not assume it is stale.

### 1.4 Duplicate-code resolution policy

Implemented in `scripts/fetch-ufrm.py`, output to
`sources/ufrm-duplicates.json` for review:

1. If duplicates are >150 m apart, they are separate facilities. Emit both as
   `bldg:{CODE}` and `bldg:{CODE}#2`, `#3`, ordered by descending `BLDG_GSF`.
   Record the split in the duplicates file.
2. If within 150 m, treat as wings of one facility. Keep the largest-gsf record
   as the primary, sum the gsf, and retain the others' centroids as additional
   entrance-search anchors.
3. Never `dict[code] = row`. The build must **fail** if the final building count
   plus the rejected count does not equal the fetched feature count.

### 1.5 Supplementary building footprints — City of Tempe open GIS (T-012.1)

`sources/asu-campus-buildings.geojson` supplies footprint polygons for buildings
that UFRM layer 0 (§1.2) does not carry. It is **subordinate to §1**: UFRM stays
the authority for every building record, name, address, gsf, photo, and category.
This file only fills footprint gaps.

- **Provenance.** City of Tempe open GIS / open data (attribution requested — not
  ODbL, not the UFRM redistribution question of D-002). The owner pulled a
  Tempe-wide building layer from the City portal and extracted the ASU Tempe
  campus polygons by hand. Because it was hand-extracted, it is **not** fetched
  by a script the way the rest of `sources/` is — the delivered file even had
  three stray bytes (`sor`) before the first `{`. `scripts/normalize-campus-buildings.py`
  is the recorded exception to "never hand-edited": it takes the hand file as
  `--in` (a hand-extracted GeoJSON export), strips leading junk,
  validates, joins, canonicalizes, and writes the committed `sources/` file plus
  its `manifest.json` entry. Re-running it is idempotent and byte-stable.
- **Join rule.** A feature is kept only if its `BLDG_CODE` is in the MC set — the
  `_role="primary"` codes in `sources/ufrm-points.geojson`. Non-MC codes go to
  `sources/rejected-campus-buildings.json`. ~203 features / ~191 distinct codes
  survive the join.
- **NOT a superset.** It gains **~29** codes UFRM layer 0 lacks, but it is
  missing **42** codes UFRM has — every Vista del Sol (`VDSB…VDSPS`, `VVDS`,
  `VDSGAZ`, `VDSTC`, `VDSDM`), every Adelphi (`ADELA/B/C/E/S`, `ADEMF`,
  `ADENE/W`, `ADESW`), plus `128H BDC CAVC CPS MRBLA MSB PS6 PS8 PSHED SCD SONX
  UNIVT USB X39 X128D ASUPD`. A naive replace would regress an entire residence
  district to proxy squares. Hence **merge, UFRM layer 0 wins every tie**
  (`stage5_entrances._load_buildings` loads `ufrm:0` first with
  `dict.setdefault`, then `campus:0`).
- **`footprint_src = 'campus'`.** A footprint sourced from this file is tagged
  `'campus'` (vs `'ufrm'` / `'proxy'` / `'none'`). It is **real geometry** — it
  is subject to gate G3, interior-spur drop, and shade adjacency exactly like a
  `'ufrm'` footprint. Only `'proxy'` is excluded from those.
- **`Type` is a coarse auto-fill, not an authority.** Every feature is typed but
  "Academic" is a 118-row catch-all; of 162 codes shared with UFRM, 83 disagree
  and several are regressions. It is used **only to fill** a category when UFRM's
  `Type` is absent or generic — it never overrides a specific UFRM `Type`.
- **`Image` is always null** — no building photos here; UFRM keeps its 131.
- **`BLDG_NAME`** (Title Case, and inconsistent — `"Hav- Acacia Hall"`,
  lowercase `"At"`) is retained in `properties` but the builder never reads it.
  `official_name` / `display_name` stay the UFRM value; nicer defaults are a
  separate `overlays/name-overrides.json` ticket.
- **`Shape__Area`** is in degrees² and unused — `stage5_entrances._make_footprint`
  recomputes area with `ST_Area(geom, 1)`.
- **Shade canopies filtered.** Polygons whose name matches
  `\b(SOLAR|CANOPY|INFRASTRUCTURE)\b` (9 features — `077X` "Tempe Campus
  Infrastructure", the Cady/Orange Mall solar arrays, parking-lot canopies) are
  **not** enclosed footprints — pedestrians route under and through them, which
  is the whole point of Sun Walk. They are dropped to the rejected file; those
  codes fall back to proxy/`none` and stay G3-safe.

Combined UFRM + City-of-Tempe footprint coverage is **84.7 %** (was 74.2 % under
D-006); the proxy/`none` count drops from ~70 to ~42. See
`sources/footprint-coverage.json` (`combined` block, written by
`scripts/footprint-coverage.py --supplemental`).

---

## 2. OpenStreetMap — pedestrian geometry

This is the source of the actual walkable network.

**Licensing (D-001, resolved 2026-08-28 — option A): accept ODbL.** The derived
graph ships under ODbL 1.0 (contents under DbCL 1.0) with "© OpenStreetMap
contributors" attribution in the map UI and in `/NOTICE`. UFRM building
attributes stay in separate files so the licences do not mix. `fetch-osm.py`
writes the licence string into `sources/manifest.json`.

### Extract

Clip to the service-area polygon (`sources/service-area.geojson`, see §4).
Preferred: a Geofabrik Arizona `.osm.pbf` clipped with `osmium extract`, so the
pull is reproducible and version-pinned. Overpass is acceptable for iteration but
its results are not reproducible over time; if you use it, record the query and
the `@timestamp` of the OSM data in the manifest.

### Ways to keep

```
highway = footway | path | steps | pedestrian | corridor | living_street
highway = service   AND foot != no
highway = residential | tertiary   ONLY where sidewalk=* is absent and foot=yes
```

### Also keep

- Nodes: `highway=crossing` (with `crossing=traffic_signals|marked|unmarked`),
  `entrance=*`, `barrier=gate|bollard|kerb`, `highway=elevator`
- Ways: `area:highway=footway` (plaza polygons — see §2.1)

### Tags to carry onto edges

`surface`, `smoothness`, `incline`, `covered`, `tunnel`, `bridge`, `layer`,
`indoor`, `width`, `wheelchair`, `access`, `foot`, `lit`, `handrail`,
`step_count`.

`bridge` and `layer` are required by the noding stage (`03-graph-pipeline.md`
§2.2): two ways that only cross in plan view must **not** be noded together when
they are grade-separated. Added 2026-08-28 (T-021) — the earlier list omitted
them, which contradicted §3.2.2.

### 2.1 Plazas

`area:highway=footway` and pedestrian areas are polygons, not lines. A router
cannot traverse a polygon. Policy for Phase C: skeletonize each plaza to a
straight edge between every pair of its boundary connection points, capped at 8
connection points to avoid a combinatorial blow-up, and mark those edges
`synthetic: true`. This is a known approximation. The MU forecourt and Hayden
Lawn are the cases that matter.

### 2.2 Expected quality

ASU Tempe is well mapped in OSM but not uniformly. Expect to find:
- Missing sidewalk segments on the campus perimeter
- Footways that end at a building wall with no `entrance` node
- Malls mapped as a single long way with no intersection nodes at crossings

The last one is why noding (`03-graph-pipeline.md` §2) is mandatory and not
optional. Two ways that visually cross but share no node are not connected.

---

## 3. Basemap

Development: `https://tiles.openfreemap.org/styles/liberty`.
Before any user-facing launch: a self-hosted PMTiles extract of the Tempe area,
served from R2 or equivalent with HTTP range requests. See D-004.

Reasons the third-party style cannot ship: no offline path, no control over
label layers competing with ours, no SLA. A free tile host being down during
orientation week is a launch-ending failure with no mitigation.

## 4. Service area

`sources/service-area.geojson` is a hand-drawn polygon, committed, and is an
**input**, not an output. It defines:
- the OSM clip boundary
- the ArcGIS envelope filter for layer 0
- the coordinate-bounds validator
- which buildings are marked `routable`

Provisional extent (see D-003): the core campus bounded by University Dr,
Rural Rd, Apache Blvd, and Mill Ave, plus a corridor south to Vista del Sol and
north to Sun Devil Stadium. Everything outside, including Research Park roughly
11 km east, is `outOfServiceArea` and the UI says so explicitly.

For reference, the prototype's graph covered a 1,086 × 1,034 m box, while MC
buildings span roughly 2.0 × 2.0 km even excluding remote sites.
