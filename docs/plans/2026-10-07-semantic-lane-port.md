---
status: completed
created: 2026-10-07
updated: 2026-10-07
slug: semantic-lane-port
---

# Plan: port the semantic lane from the engine

**Repo:** zcode-router-kit. **Source:** the engine edition's semantic wave (`docs/plans/2026-10-07-semantic-loops.md`, dev-decisions supply `3c61126`, kit foundation `3bfbd2c`, loops `be3659a`, all 2026-10-07). **Method:** the house port discipline from the browsing-and-tabular port — verify what the plane dependency already carries, ship the kit-local shell, prove it here, name the deployment.

## What is already ported by construction (verify, don't transplant)

The kit's plane is the engine's checkout (`workflow-plane: file:../agnostic-router-kit/lib/workflow`, materialized as
the `node_modules/workflow-plane` symlink). Everything the wave landed in `lib/workflow/` is live in this kit's
dependency tree **right now**: `world.semantic` (services.mjs, `--json` injected, three-verb allowlist, pinned refusal
sentence), the `semantic` grant (default-off), the engine bindings (grant-checked, journaled with corpus), and
`world.repeatFromRows`. Zero transplant, zero divergence risk — `npm run check:port` is the guard. What this port
ships is the kit-local shell: doctor, the loops, the consumers, the router tap, the probes and producers, docs,
diagrams.

## Waves

### W-A — code (the kit-local shell)

1. **Doctor row** (`lib/cli.mjs`, beside the dev-decisions row at ~581): the semantic lane rides the same CLI —
   `semantic-nn --help` presence probe, green when the CLI speaks the verbs, dim configured-absence note naming
   `docs/features/semantic-lane.md` otherwise.
2. **`router/semroute-shadow.mjs`** — the engine's module copied verbatim (pure: cosine/wouldPick/makeSemrouteShadow;
   every failure disables by name).
