---
status: completed
created: 2026-10-05
updated: 2026-10-05
slug: plane-package-and-engine-split
---

# Plan: the workflow plane as its own package, and the engine split

## Context

`lib/workflow/` — the harnessed agent control plane closed by
[2026-10-05-harnessed-agent-control-plane.md](2026-10-05-harnessed-agent-control-plane.md) —
exists in three places: the engine edition (`agnostic-router-kit`), a hand-re-ported
copy in `zcode-router-kit`, and a third copy installed beside the router by
`kit apply`. Only the first is authoritative, and the rule holding them together is a
comment: every ported file says "re-port, never fork". That rule has already failed
twice in the open — the kit's copy was missing `harness.mjs`, `checkpoint.mjs` and
`services.mjs` entirely, and the six files it did carry had diverged — and a third
time silently, because `~/.zcode/lib/workflow/` still holds the pre-plane six-file set
while the live service serves requests from it. Separately, `engine.mjs` is 1471 lines
carrying five unrelated concerns behind one export surface, which makes every future
change a change to the biggest file in the plane.

This plan does two things, in this order: give the plane a real package boundary so
there is one source of truth, then move four concerns out of `engine.mjs` so the
remaining module is orchestration and nothing else.

## Approach

Give `lib/workflow/` its own `package.json` in the engine edition and switch every
consumer on both sides to the package specifier. The kit resolves it as a file
dependency on the engine checkout, which converts "the kit's copy drifted" from a
silent fact into an install-time error, and lets the existing `copyRuntime` keep
shipping it beside the router unchanged in shape. The engine split then runs entirely
inside the package — the kit receives it as a version bump rather than a second port,
which is the whole reason the package comes first. Each of the four moves is pure code
motion with no behavior change: no new exports, no changed signatures, no altered event
stream.

The engine's dependency graph makes the cuts clean rather than hopeful. `engine.mjs` is
the only module that imports the other eight, and the four concerns to be extracted
import nothing from the plane at all — coercion, transport, git and run-directory code
are leaves. The one exception is the policy module (budgets, accounting, compaction),
which sits mid-loop and is therefore moved last.

The work runs in three phases, each ending with the same three checks.

### Phase A — the package boundary

1. **Establish the baseline.** Write `tools/compare-journals.py` (strips `t` and `ms`,
   compares event kind and field sequence) and capture the three zero-agent-call
   probes' journals — checkpoint, context, commands — as the before state. Nothing
   moves until the baseline exists.
   **Done 2026-10-05 (engine `905e2fe`)** — the comparator strips only `t` and `ms` and compares the event kind and field sequence; the baseline is three runs at `/tmp/plane-baseline` (checkpoint 50 events, context 99, commands 101). The tool also proved itself by refusing a scribbled-together comparison of two runs from the same launch rather than silently matching them.
2. Add the package manifest to `lib/workflow/` — name, version, `type: module`, one
   exports entry per module, zero runtime dependencies.
   **Done 2026-10-05 (engine `37e7a77`)** — `workflow-plane@1.0.0`, `type: module`, an `exports` entry per module, `dependencies` and `devDependencies` both empty. The `check` script is generated from the exports map (`node --check` per module), so a new module joins the syntax gate by declaring itself. The manifest grew from 9 to 14 entries as the split added modules; the generation is why that cost nothing.
3. Repoint the four upstream importers (`lib/cli.mjs`, `lib/workflowlib.mjs`,
   `router/server.js`, `router/swarm.mjs`) at the package specifier, and make
   `copyRuntime` derive its file list from the package's exports rather than a
   hand-written list.
   **Done 2026-10-05 (engine `e45bdde`)** — eight import sites read as `workflow-plane/<module>`; `grep -rn "\.\./lib/workflow\|\./workflow/" lib router bin` returns nothing outside the package. `copyRuntime` iterates `manifest.exports` and throws if a declared file is not on disk, so a missing module is an apply-time error rather than a missing module in a running router.
