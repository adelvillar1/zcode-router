# Session Recap — 2026-10-06

## What shipped

**The run API and the loop library, ported from the engine edition to the kit and
shipped live.** Plan
[2026-10-06-run-api-and-loop-library-port.md](../plans/2026-10-06-run-api-and-loop-library-port.md)
(criteria C0–C16, all checked below). The port was composition, not rewriting:
the engine's own blocks transplanted verbatim, each proved byte-identical in
both directions, then exercised through the kit's own bin and wire.

**The wire (`router/server.js`, +315 lines).** Three regions transplanted from
the engine at `4ded354`, each re-asserted byte-identical at close-out:

| Region | Size | What it is |
|---|---|---|
| run-API helpers + the one-token two-class gate | 12,995 chars | `readRunOwner` through the run-API header — app-token resolution, ownership re-derivation from the journal, the 401 body unchanged |
| the routes and the ceiling/sandbox gate | 11,350 chars | `POST /v1/runs`, `POST /v1/runs/<id>/answers`, `GET /v1/runs/<id>/artifacts` — validation order, the `out of bounds` refusal, the run-root closure, the guarded download |
| the SSE route | 9,988 chars | the two-class `?token=` gate, the `hello` frame, and the one-frame-drop fix: client eviction on the *response's* close (`res.on("close")`), not the request's |

**The roster surface.** `lib/render.mjs` maps `router.apps` rows into the rendered
config (398 chars, identical to the engine); `lib/roster.mjs` validates each row
(name + token, `grantCeiling` an array when present); `templates/roster.defaults.json`
documents the row shape; `kit status` prints an app block (name + ceiling); the
`kit workflows run` search config resolves `FIRECRAWL_API_KEY` /
`FIRECRAWL_SCRAPE_URL` / `FIRECRAWL_SCRAPE_VERSION` from `readEnvFile(ENV_FILE)`
at the boundary. One genuine fresh-install bug found by the probe and fixed:
`copyRuntime` did `copyFileSync` without creating the destination directory, so a
scratch home with no `lib/workflow/` failed on the first workflow file — a dry
run must not even create the directory it reports on, and a fresh install has
none to copy into.

**The library.** Eleven plane `.ts` workflows copied in byte-identical (sha256
verified): the seven loops (deep-research, triage, refine-loop, red-team,
watchdog, remediate, router-eval) and four probes (http-probe, search-probe,
judge-probe, context-probe). `tools/probe-run-api.mjs` ported to the kit's names:
`bin/zcode-router-kit.mjs`, scratch `ZCODE_ROUTER_DIR` /
`ZCODE_ROUTER_KIT_ROSTER`, `AGNOSTIC_ROUTER_KIT_HOME` on the spawned server,
`apply --only router` only — never a full apply, which would re-register the
launchd service that belongs to the live edition — and SDK provisioning because
the kit's `copyRuntime` installs the plane but not the vendored
`@typesafe-ai/sdk`.

## Criteria status (verification evidence)

Every line below was run through the kit's own bin and wire.

