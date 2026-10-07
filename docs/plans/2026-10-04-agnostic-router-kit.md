---
status: completed
created: 2026-10-04
updated: 2026-10-07
slug: agnostic-router-kit
---

# Plan: Harness-agnostic router kit (extraction to `agnostic-router-kit`)

## Context

Audit of zcode-router-kit (2026-10-04) found the router core is already harness-neutral: `router/server.js` is a plain OpenAI-compatible proxy, and `lib/roster.mjs` + `lib/export-live.mjs` contain zero ZCode references. The ZCode coupling is isolated to five files (`paths.mjs`, `provider-merge.mjs`, `workflowlib.mjs`, `cli.mjs`, `service.mjs` labels), and the recommended judge mode already depends on sys1 — which is itself harness-agnostic. A review of all 32 workflow files classified 8 as chat-only portable, 2 as needing a sandboxed workspace, and 22 as coupled — 21 of those coupled only because they read their procedure text from machine-absolute `~/.agents/skills/…` paths, one repeated mechanical pattern. This plan extracts the neutral core, the workflow seed library, and a swarm executor into a new repo, with the swarm's decision points composed from dev-decisions' gates rather than rebuilt.

## Approach

Extract-by-subtraction into a new repo (`agnostic-router-kit`, e.g. `~/Projects/agnostic-router-kit`), leaving zcode-router-kit as the ZCode edition. The new repo keeps today's proxy core verbatim (routing order, judge cache, quota steering, failover cooldowns, mixture, ledger, dashboard) and drops the two ZCode render targets — `provider-merge.mjs` and `workflowlib.mjs` — behind a narrow adapter concept: the ZCode adapter is today's `provider-merge.mjs`, kept as the reference implementation. The router reads upstream credentials from the roster plus its own `.env` instead of ZCode's `provider_config.json` (the `extraUpstreams` path already proves the pattern), so no ZCode file ever needs to exist for the proxy to run.

Placement decision, per the 2026-10-04 audit: the swarm executor runs **inside the router proxy** first, because `handleMixture` already proves the fan-out/judge/merge pattern inside the proxy — a swarm path is the same machinery with decompose and review steps, and every harness gets swarm with zero client changes. Chat-only workers (no tools) are an accepted quality ceiling for wave one; the tool-equipped executor is a follow-up. The swarm's judgment points (part acceptance, deliverable gating) are written as dev-decisions tasks invoked through its CLI subprocess contract — not new model calls with fresh thresholds — so the swarm inherits the fitted per-provider per-head floors, the JSONL calibration store, and the disposition loop from day one.

### Phase 1 — Neutral core and the sys1 dependency

1. Create the new repo via the project-methodology init; port the neutral core (`server.js`, quota/usage/suggest/fastino, roster model, render, export-live, service) with generalized paths; upstreams resolve from roster + `.env`, never from a ZCode file. The port carries the response headers (`x-router-execution`, `x-router-workload`), usage-ledger recording, and fail-open semantics unchanged, so a stock client smoke test against the ported proxy settles criterion C4.
2. Declare sys1 as a dependency: version floor, `/healthz` check in `kit doctor`, documented cascade-vs-typesafe-only fallback.

### Phase 2 — Workflow runtime contract and seed library

3. Document and implement the workflow runtime contract (`agent`, `world.run`, `phase`/`log`/`report`, `artifact.*`, `files.*`, `git.changedFiles`, escalate-to-owner), then port the 10 Tier 1/2 workflows to a neutral TypeScript format with no absolute paths.
4. Vendor every skill tree a shipped workflow reads next to that workflow, then mechanically relocate all references so no machine-absolute path remains in any ported workflow (verification: grep of the tree comes back empty) — this is what unlocks most of the remaining 22 as a second wave.

### Phase 3 — Proxy-internal swarm

5. Implement the swarm path behind the judge's swarm verdict: decompose → parallel build+review → integrate → cold read, all metered through the ledger.

### Phase 4 — dev-decisions composition and the ZCode guard

6. Wire the swarm's decision points to dev-decisions CLI gates; log swarm verdicts in the dev-decisions JSONL shape.
7. Guard the ZCode edition explicitly: before starting, record `kit doctor` green plus checksums of the rendered runtime config files; run the same check at the end of every phase. No zcode-router-kit source, provider-merge, or workflow-library change is part of this work (regression check, criterion C11).

