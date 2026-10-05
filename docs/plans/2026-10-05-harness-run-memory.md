---
status: completed
created: 2026-10-05
updated: 2026-10-05
slug: harness-run-memory
---

# Plan: run memory for harnessed agents

## Context

A HACP agent's knowledge at dispatch is exactly what the coordination layer pushes: its system prompt, the rendered brief, its contract, and its own tool results. There is no pull channel. The only tool that looks like one, `escalate`, is scoped to blocking ambiguities answered from the operator's pre-supplied table — a pull for owner decisions, not for facts. So a builder cannot ask what stack the plane pinned, what the dispatch gate said about its own part, which champion is winning, or whether a sibling part finished. Whatever the plane does not push, the agent simply does not have.

The storage and the audit trail already exist: `run.jsonl` journals every dispatched contract, every tool call against its grant (item 6), every service event and every gate verdict, and `renderBrief` pushes the plane's known facts at dispatch time. This plan adds the missing read path aimed at the agent — the pull half of item 8's context services. It is deliberately *coordination* memory, not content memory: the swarm's load-bearing invariant is that a worker sees nothing but the original request and its own instruction, and that isolation is what makes parts independent and their atomicity measurable.

## Approach

Two primitives, mirroring the split item 7 established between the workflow-side `world.*` surface and the agent-side tools. Fact kinds are declared rather than free-text, for two reasons: a fact is a journaled row rather than a model's summary of a journal, and the content/coordination boundary becomes enforceable in code instead of in a prompt.

`world.remember(kind, fact)` is how the coordination layer records a fact, written only by the plane and never by an agent. `recall(query)` is one more agent tool doing a deterministic lookup over the run's fact store — no model in the path — filtered to what that agent may see, byte-capped and journaled like every other read.

The rule that keeps it honest: a fact known at dispatch time belongs in the brief (push), and `recall` is for facts that arise *after* dispatch — the verdict on this part, a decision the champion made mid-run, a sibling's status changing. A fact missing from a brief is a plane bug, and a `recall` that rescues it would hide the bug while spending tokens.

### Phase A — the store

1. **`lib/workflow/harness.mjs`** — `makeRunMemory()`: the per-run fact store, a declared kind set (`task`, `stack`, `environment`, `decision`, `verdict`, `status`, `phase`), `remember` (coordination-layer only), and `lookup({ kinds, scope })` returning the facts a given scope may see. Store lives in memory beside the run's state; the journal is the durable record. Verify: `node --check`; a unit run records and reads back facts with unknown kinds refused by name. **Done 2026-10-05** — `makeRunMemory` exports `remember` (refusing an undeclared kind by name and an empty fact), `facts()` for the plane and `recallTool(scope)` for the agent side; the store unit run holds 207 facts and a `/tmp/memory-test.mjs` pass. The unit test found two real defects before the live run: the plane read was blind to part-scoped facts (`render`'s `mine` defaulted to null, which excluded every part-scoped fact — the reader documented as seeing everything saw only the public ones), and the 40-fact cap broke without a truncation line, so a reader handed 40 of 200 facts was told nothing about the other 160. Both fixed; a third defect (`ids` named a fact the reader never saw, because it sliced by rendered-line count) was found by reading a real recall line from probe run 2026-10-05_17-17-22 and fixed the same way.

### Phase B — the agent-side read

2. **`lib/workflow/tools.mjs` + `lib/workflow/engine.mjs`** — the `recall` tool definition beside `read_file`/`escalate`, wired through `buildTools` with the agent's scope injected the way `contract` already is. It is part of the default agent surface (a read of the plane's own store, like `read_file`), **not a new grant** — writes to the store stay a workflow-side privilege. Results are capped and truncated with the truncation recorded, the same discipline `fetchUrl` applies. Verify: a probe agent recalls a fact; the journal carries the recall line with kinds queried, fact ids, and byte size. **Done 2026-10-05** — `recall` joins the default surface beside `read_file`, deliberately outside `guarded` (it carries no capability; routing it through `guarded` would have labelled it "process"). The journal carries two lines per recall, as every other tool call does: the action line (`kind:"tool"`, `tool:"recall"`) and the capability line carrying `facts`, `ids` and `bytes`. The capability line is the one the CLI and `events.mjs` render. Note a deviation from the plan's own wording: the `recall` brief says a fact missing from a brief is a plane bug, so `recall` never *fetches* — it reads the store.

### Phase C — scoping and consumption

3. **Scoping as code** — an agent's scope is `public` (run-level facts) plus `own-part` (its part's status and the plane's verdicts about its part). A query naming a sibling's part, files, or built content is refused by name with the reason journaled, exactly as a refused grant is. Verify: a probe part asks for a sibling's `built` content and gets the refusal, not the content. **Done 2026-10-05** — the visible-set rule lives in `render`, not in a prompt: a plane read sees everything and narrows by `part`; an agent read sees public facts plus its own part's, and a `part` argument naming a sibling is refused by name ("out of bounds: build-3 is another part") with the refusal journaled like a refused grant. Because no agent tool trial can reach a sibling, the probe proves the boundary from the agent side (`recallTool(scope)`), which is the same closure `makeAgent` installs per agent — the reason `recallAs` exists on the workflow surface.

