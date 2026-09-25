# N8N main image for the local sandbox.
#
# Extends the upstream n8n image with the operator-denylist entrypoint wrapper
# (docker/shared/n8n-entrypoint.sh + denylist.js). No cloud APM, no private
# registry — the sandbox pulls from the public npm registry only when it needs
# to, and this image installs nothing extra by default.
#
# Build with:
#   docker build --build-arg N8N_VERSION=$(cat docker/.n8n-version) \
#     -f n8n-main/Dockerfile .
ARG N8N_VERSION=none
FROM n8nio/n8n:${N8N_VERSION}
ARG N8N_VERSION

# Sandbox-visible version markers. Vendor-neutral SANDBOX_ prefix so they cannot
# collide with n8n's own N8N_* configuration or the runner's allowed-env list.
ARG PACKAGE_SET_VERSION=none
ENV SANDBOX_N8N_VERSION=${N8N_VERSION}
ENV SANDBOX_PACKAGE_SET_VERSION=${PACKAGE_SET_VERSION}

# Fail fast if N8N_VERSION was not provided (prevents silent pull of :latest).
RUN test -n "${N8N_VERSION}" || (echo "ERROR: N8N_VERSION build arg is required" && exit 1)

# --- Operator denylist -> NODES_EXCLUDE ------------------------------------------------
#
# The denylist file is a single JSON document describing node types (and packages, for the
# runner image) an operator wants to block at boot without a rebuild. n8n-entrypoint.sh
# unions it into NODES_EXCLUDE before launching n8n, so the running process starts with the
# operator's block in force.
#
# In the sandbox this facility is unused by default — N8N_RUNNER_DENYLIST and NODES_EXCLUDE
# are left unset, and the entrypoint's fallback path boots on n8n's own defaults and logs a
# NOTICE. The plumbing is here so that swapping in a real denylist is a one-env-var change,
# not a rebuild.
#
# Mode 0555, root-owned: not writable by the `node` user the service runs as.
USER root
COPY shared/denylist.js /usr/local/bin/denylist.js
COPY shared/n8n-entrypoint.sh /usr/local/bin/n8n-entrypoint.sh
RUN chmod 0555 /usr/local/bin/denylist.js /usr/local/bin/n8n-entrypoint.sh
USER node

# The base entrypoint runs plain `n8n` when it receives no arguments, which is what main
# should do — so no CMD here.
ENTRYPOINT ["/usr/local/bin/n8n-entrypoint.sh"]
