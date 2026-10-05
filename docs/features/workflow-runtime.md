# Feature: Workflow runtime (the control plane)

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Swarm delegation", "Workflow library & registry").

## Purpose

`lib/workflow/` is the runtime `kit workflows run|watch|graph` drives, and the
half of the router that executes a library workflow: a workflow file declares
*what* its agents are told and *who* owns which files; the plane assembles
everything else. The port is verbatim from the engine edition
(`agnostic-router-kit lib/workflow/`, provenance headers on every file) — this
repo ships it, it does not fork it, and the full reference for the file format
and the surface lives there.

## What the plane assembles (so no workflow does)

- **Measurement, not assumption** — `measureEnvironment` runs the workspace's
  own format/lint and test discovery through the run's command allowlist, so a
  brief carries measured facts about this workspace rather than a guess about
  every workspace.
- **The brief and the contract** — `renderBrief` renders the harness block
  (stack, namespace, verification recipe, the run's measured facts) and
  `renderContract` renders each part's contract (owned files, acceptance
  criteria, the interface it exposes). The engine appends the contract to every
  contracted agent's ask.
- **The dispatch gate** — `validateContract` is deterministic code (file
  collisions, non-owned path references, dependency phrases) and `judgeContract`
  is the dev-decisions-first sys1 judgment, the same two-head gate the swarm
  uses. Rejection happens before any builder runs.
- **Per-part checkpoints** — a part's build runs under a byte-exact snapshot of
  the paths it declared; when the part throws or its own report does not check
  out, those paths are restored and its siblings are untouched.
- **Per-shape budgets** — a build ask keeps `--max-rounds` above a prompt-token
  ceiling; a verification or loop-shaped ask draws a smaller line on both axes,
  and at that line the shapes part: build throws the countable cap its caller
  decomposes from, verification escalates `stuck` and ends.
- **Settlement** — a parallel set is a failure domain: `settleMembers` runs
  every member however the others end and reports survivors, failures with
  reasons, and whether enough survived for the next step (two for a
  comparison, one for a parallel build).
- **The run's fact store** — the coordination layer writes status, verdicts and
  decisions through `world.remember`; an agent reads them through the scoped
  `recall` tool (its own part plus public facts, never a sibling's).
- **Escalation answering** — an escalation carries a structured topic; a
  `--answers '{"<topic>":"…"}'` key resolves it deterministically, and an
  unanswered one keeps the no-owner clause.

## The tool registry and grants

The tool surface is the plane's registry, not the model's: every capability a
run uses is a declared grant, and every call is journalled against its grant
(refusals included). `fetch_url` needs `net-fetch`, package installs need
`package`/`test-runner`, dev servers and background commands are their own
capabilities, and `delegate` needs `sub-agents` with a structural depth cap of
one — a child's surface has no `delegate` at all. Nothing is ambient: a
workflow that needs the network asks `world.grants().has("net-fetch")` and
escalates up front instead of meeting a refusal mid-run.

```
kit workflows run <file|name> --workdir <dir> [--args '{…}'] [--answers '{…}']
  [--grant package,net-fetch] [--allow-domain example.com]
  [--allow-cmd "npm test"] [--max-rounds N] [--compact-tokens N]
```

## The harness services

`services.mjs` carries the four things a harness gives an agent that a bare
tool does not, each behind the registry above rather than beside it:

- **Installs** — `installPolicy` is argv-aware. `npm ci` restores from the
  lockfile; a named package is refused as "the manifest is a human decision"
  before any registry is contacted; a bare `install` with a manifest to restore
  is a restore. A run never adds a dependency nobody wrote down.
- **Net-fetch** — `fetchUrl` is capped twice: 1MB at the network, 64KB on the
  way to a model. It refuses by *returning* a result, so a blocked fetch
  journals the refusal instead of letting a fired line read as a completed one.
- **Processes** — the registry gives per-run handles with an offset-based
  reader (every poll says where to read next, and moves the offset with any
  truncation so a reader never loses bytes silently), a readiness marker, a
  signal-aware `running` (a SIGTERM'd child has a null exit code and would
  otherwise poll as running forever), a lifetime cap, and an idempotent stop. A
  run that ends stops everything it started.
- **Format hooks** — `runFormatHooks` runs the workspace's own scripts and
  reports rather than throws.

Each is reachable both ways — as an agent tool (`fetch_url`,
`start_dev_server`, `stop_dev_server`) and on the world (`world.fetch`,
`world.server.{start,poll,stop}`, `world.format()`) — through the same guards.

## What stays workflow-side

Decomposition, part ownership, which agents exist and what each is for, and the
content of every brief. The plane refuses to let a workflow assemble a brief by
hand — that is the line: assembly, journaling, gating and settlement are the
plane's; judgement about *what to build* is the workflow's.

## Where the code lives

`lib/workflow/` (engine, harness, tools, services, checkpoint, schema, meta,
events, graph — all verbatim ports), `lib/cli.mjs` (`workflows run|watch|graph`
and the copyRuntime that ships the runtime beside the router), and the ported
probes in the engine edition (`budgets-probe`, `competition-probe`) that drive
the plane's lifecycle policy with real model calls.
