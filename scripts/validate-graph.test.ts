import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_FIXTURE_PATH, resolveArtifact } from "../src/domain/load.ts";
import type { GraphFile } from "../src/domain/types.ts";

const SCRIPT = fileURLToPath(new URL("./validate-graph.py", import.meta.url));
const FIXTURE = resolveArtifact(GRAPH_FIXTURE_PATH);

/** First working interpreter among $PYTHON, python3, python, `py -3`. */
function resolvePython(): string[] {
  const candidates: string[][] = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
  candidates.push(["python3"], ["python"], ["py", "-3"]);
  for (const cmd of candidates) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), "--version"], { stdio: "pipe" });
      return cmd;
    } catch {
      /* next */
    }
  }
  throw new Error("no python interpreter found (tried PYTHON, python3, python, py -3)");
}

const PY = resolvePython();

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(PY[0], [...PY.slice(1), SCRIPT, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "sunwalk-vg-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a mutated copy of the fixture into the OS temp dir, never a
 *  source-of-truth directory. */
function brokenCopy(name: string, mutate: (g: GraphFile) => void): string {
  const g = JSON.parse(readFileSync(FIXTURE, "utf8")) as GraphFile;
  mutate(g);
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(g));
  return path;
}

test("temp copies live outside the repo's source-of-truth directories", () => {
  for (const forbidden of ["sources", "overlays", "build", "fixtures"]) {
    assert.ok(!scratch.includes(`${forbidden}`), `scratch dir must not be under ${forbidden}/`);
  }
});

test("exits 0 on the committed fixture with every gate green", () => {
  const { code, out } = run([]);
  assert.equal(code, 0, out);
  assert.match(out, /PASS: all gates green/);
  assert.doesNotMatch(out, /FAIL/);
});

test("validates the same artifact the domain layer loads (src/domain/load.ts)", () => {
  const { out } = run([]);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("artifact:"));
  assert.ok(line, out);
  const reported = line.replace("artifact:", "").trim();
  assert.equal(reported, FIXTURE);
});

test("exits 1 and cites S1 when the artifact violates graph.schema.json", () => {
  const path = brokenCopy("broken-schema.json", (g) => {
    // `category` is a closed enum in the schema.
    (g.buildings[0] as { category: string }).category = "not-a-real-category";
  });
  const { code, out } = run([path]);
  assert.equal(code, 1);
  assert.match(out, /S1 FAIL/);
  assert.match(out, /not-a-real-category/);
});

test("exits 1 and names the edge + endpoint when an edge endpoint is broken (S2)", () => {
  const path = brokenCopy("broken-endpoint.json", (g) => {
    g.edges[3].toNodeId = "node:brokenxxxxxx";
  });
  const { code, out } = run([path]);
  assert.equal(code, 1);
  assert.match(out, /S2 FAIL/);
  assert.match(out, /edge:irnykdsyk7tc/);
  assert.match(out, /node:brokenxxxxxx/);
});

test("exits 1 and cites S5 when an edge geometry endpoint drifts from its node", () => {
  const path = brokenCopy("broken-geom.json", (g) => {
    g.edges[5].geometry[0][0] += 0.00006; // ~5.5 m east of the node
  });
  const { code, out } = run([path]);
  assert.equal(code, 1);
  assert.match(out, /S5 FAIL/);
  assert.match(out, /edge:4gxctozpa3am/);
});

test("exits 1 and cites G4 when lengthM disagrees with the geometry", () => {
  const path = brokenCopy("broken-length.json", (g) => {
    g.edges[2].lengthM += 12.5;
  });
  const { code, out } = run([path]);
  assert.equal(code, 1);
  assert.match(out, /G4 FAIL/);
  assert.match(out, /edge:vw5ov3dauyyn/);
  assert.match(out, /delta 12\.50 m/);
});
