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
- The current agent tool surface is narrow and read-mostly by design (`read_file`, `list_files`, `search_files`, `write_file` whole-file, `run_command` synchronous with a 5-minute cap, `escalate`). What it lacks is the rest of a harness: no surgical edit, no sub-agent delegation, no background command, no git isolation in the swarm (parts write straight into the workspace), no token accounting. Each is a service the plane provides rather than each workflow rediscovering.

What already exists as scattered v1 (this session): `sys1.classify` in the engine API; the `part_atomicity` gate; deterministic dispatch validation; per-champion namespaces; measured-environment facts in builder briefs; the deliverable evidence-gate; `--max-rounds`. The control plane consolidates them into one owned layer instead of per-workflow conventions.

## Approach

### Phase 1 — extract the harness assembly (`agnostic-router-kit`) — ✅ done

1. **`lib/workflow/harness.mjs`** — one module with the assembly every agent brief needs: `measureEnvironment(world)` (runtime versions, workspace facts — measured via allowlisted commands, never assumed), `renderBrief({stack, ns, ownership, acceptance, verification, facts})` (the brief text: environment block, layout, isolation rules, verification recipe, completeness clause). The engine's `agent()` factory consumes it; the swarm's worker/decomposer/integrator briefs consume the same functions. Verify: `node --check`; the briefs in a probe run's journal contain the measured facts. **Done 2026-10-05 (30ed2d0)** — probe journal 2026-10-05_14-42-15 carries node v24.19.0 / python3 3.14.5 / git 2.54.0 / npm 12.0.2.
2. **Contract-shaped agent options** — `agent(name, { system, contract })` where `contract = { files, acceptance, provides, verification, extra }`: the engine renders ownership + acceptance + interface into the brief, and journals the contract so dispatch is auditable after the fact. Verify: probe run journal carries per-agent contract blocks. **Done 2026-10-05 (30ed2d0)** — the plane-probe builder's `contract` event is in the journal.

### Phase 2 — judgment and escalation as plane services — ✅ done

3. **Dispatch gate as a plane service** — the deterministic validators (file disjointness, self-containment, dependency-phrase scan) and the sys1 two-head judgment (`part_atomicity`) move into `harness.mjs` as `validateContract(parts)` + `judgeContract(parts, task)`, consumed by both the swarm and any workflow that decomposes. Verify: swarm decomposition produces `swarm-atomicity` rows; a workflow run's journal shows the same verdicts through the shared code. **Done 2026-10-05 (f148383)** — adversarial-solve's local gate block (`sys1Gate`/`gateVerdict`/`gateNeedsFixup`) and the swarm's own fetch gate are deleted; both consume `harness.mjs`, and the plane-probe journal carries live gate verdicts.
4. **Escalation answering** — run-level `--answers` already exists but matches questions only loosely; make escalations structured (`escalate({ topic, question, evidence })` so `topic` matches an answers key deterministically), and the plane applies the operator's answer before the no-owner default. Verify: a probe run with `--answers '{"stack":"JavaScript on Node"}'` resolves a `topic:"stack"` escalation without the no-owner clause. **Done 2026-10-05 (f148383)** — `--answers` was engine-only with no CLI flag; it is now plumbed through `kit workflows run`. escalation-probe run: with the answers table the builder received "JavaScript on Node 24 with node:test" verbatim; without it the no-owner clause, unchanged.
5. **Judgment surface prefers dev-decisions** — the plane composes dev-decisions for every judgment it can (rows land in the shared calibration store with `input_sha256`, dispositions apply, floors fit from real rows): evidence verification already does; classification judgments (atomicity and future heads) grow dev-decisions first — either a generic `judge` op (ad-hoc heads + `log_record`, registered in `_GATE_OP_TARGET_FIELD`) or per-task ops, per dev-decisions' own doctrine ("add new tasks by defining heads — no provider-code changes"). Raw `sys1.classify` remains the fallback for heads dev-decisions does not yet carry, and each such fallback is a candidate to promote. Verify: the plane's judgment calls appear as dev-decisions store rows; a fallback classification is logged as such. **Done 2026-10-05** — dev-decisions 8368078 adds the generic `judge` op (ad-hoc heads → sys1 → `log_record`, registered in `_GATE_OP_TARGET_FIELD`; the import-cycle repair fad6fb4 without which the CLI could not load at all preceded it), and the kit composes it via `makeJudgingClassifier` (f148383). Live: the probe's two gate calls appear as `op: judge` rows (atomicity 0.97 / multi-concern 0.96, provider glide); with `dev-decisions` hidden from PATH the same two verdicts came back via `sys1-raw`, recorded on the verdict rather than silently swapped.

