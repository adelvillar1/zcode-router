# The run API

> Ported 2026-10-06 from the engine edition. Plan:
> `docs/plans/2026-10-06-run-api-and-loop-library-port.md`. Probe:
> `tools/probe-run-api.mjs` (33 assertions, zero model calls), fixture:
> `workflows/http-probe.ts`.

The router's wire used to be model-shaped or operator-shaped: any OpenAI-compatible
client could route model traffic, and an operator could spawn runs from a shell and
watch them on the dashboard. The run API closes the gap between those — an
**application** spawns a workflow run over the same local wire, watches its events on
the stream that already exists, answers its escalations while it is live, and collects
its deliverable.

A spawn is a capability like any other on this machine: declared, validated against
the caller's ceiling, journaled.

## Token classes

One bearer gate, two classes:

- **The operator token** (`router.localToken`) — the CLI and dashboard's class. No
  ceiling: it may spawn in any workspace, request any grants, answer any run, read any
  run's artifacts.
- **An app token** — a `router.apps` row in the roster, rendered into the runtime
  config by `kit apply`:

```json
"router": {
  "port": 8300,
  "localToken": "local-auto-router",
  "apps": [
    { "name": "probe-app", "token": "…", "grantCeiling": ["workspace-io"], "workdir": "~/somewhere" }
  ]
}
```

Apps are explicit roster rows — no dynamic registration. A leaked app token's blast
radius is its ceiling, which is the point of ceilings. The template carries
`"apps": []`, the live roster carries no rows until an operator declares one, and
`kit status` prints the table (name + ceiling) so the roster's app rows are visible
without opening the file. The SSE event stream accepts either class via `?token=`.

## Routes

### `POST /v1/runs`

Body:

```json
{
  "workflow": "triage",
  "args": { "items": "…" },
  "facts": [ { "kind": "task", "fact": "the caller's declared context" } ],
  "grants": "workspace-io,net-search",
  "allowDomains": ["example.com"],
  "allowCommands": [],
  "answers": { "stack": "JavaScript on Node 24" },
  "model": "hard",
  "workdir": "sub/path"
}
```

Response: `{ ok, runId, runDir }` — handed back before the run exists; the run id is
the run directory's name, and `freeRunDir` still guards the same-second collision.

Validation, all reused from the plane, all failing the request before a run directory
exists:

- the workflow exists in the library (a `workflows/<name>.ts` file under the roster's
  kit root, beside the `.dwf.ts` delegation library), and `args` validate against the
  workflow's own header (`parseHeader`/`validateArgs`);
- facts carry a declared kind (`task`, `stack`, `environment`, `decision`, `verdict`,
  `status`, `phase`) and non-empty text — the engine re-validates and seeds them
  through `world.remember`, so they journal as facts an agent can recall;
- grants resolve (`resolveGrants`) — an unknown capability is a 400 naming it;
- **the ceiling**: every requested grant must be in the app's `grantCeiling`, else
  `403 out of bounds: <grant> is not in <app>'s ceiling — an app spawns under its declared grants, never beyond them`;
- **the sandbox**: an app runs inside its own root (its roster `workdir`, or
  `<kit home>/apps/<name>/workspaces`, created on demand), and a body `workdir` is a
  subpath of that root — outside is refused by name, the same closure as recall's
  sibling refusal. The operator may name any directory, like the CLI.

The spawn is journaled twice: the router log records `run-spawned` (app, workflow,
grants) and refused spawns record `run-spawn-refused` with the rule that refused them;
the run's own journal records `run-start` carrying `app`, `grants`, and `facts`.
`summary.json` carries `app` too — "who asked" is a journal question, not an
inference.

The run executes in-process through the same `runWorkflow` the CLI uses. Every
existing surface picks it up unchanged: the SSE stream, the run list, the run detail,
the graph, the kanban board.

Wire-spawned runs and CLI-spawned runs get the same search backend: the run path
assembles the `firecrawl` search config from the runtime envstore
(`~/.zcode/router/.env`, key-neutral — only variable names reach the plane).

### `POST /v1/runs/<id>/answers`

Body `{ topic, answer }`. Appends to `<runDir>/answers.jsonl` — the live half of the
answers table, read by the engine at escalation fire time. No socket in the engine,
the same file discipline as the journal itself.

Precedence in `answerEscalation`: declared topic match, then live topic match, then
declared substring, then live substring, then `askOwner`, then the no-owner clause.
Every resolution journals its source (`declared` | `live` | `owner` | `none`) — the
journal says who answered, not just what was answered.

Scoped like recall: an app answers only the runs it spawned; the operator answers any.
Ownership survives a server restart because the journal, not process memory, is the
record (`readRunOwner` re-derives it from the run-start line).

### `GET /v1/runs/<id>/artifacts`

The run's versioned artifact index (id, version, file, bytes) from the run's
`artifacts/` directory. `?file=probe-answer/v1/probe-answer.md` downloads one
file: a path that resolves inside this run's artifacts directory and exists is
served, one that resolves inside but is not there is 404, and `..` or an
absolute path is refused with `out of bounds: artifacts are inside this run's
directory, never outside it`. An app reads only its own runs' artifacts; the
operator reads any.

The read routes the operator already had (`/api/workflow-runs`,
`/api/workflow-run/<id>`, `/api/workflow-graph`, `/api/workflow-events` SSE) are
unchanged and are the run-read surface.

## Where a run lives

A spawned run journals under `<kit home>/workflow-runs/<run>/` — on this machine
`~/.zcode/router/workflow-runs/`, overridable with `AGNOSTIC_ROUTER_KIT_HOME`
(set by the CLI and by the server itself). The plane resolves run dirs from the
same variable but defaults to the *engine's* home (`~/.agnostic-router-kit`) when
it is unset — the same directory the engine's router runs from, but not this one.
Without the server's override a spawn and its own read routes would disagree:
the spawn answers, then the artifacts route 404s. The probe cannot catch this
because it sets the variable on its scratch server, making the two homes agree
by construction; only a spawn over the live wire shows it.

## The one-frame drop is gone

The SSE route subscribes on the response's `close`, not the request's: a request
stream closes as soon as its (empty) body is consumed, which dropped every client one
frame in. The probe subscribes as an app token and asserts both runs stream with
attribution.

## Judgement law unchanged

The run API is a caller layer, not a judgment layer: an app-spawned run's gate
verdicts route dev-decisions first, sys1 behind it, exactly as operator runs do, into
the same calibration store with the same `input_sha256`. The wire adds no inline model
call and no route around the gates.

## Probing

```
node tools/probe-run-api.mjs
```

Renders a scratch runtime with the kit's own pipeline (`kit apply --only router` into a
scratch `ZCODE_ROUTER_DIR` — never a full apply: that re-registers the launchd service
`com.zcode.model-router`, and the service label belongs to the live port), launches
the scratch server on 8399 with its own `AGNOSTIC_ROUTER_KIT_HOME`, and asserts the
whole contract above in 33 checks with zero model calls. On success the scratch home
is removed; on failure it is left behind and printed.
