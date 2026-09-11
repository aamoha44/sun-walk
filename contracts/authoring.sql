-- =====================================================================
-- Sun Walk — authoring database (Tier 1)
--
-- SQLite + SpatiaLite. Regenerated from sources/ + overlays/ by
-- scripts/build-graph.py. NEVER migrated, NEVER hand-edited, gitignored.
-- If you need a schema change, change this file and rebuild.
--
-- Bootstrap (scripts/lib/db.py must do all of this on every connection):
--   con.enable_load_extension(True)
--   con.execute("SELECT load_extension('mod_spatialite')")
--   con.execute("PRAGMA foreign_keys = ON")        -- OFF BY DEFAULT. K-03.
--   con.execute("PRAGMA journal_mode = WAL")
--   con.execute("SELECT InitSpatialMetaData(1)")   -- fresh file only
--
-- Geometry is EPSG:4326 throughout. Every length/area call must pass the
-- geodesic flag: ST_Length(geom, true). Without it you get degrees. K-04.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PROVENANCE
-- ---------------------------------------------------------------------

-- Every fetched upstream feature, INCLUDING rejected ones. This table is
-- what makes gate S7 (fetched == kept + rejected) checkable in SQL rather
-- than by trusting a script's counters.
CREATE TABLE source_feature (
    source_feature_id INTEGER PRIMARY KEY,
    source            TEXT    NOT NULL,      -- 'ufrm:0' | 'ufrm:10' | 'osm'
    upstream_id       TEXT    NOT NULL,      -- OBJECTID, or 'way/123456'
    raw_json          TEXT    NOT NULL,      -- verbatim, for forensics
    kept              INTEGER NOT NULL,      -- 0/1
    reject_reason     TEXT,                  -- NULL iff kept = 1
    fetched_utc       TEXT    NOT NULL,

    UNIQUE (source, upstream_id),
    CHECK (kept IN (0, 1)),
    CHECK ((kept = 1 AND reject_reason IS NULL)
        OR (kept = 0 AND reject_reason IS NOT NULL))
);
CREATE INDEX ix_source_feature_reject ON source_feature (source, kept, reject_reason);

-- One row per build. build_hash is the content hash of the exported graph
-- and is the join key for everything downstream, including Route.graphHash
-- on the client.
CREATE TABLE build (
    build_hash    TEXT PRIMARY KEY,
    generated_utc TEXT NOT NULL,
    git_rev       TEXT NOT NULL,
    builder_ver   TEXT NOT NULL,
    CHECK (length(build_hash) BETWEEN 16 AND 64)
);

CREATE TABLE build_input (
    build_hash TEXT NOT NULL REFERENCES build(build_hash) ON DELETE CASCADE,
    path       TEXT NOT NULL,               -- 'sources/osm-tempe.pbf'
    sha256     TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    PRIMARY KEY (build_hash, path),
    CHECK (length(sha256) = 64)
);

-- Every number from 04-validation-gates.md, per build, so quality is
-- a time series instead of a snapshot.
CREATE TABLE build_metric (
    build_hash TEXT NOT NULL REFERENCES build(build_hash) ON DELETE CASCADE,
    metric     TEXT NOT NULL,               -- 'detour_p90' | 'coverage_50m' | ...
    value      REAL NOT NULL,
    gate       TEXT,                        -- 'R2' | 'C2' | NULL if informational
    passed     INTEGER,                     -- 0/1/NULL
    PRIMARY KEY (build_hash, metric),
    CHECK (passed IS NULL OR passed IN (0, 1))
);


-- ---------------------------------------------------------------------
-- 2. BUILDINGS
-- ---------------------------------------------------------------------

