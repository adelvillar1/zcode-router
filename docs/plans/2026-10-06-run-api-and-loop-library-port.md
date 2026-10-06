---
status: completed
created: 2026-10-06
updated: 2026-10-06
slug: run-api-and-loop-library-port
---

# Plan: port the run API and the loop library to the kit

**Repo:** zcode-router-kit (the ZCode edition). **Source:** agnostic-router-kit
`4ded354` (2026-10-06) — the run API, the seven-loop library, the sys1 judge
layer and the `net-search` capability — sitting on the 10-05 plane-package
series. The engine's plans for this work (`2026-10-05-run-api.md`,
`2026-10-06-loop-library-wave.md`) both declare the kit port out of scope and
point here; this document is that follow-up.

**Goal:** an application pointed at the kit's own wire on 8300 spawns and
steers workflow runs under per-app tokens with enforced ceilings, and the
kit's workflow library grows the seven loop shapes — with every flat judgment
riding the dev-decisions/sys1 judge layer and search credits structurally
unspendable by agents — shipped live through `kit apply` the way every kit
change ships.

## Context (deep dive, 2026-10-06, both editions read in full)

1. **Two editions, one plane.** The engine owns the workflow plane (14 modules
   as package `workflow-plane`). The kit carries no copy: it resolves the plane
   as `file:../agnostic-router-kit/lib/workflow`, and `node_modules/workflow-plane`
   is a symlink into the engine checkout. Plane code cannot drift, and
   `tools/check-plane.mjs` (`npm run check:port`) asserts exactly that. So
   every plane-side half of today's work — `answers.jsonl` live answering,
   `opts.app` provenance, the top-level `escalate()`, `sys1.judge`,
   `world.search` / `world.scrape`, `world.spentCredits()`, `persona.model` /
   `persona.tools.deny`, spawn-fact seeding, the `run-start` grants normalization
   — **arrives by resolve and needs no port at all.** `kit apply` ships the
   plane's exports into `~/.zcode/lib/workflow/` beside the router (derived from
   the package's own exports map, plus the `node_modules/workflow-plane` link the
   installed server resolves by).
2. **The live runtime is one apply behind.** `~/.zcode/lib/workflow/` already
   matches the engine (verified module-for-module today), but the live
   `~/.zcode/router/server.js` has had **no re-port since 2026-10-05** — it
   predates the run API, the judge surface additions and the search work, and
   the running process (launchd `com.zcode.model-router`, started 9:34PM 10-05)
   has the older plane loaded in memory. The restart at the end of this plan is
   what makes the new runtime actually live.
3. **What the port is, therefore:** three layers plus env, docs, probes and
   deploy — the **wire** (`router/server.js`), the **roster/config/CLI surface**
   (`lib/render.mjs`, `lib/roster.mjs`, `lib/cli.mjs`,
   `templates/roster.defaults.json`), and the **workflow library**
   (`workflows/*.ts`).
4. **The wire cannot be copied; it must be transplanted.** The kit's server.js
   diverges from the engine's by ~506 lines: upstreams resolve from ZCode's
   live `~/.zcode/v2/provider_config.json` instead of the roster's
   `extraUpstreams`, the bin name is `zcode-router-kit.mjs`, roster apply
   spawns the kit CLI, the mixture proposer timeout and the reason text differ.
   The engine's run-API block is otherwise position-independent: the kit's
   server already carries the same `KIT_HOME_DIR` / `WORKFLOW_RUNS_DIR`
   constants (server.js:1141-1144), the same `envFile()` helper (server.js:182),
   a watcher with the same names, and an SSE route that already reads
   `?token=`. So the transplant is nearly verbatim and provable by diff.
5. **What the kit already has that the loops lean on:** the judge
   (`router/fastino.mjs`, `judge.mode: "cascade"`), the dev-decisions CLI on
   PATH (`~/.local/bin/dev-decisions` — the judge layer's first leg runs
   unprivileged because `dev-decisions` is a default-allowed `process`
   command), run memory, per-shape budgets, checkpoints, delegation, the Board
   tab, and the dashboard's SSE stream.
