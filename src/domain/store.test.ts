import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixtureGraph } from "./load.ts";
import { CampusStore } from "./store.ts";
import type { Closure, GraphEdge } from "./types.ts";

const GRAPH = loadFixtureGraph();

// Stable ids from tests/fixtures/mini-graph.json (frozen fixture).
const PW_MID = "node:lbyz2kuvxnij"; // Palm Walk / University crossing, degree 3
const EAST_SPUR = "node:63lxrmxh6qnh"; // leaf, degree 1
const EDGE_PW_N = "edge:z7jmvjco36wd"; // Palm Walk north segment, 166.79 m
const EDGE_PW_MIDS = "edge:i5nrdhcm6lza"; // Palm Walk pwM->pwS segment
const EDGE_CM_N = "edge:irnykdsyk7tc"; // Cady Mall cmN->cmM, vertical at lon -111.933

test("get returns the stored entity; require throws on a missing id", () => {
  const store = new CampusStore(GRAPH);

  assert.equal(store.get(PW_MID)?.kind, "node");
  assert.equal(store.get("node:does-not-exist"), undefined);
  assert.equal(store.require("bldg:COOR").id, "bldg:COOR");
  assert.throws(() => store.require("bldg:NOPE"), /bldg:NOPE/);
});

test("graphHash exposes the hydrated manifest's content hash", () => {
  const store = new CampusStore(GRAPH);
  assert.equal(store.graphHash, GRAPH.manifest.graphHash);
});

test("all(kind) enumerates entities of exactly that kind", () => {
  const store = new CampusStore(GRAPH);

  assert.equal(store.all("node").length, 12);
  assert.equal(store.all("edge").length, 14);
  assert.equal(store.all("building").length, 2);
  assert.equal(store.all("closure").length, 0);
  assert.ok(store.all("node").every((n) => n.kind === "node"));
  assert.ok(store.all("edge").every((e) => e.kind === "edge"));
});

test("adjacency is symmetric and every entry carries the edge length", () => {
  const store = new CampusStore(GRAPH);
  const adj = store.adjacency;

  const mid = adj.get(PW_MID) ?? [];
  assert.equal(mid.length, 3, "Palm Walk / University crossing has degree 3");
  for (const entry of mid) {
    assert.ok(entry.edgeId.startsWith("edge:"));
    assert.ok(entry.otherNodeId.startsWith("node:"));
    assert.ok(entry.lengthM > 0);
    // symmetry: the neighbour lists this node back, over the same edge
    const back = adj.get(entry.otherNodeId) ?? [];
    assert.ok(
      back.some((b) => b.otherNodeId === PW_MID && b.edgeId === entry.edgeId),
      `edge ${entry.edgeId} is not mirrored on ${entry.otherNodeId}`,
    );
  }

  assert.equal((adj.get(EAST_SPUR) ?? []).length, 1, "the east spur is a leaf");
});

test("adjacency lengthM equals the referenced edge's lengthM", () => {
  const store = new CampusStore(GRAPH);
  const edge = store.require(EDGE_PW_N) as GraphEdge;

  const entry = (store.adjacency.get(PW_MID) ?? []).find(
    (e) => e.edgeId === EDGE_PW_N,
  );
  assert.ok(entry);
  assert.equal(entry.lengthM, edge.lengthM);
});

test("nearestEdge snaps a point lying on a segment to that edge", () => {
  const store = new CampusStore(GRAPH);

  // Midpoint of the Cady Mall cmN->cmM segment (lon -111.933, lat 33.421..33.4195).
  const hit = store.nearestEdge(-111.933, 33.42025);

  assert.ok(hit);
  assert.equal(hit.edge.id, EDGE_CM_N);
  assert.ok(hit.distM < 1, `expected ~0 m, got ${hit.distM} m`);
});

test("nearestEdge returns the closest edge for an off-path point within tolerance", () => {
  const store = new CampusStore(GRAPH);

  // ~14 m west of Palm Walk, latitude between pwM and pwS.
  const hit = store.nearestEdge(-111.93465, 33.4187);

  assert.ok(hit);
  assert.equal(hit.edge.id, EDGE_PW_MIDS);
  assert.ok(
    hit.distM > 5 && hit.distM < 25,
    `expected 5..25 m, got ${hit.distM} m`,
  );
});

test("nearestEdge gives up past maxDistanceM and returns null", () => {
  const store = new CampusStore(GRAPH);

  assert.equal(store.nearestEdge(-111.9, 33.3), null, "far outside the graph");
  assert.equal(
    store.nearestEdge(-111.93465, 33.4187, 5),
    null,
    "within the graph but past a tight radius",
  );
});

test("one transaction with two puts produces exactly one emit (defect P-22)", async () => {
  const store = new CampusStore(GRAPH);
  let emits = 0;
  const unsub = store.subscribe(() => {
    emits++;
  });

  const closureA: Closure = {
    kind: "closure",
    id: "closure:test-a",
    reason: "test",
    from: "2026-08-28T00:00:00.000Z",
    to: null,
    edgeIds: [],
    nodeIds: [],
    sourceUrl: null,
  };
  const closureB: Closure = { ...closureA, id: "closure:test-b" };

  store.transaction(() => {
    store.put(closureA);
    store.put(closureB);
  });

  assert.equal(emits, 0, "the emit is deferred, not synchronous");
  await Promise.resolve();
  assert.equal(emits, 1, "two puts in one transaction coalesce to one emit");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(emits, 1, "no trailing second emit");

  assert.equal(store.get("closure:test-a")?.id, "closure:test-a");
  assert.equal(store.get("closure:test-b")?.id, "closure:test-b");
  unsub();
});

test("subscribe returns an unsubscribe that stops further notifications", async () => {
  const store = new CampusStore(GRAPH);
  let emits = 0;
  const unsub = store.subscribe(() => {
    emits++;
  });
  unsub();

  store.put({
    kind: "closure",
    id: "closure:test-c",
    reason: "test",
    from: "2026-08-28T00:00:00.000Z",
    to: null,
    edgeIds: [],
    nodeIds: [],
    sourceUrl: null,
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(emits, 0);
});

test("mutations outside a transaction still coalesce to a single emit", async () => {
  const store = new CampusStore(GRAPH);
  let emits = 0;
  store.subscribe(() => {
    emits++;
  });

  const base: Closure = {
    kind: "closure",
    id: "closure:test-d",
    reason: "test",
    from: "2026-08-28T00:00:00.000Z",
    to: null,
    edgeIds: [],
    nodeIds: [],
    sourceUrl: null,
  };
  store.put(base);
  store.put({ ...base, id: "closure:test-e" });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(emits, 1);
});

test("an empty transaction does not emit", async () => {
  const store = new CampusStore(GRAPH);
  let emits = 0;
  store.subscribe(() => {
    emits++;
  });

  store.transaction(() => {});
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(emits, 0);
});
