---
status: active
created: 2026-10-05
updated: 2026-10-05
slug: harnessed-agent-control-plane
---

# Plan: the harnessed agent control plane

> **For the harness:** implement phase-by-phase; every task names exact files and a verify command. The engine is verbatim-ported between editions — agnostic-router-kit owns it upstream; zcode re-ports.

**Goal:** agents in the kit's runtime (workflows and the swarm) are bare completions with a small tool surface. Every multi-agent feature since 2026-10-04 has re-discovered, by hand, the services a harness would provide: environment facts, working conventions, task contracts, ownership, judgment gates, escalation answers. Each hand-rolling missed something (run 2026-10-05_12-08-04 alone produced four conflict classes: hidden inter-part dependencies, file-path collisions, contradictory acceptance math, an unpinned stack). This plan makes one component own them: a **harnessed agent control plane** — the layer between an orchestrator (workflow engine, swarm) and the bare model calls, which assembles everything an agent would otherwise get from a harness, from measured facts and declared contracts, in code.

## Context

The evidence, all from adversarial-solve runs on 2026-10-05 (journals under `/tmp/agnostic-wf/workflow-runs/`):

- Builders asked what stack to use (none was specified) and gathered `Node v24.19.0` facts themselves, repeatedly, per agent.
- Champions decomposed into "parallel" parts with hidden producer→consumer dependencies ("wire the already-built lower modules (do not modify)") while dispatch is parallel and builders see only their own part.
- Two parts wrote `test/server.test.js` and `src/store.js` with different designs; one file was "concurrently REPLACED mid-session" under a working builder.
- Acceptance criteria carried self-contradictory arithmetic (a `tat = now + interval` case allowing 2 back-to-back requests while asserting 3; a retry_after formula contradicting its own worked example).
- Every escalation met "no owner available — proceed on best judgment", even when the operator could have answered in one line.
- One champion's failure discarded three other champions' finished work (`Promise.all`).

What already exists as scattered v1 (this session): `sys1.classify` in the engine API; the `part_atomicity` gate; deterministic dispatch validation; per-champion namespaces; measured-environment facts in builder briefs; the deliverable evidence-gate; `--max-rounds`. The control plane consolidates them into one owned layer instead of per-workflow conventions.

## Approach

### Phase 1 — extract the harness assembly (`agnostic-router-kit`)

1. **`lib/workflow/harness.mjs`** — one module with the assembly every agent brief needs: `measureEnvironment(world)` (runtime versions, workspace facts — measured via allowlisted commands, never assumed), `renderBrief({stack, ns, ownership, acceptance, verification, facts})` (the brief text: environment block, layout, isolation rules, verification recipe, completeness clause). The engine's `agent()` factory consumes it; the swarm's worker/decomposer/integrator briefs consume the same functions. Verify: `node --check`; the briefs in a probe run's journal contain the measured facts.
2. **Contract-shaped agent options** — `agent(name, { system, contract })` where `contract = { files, acceptance, provides, verification, extra }`: the engine renders ownership + acceptance + interface into the brief, and journals the contract so dispatch is auditable after the fact. Verify: probe run journal carries per-agent contract blocks.

### Phase 2 — judgment and escalation as plane services

