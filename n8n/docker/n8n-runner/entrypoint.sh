#!/bin/sh
#
# Runner entrypoint.
#
# Applies the operator-written denylist (N8N_RUNNER_DENYLIST) to the runner allowlists
# before the launcher starts, so a package can be blocked without a rebuild.
#
# ---------------------------------------------------------------------------------
# THREE THINGS HERE ARE LOAD-BEARING.
#
# 1. THE LAST LINE MUST KEEP tini AS PID 1. The base image's ENTRYPOINT is
#    `tini -- /usr/local/bin/task-runner-launcher` with `CMD ["javascript","python"]`.
#    Replacing the ENTRYPOINT with this script drops tini, and with it signal forwarding
#    and zombie reaping.
#
# 2. THE BASELINE CONFIG STAYS ROOT-OWNED AND READ-ONLY. /etc/n8n-task-runners.json is
#    root:root 0644 and this container runs as uid 1000. The merged result therefore goes
#    to a runner-writable path and the launcher is pointed at it via N8N_RUNNERS_CONFIG_PATH.
#    Do NOT chown the baseline writable — that would hand the user that executes untrusted
#    Code-node code the ability to widen its own allowlist.
#
# 3. UNSET AND INVALID ARE DIFFERENT. Unset proceeds on the baseline with a loud notice.
#    Set-but-unusable refuses to start rather than run unfiltered while the parameter
#    claims a package is blocked.
# ---------------------------------------------------------------------------------

set -eu

BASELINE_CONFIG="${N8N_RUNNERS_BASELINE_CONFIG:-/etc/n8n-task-runners.json}"
VALIDATOR="${N8N_RUNNER_DENYLIST_VALIDATOR:-/usr/local/bin/denylist.js}"
LAUNCHER="${N8N_RUNNERS_LAUNCHER:-/usr/local/bin/task-runner-launcher}"
TINI="${TINI_PATH:-/sbin/tini}"

log() { echo "[runner-entrypoint] $*" >&2; }

# Where the merged config can actually be written. HOME first (the runner's workdir), /tmp
# as a fallback so an image whose home moves does not become an outage.
pick_writable_dir() {
  for d in "${HOME:-/home/runner}" /tmp; do
    if [ -d "${d}" ] && [ -w "${d}" ]; then
      echo "${d}"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Case 1: no denylist injected. Pre-rollout state - proceed on the baseline, loudly.
# ---------------------------------------------------------------------------
if [ -z "${N8N_RUNNER_DENYLIST+x}" ]; then
  log "NOTICE: N8N_RUNNER_DENYLIST is not set, so no operator denylist is being applied."
  log "NOTICE: running on the baseline allowlists in ${BASELINE_CONFIG}."
  exec "${TINI}" -- "${LAUNCHER}" "$@"
fi

# ---------------------------------------------------------------------------
# Case 2: a denylist was injected. From here on, anything unusable stops the container.
# ---------------------------------------------------------------------------
refuse() {
  log "FATAL: $*"
  log "FATAL: refusing to start. The denylist parameter says something is blocked, and"
  log "FATAL: starting anyway would run unfiltered while claiming otherwise."
  log "FATAL: fix N8N_RUNNER_DENYLIST or unset it to fall back to the baseline."
  exit 1
}

[ -f "${VALIDATOR}" ] || refuse "validator not found at ${VALIDATOR}"
[ -f "${BASELINE_CONFIG}" ] || refuse "baseline runner config not found at ${BASELINE_CONFIG}"

WORK_DIR="$(pick_writable_dir)" || refuse "no writable directory for the merged config (tried HOME and /tmp)"
DENYLIST_FILE="${WORK_DIR}/.runner-denylist.json"
EFFECTIVE_CONFIG="${WORK_DIR}/n8n-task-runners.effective.json"

# umask before the write: the merged config is not a secret, but it decides what untrusted
# code may import, so it is nobody else's business to edit.
umask 077
printf '%s' "${N8N_RUNNER_DENYLIST}" > "${DENYLIST_FILE}" ||
  refuse "cannot stage the denylist at ${DENYLIST_FILE}"

if ! node "${VALIDATOR}" merge \
      --denylist "${DENYLIST_FILE}" \
      --config "${BASELINE_CONFIG}" \
      --out "${EFFECTIVE_CONFIG}"; then
  # The validator has already printed exactly what is wrong with the body.
  refuse "the injected denylist was rejected (see the errors above)"
fi

# Belt and braces: a zero-byte or unparseable result would leave the launcher to fall back
# to its own default config, i.e. fail open with no allowlists narrowed at all.
[ -s "${EFFECTIVE_CONFIG}" ] || refuse "the merged config at ${EFFECTIVE_CONFIG} is empty"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${EFFECTIVE_CONFIG}" ||
  refuse "the merged config at ${EFFECTIVE_CONFIG} is not valid JSON"

# Record who applied the block and why, in the container log, next to the effect.
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const n = d.packages.length + d.nodes.length;
  console.error("[runner-entrypoint] denylist v" + d.version + " applied: " +
    d.packages.length + " package(s), " + d.nodes.length + " node type(s)");
  if (n) {
    console.error("[runner-entrypoint]   blocked: " + [...d.packages, ...d.nodes].join(", "));
    console.error("[runner-entrypoint]   reason:  " + d.reason);
    console.error("[runner-entrypoint]   by:      " + d.added_by + " at " + d.added_at +
      " (" + d.approval.mode + ")");
  }
' "${DENYLIST_FILE}" || refuse "cannot summarise the denylist"

rm -f "${DENYLIST_FILE}"

export N8N_RUNNERS_CONFIG_PATH="${EFFECTIVE_CONFIG}"
log "launcher will read ${EFFECTIVE_CONFIG}"

exec "${TINI}" -- "${LAUNCHER}" "$@"
