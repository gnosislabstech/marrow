#!/usr/bin/env bash
# Exec wrapper — loads credentials into the environment, then runs a tsx script.
# Two paths, in order:
#   1. 1Password — if OP_SERVICE_ACCOUNT_TOKEN is set (or
#      ~/.secrets/op-service-account-token exists), resolve op:// refs in
#      .env.tmpl via `op run`.
#   2. plain .env — otherwise source a local .env (copy .env.example).
# Secrets never land on disk via this wrapper (.env is gitignored).
#
# Usage:
#   ./run.sh scripts/bootstrap.ts [--dry-run]
#   ./run.sh scripts/mcp-server.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_TMPL="$SCRIPT_DIR/.env.tmpl"

# Pick up a 1Password service-account token from the conventional location.
if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" && -r "$HOME/.secrets/op-service-account-token" ]]; then
  export OP_SERVICE_ACCOUNT_TOKEN="$(cat "$HOME/.secrets/op-service-account-token")"
fi

# Node heap headroom for large session transcripts.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"

# Run from SCRIPT_DIR so relative script paths (e.g. scripts/mcp-server.ts)
# resolve regardless of caller CWD — editors spawn the MCP server with
# CWD = project dir, not the wrapper's dir; without this cd, tsx fails with
# ERR_MODULE_NOT_FOUND.
cd "$SCRIPT_DIR"

if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" && -f "$ENV_TMPL" ]]; then
  # 1Password path: resolve op:// refs in .env.tmpl at exec time, then run tsx.
  exec op run --env-file="$ENV_TMPL" -- tsx "$@"
elif [[ -f "$SCRIPT_DIR/.env" ]]; then
  # Plain-env path: load .env into the environment, then run tsx.
  set -a; . "$SCRIPT_DIR/.env"; set +a
  exec tsx "$@"
else
  echo "ERROR: no credentials found." >&2
  echo "  Use 1Password (set OP_SERVICE_ACCOUNT_TOKEN + fill in .env.tmpl)," >&2
  echo "  or copy .env.example to .env and fill it in." >&2
  exit 1
fi