| Criterion | Evidence |
|---|---|
| C0–C5 | `node tools/probe-run-api.mjs` — **33 passed, 0 failed**, zero model calls, scratch server on 8399, scratch home cleaned up. Covers the spawn shape (`{ok, runId, runDir}`), `run-start` carrying `app` / `grants` as an array / facts, `summary.json`'s `app`, the out-of-ceiling `403 out of bounds` + `run-spawn-refused` journal, the workdir closure, live answering with all four journal sources (`live`, `declared` outranking live, `none` at warmup), the artifact index with `?file=` / `..` / foreign-run / cross-app refusals, and same-second distinct run dirs streaming on SSE under both token classes |
| C6 | The SSE block is byte-identical to the engine's (9,988 chars, asserted at close-out) and carries `res.on("close", () => wfSseClients.delete(res))` — client eviction on the response's close, with the comment that a request stream closes as soon as its empty body is consumed. Live on 8300: `GET /api/workflow-events?token=…` returns the `hello` frame with the full run snapshot; an unknown token gets 401 with the message unchanged |
| C7 | `/v1/chat/completions`, `/route`, `PUT /api/roster` and the dashboard paths untouched (the transplant adds, it does not rewire); `kit workflows run context-probe` **19/19, zero agent calls**; a smoke chat completion routed on 8300 after the deploy |
| C8 | `node --check` clean on `router/server.js`, `lib/render.mjs`, `lib/roster.mjs`, `lib/cli.mjs`, `tools/probe-run-api.mjs`; the bidirectional block assertions above re-run at close-out. One honest wrinkle: the roster.mjs assertion spans a *pre-existing* ordering difference — the engine carries the `strength` validator after the apps block, the kit before it. Both blocks are present and identical in both files; only their order differs, and that predates this port |
| C9 | Seven for seven, each through `kit workflows run` from the kit's own `workflows/`: deep-research 526.0s / 6 agents / 5 phases, stop `coverage`, 2 search credits, 3 artifacts; red-team 335.8s, 1 persona → 3 attacks, 3 confirmed + fixed, 3 residuals; remediate 87.7s; refine-loop 29.8s, stop `plateau`, 4 agents; watchdog 1.4s changed / 0.0s no-change with zero model calls; router-eval 3.0s, pass; triage 1.5s, 3 items, escalation lane fired at threshold 0.99 |
| C10 | `kit workflows run judge-probe`: **0 agent calls, 1 dev-decisions call**, verdict `yes` at 0.9976, journal line `sys1.judge` → `dev-decisions` |
| C11 | `search-probe` three modes: refused by capability name; no-key refusal naming `FIRECRAWL_API_KEY` and `kit env set`; granted = 1 real result / 2 credits. Key-neutrality grep over `lib/` and `workflows/` returns **0** hits; the journal line carries query, `results`, `creditsUsed` and no key material |
| C12 | `workflows/deep-research.ts` keeps the shape: `NO_SEARCH = { tools: { deny: ["web_search"] } }` spread into every agent, `world.spentCredits()` the one budget gate (`metered + SEARCH_COST > creditBudget` → stop searching), `scrapeBudget` rides the self-hosted scraper. The 526s run exercised it: scraped 4/5 candidate pages on the self-hosted instance, 2 credits metered against a budget of 4 |
| C13 | `kit doctor` → "everything checks out"; `/healthz` → `{"ok":true}`; smoke chat completion routed on 8300 after the deploy |
| C14 | `npm run check:port` green: the kit's plane is the engine's package, the installed runtime beside the router matches the engine's modules, and the installed router resolves `workflow-plane/*.mjs` by specifier |
| C15 | No raw key in any tracked file (scan over `roster.json`, templates, `lib/`, the new docs: 0 hits); Firecrawl values live only in `~/.zcode/router/.env`, mode `600` |
| C16 | `docs/features/run-api.md`, `docs/features/loop-library.md`, `docs/features/deep-research.md` (new); `TECHNICAL-DOCUMENTATION.md` (API table, two-token-class security model, the two workflow file kinds, run state, observability); `FUNCTIONAL-SPECIFICATIONS.md` (access model, core features, user flows, edge cases); `README.md` (What you get, safety model, layout, Adding a workflow) |

## Security notes

No secrets in tracked files or outputs. The only credentials touched were read
from `~/.zcode/router/.env` (600) by the kit's own code — the probe's search
scenario used a scratch env with dummy names, and the granted search-mode run
spent 2 real credits with zero key material reaching a journal line. The scratch
runtime for the probe rendered with `apply --only router` into a throwaway
`ZCODE_ROUTER_DIR` and `AGNOSTIC_ROUTER_KIT_HOME`; the live service on 8300 was
never re-registered. Deploy was dry-run first, then apply (brief 8300 blip while
`com.zcode.model-router` restarted), then doctor + healthz + config-sha back at
baseline. The three Firecrawl names are env-var *names* in the CLI path; the
roster and the workflow library hold none of them as values (grep guard: 0).

## Notes / follow-ups

- **The remediate run's gate was vacuous, and it is recorded as such.** The
  chosen verify command was `node --version`, which proves nothing about the
  file it ran against, so the run demonstrated the checkpoint/rollback
  machinery but not an actual content change. The engine's live lesson (a fixer
  that "passed" by editing the test) is enforced in code — a whole-workspace
  manifest before and after, gate-file edits void the fix — but this run did
  not exercise a meaningful gate.
