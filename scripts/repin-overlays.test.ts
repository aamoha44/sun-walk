import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./repin-overlays.py", import.meta.url));

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

const scratch = mkdtempSync(join(tmpdir(), "sunwalk-repin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A db with two 'spatial' overlay_ref rows (object-ref and string-ref). */
function seed(dbPath: string): void {
  const script = [
    "import scripts.lib.db as db",
    `c = db.connect(${JSON.stringify(dbPath)})`,
    "def row(oid, ref, res, to):",
    "    c.execute(\"INSERT INTO overlay_ref(overlay_id,file,kind,ref_primary,ref_fallback,payload_json,resolved_to,resolution) \"",
    "              \"VALUES(?,?,?,?,?,?,?,?)\", (oid,'overlays/entrances.json','entrance',ref,'geo:-111.93,33.42,r=8','{}',to,res))",
    "row('e1', 'node:staleeeee', 'spatial', 'node:aaaaaaaa')",   // object-form ref in the file
    "row('e2', 'osm:way/999@1..2', 'spatial', 'edge:bbbbbbbb')", // string-form ref in the file
    "row('e3', 'edge:ccccdddd', 'exact', 'edge:ccccdddd')",      // exact -> must be left alone
    "c.commit(); c.close(); print('seeded')",
  ].join("\n");
  const { code, out } = py(["-c", script]);
  assert.equal(code, 0, out);
}

function overlayFile(): string {
  return JSON.stringify({
    entries: [
      { id: "e1", ref: { primary: "node:staleeeee", fallback: "geo:-111.93,33.42,r=8" }, move: "12m north" },
      { id: "e2", ref: "osm:way/999@1..2", blocked: true },
      { id: "e3", ref: "edge:ccccdddd", covered: true },
    ],
  }, null, 2);
}

test("repin-overlays: --allow-write rewrites spatial refs to content ids, keeps the fallback", () => {
  const dbPath = join(scratch, "w.db").replace(/\\/g, "/");
  const odir = join(scratch, "ovl-w");
  seed(dbPath);
  rmSync(odir, { recursive: true, force: true });
  execFileSync(PY[0], [...PY.slice(1), "-c", `import os; os.makedirs(${JSON.stringify(odir)})`]);
  writeFileSync(join(odir, "entrances.json"), overlayFile());

  const { code, out } = py([SCRIPT, "--db", dbPath, "--overlays-dir", odir, "--allow-write"]);
  assert.equal(code, 0, out);
  const res = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1));
  assert.equal(res.spatial_rows, 2);
  assert.equal(res.repinned.length, 2, out);
  assert.equal(res.files_written.length, 1);

  const doc = JSON.parse(readFileSync(join(odir, "entrances.json"), "utf8"));
  const [e1, e2, e3] = doc.entries;
  assert.deepEqual(e1.ref, { primary: "node:aaaaaaaa", fallback: "geo:-111.93,33.42,r=8" });
  assert.equal(e2.ref, "edge:bbbbbbbb");        // string-form rewritten in place
  assert.equal(e3.ref, "edge:ccccdddd");        // 'exact' row untouched
});

test("repin-overlays: without --allow-write it reports but writes nothing", () => {
  const dbPath = join(scratch, "d.db").replace(/\\/g, "/");
  const odir = join(scratch, "ovl-d");
  seed(dbPath);
  rmSync(odir, { recursive: true, force: true });
  execFileSync(PY[0], [...PY.slice(1), "-c", `import os; os.makedirs(${JSON.stringify(odir)})`]);
  const before = overlayFile();
  writeFileSync(join(odir, "entrances.json"), before);

  const { code, out } = py([SCRIPT, "--db", dbPath, "--overlays-dir", odir]);
  assert.equal(code, 0, out);
  const res = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1));
  assert.equal(res.dry_run, true);
  assert.equal(res.repinned.length, 2);
  assert.equal(res.files_written.length, 0);
  assert.equal(readFileSync(join(odir, "entrances.json"), "utf8"), before);
});
