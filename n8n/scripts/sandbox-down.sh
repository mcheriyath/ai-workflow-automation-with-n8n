#!/usr/bin/env bash
# Teardown for the local sandbox. Default: stop containers only — volumes are preserved.
#
# Usage: ./scripts/sandbox-down.sh [--sandbox-name NAME] [--purge-data]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$REPO_ROOT/.env.sandbox"
COMPOSE_FILE="$REPO_ROOT/compose/docker-compose.yml"

_log() { echo "[sandbox-down] $*" >&2; }

usage() {
	cat >&2 <<'EOF'
Usage: sandbox-down.sh [--sandbox-name NAME] [--purge-data]

  --sandbox-name NAME  Optional identifier this sandbox instance was booted with.
  --purge-data         Also remove local Docker volumes (Postgres + n8n data).
EOF
}

SANDBOX_NAME=""
PURGE_DATA="false"

while [ $# -gt 0 ]; do
	case "$1" in
	--sandbox-name)
		SANDBOX_NAME="$2"
		shift 2
		;;
	--purge-data)
		PURGE_DATA="true"
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

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && COMPOSE_ARGS+=(--env-file "$ENV_FILE")

if [ "$PURGE_DATA" = "true" ]; then
	_log "stopping containers and removing named volumes"
	docker compose "${COMPOSE_ARGS[@]}" down -v
else
	_log "stopping containers (volumes preserved)"
	docker compose "${COMPOSE_ARGS[@]}" down
fi

if [ -n "$SANDBOX_NAME" ]; then
	_log "sandbox-name=${SANDBOX_NAME} torn down"
fi
_log "done"
