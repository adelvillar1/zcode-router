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
- **Key differentiators**: judge-decided delegation (single / mixture-of-agents / swarm) instead of a static model mapping; pay-per-token safety gates; a workflow registry generated from the library's own metadata so registry and library cannot drift; a run API that lets an application spawn and steer workflow runs under per-app tokens with enforced grant ceilings; and a loop library in which every flat judgment rides the dev-decisions/sys1 judge layer instead of a model call.

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Language | Node.js ≥ 20, ESM (`.mjs` throughout) — the CLI and the router both load the workflow plane, which declares `>=20` |
| CLI (`bin/`, `lib/`) | one runtime dep: `workflow-plane` (resolved from the engine checkout) |
| Router (`router/server.js`) | `node:http` (no web framework), two npm deps: `@typesafe-ai/sdk` (the judge client) and `workflow-plane` (the workflow engine) |
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
- **`lib/workflow/`** — the workflow runtime, resolved as the `workflow-plane` package: a `file:` dependency on the engine edition's checkout (`agnostic-router-kit lib/workflow/`), installed into this repo's `node_modules/workflow-plane`. This repo owns no copy of it, so a drift between the two editions is an install-time resolution failure rather than a silent fork, and `npm run check:port` (`tools/check-plane.mjs`) fails the moment the resolved package and the engine checkout differ. A workflow declares agents and file ownership; the plane assembles the briefs and contracts (from measured workspace facts), gates dispatch deterministically then by sys1, checkpoints each part's declared paths, budgets each ask by its shape, settles a parallel set so one member's failure does not take the others', journals every tool call against its grant, and records the run's own fact store. Its modules are `engine` (the orchestration surface — `runWorkflow`, the agent factory, the ask loop, `answerEscalation`), `harness` (harness assembly, the dispatch gate, the run's fact store), `tools` (the workspace tools and their journal), `transport` (the plane's only external protocol — one streamed chat completion behind an idle cap), `context` (budget resolution, token accounting, compaction), `runstate` (the run's name, its write destinations, its artifacts, its error type), `services` (install policy, bounded fetch, dev servers, format hooks as pure capped functions), `schema` (TypeScript type text → JSON schema), `coerce` (model answers → the declared shape), `meta` (the workflow header and argument contract), `events` (the journal-event normalizer), `graph` (the orchestration graph builder), `checkpoint` (per-part workspace checkpoints), and `gitworld` (status, diff, log, changed files). `kit workflows run|watch|graph` drives it by the package specifier; `kit apply` ships the same modules beside the router — from a file list derived from the package's own exports rather than a written one — so the watcher, the CLI and the shipped server all read the same code.

`workflows/` holds two kinds of files: the `.dwf.ts` delegation workflows the router assigns (32 of them, read by `kit apply`'s registry) and the ported **loop library** — `.ts` workflows the plane reads beside them through `cfg.kitRoot` + `findWorkflowFile` (`readLibrary` filters `.dwf.ts` only, so the two kinds never collide). The loops (deep-research, remediate, triage, refine-loop, red-team, watchdog, router-eval) write the plane's judgment law into their shape: generation goes to LLM agents, every flat yes/no, class, or matters call goes to the **sys1 judge surface** (`sys1.judge(spec, text)` — dev-decisions first, rows landing in the shared calibration store with `input_sha256`, raw sys1 as the recorded fallback), and search credits are structurally unspendable by agents — the workflow searches (one no-scrape call per sub-question, deduped, budget-gated by `world.spentCredits()`), agents hold no search tools, and page enrichment rides the operator's self-hosted Firecrawl (`FIRECRAWL_SCRAPE_URL`) rather than the billed cloud API. Reference: `docs/features/loop-library.md`, `docs/features/deep-research.md`.
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
| Workflow runs | `~/.zcode/router/workflow-runs/<run>/` (`AGNOSTIC_ROUTER_KIT_HOME`; both the CLI and the server-spawned run API write here) | plane run (journal, facts, artifacts, `answers.jsonl`, `summary.json`) | no |

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
| POST | `/v1/runs` | **run API** — an application spawns a workflow run (`{workflow, args, facts, grants, answers, workdir}`) |
| POST | `/v1/runs/<id>/answers` | **run API** — answer a live escalation (`{topic, answer}` → `answers.jsonl`) |
| GET | `/v1/runs/<id>/artifacts` | **run API** — the versioned artifact index; `?file=` downloads one file, inside this run only |

Two token classes share the bearer gate: the **operator token** (no ceiling, spawns anywhere, answers and reads any run) and **app tokens** — `router.apps` roster rows with a `grantCeiling` (and optional `workdir`). An app spawns under its declared ceiling or is refused by name (`403 out of bounds: …`), runs inside its own sandbox root, answers and reads only the runs it spawned. Refused spawns journal `run-spawn-refused` with the rule that fired.

Responses carry `x-router-execution`, `x-router-workload`, `x-router-workflow`; a tier walk adds `x-router-failover`. Versioning: none — this is a personal single-consumer API. The pre-existing run-read surfaces (`/api/workflow-runs`, `/api/workflow-run/<id>`, `/api/workflow-graph`, the `/api/workflow-events` SSE stream — which accepts either token class via `?token=`) serve app-spawned runs unchanged; operational detail in `docs/features/run-api.md`.
## 6. Local Security Model

- The router binds to `127.0.0.1` only; there are no user accounts, sessions, or roles — the machine boundary plus the bearer token is the whole model. The token comes in two classes: the **operator token** (`router.localToken`, the CLI and dashboard's class — no ceiling) and **app tokens**, explicit `router.apps` roster rows, each with a declared `grantCeiling`.
- An app token is a capability, not an identity: it may spawn only under the grants in its ceiling (an out-of-ceiling request is a `403 out of bounds: <grant> is not in <app>'s ceiling`, journaled as `run-spawn-refused`), runs inside its own sandbox root (its roster `workdir`, or `<kit home>/apps/<name>/workspaces` — a body `workdir` outside that root is refused by name), and answers or reads only the runs it spawned. Ownership is re-derived from the run's journal (`run-start` carries `app`), so it survives a restart. A leaked app token's blast radius is its ceiling, which is the point of ceilings.
- Every capability a run uses (workspace io, net-fetch, net-search, package installs, dev servers, background commands, sub-agents) is a declared grant journalled against the call that used it; nothing is ambient.
- Upstream keys live only in `~/.zcode/router/.env` (600). The roster references them by `apiKeyEnv` name; `roster.json` is committed and must never contain a raw key (`kit apply` warns if it does). The same rule extends to the search backend: `FIRECRAWL_API_KEY` / `FIRECRAWL_SCRAPE_URL` are resolved at the wire from the runtime `.env`, so neither the CLI nor the workflow library ever carries key material (guard: a key-neutrality grep over `lib/` and `workflows/` returns 0).
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

Optional, only if the loop library's search-backed workflows will run: `kit env set FIRECRAWL_API_KEY=…` (the cloud search key), plus `FIRECRAWL_SCRAPE_URL` / `FIRECRAWL_SCRAPE_VERSION` pointing at an operator-run self-hosted Firecrawl. Absent keys are a configured absence — the workflows refuse by naming the variable, they do not crash.

Single-branch topology: `master` is everything; "deploy" = `kit apply` on the machine (idempotent). `kit upgrade` = `git pull && kit apply`.

## 10. Development Workflow

The plan-build-recap-document cycle:

1. **Plan** — draft at `docs/plans/YYYY-MM-DD-<slug>.md` with acceptance criteria. See `docs/plans/README.md`.
2. **Build** — implement on `master` (or a scratch branch); `kit apply --dry-run` → `kit apply` → `kit doctor`.
3. **Recap** — write `docs/recaps/SESSION-RECAP-YYYY-MM-DD.md` with criteria status.
4. **Document** — update `TECHNICAL-DOCUMENTATION.md`, `FUNCTIONAL-SPECIFICATIONS.md`, and the matching `docs/features/*.md`.

The cycle compresses for trivial work — typos and one-line fixes don't need a plan or doc updates.

## 11. CLI Scripts Reference

`bin/zcode-router-kit.mjs` (alias `kit`): `status` · `init [--template] [--force]` · `export` · `env set|unset|list` · `apply [--dry-run] [--only router]` · `doctor [--live]` · `workflows list|sync|run|watch|graph` · `route "<task>"` · `upgrade`. `kit workflows run <file|name>` drives a workflow through the ported plane with `--args/--answers/--grant/--allow-domain/--allow-cmd/--max-rounds/--compact-tokens` and prints the run's token spend; `--grant net-search` also arms the search backend, whose keys are resolved at the boundary from the runtime `.env` (`kit env set FIRECRAWL_API_KEY / FIRECRAWL_SCRAPE_URL / FIRECRAWL_SCRAPE_VERSION`). `watch`/`graph` replay a finished run's journal as text or a DAG. `kit status` prints the run-API app rows (name + ceiling). Dev tools: `tools/verify-pack.mjs` (pack self-check), `tools/probe-run-api.mjs` (the run-API contract probe — 33 checks, zero model calls, scratch runtime on 8399), `bin/open-upstream-pr.sh` (documents the upstream PR path).

## 12. Observability

- **Ledger**: per-model, per-day calls / errors / prompt+completion tokens — recorded only when the upstream reported usage, never estimated. Mixture proposers are metered too.
- **Logs**: `~/.zcode/router/logs/router.log` — `route`, `route-verdict`, `mixture`, and degraded-decision tags `judge:no-key` / `judge:error:…` / `judge:low-confidence`, failover walks, and remaps.
- **Headers**: every response names its execution, workload, and workflow; `x-router-failover` marks a tier walk.
- **Doctor**: `kit doctor [--live]` verifies the whole chain (roster → config → runtime → service → health → tier resolution → provider registration); remaps and skipped workflows are reported, never silent.
- **Run journals**: each run's `run.jsonl` records its full event stream — `run-start` (carrying `app`, `grants` as an array, and facts), every agent ask, every tool call with the grant it used, every escalation and the source that resolved it (`declared` | `live` | `owner` | `none`), every refusal, and the artifact publishes. Search lines carry the query, `results`, and `creditsUsed`; judge verdicts name their backend (`sys1.judge` → `dev-decisions` or raw sys1).
- **Calibration rows**: the judge layer writes its rows to the shared dev-decisions calibration store with `input_sha256` — the run journal says what was decided, the store is how the decision's accuracy is later graded. Router log lines `run-spawned` / `run-spawn-refused` record "who asked" at the wire.
