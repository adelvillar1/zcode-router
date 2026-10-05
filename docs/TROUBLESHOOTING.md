# Troubleshooting

Symptom-first pointers. Deeper mechanics live in `router/README.md`; the feature docs in `docs/features/` explain each subsystem.

## Start here, always

```bash
npm run kit -- status          # installed? tiers resolved? health?
npm run kit -- doctor [--live] # whole-chain verification; changes nothing
```

Treat `!` lines as things to explain, and remaps as real (a fallback fired because a target had no key or was disabled — never for quality).

## Router not reachable / not on :8300

- `kit status` → is the launchd service loaded? Restart path: `kit apply` (renders, restarts, health-checks).
- Health endpoint: `curl http://127.0.0.1:8300/healthz` (no auth).
- The router binds loopback only — remote access is out of scope by design.

## 401 / auth failures from the dashboard or `/route`

- Local token mismatch: API calls need `Authorization: Bearer <localToken>` (roster `router.localToken`, default `local-auto-router`). The served dashboard page has the current token stamped in — reload it.

## Routing looks wrong (wrong model, lazy decisions)

- Read the response headers `x-router-execution` / `x-router-workload` / `x-router-workflow`; `x-router-failover` means a tier walk happened.
- `~/.zcode/router/logs/router.log`: `route`, `route-verdict`, `mixture` events; degraded judgments are tagged `judge:no-key`, `judge:error:…`, `judge:low-confidence`.
- Preview a verdict without a model call: `kit route "<task>"`.

## A plan seems exhausted / traffic not steering

- Quota is derived, not reported: check the roster's `quota.allowance` + `calibration.reads` (a stale console reading skews headroom), and off-peak weights.
- A provider that answered quota-exhausted is benched (429: 5 min, 402: 15 min, 403: 30 min, 5xx: 1 min) — recent walks show in the ledger as separate rows.

## Provider missing from ZCode's picker / whole picker degraded

- Never hand-edit `~/.zcode/v2/provider_config.json`. Check `kit status`; then `kit apply --dry-run` to see what the kit would write.
- The kit only rewrites its own keys and aborts on an unknown `schemaVersion` — if the app's config was damaged some other way, restore the newest `*.bak-kit*` backup, then re-apply.
- Keyless roster providers keep their registration; removal requires explicit `enabled: false`.

## Workflows missing / doctor says 0 assignable

- `kit workflows sync` copies the library without deleting your local files.
- A workflow is router-assignable only with a task argument (metadata or `workflows.registry.<name>.taskArg`); structured-arg workflows are hand-launched by design.

## Key problems

- Keys live only in `~/.zcode/router/.env` (600): `kit env list` shows what's set vs required; `kit env set NAME=value` sets. A raw key in `roster.json` is a hard-rule violation — move it to the env file and reference `apiKeyEnv`.
