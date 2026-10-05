# Feature: The judge & delegation (single / mixture / swarm)

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Auto routing", "Mixture", "Swarm"), § Failover & Degraded States.

## Purpose

For an `auto` request, decide *how* to run it — one cached judgment per task answering four gated questions: `workload` (tier), `execution` (`single`/`mixture`/`swarm`), first `workflow`, optional `followUp` workflow. Weak confidence in one answer cannot wipe strong confidence in another.

## Judgment properties

- **Cached per session**, keyed on hash(system-prompt head + latest instruction); an agentic tool loop keeps one verdict across dozens of round-trips. Cache: 400 sessions, oldest evicted.
- **Compact input only**: latest instruction plus counters (message count, approx input tokens, images, tool definitions). Never the conversation, never files.
- **Fail-open**: missing key → `judge:no-key`; thrown error → `judge:error:…`; below-threshold → `judge:low-confidence`. Each degrades to `defaultWorkload` as a single call. An outage makes routing lazier; it never fails a request.

## Backends (`judge.mode`)

| Backend | Mechanism | Trade-off |
|---------|-----------|-----------|
| `typesafe` (default) | TypeSafe Jev via `@typesafe-ai/sdk`; task judgment 4s timeout no retries; proposal judgment 6s | strongest, ~1–3s cold |
| `fastino` | GLiNER2.5 encoder served locally by sys1; all four questions in one forward pass | tens of ms, no vendor call |
| `cascade` (recommended) | fastino first; TypeSafe escalates when the encoder is cold, erroring, or under the confidence gates | measured handoff rate in the ledger |

## Execution shapes

- **single** — one focused call to the tier target. The default.
- **mixture** — one hard, non-decomposable question fanned out to `mixture.proposers` (different plan pools / model families) in parallel; a proposal judgment picks the best and decides whether merging adds value — `mixture.aggregator` runs only when integration is warranted. Turns with tool definitions skip mixture (`+mixture-skipped-tools`) and fall back to the hard tier.
- **swarm** — task decomposes, or quality needs critique rounds; the response marks `x-router-execution: swarm` and names the workflow (plus a stage-scoped second stage when needed). Execution lives in the workflow library.

## Asking directly

`POST /route` (local token) returns the verdict without a model call; `kit route "…"` wraps it. Response: `{ workload, execution, target, assignments, conf, wfConf, reason }` — `target: null` on mixture (caller fans out).

## Where the code lives

`router/server.js` (cache, dispatch, mixture), `router/fastino.mjs` (fastino backend), `router/README.md` (judge backends, cold start, logs).
