#!/usr/bin/env bash
# Sourced by sandbox-up.sh / test-sandbox.sh. Idempotent KEY=VALUE writes into
# .env.sandbox — never overwrite a key that's already present, since regenerating
# N8N_ENCRYPTION_KEY or POSTGRES_PASSWORD after data exists makes that data unreadable.
set -euo pipefail

# env_get FILE KEY -> prints value or empty
env_get() {
	local file="$1" key="$2"
	[ -f "$file" ] || return 0
	grep -E "^${key}=" "$file" | tail -n1 | cut -d'=' -f2- || true
}

# env_set_if_absent FILE KEY VALUE -> appends KEY=VALUE only if KEY is not already set
env_set_if_absent() {
	local file="$1" key="$2" value="$3"
	touch "$file"
	if grep -qE "^${key}=" "$file" 2>/dev/null; then
		return 0
	fi
	echo "${key}=${value}" >>"$file"
}

# env_set_overwrite FILE KEY VALUE -> replaces KEY's line, or appends if absent
env_set_overwrite() {
	local file="$1" key="$2" value="$3"
	touch "$file"
	if grep -qE "^${key}=" "$file" 2>/dev/null; then
		local tmp
		tmp="$(mktemp)"
		awk -v k="$key" -v v="$value" -F'=' 'BEGIN{OFS="="} $1==k{$0=k"="v} {print}' "$file" >"$tmp"
		mv "$tmp" "$file"
	else
		echo "${key}=${value}" >>"$file"
	fi
}