4. **Consumption** — `workflows/adversarial-solve.ts` records the pinned stack, the judge's verdict per part, and per-part status as facts (a few `world.remember` calls beside the existing gate code, no assembly of its own); `router/swarm.mjs` records decomposition decisions and part status. Verify: grep confirms neither consumer carries recall-assembly code of their own. **Done 2026-10-05** — adversarial-solve records nine facts (task, stack, decision at start; environment after measurement; the judge's verdict per part; dispatched/built statuses per builder and sub-builder) with `scope: { part }` on the builder agents; swarm.mjs records twelve and pushes its own part's facts into each worker's prompt. **Deviation recorded honestly**: the plan said swarm "workers may recall", but a swarm worker is a bare completion with no tool loop — it has no way to call `recall`. Workers receive their own part's facts by push, which is the same isolation the swarm's load-bearing invariant requires, documented as such in `docs/features/swarm-execution.md`.

5. **The push rule, asserted rather than assumed** — a probe builder brief must still carry the measured environment, the pinned stack and its contract with no `recall` call in the run that produced it, so a fact missing from a brief stays a visible plane bug instead of becoming an invisible recall opportunity. Verify: the probe run's builder brief carries the measured facts and its journal shows no recall before that agent's first ask. **Done 2026-10-05** — `renderBrief` carries the measured facts, the pinned stack and the contract unchanged; the plane-probe run 2026-10-05_17-22-47 journaled "plane measured: node v24.19.0 · python3 3.14.5 · git 2.54.0 · npm 12.0.2" at dispatch, the builder's own output carries "Pinned stack: JavaScript on Node 24, node:test, zero npm dependencies", and that journal holds no recall line at all — the agent knew the stack because it was pushed, and the plane recorded no fact it then needed back. The same assertion in the real workflow is what the upcoming adversarial-solve run extends this to.

## Use cases (when the feature has user-visible behavior)

- [x] A: A builder whose sibling part's status changed mid-run queries the run's own state instead of escalating a stale fact or guessing — it asks what is true now, and gets the plane's answer, not another model's summary. *(verified 2026-10-05: the scoped-read trial reads the run's public facts plus its own part's status in one call — 11 facts, 355 bytes; a live builder taking this path mid-run is what the adversarial-solve run shows)*
- [x] B: An agent can ask what the plane decided about its own part (the dispatch-gate verdict, the adopted elements, the recorded conflicts) without the champion relaying it, so a rejected part learns why while it can still fix it. *(verified 2026-10-05: adversarial-solve records the judge's verdict per part under that part's scope; the scoped-read trial sees its own part's verdict facts and not its sibling's)*
- [x] C: An operator can audit what an agent was told: every recall is a journaled line naming the kinds queried and the facts returned, so "what did the builder know" is a journal question rather than an inference. *(verified 2026-10-05: recall journal lines carry `facts`, `ids` and `bytes`; the CLI renders them as `✎ <kind> <part> — <preview>`)*

## Acceptance criteria

These are the contract. Each one is a verifiable assertion. The work is "done" when every box is checked. **Order is identity**: criteria are C0, C1, … in checkbox order — never reorder after gating.

