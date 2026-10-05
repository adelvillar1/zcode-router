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

Single-user, single-machine. The router binds to `127.0.0.1` and every API call beyond `/healthz` carries the local bearer token (roster `router.localToken`, default `local-auto-router`). There is no signup, login, or password reset; "who may use this" equals "who is on this machine".

## 2. Plans & Billing Safety

The kit's economic contract — what protects the user's prepaid plans:

- Providers are declared with `billing: "plan"` or `"payg"`. **A pay-per-token provider can never be a routing target** unless the roster explicitly opts in with `allowPayg: true`. Registering one in ZCode's picker is allowed; making it the router's default is not.
- The router never imposes artificial token limits; `routing.wideChars` only diverts oversized payloads to a large-context model.
- Quota: a plan's allowance may be declared and calibrated against console readings through the off-peak-weighted ledger; plans under 5% headroom are never suggested as primaries, and steering prefers plans with headroom. Undeclared providers are left alone.

## 3. Core Features

**Roster-driven provider registration.** Entry point: `roster.json` → `kit apply`. Each provider declares baseUrl (or `templateId`), `apiKeyEnv`, billing, models, optional `featured` list. `routerOnly` providers keep their key out of ZCode's picker. Output: a provider entry per non-routerOnly provider in ZCode's model picker.

**Workload tiers with fallbacks.** `quick` / `standard_code` / `hard` / `prose` / `deep_context`, each mapping to a concrete model with an ordered fallback list. A fallback fires only when its target has no key or is disabled — never for quality reasons — and every fire is reported as a remap by `status`/`apply`/`doctor`.

**Auto routing (the judge).** For `auto` requests, one cached judgment per task answers: workload (tier), execution (`single`/`mixture`/`swarm`), first workflow, optional follow-up workflow. Backend is pluggable: `typesafe` (default), `fastino` (local GLiNER2.5 via sys1), or `cascade` (fastino first, TypeSafe escalates). Judgment sends only compact signals — never the conversation or files.

**Mixture of agents.** One hard, non-decomposable question fans out to `mixture.proposers` (different plan pools/model families) in parallel; a proposal judgment picks the best and decides whether merging adds value — the aggregator runs only when it does. Turns carrying tool definitions skip mixture (`+mixture-skipped-tools`) and fall back to the hard tier.

**Swarm delegation.** When the judge sees a decomposable task (or quality-by-critique), it names a library workflow to run — and a second-stage workflow with a stage-scoped prompt when two stages are needed.

**Thinking levels.** Profiles may force thinking `deep` or `off` per provider dialect (`routing.thinkingStyles`); `auto` strips reasoning params as always. Built-in profiles: `deep` (hard tier, thinking on), `bulk` (quick tier, thinking off).

**Workflow library & registry.** 32 saved `.dwf.ts` workflows; 19 carry a task argument and are router-assignable, 13 take structured args and stay hand-launched. The registry is generated from each file's `zcode-workflow` metadata block — library and registry cannot drift. Adding a workflow = drop the file in `workflows/` + `kit apply`.

**Usage ledger + dashboard.** Every upstream call is metered (calls, errors, tokens, latency, per model per day, mixture proposers included) and visible at `/dashboard`, which also edits the roster.

## 4. User Flows

**New machine:** clone → `kit init --template` (or `kit init` on a live machine, commit the roster) → `kit env set …` → `kit apply --dry-run` → `kit apply` → `kit doctor` → in ZCode, `LogModels` and pick `auto-router/auto` (or pin `quick`/`hard`/…).

**Everyday:** `kit status` / `kit doctor` to check the chain; `kit route "…"` to preview a verdict; the dashboard to watch usage and tune delegation; `kit upgrade` to pull and re-apply.

**Add a workflow:** drop the `.dwf.ts` into `workflows/`, `kit apply`, done — metadata supplies description, task arg, and routing shape.

**Tune delegation:** open `/dashboard`, edit roster fields, Save & apply (dashboard writes through the kit, not around it).

## 5. Admin Tool: the Dashboard

The dashboard is the kit's only UI — usage tabs (live via SSE), delegation editor, model-strength-aware suggestions, and the delegation registry view. It authenticates with the local token (stamped into the served page). Saves go through `PUT /api/roster`, which writes the roster and re-applies — the dashboard can never produce state the kit wouldn't.

## 6. Failover & Degraded States

The router's answers to "what if a plan is down":

- A serving upstream answering `402`/`403`/`408`/`429`/`5xx` — or failing to connect — sends the tier walk to the next candidate; the failed provider is benched (429: 5 min, 402: 15 min, 403: 30 min, 5xx: 1 min; `Retry-After` wins; roster cooldowns override). Client errors (400/404) pass through untouched.
- Every walk is marked (`x-router-failover`) and both the failed attempt and the winner get separate ledger rows.
- Judge degradation is fail-open: missing key, error, or low confidence → `defaultWorkload` as a single call, tagged `judge:no-key` / `judge:error:…` / `judge:low-confidence`. A judge outage makes routing slower or lazier; it never fails a request.
- Degraded rosters are never silent: fallbacks fire as reported remaps, and `kit doctor` reports skipped workflows and unresolved tiers.

## 7. Edge Cases & Error States

- **Keyless provider**: a provider with no key set never removes a working registration and never silently routes — its tier falls back and the remap is reported.
- **Cache bounds**: judgment cache is keyed per session (system-prompt head + latest instruction), capped at 400 sessions, oldest evicted.
- **Thinking budget**: thinking tokens share `max_tokens` — a thinking-on call at a tiny cap returns empty content (the router records when this happens).
- **Unknown usage**: tokens are recorded only when the upstream reports them; models that don't report show unknown counts, never invented ones.
- **Schema drift**: provider config with an unexpected `schemaVersion` aborts the apply instead of corrupting ZCode's personal config.
- **Empty states**: fresh machine (no ledger yet) shows an empty dashboard; `kit status` on an unapplied machine says "run kit init".

## 8. UI Consistency Standards

The dashboard is a single dependency-free HTML file — vanilla JS, no framework, no build step. Conventions: the local token is injected server-side into the page; live data arrives over SSE; every mutating action goes through the kit's apply path so the roster remains the single source of truth.

Theming: a header toggle switches light/dark. The default follows the OS (`prefers-color-scheme`); an explicit choice is remembered per browser and survives reload. Both palettes are pure CSS-variable swaps — no component changes — and native controls adapt via `color-scheme`. There are no other responsive breakpoints beyond the existing two-column grid collapsing at 900px.
