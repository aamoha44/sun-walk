import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATH = fileURLToPath(
  new URL("../sources/service-area.geojson", import.meta.url),
);

interface Ring extends Array<[number, number]> {}

test("service-area.geojson is one closed polygon inside the coordinate bounds (T-010)", () => {
  const raw = JSON.parse(readFileSync(PATH, "utf8")) as {
    type: string;
    features: Array<{ geometry: { type: string; coordinates: Ring[] } }>;
  };

  assert.equal(raw.type, "FeatureCollection");
  assert.equal(raw.features.length, 1, "exactly one feature");

  const geom = raw.features[0].geometry;
  assert.equal(geom.type, "Polygon");
  assert.equal(geom.coordinates.length, 1, "a single ring, no holes");

  const ring = geom.coordinates[0];
  assert.ok(ring.length >= 4, "ring has at least 4 positions");
  assert.deepEqual(ring[0], ring[ring.length - 1], "ring is closed");

  // G2 bounds — the polygon is the coordinate-bounds validator's own reference,
  // so it must itself lie well inside the campus envelope.
  for (const [lon, lat] of ring) {
    assert.ok(lon >= -112.2 && lon <= -111.7, `lon ${lon} in range`);
    assert.ok(lat >= 33.3 && lat <= 33.5, `lat ${lat} in range`);
  }

  // Non-degenerate: spans a plausible campus-scale area.
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  assert.ok(Math.max(...lons) - Math.min(...lons) > 0.005, "spans >~450 m E-W");
  assert.ok(Math.max(...lats) - Math.min(...lats) > 0.01, "spans >~1 km N-S");
});