3. **Dispatch gate as a plane service** — the deterministic validators (file disjointness, self-containment, dependency-phrase scan) and the sys1 two-head judgment (`part_atomicity`) move into `harness.mjs` as `validateContract(parts)` + `judgeContract(parts, task)`, consumed by both the swarm and any workflow that decomposes. Verify: swarm decomposition produces `swarm-atomicity` rows; a workflow run's journal shows the same verdicts through the shared code.
4. **Escalation answering** — run-level `--answers` already exists but matches questions only loosely; make escalations structured (`escalate({ topic, question, evidence })` so `topic` matches an answers key deterministically), and the plane applies the operator's answer before the no-owner default. Verify: a probe run with `--answers '{"stack":"JavaScript on Node"}'` resolves a `topic:"stack"` escalation without the no-owner clause.
5. **Judgment surface prefers dev-decisions** — the plane composes dev-decisions for every judgment it can (rows land in the shared calibration store with `input_sha256`, dispositions apply, floors fit from real rows): evidence verification already does; classification judgments (atomicity and future heads) grow dev-decisions first — either a generic `judge` op (ad-hoc heads + `log_record`, registered in `_GATE_OP_TARGET_FIELD`) or per-task ops, per dev-decisions' own doctrine ("add new tasks by defining heads — no provider-code changes"). Raw `sys1.classify` remains the fallback for heads dev-decisions does not yet carry, and each such fallback is a candidate to promote. Verify: the plane's judgment calls appear as dev-decisions store rows; a fallback classification is logged as such.

### Phase 3 — the tool surface (the rest of what a harness handles)

6. **Tool registry with capability grants** — the runtime's tool surface (workspace io, `world.run` allowlist, agent `run_command`) becomes the plane's registry: capability classes (workspace-io, process, net-fetch, package, test-runner), per-run grants (`--allow-cmd` generalized to explicit capability/exe grants), and a journal audit line per call carrying the grant that authorized it. No silent capability growth — a workflow that needs net-fetch or package installs declares the grant, the run log shows it.
7. **Harness services behind grants** — the services a real harness gives agents, evaluated against the same registry: package installs (`npm ci` in-run for test runners), bounded net-fetch (research-report already does it through an allowlisted `node -e`; make it a first-class grant instead of a trick), dev servers with bounded lifetime for server-shaped deliverables, and format/lint hooks pre-verification. Each is a grant + a capped tool, never ambient.
8. **Context services** — what a harness does for context: per-agent brief assembly is already the plane's; add result-shaping on the way back (PartResult validation against the declared contract — the "right shape of deliverable" check is code, not hope).

### Phase 4 — lifecycle policy

9. **Per-shape budgets** — cap policy by ask shape: build asks keep `--max-rounds`; verification/loop-shaped asks get a distinct (smaller) cap and a "stuck" escalation instead of a decomposition round. Verify: a probe with a deliberately looping ask escalates with the stuck reason inside the smaller budget.
10. **All-settled competitions** — champion-level failure no longer discards siblings: competitions settle (allSettled), require ≥2 surviving solutions to judge, and degrade honestly below that. Verify: a probe where one champion fails still judges the survivors.

### Phase 5 — zcode retrofit and close

11. **Re-port** `lib/workflow/` (engine + harness) into `zcode-router-kit` with provenance headers; `npm run kit -- doctor` green; `~/.zcode/router/config.json` byte-identical. Verify: node --check both editions; shasum.
12. **Docs** — `docs/features/workflow-runtime.md` gains the control-plane section (what the plane assembles, the tool registry and grants, what stays workflow-side); the swarm doc notes the shared assembly. Cross-repo: the generic `judge` op proposal for dev-decisions (its own repo, its own review) is the preferred home for new plane judgments.

## Use cases (when the feature has user-visible behavior)

- [ ] A: A new workflow author declares contracts (files, acceptance, provides) and gets harness services — measured environment, isolation rules, judgment gates, escalation policy — without writing any of them.
- [ ] B: A builder never discovers environment facts by burning tool rounds: its brief carries the measured versions, the pinned stack, the layout, and the verification recipe.
- [ ] C: An operator pre-decides the ambiguous calls (stack, tie-breaks); builders' escalations on those topics resolve from configuration instead of "no owner".

## Acceptance criteria

Order is identity: use cases are C0–C2, criteria C3–C8.

