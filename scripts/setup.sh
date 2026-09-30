#!/bin/sh
# setup: bootstrap a fresh clone of this repo into a working Doug.
# Run via `pnpm bootstrap` (never `pnpm setup` - that runs pnpm's own builtin
# setup command, which appends PNPM_HOME/PATH lines to the user's shell rc).
set -u

# Mirrors package.json's engines.node floor; keep the two in sync by hand.
REQUIRED_NODE="22.16"

# Resolve the repo root from this script's own location, regardless of cwd.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

# --- 1. node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "setup: node not found on PATH; install Node >=${REQUIRED_NODE}" >&2
  exit 1
fi

node_version=$(node --version)
node_version_stripped=${node_version#v}
node_major=${node_version_stripped%%.*}
node_rest=${node_version_stripped#*.}
node_minor=${node_rest%%.*}
required_major=${REQUIRED_NODE%%.*}
required_minor=${REQUIRED_NODE#*.}

node_ok=0
if [ "$node_major" -gt "$required_major" ] 2>/dev/null; then
  node_ok=1
elif [ "$node_major" -eq "$required_major" ] 2>/dev/null && [ "$node_minor" -ge "$required_minor" ] 2>/dev/null; then
  node_ok=1
fi

if [ "$node_ok" -ne 1 ]; then
  echo "setup: node ${node_version_stripped} found; Node >=${REQUIRED_NODE} is required" >&2
  exit 1
fi

# --- 2. pnpm -----------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  echo "setup: pnpm not found on PATH; run \`corepack enable pnpm\` or install the version named in package.json's packageManager field" >&2
  exit 1
fi

expected_pnpm=$(node -e "var v=require('./package.json').packageManager; if (v) process.stdout.write(v);" 2>/dev/null)
actual_pnpm_version=$(pnpm --version)
if [ -n "$expected_pnpm" ]; then
  expected_pnpm_version=${expected_pnpm#pnpm@}
  if [ "$actual_pnpm_version" != "$expected_pnpm_version" ]; then
    echo "setup: pnpm ${actual_pnpm_version} found; package.json's packageManager names pnpm@${expected_pnpm_version} (continuing, pnpm does not enforce this by default)"
  fi
fi

# --- 3. codex (report only, never fatal) ------------------------------------
if command -v codex >/dev/null 2>&1; then
  codex_path=$(command -v codex)
  echo "setup: codex found (${codex_path})"
else
  echo "setup: codex not found on PATH; the Codex adversary will fall back to the Claude adversary"
fi

# --- 4. install and build ----------------------------------------------------
if ! pnpm install --frozen-lockfile; then
  echo "setup: \`pnpm install --frozen-lockfile\` failed" >&2
  exit 1
fi

if ! pnpm build; then
  echo "setup: \`pnpm build\` failed" >&2
  exit 1
fi

# --- 5. link the doug CLI ----------------------------------------------------
fallback_line="setup: run it directly instead: node ${REPO_ROOT}/packages/doug-cli/dist/bin.js"

global_bin=$(pnpm bin -g 2>/dev/null)
if [ -z "$global_bin" ]; then
  echo "setup: no pnpm global bin dir is configured (set PNPM_HOME, or run pnpm's own setup yourself)"
  echo "$fallback_line"
else
  if pnpm --dir packages/doug-cli link --global; then
    echo "setup: linked doug at ${global_bin}/doug"
  else
    echo "setup: \`pnpm --dir packages/doug-cli link --global\` failed"
    echo "$fallback_line"
  fi
fi

# --- 6. next steps -------------------------------------------------------------
echo "setup: next steps:"
echo "setup:   doug init <repo>"
echo "setup:   doug board init   (or: doug board add)"
echo "setup:   start Claude Code with --plugin-dir plugins/doug-gates --plugin-dir plugins/doug-flow"
echo "setup:   then run /doug-next"
echo "setup: see docs/onboarding.md for the full walkthrough"

exit 0
