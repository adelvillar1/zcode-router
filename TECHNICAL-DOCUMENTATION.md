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
| CI/CD | one GitHub Actions job (node 20) running `npm test`; `tools/verify-pack.mjs` is the local pack checker |

## 3. Architecture

```
roster.json ──kit apply──┬── ~/.zcode/router/config.json       tier table, MoA, workflow registry
                         ├── ~/.zcode/v2/provider_config.json  the providers the model picker shows
                         ├── ~/.zcode/workflows/*.dwf.ts       the delegation library
                         └── launchd / systemd service         keeps the router running
```

Two programs, one data flow:

- **`lib/cli.mjs` + `lib/*.mjs`** — the kit. Loads and validates the roster (tier fallbacks, payg refusal), renders the router config (`render.mjs`), surgically merges the provider config (`provider-merge.mjs`), parses workflow metadata into the registry (`workflowlib.mjs`), installs the service (`service.mjs`), and can export a live machine back into a roster (`export-live.mjs`).
- **`lib/workflow/`** — the workflow runtime, resolved as the `workflow-plane` package: a `file:` dependency on the engine edition's checkout (`agnostic-router-kit lib/workflow/`), installed into this repo's `node_modules/workflow-plane`. This repo owns no copy of it, so a drift between the two editions is an install-time resolution failure rather than a silent fork, and `npm run check:port` (`tools/check-plane.mjs`) fails the moment the resolved package and the engine checkout differ. A workflow declares agents and file ownership; the plane assembles the briefs and contracts (from measured workspace facts), gates dispatch deterministically then by sys1, checkpoints each part's declared paths, budgets each ask by its shape, settles a parallel set so one member's failure does not take the others', journals every tool call against its grant, and records the run's own fact store. Its modules are `engine` (the orchestration surface — `runWorkflow`, the agent factory, the ask loop, `answerEscalation`), `harness` (harness assembly, the dispatch gate, the run's fact store), `tools` (the workspace tools and their journal), `transport` (the plane's only external protocol — one streamed chat completion behind an idle cap), `context` (budget resolution, token accounting, compaction), `runstate` (the run's name, its write destinations, its artifacts, its error type), `services` (install policy, bounded fetch, the rendered fetch and scrape router, the search backends, the dev-decisions tabular and semantic surfaces, the archify diagram audit/re-pin/finalize surface, dev servers and browser sessions, format hooks as pure capped functions), `schema` (TypeScript type text → JSON schema), `coerce` (model answers → the declared shape), `meta` (the workflow header and argument contract), `events` (the journal-event normalizer), `graph` (the orchestration graph builder), `checkpoint` (per-part workspace checkpoints), and `gitworld` (status, diff, log, changed files). `kit workflows run|watch|graph` drives it by the package specifier; `kit apply` ships the same modules beside the router — from a file list derived from the package's own exports rather than a written one — so the watcher, the CLI and the shipped server all read the same code.

`workflows/` holds two kinds of files: the `.dwf.ts` delegation workflows the router assigns (38 of them, read by `kit apply`'s registry — the three tabular loops, the two semantic loops, and diagram-refresh are `.dwf` too, hand-launched) and the ported **loop library** — `.ts` workflows the plane reads beside them through `cfg.kitRoot` + `findWorkflowFile` (`readLibrary` filters `.dwf.ts` only, so the two kinds never collide). The loops (deep-research, remediate, triage, refine-loop, red-team, watchdog, router-eval) write the plane's judgment law into their shape: generation goes to LLM agents, every flat yes/no, class, or matters call goes to the **sys1 judge surface** (`sys1.judge(spec, text)` — dev-decisions first, rows landing in the shared calibration store with `input_sha256`, raw sys1 as the recorded fallback), and search credits are structurally unspendable by agents — the workflow searches (one no-scrape call per sub-question, deduped, budget-gated by `world.spentCredits()`), agents hold no search tools, and page enrichment rides the scrape ladder (local moli behind the `browser` grant, then the operator's self-hosted Firecrawl `FIRECRAWL_SCRAPE_URL`, then plain bounded fetch — the journal's `via` names the leg that answered) rather than the billed cloud API. Three tabular loops read the dev-decisions batch lane behind the `tabular` grant — quota-forecast (`budget-gate` forecast bands per plan), flake-watch (`history-gate` per-suite flake scoring, report-only in v1), calibrate-floors (`override-prior` rendered as *proposed* floors — no write path to the roster exists in the workflow) — batch-only by law (no TabPFN network call ever runs in a synchronous path) and fail-open by construction; the review-sweep risk annotations, the triage eval head, and the watchdog fleet section are consumers in their respective `.dwf.ts`/`.ts` files. The semantic lane (ported 2026-10-07; plane by construction, shell kit-local): `world.semantic` (the `semantic` grant, default-off, `--json` injected, verbs `semantic-index`/`semantic-dedup`/`semantic-nn`) and `world.repeatFromRows` ride the plane; `workflows/dupe-watch.dwf.ts` (report-only near-dupe pairs over the calibration index — divergent grades escalate, agreeing pairs render merge proposals), `workflows/render-watch.dwf.ts` (shadow pixel comparison — 1.0000 cosine counts as would-skip, no skip path in the file, the baseline promotion is the one owner-held escalation), the review-sweep dedup head (repeats carry prior dispositions, annotated never dropped), the router-eval neighbor pre-pass (EVAL-ONLY context), and `router/semroute-shadow.mjs` with its `server.js` tap (the roster's shape sentences embedded at startup, re-warmed on config reload; after each fresh judge verdict a fire-and-forget log line names what the geometry would have picked, `evalOnly: true, applied: false` — nothing reads its return, every failure disables it by name). Producers `tools/record-findings-index.mjs` + `tools/record-render-index.mjs` write the corpora the lane indexes; the operating rule is *embeddings propose, sys1/sdm1 dispose*. The diagram lane (ported 2026-10-08; plane by construction, shell kit-local): `world.diagram.audit|repin|finalize` (the `diagram` grant, default-off) rides the plane, its CLI resolved in the pinned order `ARCHIFY_BIN` → the skill's built-in locations with a refusal sentence when absent; `workflows/diagram-refresh.dwf.ts` (the engine's loop, `.dwf`-re-header only — byte-identical body) runs audit → re-pin (moved refs only, idempotent) → finalize into a fresh `refresh-<n>/` with the receipts moved back beside the candidate → stills (`docs/architecture/render-png.mjs`; `--check` verifies sizes without Chrome) → a markdown artifact listing every `changed` ref as the agent's repair list. Batch-only with no agents and no model calls; every candidate's `sources` refs are classified by byte-identity against `meta.repository.revision` (moved vs changed are different facts, and only the second is an author's). `kit doctor` reports the freshness counts beside the tabular and semantic rows. Reference: `docs/features/diagram-lane.md`. Reference: `docs/features/loop-library.md`, `docs/features/deep-research.md`, `docs/features/browsing.md`, `docs/features/tabular-decisions.md`, `docs/features/semantic-lane.md`, `docs/features/diagram-lane.md`.
- **`router/server.js`** — the router. An OpenAI-compatible proxy. For an `auto` request: capability rules first (images → `omniModel`, width → `wideModel`), then the per-session judgment cache, then the judge (workload, execution, workflow, followUp — one cached verdict per task), then execution as `single`, `mixture` (parallel proposers + integration judgment), or `swarm` (delegated to a library workflow), walking the tier's candidate chain with quota awareness and failover. Every attempt lands in the usage ledger.

Full request lifecycle: `docs/features/judge-delegation.md`; rendering and safety: `docs/features/provider-config-merge.md`; diagrams in `docs/img/`.

## 4. State & Storage

There is no database. Six kinds of state:

| State | Location | Written by | Committed? |
|-------|----------|------------|------------|
| Roster (source of truth) | `roster.json` (repo root) | human, or dashboard `PUT /api/roster` | **yes** — env-var names only, never keys |
| Router config | `~/.zcode/router/config.json` | `kit apply` (rendered) | no |
| Provider config | `~/.zcode/v2/provider_config.json` | `kit apply` (surgical merge; `.bak-kit*` backup first) | no |
| Usage ledger | `~/.zcode/router/logs/usage.json` | router (atomic write, debounced ~3s, 30-day retention, 200-entry recent ring) | no |
| Router keys | `~/.zcode/router/.env` (chmod 600) | `kit env set` | no — never |
| Workflow runs | `~/.zcode/router/workflow-runs/<run>/` (`AGNOSTIC_ROUTER_KIT_HOME`; both the CLI and the server-spawned run API write here) | plane run (journal, facts, artifacts, `answers.jsonl`, `summary.json`) | no |
| Durable memory | `~/.agnostic-router-kit/memory/memory.jsonl` — the engine edition's store: one graph on this machine, pinned by `MEMORY_FILE_PATH` in both `router/server.js` and `lib/memory.mjs` | the plane (`lib/workflow/memory.mjs`, reached through `kit memory`, `/api/memory`, `/v1/memory`, and the MCP server ZCode's config points at) | no |
| Dev-decisions tables | `~/.local/share/dev-decisions/tables/` — dev-decisions' own convention (`quota-spend.csv`, `probe-outcomes.csv`, `risk_prior.csv`, `ci_runs.csv`, fleet tables); the kit neither moves nor renames it | `npm run record:quota` (`tools/record-quota-table.mjs`, ledger default `~/.zcode/router/logs/usage.json`), `npm test` (`tools/run-probes.mjs` appends probe outcomes), dev-decisions' own verbs | no |

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
| GET/POST | `/v1/memory` | **memory plane** — `?q=` ranked search / stats (GET); entity, entities, relations, observations, or `fact` writes (POST). An app token is refused by name unless its `grantCeiling` includes `memory`; writes are typed `app:<name>` |
| GET/POST | `/api/memory` | **memory plane, operator scope** — search, stats, write on the same store |

Two token classes share the bearer gate: the **operator token** (no ceiling, spawns anywhere, answers and reads any run) and **app tokens** — `router.apps` roster rows with a `grantCeiling` (and optional `workdir`). An app spawns under its declared ceiling or is refused by name (`403 out of bounds: …`), runs inside its own sandbox root, answers and reads only the runs it spawned. Refused spawns journal `run-spawn-refused` with the rule that fired.

**Everything under `/api/` is operator-class.** The block used to admit any valid bearer token; an app token now gets `403 this surface needs the operator token — apps act through /v1` there (memory included) — every app-legitimate surface lives under `/v1`, scoped by its ceiling. The `/api/workflow-events` SSE stream still accepts either class via `?token=`.

Responses carry `x-router-execution`, `x-router-workload`, `x-router-workflow`; a tier walk adds `x-router-failover`. Versioning: none — this is a personal single-consumer API. The pre-existing run-read surfaces (`/api/workflow-runs`, `/api/workflow-run/<id>`, `/api/workflow-graph`, the `/api/workflow-events` SSE stream — which accepts either token class via `?token=`) serve app-spawned runs unchanged; operational detail in `docs/features/run-api.md`.
## 6. Local Security Model

- The router binds to `127.0.0.1` only; there are no user accounts, sessions, or roles — the machine boundary plus the bearer token is the whole model. The token comes in two classes: the **operator token** (`router.localToken`, the CLI and dashboard's class — no ceiling) and **app tokens**, explicit `router.apps` roster rows, each with a declared `grantCeiling`.
- An app token is a capability, not an identity: it may spawn only under the grants in its ceiling (an out-of-ceiling request is a `403 out of bounds: <grant> is not in <app>'s ceiling`, journaled as `run-spawn-refused`), runs inside its own sandbox root (its roster `workdir`, or `<kit home>/apps/<name>/workspaces` — a body `workdir` outside that root is refused by name), and answers or reads only the runs it spawned. Ownership is re-derived from the run's journal (`run-start` carries `app`), so it survives a restart. A leaked app token's blast radius is its ceiling, which is the point of ceilings.
- Every capability a run uses (workspace io, net-fetch, net-search, package installs, dev servers, background commands, sub-agents, local browsing — `browser`/`browser-layout` — and the tabular lane, `tabular`; the last three default-off) is a declared grant journalled against the call that used it; nothing is ambient.
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

Optional, only if the loops' scrape leg or the Firecrawl search quality fallback will run: `kit env set FIRECRAWL_API_KEY=…` (the cloud search key), plus `FIRECRAWL_SCRAPE_URL` / `FIRECRAWL_SCRAPE_VERSION` pointing at an operator-run self-hosted Firecrawl. Search itself is keyless-first — DuckDuckGo answers with no key; the refusals are scrape asks and a pinned `firecrawl` backend, which name the variable rather than crash. Two more optional binaries, never bundled: moli on `PATH` (the rendered leg and the scrape ladder's first rung — `docs/features/browsing.md`) and the dev-decisions CLI (the tabular lane — `docs/features/tabular-decisions.md`); both are configured absences when missing, reported by `kit doctor` as dim notes.

Single-branch topology: `master` is everything; "deploy" = `kit apply` on the machine (idempotent). `kit upgrade` = `git pull && kit apply`.

## 10. Development Workflow

The plan-build-recap-document cycle:

1. **Plan** — draft at `docs/plans/YYYY-MM-DD-<slug>.md` with acceptance criteria. See `docs/plans/README.md`.
2. **Build** — implement on `master` (or a scratch branch); `kit apply --dry-run` → `kit apply` → `kit doctor`.
3. **Recap** — write `docs/recaps/SESSION-RECAP-YYYY-MM-DD.md` with criteria status.
4. **Document** — update `TECHNICAL-DOCUMENTATION.md`, `FUNCTIONAL-SPECIFICATIONS.md`, and the matching `docs/features/*.md`.

The cycle compresses for trivial work — typos and one-line fixes don't need a plan or doc updates.

## 11. CLI Scripts Reference

`bin/zcode-router-kit.mjs` (alias `kit`): `status` · `init [--template] [--force]` · `export` · `env set|unset|list` · `apply [--dry-run] [--only router]` · `doctor [--live]` · `memory …` · `workflows list|sync|run|watch|graph` · `route "<task>"` · `upgrade`. `kit workflows run <file|name>` drives a workflow through the ported plane with `--args/--answers/--grant/--allow-domain/--allow-cmd/--max-rounds/--compact-tokens` and prints the run's token spend; `--grant net-search` arms the search backend (keyless-first — DuckDuckGo needs no key; `FIRECRAWL_API_KEY` / `FIRECRAWL_SCRAPE_URL` / `FIRECRAWL_SCRAPE_VERSION` are resolved at the boundary from the runtime `.env` and are only the quality fallback and the scrape rung), `--grant browser` / `--grant browser-layout` arm the rendered leg and moli's sessions (moli on `PATH`), and `--grant tabular` arms the dev-decisions lane (`DEV_DECISIONS_BIN` overrides the CLI on `PATH`). `watch`/`graph` replay a finished run's journal as text or a DAG. `kit status` prints the run-API app rows (name + ceiling). `kit memory` is the durable memory plane on the engine edition's store: `stats | search <q> | remember <text> [--importance --veracity --extract --scope] | scratch add|list|clear | facts [--conflicts] | consolidate [--dry-run] | resolve <loser> <winner> | invalidate <id> | gc [--dry-run] | config | import --from mnemosyne|official`; `config` prints the `mcpServers.memory` snippet, and `doctor` reports the store once it exists. `npm run record:quota` (`tools/record-quota-table.mjs`) writes the usage ledger's hourly weighted spend into the dev-decisions store. Dev tools: `tools/verify-pack.mjs` (pack self-check), `tools/probe-run-api.mjs` (the run-API contract probe — 33 checks, zero model calls, scratch runtime on 8399), `tools/probe-memory.mjs` (store + CLI contract — 49 checks, scratch store and home), `tools/probe-memory-api.mjs` (the memory wire law — 15 checks, scratch router on 8392), `tools/unit-services-browser.mjs` (the browsing surface — moli-gated: skips where moli is absent), `tools/unit-services-tabular.mjs` (the tabular surface — hermetic: fixture stubs for the CLI), `bin/open-upstream-pr.sh` (documents the upstream PR path).

## 12. Observability

- **Ledger**: per-model, per-day calls / errors / prompt+completion tokens — recorded only when the upstream reported usage, never estimated. Mixture proposers are metered too. Each recent row carries `trigger` (`operator` or `app:<name>` — the token class that brought the request) and, when the roster declares prices, `costUsd` + `costSource: "price-list"`; failover rows name the failure class in the reason (`+upstream-429:rate`, `+upstream-402:quota`), and parity exclusions land as `parity:<capability>` rows. `/api/state` exposes `resolved.keyRejections` (base-url + key fingerprint, never key material) and `resolved.providerCaps` (the per-provider rollup of declared `manualModelRules` caps).
- **Classifier + atomic writes**: `router/failclass.mjs` is the failure vocabulary (pure functions — quota-before-ratelimit, keys never blamed for quotas, model gaps walk without benching); `router/atomic.mjs` + `lib/atomic.mjs` are the atomic writers (temp sibling with the final mode, fsync, rename) used by the ledger flush, `.env` writes, the roster PUT path, and the CLI's rendered-config writes. The plane's copy arrives through the `workflow-plane` symlink.
- **Logs**: `~/.zcode/router/logs/router.log` — `route`, `route-verdict`, `mixture`, and degraded-decision tags `judge:no-key` / `judge:error:…` / `judge:low-confidence`, failover walks, and remaps. Memory writes and refusals land here too: `memory-write` (app or operator, added count) and `memory-refused` (app, the rule that refused it).
- **Headers**: every response names its execution, workload, and workflow; `x-router-failover` marks a tier walk.
- **Doctor**: `kit doctor [--live]` verifies the whole chain (roster → config → runtime → service → health → tier resolution → provider registration), and reports the optional binaries the plane can shell out to — moli's version (the local browser) and dev-decisions' (the tabular lane) — green with the version when present, a dim note (not a failing check) when absent; remaps and skipped workflows are reported, never silent.
- **Run journals**: each run's `run.jsonl` records its full event stream — `run-start` (carrying `app`, `grants` as an array, and facts), every agent ask, every tool call with the grant it used, every escalation and the source that resolved it (`declared` | `live` | `owner` | `none`), every refusal, and the artifact publishes. Search lines carry the query, `results`, and `creditsUsed`; scrape and `web_render` tool lines carry the `via` leg (the `browser` grant, the bytes); judge verdicts name their backend (`sys1.judge` → `dev-decisions` or raw sys1).
- **Calibration rows**: the judge layer writes its rows to the shared dev-decisions calibration store with `input_sha256` — the run journal says what was decided, the store is how the decision's accuracy is later graded. Router log lines `run-spawned` / `run-spawn-refused` record "who asked" at the wire.