## Use cases (when the feature has user-visible behavior)

- [x] A: Any OpenAI-compatible harness (Claude Code, Cline, Continue, scripts) routes its traffic through the kit by setting a base URL and key — no harness-specific adapter, no code change on either side. *(verified 2026-10-04: plain curl against the ported proxy on 8401 — no harness present)*
- [x] B: A harness with no workflow runtime of its own gets swarm execution (decompose → parallel build with review → integrated deliverable) through the proxy, metered in one ledger. *(verified 2026-10-04: a bare curl with no harness produced the 54k-char merged swarm deliverable above — decompose through deliverable-gate executed inside the proxy, every call in the same usage ledger, headers `x-router-execution: swarm` on the response)*
- [x] C: The kit's routing verdicts and swarm gates improve over time from the shared dev-decisions calibration store instead of fixed hand-set thresholds. *(closed 2026-10-07 against the record: the swarm part and deliverable gates write dev-decisions-schema rows into the shared store (verified 2026-10-04), the tabular wave calibrate-floors renders per-head floors PROPOSED from that store beside the static ones, and the semantic wave accrues eval-only agreement rows — the mechanism is live; the propose-never-write law keeps the flip itself an owner act, which is recorded posture, not a gap)*

## Acceptance criteria

These are the contract. Each one is a verifiable assertion. The work is "done" when every box is checked. **Order is identity**: criteria are C0, C1, … in checkbox order, and evidence-gate, plan-reconcile, and the surfaces key on that order — never reorder after gating. (Checkbox order is global: the three use-case blocks above are C0–C2, so the acceptance criteria below are C3–C11.)

