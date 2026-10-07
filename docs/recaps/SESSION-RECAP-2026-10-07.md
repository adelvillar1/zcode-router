# Session recap — 2026-10-07: the hardening wave, ported

**Plan:** `docs/plans/2026-10-07-hardening-wave-port.md` (completed). Source: the engine edition's hardening wave (agnostic-router-kit, mined from OpenMausBot), ported by the house discipline — composition at the edition seams, not positional patches (kit server.js diverged ~705 lines from the engine's; not one hunk applied by position).

## What landed (10 commits, `0eb1926..HEAD`)

- **W1 defects**: the duplicated `/route` handler deleted; `workflowLibrary` array-honest; probe-memory-api exits 0 on success (the one kit site of the engine's three); the dashboard's `hasKey`/`id` stripped on PUT and cleaned out of the tracked roster — **the uncommitted tier retargets survived untouched** (strip committed against HEAD's tiers, drift restored on top).
- **W2 enforcement** (landed second here, first in no order but deliberately early): `fake-upstream.mjs`, `probe-failover.mjs` (34 checks — kit-shaped: `routerOnly` providers into `extraUpstreams`, the `ZCODE_ROUTER_DIR` scratch contract, `@typesafe-ai/sdk` provisioned like probe-run-api does), `run-probes.mjs` + `npm test` (glob; verify-pack deliberately excluded — it needs a ZCode clone), one-job CI.
- **W3 classification**: `router/failclass.mjs` verbatim + the walk wiring (classified benches, roster override first, quota-429 refuses Retry-After), key rejections on `/api/state`, `+upstream-<status>:<kind>` ledger reasons.
- **W4 atomic**: **two** twins (router/, lib/) — the plane's arrives through the symlink, and a kit-local `lib/workflow/` would trip check-plane; adopted at the ledger flush, `.env`, applyRoster, and the CLI's `writeJson`. unit-atomic proves all three parties.
- **W5 parity**: caps from `manualModelRules` onto every rendered candidate, `parityFilter` before steering, `providerCaps` on `/api/state`, dashboard Caps column. The kit roster declares `contextWindow` only — nothing gates until images/tools are declared.
- **W6 ledger**: `priceOf` (live across config reloads), `costUsd`/`costSource` at the record chokepoint, `trigger` threaded from the bearer gate through forward/parity/walk/mixture (no swarm rows here — none exist), dashboard Cost/Who columns.
- **W7 docs**: README (verification layer, module map, the failover/parity/pricing prose, request-lifecycle alt text), the `request-lifecycle.svg` walk block (classification + parity — the other two SVGs' claims still hold), `quota-failover.md` rewritten to the classified walk, FUNCTIONAL-SPEC §6 + TECH-DOC §12 rewritten, TROUBLESHOOTING's pre-failclass cooldown table replaced, STATE-SNAPSHOT replaced, CLAUDE.md state refreshed, the plane diagram re-finalized at 16 modules.

## The honest list

- The first probe run applied to the **live machine** (engine env contract vs the kit's `ZCODE_ROUTER_DIR` scratch contract) — benign, fixed, and the lesson recorded in the probe's comments.
- Orphaned fakes served stale counters until the probe structure guaranteed cleanup and the fake exits loudly on a taken port (both editions).
- My own `lib/cli.mjs` import was an unasserted replace that silently did nothing — three probes crashed instantly and I committed before reading the failure; the fix commit says so plainly. Every replace in this port is now asserted.
- W5's port carried the engine's final `forward()` (trigger included), so W6's patch found its forward-block edit already applied — the asserts caught it instead of double-applying.

## Numbers

6 suites (~175 checks) via `npm test` · CI one job · zero new runtime deps · 10 commits · `npm run check:port` green · the tier drift still uncommitted, exactly as found.

## Open seams

Prices and image/tools caps are declarable but undeclared (data decisions); `inputFormat.supportsImage` → caps mapping is its own decision; the swarm/chat surfaces remain engine-only.
