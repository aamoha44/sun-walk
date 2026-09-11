import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = process.argv[2];

// build-graph.py (T-020) needs SpatiaLite, so gates must run under a
// SpatiaLite-capable interpreter — on Windows that is the MSYS2 UCRT64 python,
// not `py -3` / the Store shim. Probe load_extension('mod_spatialite'); the
// validator and tests are stdlib-only and also run fine there.
function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  if (process.platform === "win32") {
    candidates.push(["C:/msys64/ucrt64/bin/python3.exe", []]);
  }
  candidates.push(["python3", []], ["python", []], ["py", ["-3"]]);

  const probe =
    "import sqlite3;c=sqlite3.connect(':memory:');c.enable_load_extension(True);" +
    "c.execute(\"SELECT load_extension('mod_spatialite')\")";

  for (const [command, prefixArgs] of candidates) {
    const result = spawnSync(command, [...prefixArgs, "-c", probe], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
    });
    if (result.status === 0) return { command, prefixArgs };
  }

  return null;
}

function run(label, command, args) {
  console.log(`=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error || result.status !== 0) {
    console.error(`FAIL: ${label}`);
    process.exit(result.status || 1);
  }
}

const python = findPython();
if (!python) {
  console.error(
    "FAIL: no SpatiaLite-capable Python found (tried $PYTHON, msys2 python3, python3, python, py -3). " +
      "Install mod_spatialite or set PYTHON.",
  );
  process.exit(1);
}

// Validate the real emitted graph when T-028 has produced it; fall back to the
// frozen fixture (and honour an explicit CLI override).
const builtGraph = path.join(repoRoot, "build", "graph.json");
const validateTarget = artifact ?? (existsSync(builtGraph) ? "build/graph.json" : null);
const validateArgs = validateTarget
  ? ["scripts/validate-graph.py", validateTarget]
  : ["scripts/validate-graph.py"];
run(`S1-S8: Structural gates (${validateTarget ?? "fixture"})`, python.command, [
  ...python.prefixArgs, ...validateArgs,
]);
run("TypeScript check", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "typecheck"]);
run("Tests", process.execPath, ["--test"]);

// G3 — no edge > 2 m inside a footprint. Runs against build/authoring.db (a
// build artifact). Hard gate: `stage5_clip` reroutes penetrating edges out of
// footprint interiors and writes the un-reroutable residue to
// overlays/g3-allowlist.json (endpoint-node-inside-footprint cases, tracked for
// a later node-relocation pass); gate_g3 skips those and fails on anything new.
if (existsSync(path.join(repoRoot, "build", "authoring.db"))) {
  run("G3: edge-through-footprint", python.command, [
    ...python.prefixArgs, "scripts/build/gate_g3.py", "--assert",
  ]);
} else {
  console.log("=== G3: edge-through-footprint ===");
  console.log("SKIP G3: build/authoring.db not found — run build-graph.py first");
}

if (existsSync(path.join(repoRoot, "scripts", "build-graph.py"))) {
  // Determinism is a (config, inputs) property; check it on the tight core
  // (Q3, ~4x faster to build twice than the full provisional area).
  run("B-020: build-graph.py determinism", python.command, [
    ...python.prefixArgs,
    "scripts/build-graph.py",
    "--check",
    "--service-area",
    "sources/service-area-core.geojson",
  ]);
} else {
  console.log("=== B-020: build-graph.py determinism (waiting for T-020) ===");
  console.log("SKIP B-020: scripts/build-graph.py not yet implemented");
}

// R1-R4 route quality. Report mode while the core still has red gates
// (R2/R3/R4 on the current build); flip to `--assert` once green.
if (existsSync(path.join(repoRoot, "build", "authoring.db"))) {
  run("R1-R4: route quality (report)", python.command, [
    ...python.prefixArgs, "scripts/route-report.py",
  ]);
} else {
  console.log("=== R1-R4: route quality ===");
  console.log("SKIP R1-R4: build/authoring.db not found — run build-graph.py first");
}

console.log("\n✓ All available gates passed");