4. Repoint the kit's two importers (`lib/cli.mjs`, `router/server.js`), resolve the
   package as a `file:` dependency, delete the kit's tracked copy of the plane, and
   write `tools/check-plane.mjs` — which resolves the kit's dependency and diffs every
   module against the engine checkout. Prove it works by breaking it on purpose.
   **Done 2026-10-05 (kit `50b43d1`)** — `node_modules/workflow-plane -> ../../agnostic-router-kit/lib/workflow`, the tracked copy deleted, and `check-plane.mjs` (the kit's `check:port`) asserting the resolution, the absence of a second copy, and the installed runtime beside the router. It was broken on purpose once: a whitespace edit in the engine checkout made it fail by name, and reverting restored green.

### Phase B — the engine split

Ascending order of risk, so no single step is large and each is reversible.

5. Extract `coerce.mjs` — result coercion and JSON extraction. Pure functions, no
   plane-internal imports, already covered by a 16-case unit check.
   **Done 2026-10-05 (engine `873c14a`)** — three pure functions, no imports at all, and the unit check re-pointed at `coerce.mjs`. It grew from 16 to 29 cases: the original 16 asserted behavior as written, and the re-pointed version added the cases the extraction made reachable — shape-filling, null-filling and JSON recovery each became a first-class assertion rather than an incident of another function's test.
6. Extract `transport.mjs` — the OpenAI-compatible call and stream consumption, plus
   the idle timeout. The plane's only external protocol.
   **Done 2026-10-05 (engine `41004bc`)** — `chatCompletion` and `consumeStream` with `ASK_IDLE_TIMEOUT_MS`, exercised by a stubbed `globalThis.fetch` in 9 offline cases (stream assembly, the tools-degradation path, 429/5xx retries, the idle abort). `WorkflowRunError` was seeded into `runstate.mjs` at this step so transport could throw the run's own error type without importing the engine, which would have been a cycle the package could not express.
7. Extract `gitworld.mjs` — the four git wrappers and the `git()` helper behind them.
   The plane's only subprocess boundary outside the tool registry.
   **Done 2026-10-05 (engine `a760878`)** — the module's only import is `node:child_process`; 8 cases run against real throwaway repositories (buckets, diffs, logs, and the failure paths including argv-shaped refusals).
8. Extract `runstate.mjs` — the run's error type, run-directory allocation, artifact
   storage. Two things travel with the move because they are this module's behavior
   rather than the engine's: the id is second-granular and `freeRunDir` appends `-2`
   on collision, so two runs started in the same second each keep a journal (the bug
   item 11 fixed — a shared directory let the second run erase the first's durable
   record), and the collision case is asserted as part of this step.
   **Done 2026-10-05 (engine `02a06a8`)** — 10 offline cases, including the collision case asserted the way the engine actually drives it: allocate a directory, then write the journal into it, because allocation alone reserves nothing — a directory counts as taken once it holds `run.jsonl`.
9. Extract `context.mjs` — budget resolution, token accounting, context compaction.
   Last, because `askLoop` holds two invariants across it (the brief's message index is
   captured at loop entry, and compaction runs before the round check).
   **Done 2026-10-05 (engine `7aa1415`)** — 313 lines, 11 offline cases. The crown case is the first invariant stated as a test: a history holding the system message, the brief, two assistant rounds and a later re-ask nudge, with the brief's index captured as the loop entry recorded it, and the assertions that the brief survives verbatim, the nudge is summarized away, the summarizer is asked at temperature 0 with no tools, the compaction meters its own ask, and the triggered size is the larger of the report and the measure.

### Phase C — close-out

10. Run the full model-calling regression set (grants both modes, services all three
    launches, edit, delegate both modes, escalation both variants, and
    `runtime-surface-probe` through the kit's *resolved package* rather than a local
    copy); `npm run kit -- doctor` green in both editions; `~/.zcode/router/config.json`
    still at sha256 `d32a694c…`, recorded before Phase A and again here; `npm run
    check:port` green from the kit; both contract docs updated to describe the package
    boundary instead of the copy.
    **Done 2026-10-05 (engine close-out `060d171`; the kit's close-out is the commit carrying this plan)** — eleven model-calling runs, every one through `node <kit>/bin/zcode-router-kit.mjs workflows run <engine workflows/*.ts>`, so the plane each run loaded was the one the kit resolves (`node_modules/workflow-plane → the engine checkout`, printing exactly `KIT_WORKFLOW_RUNS, answerEscalation, fmtTokens, runWorkflow`). In a scratch git workspace with a package manifest: `grants-probe` 3 fired / 2 refused by default and 4 / 1 with `--grant package` (the install fires); `services-probe` 9/9 on all three launches — no grants, `--grant package,net-fetch --allow-domain example.com`, and `--grant net-fetch` with no allowlist (fail closed); `edit-probe` applied the unique edit and refused the zero-match and ambiguous ones; `delegate-probe` spawned a real sub-agent whose answer returned intact (the refusal path refused and named the capability); `escalation-probe` returned the operator's answer verbatim from `--answers` and the no-owner clause without it; `runtime-surface-probe` ran all four phases with the artifact published. Two `grants-probe` runs launched in the same second produced `…-grants-probe` and `…-grants-probe-2`, both journals intact — the collision path proved live, not only in the unit check. Doctors: the kit green, the engine edition at its pre-existing 13. Config sha `d32a694c…` re-recorded here. `npm run check:port` green. Both editions' `docs/features/workflow-runtime.md`, `TECHNICAL-DOCUMENTATION.md` and the kit's `FUNCTIONAL-SPECIFICATIONS.md` control-plane paragraph now describe the package boundary and the module map instead of the copy.

Steps 2–9 are each one commit and each ends with three checks: the step-1 baseline
equal, both editions' `kit doctor` green, and the config sha unchanged. The guards are
not a final step that can be skipped — they are the per-commit definition of a correct
step. The only check allowed to be written late is `tools/check-plane.mjs` in step 4.

## Acceptance criteria

Order is identity: criteria are C0, C1, … in checkbox order. Never reorder after gating.

- [x] `lib/workflow/` is an installable package with its own `package.json` declaring name, version, `type: module` and an exports entry per module, and zero runtime dependencies. *(C0 — 2026-10-05: `workflow-plane@1.0.0`, `type: module`, 14 exports entries one per module file, `dependencies` and `devDependencies` both `{}`; all 14 specifiers import from outside the package, and each resolved module's export list was printed at close-out)*
- [x] No file outside the package reads a file inside it by relative path — the four upstream importers and the two kit importers all resolve the plane by specifier. *(C1 — 2026-10-05: `grep -rn "\.\./lib/workflow\|\./workflow/" lib router bin` returns nothing outside `lib/workflow/`; the eight import sites read as `workflow-plane/<module>` — `lib/workflowlib.mjs`, `lib/cli.mjs` ×3 (two static, one dynamic), `router/swarm.mjs`, `router/server.js` ×2)*
- [x] The kit resolves the same package as a dependency, so a drifted copy fails resolution instead of shipping silently, and `kit apply` still installs the runtime beside the router. *(C2 — 2026-10-05: `npm ls workflow-plane` in the kit resolves to `./../agnostic-router-kit/lib/workflow`, and the kit's resolved `engine.mjs` prints exactly `KIT_WORKFLOW_RUNS, answerEscalation, fmtTokens, runWorkflow` and real-paths to the engine checkout. `kit apply` ships the runtime: the install beside the router carries all 14 modules, each written at its own step's apply (checkpoint/events/graph/harness/meta/schema/services/tools at step 4's, coerce at step 5's, transport at step 6's, gitworld at step 7's, runstate at step 8's, context and engine at step 9's). A literal `kit apply --dry-run` naming the copy step is not observable while the install is current — the step is idempotent and stays silent — so the evidence is the sequence of shipped files plus `copyRuntime`'s exports-derived list)*
- [x] `npm run kit -- doctor` is green in both editions and `~/.zcode/router/config.json` is byte-identical (sha256 `d32a694c…`) from before the package to after the split. *(C3 — 2026-10-05: the kit prints "✓ doctor: everything checks out"; the engine edition prints the same 13 problems it carried before step 2 and is expected to — it is the development checkout with no `.env`, no provider keys and no installed service, so the guard is that the count does not move. `shasum -a 256 ~/.zcode/router/config.json` is `d32a694cde0b25ce2ff91d91b7274c7766dceb1d340d6f9a0f9581b277672f07`, recorded before step 2, after step 9, and again at close-out)*
- [x] The zero-agent-call probes (checkpoint, context, commands) produce the same journal event sequence before and after every step, compared with timestamps and durations stripped. *(C4 — 2026-10-05: `tools/compare-journals.py` exits 0 against the step-1 baseline after each of steps 2–9 and again at close-out — "identical — 50 events / 99 / 101", with `t` and `ms` stripped)*
- [x] `engine.mjs`'s coercion and JSON-extraction functions live in `coerce.mjs` as pure functions with no plane-internal imports, and the existing unit check runs against that module. *(C5 — 2026-10-05: `coerce.mjs` exports `coerceResult, coerceToSchema, extractJson` and imports nothing at all; the unit check now runs against it and reports 29 cases. It was 16 when the plan was written: the re-pointed check kept the original 16 assertions and added the ones the extraction made reachable, so the number grew rather than the claim)*
- [x] The OpenAI-compatible call, stream consumption and idle timeout live in `transport.mjs` with no reference to the agent loop, and are exercised by the offline fetch stub rather than a live provider. *(C6 — 2026-10-05: `grep -n "askLoop\|makeAgent" lib/workflow/transport.mjs` is empty; the module exports `ASK_IDLE_TIMEOUT_MS, chatCompletion, consumeStream`; 9 offline cases cover stream assembly, the tools-degradation path, 429/5xx retries and the idle abort through a stubbed `globalThis.fetch`)*
- [x] The four git wrappers and their helper live behind one module boundary that imports nothing from the plane and nothing from `engine.mjs`. *(C7 — 2026-10-05: `lib/workflow/gitworld.mjs` exports `gitChangedFiles, gitDiff, gitLog, gitStatus` and its only import is `node:child_process`; 8 cases run against real throwaway repositories)*
- [x] Run-directory allocation, artifact storage and the run's error type live in one module, and two runs started in the same second both keep their journal. *(C8 — 2026-10-05: `WorkflowRunError`, `freeRunDir`, `slug`, `makeArtifacts` and `KIT_WORKFLOW_RUNS` all resolve to `runstate.mjs`; 10 offline cases assert the collision sequence the engine actually drives — allocate, then write the journal, because a directory counts as taken once it holds one. The close-out regression produced the live proof: two `grants-probe` runs launched in the same second landed as `…-grants-probe` and `…-grants-probe-2`, both journals intact)*
- [x] Budget resolution, token accounting and context compaction live in one policy module, and `budgets-probe` and `tokens-probe` pass unchanged by the move. *(C9 — 2026-10-05: `resolveBudget`, `SHAPE_BUDGETS`, `compactContext`, `ensureRoom` and `CONTEXT_COMPACT_TOKENS` all resolve to `context.mjs`; both probes green after step 9 with the same journal shape, the only differences being the provider's own token counts and the summarizer's prose — proved nondeterministic rather than asserted, by running the pre-move plane against itself and watching it differ from its own previous run)*
- [x] `engine.mjs` retains only the orchestration surface — `runWorkflow`, the agent factory, the ask loop, `answerEscalation` — and the plane's public exports are unchanged, so no consumer needed a behavior change. *(C10 — 2026-10-05: `engine.mjs` is 829 lines down from 1471 and its only exports are the two re-exports (`KIT_WORKFLOW_RUNS`, `fmtTokens`, kept so consumers need no diff), `runWorkflow` and `answerEscalation`; the remaining symbols are `SUBAGENT_SYSTEM`, `makeAgent`, `askLoop`, `capReached` and `serializeToolResult`. The engine's consumer-facing surface stayed at exactly these four names through every step, which is the guarantee the criterion's literal wording ("the union of every module's exports matches the pre-split export list exactly") cannot express: package-internal cross-module imports must be exported, so the union is necessarily larger. The working form of the criterion is that the consumer-facing list is four names and both editions' CLIs diffed by import lines only)*
- [x] A check script exists that fails when the kit's resolved plane and the engine edition's package differ, and it was green at every step. *(C11 — 2026-10-05: `npm run check:port` green from the kit after steps 3–9 and again at close-out; broken on purpose once, at step 4, by a whitespace edit in the engine checkout, and it failed by name before the edit was reverted)*

## Files to be touched

**Upstream (`agnostic-router-kit`, owns the package):**
- `lib/workflow/package.json` — new; the package manifest
- `lib/workflow/index.mjs` — new; the public surface in one place (optional but recommended — see Notes)
- `lib/workflow/engine.mjs` — loses four concerns, keeps orchestration
- `lib/workflow/coerce.mjs` — new
- `lib/workflow/transport.mjs` — new
- `lib/workflow/gitworld.mjs` — new
- `lib/workflow/runstate.mjs` — new
- `lib/workflow/context.mjs` — new
- `lib/cli.mjs`, `lib/workflowlib.mjs`, `router/server.js`, `router/swarm.mjs` — import by specifier; `copyRuntime` follows the package layout
- `docs/features/workflow-runtime.md` — the package boundary and module map
- `TECHNICAL-DOCUMENTATION.md` — the module list

**Kit (`zcode-router-kit`, consumes the package):**
- `package.json` — the dependency
- `lib/cli.mjs`, `router/server.js` — import by specifier
- `lib/workflow/` — deleted from the repo (tracked copy); still installed beside the router by `copyRuntime`
- `docs/features/workflow-runtime.md`, `TECHNICAL-DOCUMENTATION.md` — same edits as upstream
- `tools/check-plane.mjs` — new; the divergence check

## Out of scope

- **A third repository.** The plane and the router co-evolve (items 6–13 changed `engine.mjs`, `tools.mjs` and `router/swarm.mjs` in single commits); a repo split turns each of those into a cross-repo PR pair. Recorded as rejected in Notes.
- **Splitting `runWorkflow`'s ~470-line body further.** It is the orchestration entry point; cutting it into smaller functions is cosmetics with real regression risk and is deferred until something demands it.
- **Any behavior change.** This is code motion and a packaging boundary. No new export, no changed signature, no altered journal event.
- **The router's own streaming implementation.** `router/server.js` speaks the same SSE protocol independently; unifying them is a separate question this plan does not raise.
- **The `.dwf.ts` library and the swarm's own logic** beyond their import statements.
- **Shipping the runtime.** The installed copy at `~/.zcode/lib/workflow/` is already stale; refreshing it remains the operator's call, now via `kit apply` against a version-pinned package.

## Verification

One block per criterion; all commands run from the engine edition unless noted.

**C0–C2: the package resolves and nothing reads it by relative path**
```bash
node -e "console.log(Object.keys(require('./lib/workflow/package.json').exports))"
grep -rn "\.\./lib/workflow\|\./workflow/" --include="*.mjs" --include="*.js" lib router bin | grep -v "^lib/workflow/"
```
Expected: exports list one entry per module; no importer outside the package reaches into it by path. From the kit: `npm ls workflow-plane` resolves to the engine checkout.

**C3: the guards that gated every prior phase**
```bash
cd zcode-router-kit && npm run kit -- doctor
shasum -a 256 ~/.zcode/router/config.json   # d32a694cde0b25ce…
```

**C4: the deterministic-journal invariant**
```bash
# capture before each step, compare after
for p in checkpoint context commands; do
  node bin/agnostic-router-kit.mjs workflows run $p-probe --workdir /tmp/plane-check >/dev/null 2>&1
done
python3 tools/compare-journals.py before/ after/   # t and ms stripped
```
Expected: identical event kind and field sequence. These three probes make zero agent calls, so their journals are deterministic — a model-calling probe is not a gate, it is a regression signal.

**C5–C9: each extracted module stands alone**
```bash
node --check lib/workflow/*.mjs
node tools/unit-coerce.mjs          # the 16-case check, now against coerce.mjs
node bin/agnostic-router-kit.mjs workflows run budgets-probe
node bin/agnostic-router-kit.mjs workflows run tokens-probe
node -e "import('./lib/workflow/transport.mjs').then(m=>console.log(typeof m.chatCompletion))"
```
Expected: syntax green everywhere; the coercion unit check passes against the new module path; both probes pass with the same journal shape as before the move.

**C11: the divergence check is real**
```bash
cd zcode-router-kit && npm run check:port
# then break it on purpose: touch one plane file's whitespace in the engine
# checkout and re-run — it must fail
```

**Final: the model-calling regression set**
`grants-probe` (both modes), `services-probe` (all three launches), `edit-probe`,
`delegate-probe` (both modes), `escalation-probe` (both variants), `runtime-surface-probe`
through the kit's resolved package. Run once at the end, not per step.

## Linked artifacts

- `docs/features/workflow-runtime.md` — the package boundary, the module map, and where a consumer's import comes from
- `TECHNICAL-DOCUMENTATION.md` — the `lib/workflow/` bullet (both editions)
- `FUNCTIONAL-SPECIFICATIONS.md` — the control-plane paragraph's "see" link

Step 2 also creates `lib/workflow/CHANGELOG.md` and step 4 `zcode-router-kit/tools/check-plane.mjs`; both are new files listed under Files to be touched rather than updates to an existing doc.

## Risks

- **A `file:` dependency breaks on a fresh clone.** It is machine-local, so a second checkout of the kit without a sibling engine checkout fails to install. Mitigation: the failure is loud and names the path; the alternative (a submodule) is recorded in Notes and is the switch to make if a second machine appears.
- **Compaction is the one move with hidden coupling.** Item 13's subtlety is that the brief's message index is captured at `askLoop` entry, before the json-nudge message, so compaction never mistakes it for agent history — and `ensureRoom` runs before the round check, which item 14 made load-bearing on both budget axes. Moving that code without moving those two invariants is how the split breaks, which is why it is step 8 and last.
- **`copyRuntime` copies a file list, not a package.** If the package layout changes, the shipped copy changes with it, and the installed server imports from `<routerDir>/../lib/workflow` — so a layout change is a live-service change. Mitigation: the file list is derived from the package's exports, not written twice.
- **The probes are not a complete net.** Three of them are deterministic; the rest make model calls and can pass or fail for provider reasons. C4 carries the refactor's correctness; the model-calling set is the regression signal.
- **The stale installed copy becomes visible.** Today the live service runs a pre-plane engine and nothing says so. A version-pinned package makes that a mismatch an operator can see, which means someone has to act on it.

## Notes

- [2026-10-05-harnessed-agent-control-plane.md](2026-10-05-harnessed-agent-control-plane.md) — completed; this plan is the maintainability consequence of its Edition-divergence risk, now realized.

- **Third repo, rejected.** Co-evolution is the reason: the plane's items 6–13 each changed the engine and the swarm in one commit. Polyrepo turns "one logical change" into two PRs and invites the fork it exists to prevent. Revisit only if a second machine or a second person appears.
- **Submodule, rejected for now.** It is the technically correct single-source-of-truth answer and carries a workflow cost this project has not needed. The `file:` dependency gets 90% of the benefit at 10% of the friction, and the check script makes any breakage loud.
- **In-place split without a package, rejected.** It leaves two copies of a fourteen-file module set, which is worse than two copies of nine.
- **A recommended `index.mjs`.** The plane has nine modules and consumers import four of them by deep path. A single entry that re-exports the public surface makes the split invisible to consumers and gives the check script something stable to assert against. It is a recommendation, not a criterion, because the deep imports work either way.
- **Package name is provisional.** `workflow-plane` until it is published anywhere; renaming a package nobody depends on is free.
- **What is NOT being split out of engine.mjs:** `runWorkflow`, `makeAgent`, `askLoop`/`capReached`, `answerEscalation`. Those are the orchestration, and the file is worth reading as one continuous story once the other four concerns are gone.

## Close-out notes (2026-10-05)

- **No `index.mjs`.** It was a recommendation, not a criterion, and the split made the case against it: `engine.mjs` re-exports the two names consumers want from elsewhere (`KIT_WORKFLOW_RUNS` from `runstate.mjs`, `fmtTokens` from `context.mjs`), which keeps the engine's consumer-facing surface at exactly four names and both editions' CLIs untouched. An index that re-exported the union would have grown a surface nobody asked for.
- **The engine's public export list is four names, and that is the criterion.** C10's literal wording ("the union of every module's exports matches the pre-split export list exactly") is unsatisfiable by construction: package-internal cross-module imports *must* be exported for the specifier imports to resolve, so the union is necessarily larger than the pre-split list. The guarantee that matters is the consumer-facing one — `KIT_WORKFLOW_RUNS, answerEscalation, fmtTokens, runWorkflow`, unchanged at every step — recorded here as the working form of the criterion.
- **Model-calling probes can only be compared by journal *shape*, never by content.** Beyond the four kinds of per-run noise the split already knew about (`t`, `durationMs`, a random command handle, the OS pid), a run's provider numbers differ run to run and a summarizer's prose differs every time it is asked. This was proved rather than assumed: running the *pre-move* plane against itself produced different token counts and different summaries, while the structural comparison (19/19 on budgets-probe, 10/10 on tokens-probe with one differing field — the summarizer's own text) held. C4 carries the refactor's correctness; the model-calling set is the regression signal, exactly as the Risks section said.
- **`emit_compact` is dead code, and stayed.** It has been unreachable since the compaction work landed (commit `e350061`); moving it with the compaction concern rather than deleting it keeps this plan pure code motion. Deleting it is a one-line change someone can make deliberately.
- **A latent `briefIdx` issue, found but not fixed.** After the first compaction shifts `messages`, `acct.briefIdx` is not re-captured, so a second compaction in the same ask can take the brief by a stale index and drop it. It predates this plan and is invisible at the current compaction frequency; recording it here is the point of the invariant the move was ordered to protect.
- **The regression set's workspace is part of its evidence.** A first pass ran the probes into an empty scratch directory and reported `grants-probe` 2 fired / 3 refused and one `services-probe` UNEXPECTED — both workdir artifacts (no `package.json` to read, none to restore), not plane behavior. Re-run in a scratch git repository with a manifest, the same probes report 3 / 2 and 9/9 across all three launches. The workdir is an input to the probe, so it belongs in the report.
- **`kit apply --dry-run` names no copy step while the install is current**, because `copyRuntime`'s step lines are idempotent by design. The shipping path is proved instead by the install's own history: each module appeared beside the router at its own step's apply (the 14 modules at step 4's, then coerce, transport, gitworld, runstate, context and engine in turn), and by the file list being derived from the package's exports.

[2026-10-05-harnessed-agent-control-plane.md](2026-10-05-harnessed-agent-control-plane.md) is completed; this plan was the maintainability consequence of its Edition-divergence risk, now realized — and closed.
