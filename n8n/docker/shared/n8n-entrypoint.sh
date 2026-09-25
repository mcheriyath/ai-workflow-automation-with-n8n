#!/bin/sh
#
# Shared entrypoint for the n8n main image.
#
# Turns the `nodes` half of the operator denylist (N8N_RUNNER_DENYLIST) into NODES_EXCLUDE,
# so blocking a node type and blocking a package are one mechanism with one audit trail.
#
# ---------------------------------------------------------------------------------
# THREE THINGS HERE ARE LOAD-BEARING.
#
# 1. THE BASELINE IS THE NODES_EXCLUDE ALREADY IN THE ENVIRONMENT, NOT A HARDCODED LIST.
#    The merge only ever ADDS to the deployment's declared baseline; it never invents
#    exclusions.
#
# 2. THE VALUE MUST BE A JSON ARRAY. n8n parses it with a JsonStringArray that returns []
#    on any parse failure, silently. A comma-separated value therefore excludes nothing
#    and looks like it worked. An EMPTY array is valid and means "exclude nothing".
#
# 3. THE LAST LINE KEEPS tini AS PID 1. The base ENTRYPOINT is `tini -- /docker-entrypoint.sh`;
#    replacing it without re-establishing tini drops signal forwarding and zombie reaping.
#    "$@" carries any CMD forwarded by the caller.
#
# On a malformed denylist this refuses to start rather than run "unfiltered while the
# parameter says otherwise". The off switch is unsetting N8N_RUNNER_DENYLIST, not editing
# the parameter under pressure.
# ---------------------------------------------------------------------------------

set -eu

VALIDATOR="${N8N_RUNNER_DENYLIST_VALIDATOR:-/usr/local/bin/denylist.js}"
BASE_ENTRYPOINT="${N8N_BASE_ENTRYPOINT:-/docker-entrypoint.sh}"
TINI="${TINI_PATH:-/sbin/tini}"

log() { echo "[n8n-entrypoint] $*" >&2; }

if [ -z "${N8N_RUNNER_DENYLIST+x}" ]; then
  log "NOTICE: N8N_RUNNER_DENYLIST is not set, so no operator node blocks are applied."
  log "NOTICE: n8n's own defaults still exclude executeCommand and localFileTrigger."
  exec "${TINI}" -- "${BASE_ENTRYPOINT}" "$@"
fi

refuse() {
  log "FATAL: $*"
  log "FATAL: refusing to start. The denylist parameter names blocked node types, and"
  log "FATAL: starting without applying them would run them while claiming otherwise."
  log "FATAL: fix the value or unset N8N_RUNNER_DENYLIST to fall back to n8n's defaults."
  exit 1
}

[ -f "${VALIDATOR}" ] || refuse "validator not found at ${VALIDATOR}"

DENYLIST_FILE="$(mktemp)" || refuse "cannot create a temporary file to stage the denylist"
# The staged copy is removed on every exit path, including the refusals above this line's
# effect: `trap` fires before exec replaces the process, so the file is not left behind.
trap 'rm -f "${DENYLIST_FILE}"' EXIT INT TERM
printf '%s' "${N8N_RUNNER_DENYLIST}" > "${DENYLIST_FILE}" ||
  refuse "cannot stage the denylist at ${DENYLIST_FILE}"

# NODE_OPTIONS deliberately emptied so no unrelated -r preload runs the validator.
#
# --baseline carries the NODES_EXCLUDE this deployment already declares, so the merge
# can only ever ADD to it. Passing it is load-bearing: see note 1.
COMPUTED="$(NODE_OPTIONS= node "${VALIDATOR}" nodes-exclude \
  --denylist "${DENYLIST_FILE}" --baseline "${NODES_EXCLUDE:-}")" ||
  refuse "the injected denylist was rejected (see the errors above)"

# An empty result is LEGITIMATE and must not be refused. It means the deployment excludes
# nothing and the operator has blocked no node types. Only the SHAPE is checked here.
NODE_OPTIONS= node -e '
  const v = process.argv[1];
  const a = JSON.parse(v);
  if (!Array.isArray(a) || !a.every((x) => typeof x === "string")) {
    throw new Error("not a JSON array of strings: " + v);
  }
' "${COMPUTED}" || refuse "the computed NODES_EXCLUDE is not a shape n8n can parse: ${COMPUTED}"

export NODES_EXCLUDE="${COMPUTED}"
log "NODES_EXCLUDE=${NODES_EXCLUDE}"

NODE_OPTIONS= node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (d.nodes.length) {
    console.error("[n8n-entrypoint]   operator-blocked nodes: " + d.nodes.join(", "));
    console.error("[n8n-entrypoint]   reason: " + d.reason);
    console.error("[n8n-entrypoint]   by:     " + d.added_by + " at " + d.added_at +
      " (" + d.approval.mode + ")");
  }
' "${DENYLIST_FILE}" || refuse "cannot summarise the denylist"

rm -f "${DENYLIST_FILE}"
trap - EXIT INT TERM

exec "${TINI}" -- "${BASE_ENTRYPOINT}" "$@"
