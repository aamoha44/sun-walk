import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./footprint-coverage.py", import.meta.url));

function resolvePython(): string[] {
  const c: string[][] = [];
  if (process.env.PYTHON) c.push([process.env.PYTHON]);
  c.push(["python3"], ["python"], ["py", "-3"]);
  for (const cmd of c) {
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

const dir = mkdtempSync(join(tmpdir(), "sunwalk-cov-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const point = (code: string, role: string, gsf: number) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-111.93, 33.42] },
  properties: { BLDG_CODE: code, BLDG_NAME: code, BLDG_GSF: gsf, _bldgId: `bldg:${code}`, _role: role },
});
const poly = (code: string) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[-111.93, 33.42], [-111.929, 33.42], [-111.929, 33.421], [-111.93, 33.42]]] },
  properties: { BLDG_CODE: code },
});

// 4 building records: A + B covered, C (60k, no footprint), D (0 gsf, no footprint).
// One anchor for A — must not be counted as a building.
writeFileSync(join(dir, "points.geojson"), JSON.stringify({
  type: "FeatureCollection",
  features: [
    point("A", "primary", 10000), point("A", "anchor", 500),
    point("B", "primary", 20000),
    point("C", "primary", 60000),
    point("D", "primary", 0),
  ],
}));
writeFileSync(join(dir, "footprints.geojson"), JSON.stringify({
  type: "FeatureCollection",
  features: [poly("A"), poly("B")],
}));
// Supplemental (City of Tempe): covers C (currently missing) + E (not an MC
// building, ignored) but NOT B (a code UFRM has — the honest regression column).
writeFileSync(join(dir, "supp.geojson"), JSON.stringify({
  type: "FeatureCollection",
  features: [poly("C"), poly("A"), poly("E")],
}));

execFileSync(
  PY[0],
  [...PY.slice(1), SCRIPT, "--points", join(dir, "points.geojson"),
   "--footprints", join(dir, "footprints.geojson"), "--out", join(dir, "cov.json")],
  { stdio: "pipe" },
);
execFileSync(
  PY[0],
  [...PY.slice(1), SCRIPT, "--points", join(dir, "points.geojson"),
   "--footprints", join(dir, "footprints.geojson"), "--supplemental", join(dir, "supp.geojson"),
   "--out", join(dir, "cov-supp.json")],
  { stdio: "pipe" },
);

test("counts building records (primaries only) with and without a footprint", () => {
  const r = JSON.parse(readFileSync(join(dir, "cov.json"), "utf8")) as {
    buildingRecords: number;
    withFootprint: number;
    withoutFootprint: number;
    coveragePct: number;
    withoutFootprintZeroGsf: number;
    withoutFootprintOver50kGsf: string[];
  };
  assert.equal(r.buildingRecords, 4, "the anchor is not a building");
  assert.equal(r.withFootprint, 2);
  assert.equal(r.withoutFootprint, 2);
  assert.equal(r.coveragePct, 50);
  assert.equal(r.withoutFootprintZeroGsf, 1, "D has gsf 0");
  assert.deepEqual(r.withoutFootprintOver50kGsf, ["C"], "only C is >=50k");
  assert.equal("combined" in r, false, "no --supplemental -> no combined block");
});

test("--supplemental merges City-of-Tempe footprints, UFRM wins ties", () => {
  const r = JSON.parse(readFileSync(join(dir, "cov-supp.json"), "utf8")) as {
    withFootprint: number;
    coveragePct: number;
    combined: {
      withFootprint: number;
      coveragePct: number;
      gainedFromSupplemental: string[];
      supplementalLacksUfrmHas: string[];
      stillUncovered: string[];
      newProxyOrNoneCount: number;
    };
  };
  // the UFRM-only block is untouched (D-006 cites it)
  assert.equal(r.withFootprint, 2);
  assert.equal(r.coveragePct, 50);
  // C is filled by the supplement; D still has nothing
  assert.equal(r.combined.withFootprint, 3);
  assert.equal(r.combined.coveragePct, 75);
  assert.deepEqual(r.combined.gainedFromSupplemental, ["C"]);
  assert.deepEqual(r.combined.supplementalLacksUfrmHas, ["B"], "B is UFRM-only");
  assert.deepEqual(r.combined.stillUncovered, ["D"]);
  assert.equal(r.combined.newProxyOrNoneCount, 1);
});
