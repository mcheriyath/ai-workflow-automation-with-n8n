# N8N Task Runner - Code node isolation sidecar for the local sandbox.
#
# Extends n8nio/runners with a small set of default JS/Python packages and the
# operator-denylist entrypoint wrapper. Packages are installed from the public
# npm/PyPI registries — swap the index URL in your own fork if you need a
# private registry.
#
# Build with:
#   docker build --build-arg N8N_VERSION=$(cat docker/.n8n-version) \
#     -f n8n-runner/Dockerfile .
ARG N8N_VERSION=none
FROM n8nio/runners:${N8N_VERSION}
ARG N8N_VERSION

# Sandbox-visible version markers. Vendor-neutral SANDBOX_ prefix so they cannot
# collide with the runner's allowed-env allowlist.
ARG PACKAGE_SET_VERSION=none
ENV SANDBOX_N8N_VERSION=${N8N_VERSION}
ENV SANDBOX_PACKAGE_SET_VERSION=${PACKAGE_SET_VERSION}

# Fail fast if N8N_VERSION was not provided.
RUN test -n "${N8N_VERSION}" || (echo "ERROR: N8N_VERSION build arg is required" && exit 1)

USER root

# --- JavaScript dependencies ---------------------------------------------------------
# Only runs `pnpm install` if package.json has at least one dependency. An empty install
# would still hit the registry.
COPY n8n-runner/package.json /opt/runners/task-runner-javascript/package.json
RUN set -eu; \
    cd /opt/runners/task-runner-javascript; \
    if [ "$(node -e 'const p=require("./package.json");process.stdout.write(String(Object.keys(p.dependencies||{}).length))')" = "0" ]; then \
      echo "[runner-build] JavaScript baseline is empty — skipping npm install"; \
    else \
      pnpm install --frozen-lockfile=false; \
    fi

# --- Python dependencies -------------------------------------------------------------
COPY n8n-runner/requirements.txt /tmp/requirements.txt
RUN set -eu; \
    cd /opt/runners/task-runner-python; \
    if [ -s /tmp/requirements.txt ] && grep -qE '^[^#[:space:]]' /tmp/requirements.txt; then \
      uv pip install -r /tmp/requirements.txt; \
    else \
      echo "[runner-build] Python baseline is empty — skipping pip install"; \
    fi; \
    rm -f /tmp/requirements.txt

# Runner allowlist config (NODE_FUNCTION_ALLOW_*, N8N_RUNNERS_STDLIB_ALLOW, etc.)
COPY n8n-runner/n8n-task-runners.json /etc/n8n-task-runners.json

# --- Operator denylist ---------------------------------------------------------------
# See docker/shared/denylist.js. Mode 0555, root-owned — the container runs as uid 1000,
# so the brake and its validator are not writable by the identity that executes
# untrusted Code-node code.
COPY shared/denylist.js /usr/local/bin/denylist.js
COPY n8n-runner/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/denylist.js /usr/local/bin/entrypoint.sh

# CMD is re-declared because setting ENTRYPOINT wipes the base image's CMD, and the
# base CMD ["javascript","python"] is what tells the launcher which runtimes to start.
# The entrypoint ends in `exec tini -- task-runner-launcher "$@"` — tini stays PID 1
# so signal forwarding and zombie reaping keep working.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["javascript", "python"]

USER runner