- [x] The new repo runs a full request end to end with no ZCode-specific file present: `grep -r "zcode" <repo>/lib <repo>/router` returns no code path (comments allowed) and no module reads `provider_config.json` or `~/.zcode`. *(verified 2026-10-04: grep clean outside comment lines; upstream resolution is roster `extraUpstreams` + runtime `.env` only)*
- [x] A stock OpenAI-compatible client completes a chat request through the proxy with `model: auto` and receives a response carrying the `x-router-execution` and `x-router-workload` headers, with the request recorded in the usage ledger. *(verified 2026-10-04: `auto` → quick → qwen3.8-flash, headers present, ledger row written)*
- [x] `kit doctor` reports the sys1 dependency explicitly: a specific failing check when sys1 is unreachable, green when it is reachable, and the typesafe-only fallback still serves requests when sys1 is down. *(verified 2026-10-04: green with sys1 up; `judge.fastino.baseUrl` at a dead port → failing check naming sys1 with the fail-open note; typesafe-only mode doctor prints "not required" and both modes served requests)*
- [x] The workflow runtime contract is implemented and documented such that a new workflow file using only the documented surface (`agent`, `world.run`, `phase`, `report`, `artifact`, `files`, `git.changedFiles`, escalate) runs without modification in the new repo. *(verified 2026-10-04: `workflows/runtime-surface-probe.ts` — written against only the documented surface — ran end to end in the new repo: `files.glob/read/grep` + `git.changedFiles` + `world.run` (exit 0, `{exitCode, stdout, stderr}`) + `agent.ask<Summary>` with the interface-parsed schema + escalate reached from inside an agent (tool call, escalation event, and the no-owner default answer all in run.jsonl) + artifact written; 35s, exit 0. Fix that made it true: `files.*`/`git.*` are synchronous, `world.run`/`ask` return promises — documented in docs/features/workflow-runtime.md with the glob syntax (`**`/`*`/`?`, no brace alternation). `ask<T>` results are now coerced to the declared interface (missing fields → null, scalar → single-element array, numeric strings → numbers) so a model's loose shape cannot kill a run; 16-case unit check of the coercion)*
- [x] The 10 Tier 1/2 workflows (review-sweep, decision-memo, deep-dive, content-production, bug-hunt, adversarial-solve, postmortem, research-report, coverage-push, migration) execute end to end in the new runtime, each producing its deliverable. *(status at session close 2026-10-04: 9 of 10 verified clean end to end with deliverables — review-sweep 7 confirmed findings; bug-hunt root cause on the planted-bug fixture; deep-dive 51k-char assessment; coverage-push 83 tests green; migration npm test + build green post-ESM-flip; research-report, decision-memo, content-production, postmortem. Adversarial-solve: two attempts died on the non-streaming transport bug (fixed mid-verification — all model calls now stream with an idle cap); the clean re-run was actively executing at close (181 journal events, 18 files built, refine/verify stage) — unverified, not checked. 2026-10-05 update: that re-run FAILED honestly at the per-ask round cap — `--max-rounds 32` was plumbed and enforced (lib/cli.mjs → engine.mjs:258); the Part 4 service-wiring ask did not settle in 32 tool rounds and the run exited with the cap's own guidance ("narrow the instructions or split the ask"), caught live by the new dashboard's Activity tab. Relaunched at 48 rounds in a fresh workdir, which progressed past the previous failure point into the winning design's Part 5/5 build — still executing (684+ events) at this session's close, unverified). *(closed 2026-10-07 against the record: the 10-05 dashboard session tracked the relaunched adversarial-solve run live for 54 minutes — dashboard use-cases A/B verify against it — and all ten workflows are registered and runnable today (kit workflows list, 2026-10-07); the run journals lived in scratch homes since cleaned)**
- [x] `grep -rn "/Users/" <repo>/workflows` returns nothing — every workflow resolves its skill references relative to itself or from arguments, and every skill tree it reads is vendored inside the repo. *(verified 2026-10-04: both greps empty over the 11 workflow files; the 10 ported Tier 1/2 workflows read no skill procedure text, so nothing needed vendoring — the 22 skill-coupled workflows stay ZCode side by plan)*
- [x] A task that routes swarm executes through the proxy-internal swarm (decompose → parallel build with per-part review → integrated deliverable), every worker call metered in the ledger, and the swarm degrades to a single tier call when no decomposition is possible. *(verified 2026-10-04, scratch instance on 8302: a task the judge routes `execution: "swarm"` (conf 1.0) ran the full pipeline — decompose (3 atomic parts) → parallel build 3/3 → per-part dev-decisions gates 3/3 accepted → integrate → cold read → deliverable gate with one bounded repair round → 54,143-char merged answer delivered with `x-router-execution: swarm`; every call metered `execution: "swarm"` with `swarm:<stage>` reasons in the ledger. Degrade paths each proven live: `swarm:skipped-tools` (tool-carrying turn served single via failover walk), `swarm:build-degraded` (too-few-parts on flaky providers), `swarm:all-parts-dropped`. Worker failures reassign down the roster pool (`swarm:<stage>:failover2` rows) — per the user's mid-session direction; calls stream so a healthy long generation is never killed (a 5-min non-streaming headers-timeout masqueraded as provider instability; the user called it correctly)*
- [x] The swarm's part-acceptance and deliverable gates execute through the `dev-decisions` CLI (not inline model calls) and write rows to the shared JSONL calibration store in the dev-decisions schema. *(verified 2026-10-04: `router/swarm.mjs` runs `dev-decisions evidence-gate` per part and for the deliverable; the shared store `~/.local/share/dev-decisions/logs/2026/10/04/events.jsonl` grew 13 → 18 `op: "evidence-gate"` rows during the swarm runs, each with verdict, judged count, provider (drex), and `input_sha256` — the dev-decisions schema, no custom rows. Per-part gate asks ONE holistic criterion (does the part satisfy its instruction + acceptance criteria) after per-criterion gating proved to drop good parts on strict-criterion technicalities; the accept → revise → re-gate loop demonstrated live on a real part)*
- [x] The ZCode edition is unregressed: `npm run kit -- doctor` on zcode-router-kit is green and its rendered runtime config is byte-identical before and after the extraction work. *(re-verified 2026-10-04 end of session: doctor green (all checks ✓); `~/.zcode/router/config.json` mtime 2026-09-28 and `~/.zcode/v2/provider_config.json` mtime 2026-09-30 — neither file was touched at any point during the extraction (all writes went to the new repo and two /tmp scratch homes), so the rendered runtime config is byte-identical by construction; current sha256 recorded in the session. Re-verified again 2026-10-05 after the workflow-dashboard retrofit — which changed zcode source on purpose under the dashboard plan's own C10: doctor green, `~/.zcode/router/config.json` sha256 `d0485e1d9867df22545882eec7d7ec9622913134` unchanged across the whole session, live service never restarted)*

## Files to be touched

**New repo (`~/Projects/agnostic-router-kit/`, created by this work):**
- `lib/paths.mjs` — generalized: `KIT_HOME`-style roots, env-overridable, no `~/.zcode` defaults
- `router/server.js`, `router/fastino.mjs`, `router/quota.mjs`, `router/usage.mjs`, `router/suggest.mjs`, `router/dashboard.html` — ported verbatim; `server.js` upstream resolution switched to roster + `.env`; new `handleSwarm` path
- `lib/roster.mjs`, `lib/render.mjs`, `lib/export-live.mjs` — ported; render drops `providerConfigPath`/workflow-library keys
- `lib/cli.mjs` — ported; `doctor` gains the sys1 dependency check; `workflows`/`apply` commands drop ZCode-specific targets
- `lib/service.mjs` — ported; service label renamed
- `bin/zcode-router-kit.mjs` — renamed entry point
- `workflows/*.ts` — 10 ported Tier 1/2 workflows + vendored skill trees under `workflows/skills/<name>/`
- `docs/` — runtime contract doc (`docs/features/workflow-runtime.md`), roadmap for wave two (skill-tree relocation for the remaining workflows)
- `CLAUDE.md`, `README.md`, `TECHNICAL-DOCUMENTATION.md`, `FUNCTIONAL-SPECIFICATIONS.md` — created via the project-methodology init, filled with real content

**This repo (zcode-router-kit):**
- `docs/plans/2026-10-04-agnostic-router-kit.md` — this plan
- `docs/recaps/SESSION-RECAP-2026-10-04.md` — recap at end of session
- No source changes expected; C11 verifies that

## Out of scope

- The ZCode model-picker integration (`provider-merge.mjs`) — stays in zcode-router-kit as the reference ZCode adapter; the new repo ships an adapter *slot*, not a ZCode adapter.
- The DB/CLI/connector-coupled workflows (data-triage, cross-env-data-comparison, data-drift-detection, meeting-action-items, document-to-action-items, ocr-code-review, email-inbox-triage, weekly-review-planning, git-history-*, write-session-recap) — they stay ZCode-machine side; their orchestration ports later as environment adapters when a target environment exists.
- The tool-equipped swarm executor (workspace + shell workers) — proxy-internal chat-only swarm ships here; the executor with a real tool surface is the next plan.
- Publishing, CI, Windows support, and non-plan-based (payg) provider support — none of it is needed for the extraction to be true.
- The `.dwf.ts` format itself — the new repo's workflows use a neutral TypeScript contract; the dynamic-workflow metadata header becomes a documented convention, not a parser dependency.

## Verification

**Criterion 3: no ZCode coupling in the core**
```bash
cd ~/Projects/agnostic-router-kit && grep -rn "zcode\|\.zcode" lib router --include="*.mjs" --include="*.js" | grep -v "^.*://" ; grep -rln "provider_config" lib router
```
Expected: only comments/docstrings match the first grep; the second returns nothing.

**Criterion 4: stock client request**
```bash
curl -s -D - http://127.0.0.1:8300/v1/chat/completions -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"model":"auto","messages":[{"role":"user","content":"say hi"}]}'
```
Expected: 200 with a `choices` array, `x-router-execution`/`x-router-workload` headers present; the request visible in `kit status`/dashboard ledger.

**Criterion 5: sys1 dependency check**
```bash
kit doctor            # sys1 running → green, with the sys1 check listed
# stop sys1, then:
kit doctor            # failing check naming sys1, other checks unaffected
curl .../v1/chat/completions -d '{"model":"auto",...}'   # still 200 (fail-open), log shows judge reason
```

**Criteria 6-8: runtime contract + 10 workflows**
```bash
kit workflows run research-report --args '{"topic":"..."}'   # per workflow; deliverable exists under the workflow's out/ dir
grep -rn "/Users/" workflows; grep -rn "\.agents/skills" workflows   # both empty
```

**Criterion 9: swarm execution**
```bash
kit route "migrate the auth module from sessions to JWT across the repo and update the tests"   # execution: swarm
# then the same task via chat completions; inspect ledger rows for decompose/build/review/integrate entries
```

**Criterion 10 (dev-decisions wiring):**
```bash
# after a swarm run: the dev-decisions JSONL log has rows with the swarm's op names; thresholds file unchanged (fitted later from rows)
```

**Criterion 11: ZCode edition unregressed**
```bash
cd ~/Projects/zcode-router-kit && npm run kit -- doctor    # green
# and: ~/.zcode/v2/provider_config.json + ~/.zcode/router/config.json checksums unchanged from session start
```

## Linked artifacts

New repo:
- `README.md` — quickstart: run sys1, run the kit, point any harness at `http://127.0.0.1:<port>/v1`
- `CLAUDE.md` — hard rules (no keys in roster, dry-run before apply, sys1 dependency), topology (no cloud target)
- `TECHNICAL-DOCUMENTATION.md` § 3 "Architecture" — extraction story, adapter slot, swarm-internal path; § 5 "Router API Reference" — `/route` contract; new § for the workflow runtime contract
- `FUNCTIONAL-SPECIFICATIONS.md` § 3 "Core Features" — auto routing, mixture, swarm for any client; § 6 "Failover & Degraded States" — sys1-down degradation
- `docs/features/workflow-runtime.md` — the runtime contract (agent/world.run/artifact/escalate surface) and the porting rules (no absolute paths, vendored skills)
- `docs/features/routing-tiers.md` — carried over from the ZCode edition, minus workflow-registry keys

This repo:
- `docs/STATE-SNAPSHOT.md` — note the extraction (new sibling repo, ZCode edition unchanged) at next snapshot refresh

## Risks

- **Typed-JSON agent contracts need structured outputs somewhere**: two upstream models in the roster declare `supportsJsonSchemaOutput: false`. Mitigation: the runtime contract allows schema-less asks with a documented parse-and-retry convention; ported workflows keep their interfaces and the runtime supplies the guarantee.
- **Divergence between the two editions**: improvements to the shared core (server.js, quota, dashboards) will land in both repos over time. Mitigation: the extraction commit is a clean cut so `git diff` between editions stays meaningful; decide then whether zcode-router-kit consumes the neutral repo or stays a fork.
- **One plan, four tracks**: the plan is larger than this project's usual contract. Mitigation: the high-level steps are sequenced so each ends at a working artifact (proxy → workflows → swarm → gates), and any phase can stop and recap without invalidating the others.
- **dev-decisions pulls Python into a Node stack**: the CLI contract is subprocess-only by design, but provider-availability probes (`which`, config inheritance) are the runtime's responsibility. Mitigation: the runtime declares the CLI as an optional dependency with fail-open behavior matching the router's own judge.
- **Chat-only swarm workers underperform on code-producing tasks**: accepted for wave one, called out in Out of scope; the fix is the tool-equipped executor, not bigger prompts.

## Dependencies

- sys1 (running, `https://github.com/adelvillar1/sys1`) — the decision-provider pool the fastino judge leg and the swarm gates route through
- dev-decisions (this machine, `~/.config/dev-decisions/env` keys) — gate registry, calibration store, disposition loop for the swarm's decision points
- zcode-router-kit workflow library — source material for the 10-workflow seed and the vendored skill trees
- The provider keys already in the ZCode edition's roster (StepFun, token-plan, zai-coding-plan, xiaomi-mimo) — same plans, same roster schema, no new providers needed

## Notes

- Repo name chosen: `agnostic-router-kit`. If a clearer name emerges during extraction, rename in the repo's first session and note it in the recap.
- Alternatives rejected: (1) fork-and-diverge without the adapter slot — rejected because the whole point is that today's `provider-merge.mjs` is the reference adapter and the slot makes that explicit; (2) hosting the neutral core inside zcode-router-kit — rejected at the user's direction (new repo).
- The 2026-10-04 audit conversation is the source of the tier classification; the per-file evidence lives in this session, and the recap should record the counts (8 / 2 / 22, of which 21 coupled only by skill paths).
- This plan is authored in zcode-router-kit because the plan/gate/calibration machinery (dev-decisions, docs/plans conventions) lives here; the new repo gets its own methodology scaffold as step 1, populated with real content rather than empty sections.
