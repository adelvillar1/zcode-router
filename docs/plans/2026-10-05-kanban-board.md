---
status: completed
created: 2026-10-05
updated: 2026-10-05
slug: kanban-board
---

# Plan: kanban board replaces the plan-recap graph view

> **Sequence, recorded honestly.** This plan was drafted and approved through ExitPlanMode on 2026-10-04 (`.zcode/plans/plan-sess_024fedae-1fbd-49ab-a6a4-cb06179cd646.md`) and implemented the same day. This file is the repo's record of that contract, written at close per the `docs/plans/` convention — the ISO prefix is the creation date of *this* file, not the date of approval.

**Goal:** see where the kit's work stands — what is planned, executing, completed and abandoned — as a kanban board instead of a graph, with each card naming its deliverables, its agents, and what its agent is doing right now, and opening the task's detail on a click.

**Architecture:** one file changes, `router/dashboard.html`. Every route and every SSE frame the board needs already exists, so `router/server.js` and the workflow plane are untouched and the change stays kit-local with no engine blast radius.

## Context

The dashboard's Board tab (then called Graph) drew the plan→recap DAG — plan on the left, recap on the right, 521 nodes and 550 edges over this machine's real data. It was a correct picture and an awkward answer. The question an operator opens the tab with is not "what are the nodes" but "where does the work stand": which plans are still open, which runs are live right now, what finished and what was abandoned. Reading that off a 550-edge layered DAG means tracing paths and cross-referencing the Activity tab, and a run five minutes into an eighteen-minute adversarial solve is one amber box among hundreds.

The raw material is all already on the wire. `GET /api/workflow-graph` returns the whole graph — `plan / criterion / phase / run / agent / part / artifact / gate / commit / recap` nodes and `defines / sequences / dispatches / verifies / spawns / produces / judged-by / recorded-by / summarized-in` edges, with plans carrying their own status lifecycle (`draft → active → completed ↘ abandoned`). The SSE stream carries more than the graph tab ever used: a per-run `heartbeat` naming whether a run is still live and how old its newest journal line is, a `summary` frame the moment a run ends, and the **full normalized event for every journal line** — `phase`, `agent`, `tool`, `artifact`, `contract`, `report`, `run-done`. That last one is what fills the "what is the agent doing" row.

So the board is a projection of the existing graph onto four columns, not a new data path. One file, no new dependency, no new write surface.

## Approach

### Phase 1 — the board tab

1. **Rename and re-house.** The `#tab-graph` panel becomes `#tab-board` (nav label "Board"), holding two sections behind a `Board` / `Graph` toggle: the board (default) and the existing layered DAG. Board is the default because it is the answer to the common question; the DAG stays one click away over exactly the same model, which is why it is a toggle and not a deletion. View mode is a choice, not state, and is remembered in `localStorage` (`zcode-router-board-mode`) the way the theme already is.
2. **The item model.** A card is one work item: a plan with the runs it dispatched, or a bare run when no plan covers it. A run belongs to a plan when one of the plan's phases dispatches it (`phase:<slug>:i --dispatches--> run:<id>`) or one of its criteria verifies it (`crit:<slug>:n --verifies--> run:<id>`) — the two edge kinds the graph builder draws from a plan's prose. Every other run is its own item, which is where ad-hoc kit probes and smoke tests show up.
3. **Column derivation.** A plan item: `status === "abandoned"` → Abandoned; `status === "completed"` → Completed; any attached run live → Executing; otherwise Planned. A bare run: live → Executing; `ok === false` → Abandoned; otherwise Completed. That last branch includes `ok == null`, a run whose journal has a terminal line but whose `summary.json` has not landed — neither a pass nor a failure, so it reads Completed and says `ended` on its face rather than being guessed either way.

### Phase 2 — the card and the detail

4. **Card anatomy.** Three labelled rows. *deliverables*: a plan's criteria with the checked count plus the artifacts of its runs; a run's artifacts with version, byte size and path. *agents*: `agent` nodes reached over `spawns`, one row per actor name with asks and tool calls — the same actor recurs across a plan's runs, so a plan card aggregates by name rather than repeating a row per run, and a tool call with no actor behind it is not an assignment and is not shown. *now*: the latest phase, the latest tool call with a truncated argument, or the artifact an agent last produced, plus the age of the newest journal event on a live card. Swarm parts appear with their last gate verdict.
5. **Click-to-detail** reuses the existing `#gdetail` panel rather than replacing it. A run's detail fetches `/api/workflow-run/<id>` and renders the `contract` events — the durable record of which agent owns which files, what it provides and how many acceptance criteria it accepted — alongside phases, the agent table, artifacts with paths, and the gates attributed to the run's time window by the same heuristic the Activity tab already uses. A plan's detail renders the criterion list with done/open marks, phases, runs with state, artifacts, the `recorded-by` commits and the `summarized-in` recaps. The run detail keeps the "open run in Activity tab" cross-link.

