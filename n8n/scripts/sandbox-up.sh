#!/usr/bin/env bash
# Turnkey local sandbox bootstrap. Everything runs locally via Docker Compose.
#
# Usage: ./scripts/sandbox-up.sh [--sandbox-name NAME] [--sandbox-host HOST] [--rebuild]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$REPO_ROOT/.env.sandbox"
COMPOSE_FILE="$REPO_ROOT/compose/docker-compose.yml"

# shellcheck source=./lib-prereqs.sh
source "$SCRIPT_DIR/lib-prereqs.sh"
# shellcheck source=./lib-envfile.sh
source "$SCRIPT_DIR/lib-envfile.sh"

_log() { echo "[sandbox-up] $*" >&2; }

usage() {
	cat >&2 <<'EOF'
Usage: sandbox-up.sh [--sandbox-name NAME] [--sandbox-host HOST] [--rebuild]

  --sandbox-name NAME  Identifier for this sandbox instance (default: local).
  --sandbox-host HOST  Hostname the sandbox is served under (default: n8n.local).
  --rebuild            Force a rebuild of the local Docker images.
EOF
}

SANDBOX_NAME="local"
SANDBOX_HOST="${SANDBOX_HOST:-n8n.local}"
REBUILD="false"

while [ $# -gt 0 ]; do
	case "$1" in
	--sandbox-name)
		SANDBOX_NAME="$2"
		shift 2
		;;
	--sandbox-host)
		SANDBOX_HOST="$2"
		shift 2
		;;
	--rebuild)
		REBUILD="true"
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		_log "FATAL: unknown argument: $1"
		usage
		exit 1
		;;
	esac
done

check_prereqs

_log "sandbox-name=${SANDBOX_NAME} sandbox-host=${SANDBOX_HOST}"

# --- cert + /etc/hosts precondition check ---
CERT_DIR="$REPO_ROOT/compose/certs"
if [ ! -f "$CERT_DIR/${SANDBOX_HOST}.pem" ] || [ ! -f "$CERT_DIR/${SANDBOX_HOST}-key.pem" ]; then
	_log "FATAL: no cert for ${SANDBOX_HOST} in ${CERT_DIR}"
	_log "FATAL: run ./scripts/bootstrap-host.sh --sandbox-host ${SANDBOX_HOST} first"
	exit 1
fi

if ! grep -qE "^\s*127\.0\.0\.1\s+.*\b${SANDBOX_HOST}\b" /etc/hosts 2>/dev/null; then
	_log "NOTICE: /etc/hosts has no entry for ${SANDBOX_HOST} — run bootstrap-host.sh"
fi

# --- .env.sandbox: generate secrets once, never regenerate on top of existing data ---
touch "$ENV_FILE"
env_set_if_absent "$ENV_FILE" "SANDBOX_NAME" "$SANDBOX_NAME"
env_set_if_absent "$ENV_FILE" "SANDBOX_HOST" "$SANDBOX_HOST"
env_set_if_absent "$ENV_FILE" "N8N_VERSION" "$(cat "$REPO_ROOT/docker/.n8n-version")"
env_set_if_absent "$ENV_FILE" "N8N_ENCRYPTION_KEY" "$(openssl rand -hex 32)"
env_set_if_absent "$ENV_FILE" "POSTGRES_USER" "n8n_app"
env_set_if_absent "$ENV_FILE" "POSTGRES_PASSWORD" "$(openssl rand -hex 16)"
env_set_if_absent "$ENV_FILE" "POSTGRES_DB" "n8n"
env_set_if_absent "$ENV_FILE" "GENERIC_TIMEZONE" "UTC"
env_set_if_absent "$ENV_FILE" "CLAUDE_BRIDGE_URL" "http://host.docker.internal:8787"
env_set_if_absent "$ENV_FILE" "CLAUDE_BRIDGE_TOKEN" "$(openssl rand -hex 32)"

# --- compose up ---
COMPOSE_ARGS=(-f "$COMPOSE_FILE" --env-file "$ENV_FILE")
if [ "$REBUILD" = "true" ]; then
	docker compose "${COMPOSE_ARGS[@]}" up -d --build
else
	docker compose "${COMPOSE_ARGS[@]}" up -d
fi

# --- health validation, bounded retries ---
_log "waiting for postgres..."
for _ in $(seq 1 30); do
	if docker compose "${COMPOSE_ARGS[@]}" exec -T postgres pg_isready -U n8n_app -d n8n >/dev/null 2>&1; then
		break
	fi
	sleep 2
done

_log "waiting for n8n /healthz..."
for _ in $(seq 1 30); do
	if curl -sk -o /dev/null -w '%{http_code}' "https://${SANDBOX_HOST}:5678/healthz" 2>/dev/null | grep -q '^200$'; then
		break
	fi
	sleep 2
done

cat >&2 <<EOF

Sandbox is up.
  n8n URL:        https://${SANDBOX_HOST}:5678
  Sandbox name:   ${SANDBOX_NAME}

Next: ./scripts/test-sandbox.sh                    (smoke test)
      ./scripts/bridge-up.sh                       (start host Claude bridge, optional)
      ./scripts/import-workflows.sh                (upsert local workflows into n8n)
      ./scripts/sandbox-down.sh                    (teardown)
EOF