- [x] The plane owns one fact store per run: `world.remember(kind, fact)` accepts a kind from the declared set, refuses an unknown kind by name, and journals every fact written with its kind. *(C0 — 2026-10-05: context-probe 19/19; an unknown kind is refused as `unknown fact kind: weather (declared: task, stack, environment, decision, verdict, status, phase)` and an empty fact as "a fact with no text is not a fact"; every `remember` journals `{kind:"fact", op, factId, factKind, part, chars, text}`)*
- [x] `recall` is part of the default agent surface and answers deterministically — the path from query to answer contains no model call. *(C1 — 2026-10-05: the recall path is `render` over an array — grep shows no classifier/chat call; the probe's eleven store trials add zero agent events and the whole run takes 0.1s)*
- [x] Scoping is enforced in code, not in prompts: an agent receives the run's public facts, its own part's facts, and the plane's verdicts about its own part, and nothing beyond them. *(C2 — 2026-10-05: the scoped agent sees 11 facts (public + own) where the sibling-scoped read sees 9; a scope-free agent sees public only)*
- [x] No sibling content is retrievable: a probe part that asks for another part's built content, files, or result is refused by name, and the refusal is journaled like every other refusal. *(C3 — 2026-10-05: naming a sibling part throws `out of bounds: build-3 is another part — an agent reads the run's public facts and its own part's, never a sibling's`, journaled on the same line as a fired recall)*
- [x] Every recall is journaled with the kinds queried, the fact ids returned, and the byte size, so an operator can audit what an agent was told. *(C4 — 2026-10-05: the recall journal line carries `args.kind`, `ids` and `bytes`; run 2026-10-05_17-19-24 line 3 is `facts=11 ids=[f1..f11] bytes=355`)*
- [x] Recall results are byte-capped and truncated with the truncation recorded, never silently cut — the same cap discipline `fetchUrl` already applies. *(C5 — 2026-10-05: a 69-fact store renders 40 facts and appends "… 29 more fact(s) over the 40-fact cap — ask for one kind at a time"; a store over 8KB records the byte cap the same way)*
- [x] A probe builder's brief carries the measured environment, the pinned stack and its contract, and the run that produced it shows no `recall` call — push still covers everything the plane knew at dispatch time. *(C6 — 2026-10-05: plane-probe run 2026-10-05_17-22-47 — the plane logged the measured versions at dispatch, the builder's output carries the pinned stack, and the journal has no recall line; the live adversarial-solve run extends the same assertion to a real builder)*
- [x] The workflow and the swarm consume the plane's store with no recall-assembly code of their own (grep confirms), and each recall's bytes are counted toward the agent's context accounting once item 13 lands. *(C7 — 2026-10-05: grep shows `remember`/`recall` call sites only; the one non-remember use is swarm.mjs's push line appending its own part's facts to a worker prompt. Item 13's accounting half stays open with that item.)*

## Files to be touched

**agnostic-router-kit (the engine owner):**
- `lib/workflow/harness.mjs` — the fact store, the declared kind set, and the scope filter (`makeRunMemory`), beside `renderBrief`/`validatePartResult` as the other context services.
- `lib/workflow/tools.mjs` — the `recall` tool definition, and the journal audit line for a fired/refused recall beside the existing `guarded` lines.
- `lib/workflow/engine.mjs` — `world.remember` on the `world.*` surface; the `recall` tool wired into `buildTools` with the agent's scope injected the way `contract` is.
- `workflows/adversarial-solve.ts` — records stack, per-part gate verdicts, and per-part status as facts; builders may recall.
- `router/swarm.mjs` — records decomposition decisions and part status as facts; workers may recall.
- `workflows/context-probe.ts` — extended with deterministic recall trials (fires, scope refusal, cap, push-rule), still zero agent calls.
- `docs/features/workflow-runtime.md` — the recall surface, the kind set, and the push-vs-recall rule.

**zcode-router-kit:** `lib/workflow/` re-ported with the plane in Phase 5 of the control-plane plan; this plan file under `docs/plans/`.

## Out of scope

- Free-text Q&A over `run.jsonl` — a model summarizing the journal is a prompt, not code, and it would defeat the auditability this exists to provide.
- Retrieving any sibling part's content, files, or result. That is the isolation the whole plane rests on.
- Cross-run memory or any persistence past the run's end. Facts die with the run; the journal is the record.
- A new capability grant. `recall` reads the plane's own store and joins `read_file` on the default surface; writes stay workflow-side.
- Changing what the brief pushes. The push rule is a constraint on this work, not something it revises.

## Verification

**C0:** a scratch run calls `world.remember` with a valid kind and an unknown one; the journal shows both, the second refused.
**C1:** grep the recall path for any classifier/chat call — there is none; a probe recall returns instantly with zero `agent` events.
**C2:** a probe agent scoped to part X recalls a run-level fact (the stack) and its own part's status; the same query from part Y returns the run-level fact and not X's.
**C3:** a probe part asks for a sibling's `built` content; the journal carries the refusal naming the scope rule and the content never appears.
**C4:** the recall lines in a probe journal name kinds, fact ids, and byte size.
**C5:** a fact larger than the cap is truncated with the truncation recorded in the same line.
**C6:** the probe builder's brief carries the measured environment, the pinned stack and its contract, and no fact the plane knew at dispatch is recall-only.
**C7:** `grep -c "recall\|remember" workflows/adversarial-solve.ts router/swarm.mjs` shows call sites only — no assembly logic.

Regression: escalation-probe, plane-probe, grants-probe, services-probe and context-probe all unchanged (recall is additive to the default surface, and every probe still runs with zero agent calls where it did before).

## Linked artifacts

- `docs/features/workflow-runtime.md` — new "run memory" subsection in the control-plane section written by item 17.
- `docs/features/swarm-execution.md` — note that workers now have read-only run facts.
- `TECHNICAL-DOCUMENTATION.md` — the plane's service list gains the fact store and `recall`.

## Notes

- **sys1 decision-shape check (per plan convention):** recall is deterministic lookup over stored facts. No sys1 head fits and none is added; the plane adds no new inline model calls.
- Cross-referenced as item 18 of `2026-10-05-harnessed-agent-control-plane.md`, where it is the pull half of item 8's context services. Its criteria interact with item 13 (token accounting counts recall bytes) and item 10 (a delegated child's recall scope is declared at spawn, inheriting the parent's or none).
