import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { haversineM } from "./geo.ts";
import { loadFixtureGraph } from "./load.ts";
import { CampusStore } from "./store.ts";
import {
  ACCESSIBLE_PROFILE,
  computeRoute,
  DEFAULT_PROFILE,
  findCheapestPath,
} from "./route.ts";
import type { Building, GraphEdge, GraphFile, GraphNode } from "./types.ts";

const GRAPH = loadFixtureGraph();

// Stable ids from the frozen fixture.
const COOR_DOOR = "node:dvt4xswmfxcg"; // Coor Hall west door -> cmM
const PSY_DOOR = "node:dida4an76q7d"; // Psychology north door -> pwS
const CM_MID = "node:vyyyikquzmuw"; // Cady Mall / University crossing
const CM_SOUTH = "node:deogvogtagaq"; // Cady Mall / south cross mall
const PW_SOUTH = "node:dj6fmsxtzj63"; // Palm Walk / south cross mall
const E_COOR_LINK = "edge:r2zcab7khdty";
const E_CADY_MID = "edge:qytdw3hktyhc";
const E_SOUTH_XMALL = "edge:jdwxcitpfctd";
const E_PSY_LINK = "edge:4c2qx7p4bw2d";

test("computeRoute returns the cheapest door-to-door route over the fixture", () => {
  const store = new CampusStore(GRAPH);

  const result = computeRoute(store, {
    fromBuildingId: "bldg:COOR",
    toBuildingId: "bldg:PSY",
    departAtUtc: "2026-01-15T19:00:00Z", // 12:00 America/Phoenix
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { route } = result;

  assert.deepEqual(route.nodeIds, [COOR_DOOR, CM_MID, CM_SOUTH, PW_SOUTH, PSY_DOOR]);
  assert.deepEqual(route.edgeIds, [E_COOR_LINK, E_CADY_MID, E_SOUTH_XMALL, E_PSY_LINK]);
  assert.equal(route.fromNodeId, COOR_DOOR);
  assert.equal(route.toNodeId, PSY_DOOR);
  assert.equal(route.fromBuildingId, "bldg:COOR");
  assert.equal(route.toBuildingId, "bldg:PSY");
  assert.equal(route.profileId, DEFAULT_PROFILE.id);

  // lengthM is geometry: the haversine sum of the four edges.
  assert.ok(
    Math.abs(route.lengthM - 315.98) < 0.05,
    `expected ~315.98 m, got ${route.lengthM}`,
  );
  // estimatedSec is policy time: pure walk time on this path, lengthM / 1.35 m/s.
  assert.ok(
    Math.abs(route.estimatedSec - 315.98 / 1.35) <= 1,
    `expected ~${315.98 / 1.35} s, got ${route.estimatedSec}`,
  );
  assert.ok(Math.abs(route.shadedFraction - 0.15) < 1e-6);
  assert.equal(route.id, `route:${COOR_DOOR}>${PSY_DOOR}@${DEFAULT_PROFILE.id}:12`);
  assert.equal(route.graphHash, GRAPH.manifest.graphHash);
});

/* ---------------------------------------------------------------- helpers */

function freshStore(): CampusStore {
  return new CampusStore(JSON.parse(JSON.stringify(GRAPH)) as GraphFile);
}

const COOR = GRAPH.buildings.find((b) => b.id === "bldg:COOR") as Building;
const PSY = GRAPH.buildings.find((b) => b.id === "bldg:PSY") as Building;

function entrance(
  id: string,
  buildingId: string,
  position: [number, number],
  name: string,
): GraphNode {
  return {
    kind: "node",
    id,
    type: "entrance",
    position,
    buildingId,
    provisional: false,
    entranceName: name,
    label: name,
  };
}

function edge(
  over: Partial<GraphEdge> &
    Pick<GraphEdge, "id" | "fromNodeId" | "toNodeId" | "geometry" | "lengthM">,
): GraphEdge {
  return {
    kind: "edge",
    type: "path",
    name: null,
    surface: "concrete",
    stairs: false,
    stepCount: null,
    covered: false,
    indoor: false,
    accessible: true,
    shadeIndex: 0.15,
    shadeSource: "default",
    synthetic: false,
    osmWayId: null,
    ...over,
  };
}

function building(
  id: string,
  entranceIds: string[],
  over: Partial<Building> = {},
): Building {
  return {
    kind: "building",
    id,
    code: id.replace("bldg:", ""),
    officialName: id,
    displayName: id.replace("bldg:", ""),
    category: "academic",
    centroid: [-111.933, 33.419],
    footprintId: null,
    footprintSource: "none",
    entranceIds,
    gsf: null,
    address: null,
    imageUrl: null,
    inServiceArea: true,
    routable: true,
    unroutableReason: null,
    ...over,
  };
}

function reasonOf(r: ReturnType<typeof computeRoute>): string {
  return r.ok ? "(ok)" : r.reason;
}

/* --------------------------------------------------------- failure modes */

test("unknown_building for an id that is not in the store (either side)", () => {
  const store = freshStore();
  assert.deepEqual(
    computeRoute(store, { fromBuildingId: "bldg:ZZZ", toBuildingId: "bldg:PSY" }),
    { ok: false, reason: "unknown_building", detail: "bldg:ZZZ" },
  );
  assert.deepEqual(
    computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:ZZZ" }),
    { ok: false, reason: "unknown_building", detail: "bldg:ZZZ" },
  );
});

test("same_building when origin equals destination", () => {
  const store = freshStore();
  assert.deepEqual(
    computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:COOR" }),
    { ok: false, reason: "same_building" },
  );
});

test("no_entrance when a building has no entrance nodes", () => {
  const store = freshStore();
  store.put(building("bldg:NODOOR", []));
  assert.equal(
    reasonOf(computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:NODOOR" })),
    "no_entrance",
  );
  assert.equal(
    reasonOf(computeRoute(store, { fromBuildingId: "bldg:NODOOR", toBuildingId: "bldg:PSY" })),
    "no_entrance",
  );
});

test("out_of_service_area when a building is flagged outside the service area", () => {
  const store = freshStore();
  store.put(building("bldg:REMOTE", [...PSY.entranceIds], { inServiceArea: false }));
  assert.equal(
    reasonOf(computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:REMOTE" })),
    "out_of_service_area",
  );
  assert.equal(
    reasonOf(computeRoute(store, { fromBuildingId: "bldg:REMOTE", toBuildingId: "bldg:PSY" })),
    "out_of_service_area",
  );
});

test("disconnected when the destination door sits on an isolated component", () => {
  const store = freshStore();
  store.put(entrance("node:islanddooraa", "bldg:ISLAND", [-111.928, 33.423], "main"));
  store.put(building("bldg:ISLAND", ["node:islanddooraa"]));
  assert.deepEqual(
    computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:ISLAND" }),
    { ok: false, reason: "disconnected", detail: "bldg:COOR -> bldg:ISLAND" },
  );
});

test("no_accessible_route: reachable by default but not under requireAccessible", () => {
  const store = freshStore();
  store.put(entrance("node:gymdoornaaaa", "bldg:GYM", [-111.9331, 33.41655], "main"));
  store.put(
    edge({
      id: "edge:gymstepsaaaa",
      type: "steps",
      fromNodeId: "node:6tqoq2ajr6am",
      toNodeId: "node:gymdoornaaaa",
      geometry: [
        [-111.933, 33.4168],
        [-111.9331, 33.41655],
      ],
      lengthM: 28,
      stairs: true,
      stepCount: 18,
      accessible: false,
    }),
  );
  store.put(building("bldg:GYM", ["node:gymdoornaaaa"], { displayName: "Gymnasium", category: "athletics" }));

  assert.equal(
    computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:GYM" }).ok,
    true,
  );
  assert.deepEqual(
    computeRoute(store, {
      fromBuildingId: "bldg:COOR",
      toBuildingId: "bldg:GYM",
      profile: ACCESSIBLE_PROFILE,
    }),
    { ok: false, reason: "no_accessible_route", detail: "bldg:COOR -> bldg:GYM" },
  );
});

/* ------------------------------------------------------ cost vs geometry */

test("policy cost changes with the profile while geometric lengthM does not", () => {
  const store = freshStore();
  const summerNoon = "2026-07-15T20:00:00Z"; // 13:00 America/Phoenix, peak heat

  const plain = computeRoute(store, {
    fromBuildingId: "bldg:COOR",
    toBuildingId: "bldg:PSY",
    departAtUtc: summerNoon,
  });
  const shaded = computeRoute(store, {
    fromBuildingId: "bldg:COOR",
    toBuildingId: "bldg:PSY",
    departAtUtc: summerNoon,
    profile: { ...DEFAULT_PROFILE, id: "walk-shade", shadeWeight: 1 },
  });
  assert.ok(plain.ok && shaded.ok);
  if (!plain.ok || !shaded.ok) return;

  assert.equal(shaded.route.lengthM, plain.route.lengthM, "geometry unchanged by profile");
  assert.deepEqual(shaded.route.nodeIds, plain.route.nodeIds, "same path, uniform multiplier");
  assert.ok(
    shaded.route.estimatedSec > plain.route.estimatedSec,
    `shade weighting must raise ETA: ${plain.route.estimatedSec} -> ${shaded.route.estimatedSec}`,
  );
  assert.ok(
    Math.abs(plain.route.estimatedSec - plain.route.lengthM / 1.35) <= 1,
    "default ETA is pure walk time on a flat concrete path",
  );
});

/* --------------------------------------------------------- leg generation */

test("legs: named path, a sharp turn, and a final entrance arrival", () => {
  const store = freshStore();
  const result = computeRoute(store, {
    fromBuildingId: "bldg:COOR",
    toBuildingId: "bldg:PSY",
    departAtUtc: "2026-01-15T19:00:00Z",
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  const { legs } = result.route;

  assert.ok(legs.length >= 3, `expected the L-shaped path to split into legs, got ${legs.length}`);
  assert.ok(legs.some((l) => /Cady Mall/.test(l.instruction)), "a leg names Cady Mall");
  const last = legs[legs.length - 1];
  assert.match(last.instruction, /Psychology/);
  assert.match(last.instruction, /north/);
  for (const leg of legs) {
    assert.ok(Number.isFinite(leg.bearing) && leg.bearing >= 0 && leg.bearing < 360);
    assert.ok(leg.instruction.length > 0);
    assert.ok(leg.distanceM > 0);
  }
  assert.ok(Math.abs(legs.reduce((s, l) => s + l.distanceM, 0) - 315.98) < 0.2);
});

test("legs: entering a crossing edge emits a 'cross' leg", () => {
  const store = freshStore();
  store.put(entrance("node:eastdooraaaa", "bldg:EAST", [-111.9339, 33.4194], "west"));
  store.put(
    edge({
      id: "edge:eastlinkaaaaa",
      type: "link",
      fromNodeId: "node:27lbsw5af2xs",
      toNodeId: "node:eastdooraaaa",
      geometry: [
        [-111.9338, 33.4195],
        [-111.9339, 33.4194],
      ],
      lengthM: 15,
    }),
  );
  store.put(building("bldg:EAST", ["node:eastdooraaaa"], { displayName: "East Hall" }));

  const result = computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:EAST" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(
    result.route.legs.some((l) => /cross/i.test(l.instruction)),
    `expected a crossing leg, got: ${result.route.legs.map((l) => l.instruction).join(" | ")}`,
  );
});

test("legs: a steps edge emits a 'stairs' leg", () => {
  const store = freshStore();
  store.put(entrance("node:gymdoornaaaa", "bldg:GYM", [-111.9331, 33.41655], "main"));
  store.put(
    edge({
      id: "edge:gymstepsaaaa",
      type: "steps",
      fromNodeId: "node:6tqoq2ajr6am",
      toNodeId: "node:gymdoornaaaa",
      geometry: [
        [-111.933, 33.4168],
        [-111.9331, 33.41655],
      ],
      lengthM: 28,
      stairs: true,
      stepCount: 18,
      accessible: false,
    }),
  );
  store.put(building("bldg:GYM", ["node:gymdoornaaaa"], { displayName: "Gymnasium" }));

  const result = computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:GYM" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(
    result.route.legs.some((l) => /stair/i.test(l.instruction)),
    `expected a stairs leg, got: ${result.route.legs.map((l) => l.instruction).join(" | ")}`,
  );
});

test("multi-entrance: the search picks the cheapest origin door", () => {
  const store = freshStore();
  store.put(entrance("node:coorfaraaaaaa", "bldg:COOR", [-111.927, 33.4195], "loading"));
  store.put(
    edge({
      id: "edge:coorfarlinkaa",
      type: "link",
      fromNodeId: "node:63lxrmxh6qnh",
      toNodeId: "node:coorfaraaaaaa",
      geometry: [
        [-111.9322, 33.4195],
        [-111.927, 33.4195],
      ],
      lengthM: 482,
    }),
  );
  store.put(building("bldg:COOR", [...COOR.entranceIds, "node:coorfaraaaaaa"]));

  const near = computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:PSY" });
  assert.ok(near.ok);
  if (!near.ok) return;
  assert.equal(near.route.fromNodeId, COOR_DOOR, "the near west door is chosen");
  assert.ok(Math.abs(near.route.lengthM - 315.98) < 0.05);

  store.delete(COOR_DOOR);
  store.delete(E_COOR_LINK);
  store.put(building("bldg:COOR", ["node:coorfaraaaaaa"]));
  const far = computeRoute(store, { fromBuildingId: "bldg:COOR", toBuildingId: "bldg:PSY" });
  assert.ok(far.ok);
  if (!far.ok) return;
  assert.equal(far.route.fromNodeId, "node:coorfaraaaaaa");
  assert.ok(far.route.lengthM > near.route.lengthM);
});

/* ----------------------------------------------------------- performance */

const ALPHA = "abcdefghijklmnopqrstuvwxyz234567";
function b32(n: number, width: number): string {
  let s = "";
  let x = n;
  do {
    s = ALPHA[x % 32] + s;
    x = Math.floor(x / 32);
  } while (x > 0);
  return s.padStart(width, "a");
}

function makeGrid(cols: number, rows: number): GraphFile {
  const baseLon = -111.95;
  const baseLat = 33.4;
  const step = 0.00012;
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  const pos = (c: number, r: number): [number, number] => [
    r6(baseLon + c * step),
    r6(baseLat + r * step),
  ];
  const at = (c: number, r: number): number => r * cols + c;
  const nid = (i: number): string => `node:${b32(i, 10)}`;
  const last = rows * cols - 1;

  const nodes: GraphNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = at(c, r);
      if (i === 0 || i === last) {
        nodes.push({
          kind: "node",
          id: nid(i),
          type: "entrance",
          position: pos(c, r),
          buildingId: i === 0 ? "bldg:GA" : "bldg:GB",
          provisional: false,
        });
      } else {
        nodes.push({ kind: "node", id: nid(i), type: "walkway", position: pos(c, r) });
      }
    }
  }

  const edges: GraphEdge[] = [];
  const link = (a: number, b: number): void => {
    const ap = nodes[a].position;
    const bp = nodes[b].position;
    edges.push({
      kind: "edge",
      id: `edge:${b32(a, 6)}${b32(b, 6)}`,
      type: "path",
      fromNodeId: nid(a),
      toNodeId: nid(b),
      geometry: [ap, bp],
      lengthM:
        Math.round(haversineM({ lon: ap[0], lat: ap[1] }, { lon: bp[0], lat: bp[1] }) * 100) / 100,
      name: null,
      surface: "concrete",
      stairs: false,
      stepCount: null,
      covered: false,
      indoor: false,
      accessible: true,
      shadeIndex: 0.15,
      shadeSource: "default",
      synthetic: false,
      osmWayId: null,
    });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = at(c, r);
      if (c < cols - 1) link(i, at(c + 1, r));
      if (r < rows - 1) link(i, at(c, r + 1));
    }
  }

  return {
    manifest: {
      generatedUtc: "2026-08-28T00:00:00.000Z",
      builderGitRev: "synthgrid",
      inputs: {},
      graphHash: "synthgrid0000000",
      counts: {
        buildings: 2,
        routableBuildings: 2,
        nodes: nodes.length,
        entrances: 2,
        provisionalEntrances: 0,
        crossings: 0,
        edges: edges.length,
        totalLengthM: 0,
        components: 1,
      },
    },
    buildings: [building("bldg:GA", [nid(0)]), building("bldg:GB", [nid(last)])],
    nodes,
    edges,
  };
}

test("performance: p99 single route under 15 ms on a ~15,000-node graph", () => {
  const cols = 123;
  const rows = 122; // 15_006 nodes
  const store = new CampusStore(makeGrid(cols, rows));
  const src = [`node:${b32(0, 10)}`];
  const dst = [`node:${b32(rows * cols - 1, 10)}`];
  const when = new Date("2026-01-15T19:00:00Z");

  for (let i = 0; i < 20; i++) findCheapestPath(store, src, dst, DEFAULT_PROFILE, when);

  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const path = findCheapestPath(store, src, dst, DEFAULT_PROFILE, when);
    samples.push(performance.now() - t0);
    assert.ok(path !== null && path.cost > 0);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  assert.ok(
    p99 < 15,
    `p99 was ${p99.toFixed(2)} ms (median ${samples[100].toFixed(2)} ms)`,
  );
});
