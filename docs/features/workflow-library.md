# Feature: Workflow library & registry

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Workflow library & registry").

## Purpose

The saved dynamic workflows in `workflows/*.dwf.ts` are the router's multi-agent execution layer, and the delegation registry the judge picks from. The registry is **generated from each file's `zcode-workflow` metadata block**, so the library and the registry can never drift.

## Assignment shapes

- **Router-assignable** — the workflow takes a `task` argument (per its metadata or a roster `workflows.registry.<name>.taskArg` override) so the judge can hand it a task directly. 19 of 32 today.
- **Hand-launched** — structured arguments rather than a task; the router never assigns them. 13 today. `kit workflows list` shows the split; `kit doctor` reports the count so a drop to 0 assignable is visible.

## Adding a workflow

Drop the `.dwf.ts` into `workflows/` and run `kit apply`. The metadata block supplies description, task argument, and (with a `shape`) the routing entry. Nothing else to register. The roster can add `workflows.shapes.<name>` (problem-shape text for routing) and `workflows.registry.<name>.defaults`.

## Installation

`kit workflows sync` / `kit apply` copy the library into `~/.zcode/workflows/` **without ever deleting files the user added locally** — the kit only manages its own.

## Library highlights (fan-out family)

`swarm` (decompose, build, review) · `adversarial-solve` (solutions argue, then judged) · `bug-hunt` (root-cause without fixing) · `review-sweep` (findings confirmed before action) · `deep-dive`, `decision-memo`, `data-triage`, `regression-claim-verification`, `coverage-push`, `migration`, `plan-backlog-generation`, `postmortem`.

## The fan-out workflows carry no assembly code

Every workflow that fans out to builders — the `swarm` family and
`adversarial-solve` alike — consumes the same plane functions
(`measureEnvironment`, `renderBrief`, `renderContract`, `validateContract`,
`judgeContract`, per-part checkpoints, per-shape budgets, settlement). The
The swarm's atomicity gate and a workflow's dispatch gate are one implementation
in the plane (`workflow-plane/harness.mjs`), not two: a workflow declares
decomposition and ownership, and the plane assembles, gates, journals and
settles. See [workflow-runtime.md](workflow-runtime.md).

## Where the code lives

`lib/workflowlib.mjs` (metadata parser + registry generator), `workflows/README.md`, roster keys `workflows.shapes` / `workflows.registry`.
