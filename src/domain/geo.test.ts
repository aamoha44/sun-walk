import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EARTH_RADIUS_M,
  haversineM,
  polylineLengthM,
  projectPointOnSegment,
  bearingDeg,
  pointInPolygon,
  segmentIntersection,
} from "./geo.ts";

test("haversineM: ASU Tempe campus to Phoenix City Hall matches an independently computed reference", () => {
  const tempe = { lon: -111.9333, lat: 33.4212 };
  const phoenixCityHall = { lon: -112.0741, lat: 33.4485 };

  const distance = haversineM(tempe, phoenixCityHall);

  // Reference value cross-checked two ways (haversine formula and spherical
  // law of cosines, R = 6,371,008.8 m) independently of this implementation;
  // both agreed to sub-millimeter precision at 13413.372 m (~8.335 mi).
  assert.ok(
    Math.abs(distance - 13413.372) < 1,
    `expected ~13413.372 m, got ${distance} m`,
  );
});

test("polylineLengthM: sums haversine legs between consecutive points", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.93, lat: 33.4225 };
  const c = { lon: -111.925, lat: 33.424 };

  const total = polylineLengthM([a, b, c]);
  const expected = haversineM(a, b) + haversineM(b, c);

  assert.ok(
    Math.abs(total - expected) < 1e-6,
    `expected ${expected} m, got ${total} m`,
  );
});

test("polylineLengthM: a single point has zero length", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  assert.equal(polylineLengthM([a]), 0);
});

test("projectPointOnSegment: a degenerate (zero-length) segment projects onto its single point", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const p = { lon: -111.933, lat: 33.4215 };

  const result = projectPointOnSegment(p, a, a);

  assert.equal(result.point.lon, a.lon);
  assert.equal(result.point.lat, a.lat);
  assert.equal(result.t, 0);
  assert.ok(
    Math.abs(result.distM - haversineM(p, a)) < 1e-6,
    `expected distM ${haversineM(p, a)}, got ${result.distM}`,
  );
});

test("projectPointOnSegment: a point beyond the segment's end clamps to t=1", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.93, lat: 33.4212 };
  const p = { lon: -111.9, lat: 33.4212 }; // due east, past b

  const result = projectPointOnSegment(p, a, b);

  assert.equal(result.t, 1);
  assert.equal(result.point.lon, b.lon);
  assert.equal(result.point.lat, b.lat);
});

test("projectPointOnSegment: a point off the midpoint projects with 0 < t < 1", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.93, lat: 33.4212 };
  const p = { lon: -111.93165, lat: 33.4215 }; // roughly above the midpoint

  const result = projectPointOnSegment(p, a, b);

  assert.ok(result.t > 0.4 && result.t < 0.6, `expected t near 0.5, got ${result.t}`);
});

test("bearingDeg: due north is 0 degrees", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.9333, lat: 33.43 };
  assert.equal(bearingDeg(a, b), 0);
});

test("bearingDeg: due south is 180 degrees", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.9333, lat: 33.41 };
  assert.equal(bearingDeg(a, b), 180);
});

test("bearingDeg: heading east at constant latitude matches an independently computed reference", () => {
  const a = { lon: -111.9333, lat: 33.4212 };
  const b = { lon: -111.925, lat: 33.4212 };
  // Reference computed separately via the standard initial-bearing formula:
  // 89.9977 degrees (not exactly 90 - meridian convergence at this latitude).
  const bearing = bearingDeg(a, b);
  assert.ok(Math.abs(bearing - 89.9977) < 1e-3, `expected ~89.9977, got ${bearing}`);
});

test("pointInPolygon: a point inside a simple square ring is inside", () => {
  const ring = [
    { lon: 0, lat: 0 },
    { lon: 0, lat: 1 },
    { lon: 1, lat: 1 },
    { lon: 1, lat: 0 },
    { lon: 0, lat: 0 },
  ];
  assert.equal(pointInPolygon({ lon: 0.5, lat: 0.5 }, ring), true);
});

test("pointInPolygon: a point outside a simple square ring is outside", () => {
  const ring = [
    { lon: 0, lat: 0 },
    { lon: 0, lat: 1 },
    { lon: 1, lat: 1 },
    { lon: 1, lat: 0 },
    { lon: 0, lat: 0 },
  ];
  assert.equal(pointInPolygon({ lon: 2, lat: 2 }, ring), false);
});

test("segmentIntersection: two crossing segments intersect at their shared midpoint", () => {
  const a = { lon: 0, lat: 0 };
  const b = { lon: 2, lat: 2 };
  const c = { lon: 0, lat: 2 };
  const d = { lon: 2, lat: 0 };

  const result = segmentIntersection(a, b, c, d);

  assert.ok(result !== null, "expected an intersection");
  assert.ok(Math.abs(result!.lon - 1) < 1e-9);
  assert.ok(Math.abs(result!.lat - 1) < 1e-9);
});