-- PK is the natural id. UNIQUE (code, ordinal) is what handles the 11
-- duplicate BLDG_CODE values in UFRM without losing 14 buildings. K-01.
-- ordinal = 0 is primary; splits are #1, #2, assigned by descending gsf
-- so the assignment is deterministic across rebuilds.
CREATE TABLE building (
    building_id     TEXT PRIMARY KEY,        -- 'bldg:MU' | 'bldg:STAD#1'
    code            TEXT    NOT NULL,
    ordinal         INTEGER NOT NULL DEFAULT 0,
    official_name   TEXT    NOT NULL,        -- UFRM ALL CAPS, never displayed
    display_name    TEXT    NOT NULL,        -- from overlays/name-overrides.json
    category        TEXT    NOT NULL,
    footprint_id    INTEGER REFERENCES footprint(footprint_id),
    footprint_src   TEXT    NOT NULL,        -- 'ufrm' | 'campus' | 'proxy' | 'none'
    gsf             INTEGER,
    address         TEXT,
    image_url       TEXT,
    in_service_area INTEGER NOT NULL,
    routable        INTEGER NOT NULL,
    unroutable_why  TEXT,

    UNIQUE (code, ordinal),
    CHECK (ordinal >= 0),
    CHECK (category IN ('academic','administrative','athletics','fine-arts',
                        'housing','library','research','student-services',
                        'parking','support','unknown')),
    CHECK (footprint_src IN ('ufrm','campus','proxy','none')),
    CHECK (in_service_area IN (0,1)),
    CHECK (routable IN (0,1)),
    CHECK (gsf IS NULL OR gsf >= 0),
    -- routable buildings must have a reason of NULL; unroutable must explain
    CHECK ((routable = 1 AND unroutable_why IS NULL)
        OR (routable = 0 AND unroutable_why IS NOT NULL))
);
SELECT AddGeometryColumn('building', 'centroid', 4326, 'POINT', 'XY');
SELECT CreateSpatialIndex('building', 'centroid');
CREATE INDEX ix_building_code     ON building (code);
CREATE INDEX ix_building_routable ON building (routable, category);

