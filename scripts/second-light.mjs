// `npm run second-light` -- find the SpatiaLite-capable interpreter, then run
// scripts/second-light.py (exports build/second-light/ and serves it).
// Mirrors first-light.mjs / gates.mjs findPython(). Pass extra args through:
// `npm run second-light -- --no-serve`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  if (process.platform === "win32") candidates.push(["C:/msys64/ucrt64/bin/python3.exe", []]);
  candidates.push(["python3", []], ["python", []], ["py", ["-3"]]);
  const probe =
    "import sqlite3;c=sqlite3.connect(':memory:');c.enable_load_extension(True);" +
    "c.execute(\"SELECT load_extension('mod_spatialite')\")";
  for (const [command, prefixArgs] of candidates) {
    const r = spawnSync(command, [...prefixArgs, "-c", probe], { cwd: repoRoot, stdio: "ignore" });
    if (r.status === 0) return { command, prefixArgs };
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error("no SpatiaLite-capable Python found (tried $PYTHON, msys2 python3, python3, python, py -3).");
  process.exit(1);
}
const r = spawnSync(
  py.command,
  [...py.prefixArgs, "scripts/second-light.py", ...process.argv.slice(2)],
  { cwd: repoRoot, stdio: "inherit" },
);
process.exit(r.status ?? 1);
