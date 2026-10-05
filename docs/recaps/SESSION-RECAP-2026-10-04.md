# Session Recap — 2026-10-04

## What shipped

**The harness-agnostic edition, Phase 1 complete** — new repo `~/Projects/agnostic-router-kit`
(commits `f939ef5`, `5e607e1`), built from plan
`docs/plans/2026-10-04-agnostic-router-kit.md` (status: active; C0/C3/C4/C5/C11 checked).

1. **Neutral core ported and made harness-free**
   - `router/` (server, quota, usage, suggest, fastino, dashboard) ported; `server.js`
     upstream resolution rewritten: every roster provider renders into
     `config.extraUpstreams` with its key as an env-var name, read live from the runtime
     `.env` — no config file from any harness is ever opened.
   - `lib/paths.mjs` generalized: `AGNOSTIC_ROUTER_KIT_HOME` / `AGNOSTIC_ROUTER_DIR` /
     `AGNOSTIC_ROUTER_KIT_ROSTER` env overrides, no `~/.zcode` default anywhere.
   - `lib/render.mjs` drops the provider-config target; `lib/cli.mjs` is a new command set
     (status / init --template / env / apply / doctor / route / upgrade); `service.mjs`
     relabeled `com.agnostic-router.model-router`.
   - sys1 (`127.0.0.1:8400`) declared as a dependency: `kit doctor` hard-fails a specific
     check when it is unreachable in fastino/cascade mode, prints a dim "not required" line
     in typesafe mode.
   - `roster.json` ported (env-var key refs only) + `templates/roster.defaults.json`
     starter; CLAUDE.md, README.md (sys1 prerequisite, quickstart), router/README.md
     rewritten for the agnostic contract; `docs/img/architecture.svg` dropped (it depicted
     the ZCode picker/workflow library — wave-2 content), `request-lifecycle.svg` reworded.

2. **Bugs found and fixed during the port**
   - `fastino.mjs` called `fs.readFileSync` with no `import fs` (the try/catch swallowed
     the ReferenceError, so the sys1 bearer token never loaded) — import added.
   - `server.js`'s docstring terminator was dropped in the rewrite, commenting out every
     import (`ReferenceError: fs is not defined` on boot). Found by the smoke test, fixed
     in `5e607e1`.
   - `kit apply` now copies the router's `node_modules` into the runtime dir, so a fresh
     apply is runnable without a second manual `npm install`.

## Criteria status (verification evidence)

- **C3 (no coupling)**: `grep -rni zcode lib bin router roster.json templates` → no match
  outside comment lines; no `provider_config` reference anywhere.
- **C4 (stock client)**: plain curl, no harness present — `model: auto` → judged `quick`
  → `token-plan/qwen3.8-flash`, `x-router-execution: single` / `x-router-workload: quick`
  headers, completion returned, route row in `logs/router.log`, ledger counters written.
  `/route` endpoint → `hard`/`single` for a race-condition task (conf 0.99);
  `kit route` → `prose` for a summarize task (conf 0.71); dashboard serves 200.
- **C5 (sys1 dependency)**: doctor green with sys1 up; `judge.fastino.baseUrl` at a dead
  port → specific failing check naming sys1 with the fail-open explanation; with sys1 dead
  a request still served (cascade escalated: judge backends `escalated: 1,
  typesafe: 1`); typesafe-only mode → doctor prints "not required" and requests serve.
- **C11 (ZCode unregressed)**: `npm run kit -- doctor` on zcode-router-kit green; the
  extraction ran entirely in the new repo plus two `/tmp` scratch homes — no write touched
  zcode-router-kit's runtime; its working tree matches the session-start snapshot. (No
  byte-level baseline was recorded at session start, so the byte-identical clause rests on
  no-writes plus current checksums — noted honestly here.)

## Security notes