### Phase 3 — the tool surface (the rest of what a harness handles)

6. **Tool registry with capability grants** — the runtime's tool surface (workspace io, `world.run` allowlist, agent `run_command`) becomes the plane's registry: capability classes (workspace-io, process, net-fetch, package, test-runner), per-run grants (`--allow-cmd` generalized to explicit capability/exe grants), and a journal audit line per call carrying the grant that authorized it. No silent capability growth — a workflow that needs net-fetch or package installs declares the grant, the run log shows it.
   **Done 2026-10-05 (commit)** — `CAPABILITIES` + `resolveGrants` + `requiredGrant` in `tools.mjs`; `run_command`, `world.run` and every workspace tool go through `guarded`, which journals `{kind, tool|command, grant, refused}` on the fired call and the refused one alike; `--grant package,net-fetch` plumbed through `lib/cli.mjs`. Verified with `workflows/grants-probe.ts`: a workspace read fired under `workspace-io`, `npm test` under `test-runner`, `node -e` under `process`; `npm install` refused with `capability not granted in this run: package` and `curl` refused as a non-allowlisted exe, both journaled with the same audit line; `--grant package` made the install fire; `--grant nonsense` failed at launch with a journaled warn + run-failed line and a summary (`kit workflows last` explains itself). Regression: escalation-probe (1 agent call) and plane-probe (dev-decisions gate, conf 0.98 pass / 0.97 REJECT) both unchanged. argv-aware: `npm ci/test/run` stay under the default `test-runner`, only dependency-changing subjects need `package`.
7. **Harness services behind grants** — the services a real harness gives agents, evaluated against the same registry: package installs (`npm ci` locked-only in-run for test runners — no arbitrary installs; a package not in the manifest is rejected, not fetched), bounded net-fetch (research-report already does it through an allowlisted `node -e`; make it a first-class grant carrying a domain allowlist and a response size cap, instead of a trick), dev servers with bounded lifetime for server-shaped deliverables, and format/lint hooks pre-verification. Each is a grant + a capped tool, never ambient.
   **Done 2026-10-05 (commit)** — new `lib/workflow/services.mjs` carries four services, each behind the registry from item 6 rather than beside it. `installPolicy` is argv-aware: `ci` restores from the lockfile, a named package is refused as "the manifest is a human decision" before any registry is contacted, and a bare `install` with a manifest to restore is a restore. `fetchUrl` is capped twice — 1MB at the network, 64KB on the way to a model — and refuses by returning a result, so both `fetch_url` and `world.fetch` journal a second refusal line rather than letting the fired line read as a completed fetch. `ProcessRegistry` gives per-run handles with an offset reader, a readiness marker, a signal-aware `running` (a SIGTERM-killed child has a null exit code and would otherwise poll as running forever), a lifetime cap, and an idempotent stop. `runFormatHooks` runs the workspace's own scripts under `test-runner` and reports rather than throws. Each is reachable both ways — as an agent tool (`fetch_url`, `start_dev_server`, `stop_dev_server`) and on `world` (`world.fetch`, `world.server.{start,poll,stop}`, `world.grants()`, `world.format()`) — through the same guards. Verified with `workflows/services-probe.ts` at 9/9 across three launches: no grants, `--grant package,net-fetch --allow-domain example.com`, and `--grant net-fetch` with no allowlist (fail closed: a grant without an allowlist fetches nothing). The live allowlisted fetch returned status 200 in 577 bytes; `iana.org` was refused by host, the lifetime cap fired at ~1010ms with exit signal SIGTERM; every journal line carries grant or refusal and service events journal as their own `kind:"service"`. A run that ends stops everything it started — `stopped 2 service processes this run started`, nothing left on port 8123. Regression: grants-probe unchanged (3 fired inside their grant, 2 refused outside). C7 stays open for items 10 and 11.
