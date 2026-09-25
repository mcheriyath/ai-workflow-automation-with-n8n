# ai-workflow-automation

Local sandboxes for building workflow automations. Each engine gets its own top-level
folder, fully self-contained.

## n8n

A turnkey local n8n sandbox: Postgres, n8n, the JS/Python task-runner sidecar,
TLS via mkcert + Caddy. Optionally, a host-side HTTP bridge that exposes your
local `claude` CLI to workflows for AI automations.

```bash
./n8n/scripts/bootstrap-host.sh     # one-shot host prep (mkcert CA, /etc/hosts, cert)
./n8n/scripts/sandbox-up.sh         # boot the stack
```

See [n8n/README.md](n8n/README.md) for the full walkthrough and
[n8n/docs/sandbox-quickstart.md](n8n/docs/sandbox-quickstart.md) for the short version.

### Layout

- `n8n/docker/` — the n8n main + task-runner Dockerfiles and the local-only Caddy config.
- `n8n/compose/` — `docker-compose.yml` and the `.env.sandbox.example` template.
- `n8n/scripts/` — `sandbox-up.sh`, `sandbox-down.sh`, `bootstrap-host.sh`, the bridge
  helpers, and the workflow importer.
- `n8n/host-bridge/` — the Node HTTP bridge that lets workflows call `claude` on the host.
- `n8n/workflows-example/` — shareable example workflows.
- `n8n/workflows-local/` — your own workflows, git-ignored.
- `n8n/docs/` — quickstart.

## airflow

Placeholder for an Apache Airflow sandbox — not yet built.
