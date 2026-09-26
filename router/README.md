# zcode-model-router

Local OpenAI-compatible proxy that routes each task to the right upstream
model. Registered in ZCode as the **Auto Router** provider — its single
model, `auto`, appears in the model picker (`auto-router/auto`).

## Routing

Per request, in order:

1. **Capability rules** (always evaluated, always win — even over a pinned
   profile):
   - Any image/video/audio content part -> `mimo-v2.6-pro` (omnimodal).
   - Payload larger than `routing.wideChars` (~150K tokens) -> same 1M-context
     flagship.
2. **Pinned profiles** — model ids other than `auto` pin their workload with
   no judgment:

   | Picker model | Pins to | Model | Plan |
   |---|---|---|---|
   | `quick` | quick | qwen3.8-flash | Token plan |
   | `code` | standard_code | step-3.7-flash | Step plan |
   | `hard` | hard | GLM-5.3-Flash | Z.AI Coding Plan |
   | `prose` | prose | mimo-v2.6-flash | MiMo plan |
   | `long-context` | deep_context | mimo-v2.6-pro | MiMo plan |
   | `vision` | (omni rule) | mimo-v2.6-pro | MiMo plan |

3. **`auto`** — one TypeSafe Jev judgment per *task* (cached, keyed on system
   prompt + latest user instruction, TTL `ttlHours`) picks the workload:

   | Workload | Signals in the judge | Model | Plan |
   |---|---|---|---|
   | `quick` | quick answers, tiny edits, formatting, simple extraction | qwen3.8-flash | Token plan |
   | `standard_code` | routine features, normal debugging, tool work | step-3.7-flash | Step plan |
   | `hard` | architecture, intricate reasoning, big refactors, subtle bugs | GLM-5.3-Flash | Z.AI Coding Plan |
   | `prose` | docs, prose, summaries, explanations, reports | mimo-v2.6-flash | MiMo plan |
   | `deep_context` | connecting many files, very long documents | mimo-v2.6-pro | MiMo plan |

   Confidence below `routing.minConfidence` (0.6), missing key, or any judge
   error -> `routing.defaultWorkload` (standard_code). A TypeSafe outage never
   fails a request.

### Topology: who decides swarm vs single

The TypeSafe judgment answers TWO questions per task: the workload (which
model) and the **execution style** — `single` (one focused call/worker),
`mixture` (parallel answers + judge), or `swarm` (decomposed multi-agent work
with critique rounds). Topology is a routing decision, not a hardcoded one.
Hardness alone does not trigger MoA: a single hard decision stays `single`.

Consumers:
- The **chat path** acts on it: mixture/swarm verdicts run MoA and return the
  verdict in the `x-router-execution` / `x-router-workload` response headers
  (a swarm verdict at the chat layer runs MoA as its closest available
  approximation and advertises the recommendation for orchestration).
- **`POST /route`** ({task} or {messages}) returns the verdict alone —
  `{workload, execution, target, conf, reason}` — for delegation-time
  decisions (launch the swarm workflow vs normal delegation).

### Workflow assignment (and sequencing)

`routing.workflows` registers every saved workflow with a one-line problem
shape. The TypeSafe judgment then answers four questions per task: the
workload (which model), the execution style (single/mixture/swarm),
**which saved workflow runs first**, and **which runs second** — plus a follow-up pick for requests that
complete only after a second workflow (research then write it up, diagnose
then review the fix). `POST /route` returns `workload`, `execution`, `target`, `assignments: [{name, args}]`
(in order), `assignment` (the first step, for convenience), `conf`, `wfConf`,
and `reason` — the router picks, the coordinator assigns and runs them in
sequence, feeding each workflow's deliverable forward. A workflow assignment
outranks the chat layer's mixture approximation; `execution` governs what the
chat path itself does. Note `wfConf` on an empty `assignments` is confidence
in the *"none"* abstention — gate on `assignments` being non-empty, not on the
number alone.

Confidence gates are per-question (`minConfidence` for the 5-way workload
pick, `workflowMinConfidence` default 0.4 for the 12-way workflow pick —
different option spaces, different chance baselines). Registered shapes:

swarm, review-sweep, bug-hunt, migration, research-report, deep-dive,
coverage-push, content-production, decision-memo, postmortem,
adversarial-solve. Tuning a mis-pick is a one-line shape edit in config.json.

### Mixture of Agents (`mixture` / `auto` + hard)

Really hard, one-shot reasoning (no tool-calling — tool turns can't be
merged) fans out to 3 proposers on 3 different plan pools and model families:

1. **Propose** — `GLM-5.3-Flash`, `mimo-v2.6-pro`, `step-5-preview` answer the
   same request in parallel (`routing.mixture.proposers`).
