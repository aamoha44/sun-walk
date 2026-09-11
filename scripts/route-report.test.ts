import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./route-report.py", import.meta.url));

function resolveSpatialitePython(): string[] {
  const c: string[][] = [];
  if (process.env.PYTHON) c.push([process.env.PYTHON]);
  c.push(["C:/msys64/ucrt64/bin/python3.exe"], ["python3"], ["python"], ["py", "-3"]);
  const probe =
    "import sqlite3;c=sqlite3.connect(':memory:');c.enable_load_extension(True);" +
    "c.execute(\"SELECT load_extension('mod_spatialite')\")";
  for (const cmd of c) {
    try { execFileSync(cmd[0], [...cmd.slice(1), "-c", probe], { stdio: "pipe" }); return cmd; }
    catch { /* next */ }
  }
  throw new Error("no SpatiaLite-capable python found");
}
const PY = resolveSpatialitePython();

function py(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(PY[0], [...PY.slice(1), ...args], {
      encoding: "utf8", stdio: "pipe", cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: REPO_ROOT },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "sunwalk-rr-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Synthetic authoring.db: A—m1—m2—B along a straight walkway (an L-shaped
 *  detour so graph > straight), plus C on a disconnected stub. */
function seed(dbPath: string): void {
  const code = [
    "import scripts.lib.db as db",
    `c = db.connect(${JSON.stringify(dbPath)})`,
    "def node(nid, lon, lat, typ='walkway', bid=None, prov=None):",
    "    c.execute('INSERT INTO node(node_id,type,building_id,provisional,geom) VALUES(?,?,?,?,MakePoint(?,?,4326))', (nid,typ,bid,prov,lon,lat))",
    "def edge(eid,a,b,wkt):",
    "    lo,hi=sorted((a,b))",
    "    L=c.execute('SELECT ST_Length(GeomFromText(?,4326),1)',(wkt,)).fetchone()[0]",
    "    c.execute(\"INSERT INTO edge(edge_id,from_node_id,to_node_id,ord,type,length_m,surface,shade_index,shade_source,geom) VALUES(?,?,?,0,'path',?,'paved',0.15,'default',GeomFromText(?,4326))\",(eid,lo,hi,L,wkt))",
    "def bld(bid,code_,lon,lat):",
    "    c.execute(\"INSERT INTO building(building_id,code,official_name,display_name,category,footprint_src,in_service_area,routable,unroutable_why,centroid) VALUES(?,?,?,?,'academic','none',1,1,NULL,MakePoint(?,?,4326))\",(bid,code_,code_,code_,lon,lat))",
    // A at (0,0)-ish near ASU, B ~200 m east; walkway goes A -> north 100 m -> east 200 m -> south 100 m -> B  (an L, detour ~2x)
    "AX,AY = -111.9350, 33.4200",
    "BX = -111.9350 + 200/ (6371008.8*__import__('math').cos(__import__('math').radians(AY))*__import__('math').pi/180)",
    "NY = AY + 100/(6371008.8*__import__('math').pi/180)",
    "bld('bldg:A','A',AX,AY); bld('bldg:B','B',BX,AY); bld('bldg:C','C',AX-0.002,AY)",
    "node('node:ea',AX,AY,'entrance','bldg:A',0)",
    "node('node:eb',BX,AY,'entrance','bldg:B',0)",
    "node('node:ec',AX-0.002,AY,'entrance','bldg:C',0)",
    "node('node:m1',AX,NY); node('node:m2',BX,NY)",
    "node('node:cs',AX-0.0025,AY)",  // C's disconnected stub node
    "c.execute(\"INSERT INTO entrance(node_id,building_id,ordinal,snap_m) VALUES('node:ea','bldg:A',0,0),('node:eb','bldg:B',0,0),('node:ec','bldg:C',0,0)\")",
    "edge('edge:a_m1','node:ea','node:m1',f'LINESTRING({AX} {AY}, {AX} {NY})')",
    "edge('edge:m1_m2','node:m1','node:m2',f'LINESTRING({AX} {NY}, {BX} {NY})')",
    "edge('edge:m2_b','node:m2','node:eb',f'LINESTRING({BX} {NY}, {BX} {AY})')",
    "edge('edge:c_stub','node:ec','node:cs',f'LINESTRING({AX-0.002} {AY}, {AX-0.0025} {AY})')",  // C -> nowhere
    "c.commit(); c.close(); print('seeded')",
  ].join("\n");
  const { code: rc, out } = py(["-c", code]);
  assert.equal(rc, 0, out);
}

test("route-report: detour ratio = graph shortest path / straight line; disconnected pair → R4 failure", () => {
  const dbPath = join(scratch, "rr.db").replace(/\\/g, "/");
  seed(dbPath);

  // only 3 buildings, so ask for every pair
  const { code, out } = py([SCRIPT, "--db", dbPath, "--pairs", "3"]);
  assert.equal(code, 0, out); // report mode
  const res = JSON.parse(out);
  assert.ok(res.pairs >= 2 && res.pairs <= 3);

  // A↔B: straight ~200 m, graph path is the L ~400 m → ratio ≈ 2.0
  const rows = JSON.parse(py(["-c", [
    "import json, scripts.lib.db as db",
    `c = db.connect(${JSON.stringify(dbPath)})`,
    "print(json.dumps([list(r) for r in c.execute('SELECT from_bldg,to_bldg,round(detour_ratio,2),failure FROM route_sample ORDER BY from_bldg,to_bldg')]))",
  ].join("\n")]).out);
  const ab = rows.find((r: any[]) => r[0] === "bldg:A" && r[1] === "bldg:B");
  assert.ok(ab, JSON.stringify(rows));
  assert.ok(ab[2] > 1.7 && ab[2] < 2.3, `A↔B detour ${ab[2]} not ≈ 2`);
  // any pair involving C is disconnected
  const cPairs = rows.filter((r: any[]) => r[0] === "bldg:C" || r[1] === "bldg:C");
  assert.ok(cPairs.length >= 1);
  assert.ok(cPairs.every((r: any[]) => r[3] === "disconnected"));

  assert.equal(res.gates.R4_failures.value, cPairs.length);
  // the only routed ratio here is the ~2.0 L-detour, so R1 median is ~2.0 → fails
  assert.ok(res.gates.R1_median.value > 1.7 && res.gates.R1_median.value < 2.3);
  assert.equal(res.gates.R1_median.pass, false);
});

test("route-report --assert fails when a gate is red", () => {
  const dbPath = join(scratch, "rr2.db").replace(/\\/g, "/");
  seed(dbPath);
  // R4 (disconnected C) alone makes --assert fail
  assert.equal(py([SCRIPT, "--db", dbPath, "--pairs", "3", "--assert"]).code, 1);
});
