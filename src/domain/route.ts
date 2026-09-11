// Reference router for Sun Walk — plain Dijkstra with a binary heap.
//
// Contract: docs/specs/05-routing-and-cost.md (§1 separation, §2 profile, §3 cost,
// §5 algorithm, §6 typed failures, §7/§5.8 legs, §8 route identity) and
// docs/specs/11-system-architecture.md §5.1–5.8.
//
// This is the *reference* implementation: exhaustive Dijkstra, multi-source over
// every origin door, multi-target over every destination door, terminating when
// the first target is **settled** (not when first relaxed — K-12). It stays
// simple on purpose; bidirectional A* (T-044) is asserted against it later.
// It does not touch the binary runtime export or the Web Worker (T-035+).
//
// Layering: domain-only. No react / maplibre / src/map / src/ui imports.

import { bearingDeg, haversineM, type LonLat } from "./geo.ts";
import type { CampusStore } from "./store.ts";
import type {
  Building,
  EntityId,
  GraphEdge,
  GraphNode,
  Position,
  Profile,
  Route,
  RouteLeg,
  RouteResult,
  Surface,
} from "./types.ts";

/* --------------------------------------------------------------- profiles */

export const DEFAULT_PROFILE: Profile = {
  id: "walk-default",
  walkSpeedMps: 1.35,
  avoidStairs: false,
  requireAccessible: false,
  shadeWeight: 0,
  crossingPenaltySec: 20,
};

export const ACCESSIBLE_PROFILE: Profile = {
  id: "walk-accessible",
  walkSpeedMps: 1.35,
  avoidStairs: true,
  requireAccessible: true,
  shadeWeight: 0,
  crossingPenaltySec: 20,
};

export interface RouteQuery {
  fromBuildingId: EntityId;
  toBuildingId: EntityId;
  /** Defaults to {@link DEFAULT_PROFILE}. */
  profile?: Profile;
  /** ISO 8601 UTC. Defaults to now. Only affects cost when `shadeWeight > 0`. */
  departAtUtc?: string;
}

/* ----------------------------------------------------------------- public */

export function computeRoute(store: CampusStore, query: RouteQuery): RouteResult {
  const profile = query.profile ?? DEFAULT_PROFILE;
  const now = new Date(query.departAtUtc ?? new Date().toISOString());

  const from = store.get(query.fromBuildingId);
  const to = store.get(query.toBuildingId);
  if (from === undefined || from.kind !== "building") {
    return { ok: false, reason: "unknown_building", detail: query.fromBuildingId };
  }
  if (to === undefined || to.kind !== "building") {
    return { ok: false, reason: "unknown_building", detail: query.toBuildingId };
  }
  if (query.fromBuildingId === query.toBuildingId) {
    return { ok: false, reason: "same_building" };
  }
  if (!from.inServiceArea) {
    return { ok: false, reason: "out_of_service_area", detail: query.fromBuildingId };
  }
  if (!to.inServiceArea) {
    return { ok: false, reason: "out_of_service_area", detail: query.toBuildingId };
  }

  const originDoors = entranceNodeIds(store, from);
  const destDoors = entranceNodeIds(store, to);
  if (originDoors.length === 0) {
    return { ok: false, reason: "no_entrance", detail: query.fromBuildingId };
  }
  if (destDoors.length === 0) {
    return { ok: false, reason: "no_entrance", detail: query.toBuildingId };
  }

  const path = findCheapestPath(store, originDoors, destDoors, profile, now);
  if (path === null) {
    // Distinguish "not under this profile" from "genuine graph gap" (P-24).
    if (profile.requireAccessible) {
      const fallback = findCheapestPath(store, originDoors, destDoors, DEFAULT_PROFILE, now);
      if (fallback !== null) {
        return {
          ok: false,
          reason: "no_accessible_route",
          detail: `${query.fromBuildingId} -> ${query.toBuildingId}`,
        };
      }
    }
    return {
      ok: false,
      reason: "disconnected",
      detail: `${query.fromBuildingId} -> ${query.toBuildingId}`,
    };
  }

  let geomLengthM = 0;
  let shadedLengthM = 0;
  for (const edgeId of path.edgeIds) {
    const edge = store.require(edgeId) as GraphEdge;
    geomLengthM += edge.lengthM;
    shadedLengthM += edge.lengthM * edge.shadeIndex;
  }
  const lengthM = round2(geomLengthM);

  const route: Route = {
    kind: "route",
    id: `route:${path.fromNodeId}>${path.toNodeId}@${profile.id}:${phoenixParts(now).hour}`,
    fromBuildingId: query.fromBuildingId,
    toBuildingId: query.toBuildingId,
    fromNodeId: path.fromNodeId,
    toNodeId: path.toNodeId,
    nodeIds: path.nodeIds,
    edgeIds: path.edgeIds,
    legs: generateLegs(store, path, to),
    lengthM,
    estimatedSec: Math.round(path.cost),
    profileId: profile.id,
    shadedFraction: lengthM > 0 ? round4(shadedLengthM / geomLengthM) : 0,
    graphHash: store.graphHash,
  };
  return { ok: true, route };
}

