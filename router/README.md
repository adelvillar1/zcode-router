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

To retarget any workload or profile, edit `routing.workloads` / `routing.profiles`
in `config.json` — any provider in ZCode's provider config can be a target,
and the next request picks changes up (restart to change the port).

## Files

- `server.js` — the proxy (Node ≥ 18, one npm dep: `@typesafe-ai/sdk`).
- `config.json` — port, local token, tier table, thresholds. Edit and the
  next request picks it up (restart to change the port).
- `.env` — `TYPESAFE_API_KEY` (chmod 600; copied from the hermes agent env).
- `logs/router.log` — one JSON line per request: tier, upstream model,
  reason (`capability:*` / `judge` / `cache` / `judge:low-confidence`),
  confidence, sizes, upstream status, latency.

## Operations

Runs as a launchd user agent:
`~/Library/LaunchAgents/com.alejandrodelvillar.zcode-model-router.plist`
(RunAtLoad + KeepAlive, listens on 127.0.0.1:8300 only).

```bash
launchctl kickstart -k gui/$(id -u)/com.alejandrodelvillar.zcode-model-router  # restart
launchctl bootout gui/$(id -u)/com.alejandrodelvillar.zcode-model-router       # stop
curl -s http://127.0.0.1:8300/healthz                                          # health
tail -f ~/.zcode/router/logs/router.log                                        # watch routing
```

To tune tiers, edit `routing.tiers` in `config.json` — any provider that
exists in ZCode's provider config can be a target. To add DeepSeek
(pay-per-token) as the `deep` tier, point it at `deepseek/deepseek-v4-pro`.

## Known limits

- Routing is OpenAI chat-completions only; the Z.AI coding-plan models
  (GLM-5.3-Flash etc.) speak the Anthropic wire format and are not router
  targets yet — they'd need an Anthropic-messages translation hop.
- Judgments add ~1–3s to the first request of a task; subsequent requests in
  the same task are cache-hits with zero added latency.
