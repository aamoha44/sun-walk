// Geospatial primitives for Sun Walk.
//
// Contract (CONTRIBUTING.md "Units and coordinates"):
// - Coordinates are [longitude, latitude], WGS84 (EPSG:4326).
// - Distances are meters, float, computed by haversine on R = 6,371,008.8 m
//   (IUGG mean earth radius). Never use flat-earth meters-per-degree
//   constants - the previous prototype's M_LAT = 111320 / M_LON = 93080
//   were 0.37% / 0.08% high at this latitude and silently inflated lengths.
// - This module must not import maplibre-gl, react, or anything from
//   src/map/** or src/ui/**, and must run under plain `node --test`.

export const EARTH_RADIUS_M = 6_371_008.8;

export interface LonLat {
  lon: number;
  lat: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Great-circle distance between two WGS84 points, in meters. */
export function haversineM(a: LonLat, b: LonLat): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = toRad(b.lat - a.lat);
  const dLambda = toRad(b.lon - a.lon);

  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Sum of haversine legs between consecutive points, in meters. */
export function polylineLengthM(coords: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1], coords[i]);
  }
  return total;
}

export interface Projection {
  point: LonLat;
  t: number;
  distM: number;
}

/**
 * Closest point on segment a-b to p, clamped to the segment (t in [0,1]).
 *
 * Finds t via a local tangent-plane approximation, valid at the mall/
 * sidewalk scale this graph operates at. The plane's scale factors are
 * derived from EARTH_RADIUS_M and the segment's own latitude on every call -
 * this is not the fixed meters-per-degree constant the contract forbids,
 * which used one global number regardless of latitude.
 */
export function projectPointOnSegment(p: LonLat, a: LonLat, b: LonLat): Projection {
  if (a.lon === b.lon && a.lat === b.lat) {
    return { point: { ...a }, t: 0, distM: haversineM(p, a) };
  }

  const lat0 = toRad((a.lat + b.lat) / 2);
  const mPerDegLon = EARTH_RADIUS_M * Math.cos(lat0) * (Math.PI / 180);
  const mPerDegLat = EARTH_RADIUS_M * (Math.PI / 180);

  const ax = a.lon * mPerDegLon;
  const ay = a.lat * mPerDegLat;
  const bx = b.lon * mPerDegLon;
  const by = b.lat * mPerDegLat;
  const px = p.lon * mPerDegLon;
  const py = p.lat * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.min(1, Math.max(0, t));

  const point: LonLat = {
    lon: a.lon + t * (b.lon - a.lon),
    lat: a.lat + t * (b.lat - a.lat),
  };

  return { point, t, distM: haversineM(p, point) };
}

/** Initial great-circle bearing from a to b, in degrees clockwise from north [0, 360). */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLambda = toRad(b.lon - a.lon);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Ray-casting point-in-polygon test. `ring` is a closed or unclosed simple
 * ring; planar (not geodesic) - correct at building-footprint scale.
 */
export function pointInPolygon(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    const intersects =
      vi.lat > p.lat !== vj.lat > p.lat &&
      p.lon < ((vj.lon - vi.lon) * (p.lat - vi.lat)) / (vj.lat - vi.lat) + vi.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Intersection point of segments a-b and c-d, or null if they don't cross
 * within their own bounds (parallel, collinear, or crossing only if
 * extended). Planar; used for noding at OSM local-geometry scale, not for
 * long geodesic segments.
 */
export function segmentIntersection(
  a: LonLat,
  b: LonLat,
  c: LonLat,
  d: LonLat,
): LonLat | null {
  const r = { lon: b.lon - a.lon, lat: b.lat - a.lat };
  const s = { lon: d.lon - c.lon, lat: d.lat - c.lat };

  const denom = r.lon * s.lat - r.lat * s.lon;
  if (denom === 0) return null; // parallel or collinear

  const ac = { lon: c.lon - a.lon, lat: c.lat - a.lat };
  const t = (ac.lon * s.lat - ac.lat * s.lon) / denom;
  const u = (ac.lon * r.lat - ac.lat * r.lon) / denom;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { lon: a.lon + t * r.lon, lat: a.lat + t * r.lat };
}