6. **`workflows/` is a mixed directory and must stay that way.** It holds 32
   `.dwf.ts` files (ZCode's saved-workflow library) plus
   `runtime-surface-probe.ts`. `readLibrary` filters on `.dwf.ts`
   (workflowlib.mjs:80), so `kit workflows sync` copies only those into
   `~/.zcode/workflows` — plane `.ts` files added beside them are invisible to
   the ZCode library and safe. The engine's run API resolves workflows via
   `findWorkflowFile` → `<config.kitRoot>/workflows/<name>.{ts,mts,js,mjs}`, and
   the kit's `kitRoot` is this repo, so the loops land in
   `~/Projects/zcode-router-kit/workflows/`.
7. **The kit's own baselines come first.** The kit's convention (recap 10-05)
   pins `sha256 ~/.zcode/router/config.json`, runs `kit doctor` before/after,
   and treats a moved baseline as a finding, not noise. Record all of it before
   touching anything.
8. **Method precedent.** The board port (engine-side, 2026-10-05) composed by
   construction and proved the result with **bidirectional diff assertions**
   rather than by eye. The same method applies to the wire here: assert both
   that the kit's run-API block matches the engine's, and that porting it
   introduced no new class of divergence beyond the known ZCode-specific set.

## Approach

### Phase 0 — preflight (no code)

- Record baselines: `kit doctor` output (problem count), `sha256sum
  ~/.zcode/router/config.json`, `curl /healthz`, `npm run check:port` (expect
  green), `which dev-decisions`, and the state of
  `~/.zcode/router/.env` (the three Firecrawl names are expected **absent**
  until Phase E).
- Confirm the engine checkout is clean (`git -C ~/Projects/agnostic-router-kit
  status --porcelain -- lib/workflow`) — a dirty plane makes `check:port`'s
  green a lie about released code.

### Phase 1 — confirm the plane needs no port (verification, not code)

- `npm run check:port` must pass all three checks (the kit resolves the engine
  checkout; no competing `lib/workflow/`; the installed runtime beside the
  router matches — note this install is still one apply stale until Phase F and
  that is expected, not a failure).
- Spot-check the resolved plane exposes the new surface: a throwaway script
  importing `workflow-plane/engine.mjs` and asserting
  `typeof runWorkflow` plus the presence of the search config plumbing in
  `services.mjs` (`grep searchWeb`).

### Phase 2 — the wire (`router/server.js`)

Transplant the engine's run-API regions onto the kit's server, adapting only
what the kit's divergence requires. The regions and their engine anchors:

- **Imports** (engine server.js:40-45): `runWorkflow`, `resolveGrants`,
  `FACT_KINDS`, `slug`, `freeRunDir`, `parseHeader`, `validateArgs` from
  `workflow-plane/*`.
- **The run-API helper block** (engine server.js:1168-1197): the `spawnOwners`
  registry, `findWorkflowFile`, `readRunOwner`. Lands beside the kit's existing
  watcher block, which already defines the same `KIT_HOME_DIR` /
  `WORKFLOW_RUNS_DIR`.
- **The bearer gate, two token classes** (engine server.js:1429-1451):
  `caller = {operator}` for the local token, `caller = {app}` for a
  `config.apps[].token` row, unknown still 401 with the unchanged message. The
  SSE route's `?token=` check accepts both classes (widening the kit's
  existing local-token-only check at server.js:1355).
- **The SSE fix** (engine server.js:1432-1437): `res.on("close")` replaces
  `req.on("close")` — the request stream closes when its empty body is
  consumed, so every SSE client was dropped one frame in and the dashboard's
  live stream never worked. Port verbatim; this is a pre-existing kit bug the
  engine's probe caught.
- **The three routes** (engine server.js:1512-1760): `POST /v1/runs`,
  `POST /v1/runs/<id>/answers`, `GET /v1/runs/<id>/artifacts` — validation
  order preserved (workflow exists → args against the workflow's own header →
  facts against `FACT_KINDS` → answers shape → grants resolve → app ceiling →
  app sandbox → fire-and-forget `runWorkflow`), each failing before a run
  directory exists.