### Phase 3 — liveness

6. **Who says a run is live.** The journal's `run-done` line only reaches the board as an `event`, and `summary.json` lands a beat later, so neither is the authority. The `heartbeat` frame is: the server computes `!terminal || !summary` and broadcasts it every 5s, so the page sets `run.active` from the heartbeat and a finished card moves within one heartbeat. The `summary` frame is applied the instant it arrives, which usually makes the move immediate. `event` frames fill the per-run activity tail; `graph-node` / `graph-edge` deltas merge new agents and artifacts as they appear. The tab also polls the graph every 10s while visible — cheap, because the server memoizes it for 5s — so new plans, gates, commits and recaps land without a refresh. This replaces the old behaviour of fetching once when the tab was clicked.

### Phase 4 — verification

7. **Run the real code against the real data, twice.** First in Node: a harness extracts the actual board module and helpers out of `router/dashboard.html` and evaluates them against the real `buildGraph()` output, so what is tested is the shipped code, not a description of it. Then in a real browser against a live router on real plan and run data: four columns rendered and measured, a card click opening the detail, the Graph toggle still drawing the DAG, and the Activity tab unregressed.
8. **Docs.** `docs/features/dashboard.md`, `FUNCTIONAL-SPECIFICATIONS.md` §5, `router/README.md`'s dashboard section, and this plan.

## Use cases

