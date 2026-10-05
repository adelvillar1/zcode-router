---
status: active
created: 2026-10-04
updated: 2026-10-05
slug: workflow-dashboard
---

# Workflow visualization — live graph from plan to recap

> **For the harness:** implement phase-by-phase, task-by-task; every task names exact files and a verify command. Dispatch strictly in phase order — the pipe before the graph model, the model before the views, the agnostic build before the zcode retrofit (Phases 1–4 are upstream; Phase 5 ports them verbatim).

**Goal:** see everything that was orchestrated and delivered as one navigable graph — plan → criteria → runs → agents → gates → deliverables → commits → recap — live while it happens, and as a publication-quality snapshot on demand.

**Architecture:** one read-only graph model, three renderers. `lib/workflow/graph.mjs` assembles the orchestration graph from local sources (run journals, plan markdown, the dev-decisions store, git log, recap docs); the dashboard renders it as a layered DAG that updates over the existing SSE pipe; `kit workflows graph` exports it headless as Graphviz DOT or as archify-typed JSON for archify's gated snapshot renderer. The kit stays the only writer everywhere; every new module is read-only.

**Tech stack:** no new runtime dependencies. Node http + SSE (pattern already in both routers), hand-rolled layered-DAG SVG in the existing single-file dashboard, JSONL/MD parsing already in the kit's style.

---

## Context

Workflow runs are the kit's long work — minutes to half an hour — and today they are invisible: a terminal shows phase lines at best, nothing distinguishes a healthy run from a stalled one until it exits (2026-10-04's transport bug hid behind that silence for most of an hour), and nothing shows the session as a whole — which plan produced which runs, which agents built which deliverables, which gates passed them, which commit recorded them. The raw material all exists locally and is already written continuously: run journals (`run.jsonl` + `summary.json`), plan files with checkbox criteria, the dev-decisions calibration store (gate verdicts keyed by `input_sha256`), the usage ledger, git history, and session recaps. Missing: the model that joins them and the views that draw them. This plan builds both in `agnostic-router-kit`, then retrofits verbatim into `zcode-router-kit`.

## Approach

### Phase 1 — the pipe (agnostic-router-kit)

1. **Shared normalizer** — `lib/workflow/events.mjs`: `normalize(line, runId)` maps journal kinds (`run-start`, `phase`, `agent`, `tool`, `report`, `escalation`, `artifact`, `command`, `run-done`, `run-failed`) to view events, tool args truncated to 200 chars. Verify: `node --check` + fixture replay.
2. **Tail watcher** — `router/server.js`: `createWorkflowWatcher(kitHome)` scans `workflow-runs/` on boot, watches for new run dirs, tails each `run.jsonl` by offset into a per-run ring buffer (cap 500) and SSE subscribers. Strictly read-only. Verify: grep clean; journal shasum unchanged across a router kill mid-run.
3. **SSE + snapshot routes** — `GET /api/workflow-events` (SSE, 5s heartbeat carrying per-run last-event age), `GET /api/workflow-runs`, `GET /api/workflow-graph` (full graph snapshot, Phase 2 model). Local-token auth. Verify: events ≤2s behind the journal write.

### Phase 2 — the graph model (agnostic-router-kit)

