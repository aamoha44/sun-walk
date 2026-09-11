import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fetch-ufrm.py", import.meta.url));
const FIXTURE_DIR = fileURLToPath(
  new URL("../tests/fixtures/ufrm-offline", import.meta.url),
);

function resolvePython(): string[] {
  const candidates: string[][] = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
  candidates.push(["python3"], ["python"], ["py", "-3"]);
  for (const cmd of candidates) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), "--version"], { stdio: "pipe" });
      return cmd;
    } catch {
      /* next */
    }
  }
  throw new Error("no python interpreter found");
}
const PY = resolvePython();

const outDir = mkdtempSync(join(tmpdir(), "sunwalk-ufrm-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// Run the fetcher once in offline mode against the frozen fixture.
execFileSync(
  PY[0],
  [...PY.slice(1), SCRIPT, "--offline", FIXTURE_DIR, "--out", outDir],
  { stdio: "pipe" },
);

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(outDir, name), "utf8"));

test("rejects (0,0) and missing-geometry features, with a reason", () => {
  const rejected = read("rejected-features.json") as Array<{
    code: string;
    reason: string;
  }>;
  assert.equal(rejected.length, 2);
  const byCode = Object.fromEntries(rejected.map((r) => [r.code, r.reason]));
  assert.match(byCode["NULLA"], /null-island/);
  assert.match(byCode["NOGEO"], /missing point geometry/);
});

test("duplicate codes are resolved per §1.4: STAD split, MB merged as wings", () => {
  const dups = read("ufrm-duplicates.json") as Array<{
    code: string;
    featureCount: number;
    clusterCount: number;
    clusters: Array<{ id: string; memberCount: number; resolution: string }>;
  }>;
  assert.equal(dups.length, 2, "exactly the two repeating codes");

  const stad = dups.find((d) => d.code === "STAD")!;
  assert.equal(stad.featureCount, 2);
  assert.equal(stad.clusterCount, 2, ">150 m apart => two separate facilities");
  assert.deepEqual(
    stad.clusters.map((c) => c.id).sort(),
    ["bldg:STAD", "bldg:STAD#2"],
  );
  assert.ok(stad.clusters.every((c) => c.resolution === "separate"));

  const mb = dups.find((d) => d.code === "MB")!;
  assert.equal(mb.featureCount, 3);
  assert.equal(mb.clusterCount, 1, "<=150 m => one facility with wings");
  assert.equal(mb.clusters[0].memberCount, 3);
  assert.equal(mb.clusters[0].resolution, "wings");
});

test("points carry the resolved bldg id and a primary/anchor role", () => {
  const fc = read("ufrm-points.geojson") as {
    features: Array<{ properties: { _bldgId: string; _role: string; BLDG_CODE: string } }>;
  };
  // COOR(1) + STAD(1) + STAD#2(1) + MB primary(1) + MB anchors(2) = 6
  assert.equal(fc.features.length, 6);

  const roles = fc.features.reduce<Record<string, number>>((acc, f) => {
    acc[f.properties._role] = (acc[f.properties._role] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(roles["primary"], 4);
  assert.equal(roles["anchor"], 2);

  const mbAnchors = fc.features.filter(
    (f) => f.properties._bldgId === "bldg:MB" && f.properties._role === "anchor",
  );
  assert.equal(mbAnchors.length, 2);
});

test("footprints are envelope-joined to the MC code set (ZZZ dropped)", () => {
  const fc = read("ufrm-footprints.geojson") as {
    features: Array<{ properties: { BLDG_CODE: string } }>;
  };
  const codes = fc.features.map((f) => f.properties.BLDG_CODE).sort();
  assert.deepEqual(codes, ["COOR", "MB", "STAD"]);
});

test("manifest reconciles fetched == kept + rejected and records freshness", () => {
  const m = read("manifest.json") as {
    reconciliation: { fetched: number; kept: number; rejected: number; ok: boolean };
    entries: Array<{ file: string; sha256: string; freshness?: Record<string, { p50: string | null }> }>;
  };
  assert.deepEqual(m.reconciliation, { fetched: 8, kept: 6, rejected: 2, ok: true });

  const pts = m.entries.find((e) => e.file === "ufrm-points.geojson")!;
  assert.match(pts.sha256, /^[0-9a-f]{64}$/);
  assert.ok(pts.freshness);
  assert.match(pts.freshness!["EditDate"].p50 ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(pts.freshness!["ExtractDateTime"].p50 ?? "", /^\d{4}-\d{2}-\d{2}T/);
});