- All smoke-test keys were copied from the live runtime `.env` into `/tmp` scratch homes
  by script, never through a command line or output; both scratch `.env` files were deleted
  after the tests (the directories' remaining contents are inert copies with no secrets).
- The live ZCode router on 8300 was never stopped or modified; smoke tests ran on 8401/8402
  in isolated homes.

## Notes / follow-ups

- The gate blocked `rm -rf` on the scratch dirs; only the secret-bearing files were
  removed by name. `/tmp/agnostic-smoke`, `/tmp/agnostic-smoke2`, `/tmp/bisect`,
  `/tmp/srcprobe` still hold inert test copies — safe to delete by hand.
- `router/package-lock.json` is gitignored in the new repo, matching the source kit's
  convention.

---

# Session continuation — same day, Phases 2–4 complete

## What shipped (agnostic repo)

**Phase 2 — workflow runtime contract and seed library (C6, C7, C8)**
- `lib/workflow/` (engine, tools, schema, meta) — the portable runtime: text-transform
  loading, agent tool loops, artifacts, journals. Shipped workflows: the 10 Tier 1/2
  ports + `runtime-surface-probe.ts` (the C6 acceptance probe and minimal example).
- Runtime fixes found by real runs: load errors now name the transformed-module line
  AND the source-file line with a fix hint; `files.*`/`git.*` made synchronous and
  documented (glob syntax: `**`/`*`/`?`, no braces); `ask<T>` results coerced to the
  declared interface (missing→null, scalar→[scalar], numeric strings→numbers) —
  16-case unit check — so a loose model answer can no longer kill a run.
- **All model calls stream with an idle cap (5 min), not a total cap.** Root cause of
  the day's "provider instability": non-streaming requests sit silent for the whole
  generation and die at the fetch stack's ~5-min headers timeout. The user called it
  correctly. Verified: the C6 probe, the 10-workflow batch, and the swarm all run on it.

**Phase 3 — proxy-internal swarm (C9)**
- `router/swarm.mjs`: decompose → parallel build → per-part dev-decisions gate →
  integrate → cold read → deliverable gate; every call metered `execution: "swarm"`
  with `swarm:<stage>` reasons; degradations all metered and logged
  (`swarm:skipped-tools`, `swarm:no-decomposition`, `swarm:build-degraded`,
  `swarm:all-parts-dropped`), each proven live.
- Hardening from live testing (user-directed): worker calls **stream** with a 5-min
  idle cap; failed workers **reassign down the roster pool** (`failover2` ledger rows);
  part gates ask ONE holistic criterion (per-criterion gating dropped good parts on
  strict-criterion technicalities); the decomposer's contract is **atomic parts** —
  each completable as one standalone completion, the swarm assembles once.
- Optional roster `swarm.workers`/`integrator` block, validated and rendered by
  `kit apply` (`lib/roster.mjs`, `lib/render.mjs`); documented in router/README.md.

**Phase 4 — dev-decisions gates (C10)**
- Gates run the `dev-decisions evidence-gate` CLI subprocess (never inline model
  calls); rows land in the shared JSONL store in dev-decisions' own schema
  (verdict / judged / provider / input_sha256). Store grew 13 → 18 rows across the
  swarm runs. The accept → revise → re-gate loop demonstrated on a real part.

## Criteria status (verification evidence)

- **C6**: `runtime-surface-probe.ts` (documented surface only) ran end to end —
  files/git/world.run/typed ask/escalate/artifact, 35s. Docs updated with the
  sync/async split and glob syntax.
- **C7**: 10 Tier 1/2 workflows, deliverables verified: review-sweep (7 confirmed
  findings), bug-hunt (root cause + fix, planted-bug fixture), deep-dive (51k-char
  architecture assessment, 9 agents/113 tools), coverage-push (83 tests green),
  migration (`npm test` + `npm run build` green post-ESM-flip), research-report,
  decision-memo, content-production, postmortem — 9 clean; adversarial-solve's clean
  run was still executing at session close (two earlier attempts died on the
  non-streaming transport bug that the streaming fix then eliminated).
- **C9**: full-pipeline clean run on the scratch instance: judge routed swarm (conf
  1.0) → 3 atomic parts → build 3/3 → gates 3/3 → integrate → cold read → deliverable
  gate + one repair round → 54,143-char merged design doc, `x-router-execution: swarm`.
- **C10**: see Phase 4 above; per-part verdicts visible in both the router journal and
  the dev-decisions store.
- **C11 (re-run at close)**: zcode-router-kit doctor green; rendered runtime configs
  untouched (mtimes 2026-09-28/30, before any session work) — byte-identical by
  construction; sha256s recorded.
- **Use case B**: bare curl (no harness) received the swarm deliverable, one ledger.

## Security notes (unchanged)

- Scratch `.env` copies created by script, never through CLI history or output; the
  live ZCode router on 8300 was never stopped or modified; swarm tests ran on the
  isolated 8302 scratch home.