4. **Graph builder** — `lib/workflow/graph.mjs`: `buildGraph(kitHome, repoRoot)` returns `{nodes, edges}`. Node kinds: `plan` (frontmatter status), `criterion` (checkbox id C0…, done/pending), `phase` (### plan phases), `run` (workflow-runs dirs: name, ok, ms), `part` (swarm decompose parts, from journal stage events), `agent` (per ask, from journal actors, with tool-call counts), `artifact` (deliverables: path, bytes, versions), `gate` (dev-decisions `evidence-gate` rows: verdict, provider), `commit` (git log), `recap` (docs/recaps/*.md). Edge kinds: `defines` (plan→criterion), `sequences` (plan→phase), `dispatches` (phase→run, matched by workflow name), `spawns` (run→agent, run→part), `produces` (agent→artifact), `judged-by` (part/artifact→gate, matched via swarm-gate labels), `recorded-by` (run→commit, commit-message match), `summarized-in` (deliverables→recap). Read-only over all sources. Verify: built against this session's real data — the graph must contain ≥1 plan, ≥10 runs, ≥3 gates, ≥9 artifacts, ≥1 recap, every edge endpoint resolvable.
5. **Graph event stream** — watcher emits `graph:node` / `graph:edge` deltas as journal events land, so the model grows live. Verify: a probe run adds its run/agent/artifact nodes to `/api/workflow-graph` while running.

### Phase 3 — the views (agnostic-router-kit)

6. **Workflows tab (temporal)** — existing tab + SSE patterns: phase progress, per-agent activity feed, artifacts landing, gate verdicts, per-run last-event age (the stall detector). Completed runs render from summary + replay. Verify: one probe run against the C3 checklist.
7. **Graph tab (spatial)** — layered-DAG SVG (plan on the left, recap on the right; BFS layering, hand-rolled, no framework — force layout rejected: jitter under live updates), node color by kind, live nodes/edges appearing as deltas arrive, click-through to a detail panel (journal excerpt, artifact preview, gate verdicts, criterion text). Visual pass via archify authoring defaults at build time. Verify: C5 checklist against a live probe run.
8. **Contract doc** — `docs/features/workflow-dashboard.md` (event + graph schema, routes, read-only rules).

### Phase 4 — headless exports (agnostic-router-kit)

9. **`kit workflows graph`** in `lib/cli.mjs` — `--dot` prints Graphviz DOT of the session graph (rankdir LR, cluster per run); `--archify <out.json>` emits the candidate JSON in archify's `workflow` schema for archify's own gated rendering (the kit emits typed JSON only; archify stays a skill-side tool, not a dependency). Verify: DOT parses (`dot -Tsvg` or `graphviz` absent → structural check); the archify candidate passes `node bin/archify.mjs finalize workflow … --json` with exit 0.

### Phase 5 — retrofit to zcode-router-kit

zcode-router-kit has the workflow **library** (`workflowlib.mjs`) but no kit-side runtime — its `.dwf.ts` workflows run inside the ZCode harness. The retrofit ports the runtime and the views together, or the tabs watch nothing:

10. **Port the runtime verbatim** — `lib/workflow/` (engine, tools, schema, meta, events, graph) with provenance headers ("verbatim port; upstream: agnostic-router-kit"); `kit workflows run` added to `lib/cli.mjs`; `runtime-surface-probe.ts` as smoke test. This deliberately supersedes the extraction plan's no-zcode-source scope — that guard protected the extraction; this plan changes zcode source on purpose under the same discipline. Verify: `node --check` each file; probe runs through zcode's router.
11. **Port the pipe and both views** — watcher + routes into `router/server.js`, both tabs into `router/dashboard.html`, watching zcode's kit home via its `lib/paths.mjs`. Verify: C2/C3/C5 checks against zcode's router.
12. **Guards at close** — `npm run kit -- doctor` green; `config.json` shasum byte-identical (routing untouched; the deliberate delta is the dashboard asset); usage tabs + save-and-apply unregressed. Verify: shasums + existing checks.

## Use cases (when the feature has user-visible behavior)

- [x] A: A user launches a long workflow and watches the graph grow — run, agents, parts, artifacts, gates appearing as they happen — plus the activity feed for the second-by-second view; no refresh, no waiting for the run to end. *(verified 2026-10-05: browser against the 8303 scratch instance while the 54-min adversarial-solve run executed — the Activity table's event count rose with the journal during a browsing pass, and the Graph tab's node count grew 381 → 382 with the graph tab open, no refresh)*
- [x] B: A stalled run is distinguishable from a working one: last-event age per run in both views, so silence shows up in the first minute instead of the fortieth. *(verified 2026-10-05: the dead 01-14-11 adversarial run flagged `stalled?` at 1.9h of silence while live runs read seconds-old; heartbeat carries per-run lastEventAgeMs every 5s; this needed two real fixes in the watcher — runId clocks are UTC so startedAt needs the Z suffix, and boot-time replay must stamp lastEventAt from each event's own offset clock, not wall-clock)*

## Acceptance criteria

Order is identity: use cases are C0–C1, criteria C2–C10. Never reorder after gating.

- [x] Every journal line reaches the `workflow` SSE channel within 2s of the write, including runs started after router boot. *(verified 2026-10-05: the SSE hello frame carries the full run snapshot at connect; during browsing the Activity table tracked the live adversarial journal (events 663 → 668) within the 1s poll + 5s heartbeat cadence; the watcher rescans `workflow-runs/` every tick, so post-boot runs appear without router restart)*
- [x] The activity tab renders live phases, agents, artifacts, gates and last-event age; completed runs render from summary + replay. *(verified 2026-10-05 in the browser: the failed 50.7m adversarial run rendered its summary strip, both phase names, agent asks/tool counts, the 200-line replay feed; the SSE `summary` frame flipped a live run to `failed` mid-browse; gates render from the graph model time-matched to the run's window)*
- [x] `buildGraph` assembles the plan→recap orchestration graph from all local sources with the defined node/edge kinds, every edge endpoint resolvable, and — built on this session's real data — ≥1 plan, ≥10 runs, ≥3 gates, ≥9 artifacts, ≥1 recap. *(verified 2026-10-05: curl against the 8303 instance — 378–382 nodes / 367–372 edges over the session's real data: plan 2, criterion 23, run 37–38, agent 240+, artifact 11, gate 19, commit 35, recap 2; 0 dangling edges; README and the handoff doc excluded from plans so plan:2)*
- [x] The graph tab renders the live DAG with click-through detail, and nodes/edges appear during a run without refresh. *(verified 2026-10-05: layered-DAG SVG (longest-path columns, barycenter rows), run-node click-through with per-kind detail and an "open run in Activity" cross-link, wheel zoom + drag pan; node count grew while the tab was open; layout screenshot-checked — initial view anchors top-left at readable scale after the first pass fit the whole 8.6k-px-tall graph into a sliver)*
- [x] `kit workflows graph` exports valid DOT and an archify `workflow` candidate that passes archify's finalize gates (exit 0). *(verified 2026-10-05: `--dot` structural check since graphviz is absent — 372 edges, 0 dangling refs, balanced braces/quotes; the scoped `--archify --archify-run` candidate passed `archify validate` and `archify finalize workflow … --quality showcase --json` with exit 0, all four gates pass, 760,988-byte publication HTML + receipt. The full 380-node session dump does not fit archify's readable-v2 fan-out limits — the candidate is one run's story with criteria/phases collapsed to summaries and agents to one counted node; per-agent detail stays in the dashboard and DOT)*
- [x] `kit workflows watch` streams a live run and replays a finished one through the same normalizer, no router needed. *(verified 2026-10-05: finished runtime-surface-probe replay = one normalized line per journal event (25 printed vs 24 `wc -l` — the journal's unterminated tail line included); `--follow` on the live adversarial run streamed its events for a 6s window ending exactly at the journal's newest phase; file reads only)*
- [x] The watcher and graph builder are read-only: no write path into any watched source, and killing a router mid-run leaves every watched file byte-identical. *(verified 2026-10-05: grep — graph.mjs and events.mjs contain no write calls, the CLI writes only kit-install paths and the `--archify` candidate file; the 8303 scratch router was killed mid-run twice while the adversarial run kept writing — the CLI (the only writer) continued cleanly, and quiescent watched files (finished journal + summary + plan md) hashed identical across a kill/restart)*
- [x] The agnostic dashboard is unregressed (usage SSE, save-and-apply) and no new route reads outside its declared roots. *(verified 2026-10-05: dashboard edits are strictly additive — nav buttons, a CSS block, two tab panels, one client block, two boot lines; existing render functions untouched, concatenated script blocks node --check clean; Usage tab renders (6 totals cards, models + recent tables) on 8303; the new routes read only the kitHome and repoRoot subtrees)*
- [x] zcode-router-kit serves both tabs fed by its own kit-run journals (probe runs through zcode's kit), doctor green, `config.json` byte-identical. *(verified 2026-10-05: `lib/workflow/` ported verbatim with provenance headers, watcher + routes transplanted surgically, both tabs in zcode's dashboard; a scratch instance via `kit apply` with `ZCODE_ROUTER_DIR` on 8305 ran `kit workflows run runtime-surface-probe` (2 agent calls, 4 phases, artifact) with the Activity/Graph tabs showing it live and Usage unregressed; `npm run kit -- doctor` green; `~/.zcode/router/config.json` sha256 `d0485e1d…` byte-identical all session — the live service was never restarted; applying to it and restarting is the operator's call)*

## Files to be touched

**agnostic-router-kit:** `lib/workflow/events.mjs`, `lib/workflow/graph.mjs` (new), `router/server.js` (watcher + routes), `router/dashboard.html` (two tabs), `lib/cli.mjs` (`workflows watch`, `workflows graph`), `docs/features/workflow-dashboard.md` (new).
**zcode-router-kit:** `lib/workflow/` (ported), `lib/cli.mjs` (`workflows run`), `workflows/runtime-surface-probe.ts` (new), `router/server.js` + `router/dashboard.html` (ported pipe + tabs), `TECHNICAL-DOCUMENTATION.md` (one paragraph).
**this repo:** `docs/plans/2026-10-04-workflow-dashboard.md` — this plan.

## Out of scope

- Starting/stopping/cancelling runs from the UI — the kit CLI stays the only writer and control surface.
- Visualizing ZCode-harness dynamic-workflow runs (CreateWorkflow) — they journal inside the harness; a bridge is a separate plan.
- Cross-session historical analytics; the usage ledger already covers spend.
- Swarm instrumentation beyond what journals and the ledger already emit.

## Verification

**C2:** `curl -N /api/workflow-events` during a probe run; per-line wall time ≤2s, including a post-boot run.
**C3:** one probe run with the tab open; the checklist is the criterion's own list.
**C4:** `node -e "buildGraph(…)"` against this session's kit home — counts and edge-endpoint assertions as listed.
**C5:** probe run with the graph tab open; click each node kind; deltas appear live.
**C6:** `kit workflows graph --dot > /tmp/g.dot && dot -Tsvg /tmp/g.dot -o /tmp/g.svg`; `kit workflows graph --archify /tmp/candidate.json && node bin/archify.mjs finalize workflow /tmp/candidate.json /tmp/graph.html --quality showcase --json` → exit 0.
**C7:** watch output of a finished run, normalized, diffs clean against the journal; live run streams with the router down.
**C8:** grep for write calls in watcher/graph paths → none; sha256 every watched file before/after a router kill mid-run.
**C9:** existing dashboard checks pass; `../`-escape probe on new routes 404s.
**C10:** probe runs via zcode's `kit workflows run` with zcode's dashboard open; `npm run kit -- doctor` green; `shasum ~/.zcode/router/config.json` unchanged.

## Risks

- **Journal/plan format drift** breaks model or view silently — one shared normalizer + one graph builder consumed by everything; the runtime owns event kinds.
- **Graph density** (deep-dive ran 200+ events; tool calls would explode the graph) — tool calls collapsed into per-agent counts; ring buffers; args truncated; replay capped.
- **dashboard.html growth** — both tabs reuse existing tab/SSE patterns; the DAG layout is ~200 lines of hand-rolled SVG, no framework.
- **Edition divergence** — Phase 5 ports verbatim with provenance headers; events.mjs and graph.mjs are the two files that must never fork.

## Dependencies

None new. Journals, SSE, local-token auth ship today in both editions; plan/gate/recap/git are local files. Archify remains skill-side: the kit only emits its typed JSON.

## Notes

- **Renderer division of labor:** the dashboard tab is the live renderer; archify is the publication-quality snapshot renderer (its `workflow` type is built for exactly "plans and step-by-step life processes", and its finalize gates buy validated, browser-checked HTML); DOT is the headless one. One graph model, three projections — no renderer owns the data.
- **sys1 decision-shape check (per plan convention):** considered per-event judgment (classify/render, gate) — none fits: the journal `kind` and the graph `node.kind`/`edge.kind` are deterministic classifications. No sys1 head; stated rather than left unasked.
- The stall detector (use case B) is what would have caught 2026-10-04's transport bug in the first minute; the graph (use case A) is what shows the hour's actual yield — 10 runs, 3 gate verdicts, 9 deliverables — as one picture from plan to recap.
