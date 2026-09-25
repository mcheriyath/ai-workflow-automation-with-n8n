#!/usr/bin/env bash
# Sourced by sandbox-up.sh / bootstrap-host.sh. Checks the tools the sandbox needs:
# docker, docker compose, jq, mkcert.
set -euo pipefail

_log() { echo "[prereqs] $*" >&2; }

check_prereqs() {
	local missing=()

	command -v docker >/dev/null 2>&1 || missing+=("docker")
	docker compose version >/dev/null 2>&1 || missing+=("docker compose (v2 plugin)")
	command -v jq >/dev/null 2>&1 || missing+=("jq")
	command -v openssl >/dev/null 2>&1 || missing+=("openssl")

	if ! command -v mkcert >/dev/null 2>&1; then
		_log "mkcert not found — install it with your OS package manager"
		missing+=("mkcert")
	fi

	if [ "${#missing[@]}" -gt 0 ]; then
		_log "FATAL: missing required tools: ${missing[*]}"
		_log "macOS:  brew install docker jq mkcert openssl"
		_log "Debian: sudo apt-get install docker.io docker-compose-plugin jq mkcert openssl"
		exit 1
	fi

	_log "all prerequisites present"
}