- **The search config block** (engine server.js:1637-1643): assembled from the
  kit's existing `envFile()` — `{backend, apiKeyEnv, envMap, scrapeBaseUrl,
  scrapeApiVersion}` — so the plane sees only declared-name values.
- **The router-log lines**: `run-spawned`, `run-spawn-refused`,
  `run-api-run-done`, `run-api-run-failed`.

Do **not** port anything else from the 506-line delta: the engine's static
upstream registry, `router/swarm.mjs`, the mixture timeout and reason-text
changes are separate decisions (see Out of scope).

Proof of the transplant, both directions:

- the run-API block, marker to marker, is identical to the engine's modulo the
  adaptations (which should be none beyond the `apps` plumbing — say so loudly
  if any appear);
- `diff` of the whole kit server against the engine's stays within the known
  divergence set — the port adds no new class of difference.

### Phase 3 — roster, render, CLI

- `templates/roster.defaults.json`: `router.apps: []` beside `localToken`,
  annotated like the rest of the template.
- `lib/render.mjs`: render `cfg.apps` (name, token, grantCeiling array or null,
  optional workdir; rows missing name+token dropped).
- `lib/roster.mjs`: `validateRoster` requires name + token per app row and
  `grantCeiling` to be an array when present.
- `lib/cli.mjs`: `kit status` prints a run-api apps block (name + ceiling);
  the `kit workflows run` path assembles the same search config from
  `readEnvFile(ENV_FILE)` (the kit's envstore, `~/.zcode/router/.env`) so
  CLI-spawned runs can search exactly like wire-spawned ones.
- The kit's committed `roster.json` gains no app rows — apps are explicit
  operator declarations, like the engine's.

### Phase 4 — the loop library and the probes

Copy the seven loops into `workflows/` as plane `.ts` files:
`deep-research.ts`, `remediate.ts`, `triage.ts`, `refine-loop.ts`,
`red-team.ts`, `watchdog.ts`, `router-eval.ts`. They are harness-neutral
(plane surfaces only) and copy verbatim; their conventions ride along: the
`ESCALATE` persona clause, named stops, `NO_SEARCH = { tools: { deny:
["web_search"] } }` on every deep-research agent, gate-file exclusion in
remediate, the stated LLM exception in refine-loop's rubric scoring.

Copy the probes this port needs to verify itself:

- `http-probe.ts` — the zero-model fixture the run-API probe spawns (required).
- `search-probe.ts` — granted / refused / no-key modes.
- `judge-probe.ts` — the judge envelope on a self-evident head (one
  dev-decisions call, zero agent calls).
- `context-probe.ts` — the standing 19/19 zero-agent regression fixture the
  engine re-runs after every phase; the kit's equivalent proof that the
  existing surface is untouched.

The remaining model-calling probes (delegate/edit/tokens/budgets/competition/
checkpoint/commands/services/grants/escalation/plane) are **not** part of this
port; the kit has never carried them and their absence is not a regression.

### Phase 5 — the search backend env (operator action, no code)

`kit env set FIRECRAWL_API_KEY=…`, `FIRECRAWL_SCRAPE_URL=…`,
`FIRECRAWL_SCRAPE_VERSION=…` into `~/.zcode/router/.env` (600, never tracked).
The engine's runtime already holds these values; the self-hosted scrape
instance is on this machine. Scrapes ride self-hosted (zero cloud credits);
only `search-probe`'s granted mode and a real deep-research run spend cloud
credits, and both are bounded and counted. No raw key ever enters a tracked
file — the kit's `kit apply` warns on raw keys and that warning is a stop.

### Phase 6 — deploy (the operator action the engine's recap deferred)

- `kit apply --dry-run` — expect the router files, the plane modules and the
  rendered `apps` config in the plan.
- `kit apply` — ships `router/*` and the plane into `~/.zcode/` and restarts
  `com.zcode.model-router`. This is the kit's own service and the restart is
  intended (unlike the engine-side launchd incident, where the *other*
  edition's label was hijacked by a scratch apply). Expect a brief blip on
  8300; note it.
- `kit doctor` after — compare against the Phase 0 baseline; the count must
  not move for a reason this plan did not intend.
- `npm run check:port` again — the installed runtime must now match the
  engine's modules (the drift check that actually bit before).

### Phase 7 — verification

Port `tools/probe-run-api.mjs` to the kit's names and run it: it renders a
scratch runtime with `kit apply --only router` (never a full apply — the
launchd lesson), starts the scratch server on **8399** with its own home
(`AGNOSTIC_ROUTER_KIT_HOME` plus the kit's `ZCODE_HOME` / `ZCODE_ROUTER_DIR` /
`ZCODE_WORKFLOWS_DIR` / `ZCODE_ROUTER_KIT_ROSTER` scratch overrides and dummy
keys), and asserts 33 checks with zero model calls. Then the loop-library
proofs: `context-probe` 19/19, `judge-probe`, `search-probe`'s three modes, and
at least one real loop end to end — `triage` first (1.4 s, zero agent calls,
sys1 classification and an escalation lane), then `watchdog`'s three paths
(baseline / no-change zero-model / changed with one `matters` head).

## Acceptance criteria

Order is identity. All verified through the kit's own bin and wire.

- [x] **C0:** `POST /v1/runs` on the kit's wire returns `{ok, runId, runDir}`; the run-start journal line carries `app`, `grants` (as an array) and `facts`; `summary.json` carries `app`.
- [x] **C1:** an app requesting a grant outside its ceiling is refused by name and journaled as `run-spawn-refused`; the operator token has no ceiling.
- [x] **C2:** an app's body `workdir` resolving outside its root is refused by name; the default root `<kit home>/apps/<name>/workspaces` is created on demand.
- [x] **C3:** live answering works end to end — the run escalates, a matching-topic POST resolves it with journal source `live`, a declared answer outranks a live one (`declared`), and the warmup resolves `none`.
- [x] **C4:** artifacts: the versioned index lists, `?file=` downloads inside the run, `..` and foreign paths are refused, another run's artifact is 404, another app's run is 403.
- [x] **C5:** two runs spawned in the same second get distinct run dirs, and both stream on SSE with correct attribution under both token classes via `?token=`.
- [x] **C6:** the SSE route uses `res.on("close")`; the dashboard's live stream receives events (the pre-existing one-frame drop is gone).
- [x] **C7:** the existing surface is untouched — `/v1/chat/completions`, `/route`, `PUT /api/roster`, the dashboard tabs behave as before — and `context-probe` runs 19/19 with zero agent calls through the kit's bin after every phase.
- [x] **C8:** `node --check` is clean on every touched file, and the bidirectional diff assertions from Phase 2 hold.
- [x] **C9:** the seven loops run under `kit workflows run <name>.ts` from the kit's own `workflows/` directory, each with its named stop reasons in the result.
- [x] **C10:** `sys1.judge` is available on the workflow surface in the kit's runtime, routes dev-decisions first with `source` journaled, and `judge-probe` passes with zero agent calls.
- [x] **C11:** `world.search` / `world.scrape` work from a kit-spawned run: the journal line carries `results` and `creditsUsed`, never key material (key-neutrality grep over `lib/` and `workflows/` is 0), and a missing key is a configured absence naming `FIRECRAWL_API_KEY` and `kit env set`.
- [x] **C12:** deep-research's structural protections hold in the kit: every agent denies `web_search`, searches run in the workflow only, scrapes target the self-hosted instance, and `world.spentCredits()` is the one budget gate.
- [x] **C13:** `kit doctor` is back at its Phase 0 baseline (or better) after apply, `/healthz` is green, and a smoke chat completion routes on 8300.
- [x] **C14:** `npm run check:port` is green after apply — the installed runtime beside the router matches the engine's modules, and the kit still resolves the plane by specifier.
- [x] **C15:** no raw API key in any tracked file; Firecrawl values live only in `~/.zcode/router/.env` (600).
- [x] **C16:** the contract docs are updated with the code, not after — the feature docs, the API table, the security model, and a session recap per house convention.

## Files to be touched

- `router/server.js` — the run-API transplant (Phase 2).
- `templates/roster.defaults.json` — `router.apps: []`.
- `lib/render.mjs`, `lib/roster.mjs` — `apps` rendering and validation.
- `lib/cli.mjs` — `kit status` apps block; the run-path search config from
  `readEnvFile(ENV_FILE)`.
- `workflows/` — the seven loops, `http-probe.ts`, `search-probe.ts`,
  `judge-probe.ts`, `context-probe.ts`.
- `tools/probe-run-api.mjs` — ported to the kit's env names, port 8399, dummy
  keys, `apply --only router` only.
- `docs/features/run-api.md`, `docs/features/loop-library.md`,
  `docs/features/deep-research.md` — new feature docs (kit-adapted).
- `TECHNICAL-DOCUMENTATION.md` (API table, workflow surface, security model),
  `FUNCTIONAL-SPECIFICATIONS.md`, `README.md` (security model, roadmap) —
  per the house rule: update with the code.
- `docs/plans/2026-10-06-run-api-and-loop-library-port.md` — this plan;
  `docs/recaps/SESSION-RECAP-2026-10-06.md` — the recap flips this plan's
  status to completed.
- Not touched: the 32 `.dwf.ts` files, `~/.zcode/workflows/`,
  `~/.zcode/v2/provider_config.json`, the engine repo.

## Out of scope

- **The proxy-internal swarm** (`router/swarm.mjs`, `createSwarm`): the kit's
  swarm path is the `.dwf.ts` delegation and that stays as-is; porting the
  proxy swarm is its own decision with its own risk budget.
- **The 20 kit-only `.dwf.ts` workflows** and the rest of the upstream probe
  suite (nothing here needs them).
- **Engine-side fixes found during the dive:** `world.scrape` journals `bytes`
  but does not add to the credit meter even though `scrapeUrl` returns
  `creditsUsed`; and because the search config block is spread wholesale, the
  scrape request carries `Authorization: Bearer $FIRECRAWL_API_KEY` to the
  self-hosted instance, contrary to the engine plan's stated invariant. Both
  are inherited as-is by this port and belong to an engine-side plan; recording
  them here is what keeps the port from silently lauding them.
- **AG-UI mapping, Alexandria as a search backend, hosted/multi-host, cross-run
  memory, raw sys1 exposure to apps.**
- **Installing the engine runtime** — this plan ships nothing into
  `~/.agnostic-router-kit/`.

## Verification

```
# baselines (Phase 0)
npm run check:port
kit doctor | tail -1            # problem count
sha256sum ~/.zcode/router/config.json

# the port itself
node --check router/server.js lib/render.mjs lib/roster.mjs lib/cli.mjs
node tools/probe-run-api.mjs    # 33/33, zero model calls, port 8399, never a full apply

# the library
kit workflows run context-probe                            # 19/19, zero agent calls
kit workflows run judge-probe                              # 0 agents, 1 dev-decisions call
kit workflows run search-probe --args '{"mode":"refused"}'  # no grant: refusal by name
kit workflows run search-probe --args '{"mode":"no-key"}' --grant net-search # with a runtime env lacking the key (before Phase E, or the scratch runtime): the configured absence names the env var
kit workflows run search-probe --args '{"mode":"granted"}' --grant net-search # spends one real search (~2 credits)
kit workflows run triage --args '{"items":"…"}'            # ~1.4s, zero agent calls, sys1 class + escalation lane
kit workflows run watchdog --args '{…}'                    # baseline / no-change zero-model / changed one head

# ship
kit apply --dry-run
kit apply                       # restarts com.zcode.model-router — brief blip on 8300
kit doctor | tail -1            # back at baseline
npm run check:port              # installed runtime current
curl -s localhost:8300/healthz
```

## Linked artifacts

- Engine commit `4ded354` and its plans `docs/plans/2026-10-05-run-api.md`,
  `docs/plans/2026-10-06-loop-library-wave.md`, feature docs
  `docs/features/run-api.md`, `docs/features/loop-library.md`,
  `docs/features/deep-research.md`, recaps `SESSION-RECAP-2026-10-05.md` /
  `-06.md` (all in the engine checkout).
- `tools/check-plane.mjs` — the port-boundary check that makes the plane half
  of this port structural rather than manual.
- This repo's updates with the code: `docs/features/run-api.md`,
  `docs/features/loop-library.md`, `docs/features/deep-research.md` (new);
  `TECHNICAL-DOCUMENTATION.md` §5 (API table), §6 (security model), §3 (the
  two workflow file kinds); `FUNCTIONAL-SPECIFICATIONS.md` §1 (access model),
  §3 (core features), §4 (user flows); `README.md` (What you get, Safety model);
  the recap `docs/recaps/SESSION-RECAP-2026-10-06.md`.
- `docs/plans/2026-10-05-kanban-board.md` — the composition-and-diff method
  this plan reuses for the wire.
- `docs/plans/2026-10-05-harnessed-agent-control-plane.md` item 16 — the
  measured re-port gap this plan closes the rest of.
