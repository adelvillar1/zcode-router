# Architecture Overview

Installable, config-controlled model routing and workflow delegation for ZCode. Node.js ≥ 20 (the CLI loads the workflow
plane, which declares `>=20`), ESM only.

## The one diagram that matters

```
roster.json ──kit apply──┬── ~/.zcode/router/config.json       tier table, MoA, workflow registry
                         ├── ~/.zcode/v2/provider_config.json  the providers the model picker shows
                         ├── ~/.zcode/workflows/*.dwf.ts       the delegation library
                         ├── ~/.zcode/lib/workflow/*.mjs       the workflow plane's 14 modules
                         └── launchd / systemd service         keeps the router running
```

Rendered diagrams: `docs/img/architecture.svg`, `docs/img/request-lifecycle.svg`, `docs/img/quota.svg`, and the
interactive [package boundary](zcode-router-plane.html) — the workflow plane in the engine edition, the `file:`
dependency this kit resolves, the roster / keys / workflow library you edit, and what `kit apply` renders and installs.

## Components

| Component | Files | Role |
|-----------|-------|------|
| CLI | `bin/zcode-router-kit.mjs`, `lib/cli.mjs` | `status/init/export/env/apply/doctor/workflows/route/upgrade` |
| Roster model | `lib/roster.mjs` | load, validate, resolve tiers with ordered fallbacks; payg refusal |
| Renderer | `lib/render.mjs` | roster → router `config.json` (tiers, MoA, registry, localToken) |
| Provider merge | `lib/provider-merge.mjs` | surgical merge into ZCode's `provider_config.json` (backup + `schemaVersion` guard) |
| Workflow library | `lib/workflowlib.mjs` | parse `zcode-workflow` metadata blocks → registry; install without deleting user files |
| Workflow plane | `workflow-plane`, resolved from the engine checkout (`../agnostic-router-kit`) | the harnessed agent control plane — 14 modules, zero runtime deps: run state + checkpoints, judging and gates, tool grants and the world, transport, event journal and graph. Shipped to `~/.zcode/lib/workflow/` by `kit apply` |
| Service | `lib/service.mjs` | launchd (macOS) / systemd (Linux) user unit, keepalive |
| Live export | `lib/export-live.mjs` | machine → roster (preserves fallback chains and tier notes) |
| Env store | `lib/envstore.mjs` | `~/.zcode/router/.env` (600) read/write |
| Router | `router/server.js` | OpenAI-compatible proxy on `127.0.0.1:8300` (`node:http`, no framework) |
| Judge | `router/fastino.mjs` + `@typesafe-ai/sdk` | workload/execution/workflow/followUp verdict per task (typesafe / fastino / cascade backends) |
| Ledger | `router/usage.mjs` | per-model/per-day usage; atomic JSON persistence |
| Quota | `router/quota.mjs` | allowance calibration, headroom, steering, cooldown benches |
| Suggester | `router/suggest.mjs` | model ranking: measured latency/errors, declared context, quota, `strength` |
| Dashboard | `router/dashboard.html` | usage, delegation editor, suggestions; saves via `PUT /api/roster` |

## Data flow for the common request

ZCode sends `POST /v1/chat/completions` with `model: auto-router/auto`:

1. **Capability rules** (always win): images → `omniModel`; length > `wideChars` → `wideModel`.
2. **Judgment cache**: hash of system-prompt head + latest instruction; hit → reuse verdict (agentic loops keep one verdict).
3. **Judge** (one verdict per task, fail-open): workload tier, execution (`single`/`mixture`/`swarm`), first workflow, optional follow-up.
4. **Execution**: single call; or parallel proposers + integration judgment (mixture); or delegate to a library workflow (swarm).
5. **Tier chain walk**: quota-aware candidate order; upstream `402/403/408/429/5xx` or connection failure → next candidate + cooldown bench.
6. **Metering**: every attempt (won, diverted, lost) → the usage ledger; verdict headers on the response.

## Design invariants

- `roster.json` is the single source of truth; everything under `~/.zcode` is rendered and never hand-edited.
- The workflow library is configured here, but the engine that runs it is resolved from the engine checkout as a
  `file:` dependency — never copied into this repo, never edited here. `npm run check:port` asserts that the kit resolves
  the engine's package and that the runtime shipped beside the router is current.
- Keys live only in `~/.zcode/router/.env`, referenced from the roster by env-var name.
- Fail-open everywhere above the HTTP layer: judge outage, missing key, low confidence → default workload, tagged in the log, request still served.
- Degraded state is never silent: remaps, failovers, and skipped workflows are reported by `status`/`apply`/`doctor` and in response headers.

Deeper dives: `router/README.md` (routing order, judgment, MoA, quota, failover, thinking levels, logs) and the per-feature files in `docs/features/`.
