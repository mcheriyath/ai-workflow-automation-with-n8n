# n8n local sandbox

A turnkey local n8n sandbox: Postgres, n8n, the JS/Python task-runner sidecar,
and Caddy fronting it all with mkcert-issued TLS. Optionally, a host-side HTTP
bridge that exposes your local `claude` CLI to workflows for AI automations.

Everything runs on your machine via Docker Compose. No cloud dependencies, no
private registries.

## Prerequisites

- Docker + Docker Compose v2 plugin
- `jq`, `openssl`
- [mkcert](https://github.com/FiloSottile/mkcert)
- (Optional, for the Claude bridge) Node 18+ on the host and the `claude` CLI on `PATH`

macOS:

```bash
brew install docker jq mkcert openssl node
```

## First boot

```bash
# 1. Install mkcert CA, add sandbox host to /etc/hosts, issue the leaf cert.
./n8n/scripts/bootstrap-host.sh                 # default host: n8n.local
# or: ./n8n/scripts/bootstrap-host.sh --sandbox-host mysandbox.local

# 2. Boot the stack.
./n8n/scripts/sandbox-up.sh                     # default sandbox-name: local

# 3. Open n8n.
open https://n8n.local:5678
```

Create an account in the n8n UI. Then grab an API key from **Settings -> API**
and either export it or drop it into `n8n/.env.sandbox`:

```bash
export N8N_API_KEY=...
export N8N_API_URL=https://n8n.local:5678/api/v1
```

## Import the example workflow

```bash
./n8n/scripts/import-workflows.sh --from n8n/workflows-example
```

That upserts `hello-claude` — a manual-trigger workflow that calls the host
Claude bridge and polls for the result.

## Host Claude bridge (optional)

Workflows can call `claude -p` on the host via a small HTTP server started with:

```bash
./n8n/scripts/bridge-up.sh          # starts the bridge on 127.0.0.1:8787
./n8n/scripts/bridge-logs.sh        # tail the log
./n8n/scripts/bridge-down.sh        # stop it
```

The bridge:

- listens on `127.0.0.1:8787` only (Docker Desktop routes `host.docker.internal` to it),
- requires `Authorization: Bearer $CLAUDE_BRIDGE_TOKEN` on every request,
- runs `claude -p` inside `$CLAUDE_BRIDGE_WORKSPACE_ROOT` (default: `~/claude-workspaces/`),
- runs claude with a fixed tool allowlist plus anything you list in
  `CLAUDE_BRIDGE_EXTRA_TOOLS` (space or comma separated),
- disallows `git push`, PR creation/merge, and remote workflow triggers regardless of allowlist.

**Adding tools**: append them to `CLAUDE_BRIDGE_EXTRA_TOOLS` in your shell, e.g.:

```bash
export CLAUDE_BRIDGE_EXTRA_TOOLS='Bash(terraform:*) Bash(kubectl:*)'
./n8n/scripts/bridge-up.sh
```

**Adding host scripts**: drop your script into `n8n/host-bridge/scripts/`,
register it in the `SCRIPTS` map of `n8n/host-bridge/claude-bridge.mjs`, and it
becomes callable via `POST /jobs` with `{"kind":"script","name":"..."}`. See
`n8n/host-bridge/scripts/example.sh` for the shape.

## Smoke test

```bash
./n8n/scripts/test-sandbox.sh
```

Passes when Postgres is ready and `https://n8n.local:5678/healthz` returns 200.

## Teardown

```bash
./n8n/scripts/sandbox-down.sh                 # containers only, volumes preserved
./n8n/scripts/sandbox-down.sh --purge-data    # nuke Postgres + n8n volumes too
```

## Local vs example workflows

- `n8n/workflows-example/` — checked-in templates you can safely share.
- `n8n/workflows-local/` — git-ignored; put your own workflow exports here.
  Workflow JSON can carry credentials, so it's kept off git deliberately.
