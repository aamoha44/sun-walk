import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./normalize-campus-buildings.py", import.meta.url));

function resolvePython(): string[] {
  const c: string[][] = [];
  if (process.env.PYTHON) c.push([process.env.PYTHON]);
  c.push(["C:/msys64/ucrt64/bin/python3.exe"], ["python3"], ["python"], ["py", "-3"]);
  for (const cmd of c) {
    try { execFileSync(cmd[0], [...cmd.slice(1), "--version"], { stdio: "pipe" }); return cmd; }
    catch { /* next */ }
  }
  throw new Error("no python found");
}
const PY = resolvePython();

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(PY[0], [...PY.slice(1), SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "sunwalk-ncb-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A closed ~small square ring near the ASU Tempe centre. */
function sq(lon: number, lat: number, d = 0.0003): number[][] {
  return [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
}

/** Write a case dir with a mini ufrm-points.geojson (the MC join set) and a raw
 *  input file; return the two paths. `rawPrefix` lets a test inject junk bytes. */
function setup(name: string, mcCodes: string[], rawFeatures: unknown[], rawPrefix = "sor"): { dir: string; raw: string } {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ufrm-points.geojson"), JSON.stringify({
    type: "FeatureCollection",
    features: mcCodes.map((code) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-111.93, 33.42] },
      properties: { BLDG_CODE: code, _role: "primary", _bldgId: `bldg:${code}` },
    })),
  }));
  const raw = join(dir, "raw.geojson");
  writeFileSync(raw, rawPrefix + JSON.stringify({ type: "FeatureCollection", name: "x", crs: {}, features: rawFeatures }));
  return { dir, raw };
}

function feat(code: string, type = "Academic", ring = sq(-111.93, 33.42)): unknown {
  return {
    type: "Feature",
    id: 99,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { BLDG_CODE: code, BLDG_NAME: `${code} Hall`, Type: type, Image: null, Shape__Area: 1e-8 },
  };
}

test("normalize: strips the stray prefix, joins to the MC set, canonicalizes", () => {
  const { dir, raw } = setup("ok", ["MU", "LIB", "PSF"], [
    feat("MU"), feat("LIB"), feat("PSF"),
    feat("NOTMC"),                              // not in the MC set -> rejected
  ]);
  const { code, out } = run(["--in", raw, "--out", dir]);
  assert.equal(code, 0, out);
  assert.match(out, /stripped 3 leading byte/);

  const fc = JSON.parse(readFileSync(join(dir, "asu-campus-buildings.geojson"), "utf8"));
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 3);                        // NOTMC dropped
  assert.deepEqual(fc.features.map((f: any) => f.properties.BLDG_CODE), ["LIB", "MU", "PSF"]); // sorted
  const e = fc.features[0];
  assert.deepEqual(Object.keys(e.properties).sort(), ["BLDG_CODE", "BLDG_NAME", "Image", "Shape__Area", "Type"]);
  assert.equal(e.properties.Image, null);
  assert.equal("id" in e, false);
  assert.equal("crs" in fc, false);

  const rej = JSON.parse(readFileSync(join(dir, "rejected-campus-buildings.json"), "utf8"));
  assert.equal(rej.length, 1);
  assert.equal(rej[0].code, "NOTMC");
});

test("normalize: multi-part codes are kept as separate features", () => {
  const { dir, raw } = setup("multi", ["STAD"], [
    feat("STAD", "Athletics", sq(-111.931, 33.418)),
    feat("STAD", "Athletics", sq(-111.930, 33.419)),
  ]);
  assert.equal(run(["--in", raw, "--out", dir]).code, 0);
  const fc = JSON.parse(readFileSync(join(dir, "asu-campus-buildings.geojson"), "utf8"));
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features.map((f: any) => f.properties.BLDG_CODE), ["STAD", "STAD"]);
});

test("normalize: a non-polygon geometry fails validation", () => {
  const { dir, raw } = setup("badgeom", ["MU"], [
    { type: "Feature", geometry: { type: "LineString", coordinates: [[-111.93, 33.42], [-111.929, 33.42]] },
      properties: { BLDG_CODE: "MU" } },
  ]);
  const { code, out } = run(["--in", raw, "--out", dir]);
  assert.equal(code, 1);
  assert.match(out, /want Polygon\/MultiPolygon/);
  assert.equal(existsSync(join(dir, "asu-campus-buildings.geojson")), false);
});

test("normalize: a vertex outside the ASU Tempe bbox fails validation", () => {
  const { dir, raw } = setup("oob", ["MU"], [feat("MU", "Academic", sq(-110.0, 33.42))]);
  const { code, out } = run(["--in", raw, "--out", dir]);
  assert.equal(code, 1);
  assert.match(out, /outside the ASU Tempe bbox/);
});

test("normalize: output is byte-stable and the manifest entry is replace-or-add", () => {
  const { dir, raw } = setup("stable", ["MU", "LIB"], [feat("LIB"), feat("MU")]);
  assert.equal(run(["--in", raw, "--out", dir]).code, 0);
  const first = readFileSync(join(dir, "asu-campus-buildings.geojson"), "utf8");
  assert.equal(run(["--in", raw, "--out", dir]).code, 0);
  assert.equal(run(["--in", raw, "--out", dir]).code, 0);
  assert.equal(readFileSync(join(dir, "asu-campus-buildings.geojson"), "utf8"), first, "geojson not byte-stable");

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const entries = manifest.entries.filter((e: any) => e.file === "asu-campus-buildings.geojson");
  assert.equal(entries.length, 1, "manifest entry duplicated across runs");
  assert.match(entries[0].license, /City of Tempe/);
  assert.equal(entries[0].featureCount, 2);
});