- [ ] Harness assembly (environment measurement, brief rendering, contract validation, judgment calls) lives in one module consumed by both the engine and the swarm — no brief-building logic duplicated in workflows or swarm code.
- [ ] Every dispatched builder brief contains measured environment facts and its full contract (owned files, acceptance, provides); the journal records the contract per agent.
- [ ] Dispatch validation is deterministic code: file collisions, non-owned path references, and dependency phrases reject before any builder runs; violations never reach a builder without being recorded.
- [ ] Judgment events route through the decision layer per the established law, dev-decisions first: evidence verification runs `dev-decisions evidence-gate`; bounded classifications compose dev-decisions ops where they exist (rows in the shared calibration store, dispositions apply) and fall back to raw `sys1.classify` only for heads dev-decisions does not yet carry — with the fallback recorded as a promotion candidate. The plane adds no new inline model calls and no hand-set thresholds.
- [ ] The tool surface is the plane's registry: every capability a run uses is a declared grant, every tool call is journaled against its grant, and no capability (net-fetch, package installs, dev servers) is ambient.
- [ ] Escalations carry a structured topic; an operator-supplied answer matching the topic resolves the escalation deterministically, and unanswered ones keep the no-owner behavior.
- [ ] Ask budgets are per shape, and a competition/parallel build survives a member's failure when enough members survive (allSettled semantics), degrading honestly below the threshold.
- [ ] The kit's own workflow library uses the plane: adversarial-solve carries no brief-assembly code of its own, and the swarm consumes the same module.
- [ ] zcode-router-kit runs the ported plane with doctor green and its rendered runtime config byte-identical.

## Files to be touched

**agnostic-router-kit:** `lib/workflow/harness.mjs` (new), `lib/workflow/engine.mjs` (agent factory consumes the plane), `router/swarm.mjs` (briefs + gates consume the plane), `workflows/adversarial-solve.ts` (contracts only, no assembly), `docs/features/workflow-runtime.md`.
**zcode-router-kit:** `lib/workflow/` (re-ported), `docs/plans/` — this plan.
**dev-decisions (its own repo, its own review):** the preferred home for new plane judgments — a generic `judge` op (ad-hoc sys1 heads + `log_record` + `_GATE_OP_TARGET_FIELD` registration) so classification judgments compose the calibration store like every other gate.
**Out of scope:** the router's judge path (already sys1), ZCode-harness `.dwf.ts` workflows, any UI.

## Verification

**C3:** grep the swarm + workflow sources for brief-assembly duplication → only `harness.mjs`; `node --check` all.
**C4:** probe run → the journal's agent contracts include measured facts (compare against a live `node --version`).
**C5:** a contract with a duplicate file path and an "already built" instruction is rejected pre-dispatch, with the rejection in the journal.
**C6:** the sys1 calls carry the established head shapes; a gate outage degrades fail-open with the reason logged.
**C7:** a probe run with a pre-seeded answer resolves a matching escalation; without it, no-owner behavior is unchanged.
**C8:** a two-champion probe where one champion fails still judges the survivor; `--max-rounds` still governs build asks.

## Risks

- **Brief bloat** — contracts and facts add tokens to every call. Mitigation: the brief is assembled once per agent (not per tool round), and the contract is data, capped like every other journal preview.
- **Plane/workflow responsibility drift** — the plane owns assembly and enforcement; workflows own content. The acceptance criteria pin the boundary (no assembly code outside the plane).
- **Edition divergence** — the plane is engine-owned; the verbatim-port rule covers it like the rest of `lib/workflow/`.

## Out of scope

- Changing the router's routing judge or ledger.
- ZCode-harness (`.dwf.ts`) workflows — they already run inside a real harness.
- Resume/checkpointing of failed runs (separate concern, tracked in the runtime doc's roadmap).

## Notes

- **sys1 decision-shape check (per plan convention):** the plane's own assembly (environment measurement, contract validation, brief rendering) is deterministic code — no sys1 head fits and none is added. The judgments it *invokes* (atomicity, criteria consistency, deliverable acceptance) already route through sys1/dev-decisions per the established law.
- The name: this is the agent-side analogue of the router itself — the router is the control plane for model traffic; this is the control plane for agent work.
- First consumers: adversarial-solve (the torture test that produced the requirements) and the swarm.