8. **Context services** — what a harness does for context: per-agent brief assembly is already the plane's; add result-shaping on the way back (PartResult validation against the declared contract — the "right shape of deliverable" check is code, not hope).
9. **Surgical file editing** — `edit_file({path, old_string, new_string})` beside `write_file`: exact-match replacement with a uniqueness requirement (a zero-match or ambiguous match fails loudly instead of silently rewriting), scoped to the workspace and to the contract's owned paths. Whole-file rewrites are the dominant corruption mode for parts that touch existing files — a 400-line file regenerated from the model's memory truncates and drifts silently — and this is also the read-before-write discipline a harness enforces as code. Verify: a probe part edits an existing file, the journal carries the edit call, and a non-unique `old_string` returns an error rather than writing.
10. **Bounded sub-agent delegation** — a part that meets a self-contained subproblem delegates it instead of ballooning its own context or throwing "stuck, not big": spawn a fresh-context one-shot completer with its own rounds cap, the same grants, and a declared contract. This is the harness form of the universal atomic contract the decomposition law already states (every agentic unit completable as one standalone completion). It is not an escape hatch from budgets: depth cap 1, one child at a time per part, the child's calls count against the parent's accounting, and the contract + result land in the journal under the parent's namespace. Verify: a probe part whose work needs a sub-lookup delegates it; the journal shows the child's contract and result beneath the parent.
11. **Background commands** — `run_command` stays synchronous for the common case (its cap is the right default); add `start_command`/`poll_command`/`stop_command` with a handle, an offset-based output reader (the same shape as the run watcher's reads), and a lifetime cap. A 10-minute test suite currently turns the agent's synchronous tool round dead at 5 minutes — the room-scale version of the same failure the run-6 80-minute death showed at the run level. Verify: a probe part starts a long command, polls partial output, and stops it; the journal carries start/poll/stop with the exit code.
12. **Per-part checkpoint and rollback** — before a part builds, snapshot its owned paths (the swarm today has no git isolation at all — parts write straight into the workspace, so a failure mid-part leaves debris that poisons integration); on part failure or acceptance failure, rollback the snapshot. Complements all-settled competitions (item 15): a surviving champion's tree must not contain a loser's half-written file. Verify: a deliberately failing part leaves no trace in the integrated tree; checkpoint and rollback are journaled lines.
13. **Token accounting and context compaction** — journal prompt/completion token counts per ask and tool calls per part; budgets (item 14) count tokens alongside rounds, since rounds measure persistence, not cost. When an agent's context crosses a threshold, compact it with one deterministic summarizer ask — keeping the brief's measured facts and contract (the plane-owned parts) — instead of dying at the context wall. Verify: a long part shows accounting lines in its journal section; a compacted agent's environment facts and contract survive when its mid-history does not.

### Phase 4 — lifecycle policy

14. **Per-shape budgets** — cap policy by ask shape: build asks keep `--max-rounds`; verification/loop-shaped asks get a distinct (smaller) cap and a "stuck" escalation instead of a decomposition round. With item 13's accounting the budget is tokens + rounds, not rounds alone. Verify: a probe with a deliberately looping ask escalates with the stuck reason inside the smaller budget.
15. **All-settled competitions** — champion-level failure no longer discards siblings: competitions settle (allSettled), require ≥2 surviving solutions to judge, and degrade honestly below that. Verify: a probe where one champion fails still judges the survivors.

### Phase 5 — zcode retrofit and close

16. **Re-port** `lib/workflow/` (engine + harness) into `zcode-router-kit` with provenance headers; `npm run kit -- doctor` green; `~/.zcode/router/config.json` byte-identical. Verify: node --check both editions; shasum.
17. **Docs** — `docs/features/workflow-runtime.md` gains the control-plane section (what the plane assembles, the tool registry and grants, what stays workflow-side); the swarm doc notes the shared assembly. Cross-repo: the generic `judge` op proposal for dev-decisions (its own repo, its own review) is the preferred home for new plane judgments.

## Use cases (when the feature has user-visible behavior)

- [x] A: A new workflow author declares contracts (files, acceptance, provides) and gets harness services — measured environment, isolation rules, judgment gates, escalation policy — without writing any of them. *(verified 2026-10-05: plane-probe + escalation-probe write no assembly code of their own)*
- [x] B: A builder never discovers environment facts by burning tool rounds: its brief carries the measured versions, the pinned stack, the layout, and the verification recipe. *(verified 2026-10-05: the builder's brief/journal carries the measured versions)*
- [x] C: An operator pre-decides the ambiguous calls (stack, tie-breaks); builders' escalations on those topics resolve from configuration instead of "no owner". *(verified 2026-10-05: escalation-probe with and without --answers)*

## Acceptance criteria

Order is identity: use cases are C0–C2, criteria C3–C11.

- [x] Harness assembly (environment measurement, brief rendering, contract validation, judgment calls) lives in one module consumed by both the engine and the swarm — no brief-building logic duplicated in workflows or swarm code. *(C3 — 2026-10-05: adversarial-solve's and the swarm's local blocks are deleted; both import harness.mjs)*
- [x] Every dispatched builder brief contains measured environment facts and its full contract (owned files, acceptance, provides); the journal records the contract per agent. *(C4 — 2026-10-05: probe journal)*
- [x] Dispatch validation is deterministic code: file collisions, non-owned path references, and dependency phrases reject before any builder runs; violations never reach a builder without being recorded. *(C5 — 2026-10-05: validateContract unit-tested for true positives (cross-part reference, collision, dependency phrase, no-files) and the false positive killed by suffix matching)*
- [x] Judgment events route through the decision layer per the established law, dev-decisions first: evidence verification runs `dev-decisions evidence-gate`; bounded classifications compose dev-decisions ops where they exist (rows in the shared calibration store, dispositions apply) and fall back to raw `sys1.classify` only for heads dev-decisions does not yet carry — with the fallback recorded as a promotion candidate. The plane adds no new inline model calls and no hand-set thresholds. *(C6 — 2026-10-05: judge op rows with input_sha256; fallback recorded on the verdict as source: sys1-raw)*
- [ ] The tool surface is the plane's registry: every capability a run uses is a declared grant, every tool call is journaled against its grant, and no capability (net-fetch, package installs, dev servers, sub-agent spawning, background commands) is ambient. *(C7 — partial 2026-10-05: the registry exists and every call on today's surface is journaled against its grant (item 6, grants-probe); net-fetch, package installs and dev servers are now grants too (item 7, services-probe). Still open: items 10 and 11 must register sub-agent spawning and background commands into the same registry — the criterion closes when those two are grants as well, not before.)*
- [x] Escalations carry a structured topic; an operator-supplied answer matching the topic resolves the escalation deterministically, and unanswered ones keep the no-owner behavior. *(C8 — 2026-10-05: escalation-probe, both variants)*
- [ ] Ask budgets are per shape (tokens alongside rounds, with compaction before the context wall), and a competition or parallel build survives a member's failure when enough members survive (allSettled semantics plus per-part checkpoint/rollback), degrading honestly below the threshold.
- [x] The kit's own workflow library uses the plane: adversarial-solve carries no brief-assembly code of its own, and the swarm consumes the same module. *(C10 — 2026-10-05: grep confirms no local brief/gate assembly remains in either; the swarm's atomicity gate and the workflows' dispatch gate are the same code)*
- [ ] zcode-router-kit runs the ported plane with doctor green and its rendered runtime config byte-identical.

## Files to be touched

**agnostic-router-kit:** `lib/workflow/harness.mjs` (new), `lib/workflow/tools.mjs` (the registry grows here — edit/background/sub-agent tools, behind the plane's grants), `lib/workflow/engine.mjs` (agent factory consumes the plane), `router/swarm.mjs` (briefs + gates consume the plane), `workflows/adversarial-solve.ts` (contracts only, no assembly), `docs/features/workflow-runtime.md`.
**zcode-router-kit:** `lib/workflow/` (re-ported), `docs/plans/` — this plan.
**dev-decisions (its own repo, its own review):** the preferred home for new plane judgments — a generic `judge` op (ad-hoc sys1 heads + `log_record` + `_GATE_OP_TARGET_FIELD` registration) so classification judgments compose the calibration store like every other gate.
**Out of scope:** the router's judge path (already sys1), ZCode-harness `.dwf.ts` workflows, any UI.

## Verification

**C3:** grep the swarm + workflow sources for brief-assembly duplication → only `harness.mjs`; `node --check` all.
**C4:** probe run → the journal's agent contracts include measured facts (compare against a live `node --version`).
**C5:** a contract with a duplicate file path and an "already built" instruction is rejected pre-dispatch, with the rejection in the journal.
**C6:** the sys1 calls carry the established head shapes; a gate outage degrades fail-open with the reason logged.
**C7:** a probe exercising `edit_file`, one background command, and one sub-agent shows one journal line per call naming its grant; the same calls are refused without the grant, and the refusal carries the same audit line.
**C8:** a probe run with a pre-seeded answer resolves a matching escalation; without it, no-owner behavior is unchanged.
**C9:** a two-champion probe where one champion fails still judges the survivor and the failed part leaves no trace; `--max-rounds` still governs build asks; a long part shows token accounting and compaction before the context wall.
**C10:** adversarial-solve and the swarm consume the plane's assembly functions — no brief-assembly code remains in either (grep the sources).
**C11:** doctor green in zcode-router-kit; `~/.zcode/router/config.json` byte-identical.

## Risks

- **Brief bloat** — contracts and facts add tokens to every call. Mitigation: the brief is assembled once per agent (not per tool round), and the contract is data, capped like every other journal preview.
- **Delegation as budget escape** — sub-agents could become a way to spread an over-budget ask across fresh contexts. Mitigation: depth cap 1, one child at a time, the child's tokens count against the parent's accounting, and the spawn is journaled like every other capability.
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
