// The single place that turns a graph artifact path into a `GraphFile`.
//
// Gate 0 of docs/specs/04-validation-gates.md: a validator that reads a path the
// application does not load is a bug (defect P-26 — the prototype's validator
// checked files that never existed). `scripts/validate-graph.py` defaults to the
// exact artifact named here, and a test asserts the two stay in sync.
//
// Domain-only: no react / maplibre / node-server imports beyond `node:fs`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GraphFile } from "./types.ts";

/** Repo-root-relative path to the graph the domain layer loads in tests today,
 *  and the app once Phase D lands. */
export const GRAPH_FIXTURE_PATH = "tests/fixtures/mini-graph.json";

/** Repo-root-relative path to the generated production graph (Phase C output). */
export const GRAPH_BUILD_PATH = "build/graph.json";

const REPO_ROOT_URL = new URL("../../", import.meta.url);

/** Absolute path for a repo-root-relative artifact path. */
export function resolveArtifact(repoRelativePath: string): string {
  return fileURLToPath(new URL(repoRelativePath, REPO_ROOT_URL));
}

export function loadGraphFile(absolutePath: string): GraphFile {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as GraphFile;
}

/** The frozen mini fixture, parsed. */
export function loadFixtureGraph(): GraphFile {
  return loadGraphFile(resolveArtifact(GRAPH_FIXTURE_PATH));
}
