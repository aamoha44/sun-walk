import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fetch-osm.py", import.meta.url));
const OVERPASS = fileURLToPath(
  new URL("../tests/fixtures/osm-overpass.json", import.meta.url),
);

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

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(PY[0], [...PY.slice(1), SCRIPT, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const dir = mkdtempSync(join(tmpdir(), "sunwalk-osm-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("applies the §2 way and node filter", () => {
  const { code, out } = run(["--overpass-json", OVERPASS]);
  assert.equal(code, 0);
  const end = out.indexOf("}");
  const summary = JSON.parse(out.slice(0, end + 1)) as {
    ways: number;
    nodes: number;
    plazas: number;
    centrelineMetres: number;
    osmTimestamp: string;
  };
  // kept ways: footway, steps, service+foot=yes, residential (no sidewalk)
  // + area:highway=footway plaza + highway=pedestrian/area=yes plaza = 6
  assert.equal(summary.ways, 6);
  assert.equal(summary.plazas, 2);
  // dropped: service foot=no, residential+sidewalk, highway=primary
  // kept nodes: crossing, entrance, bollard = 3  (amenity=bench dropped)
  assert.equal(summary.nodes, 3);
  assert.ok(summary.centrelineMetres > 0);
  assert.equal(summary.osmTimestamp, "2026-08-01T00:00:00Z");
});

test("the file write is gated behind --allow-write (fetch + summary still run)", () => {
  const outPath = join(dir, "osm-tempe.geojson");
  const { code, out } = run(["--overpass-json", OVERPASS, "--out", outPath]);
  assert.equal(code, 0);
  assert.match(out, /Pass --allow-write to write/);
  assert.equal(existsSync(outPath), false, "no file written without --allow-write");
});

test("--allow-write writes a FeatureCollection + manifest entry with ODbL provenance", () => {
  const outPath = join(dir, "osm-tempe.geojson");
  const manifestPath = join(dir, "manifest.json");
  const { code } = run([
    "--overpass-json", OVERPASS, "--out", outPath,
    "--manifest", manifestPath, "--allow-write",
  ]);
  assert.equal(code, 0);

  const fc = JSON.parse(readFileSync(outPath, "utf8")) as {
    features: Array<{ geometry: { type: string }; properties: Record<string, unknown> }>;
    _meta: { license: string; attribution: string };
  };
  const lines = fc.features.filter((f) => f.geometry.type === "LineString");
  assert.ok(lines.every((f) => typeof f.properties.osmWayId === "number"));
  assert.ok(lines.every((f) => f.properties.synthetic === false));
  const steps = fc.features.find((f) => f.properties.osmWayId === 1002)!;
  assert.equal(steps.properties.step_count, "14"); // §2.4 tag carried through
  // grade-separation tags the noding stage needs (03 §2.2); added 2026-08-28
  assert.equal(steps.properties.bridge, "yes");
  assert.equal(steps.properties.layer, "1");
  const palm = fc.features.find((f) => f.properties.osmWayId === 1001)!;
  assert.equal("bridge" in palm.properties, false); // only carried when present
  // §2.1 plazas: both tagging schemes land as Polygon features flagged plaza
  const plazas = fc.features.filter((f) => f.properties.plaza === true);
  assert.equal(plazas.length, 2);
  assert.ok(plazas.every((f) => f.geometry.type === "Polygon"));
  const forecourt = fc.features.find((f) => f.properties.osmWayId === 1009)!;
  assert.equal(forecourt.geometry.type, "Polygon");
  assert.equal(forecourt.properties.name, "MU Forecourt");
  assert.match(fc._meta.license, /ODbL 1\.0/);
  assert.equal(fc._meta.attribution, "© OpenStreetMap contributors");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: Array<{ file: string; license: string; query: string; centrelineMetres: number }>;
  };
  const entry = manifest.entries.find((e) => e.file === "osm-tempe.geojson")!;
  assert.match(entry.license, /ODbL 1\.0/);
  assert.match(entry.query, /highway.*footway/);
  assert.ok(entry.centrelineMetres > 0);
});
