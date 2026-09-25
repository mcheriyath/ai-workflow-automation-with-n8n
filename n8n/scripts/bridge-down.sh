#!/usr/bin/env bash
# Stop the host Claude bridge started by bridge-up.sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
PID_FILE="$REPO_ROOT/host-bridge/.bridge.pid"

_log() { echo "[bridge-down] $*" >&2; }

if [ ! -f "$PID_FILE" ]; then
	_log "no pid file — bridge is not running"
	exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
	kill "$PID"
	_log "sent SIGTERM to pid $PID"
else
	_log "pid $PID no longer alive"
fi
rm -f "$PID_FILE"
