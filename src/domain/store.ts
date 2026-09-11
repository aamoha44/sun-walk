// CampusStore — identity, indexes, and coalesced change notification.
//
// Contract (docs/specs/01-architecture.md "Store"):
//  - Every object is reachable by id; references between objects are ids.
//  - `adjacency` is Map<nodeId, {edgeId, otherNodeId, lengthM}[]>, undirected.
//  - `nearestEdge` is backed by a uniform grid — sufficient at campus scale.
//  - `emit()` is batched with queueMicrotask. Mutations are wrapped in
//    `transaction(fn)` and produce exactly one emit at the end (defect P-22:
//    the prototype fired one emit per mutation and double-rendered).
//
// Scope note: `project*()` GeoJSON methods and the route cache described in the
// same architecture section are deferred to their consuming tickets (map
// integration T-050, routing/caching T-005). This module implements only the
// members T-004 enumerates.
//
// Layering: this module is domain-only. It must not import maplibre-gl, react,
// or anything from src/map/** or src/ui/**, and must run under `node --test`.

import { EARTH_RADIUS_M, projectPointOnSegment, type LonLat } from "./geo.ts";
import type {
  Building,
  Closure,
  Entity,
  EntityId,
  GraphEdge,
  GraphFile,
  GraphNode,
  Position,
  Route,
  Session,
} from "./types.ts";

/** One undirected step out of a node. */
export interface AdjacencyEntry {
  edgeId: EntityId;
  otherNodeId: EntityId;
  /** The referenced edge's geometric length, copied for the router's inner loop. */
  lengthM: number;
}

/** Result of snapping a coordinate onto the walk network. */
export interface NearestEdgeHit {
  edge: GraphEdge;
  /** Closest point on the edge polyline, `[lon, lat]`, 6 dp. */
  point: Position;
  /** Haversine distance from the query point to `point`, meters. */
  distM: number;
}

const RAD = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * RAD;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const toLonLat = (p: Position): LonLat => ({ lon: p[0], lat: p[1] });

/** Grid cell edge length. 50 m keeps buckets small at ~2 km campus extent. */
const CELL_SIZE_M = 50;
/** Default snap radius; matches the runtime index's give-up distance (T-047). */
const DEFAULT_MAX_SNAP_M = 125;

interface GridMeta {
  minLon: number;
  minLat: number;
  mPerDegLon: number;
}

export class CampusStore {
  #entities = new Map<EntityId, Entity>();

  #adjacency = new Map<EntityId, AdjacencyEntry[]>();
  #grid = new Map<string, EntityId[]>();
  #gridMeta: GridMeta = { minLon: 0, minLat: 0, mPerDegLon: M_PER_DEG_LAT };
  #indexesDirty = true;

  #listeners = new Set<() => void>();
  #txDepth = 0;
  #pendingInTx = false;
  #emitScheduled = false;

  #graphHash: string;

  constructor(graph: GraphFile) {
    this.#graphHash = graph.manifest.graphHash;
    for (const b of graph.buildings) this.#entities.set(b.id, b);
    for (const n of graph.nodes) this.#entities.set(n.id, n);
    for (const e of graph.edges) this.#entities.set(e.id, e);
    // Hydration is not a mutation: no emit, indexes build lazily on first read.
  }

  /* -------------------------------------------------------------- identity */

  /** Content hash of the hydrated graph — the invalidation key for `Route`. */
  get graphHash(): string {
    return this.#graphHash;
  }

  get(id: EntityId): Entity | undefined {
    return this.#entities.get(id);
  }

  require(id: EntityId): Entity {
    const found = this.#entities.get(id);
    if (found === undefined) throw new Error(`CampusStore: no entity with id ${id}`);
    return found;
  }

  /* ----------------------------------------------------------- enumeration */

