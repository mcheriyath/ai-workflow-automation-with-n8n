#!/usr/bin/env bash
# Upsert n8n workflow JSON files into the running sandbox via the n8n public REST API.
#
# By default imports from n8n/workflows-local/. Pass --from PATH to import from another
# directory (typically n8n/workflows-example/ to seed the sandbox with the shipped
# examples).
#
# Reads N8N_API_KEY / N8N_API_URL from the host environment first, then n8n/.env.sandbox.
#
# Usage: ./scripts/import-workflows.sh [--from DIR] [--activate]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$REPO_ROOT/.env.sandbox"

_log() { echo "[import-workflows] $*" >&2; }

FROM_DIR="$REPO_ROOT/workflows-local"
ACTIVATE="false"

while [ $# -gt 0 ]; do
	case "$1" in
	--from)
		FROM_DIR="$2"
		shift 2
		;;
	--activate)
		ACTIVATE="true"
		shift
		;;
	-h | --help)
		echo "Usage: import-workflows.sh [--from DIR] [--activate]" >&2
		exit 0
		;;
	*)
		_log "FATAL: unknown argument: $1"
		exit 1
		;;
	esac
done

if [ -f "$ENV_FILE" ]; then
	# shellcheck disable=SC1090
	set -a
	. "$ENV_FILE"
	set +a
fi

SANDBOX_HOST="${SANDBOX_HOST:-n8n.local}"
N8N_API_URL="${N8N_API_URL:-https://${SANDBOX_HOST}:5678/api/v1}"

if [ -z "${N8N_API_KEY:-}" ]; then
	_log "FATAL: N8N_API_KEY not set (export it, or add it to $ENV_FILE)"
	_log "       Create one in n8n UI -> Settings -> API"
	exit 1
fi

command -v jq >/dev/null 2>&1 || { _log "FATAL: jq is required"; exit 1; }

if [ ! -d "$FROM_DIR" ]; then
	_log "FATAL: no such directory: $FROM_DIR"
	exit 1
fi

shopt -s nullglob
files=("$FROM_DIR"/*.json)
if [ "${#files[@]}" -eq 0 ]; then
	_log "no workflow JSON files in $FROM_DIR"
	exit 0
fi

for file in "${files[@]}"; do
	name="$(jq -r '.name // empty' "$file")"
	if [ -z "$name" ]; then
		_log "skipping $file — no .name field"
		continue
	fi

	existing_id="$(curl -sk -H "X-N8N-API-KEY: $N8N_API_KEY" \
		"$N8N_API_URL/workflows?name=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$name")" \
		| jq -r '.data[0].id // empty')"

	payload="$(jq '{name, nodes, connections, settings: (.settings // {})}' "$file")"

	if [ -n "$existing_id" ]; then
		_log "updating '$name' (id $existing_id)"
		curl -sk -X PUT -H "X-N8N-API-KEY: $N8N_API_KEY" -H "content-type: application/json" \
			--data "$payload" "$N8N_API_URL/workflows/$existing_id" >/dev/null
		wf_id="$existing_id"
	else
		_log "creating '$name'"
		wf_id="$(curl -sk -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" -H "content-type: application/json" \
			--data "$payload" "$N8N_API_URL/workflows" | jq -r '.id // empty')"
		if [ -z "$wf_id" ]; then
			_log "FATAL: create failed for '$name'"
			exit 1
		fi
	fi

	if [ "$ACTIVATE" = "true" ]; then
		_log "activating '$name' (id $wf_id)"
		curl -sk -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
			"$N8N_API_URL/workflows/$wf_id/activate" >/dev/null
	fi
done

_log "done"