test("segmentIntersection: parallel non-overlapping segments do not intersect", () => {
  const a = { lon: 0, lat: 0 };
  const b = { lon: 2, lat: 0 };
  const c = { lon: 0, lat: 1 };
  const d = { lon: 2, lat: 1 };

  assert.equal(segmentIntersection(a, b, c, d), null);
});

test("segmentIntersection: segments that would cross if extended, but don't within their bounds, do not intersect", () => {
  const a = { lon: 0, lat: 0 };
  const b = { lon: 1, lat: 1 };
  const c = { lon: 3, lat: 0 };
  const d = { lon: 3, lat: 1 };

  assert.equal(segmentIntersection(a, b, c, d), null);
});

// T-032a — the geo.ts half of the geodesic-length guard.
// K-04: a length routine that silently returns degrees (or any wrong scale) is
// a factor-of-~90,000 bug; the SpatiaLite half (T-032b) guards ST_Length(geom,
// true). P-16: the prototype measured length with flat-earth meters-per-degree
// constants (M_LAT = 111320) that inflated every stored length by ~0.37% at
// this latitude. Both are one class of failure: the metric no longer matches a
// known ground-truth distance.

test("geodesic-length guard (T-032a, K-04): a spherically-known 100 m segment measures 100 m ± 0.5 through geo.ts", () => {
  // The contract commits to the spherical model (haversine on R =
  // EARTH_RADIUS_M). "Known" here means each endpoint is placed by the inverse
  // relation d = R * theta — a different formula from haversine's sin^2/asin
  // form — so this pins the radius, the degree<->radian handling, and the
  // cos(lat) term on the E-W axis without being circular.
  const R = EARTH_RADIUS_M;
  const origin = { lon: -111.93, lat: 33.42 };
  const degPerRad = 180 / Math.PI;

  // 100 m due north: dLat = (100 / R) rad.
  const north = { lon: origin.lon, lat: origin.lat + (100 / R) * degPerRad };
  const nsLen = haversineM(origin, north);
  assert.ok(Math.abs(nsLen - 100) <= 0.5, `N-S: expected 100 m ± 0.5, got ${nsLen} m`);

  // 100 m due east: dLon = (100 / (R * cos(lat))) rad.
  const east = {
    lon: origin.lon + (100 / (R * Math.cos(origin.lat / degPerRad))) * degPerRad,
    lat: origin.lat,
  };
  const ewLen = haversineM(origin, east);
  assert.ok(Math.abs(ewLen - 100) <= 0.5, `E-W: expected 100 m ± 0.5, got ${ewLen} m`);

  // polylineLengthM must agree with the endpoint distance: two 50 m legs north
  // sum to 100 m within the same tolerance.
  const mid = { lon: origin.lon, lat: origin.lat + (50 / R) * degPerRad };
  const polyLen = polylineLengthM([origin, mid, north]);
  assert.ok(Math.abs(polyLen - 100) <= 0.5, `polyline: expected 100 m ± 0.5, got ${polyLen} m`);
});

test("geodesic-length guard (T-032a, P-16): a flat-earth meters-per-degree constant is caught by the ± 0.5 m tolerance", () => {
  // Defect P-16: the prototype used M_LAT = 111320 m/deg — a near-equatorial
  // value, ~0.37% long at 33.42 N. At 100 m that bias (~0.4 m) hides under the
  // tolerance, so the guard is asserted at 1 km, where it does not: a segment
  // sized to "1000 m" by the flat-earth constant is really ~998.9 m, and
  // haversine reports the true (smaller) value.
  const R = EARTH_RADIUS_M;
  const degPerRad = 180 / Math.PI;
  const origin = { lon: -111.93, lat: 33.42 };
  const M_LAT_FLAT_EARTH = 111320; // prototype's constant — do not reintroduce

  const flatEarthKm = { lon: origin.lon, lat: origin.lat + 1000 / M_LAT_FLAT_EARTH };
  const measured = haversineM(origin, flatEarthKm);
  assert.ok(
    Math.abs(measured - 1000) > 0.5,
    `a flat-earth 1 km segment must measure off by > 0.5 m; got ${measured} m (off by ${Math.abs(measured - 1000)} m)`,
  );

  // The correctly-sized 1 km segment passes the same tolerance.
  const sphericalKm = { lon: origin.lon, lat: origin.lat + (1000 / R) * degPerRad };
  const measuredOk = haversineM(origin, sphericalKm);
  assert.ok(Math.abs(measuredOk - 1000) <= 0.5, `spherical 1 km: expected 1000 m ± 0.5, got ${measuredOk} m`);
});
