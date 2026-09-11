import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_PY = fileURLToPath(new URL("./db.py", import.meta.url));

/**
 * First interpreter that runs AND can load mod_spatialite. Order: $PYTHON, the
 * MSYS2 UCRT64 python (where SpatiaLite lives on this machine), then the bare
 * names. The Windows Store `python3` shim and python.org / `py -3` all fail the
 * load_extension probe and are skipped. See scripts/lib/db.py.
 */
function resolveSpatialitePython(): string[] {
  const candidates: string[][] = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
  candidates.push(
    ["C:/msys64/ucrt64/bin/python3.exe"],
    ["python3"],
    ["python"],
    ["py", "-3"],
  );
  const probe =
    "import sqlite3;c=sqlite3.connect(':memory:');c.enable_load_extension(True);" +
    "c.execute(\"SELECT load_extension('mod_spatialite')\")";
  for (const cmd of candidates) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), "-c", probe], { stdio: "pipe" });
      return cmd;
    } catch {
      /* next */
    }
  }
  throw new Error(
    "no SpatiaLite-capable python found (tried $PYTHON, msys2 python3, python3, python, py -3). " +
      "Install mod_spatialite or set PYTHON to an interpreter that has it.",
  );
}

const PY = resolveSpatialitePython();

function py(args: string[], opts: { cwd?: string } = {}): { code: number; out: string } {
  try {
    const out = execFileSync(PY[0], [...PY.slice(1), ...args], {
      encoding: "utf8",
      stdio: "pipe",
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, PYTHONPATH: REPO_ROOT },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "sunwalk-db-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("db.py --check: an edge with a dangling from_node_id is rejected by the FK (K-03 DoD)", () => {
  const { code, out } = py([DB_PY, "--check"]);
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`);
  assert.match(out, /K-03 OK: dangling from_node_id rejected/);
  assert.match(out, /SpatiaLite \d+\.\d+/); // spatialite really loaded, not skipped
});

test("connect(): bootstraps a fresh file with the full schema and is idempotent on reopen", () => {
  const dbPath = join(scratch, "authoring.db").replace(/\\/g, "/");
  const code = [
    "import scripts.lib.db as db",
    `p = ${JSON.stringify(dbPath)}`,
    "c = db.connect(p); c.close()", // fresh: runs InitSpatialMetaData + authoring.sql
    "c = db.connect(p)", // reopen: must NOT re-run the schema (would raise 'table exists')
    "tables = {r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}",
    "need = {'source_feature','build','building','building_alias','footprint','node','edge','entrance','overlay_ref','closure','closure_edge','route_sample','build_input','build_metric'}",
    "missing = need - tables",
    "assert not missing, f'missing tables: {missing}'",
    "assert 'geometry_columns' in tables, 'InitSpatialMetaData did not run'",
    "assert c.execute('PRAGMA foreign_keys').fetchone()[0] == 1",
    "print('OK', len(need), 'tables')",
  ].join("\n");
  const { code: rc, out } = py(["-c", code]);
  assert.equal(rc, 0, `expected exit 0, got ${rc}:\n${out}`);
  assert.match(out, /OK 14 tables/);
});

test("geodesic-length guard (T-032b, K-04): ST_Length(geom, true) reads a known ~100 m segment as 100 m ± 0.5; the flagless call returns degrees", () => {
  // SQL-side mirror of T-032a (src/domain/geo.test.ts). Endpoints are placed
  // 100 m out by the spherical forward formula (R = 6371008.8 — the same model
  // geo.ts uses), due north and due east. SpatiaLite reads them on the
  // ellipsoid as ~99.7 / ~100.2 m: agreement with our haversine model to
  // < 0.3 m at the 100 m scale the graph works at, which is what gate G4's
  // 0.5 m tolerance needs. ST_Length(geom) WITHOUT the geodesic flag returns
  // DEGREES (~9e-4) — K-04's ~110,000x trap — and fails the same tolerance.
  const code = [
    "import math, scripts.lib.db as db",
    "R = 6371008.8",
    "c = db.connect(':memory:')",
    "lon0, lat0 = -111.93, 33.42",
    "def fwd(dist, brg):",
    "    ad, br, p1 = dist/R, math.radians(brg), math.radians(lat0)",
    "    p2 = math.asin(math.sin(p1)*math.cos(ad) + math.cos(p1)*math.sin(ad)*math.cos(br))",
    "    l2 = math.radians(lon0) + math.atan2(math.sin(br)*math.sin(ad)*math.cos(p1), math.cos(ad)-math.sin(p1)*math.sin(p2))",
    "    return f'LINESTRING({lon0} {lat0}, {math.degrees(l2)} {math.degrees(p2)})'",
    "for brg, name in ((0.0, 'N'), (90.0, 'E')):",
    "    wkt = fwd(100.0, brg)",
    "    geo = c.execute('SELECT ST_Length(GeomFromText(?,4326), 1)', (wkt,)).fetchone()[0]",
    "    flagless = c.execute('SELECT ST_Length(GeomFromText(?,4326))', (wkt,)).fetchone()[0]",
    "    assert abs(geo - 100.0) <= 0.5, f'{name}: ST_Length(geom,true)={geo} not within 0.5 m of 100'",
    "    assert abs(flagless - 100.0) > 0.5, f'{name}: flagless ST_Length={flagless} unexpectedly close to 100 (K-04 did not reproduce)'",
    "    print(f'{name}: geodesic={geo:.4f} m  flagless={flagless:.8f}')",
  ].join("\n");
  const { code: rc, out } = py(["-c", code]);
  assert.equal(rc, 0, `expected exit 0, got ${rc}:\n${out}`);
  assert.match(out, /N: geodesic=9[0-9]\.\d+ m/);
  assert.match(out, /E: geodesic=1[0-9][0-9]\.\d+ m/);
});

test("K-03 control: without PRAGMA foreign_keys=ON the same dangling insert is accepted", () => {
  // Proves connect()'s pragma is load-bearing: SQLite leaves FKs OFF by default,
  // so a plain connection over the identical schema does not reject the edge.
  const code = [
    "import sqlite3, pathlib",
    "schema = pathlib.Path('contracts/authoring.sql').read_text(encoding='utf-8')",
    "c = sqlite3.connect(':memory:')",
    "c.enable_load_extension(True); c.execute(\"SELECT load_extension('mod_spatialite')\")",
    "c.execute('SELECT InitSpatialMetaData(1)')",
    "c.executescript(schema)",
    "c.execute(\"INSERT INTO node(node_id,type) VALUES('node:aaaaaaaaaa','walkway')\")",
    "c.execute(\"INSERT INTO edge(edge_id,from_node_id,to_node_id,type,length_m,surface,shade_index,shade_source)\"",
    "          \" VALUES('edge:zzzzzzzzzz','node:aaaaaaaaaa','node:doesnotexist','path',10,'paved',0.5,'default')\")",
    "print('accepted-without-pragma')",
  ].join("\n");
  const { code: rc, out } = py(["-c", code]);
  assert.equal(rc, 0, `expected the insert to be accepted, got exit ${rc}:\n${out}`);
  assert.match(out, /accepted-without-pragma/);
});