/* --------------------------------------------------------------- Dijkstra */

interface PathResult {
  cost: number;
  nodeIds: EntityId[];
  edgeIds: EntityId[];
  fromNodeId: EntityId;
  toNodeId: EntityId;
}

/**
 * Cheapest path from any node in `sources` (seeded at cost 0) to any node in
 * `targets`. Returns `null` when no target is reachable under `profile`.
 *
 * Runs over a dense-index adjacency (built once per graph version, cached on the
 * `store.adjacency` identity) so it clears gate P3 at V ≈ 15,000. It is still a
 * plain exhaustive Dijkstra — no heuristic — and it is NOT the binary runtime
 * export (T-035): no file format, no CSR-on-ArrayBuffer, no worker.
 * Exported for the T-005 performance benchmark.
 */
export function findCheapestPath(
  store: CampusStore,
  sources: readonly EntityId[],
  targets: readonly EntityId[],
  profile: Profile,
  now: Date,
): PathResult | null {
  const g = compactGraph(store);
  const heat = profile.shadeWeight > 0 ? heatFactorAt(now) : 0;

  const srcIdx: number[] = [];
  for (const s of sources) {
    const i = g.index.get(s);
    if (i !== undefined) srcIdx.push(i);
  }
  const tgtIdx = new Set<number>();
  for (const t of targets) {
    const i = g.index.get(t);
    if (i !== undefined) tgtIdx.add(i);
  }
  if (srcIdx.length === 0 || tgtIdx.size === 0) return null;

  // Persistent scratch, reused across queries; a generation stamp replaces an
  // O(V) reset of `dist`/`settled` per query (docs/specs/11 §5.2). Full generation-
  // stamped scratch buffers for the production worker are T-041.
  const sc = g.scratch;
  const gen = ++sc.gen;
  const { dist, distGen, settledGen, prevN, prevE, heap } = sc;
  heap.clear();

  for (const s of srcIdx) {
    if (distGen[s] !== gen || dist[s] > 0) {
      dist[s] = 0;
      distGen[s] = gen;
      prevN[s] = -1;
      prevE[s] = -1;
      heap.push(0, s);
    }
  }

  const speed = profile.walkSpeedMps;
  const shadeWeight = profile.shadeWeight;
  const crossPen = profile.crossingPenaltySec;
  const requireAccessible = profile.requireAccessible;
  const avoidStairs = profile.avoidStairs;

  let hit = -1;
  while (heap.size > 0) {
    const u = heap.popValue();
    if (settledGen[u] === gen) continue; // lazy deletion
    settledGen[u] = gen;
    if (tgtIdx.has(u)) {
      hit = u;
      break;
    }
    const du = dist[u];
    for (let p = g.rowOffset[u]; p < g.rowOffset[u + 1]; p++) {
      const v = g.adjTarget[p];
      if (settledGen[v] === gen) continue;
      const e = g.adjEdge[p];
      if (requireAccessible && (g.edgeStairs[e] === 1 || g.edgeAccessible[e] === 0)) {
        continue; // `accessible === null` (unknown) stays in — K-17
      }
      const walk = g.edgeLen[e] / (speed * g.edgeSurfFactor[e]);
      const timeSeconds =
        walk + g.edgeStepPen[e] + (g.nodeIsCrossing[v] === 1 ? crossPen : 0);
      let cost = timeSeconds * (1 + shadeWeight * (1 - g.edgeShadeIndex[e]) * heat);
      if (avoidStairs && g.edgeStairs[e] === 1) cost *= 4;
      const nd = du + cost;
      if (distGen[v] !== gen || nd < dist[v]) {
        dist[v] = nd;
        distGen[v] = gen;
        prevN[v] = u;
        prevE[v] = e;
        heap.push(nd, v);
      }
    }
  }
  if (hit === -1) return null;

  const nodeIds: EntityId[] = [g.ids[hit]];
  const edgeIds: EntityId[] = [];
  let cur = hit;
  while (prevN[cur] !== -1) {
    edgeIds.push(g.edgeIds[prevE[cur]]);
    cur = prevN[cur];
    nodeIds.push(g.ids[cur]);
  }
  nodeIds.reverse();
  edgeIds.reverse();
  return { cost: dist[hit], nodeIds, edgeIds, fromNodeId: nodeIds[0], toNodeId: g.ids[hit] };
}

