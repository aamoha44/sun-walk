#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

PYTHON=(python3)
if ! command -v "${PYTHON[0]}" >/dev/null 2>&1; then
  if command -v python >/dev/null 2>&1; then
    PYTHON=(python)
  elif command -v py >/dev/null 2>&1; then
    PYTHON=(py -3)
  else
    echo "FAIL: S1-S8 — no Python 3 interpreter found"
    exit 1
  fi
fi

ARTIFACT="${1:-}"
VALIDATE_ARGS=()
if [ -n "$ARTIFACT" ]; then
  VALIDATE_ARGS=("$ARTIFACT")
fi

echo "=== S1-S8: Structural gates ==="
if ! "${PYTHON[@]}" scripts/validate-graph.py "${VALIDATE_ARGS[@]}"; then
  echo "FAIL: S1-S8"
  exit 1
fi

echo "=== TypeScript check ==="
if ! npm run typecheck; then
  echo "FAIL: typecheck"
  exit 1
fi

echo "=== Tests ==="
if ! node --test; then
  echo "FAIL: tests"
  exit 1
fi

if [ -f scripts/build-graph.py ]; then
  echo "=== B-020: build-graph.py determinism ==="
  if ! "${PYTHON[@]}" scripts/build-graph.py --check; then
    echo "FAIL: B-020"
    exit 1
  fi
else
  echo "=== B-020: build-graph.py determinism (waiting for T-020) ==="
  echo "SKIP B-020: scripts/build-graph.py not yet implemented"
fi

if [ -f scripts/route-report.py ]; then
  echo "=== R1-R5: route quality gates ==="
  if ! "${PYTHON[@]}" scripts/route-report.py --assert; then
    echo "FAIL: R1-R5"
    exit 1
  fi
else
  echo "=== R1-R5: route quality gates (waiting for T-030) ==="
  echo "SKIP R1-R5: scripts/route-report.py not yet implemented"
fi

echo
echo "✓ All available gates passed"