- [x] A: An operator opens one tab and sees where the work stands — which plans are still open, which runs are live this second, what finished, what was abandoned — without reading plan markdown or `run.jsonl`. *(C0 — 2026-10-05: the board renders 2 planned, 3 executing, 46 completed, 2 abandoned from this machine's real data; the DOM measurement is four columns at four distinct x offsets on one y, 250px wide each, and a per-column pixel pass of the screenshot shows every column carrying distinct painted content)*
- [x] B: A long run is not a silent one: a live card says what its agent is doing and how old that information is, so a stalled run is visible in the first minute instead of the fortieth. *(C1 — 2026-10-05: driving the page's own SSE handler with a real `event` frame turned the card's "now" row from "no journal events" into `p1 → write_file "out/x.py"`, fed from a real journal line; live cards also carry the last-event age from the heartbeat)*
- [x] C: Clicking a card tells the whole story of that task — its deliverables, who was assigned to what, and what the gates said. *(C2 — 2026-10-05: `plan:agnostic-router-kit`'s detail rendered all 12 acceptance criteria with ✓/▢ marks, its 4 phase chips and the 2 commits recorded against it; the run detail for `run:2026-10-05_17-27-41-adversarial-solve` rendered the contract row `nfc-normalize-hyphenate — owns 2 files — 11 acceptance criteria — provides: …` straight from that run's real journal. Both snapshots were taken against live data, so the counts describe the moment they were measured, not a fixture)*

## Acceptance criteria

Order is identity: use cases are C0–C2, criteria C3–C10. Never reorder after gating.

- [x] The Board tab renders four columns — planned, executing, completed, abandoned — assembled read-only from the same sources the graph reads, with no new server route and no write path anywhere in the board. *(C3 — 2026-10-05: `npm run check:port` green (the kit's plane is the engine's package); `git diff --stat router/server.js` is empty; the only 4xx on the page is a pre-existing `favicon.ico` 401)*
- [x] A card is one work item: a plan with the runs it dispatched attached, or a bare run when no plan covers it. *(C4 — 2026-10-05: 53 cards — 6 plan items plus 47 bare runs; the 16 runs of `plan:harness-run-memory` attach to that plan through `dispatches`/`verifies` edges and render as one card, while the harness probes with no plan edge each get their own)*
- [x] Column derivation follows the stated rules for both item kinds, and a run that ended without a summary reads Completed with an `ended` badge rather than a pass or a failure. *(C5 — 2026-10-05: the 2 abandoned cards are `ok: false` runs and the 3 executing are `active: true` runs with `ok: null`; driving a heartbeat(`active: false`) moved a live card from Executing/"running" to Completed/"ended", then a `summary` frame moved it to "ok")*
- [x] Each card shows its deliverables, the agents assigned to it, and what the agent is currently doing. *(C6 — 2026-10-05: `plan:harness-run-memory` reads `<b>11/11</b> criteria · 16 runs` and `recall · 55 tools`; the "now" row was driven to `p1 → write_file "out/x.py"` through the page's own event handler)*
- [x] Clicking a card opens the task's detail — for a run, the contract events naming files owned, acceptance criteria and what each agent provides, plus phases, agents, artifacts and the gates in the run's window; for a plan, the criterion list with done/open marks, phases, its runs with state, artifacts, recorded-by commits and summarized-in recaps, each section appearing only when the plan actually has that data. *(C7 — 2026-10-05: the run detail for `run:2026-10-05_17-27-41-adversarial-solve` rendered 3,733 characters across 5 sections (agent assignment, agents assigned, phases, agent activity, gates in this run's window) with 13 rows and the "open run in Activity tab" cross-link; `plan:agnostic-router-kit`'s detail rendered 4,976 characters across 3 sections (acceptance criteria, phases, recorded by commit) — it dispatches no runs and has no artifacts or recaps, so those sections are absent rather than empty)*
- [x] Cards move live: the heartbeat frame is the authority on liveness, the summary frame is applied on arrival, and event frames fill the activity tail — a finished card leaves Executing with no refresh and no user action. *(C8 — 2026-10-05: Executing held 3 cards at load; after the synthetic heartbeat the column headers read `Planned=2 Executing=2 Completed=46 Abandoned=2` with no reload)*
- [x] The layered plan→recap DAG is no longer the tab's default view but remains reachable over the same model, and the mode survives a reload. *(C9 — 2026-10-05: the Graph toggle redrew the DAG from the same `gModel` — 521 nodes and 550 edges, plan 6 / criterion 70 / phase 18 / run 100 / agent 261 / artifact 3 / gate 20 / commit 40 / recap 3; `localStorage` held `graph` after the click and the toggle's `.on` class moved with it)*
- [x] The dashboard stays a single self-contained HTML file with no new dependency, both themes work with no new tokens, and the server's token-injection line survives byte-identical. *(C10 — 2026-10-05: `node --check` on the extracted 1,485-line inline script parses cleanly; the served page stamps the local token into `INJECTED_TOKEN` at line 433 rather than the empty literal, and `grep -c 'const INJECTED_TOKEN = "";'` on the served page is 0; card contrast measured 14.84:1 in light and 14.64:1 in dark, both drawing on `--dim/--warn/--ok/--err` that already existed)*
- [x] The Activity tab and the roster tabs are unregressed, and the kit's plane stays the engine's package. *(C11 — 2026-10-05: the Activity tab rendered 50 run rows with a selected run's detail after the rename; `npm run check:port` reports the kit's plane is the engine's package and the install ships all 14 modules)*

## Files to be touched

**zcode-router-kit (this repo, the only one changed):**
- `router/dashboard.html` — the board: CSS block, tab markup, nav label, the board module (item build, column derivation, card render, detail panels, SSE wiring, poll), and the removal of the now-superseded fetch-once `graphEnsure`.
- `docs/features/dashboard.md` — the Board tab and the workflow surfaces.
- `FUNCTIONAL-SPECIFICATIONS.md` §5 — the board in the dashboard's contract.
- `router/README.md` — a workflow-surfaces section (Activity and Board); the stale "Four surfaces" list corrected to six.
- `docs/plans/2026-10-05-kanban-board.md` — this plan.

**agnostic-router-kit:** nothing. `router/server.js`, the watcher, the SSE routes, `lib/workflow/graph.mjs` and `lib/workflow/events.mjs` are untouched — `git diff --stat router/server.js` is empty.

## Out of scope

- Dragging cards between columns. The board is a read-only projection; the kit CLI is the only writer and the only thing that changes workflow state. A card moves because a run started or finished, never because an operator dragged it.
- Per-part movement for swarms. See the known limitation below.
- Starting, stopping or cancelling runs from the UI.
- Deleting the DAG. It stays one toggle away, because "what are the nodes and how do they connect" is a real question that the board does not answer.
- Any new dependency, framework or build step. The dashboard stays one self-contained HTML file.

## Verification

**C0:** `npm run check:port`; `git diff --stat router/server.js`; load `/dashboard` in a browser and list every non-2xx response.
**C1:** `node /tmp/kboard/harness.mjs` (extracts the real board module from `router/dashboard.html`, runs it against the real `buildGraph()` with `AGNOSTIC_ROUTER_KIT_HOME=~/.agnostic-router-kit`); then in the browser, drive `wf.es.onmessage` with a real `event` frame and read the card's "now" row.
**C2:** in the browser, click a plan card then a run card; the detail panel's sections and body lengths are captured, not asserted.
**C3/C4/C5:** the harness's column dump (kind, label, status, active, ok per item) plus the browser's per-column card counts.
**C6:** the harness's verbatim card render for one card per column.
**C7:** the browser's detail-panel dump for both item kinds.
**C8:** drive `wf.es.onmessage` with `heartbeat`(active:false) then `summary`, and read the card's column and badge before and after.
**C9:** click the Graph toggle, count `.gnode` and `.gedge` in the SVG, then reload and read `localStorage['zcode-router-board-mode']`.
**C10:** `sed -n '420,1904p' router/dashboard.html > /tmp/kboard/app.js && node --check` (1,485 lines); `curl -s /dashboard | grep -c 'const INJECTED_TOKEN = "";'` must be 0, and the served page's `INJECTED_TOKEN` must hold the local token rather than the literal; measure `getComputedStyle` contrast in both themes.
**C11:** click the Activity tab, count `#wfRunsTable tbody tr`, and re-run `check:port`.

Regression: the roster tabs (Usage, Delegation, Providers, Quota, Workflows), save-and-apply and the theme toggle are untouched — the board is strictly additive beside them, and the only shared code it reuses is the helpers and the SSE frame dispatch, both of which gained a `boardRefresh()` call rather than a change of behaviour.

## Known limitation, stated rather than hidden

Swarm parts have no live per-part status feed. `run-fact` status rows exist in the router log but `buildGraph` does not surface them, and adding that means changing `lib/workflow/graph.mjs` in the engine repo. A swarm card therefore shows its part count and each part's last gate verdict but does not move parts between columns, and the plan card's "agents" row degrades to the honest "no named agents in these runs" when a swarm's parts carry actors the journal does not name. Full per-part movement is a follow-up that belongs in the plane, not here.

## Notes

- **The verification rig is scratch, not committed.** The Node harness (`/tmp/kboard/harness.mjs`) extracts the real board module and helpers out of `router/dashboard.html` and evaluates them against the real `buildGraph()` output in a DOM shim; the browser passes drive the served page over CDP against a scratch router on a spare port. Neither is checked in — `git ls-files` shows nothing under `tools/` from this work — so the verification section names what to look for rather than a committed test to run. That is the gap worth closing next if the board is to keep its own regression net.
- **Six defects were found by running the code, not by reading it.** Every one was a real defect that a code review would have passed: `agent` nodes labelled `?` rendered as `? · 0 asks · 5 tools`; a run card duplicated its runId in both title and hint; the SSE activity tail was keyed by the bare runId but looked up with the `run:`-prefixed node id, so it never populated at all; the contract event's `files` is a count rather than an array, so the "owns:" line was dead code; `startedAt` on a run node is an ISO string while `ago()` takes milliseconds, so both detail call sites rendered `started NaNd ago`; and a tool event with no actor rendered as ` → recall`. Three of the six came out of the Node harness, three out of the browser pass. That is the argument for running the real module against the real data before claiming a feature works.
- **Why the heartbeat is the liveness authority.** The run node's `active` flag is only wrong in one direction — a finished run stays `active` in the journal until `summary.json` lands — and only the heartbeat frame carries the server's `!terminal || !summary` computation. Having the page trust anything else would leave finished cards sitting in Executing until the next poll.
- **Renderer division of labor is preserved.** One graph model, two projections: the board answers "where does the work stand", the DAG answers "what are the nodes and how do they connect". Neither owns the data, and `kit workflows graph` still exports it as DOT and as archify-typed JSON unchanged.
- **sys1 decision-shape check (per plan convention):** every classification on this path is deterministic — the plan status comes from frontmatter, the run state from the journal and the heartbeat, the actor from the event's own field. No judgment head fits and none is added; the dashboard adds no model calls.
- Cross-referenced against `2026-10-04-workflow-dashboard.md`, whose use cases this plan changes the answer to rather than the data path: nothing in that plan's model, routes or read-only discipline is revised here, only which renderer opens first.
