---
status: active
created: 2026-10-07
updated: 2026-10-07
slug: browsing-and-tabular-port
---

# Plan: port the browsing and tabular waves from the engine

**Repo:** zcode-router-kit. **Source:** the engine edition's browsing wave (`docs/plans/2026-10-07-local-browsing.md`, moli + keyless search + the browser grant) and tabular wave (`docs/plans/2026-10-07-tabular-loops.md`, six sdm1 loops + `world.tabular`), both landed 2026-10-07. **Method:** the house port discipline — but this is the cheapest port yet, and the plan says why.

## What is already ported by construction (verify, don't transplant)

The kit's plane is the engine's checkout (`workflow-plane` symlink). Everything the two waves landed in `lib/workflow/` is live in the kit's dependency tree **right now**: `world.tabular`, the `tabular`/`browser`/`browser-layout` grants, `browserFetch`/`scrapeUrl`/the keyless search backends, `browserSession`, `web_render`, the engine.mjs world bindings. Zero transplant, zero divergence risk — `npm run check:port` is the guard. What this port ships is the **kit-local shell**: doctor, producers, the loops, the consumers, docs, diagrams, deployment.

## Waves

### W-A — code (one agent; the kit-local shell)

1. **Doctor rows** (`lib/cli.mjs` `cmdDoctor`, moli-mechanism precedent from the engine's file): moli row (version via `moli --version`, absent = dim note naming `docs/features/browsing.md`) + dev-decisions row (presence/version via `DEV_DECISIONS_BIN` override, absent = dim note naming `docs/features/tabular-decisions.md`).
2. **`tools/record-quota-table.mjs`** — the engine's file with kit path defaults: `--usage` default `~/.zcode/router/logs/usage.json`, roster default the kit's `roster.json`; the weighting math imports kit-side (`router/quota.mjs` `offpeakWeight` — same lineage, verify the import resolves). `package.json` gains `"record:quota"`.
3. **`tools/run-probes.mjs`** — the probe-outcomes append (header `ts,suite,passed,failed,ms` on creation, one row per suite per run, try/catch-wrapped, exit semantics untouched).
4. **Unit probes** — port `tools/unit-services-browser.mjs` + `tools/unit-services-tabular.mjs` verbatim: they import plane code through the symlink, so they pass here unchanged; that IS the cross-edition coverage statement. (If any assertion references an engine-only path, adapt and note.)
5. **The three loops** — `workflows/quota-forecast.ts`, `workflows/flake-watch.ts`, `workflows/calibrate-floors.ts` from the engine's files, kit-adapted: store path const identical (`~/.local/share/dev-decisions/tables/…`), the quota-forecast stat gate via `world.run` unchanged; verify headers parse via `node bin/zcode-router-kit.mjs workflows list`.
6. **Consumers** — the kit's library HAS the targets: `workflows/review-sweep.dwf.ts` (risk-prior annotations after findings), `workflows/triage.ts` (eval-only sdm1 routing head, `applied:false` journal, grep marker), `workflows/watchdog.ts` (fleet section via `fleet-anomaly`). Port from the engine's post-wave files, adapting to each kit file's own shape (`.dwf.ts` flavor differs — read first, transplant the SECTION, not the file). **N/A, stated:** the router-swarm risk composition — the kit has no `router/swarm.mjs` runtime; building one to carry a gate composition is invention, not porting. The engine's swarm-side proof stays engine-side.

### W-B — docs + diagrams (one agent, parallel with W-A)

1. **README**: browsing paragraph (local moli, browser grant default-off, keyless-first search) + tabular paragraph (six loops, batch-only law, `tabular` grant) + loop-library lines; module map gains `failclass.mjs`/`atomic.mjs` naming check (already landed in the hardening port — verify, don't duplicate).
2. **`docs/features/browsing.md` + `docs/features/tabular-decisions.md`** (new, engine's files as the base, kit paths: `~/.zcode/router/logs/usage.json`, `kit apply` deployment note, the producer `npm run record:quota`).
3. **TROUBLESHOOTING**: the browser-rendered section + the tabular-unavailable/forecast-band sections (engine's entries, kit paths).
4. **FUNC-SPEC + TECH-DOC**: the plane's surface lists gain browser/tabular (grep where net-search/browsing already sit post-hardening; the hardening port already carried the classification/parity/pricing contracts — extend, don't restate).
5. **SVG audit** (the text twins): `request-lifecycle.svg` already carries the classified walk (verified this survey); audit it and `quota.svg`/`architecture.svg` for browsing/tabular claims — edit only false-or-incomplete statements (the walk box gaining "render", the Firecrawl mentions gaining the local-first ladder if present). `docs/architecture/zcode-router-plane.html`: module count unchanged (16) — verify, no re-finalize unless the plane-boundary statement changed.
6. **STATE-SNAPSHOT** replaced; CLAUDE.md Today's state refreshed.

### W-C — integration (me)

Harness/world verification through a real workflow, both-edition `npm test` (the kit suite grows to 8 with the two ported unit probes), `check:port`, neutrality grep, plan close + recap. **Deployment (`kit apply` + service restart) stays the operator's step** — named in the recap, as with every prior wave.

## Acceptance criteria

- [ ] **C0** doctor: moli + dev-decisions rows, both branches exercised (present here; absent via env pin).
- [ ] **C1** producers: record-quota-table idempotent per bucket against a fixture; run-probes appends outcomes; `npm run record:quota` wired; kit ledger default path.
- [ ] **C2** the three loops parse via `kit workflows list`, transform-compile through the plane, and carry the fail-open sentences verbatim.
- [ ] **C3** consumers: review-sweep risk annotation, triage eval head (`applied:false`, grep-provable), watchdog fleet section — ported to the kit files' own shapes, each degrading by name without the grant/CLI.
- [ ] **C4** both engine unit probes pass in the kit (cross-edition coverage statement); kit `npm test` green (8 suites).
- [ ] **C5** check:port green (deployment named, not done); engine `npm test` untouched-green.
- [ ] **C6** docs in-wave: README, both feature docs, TROUBLESHOOTING, both specs, STATE-SNAPSHOT replaced, CLAUDE state; SVG audit recorded (edits only where claims are false/incomplete); plan closed; recap filed.
- [ ] **C7** zero new runtime dependencies; neutrality grep clean; `node --check` clean on touched files; the ZCode seams untouched (`upstream()` merge, `KIT_ROOT` apply chain, `AGNOSTIC_ROUTER_KIT_HOME`/`MEMORY_FILE_PATH` pins, memory ceilings, operator gate).

## Out of scope (with reasons)

- The router-swarm risk composition (no swarm runtime here — invention, not porting).
- The engine's swarm/chat surfaces, probe-chat-surface/probe-memory-mcp/visual probes (as before).
- Declaring prices/caps in the kit roster; `kit apply` deployment (operator).
- The engine-side `inputFormat.supportsImage` caps mapping decision.
