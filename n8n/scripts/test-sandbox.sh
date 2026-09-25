#!/usr/bin/env bash
# Synthetic smoke test for the running sandbox: Postgres and n8n /healthz over HTTPS.
# Exits non-zero on any FAIL.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$REPO_ROOT/.env.sandbox"
COMPOSE_FILE="$REPO_ROOT/compose/docker-compose.yml"

FAILED=0
pass() { echo "[PASS] $*"; }
fail() {
	echo "[FAIL] $*"
	FAILED=1
}

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && COMPOSE_ARGS+=(--env-file "$ENV_FILE")

# 1. Postgres connectivity
if docker compose "${COMPOSE_ARGS[@]}" exec -T postgres pg_isready -U n8n_app -d n8n >/dev/null 2>&1; then
	pass "postgres connectivity"
else
	fail "postgres connectivity — pg_isready did not report ready"
fi

# 2. n8n health endpoint over HTTPS, through the Caddy proxy
SANDBOX_HOST="${SANDBOX_HOST:-n8n.local}"
if [ -f "$ENV_FILE" ]; then
	# shellcheck disable=SC1090
	FILE_HOST="$(grep -E '^SANDBOX_HOST=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
	[ -n "$FILE_HOST" ] && SANDBOX_HOST="$FILE_HOST"
fi
CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://${SANDBOX_HOST}:5678/healthz" 2>/dev/null || echo "000")"
if [ "$CODE" = "200" ]; then
	pass "n8n /healthz over HTTPS (200)"
else
	fail "n8n /healthz over HTTPS — got HTTP ${CODE}, expected 200"
fi

exit "$FAILED"
