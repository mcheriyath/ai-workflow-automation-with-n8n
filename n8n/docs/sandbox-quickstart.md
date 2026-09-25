# n8n sandbox quickstart

See [`n8n/README.md`](../README.md) for the full setup guide. Below is the
short version.

## Quickstart

```bash
# 1. Host prep (mkcert CA + /etc/hosts + leaf cert). Idempotent.
./n8n/scripts/bootstrap-host.sh

# 2. Boot the sandbox.
./n8n/scripts/sandbox-up.sh

# 3. Sanity check.
./n8n/scripts/test-sandbox.sh
```

Open <https://n8n.local:5678>.

## Common tasks

| Task | Command |
| --- | --- |
| Boot | `./n8n/scripts/sandbox-up.sh [--sandbox-name NAME] [--rebuild]` |
| Stop | `./n8n/scripts/sandbox-down.sh` |
| Stop + wipe data | `./n8n/scripts/sandbox-down.sh --purge-data` |
| Smoke test | `./n8n/scripts/test-sandbox.sh` |
| Start Claude bridge | `./n8n/scripts/bridge-up.sh` |
| Stop Claude bridge | `./n8n/scripts/bridge-down.sh` |
| Import example workflow | `./n8n/scripts/import-workflows.sh --from n8n/workflows-example` |
| Import your own workflows | `./n8n/scripts/import-workflows.sh` (reads `n8n/workflows-local/`) |

## Troubleshooting

**`Waiting for task broker to be ready` in the runner logs.** Confirm the `n8n`
service has `N8N_RUNNERS_BROKER_LISTEN_ADDRESS=0.0.0.0` set. Compose gives every
service its own network namespace, so the broker must bind on `0.0.0.0` and the
runner dials `n8n:5679`.

**Browser says the cert is untrusted.** Run `mkcert -install` (or
`./n8n/scripts/bootstrap-host.sh`) and restart the browser.

**`import-workflows.sh` says `N8N_API_KEY not set`.** Create one in the n8n UI
at Settings -> API, then `export N8N_API_KEY=...`.
