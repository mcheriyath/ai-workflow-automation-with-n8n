#!/usr/bin/env bash
# One-shot host prep for the local sandbox:
#   1. installs mkcert's local CA into the system trust store
#   2. appends SANDBOX_HOST to /etc/hosts (idempotent)
#   3. issues the leaf cert into n8n/compose/certs/
#
# Re-runnable — every step is idempotent.
#
# Usage: ./n8n/scripts/bootstrap-host.sh [--sandbox-host HOST]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"

# shellcheck source=./lib-prereqs.sh
source "$SCRIPT_DIR/lib-prereqs.sh"

_log() { echo "[bootstrap-host] $*" >&2; }

SANDBOX_HOST="${SANDBOX_HOST:-n8n.local}"
while [ $# -gt 0 ]; do
	case "$1" in
	--sandbox-host)
		SANDBOX_HOST="$2"
		shift 2
		;;
	-h | --help)
		echo "Usage: bootstrap-host.sh [--sandbox-host HOST]"
		exit 0
		;;
	*)
		_log "FATAL: unknown argument: $1"
		exit 1
		;;
	esac
done

check_prereqs

_log "sandbox host: ${SANDBOX_HOST}"

# 1. mkcert CA install (needs sudo the first time; no-op on repeat)
mkcert -install

# 2. /etc/hosts
if grep -qE "^\s*127\.0\.0\.1\s+.*\b${SANDBOX_HOST}\b" /etc/hosts 2>/dev/null; then
	_log "/etc/hosts already contains ${SANDBOX_HOST}"
else
	_log "appending '127.0.0.1 ${SANDBOX_HOST}' to /etc/hosts (needs sudo)"
	echo "127.0.0.1 ${SANDBOX_HOST}" | sudo tee -a /etc/hosts >/dev/null
fi

# 3. cert
CERT_DIR="$REPO_ROOT/compose/certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/${SANDBOX_HOST}.pem" ] || [ ! -f "$CERT_DIR/${SANDBOX_HOST}-key.pem" ]; then
	_log "issuing mkcert certificate for ${SANDBOX_HOST}"
	(cd "$CERT_DIR" && mkcert -cert-file "${SANDBOX_HOST}.pem" -key-file "${SANDBOX_HOST}-key.pem" "${SANDBOX_HOST}")
else
	_log "reusing existing mkcert certificate for ${SANDBOX_HOST}"
fi

_log "done. Next: ./n8n/scripts/sandbox-up.sh"