- **`scrapeBudget: 0` falls back to 6** (`Number(0) || 6` — zero is falsy). The
  kit's deep-research run inherited that: asking for no scrapes gets the
  default. It is plane-side semantics, not a kit defect, and out of scope here;
  the doc now says "pass nothing rather than zero".
- **The two engine-side asymmetries are inherited, as the plan said they would
  be.** `world.scrape` journals `bytes` but does not add to the credit meter
  even though `scrapeUrl` returns `creditsUsed`; and the search config block is
  spread wholesale, so the scrape request carries the cloud key to the
  self-hosted instance. Both belong to an engine-side plan; this port records
  them rather than silently lauding them.
- **`roster.json` carries local tier drift that is not this port's.** The
  working tree's roster changes reorder tier targets
  (`quick`/`standard_code` → `xiaomi-mimo/mimo-v2.6-flash`, `hard` →
  `stepfun/step-5-preview`) alongside the port's own changes. The port
  committed without it, and that was the call — a feature commit that also
  silently rewrites provider tiers is harder to bisect. The roster
  declares **no** `router.apps` rows — apps are an explicit operator
  declaration, and none has been declared on this machine yet; the template
  documents the shape and the machinery is proven by the probe.
- **The port is committed and it is `86f12e9`.** The machine runs the new
  server (8300 green) and a fresh clone of `master` plus `kit apply` now
  reproduces that runtime; `kit apply --dry-run` reported no steps to run,
  which is how the live install was confirmed to match the commit. The
  `roster.json` tier drift above is the one pre-existing change deliberately
  left out of that commit — it is still a working-tree edit, so anyone who
  wonders why the checked-in roster disagrees with the live one is looking at
  that, not at this port.

## The board's view of this work

`2026-10-06 17:38` — the deep-research run that proved the port is on the live
board as `run:2026-10-06_17-38-39-deep-research`, 105 journaled events, three
published artifacts, visible in the SSE run snapshot the dashboard reads. The
loop library and the run API are the first features whose evidence is a run the
board can show.

## The defect the live wire found, and the fix — later the same session

**A wire-spawned run answered, then 404'd on its own artifacts.** The first
spawn over the live 8300 wire returned `{ok, runId, runDir}` and the run
executed — but its `runDir` was `~/.agnostic-router-kit/workflow-runs/…`, the
*engine's* home, and every read route (`/api/workflow-run/<id>`,
`/v1/runs/<id>/artifacts`, `/v1/runs/<id>/answers`) answered 404 for it. Cause:
the server's `WORKFLOW_RUNS_DIR` resolves from `AGNOSTIC_ROUTER_KIT_HOME` with a
default of its own install dir (`~/.zcode/router`), while the plane's
`freeRunDir` — which the transplant calls with a bare run name — resolves the
same variable with a default of `~/.agnostic-router-kit`. In the engine's
deployment those two defaults are the same directory, so the divergence is
invisible there; in the kit they are two directories, and the spawn path and
the read path disagreed.

**The probe could not have caught it**, because the probe sets
`AGNOSTIC_ROUTER_KIT_HOME` on its spawned server — the two homes agreed by
construction in the scratch runtime. The gap is a live-deploy property, and it
was found by spawning over the real wire, not by the 33 assertions that
otherwise pass.

**Fix** — one kit line in `router/server.js` at the constants block, mirroring
what `lib/cli.mjs` already does for the CLI path:

```js
process.env.AGNOSTIC_ROUTER_KIT_HOME ??= KIT_HOME_DIR;
```

The three transplant blocks stay byte-identical to the engine (re-asserted:
12,995 / 11,350 / 9,988 chars), so the port proof is unaffected. Deployed with
`kit apply --dry-run` → `kit apply` (only `server.js` re-copied; service
kicked), then verified live: a spawned `http-probe` now journals into
`~/.zcode/router/workflow-runs/`, the run detail reads back, the artifact index
lists `probe-answer` v1 (44 bytes), and `?file=` downloads the resolved
escalation answer — the full spawn → escalate → publish → collect contract,
zero model calls. Re-run after the change: probe 33/33, `kit doctor` green,
`npm run check:port` green, `/healthz` ok, key-neutrality grep 0.

The stray test runs this check wrote into `~/.agnostic-router-kit/workflow-runs/`
before the fix (`18-02-01-context-probe`) are left in place — they are engine-side
runtime state, and deleting them is an operator decision.