  all(kind: "building"): Building[];
  all(kind: "node"): GraphNode[];
  all(kind: "edge"): GraphEdge[];
  all(kind: "route"): Route[];
  all(kind: "closure"): Closure[];
  all(kind: "session"): Session[];
  all(kind: Entity["kind"]): Entity[] {
    const out: Entity[] = [];
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind) out.push(entity);
    }
    return out;
  }

  /* -------------------------------------------------------------- indexes */

  get adjacency(): ReadonlyMap<EntityId, readonly AdjacencyEntry[]> {
    this.#ensureIndexes();
    return this.#adjacency;
  }

  nearestEdge(
    lon: number,
    lat: number,
    maxDistanceM: number = DEFAULT_MAX_SNAP_M,
  ): NearestEdgeHit | null {
    this.#ensureIndexes();
    if (this.#grid.size === 0) return null;

    const q: LonLat = { lon, lat };
    const { minLon, minLat, mPerDegLon } = this.#gridMeta;
    const qCol = Math.floor(((lon - minLon) * mPerDegLon) / CELL_SIZE_M);
    const qRow = Math.floor(((lat - minLat) * M_PER_DEG_LAT) / CELL_SIZE_M);
    const maxRing = Math.ceil(maxDistanceM / CELL_SIZE_M) + 1;

    const tested = new Set<EntityId>();
    let best: NearestEdgeHit | null = null;
    let bestDistM = Infinity;

    for (let ring = 0; ring <= maxRing; ring++) {
      for (let col = qCol - ring; col <= qCol + ring; col++) {
        for (let row = qRow - ring; row <= qRow + ring; row++) {
          // Chebyshev shell only — inner cells were covered by earlier rings.
          if (Math.max(Math.abs(col - qCol), Math.abs(row - qRow)) !== ring) {
            continue;
          }
          const bucket = this.#grid.get(`${col}:${row}`);
          if (bucket === undefined) continue;

          for (const edgeId of bucket) {
            if (tested.has(edgeId)) continue;
            tested.add(edgeId);
            const edge = this.#entities.get(edgeId) as GraphEdge;

            for (let i = 1; i < edge.geometry.length; i++) {
              const proj = projectPointOnSegment(
                q,
                toLonLat(edge.geometry[i - 1]),
                toLonLat(edge.geometry[i]),
              );
              if (proj.distM < bestDistM) {
                bestDistM = proj.distM;
                best = {
                  edge,
                  point: [round6(proj.point.lon), round6(proj.point.lat)],
                  distM: proj.distM,
                };
              }
            }
          }
        }
      }

      // Every cell in the next ring is at least `ring * CELL_SIZE_M` from the
      // query point, so a closer edge cannot be hiding there.
      if (best !== null && bestDistM <= ring * CELL_SIZE_M) break;
    }

    if (best === null || bestDistM > maxDistanceM) return null;
    return best;
  }

  /* --------------------------------------------------------- notification */

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Run `fn`, then emit **once** if anything changed. Nested transactions
   * coalesce into the outermost one.
   */
  transaction(fn: () => void): void {
    this.#txDepth++;
    try {
      fn();
    } finally {
      this.#txDepth--;
      if (this.#txDepth === 0 && this.#pendingInTx) {
        this.#pendingInTx = false;
        this.#scheduleEmit();
      }
    }
  }

  put(entity: Entity): void {
    this.#entities.set(entity.id, entity);
    if (entity.kind === "node" || entity.kind === "edge") this.#indexesDirty = true;
    this.#markDirty();
  }

  delete(id: EntityId): boolean {
    const existing = this.#entities.get(id);
    if (existing === undefined) return false;
    this.#entities.delete(id);
    if (existing.kind === "node" || existing.kind === "edge") {
      this.#indexesDirty = true;
    }
    this.#markDirty();
    return true;
  }

  /* -------------------------------------------------------------- private */

  #markDirty(): void {
    if (this.#txDepth > 0) {
      this.#pendingInTx = true;
    } else {
      this.#scheduleEmit();
    }
  }

  #scheduleEmit(): void {
    if (this.#emitScheduled) return;
    this.#emitScheduled = true;
    queueMicrotask(() => {
      this.#emitScheduled = false;
      for (const listener of this.#listeners) listener();
    });
  }

  #ensureIndexes(): void {
    if (!this.#indexesDirty) return;
    this.#buildAdjacency();
    this.#buildGrid();
    this.#indexesDirty = false;
  }

  #buildAdjacency(): void {
    const adjacency = new Map<EntityId, AdjacencyEntry[]>();
    for (const node of this.all("node")) adjacency.set(node.id, []);

    for (const edge of this.all("edge")) {
      const forward = adjacency.get(edge.fromNodeId);
      const backward = adjacency.get(edge.toNodeId);
      // An edge whose endpoints are not both real nodes is a data bug; skip it
      // here rather than crash — the structural validator (T-006) is what fails.
      if (forward === undefined || backward === undefined) continue;
      forward.push({ edgeId: edge.id, otherNodeId: edge.toNodeId, lengthM: edge.lengthM });
      backward.push({ edgeId: edge.id, otherNodeId: edge.fromNodeId, lengthM: edge.lengthM });
    }

    this.#adjacency = adjacency;
  }

  #buildGrid(): void {
    const grid = new Map<string, Set<EntityId>>();
    const nodes = this.all("node");
    if (nodes.length === 0) {
      this.#grid = new Map();
      return;
    }

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const node of nodes) {
      const [lon, lat] = node.position;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const meanLat = (minLat + maxLat) / 2;
    const mPerDegLon = M_PER_DEG_LAT * Math.cos(meanLat * RAD);
    this.#gridMeta = { minLon, minLat, mPerDegLon };

    const colOf = (lon: number): number =>
      Math.floor(((lon - minLon) * mPerDegLon) / CELL_SIZE_M);
    const rowOf = (lat: number): number =>
      Math.floor(((lat - minLat) * M_PER_DEG_LAT) / CELL_SIZE_M);

    const add = (col: number, row: number, edgeId: EntityId): void => {
      const key = `${col}:${row}`;
      let cell = grid.get(key);
      if (cell === undefined) {
        cell = new Set();
        grid.set(key, cell);
      }
      cell.add(edgeId);
    };

    for (const edge of this.all("edge")) {
      for (let i = 1; i < edge.geometry.length; i++) {
        const [aLon, aLat] = edge.geometry[i - 1];
        const [bLon, bLat] = edge.geometry[i];
        const c0 = Math.min(colOf(aLon), colOf(bLon));
        const c1 = Math.max(colOf(aLon), colOf(bLon));
        const r0 = Math.min(rowOf(aLat), rowOf(bLat));
        const r1 = Math.max(rowOf(aLat), rowOf(bLat));
        for (let col = c0; col <= c1; col++) {
          for (let row = r0; row <= r1; row++) add(col, row, edge.id);
        }
      }
    }

    const flat = new Map<string, EntityId[]>();
    for (const [key, ids] of grid) flat.set(key, [...ids]);
    this.#grid = flat;
  }
}
