# zcode-router-kit — Functional Specifications

> **For:** Product/UX reference and developer onboarding (user-flow contract)
> **Repo:** https://github.com/adelvillar1/zcode-router
> **Users:** the developer running ZCode on a machine this kit configures

This is the user-flow contract — the document that describes what the system does from the user's perspective. It captures intended behavior, edge cases, and the rules that govern features. This is a local developer tool, not a SaaS app: there are no accounts, subscriptions, or notifications, and sections are shaped accordingly.

This file stays in sync with the implementation as part of finishing a feature (see CLAUDE.md "Housekeeping protocol"). When a feature ships or changes, update both `docs/features/<name>.md` (operational reference) and the matching section here.

---

## Table of Contents

1. [Access Model](#1-access-model)
2. [Plans & Billing Safety](#2-plans--billing-safety)
3. [Core Features](#3-core-features)
4. [User Flows](#4-user-flows)
5. [Admin Tool: the Dashboard](#5-admin-tool-the-dashboard)
6. [Failover & Degraded States](#6-failover--degraded-states)
7. [Edge Cases & Error States](#7-edge-cases--error-states)
8. [UI Consistency Standards](#8-ui-consistency-standards)

---

## 1. Access Model

Single-user, single-machine. The router binds to `127.0.0.1` and every API call beyond `/healthz` carries a bearer token from one of two classes:

- **The operator token** (roster `router.localToken`, default `local-auto-router`) — the CLI and dashboard's class. No ceiling: it may spawn runs in any workspace, request any grants, answer any run, and read any run's artifacts.
- **App tokens** — explicit `router.apps` roster rows, each declaring its `grantCeiling` (and optionally a `workdir`). There is no dynamic registration; an app exists because a roster row says so.

"Who may use this" still equals "who is on this machine" for the operator class. An app token is a capability, not an identity: a leaked app token's blast radius is its ceiling and its sandbox, which is the point of ceilings.

## 2. Plans & Billing Safety

The kit's economic contract — what protects the user's prepaid plans:

- Providers are declared with `billing: "plan"` or `"payg"`. **A pay-per-token provider can never be a routing target** unless the roster explicitly opts in with `allowPayg: true`. Registering one in ZCode's picker is allowed; making it the router's default is not.
- The router never imposes artificial token limits; `routing.wideChars` only diverts oversized payloads to a large-context model.
- Quota: a plan's allowance may be declared and calibrated against console readings through the off-peak-weighted ledger; plans under 5% headroom are never suggested as primaries, and steering prefers plans with headroom. Undeclared providers are left alone.
- Search credits (Firecrawl) are a second spend surface, and they are budgeted inside the workflow rather than at the router: a run-level `creditBudget` (default 20) gates searches, a search is one no-scrape call per sub-question, agents hold no search tools, and page reads ride the scrape ladder's self-hosted rung when configured. Search itself is keyless-first: the default `auto` backend reads DuckDuckGo (`creditsUsed: 0`) and demotes Firecrawl to a fallback reached only when DDG came up empty *and* `FIRECRAWL_API_KEY` resolves. A missing key is a configured absence — the run refuses by naming the variable and `kit env set`, it does not crash.

## 3. Core Features

**Roster-driven provider registration.** Entry point: `roster.json` → `kit apply`. Each provider declares baseUrl (or `templateId`), `apiKeyEnv`, billing, models, optional `featured` list. `routerOnly` providers keep their key out of ZCode's picker. Output: a provider entry per non-routerOnly provider in ZCode's model picker.

**Workload tiers with fallbacks.** `quick` / `standard_code` / `hard` / `prose` / `deep_context`, each mapping to a concrete model with an ordered fallback list. A fallback fires only when its target has no key or is disabled — never for quality reasons — and every fire is reported as a remap by `status`/`apply`/`doctor`.

**Auto routing (the judge).** For `auto` requests, one cached judgment per task answers: workload (tier), execution (`single`/`mixture`/`swarm`), first workflow, optional follow-up workflow. Backend is pluggable: `typesafe` (default), `fastino` (local GLiNER2.5 via sys1), or `cascade` (fastino first, TypeSafe escalates). Judgment sends only compact signals — never the conversation or files.

**Mixture of agents.** One hard, non-decomposable question fans out to `mixture.proposers` (different plan pools/model families) in parallel; a proposal judgment picks the best and decides whether merging adds value — the aggregator runs only when it does. Turns carrying tool definitions skip mixture (`+mixture-skipped-tools`) and fall back to the hard tier.

**Swarm delegation.** When the judge sees a decomposable task (or quality-by-critique), it names a library workflow to run — and a second-stage workflow with a stage-scoped prompt when two stages are needed.

**The workflow runtime (the control plane).** A workflow declares what its agents are told and who owns which files; the workflow plane assembles everything else — measured environment facts, each part's contract and brief, deterministic dispatch validation, dev-decisions-first judgment gates, per-part checkpoints with byte-exact rollback, per-shape ask budgets, escalation answering, and settlement of a parallel set where one member's failure no longer discards its siblings. The plane is the `workflow-plane` package, resolved from the engine edition's checkout and imported by specifier, not a copy carried in this repo. Every capability a run uses (workspace io, net-fetch, net-search, package installs, dev servers, background commands, sub-agents, local browsing — `browser`/`browser-layout` — and the tabular lane, `tabular`; the last three default-off) is a declared grant journalled against the call that used it; nothing is ambient. See [docs/features/workflow-runtime.md](docs/features/workflow-runtime.md).

**Local browsing (granted, not ambient).** Rendered pages and scrapes run through the operator-installed moli browser behind the `browser` grant (default-off, opted in at spawn like net-fetch); page reading rides a scrape ladder — local moli, then the operator's self-hosted Firecrawl (`FIRECRAWL_SCRAPE_URL`), then plain bounded fetch — with the journal's `via` naming the leg that answered; search's `auto` backend is keyless-first (DuckDuckGo) with Firecrawl as the paid quality fallback. moli is never bundled or auto-downloaded: `kit doctor` reports it green with a version when installed and as a dim note (not a failing check) when absent — a configured absence, like a missing key. See [docs/features/browsing.md](docs/features/browsing.md).

**Tabular decisions (batch, granted, fail-open).** The `tabular` grant (default-off) gates `world.tabular(command, args)` — the dev-decisions CLI's batch lane over the tables the kit already produces: the usage ledger's weighted spend, the probe outcomes `npm test` appends, calibration rows, git history. Loops call it between agent rounds, never inside an ask — no TabPFN network call ever runs in a synchronous path. The six loops: quota-forecast, flake-watch, calibrate-floors (which proposes floors and has no write path to the roster), risk-composed review (findings annotated with directory revert risk; the swarm-side gate composition stays engine-side — this kit has no swarm runtime), triage eval (predictions journaled, never applied), fleet-watch. Absent CLI, absent sdm1 key (`TABPFN_API_KEY`), or an empty table → the loop names the absence and the run proceeds exactly as it would without the lane. See [docs/features/tabular-decisions.md](docs/features/tabular-decisions.md).

**Semantic decisions are geometry, and geometry never decides (ported 2026-10-07).** The `semantic` grant (default-off) gates `world.semantic(command, args)` — the engine's plane carries it by construction (`workflow-plane` `file:` dependency; `npm run check:port` is the drift guard): the dev-decisions CLI's embeddings lane with `--json` injected on every call, verbs exactly `semantic-index`, `semantic-dedup`, `semantic-nn`, plus the pure `world.repeatFromRows` dedup rule. The operating rule: *embeddings propose, sys1/sdm1 dispose* — a similarity score is a lead to confirm, never a verdict, label, or join. The kit-local consumers: dupe-watch (`workflows/dupe-watch.dwf.ts`, report-only), render-watch (`workflows/render-watch.dwf.ts`, shadow — counts only, no skip path in the file, the baseline promotion owner-held), review-sweep's dedup head (repeats carry prior dispositions, annotated never dropped), router-eval's neighbor pre-pass (EVAL-ONLY context the grep-grade never sees), and `router/semroute-shadow.mjs` + the `server.js` tap (fire-and-forget agreement rows in `router/logs/router.log`, nothing reads its return). The shadow law: a loop that would change a decision starts by logging what it would have done. See [docs/features/semantic-lane.md](docs/features/semantic-lane.md).

**The run API (application-spawned runs).** `POST /v1/runs` on the kit's own wire lets a pointed application spawn a workflow run — passing facts, grants, answers, and a workspace — under an app token whose ceiling bounds what it may request. The run then behaves exactly like an operator's run: it streams on the same event stream, escalates its questions over `POST /v1/runs/<id>/answers` while it is live (the caller answers without touching a terminal), and publishes its artifacts to `GET /v1/runs/<id>/artifacts`, downloadable per version. Refusals are named and journaled, never silent: a grant outside the ceiling is `403 out of bounds: …`, a workspace outside the app's root is refused by path, and another app's run is a 403 on read. See [docs/features/run-api.md](docs/features/run-api.md).

**The durable memory plane.** One JSONL graph on this machine — the engine edition's store, the same file ZCode's `mcpServers.memory` config points its memory server at — in the official MCP memory server's format, so any harness reads it with no adapter. A repeated SPO fact compounds its confidence, the same subject+predicate with a different object registers as a conflict that resolution supersedes rather than overwriting, a session-scoped scratch tier expires on a 24h TTL and consolidates additively into digests, and recall ranks hits by importance, recency, veracity, and mentions. The operator drives it with `kit memory` (or `GET/POST /api/memory`); an application reaches it through `GET/POST /v1/memory` only when its `grantCeiling` includes the `memory` capability, refused by name otherwise. Everything under `/api/` is operator-class — an app token acts through `/v1`. See [docs/features/memory.md](docs/features/memory.md).

**The loop library.** Fifteen loops in all. Seven library shapes — deep-research (credit-bounded iterative research), triage (high-volume classify and route with escalation instead of guessing), refine-loop (rubric-scored revision to a plateau), red-team (hostile attack before ship), watchdog (state in, state out), remediate (apply confirmed findings, roll back what cannot verify), router-eval (golden-task calibration feeder) — plus four zero-model-call probes. Every flat judgment in them (yes/no, class, keep/drop, matters) rides the dev-decisions/sys1 judge layer rather than a model call, and search credits are structurally unspendable by agents: the workflow searches once per sub-question, agents hold no search tools, and page enrichment rides the scrape ladder (moli first, the operator's self-hosted scraper as the middle rung, plain fetch as the floor). Six tabular loops read the dev-decisions batch lane — quota-forecast, flake-watch, calibrate-floors here, and the risk-composed review annotations, the triage eval head, and the watchdog fleet section as consumers in their own files (see the tabular paragraph above) — and two semantic loops, dupe-watch and render-watch, ride the embeddings lane (see the semantic decisions paragraph above); fifteen in all. See [docs/features/loop-library.md](docs/features/loop-library.md), [docs/features/tabular-decisions.md](docs/features/tabular-decisions.md), [docs/features/semantic-lane.md](docs/features/semantic-lane.md), and [docs/features/deep-research.md](docs/features/deep-research.md).

**Thinking levels.** Profiles may force thinking `deep` or `off` per provider dialect (`routing.thinkingStyles`); `auto` strips reasoning params as always. Built-in profiles: `deep` (hard tier, thinking on), `bulk` (quick tier, thinking off).

**Workflow library & registry.** 37 saved `.dwf.ts` workflows; 19 carry a task argument and are router-assignable, 18 take structured args and stay hand-launched (the three tabular loops and the two semantic loops among them). The registry is generated from each file's `zcode-workflow` metadata block — library and registry cannot drift. Adding a workflow = drop the file in `workflows/` + `kit apply`.

**Usage ledger + dashboard.** Every upstream call is metered (calls, errors, tokens, latency, per model per day, mixture proposers included) and visible at `/dashboard`, which also edits the roster.

## 4. User Flows

**New machine:** clone → `kit init --template` (or `kit init` on a live machine, commit the roster) → `kit env set …` → `kit apply --dry-run` → `kit apply` → `kit doctor` → in ZCode, `LogModels` and pick `auto-router/auto` (or pin `quick`/`hard`/…).

**Everyday:** `kit status` / `kit doctor` to check the chain; `kit route "…"` to preview a verdict; the dashboard to watch usage and tune delegation; `kit upgrade` to pull and re-apply.

**Run a loop from the CLI:** `kit workflows run triage --args '{"items":[…]}'` / `kit workflows run watchdog --args '{…}'` — no grant needed; `--grant net-search` arms the search-backed loops (deep-research), `--grant browser` arms the rendered leg and the moli scrape rung, and `--grant tabular` arms the dev-decisions lane (the triage eval head runs only under it) — keys and binaries resolve from the runtime `.env` and `PATH`. The run prints its stop reason, spend, and artifact paths; `kit workflows watch <run>` replays the journal.

**Point an application at the wire:** add a `router.apps` row to `roster.json` (name, token, grantCeiling, optional workdir) → `kit apply` → the app POSTs to `/v1/runs` with its token. It may only spawn under its ceiling; when a run escalates, the app answers over `POST /v1/runs/<id>/answers` and collects the deliverable from the artifacts index. `kit status` lists the app rows.

**Add a workflow:** drop the `.dwf.ts` into `workflows/`, `kit apply`, done — metadata supplies description, task arg, and routing shape.

**Tune delegation:** open `/dashboard`, edit roster fields, Save & apply (dashboard writes through the kit, not around it).

## 5. Admin Tool: the Dashboard

The dashboard is the kit's only UI — usage tabs (live via SSE), delegation editor, model-strength-aware suggestions, the delegation registry view, and the workflow board. It authenticates with the local token (stamped into the served page). Saves go through `PUT /api/roster`, which writes the roster and re-applies — the dashboard can never produce state the kit wouldn't.

The workflow surfaces are strictly read-only. The **Board** tab answers "where does the work stand" as a kanban board — four columns for what is planned, executing, completed and abandoned, one card per work item, assembled from the same sources the graph reads (plan markdown, run journals, the router log, the dev-decisions store, git log, recaps). Each card carries its deliverables, the agents assigned to it, and what the agent is doing right now; clicking a card opens the task's detail. Cards move as runs start, finish and fail, driven by the same SSE stream that feeds the activity feed. The layered plan→recap DAG that preceded it stays one toggle away over exactly the same model. Nothing on either surface writes: the kit CLI remains the only writer and control surface, so the board cannot produce workflow state the kit wouldn't.

## 6. Failover & Degraded States

The router's answers to "what if a plan is down":

- **Every failure is classified before it is benched** (`router/failclass.mjs`, pure functions, unit-table tested). Two laws: the usage-limit vocabulary is matched *before* the 429 pattern — a subscription's window is hours away, so its limit is terminal (quota) even when the provider phrases it as a rate limit; and quota/billing/rate-limit bodies are never a key rejection — the key is not the thing that is exhausted. Verdicts: `quota` (bench 30 min), `rate` (`Retry-After` honored, else 5 min), `key` (bench 60 min, remembered per base-url + key fingerprint on `/api/state` as `keyRejections` — fingerprint only, never key material), `model` (walk, bench nothing), `transient` (1 min), `client` (pass through, no walk), `network` (1 min). The roster's `routing.failover.cooldowns` override wins first.
- A serving upstream answering `402`/`403`/`408`/`429`/`5xx` — or failing to connect — sends the tier walk to the next candidate with the classified bench. Client errors (400/404) pass through untouched. A benched provider steers as zero headroom: it leaves the target slot while a healthy candidate exists, and the walk skips it in fallback position.
- **Capability parity**: `manualModelRules` may declare per-model `supportsImages`, `supportsTools`, `contextWindow`. A fallback that would silently drop a capability the request carries is excluded from the chain before steering and recorded as a `parity:<capability>` ledger row; undeclared caps gate nothing.
- Every walk is marked (`x-router-failover`) and both the failed attempt and the winner get separate ledger rows, the class in the reason (`+upstream-429:rate`, `+upstream-402:quota`). Rows carry `trigger` (operator / `app:<name>`) and `costUsd` + `costSource: "price-list"` from declared roster prices — cost is never estimated, like tokens.
- Durable writes (ledger, `.env`, roster PUT, rendered config) land through an atomic writer (temp sibling with the final mode, fsync, rename) — never half-written, never briefly world-readable; the plane's copy arrives through the `workflow-plane` symlink.
- Judge degradation is fail-open: missing key, error, or low confidence → `defaultWorkload` as a single call, tagged `judge:no-key` / `judge:error:…` / `judge:low-confidence`. A judge outage makes routing slower or lazier; it never fails a request.
- Degraded rosters are never silent: fallbacks fire as reported remaps, and `kit doctor` reports skipped workflows and unresolved tiers.

## 7. Edge Cases & Error States

- **Keyless provider**: a provider with no key set never removes a working registration and never silently routes — its tier falls back and the remap is reported.
- **Cache bounds**: judgment cache is keyed per session (system-prompt head + latest instruction), capped at 400 sessions, oldest evicted.
- **Thinking budget**: thinking tokens share `max_tokens` — a thinking-on call at a tiny cap returns empty content (the router records when this happens).
- **Unknown usage**: tokens are recorded only when the upstream reports them; models that don't report show unknown counts, never invented ones.
- **Schema drift**: provider config with an unexpected `schemaVersion` aborts the apply instead of corrupting ZCode's personal config.
- **Empty states**: fresh machine (no ledger yet) shows an empty dashboard; `kit status` on an unapplied machine says "run kit init".
- **Out-of-ceiling spawn**: an app requesting a grant it never declared gets `403 out of bounds: <grant> is not in <app>'s ceiling` and nothing runs; the refusal is journaled as `run-spawn-refused` with the rule that fired.
- **Sandbox escape attempt**: an app's body `workdir` resolving outside its root is refused by name; the default root `<kit home>/apps/<name>/workspaces` is created on demand rather than failing cold. The artifact download obeys the same closure: `..` and absolute paths are refused with `out of bounds: artifacts are inside this run's directory`, a file that is not there is 404, and another app's run is a 403.
- **Cross-app read**: an app fetching or answering another app's run gets a 403; ownership is re-derived from the run's journal, so a router restart does not reopen a closed door.
- **Missing search key**: the default `auto` search backend reads DuckDuckGo keylessly, so the common search needs no key at all; the refusals are a `scrape` ask and a pinned `firecrawl` backend, which name `FIRECRAWL_API_KEY` (and `kit env set`) while the run completes on what it has, and the refusal is journaled like every other.
- **`web_render` without the grant or without moli**: a run spawned without `--grant browser` gets the named, journalled refusal (`capability not granted in this run: browser`); a run with the grant on a machine without moli gets the refusal sentence naming the fix instead of a crash — `kit doctor` disambiguates the two (green moli line = grant missing; dim moli note = binary missing).
- **Tabular lane absent**: dev-decisions not installed, `TABPFN_API_KEY` unset, or the store table empty → the loop reports the absence by name and returns exactly what it would have without the lane (findings unannotated, triage byte-identical, watchdog proceeding); running the missing producer (`npm run record:quota`, `npm test`, dev-decisions' own verbs) is the whole remediation.
- **App without the memory capability**: `GET/POST /v1/memory` from an app whose ceiling lacks `memory` is `403 out of bounds: memory is not in <app>'s ceiling` — journaled as `memory-refused`; the operator surface (`/api/memory`) and the whole `/api/` block answer 403 to app tokens, because the control plane is operator-class.
- **No store yet / a malformed row**: the store is created lazily on first write, so a fresh machine has an empty graph rather than an error; a row that is not valid JSON is skipped on read with the rest of the graph surviving, and `kit doctor` names the store (with its entity/relation counts) once it exists.

## 8. UI Consistency Standards

The dashboard is a single dependency-free HTML file — vanilla JS, no framework, no build step. Conventions: the local token is injected server-side into the page; live data arrives over SSE; every mutating action goes through the kit's apply path so the roster remains the single source of truth.

Theming: a header toggle switches light/dark. The default follows the OS (`prefers-color-scheme`); an explicit choice is remembered per browser and survives reload. Both palettes are pure CSS-variable swaps — no component changes — and native controls adapt via `color-scheme`. There are no other responsive breakpoints beyond the existing two-column grid collapsing at 900px.
