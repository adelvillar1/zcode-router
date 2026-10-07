# Session recap — 2026-10-07 (port): browsing + tabular catch up kit-side

**Plan:** `docs/plans/2026-10-07-browsing-and-tabular-port.md` (completed). The cheapest port yet — the plane is the engine's checkout by symlink, so `world.tabular`, the browser/tabular grants, the scrape ladder, and the keyless search backends arrived **by construction**; the work was the kit-local shell, two delegated agents (code / docs+diagrams), and integration.

## What landed

- **Doctor rows**: moli + dev-decisions in `kit doctor` (both branches exercised; `DEV_DECISIONS_BIN` honored, swarm precedent).
- **Producers**: `npm run record:quota` (kit ledger default `~/.zcode/router/logs/usage.json`, kit roster for the off-peak weights, idempotency fixture-proven 3/0 → 0/3); run-probes appends suite outcomes to the dev-decisions store on every run.
- **The three loops** as `.dwf.ts` (the kit's own flavor — the loader divergence the survey warned about, caught at verification): quota-forecast, flake-watch, calibrate-floors. Run by explicit `.dwf.ts` path for now (the loader resolves `<name>.ts`).
- **Consumers**: review-sweep risk annotations, triage's eval-only sdm1 head (`applied:false`), watchdog's fleet section. The swarm risk-composition dropped out — no swarm runtime here, stated in the plan.
- **Cross-edition coverage**: the engine's two unit probes ported (19 + 13 checks, one import idiom adapted) — the plane's tabular/browser code is proven from BOTH editions now.
- **Docs + diagrams**: `docs/features/browsing.md` + `docs/features/tabular-decisions.md` (new), README paragraphs + loop lines + grants, TROUBLESHOOTING sections, both specs' surfaces, STATE-SNAPSHOT replaced, CLAUDE state. **The three hand-maintained SVGs retired**: replaced by archify diagrams (architecture / request-lifecycle / quota — all four gates each, 30+ line-level source refs), stills rendered by the ported `render-png.mjs`, README + overview switched. The plane diagram needed nothing: 16 modules is still the truth.

## The honest list

- The hardening port's own contract prose (README/SPEC/TECH-DOC failclass·parity·pricing edits) was found **uncommitted in the tree** at this port's start — landed first as its own commit, an apology to whichever session left it.
- `kit workflows run <name>` resolves `<name>.ts`, so the new `.dwf.ts` loops run by path — loader quirk named, not worked around.
- check-plane reports the installed runtime 3/16 current; `kit apply` + restart remains the operator's deployment step.

## Numbers

8 kit suites green (6 + 2 ported unit probes) · engine 18 suites untouched-green · 6 commits · zero new runtime dependencies · 3 diagrams redone with archify, all gates green, stills visually verified.
