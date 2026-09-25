#!/usr/bin/env bash
# Template for a host bridge script. Register in n8n/host-bridge/claude-bridge.mjs
# under SCRIPTS to make it callable via `POST /jobs {"kind":"script","name":"..."}`.
#
# The bridge treats the LAST stdout line as the machine-readable result and will
# JSON-parse it if possible.
set -euo pipefail

MESSAGE="${1:-hello from example.sh}"
printf '{"ok":true,"message":%s,"args":[%s]}\n' \
	"$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
	"$(for a in "$@"; do printf '%s' "$a" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; done | paste -sd, -)"
