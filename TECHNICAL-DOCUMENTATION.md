# zcode-router-kit — Technical Documentation

> **For:** Developer onboarding and reference
> **Repo:** https://github.com/adelvillar1/zcode-router
> **Deployment target:** the local machine (`kit apply` renders into `~/.zcode/…`)

This is the developer-onboarding contract — the document a new contributor reads to understand how the system is built. It's intentionally summary-style and links into `docs/` for deep dives. The two layers stay in sync as part of finishing a feature (see CLAUDE.md "Housekeeping protocol").

When a feature ships, update both the relevant `docs/` file (operational reference) **and** the matching section here (summary contract). The recap workflow prompts for both.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [State & Storage](#4-state--storage)
5. [Router API Reference](#5-router-api-reference)
6. [Local Security Model](#6-local-security-model)
7. [Dashboard](#7-dashboard)
8. [Service & Lifecycle](#8-service--lifecycle)
9. [Deployment (new machine)](#9-deployment-new-machine)
10. [Development Workflow](#10-development-workflow)
11. [CLI Scripts Reference](#11-cli-scripts-reference)
12. [Observability](#12-observability)

---

## 1. Project Overview

One roster file (`roster.json`) decides what a machine has; `kit apply` renders everything ZCode reads — the router's tier/delegation config, the provider registrations in ZCode's picker, the workflow library, and a keepalive service. Clone on a new machine, write its roster, set its keys, and it comes up identical.

- **Who it's for**: a developer running ZCode against multiple prepaid model plans who wants every `auto` request steered to the right plan, with usage metered and quota respected.
- **Key differentiators**: judge-decided delegation (single / mixture-of-agents / swarm) instead of a static model mapping; pay-per-token safety gates; a workflow registry generated from the library's own metadata so registry and library cannot drift.

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Language | Node.js ≥ 18, ESM (`.mjs` throughout) |
| CLI (`bin/`, `lib/`) | **zero runtime dependencies** |
| Router (`router/server.js`) | `node:http` (no web framework), one npm dep: `@typesafe-ai/sdk` (the judge client) |
| Database | none — JSON files (roster in git, ledger + config on disk) |
| Service | macOS launchd user agent / Linux systemd user unit |
| Hosting | local machine only; router listens on `127.0.0.1:8300` |
| CI/CD | none (personal infra repo; `tools/verify-pack.mjs` is the local pack checker) |

## 3. Architecture

```
roster.json ──kit apply──┬── ~/.zcode/router/config.json       tier table, MoA, workflow registry
                         ├── ~/.zcode/v2/provider_config.json  the providers the model picker shows
                         ├── ~/.zcode/workflows/*.dwf.ts       the delegation library
                         └── launchd / systemd service         keeps the router running
```

Two programs, one data flow:

- **`lib/cli.mjs` + `lib/*.mjs`** — the kit. Loads and validates the roster (tier fallbacks, payg refusal), renders the router config (`render.mjs`), surgically merges the provider config (`provider-merge.mjs`), parses workflow metadata into the registry (`workflowlib.mjs`), installs the service (`service.mjs`), and can export a live machine back into a roster (`export-live.mjs`).
- **`router/server.js`** — the router. An OpenAI-compatible proxy. For an `auto` request: capability rules first (images → `omniModel`, width → `wideModel`), then the per-session judgment cache, then the judge (workload, execution, workflow, followUp — one cached verdict per task), then execution as `single`, `mixture` (parallel proposers + integration judgment), or `swarm` (delegated to a library workflow), walking the tier's candidate chain with quota awareness and failover. Every attempt lands in the usage ledger.

Full request lifecycle: `docs/features/judge-delegation.md`; rendering and safety: `docs/features/provider-config-merge.md`; diagrams in `docs/img/`.

## 4. State & Storage

There is no database. Four kinds of state:

| State | Location | Written by | Committed? |
|-------|----------|------------|------------|
| Roster (source of truth) | `roster.json` (repo root) | human, or dashboard `PUT /api/roster` | **yes** — env-var names only, never keys |
| Router config | `~/.zcode/router/config.json` | `kit apply` (rendered) | no |
| Provider config | `~/.zcode/v2/provider_config.json` | `kit apply` (surgical merge; `.bak-kit*` backup first) | no |
| Usage ledger | `~/.zcode/router/logs/usage.json` | router (atomic write, debounced ~3s, 30-day retention, 200-entry recent ring) | no |
| Router keys | `~/.zcode/router/.env` (chmod 600) | `kit env set` | no — never |

Migration strategy: none needed — schema evolution lives in the roster's documented shape (`templates/roster.defaults.json`) and the `schemaVersion: 1` guard on provider config.

## 5. Router API Reference

OpenAI-compatible, loopback-only, on `127.0.0.1:8300`. All endpoints except `/healthz` and the dashboard page require `Authorization: Bearer <localToken>` (default `local-auto-router`, set via roster `router.localToken`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | liveness (no auth) |
| GET | `/v1/models` | models the router exposes (drives ZCode's picker) |
| POST | `/v1/chat/completions` | the routing endpoint (streaming supported) |
| POST | `/route` (`/v1/route`) | verdict only — workload/execution/workflow assignments, no model call |
| GET | `/dashboard` | dashboard page (local token injected) |
| GET | `/api/state`, `/api/usage`, `/api/suggest`, `/api/roster` | dashboard data: live state, ledger, distribution suggestions, effective roster |
| PUT | `/api/roster` | dashboard saves an edited roster → the kit's apply path |
| POST | `/api/usage/reset` | clear the ledger |

Responses carry `x-router-execution`, `x-router-workload`, `x-router-workflow`; a tier walk adds `x-router-failover`. Versioning: none — this is a personal single-consumer API.

## 6. Local Security Model

- The router binds to `127.0.0.1` only; there are no user accounts, sessions, or roles — the machine boundary plus the bearer local token is the whole model.
- Upstream keys live only in `~/.zcode/router/.env` (600). The roster references them by `apiKeyEnv` name; `roster.json` is committed and must never contain a raw key (`kit apply` warns if it does).
- `provider_config.json` is backed up before every write and a `schemaVersion` other than 1 aborts the apply — the merge rewrites only kit-owned keys, leaving app-managed rules untouched.
- A `billing: "payg"` provider is refused as a routing target without explicit `allowPayg: true`.

## 7. Dashboard

Single-file `router/dashboard.html`, served by the router at `/dashboard`, no build step. Tabs: usage per model/day (SSE live view over the ledger's recent-request ring), the delegation editor (edits the roster, saves via `PUT /api/roster` → kit apply), suggestions (`/api/suggest` ranks models by measured latency, errors, declared context, quota headroom, optional `strength`), and the workflows/delegation registry view.

Operational reference: `docs/features/dashboard.md`.

## 8. Service & Lifecycle

`kit apply` installs a **launchd user agent** (macOS) or **systemd user unit** (Linux) labeled `com.zcode.model-router` that keeps the router running and restarts it on failure; `kit apply` restarts it after re-rendering and health-checks `/healthz`. On other platforms the kit prints manual run instructions. Background jobs: none — the router is a single long-lived process; metering, quota windows, and cache eviction all happen in-process.

## 9. Deployment (new machine)

```bash
git clone git@github.com:adelvillar1/zcode-router.git zcode-router-kit && cd zcode-router-kit
node bin/zcode-router-kit.mjs init --template   # or kit init on a live machine, then commit roster.json
node bin/zcode-router-kit.mjs env set XIAOMI_MIMO_API_KEY=… STEPFUN_API_KEY=…
node bin/zcode-router-kit.mjs apply --dry-run
node bin/zcode-router-kit.mjs apply
node bin/zcode-router-kit.mjs doctor [--live]
```

Single-branch topology: `master` is everything; "deploy" = `kit apply` on the machine (idempotent). `kit upgrade` = `git pull && kit apply`.

## 10. Development Workflow

The plan-build-recap-document cycle:

1. **Plan** — draft at `docs/plans/YYYY-MM-DD-<slug>.md` with acceptance criteria. See `docs/plans/README.md`.
2. **Build** — implement on `master` (or a scratch branch); `kit apply --dry-run` → `kit apply` → `kit doctor`.
3. **Recap** — write `docs/recaps/SESSION-RECAP-YYYY-MM-DD.md` with criteria status.
4. **Document** — update `TECHNICAL-DOCUMENTATION.md`, `FUNCTIONAL-SPECIFICATIONS.md`, and the matching `docs/features/*.md`.

The cycle compresses for trivial work — typos and one-line fixes don't need a plan or doc updates.

## 11. CLI Scripts Reference

`bin/zcode-router-kit.mjs` (alias `kit`): `status` · `init [--template] [--force]` · `export` · `env set|unset|list` · `apply [--dry-run]` · `doctor [--live]` · `workflows list|sync` · `route "<task>"` · `upgrade`. Dev tools: `tools/verify-pack.mjs` (pack self-check), `bin/open-upstream-pr.sh` (documents the upstream PR path).

## 12. Observability

- **Ledger**: per-model, per-day calls / errors / prompt+completion tokens — recorded only when the upstream reported usage, never estimated. Mixture proposers are metered too.
- **Logs**: `~/.zcode/router/logs/router.log` — `route`, `route-verdict`, `mixture`, and degraded-decision tags `judge:no-key` / `judge:error:…` / `judge:low-confidence`, failover walks, and remaps.
- **Headers**: every response names its execution, workload, and workflow; `x-router-failover` marks a tier walk.
- **Doctor**: `kit doctor [--live]` verifies the whole chain (roster → config → runtime → service → health → tier resolution → provider registration); remaps and skipped workflows are reported, never silent.
