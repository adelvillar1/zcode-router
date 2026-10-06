# The loop library

> Ported 2026-10-06 from the engine edition. Plan:
> `docs/plans/2026-10-06-run-api-and-loop-library-port.md`.

The kit's `workflows/` directory carries two kinds of file, and the difference
matters: the saved dynamic workflows are `*.dwf.ts` (the delegation library the
model lists and runs through its own tools), and beside them sit the **plane
workflows** — plain `.ts` files the plane runs directly. The seven loops and the four
probes land as the second kind: `workflows/<name>.ts`, harness-neutral, byte-identical
to the engine edition's copies.

## The judge layer

Every yes/no, keep/drop, class, and matters judgment in the loops rides the **sys1
judge layer** — `sys1.judge(spec, text)` on the workflow surface: dev-decisions first
(rows land in the shared calibration store with `input_sha256`), raw sys1 as the
recorded fallback. Flat judgments are the decision layer's job; the LLM agents do
generation only. Where a judgment point intentionally stays an LLM ask (content
scoring in refine-loop), the workflow says so. Measured in this port's verification
runs: triage of three items ran in 1.5 seconds with zero agent calls; a watchdog
no-change run settled in 0.0s with nothing judged; deep-research's cheapest-bound
run (breadth 1, depth 1, budget 4) read five sources across one round — three
candidate findings, zero supported, three unconfirmed — for two search credits and
a stop reason of `coverage`.

## The loops

Run any of them through the kit's own bin:

```
kit workflows run triage --args '{"items":"[{\"id\":\"r1\",\"text\":\"…\"}]"}'
```

- **deep-research** — `docs/features/deep-research.md`. Credit-bounded iterative
  research; searches run in the workflow only, findings judged by a sys1 head,
  enrichment through the operator's self-hosted scraper. Needs the `net-search`
  grant and the Firecrawl env (see below).
- **remediate** — applies confirmed findings: planner groups by file, fixers work
  under per-group checkpoints, the verify command decides, a group that cannot verify
  rolls back clean. Ownership is enforced in code: a whole-workspace manifest before
  and after each fixer, and any change outside the group's declared files — **or to a
  gate file (tests/specs), declared or not** — voids the fix and rolls it back. Born
  from a live run where a fixer "passed" the gate by editing the test.
- **triage** — high-volume classify and route: one sys1 head per item (class +
  confidence), ambiguous items escalate with a structured topic instead of being
  guessed, duplicates escalate for a target name. The first feed is CI failures, over
  the run API.
- **refine-loop** — rubric-scored fix rounds: score per dimension, revise the weakest
  only, stop on plateau (improvement under 0.5) with the score history in the record.
  The per-round scores are calibration rows collected as a side effect.
- **red-team** — hostile attack before ship: persona challengers (LLM), keep/drop and
  confirmation by sys1 heads over the deliverable text, a fixer for confirmed attacks,
  and one re-attack round — residuals are reported, not re-fixed. Fewer personas than
  the set is an under-covered surface and the report says so.
- **watchdog** — state in, state out: the spawner carries prior state between runs
  (spawn facts / result state), the diff is deterministic hashes, and the sys1
  `matters` head is the only judgment — a no-change run spends nothing.
- **router-eval** — the calibration feeder: golden tasks with mechanically checkable
  outcomes replayed across router profiles or pinned models, graded by substring
  checks — never a model verdict — with a per-candidate accuracy/spend/latency table
  and JSONL calibration rows.

## The probes

Zero-model fixtures, the library's own regression surface. They are not part of the
`.dwf.ts` delegation library and are never run as tasks:

- `context-probe.ts` — the standing 19/19 zero-agent fixture for the fact store's
  scoping rules.
- `judge-probe.ts` — the judge envelope on a self-evident head: one dev-decisions
  call, zero agent calls.
- `search-probe.ts` — three modes: `granted` (one real search, two credits),
  `refused` (no grant: the capability refusal by name), `no-key` (grant held, key
  absent: the configured absence names `FIRECRAWL_API_KEY` and `kit env set`).
- `http-probe.ts` — the run-API probe's fixture: one phase, two escalations, one
  artifact, zero model calls.

The remaining model-calling probes (delegate/edit/tokens/budgets/competition/
checkpoint/commands/services/grants/escalation/plane) are engine-side and not carried
here; their absence is not a regression.

## Efficiency rules the library bakes in

1. Flat judgment → sys1 judge head; generation → LLM agents. Never an agent asked for
   a yes/no.
2. Search credits are budgeted in the workflow, searched in one place, and agents hold
   no search tools.
3. Scrapes point at the self-hosted instance (`FIRECRAWL_SCRAPE_URL`); the cloud
   search API stays no-scrape.
4. Every stop — coverage, plateau, depth, credit-budget — is named in the result,
   never hidden in a last round.