/* ------------------------------------------------------- compact adjacency */

interface RouteScratch {
  dist: Float64Array;
  distGen: Int32Array;
  settledGen: Int32Array;
  prevN: Int32Array;
  prevE: Int32Array;
  heap: MinHeapNum;
  gen: number;
}

interface CompactGraph {
  index: Map<EntityId, number>;
  ids: EntityId[];
  nodeIsCrossing: Uint8Array;
  rowOffset: Int32Array;
  adjTarget: Int32Array;
  adjEdge: Int32Array;
  edgeIds: EntityId[];
  edgeLen: Float64Array;
  edgeSurfFactor: Float64Array;
  edgeStepPen: Float64Array;
  edgeShadeIndex: Float64Array;
  edgeStairs: Uint8Array;
  edgeAccessible: Int8Array; // -1 unknown, 0 no, 1 yes
  scratch: RouteScratch;
}

const compactCache = new WeakMap<object, CompactGraph>();

/** Cached on `store.adjacency` identity; the store swaps that Map on any
 *  node/edge mutation, so the cache invalidates itself. */
function compactGraph(store: CampusStore): CompactGraph {
  const adjacency = store.adjacency;
  const cached = compactCache.get(adjacency);
  if (cached !== undefined) return cached;

  const nodes = store.all("node");
  const V = nodes.length;
  const index = new Map<EntityId, number>();
  const ids: EntityId[] = new Array(V);
  const nodeIsCrossing = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    index.set(nodes[i].id, i);
    ids[i] = nodes[i].id;
    if (nodes[i].type === "crossing") nodeIsCrossing[i] = 1;
  }

  const edges = store.all("edge");
  const E = edges.length;
  const edgeIndex = new Map<EntityId, number>();
  const edgeIds: EntityId[] = new Array(E);
  const edgeLen = new Float64Array(E);
  const edgeSurfFactor = new Float64Array(E);
  const edgeStepPen = new Float64Array(E);
  const edgeShadeIndex = new Float64Array(E);
  const edgeStairs = new Uint8Array(E);
  const edgeAccessible = new Int8Array(E);
  for (let e = 0; e < E; e++) {
    const edge = edges[e];
    edgeIndex.set(edge.id, e);
    edgeIds[e] = edge.id;
    edgeLen[e] = edge.lengthM;
    edgeSurfFactor[e] = surfaceFactor(edge.surface);
    edgeStairs[e] = edge.stairs ? 1 : 0;
    edgeStepPen[e] = edge.stairs ? (edge.stepCount !== null ? edge.stepCount * 0.9 : 12) : 0;
    edgeShadeIndex[e] = edge.shadeIndex;
    edgeAccessible[e] = edge.accessible === null ? -1 : edge.accessible ? 1 : 0;
  }

  const rowOffset = new Int32Array(V + 1);
  for (let i = 0; i < V; i++) {
    rowOffset[i + 1] = rowOffset[i] + (adjacency.get(ids[i])?.length ?? 0);
  }
  const arcs = rowOffset[V];
  const adjTarget = new Int32Array(arcs);
  const adjEdge = new Int32Array(arcs);
  for (let i = 0; i < V; i++) {
    let p = rowOffset[i];
    for (const entry of adjacency.get(ids[i]) ?? []) {
      adjTarget[p] = index.get(entry.otherNodeId) as number;
      adjEdge[p] = edgeIndex.get(entry.edgeId) as number;
      p++;
    }
  }

  const g: CompactGraph = {
    index,
    ids,
    nodeIsCrossing,
    rowOffset,
    adjTarget,
    adjEdge,
    edgeIds,
    edgeLen,
    edgeSurfFactor,
    edgeStepPen,
    edgeShadeIndex,
    edgeStairs,
    edgeAccessible,
    scratch: {
      dist: new Float64Array(V),
      distGen: new Int32Array(V),
      settledGen: new Int32Array(V),
      prevN: new Int32Array(V),
      prevE: new Int32Array(V),
      heap: new MinHeapNum(2 * V),
      gen: 0,
    },
  };
  compactCache.set(adjacency, g);
  return g;
}

/* ------------------------------------------------------------------- cost */