3. **`router/server.js` tap** — the one real hand-merge (kit server is 2190 lines against the engine's 2530): the
   import, create-once from `R.workflows` + `SEM1_EMBED_URL`/`SEM1_EMBED_MODEL`/`SEM1_EMBED_KEY` envs, re-warm on
   config reload, `warm()` in the listen callback, and the fire-and-forget `void shadowRoute?.note(...)` after the
   judge verdict — nothing reads its return, the same structural guarantee the engine's C8 probe holds.
4. **Unit + executed probes** — `tools/unit-services-semantic.mjs` (the one known adaptation: engine repo-path imports
   become the kit's bare specifiers, `workflow-plane/services.mjs` / `workflow-plane/tools.mjs` — that IS the
   cross-edition coverage statement), `probe-semroute-shadow.mjs` (verbatim — it imports `router/semroute-shadow.mjs`,
   now kit-local), `probe-render-watch-shadow.mjs` + `probe-sweep-semantic-dedup.mjs` + `probe-semantic-loops.mjs`
   (structure greps repointed at the kit's re-flavored workflow filenames), and the producers
   `record-findings-index.mjs` + `record-render-index.mjs` (verbatim — the store dir is dev-decisions' convention in
   both editions).
5. **The loops** — `workflows/dupe-watch.dwf.ts` and `workflows/render-watch.dwf.ts` from the engine's files,
   re-flavored to the kit's `/* zcode-workflow */` header (the loader divergence the tabular port recorded; they run by
   explicit `.dwf.ts` path). `workflows/review-sweep.dwf.ts` gains the dedup head by SECTION transplant (read the kit
   file's own shape first — the tabular port's rule). `workflows/router-eval.ts` gains the neighbor pre-pass
   (diff-against-engine first, transplant the additive block).

### W-B — docs + diagrams

1. **`docs/features/semantic-lane.md`** (new; the engine's as the base, kit paths, the `.dwf.ts` flavor note, the
   deployment note).
2. **README** loop-library lines (dupe-watch, render-watch, the shadow router) + the semantic paragraph.
3. **TROUBLESHOOTING**: the three semantic entries (four absences, the expected shadow disagreement, the
   surrogate-text lead).
4. **FUNC-SPEC + TECH-DOC**: the surface lists gain `world.semantic`/`world.repeatFromRows`; the loops list gains the
   two; the router module set gains `semroute-shadow.mjs`.
5. **STATE-SNAPSHOT** replaced; CLAUDE.md Today's state refreshed.
6. **Archify audit**: `request-lifecycle` (the judge flow gains the eval-only shadow tap — edit only false-or-
   incomplete statements) and `zcode-router-plane` (plane module count unchanged — the plane is engine-side; verify).
   Re-finalize only what the audit proves stale.

### W-C — integration

Kit `npm test` (the suite grows with the four ported probes), `npm run check:port` green, `kit workflows list`
parses the re-flavored loops, engine `npm test` untouched-green, plan close + recap. **Deployment (`kit apply` +
service restart) stays the operator's step** — named in the recap, as with every prior wave; check-plane reports
installed-runtime lag until then.

## What landed (deviations recorded honestly)

- **Two commits**: the shell (`feat:` — semroute-shadow + server tap, doctor row, four workflows, two producers, five probe suites) and the docs (`docs:` — feature doc, README, TROUBLESHOOTING, both specs, STATE-SNAPSHOT, CLAUDE state, the architecture diagram's count fix + re-finalize). Kit `npm test`: 13 suites green (9 prior + unit-services-semantic 14 + the executed probes 8/5/6/5). Engine `npm test` untouched-green (23 suites).
- **The section transplant became a verified whole-file copy**: the kit's `review-sweep.dwf.ts` and `router-eval.ts` were byte-identical to the engine's pre-wave versions apart from the header flavor line (diff-proven before copying), so the tabular port's "transplant the section, not the file" rule was satisfiable by the stronger check — copy post-wave + flip the header. The two new loops landed the same way.
- **The probe import adaptation applied twice, not once**: besides the unit probe's bare plane specifiers, the three structure probes imported the surface by the engine's repo path — all four now import `workflow-plane/services.mjs`, which IS the cross-edition coverage statement.
- **One flavor adaptation in the tap**: this kit's judge also answers `mixture`, so the shadow's picked value records `mixture`/`swarm` beside the engine's `swarm`-only form. Everything else of the wiring is line-for-line.
- **check:port reports the standing lag, as the prior port recorded**: the installed runtime beside the router is 3/16 current (engine.mjs, services.mjs, tools.mjs). The live service executes the pre-wave plane until `kit apply` + service restart — deployment named, not done.
- **Archify audit**: `architecture.candidate.json`'s "35 saved .dwf.ts" was the one stale claim — fixed to 37, re-finalized (all four gates pass), still rendered and verified by eye ("37 saved .dwf.ts · zcode-workflow metadata" legible, nothing clipped; the finalize's crossing/detour advisory names pre-existing geometry this label edit did not touch). `request-lifecycle`, `quota`, and `zcode-router-plane` audited, no edits: the tap adds a log line after the judge, not a request-path change, and the plane's 16 modules are engine-side.
- **`kit workflows list` shows dupe-watch unregistered** (no task arg → hand-launched, the tabular loops' recorded state) and render-watch/review-sweep parsed; the `.dwf` loops run by explicit path until the loader learns the flavor — the tabular port's standing note, unchanged.

## Acceptance criteria

- [x] **C0** plane inheritance verified: `world.semantic` + the grant + bindings resolve through the kit's dependency
  (check:port green; unit probe passes here unchanged but for the specifier idiom).
- [x] **C1** doctor: the semantic row both branches (present here; the dim note's text matches the doc path).
- [x] **C2** the two new loops + the two transplanted heads: `kit workflows list` parses them; the fail-open sentences
  ride verbatim; the report-only/shadow laws hold in the kit copies (the probes' structure checks pass against the
  re-flavored files).
- [x] **C3** the router tap: `node --check` clean; the probe's wiring greps pass against the KIT server (tap after the
  verdict, fire-and-forget, nothing reads the return, registry from the kit's `R.workflows`).
- [x] **C4** kit `npm test` green with the new suites enrolled; engine `npm test` untouched-green.
- [x] **C5** check:port green (deployment named, not done).
- [x] **C6** docs in-wave (feature doc, README, TROUBLESHOOTING, both specs, STATE-SNAPSHOT, CLAUDE state); archify
  audit recorded, re-finalize only where stale; plan closed; recap filed.
