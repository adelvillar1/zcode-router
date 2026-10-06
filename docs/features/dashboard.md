# Feature: Dashboard

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Admin Tool.

## Purpose

The kit's only UI: a local ops panel served by the router at `http://127.0.0.1:8300/dashboard` — usage visibility, roster editing, and a live view of what the kit's workflows are doing. Single file (`router/dashboard.html`), vanilla JS, no build step, no dependencies.

## What it shows

- **Usage** — the ledger by model and by day (calls, errors, tokens), plus a live view over the recent-request ring via SSE.
- **Delegation editor** — edit roster fields (tiers, delegation, profiles) and **Save & apply**: `PUT /api/roster` writes the roster and re-applies through the kit's own path, so the dashboard can never produce state the kit wouldn't.
- **Suggestions** — `GET /api/suggest` ranks models by measured latency and errors, declared context, quota headroom, and optional roster `strength` (1–5); hard-tier and aggregator suggestions sharpen with strength. Models without a declared strength rank neutral and the panel says so.
- **Workflows / delegation registry** — the library view with install state and assignability; the doctor cross-checks it (skipped hand-launched workflows stay visible).

## Workflow surfaces (read-only)

Two tabs watch the kit's own workflow state. Both are strictly read-only: the kit CLI is the only writer, so nothing these tabs show can have been produced by the dashboard.

- **Activity** — the temporal view. Per-run phase progress, an agent activity feed, artifacts landing, gate verdicts, and per-run last-event age (the stall detector). Completed runs render from `summary.json` plus journal replay.
- **Board** — the spatial view of *where the work stands*: a kanban board with four columns (planned, executing, completed, abandoned), one card per work item. Described below.

### The Board tab

A card is **one work item**: a plan with the runs it dispatched attached, or a bare run when no plan claims it. Board is the default view of the tab; the layered plan→recap DAG it replaced stays one toggle away (`Board` / `Graph` buttons) over exactly the same graph model, and the chosen mode is remembered per browser in `localStorage` (`zcode-router-board-mode`).

**Columns.**

| Column | A plan item lands here when | A bare run lands here when |
|---|---|---|
| Planned | status is `draft` or `active` and none of its runs are live | — |
| Executing | any attached run is live | the run is live |
| Completed | status is `completed` | the run has a summary (`ok`) or has ended |
| Abandoned | status is `abandoned` | the run's summary is `ok: false` |

A run with a terminal journal line but no summary is neither a pass nor a failure: it reads Completed and says `ended` on its face rather than being guessed either way.

**Card anatomy** — deliverables, agents, now:

- *deliverables* — for a plan, its acceptance criteria (`n/m` checked) plus the artifacts its runs produced; for a run, its artifacts with version, byte size and path.
- *agents* — `agent` nodes reached over `spawns` edges, one row per actor name with asks and tool calls (the same actor recurs across a plan's runs, so a plan card aggregates rather than repeating). A tool call with no actor behind it is not an assignment and is not shown. For a swarm, the card lists its parts with their last gate verdict.
- *now* — the latest phase, the latest tool call (`actor → tool` with a truncated argument), or the artifact an agent last produced, plus the age of the newest journal event for a live card.

**Click-to-detail** opens a panel below the board. For a run it fetches `/api/workflow-run/<id>` and renders the `contract` events — the durable record of who owns which files, what they provide, and how many acceptance criteria they accepted — alongside phases, the agent table, artifacts with paths, and the dev-decisions gates attributed to the run's time window. For a plan it renders the full criterion list with done/open marks, its phases, its runs with state, its artifacts, the commits that recorded them and the recaps that summarize them. Both keep the existing "open run in Activity tab" cross-link.

**Liveness.** The board reads the graph snapshot (`GET /api/workflow-graph`, server-memoized 5s) and the SSE stream (`/api/workflow-events`). The **heartbeat** frame is the authority on whether a run is still live — it is the only place that learns `!terminal || !summary` — so a finished card moves to Completed within one 5-second heartbeat; the `summary` frame is applied the moment it arrives, which usually makes the move instant. `event` frames fill the per-run activity tail. `graph-node` / `graph-edge` deltas merge new agents and artifacts as they appear. The tab polls the graph every 10s while visible, the memo making it cheap, so new plans, gates, commits and recaps land without a refresh.

**Known limitation, stated rather than hidden.** Swarm parts have no live per-part status feed — `run-fact` status rows exist in the router log but the graph builder does not surface them, and adding that means changing the plane in the engine repo. A swarm card therefore shows its parts and their gate verdicts but does not move parts between columns. Full per-part movement is a follow-up that belongs in the plane, not here.

## Auth

Local-token: API calls beyond `/healthz` require `Bearer <localToken>`; the served page is stamped with the current token (`INJECTED_TOKEN`) so the browser needs no configuration.

## Theme

Light/dark toggle in the header (the sun/moon button). Default follows the OS via `prefers-color-scheme`; an explicit choice is persisted per browser in `localStorage` (`zcode-router-theme`) and wins over the OS on reload. A pre-paint script in `<head>` sets `data-theme` before first render, so there is no flash of the wrong theme. Both palettes are CSS-variable blocks on `:root` (dark = GitHub dark, light = GitHub light); native form controls follow via `color-scheme`. The board reuses the same variables — column accents draw on `--dim / --warn / --ok / --err`, the palette the graph legend already used — so it works in both themes with no new tokens.

## Endpoints behind the tabs

`GET /api/state` · `GET /api/usage` · `POST /api/usage/reset` · `GET /api/suggest` · `GET|PUT /api/roster` · `GET /api/workflow-runs` · `GET /api/workflow-run/<id>` · `GET /api/workflow-graph` · `GET /api/workflow-events` (SSE).

## Where the code lives

`router/dashboard.html`; data endpoints in `router/server.js`; suggestion ranking in `router/suggest.mjs`; the graph model both workflow tabs render is `lib/workflow/graph.mjs` in the engine checkout (the kit resolves it as `workflow-plane`).