-- Search synonyms. "Memorial Union" / "the MU" / "MU" all resolve to bldg:MU.
CREATE TABLE building_alias (
    building_id TEXT NOT NULL REFERENCES building(building_id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    alias_norm  TEXT NOT NULL,               -- lowercase, unaccented, no punctuation
    source      TEXT NOT NULL,               -- 'ufrm' | 'overlay' | 'osm'
    PRIMARY KEY (building_id, alias_norm)
);
CREATE INDEX ix_alias_norm ON building_alias (alias_norm);

CREATE TABLE footprint (
    footprint_id INTEGER PRIMARY KEY,
    code         TEXT NOT NULL,
    area_m2      REAL NOT NULL
);
SELECT AddGeometryColumn('footprint', 'geom', 4326, 'POLYGON', 'XY');
SELECT CreateSpatialIndex('footprint', 'geom');
CREATE INDEX ix_footprint_code ON footprint (code);


-- ---------------------------------------------------------------------
-- 3. GRAPH
-- ---------------------------------------------------------------------

-- node_id is content-derived from a 0.5 m grid cell (03-graph-pipeline.md §4) so
-- rebuilds are idempotent. idx is the dense 0..V-1 surrogate assigned at
-- export time in Hilbert order, for CSR cache locality. idx is meaningless
-- outside a single build and MUST NOT appear in any overlay.
CREATE TABLE node (
    node_id     TEXT PRIMARY KEY,            -- 'node:k7q2mf3xza'
    idx         INTEGER UNIQUE,              -- assigned by export-runtime.py
    type        TEXT NOT NULL,               -- 'walkway' | 'entrance' | 'crossing'
    label       TEXT,                        -- debug only
    osm_node_id INTEGER,                     -- provenance + overlay anchoring
    -- entrance only
    building_id TEXT REFERENCES building(building_id) ON DELETE CASCADE,
    provisional INTEGER,
    weak        INTEGER,
    entrance_nm TEXT,
    -- crossing only
    signalized  INTEGER,
    cross_kind  TEXT,

    CHECK (type IN ('walkway','entrance','crossing')),
    CHECK (type <> 'entrance' OR (building_id IS NOT NULL AND provisional IS NOT NULL)),
    CHECK (type <> 'crossing' OR signalized IS NOT NULL),
    CHECK (type =  'entrance' OR building_id IS NULL),
    CHECK (provisional IS NULL OR provisional IN (0,1)),
    CHECK (weak        IS NULL OR weak        IN (0,1)),
    CHECK (signalized  IS NULL OR signalized  IN (0,1)),
    CHECK (cross_kind  IS NULL OR cross_kind IN ('traffic_signals','marked','unmarked'))
);
SELECT AddGeometryColumn('node', 'geom', 4326, 'POINT', 'XY');
SELECT CreateSpatialIndex('node', 'geom');
CREATE INDEX ix_node_type     ON node (type);
CREATE INDEX ix_node_building ON node (building_id) WHERE building_id IS NOT NULL;
CREATE INDEX ix_node_osm      ON node (osm_node_id) WHERE osm_node_id IS NOT NULL;

-- Undirected. CHECK (from < to) canonicalizes so (a,b) and (b,a) cannot
-- both exist. `ord` disambiguates parallel edges between the same pair
-- (divided walkways around a planter), sorted by ascending length_m.
--
-- edge_id hashes ONLY (from, to, ord) — NOT the geometry. Hashing the
-- geometry would change the id on any vertex nudge and break every overlay
-- pointing at it. Revised from 03-graph-pipeline.md §4; see 08-decisions.md.
CREATE TABLE edge (
    edge_id      TEXT PRIMARY KEY,           -- 'edge:m3p8qw2vzt'
    idx          INTEGER UNIQUE,             -- dense, export-time only
    from_node_id TEXT NOT NULL REFERENCES node(node_id) ON DELETE RESTRICT,
    to_node_id   TEXT NOT NULL REFERENCES node(node_id) ON DELETE RESTRICT,
    ord          INTEGER NOT NULL DEFAULT 0,
    type         TEXT NOT NULL,
    name         TEXT,
    length_m     REAL NOT NULL,
    surface      TEXT NOT NULL,
    stairs       INTEGER NOT NULL DEFAULT 0,
    step_count   INTEGER,
    covered      INTEGER NOT NULL DEFAULT 0,
    indoor       INTEGER NOT NULL DEFAULT 0,
    tunnel       INTEGER NOT NULL DEFAULT 0,
    bridge       INTEGER NOT NULL DEFAULT 0,
    layer        INTEGER NOT NULL DEFAULT 0, -- grade separation; see 03-graph-pipeline.md §2.2
    accessible   INTEGER,                    -- NULL = unknown. K-17.
    shade_index  REAL NOT NULL,
    shade_source TEXT NOT NULL,
    synthetic    INTEGER NOT NULL DEFAULT 0,
    osm_way_id   INTEGER,

    UNIQUE (from_node_id, to_node_id, ord),
    CHECK (from_node_id < to_node_id),
    CHECK (from_node_id <> to_node_id),
    CHECK (length_m > 0 AND length_m < 2000),
    CHECK (shade_index BETWEEN 0 AND 1),
    CHECK (type    IN ('path','steps','crossing','link','plaza','indoor')),
    CHECK (surface IN ('paved','concrete','asphalt','gravel','grass','sand','unknown')),
    CHECK (shade_source IN ('survey','covered','treerow','adjacency','default')),
    CHECK (stairs IN (0,1) AND covered IN (0,1) AND indoor IN (0,1)
       AND tunnel IN (0,1) AND bridge  IN (0,1) AND synthetic IN (0,1)),
    CHECK (accessible IS NULL OR accessible IN (0,1)),
    CHECK (step_count IS NULL OR step_count > 0),
    CHECK (stairs = 1 OR step_count IS NULL)
);
SELECT AddGeometryColumn('edge', 'geom', 4326, 'LINESTRING', 'XY');
SELECT CreateSpatialIndex('edge', 'geom');
CREATE INDEX ix_edge_from ON edge (from_node_id);
CREATE INDEX ix_edge_to   ON edge (to_node_id);
CREATE INDEX ix_edge_osm  ON edge (osm_way_id) WHERE osm_way_id IS NOT NULL;
CREATE INDEX ix_edge_name ON edge (name) WHERE name IS NOT NULL;

-- Ordered doors per building. ordinal 0 is preferred/main.
CREATE TABLE entrance (
    node_id     TEXT PRIMARY KEY REFERENCES node(node_id) ON DELETE CASCADE,
    building_id TEXT NOT NULL REFERENCES building(building_id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    snap_m      REAL NOT NULL,               -- distance to the network at link time
    side        TEXT,                        -- 'north' | 'main' | 'loading'
    UNIQUE (building_id, ordinal),
    CHECK (ordinal >= 0),
    CHECK (snap_m >= 0 AND snap_m <= 120)    -- 03-graph-pipeline.md §5.3 fallback ceiling
);


-- ---------------------------------------------------------------------
-- 4. OVERLAYS
-- ---------------------------------------------------------------------

-- The reference-resolution subsystem (11-system-architecture.md §3.2). This table is how
-- hand-curated corrections survive graph regeneration. Defect P-31.
CREATE TABLE overlay_ref (
    overlay_id   TEXT PRIMARY KEY,           -- stable, human-authored slug
    file         TEXT NOT NULL,              -- 'overlays/edge-overrides.json'
    kind         TEXT NOT NULL,              -- 'entrance'|'edge_attr'|'name'|'closure'
    ref_primary  TEXT NOT NULL,              -- 'osm:way/123@3..7' | 'edge:m3p8…'
    ref_fallback TEXT,                       -- 'geo:-111.9336,33.4194,r=8'
    payload_json TEXT NOT NULL,
    resolved_to  TEXT,                       -- node_id / edge_id / building_id
    resolution   TEXT NOT NULL,              -- 'exact'|'spatial'|'ambiguous'|'failed'
    authored_by  TEXT,
    authored_utc TEXT,
    note         TEXT,

    CHECK (kind IN ('entrance','edge_attr','name','closure','geometry')),
    CHECK (resolution IN ('exact','spatial','ambiguous','failed')),
    -- exact/spatial must have resolved to something; the others must not
    CHECK ((resolution IN ('exact','spatial') AND resolved_to IS NOT NULL)
        OR (resolution IN ('ambiguous','failed') AND resolved_to IS NULL))
);
CREATE INDEX ix_overlay_resolution ON overlay_ref (resolution);

-- Build FAILS on any 'ambiguous' or 'failed' row.
-- Build WARNS on any 'spatial' row and lists it for re-pinning.
--   SELECT overlay_id, ref_primary, resolved_to FROM overlay_ref
--   WHERE resolution <> 'exact';


-- ---------------------------------------------------------------------
-- 5. CLOSURES  (authored here, EXPORTED SEPARATELY, never baked into the graph)
-- ---------------------------------------------------------------------

CREATE TABLE closure (
    closure_id TEXT PRIMARY KEY,             -- 'closure:cady-mall-east-2026-08'
    reason     TEXT NOT NULL,
    from_utc   TEXT NOT NULL,
    to_utc     TEXT,                         -- NULL = indefinite
    source_url TEXT,
    CHECK (to_utc IS NULL OR to_utc > from_utc)
);

CREATE TABLE closure_edge (
    closure_id TEXT NOT NULL REFERENCES closure(closure_id) ON DELETE CASCADE,
    edge_id    TEXT NOT NULL REFERENCES edge(edge_id)       ON DELETE CASCADE,
    PRIMARY KEY (closure_id, edge_id)
);


-- ---------------------------------------------------------------------
-- 6. QUALITY SAMPLES
-- ---------------------------------------------------------------------

-- The 500 seeded pairs from scripts/route-report.py, per build, so a
-- detour-ratio regression is attributable to a commit.
CREATE TABLE route_sample (
    build_hash   TEXT NOT NULL REFERENCES build(build_hash) ON DELETE CASCADE,
    from_bldg    TEXT NOT NULL,
    to_bldg      TEXT NOT NULL,
    graph_m      REAL,
    straight_m   REAL NOT NULL,
    detour_ratio REAL,
    hops         INTEGER,
    failure      TEXT,                       -- NULL on success
    PRIMARY KEY (build_hash, from_bldg, to_bldg),
    CHECK ((graph_m IS NOT NULL AND failure IS NULL)
        OR (graph_m IS NULL     AND failure IS NOT NULL))
);
CREATE INDEX ix_sample_ratio ON route_sample (build_hash, detour_ratio DESC);


-- =====================================================================
-- GATE QUERIES  (scripts/validate-graph.py runs these; see 04-validation-gates.md)
-- =====================================================================

-- S7 — reconciliation. Must return zero rows.
--   SELECT source, COUNT(*) total,
--          SUM(kept) kept, SUM(1-kept) rejected
--   FROM source_feature GROUP BY source
--   HAVING total <> kept + rejected;

-- S2 — dangling endpoints. Enforced by the FKs, but assert anyway in case
--      someone loaded with foreign_keys OFF. Must return zero rows.
--   SELECT e.edge_id FROM edge e
--   LEFT JOIN node a ON a.node_id = e.from_node_id
--   LEFT JOIN node b ON b.node_id = e.to_node_id
--   WHERE a.node_id IS NULL OR b.node_id IS NULL;

-- G3 — THE gate. No edge interior more than 2 m inside a footprint.
--      Catches defect P-02 (malls through Hayden Library, the MU, Payne
--      Hall, ISTB1 and eleven others). Must return zero rows.
--   SELECT e.edge_id, b.building_id,
--          ST_Length(ST_Intersection(e.geom, f.geom), true) AS inside_m
--   FROM edge e
--   JOIN footprint f ON f.ROWID IN (
--        SELECT ROWID FROM SpatialIndex
--        WHERE f_table_name = 'footprint' AND search_frame = e.geom)
--     AND ST_Intersects(e.geom, f.geom)
--   JOIN building b ON b.footprint_id = f.footprint_id
--   WHERE e.indoor = 0 AND e.tunnel = 0
--     AND ST_Length(ST_Intersection(e.geom, f.geom), true) > 2.0;

-- G4 — stored length matches recomputed geodesic length within 0.5 m.
--   SELECT edge_id, length_m, ST_Length(geom, true) AS recomputed
--   FROM edge WHERE abs(length_m - ST_Length(geom, true)) > 0.5;

-- G7 — no two nodes closer than 0.5 m (clustering did its job).
--   SELECT a.node_id, b.node_id, ST_Distance(a.geom, b.geom, true) d
--   FROM node a JOIN node b ON a.node_id < b.node_id
--    AND b.ROWID IN (SELECT ROWID FROM SpatialIndex
--                    WHERE f_table_name='node'
--                      AND search_frame = ST_Buffer(a.geom, 0.00001))
--   WHERE ST_Distance(a.geom, b.geom, true) < 0.5;

-- G8 — entrance further than 40 m from its own footprint.
--   SELECT n.node_id, n.building_id,
--          ST_Distance(n.geom, f.geom, true) d
--   FROM node n
--   JOIN building b ON b.building_id = n.building_id
--   JOIN footprint f ON f.footprint_id = b.footprint_id
--   WHERE n.type = 'entrance' AND ST_Distance(n.geom, f.geom, true) > 40;

-- C1 — coverage. Fails below 0.95.
--   SELECT CAST(SUM(routable) AS REAL) / COUNT(*)
--   FROM building WHERE in_service_area = 1;

-- C3 — large buildings that are unroutable. Must be 0.
--   SELECT building_id, gsf, unroutable_why FROM building
--   WHERE in_service_area = 1 AND routable = 0 AND gsf >= 50000;

-- C5 — total centerline. Fails below 25,000 m.
--   SELECT SUM(length_m) FROM edge WHERE type <> 'link';

-- C6 — the provisional-entrance work queue, ordered by building size.
--      This is the Phase E task list.
--   SELECT b.building_id, b.display_name, b.gsf, e.snap_m
--   FROM entrance e
--   JOIN node n     ON n.node_id = e.node_id AND n.provisional = 1
--   JOIN building b ON b.building_id = e.building_id
--   ORDER BY b.gsf DESC;

-- Connected components (S8) are computed in Python with a union-find over
-- the edge table; recursive CTEs in SQLite handle this but are far slower
-- and harder to read at 8,000 edges.