2. **Evaluate** — one TypeSafe Jev call picks the best answer (`best_answer`
   Choice with calibrated probabilities) AND decides integration
   (`worth_merging` Noul: "would merging produce a better answer than the
   single best alone?").
3. **Integrate if needed** — when the judge says merging adds value, the
   aggregator (`GLM-5.3-Flash`) synthesizes one answer from all proposals;
   otherwise the winning proposal is returned verbatim.

`auto` routes to MoA when the workload is `hard` and the request carries no
tools; the `mixture` picker profile pins it directly. Every run logs the
proposers, the winner, its confidence, and whether merging happened
(`event: "mixture"`).

No artificial limits: client `max_tokens` passes through verbatim (or is
unset so each model uses its own output default — these models run 1M input
contexts and 128K+ outputs), and judge/aggregator inputs are never truncated.
`routing.wideChars` (1,000,000) only exists to divert payloads beyond the
262K-token windows of qwen3.8-flash / step-3.7-flash to the 1M-window models.

All routed upstreams draw on prepaid plans (Z.AI Coding Plan, token plan,
step plan, MiMo plan) — there is no per-token-billed upstream in the chain.
The `/api/coding/paas/v4` path is the Z.AI coding plan's own API surface
(plan quota, never pay-per-token); the pay-per-token endpoint `/api/paas/v4`
is deliberately unused. ZCode's
`~/.zcode/v2/provider_config.json` stays the single source of truth for
upstream URLs and keys (except `zai-coding-plan`, whose key lives in `.env`)
— the proxy re-reads it automatically when it changes.

## Dashboard

The router serves its own management UI at **`http://127.0.0.1:8300/dashboard`**
— no app patching, survives ZCode updates, same on every machine the kit
installs on. The page is static and carries no secrets; its API calls use the
same local token as the proxy routes (asked for once, kept in the browser's
localStorage — `kit status` prints it).

Four surfaces:

- **Usage** — the point of the router is that plans are prepaid, so the
  interesting number is what each model actually consumed. Calls, errors,
  prompt and completion tokens per model (including losing mixture proposers
  and the aggregator — a prepaid plan pays for those all the same), per-day
  rollups, the single/mixture/swarm delegation mix, judge freshness
  (fresh TypeSafe judgments vs session cache hits), and the last 100 routed
  requests with latency and tokens. Tokens are recorded only when the upstream
  reported them — nothing is estimated, and a model that never reports usage
  shows calls with unknown tokens rather than invented numbers. Counters live
  in `logs/usage.json`, survive deploys and restarts, and are never written on
  the request path (flushed a few seconds after the last change).
- **Delegation** — a structured editor for the roster's routing table:
  workload tiers with their fallback chains, the omni/wide capability chains,
  mixture proposers and aggregator, judge thresholds, and the picker profiles.
  Each tier shows what the router resolved *right now*, so a fallback remap is
  visible instead of silent.
- **Providers** — enable/disable, billing plan/payg, whether the key resolves.
  Keys themselves are env-var references by design; set them with `kit env
  set`, never in the UI.
- **Workflows** — the delegation registry, and a control rather than a
  catalog: per workflow, the shape text the judge matches against (roster-owned
  and authoritative over the workflow's own frontmatter), assignability with
  the task argument the router fills, arg defaults, and live assignment
  outcomes (first stage vs follow-up, last assigned) — the only place those
  numbers exist. ↺ drops an override so the value falls back to library
  derivation. **Authoring stays in ZCode**: workflows are `.dwf.ts` files in
  `~/.zcode/workflows/` created via CreateWorkflow; this tab tunes assignment,
  never the workflow code.

Save & apply writes the roster and then runs the kit's own `kit apply
--only router,provider` — validation, the payg guard, config regeneration and
the provider_config merge all happen through the reference pipeline, never a
second copy inside the router. If apply fails, the roster is rolled back and
resynced before the error reaches the UI. Two fields are not dashboard-editable
on purpose: the router identity (`port` / `localToken`) — changing the port
there would desync the running service definition — and the schema version.

## Files

- `server.js` — the proxy (Node ≥ 18, one npm dep: `@typesafe-ai/sdk`).
- `usage.mjs` — the usage ledger and the SSE tap that meters streams without
  altering a byte.
- `dashboard.html` — the UI above, served at `/dashboard`.
- `config.json` — port, local token, tier table, thresholds. **Generated from
  the roster** (`kit apply`), so hand-edits are overwritten — edit the roster
  or use the dashboard instead. Re-read on mtime change; a restart is only
  needed for code changes.
- `.env` — `TYPESAFE_API_KEY` (chmod 600; copied from the hermes agent env).
- `logs/router.log` — one JSON line per request: tier, upstream model,
  reason (`capability:*` / `judge` / `cache` / `judge:low-confidence`),
  confidence, sizes, upstream status, latency.
- `logs/usage.json` — the usage ledger the dashboard renders.

## Operations

Runs as a launchd user agent:
`~/Library/LaunchAgents/com.alejandrodelvillar.zcode-model-router.plist`
(RunAtLoad + KeepAlive, listens on 127.0.0.1:8300 only).

```bash
launchctl kickstart -k gui/$(id -u)/com.alejandrodelvillar.zcode-model-router  # restart
launchctl bootout gui/$(id -u)/com.alejandrodelvillar.zcode-model-router       # stop
curl -s http://127.0.0.1:8300/healthz                                          # health
open http://127.0.0.1:8300/dashboard                                           # usage + roster UI
tail -f ~/.zcode/router/logs/router.log                                        # watch routing
```

To retarget any workload, profile or chain, edit the roster (`roster.json` in
the kit) or the dashboard's Delegation tab — never `config.json` by hand.
Tier targets fall down their chain when a provider is disabled, its key is
missing, or it bills per token while `allowPayg` is off, and `kit apply`
refuses a roster whose tiers have no usable target at all.

## Known limits

- Routing is OpenAI chat-completions only; the Z.AI coding-plan models
  (GLM-5.3-Flash etc.) speak the Anthropic wire format and are not router
  targets yet — they'd need an Anthropic-messages translation hop.
- Judgments add ~1–3s to the first request of a task; subsequent requests in
  the same task are cache-hits with zero added latency.
