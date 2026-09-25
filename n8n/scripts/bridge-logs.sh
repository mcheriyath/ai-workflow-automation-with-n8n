#!/usr/bin/env bash
# Tail the host Claude bridge log.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
LOG_FILE="$REPO_ROOT/host-bridge/.bridge.log"

if [ ! -f "$LOG_FILE" ]; then
	echo "[bridge-logs] no log file at $LOG_FILE — is the bridge running?" >&2
	exit 1
fi

exec tail -n 200 -f "$LOG_FILE"