// The edge cost is docs/specs/05 §3, inlined in the Dijkstra relaxation loop:
//   timeSeconds = lengthM/(speed·surfaceFactor) + stairsPenalty + crossingPenalty
//   cost        = timeSeconds · (1 + shadeWeight·(1 - shadeIndex)·heatFactor)
//   cost       ·= 4   when avoidStairs and the edge has stairs (reachable, but
//                     strongly discouraged rather than excluded).
// `lengthM` (geometry) enters only divided by speed; it is never mutated.

/**
 * docs/specs/05 §3 lists paved/gravel/grass/sand/unknown. `concrete` and `asphalt`
 * are hard paved surfaces and take the paved factor (1.0). See 08-decisions.md.
 */
function surfaceFactor(surface: Surface): number {
  switch (surface) {
    case "paved":
    case "concrete":
    case "asphalt":
      return 1.0;
    case "gravel":
      return 0.9;
    case "grass":
      return 0.85;
    case "sand":
      return 0.7;
    case "unknown":
      return 0.95;
  }
}

/** America/Phoenix, no DST — a fixed UTC-7 offset, always. */
function phoenixParts(utc: Date): { month: number; hour: number; minute: number } {
  const local = new Date(utc.getTime() - 7 * 3_600_000);
  return {
    month: local.getUTCMonth() + 1,
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/**
 * docs/specs/05 §3: 0 at night and in winter, up to 1.0 at 13:00–17:00 May–September.
 * Deliberately crude — a placeholder until a real heat model exists.
 */
function heatFactorAt(utc: Date): number {
  const { month, hour, minute } = phoenixParts(utc);
  const h = hour + minute / 60;
  const monthFactor =
    month >= 5 && month <= 9 ? 1 : month === 4 || month === 10 ? 0.5 : month === 3 || month === 11 ? 0.2 : 0;
  const hourFactor =
    h < 8 || h >= 20 ? 0 : h < 13 ? (h - 8) / 5 : h <= 17 ? 1 : (20 - h) / 3;
  return monthFactor * hourFactor;
}

/* ------------------------------------------------------------------- legs */

function generateLegs(store: CampusStore, path: PathResult, toBuilding: Building): RouteLeg[] {
  interface Raw {
    edgeIds: EntityId[];
    distanceM: number;
    bearing: number;
  }
  const raw: Raw[] = [];
  let cur: Raw | null = null;
  let prevEdge: GraphEdge | null = null;
  let prevTrailing = 0;
  const n = path.edgeIds.length;

  for (let i = 0; i < n; i++) {
    const edge = store.require(path.edgeIds[i]) as GraphEdge;
    const coords = travelCoords(edge, path.nodeIds[i]);
    const lead = leadingBearing(coords);
    const trail = trailingBearing(coords);
    const isLast = i === n - 1;

    let boundary = cur === null;
    if (!boundary && prevEdge !== null) {
      if (edge.type === "crossing" || prevEdge.type === "crossing") boundary = true;
      else if (edge.type === "steps" || prevEdge.type === "steps") boundary = true;
      else if (edge.name !== null && prevEdge.name !== null && edge.name !== prevEdge.name) {
        boundary = true;
      } else if (angleDiff(prevTrailing, lead) > 35) boundary = true;
    }
    if (!boundary && isLast && edge.type === "link" && cur !== null) boundary = true;

    if (boundary) {
      if (cur !== null) raw.push(cur);
      cur = { edgeIds: [], distanceM: 0, bearing: lead };
    }
    (cur as Raw).edgeIds.push(edge.id);
    (cur as Raw).distanceM += edge.lengthM;
    prevEdge = edge;
    prevTrailing = trail;
  }
  if (cur !== null) raw.push(cur);

  return raw.map((leg, idx) => ({
    edgeIds: leg.edgeIds,
    instruction: instructionFor(store, leg, idx === 0, idx === raw.length - 1, path, toBuilding),
    distanceM: round2(leg.distanceM),
    bearing: Math.round(leg.bearing),
  }));
}

function instructionFor(
  store: CampusStore,
  leg: { edgeIds: EntityId[]; distanceM: number; bearing: number },
  isFirst: boolean,
  isFinal: boolean,
  path: PathResult,
  toBuilding: Building,
): string {
  const first = store.require(leg.edgeIds[0]) as GraphEdge;
  if (isFinal && first.type === "link") {
    const door = store.require(path.toNodeId) as GraphNode;
    const where = door.entranceName ? ` (${door.entranceName} entrance)` : "";
    return `Arrive at ${toBuilding.displayName}${where}`;
  }
  if (first.type === "crossing") return "Cross the street";
  if (first.type === "steps") return first.stairs ? "Take the stairs" : "Take the ramp";
  if (first.name !== null) return `${isFirst ? "Walk" : "Continue"} along ${first.name}`;
  return `Head ${compass(leg.bearing)} for ${Math.round(leg.distanceM)} m`;
}

/* -------------------------------------------------------------- geometry */

const ll = (p: Position): LonLat => ({ lon: p[0], lat: p[1] });

function travelCoords(edge: GraphEdge, fromNodeId: EntityId): Position[] {
  return edge.fromNodeId === fromNodeId ? edge.geometry : [...edge.geometry].reverse();
}

/** Position `target` metres along the polyline, clamped to its end. */
function pointAlong(coords: Position[], target: number): Position {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineM(ll(coords[i - 1]), ll(coords[i]));
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      return [
        coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
        coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}

/** Heading over the first 10 m of travel (falls back to whole-edge). */
function leadingBearing(coords: Position[]): number {
  const p = pointAlong(coords, 10);
  const start = coords[0];
  const end = coords[coords.length - 1];
  if (p[0] === start[0] && p[1] === start[1]) return bearingDeg(ll(start), ll(end));
  return bearingDeg(ll(start), ll(p));
}

/** Heading over the last 10 m of travel (falls back to whole-edge). */
function trailingBearing(coords: Position[]): number {
  const reversed = [...coords].reverse();
  const p = pointAlong(reversed, 10);
  const end = coords[coords.length - 1];
  if (p[0] === end[0] && p[1] === end[1]) return bearingDeg(ll(coords[0]), ll(end));
  return bearingDeg(ll(p), ll(end));
}

const COMPASS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
] as const;

function compass(deg: number): string {
  const norm = (((deg % 360) + 360) % 360) / 45;
  return COMPASS[Math.round(norm) % 8];
}

/** Smallest absolute difference between two bearings, in degrees [0, 180]. */
function angleDiff(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

/* --------------------------------------------------------------- helpers */

function entranceNodeIds(store: CampusStore, building: Building): EntityId[] {
  const out: EntityId[] = [];
  for (const id of building.entranceIds) {
    const node = store.get(id);
    if (node !== undefined && node.kind === "node" && node.type === "entrance") {
      out.push(node.id);
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/* ----------------------------------------------------------- binary heap */

/**
 * Min-heap over (f64 key, i32 value) on typed-array storage. Real sift-up /
 * sift-down — never a `sort()` per pop (defect P-23, gate P3). Grows on demand;
 * the initial `2V` capacity (docs/specs/11 §5.2) covers lazy-deletion Dijkstra.
 */
class MinHeapNum {
  #keys: Float64Array;
  #vals: Int32Array;
  #n = 0;

  constructor(capacity: number) {
    const cap = Math.max(16, capacity);
    this.#keys = new Float64Array(cap);
    this.#vals = new Int32Array(cap);
  }

  get size(): number {
    return this.#n;
  }

  clear(): void {
    this.#n = 0;
  }

  push(key: number, value: number): void {
    if (this.#n === this.#keys.length) this.#grow();
    const k = this.#keys;
    const v = this.#vals;
    let i = this.#n++;
    k[i] = key;
    v[i] = value;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent] <= k[i]) break;
      const tk = k[parent];
      k[parent] = k[i];
      k[i] = tk;
      const tv = v[parent];
      v[parent] = v[i];
      v[i] = tv;
      i = parent;
    }
  }

  /** Remove and return the value with the smallest key. Caller guards `size`. */
  popValue(): number {
    const k = this.#keys;
    const v = this.#vals;
    const top = v[0];
    const n = --this.#n;
    if (n > 0) {
      k[0] = k[n];
      v[0] = v[n];
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < n && k[left] < k[smallest]) smallest = left;
        if (right < n && k[right] < k[smallest]) smallest = right;
        if (smallest === i) break;
        const tk = k[smallest];
        k[smallest] = k[i];
        k[i] = tk;
        const tv = v[smallest];
        v[smallest] = v[i];
        v[i] = tv;
        i = smallest;
      }
    }
    return top;
  }

  #grow(): void {
    const nextKeys = new Float64Array(this.#keys.length * 2);
    const nextVals = new Int32Array(this.#vals.length * 2);
    nextKeys.set(this.#keys);
    nextVals.set(this.#vals);
    this.#keys = nextKeys;
    this.#vals = nextVals;
  }
}
