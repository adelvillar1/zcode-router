---
status: active
created: 2026-10-07
updated: 2026-10-07
slug: hardening-wave-port
---

# Plan: port the engine's hardening wave into the kit edition

**Repo:** zcode-router-kit. **Source:** the engine edition's 2026-10-07 hardening wave (agnostic-router-kit, plan `docs/plans/2026-10-07-hardening-and-mausbot-lessons.md`, fifteen commits `ae86d01..2c775ed`, mined from OpenMausBot). **Method:** the house port discipline (SESSION-RECAP-2026-10-06) — composition, not rewriting: the engine's blocks transplanted by rule, adapted at the edition seams, each verified against this repo's own probes. Wave sites were surveyed against kit HEAD `54656a0`; line references below are kit-side unless prefixed `engine:`.

**What the survey found (drives every adaptation below):** the kit is the same lineage but not the same machine — no chat/setup/swarm surfaces, `handleMixture` has no swarm runtime, the plane arrives as a `file:` symlink into the engine checkout (`workflow-plane/atomic.mjs` already live through it), the provider upstreams merge with ZCode's `provider_config.json`, and `roster.json` carries uncommitted tier retargets that are deliberately not mine to commit.

## Order: enforcement first, then the fixes it guards

The engine landed enforcement second; the kit lands it first. Nothing in P0/P2/P3 here is guarded by any runner today (three probes, run by hand, no `npm test`, no CI) — so the port order is W1 (defects small enough to verify by hand) → W2 (the whole verification layer) → W3–W6 test-first against it.

## W1 — defect cleanup that exists here

1. **Duplicated `/route` handler** — `router/server.js:1472-1495`, two identical consecutive blocks, second unreachable. Delete the second (engine `ae86d01`). Verify: `node --check`, single match.
2. **`/api/state` array-honest** — kit has ONE pair (1876-1877), not duplicated; `workflowLibrary` falls back to `null`. Adopt the array-honest half only: `workflowLibrary: Array.isArray(config.workflowLibrary) ? config.workflowLibrary : []` (engine `4aeceb4`, state half).
3. **Probe exit bug** — `tools/probe-memory-api.mjs:216` is the one site of the engine's three (engine `4572e10`); kit's line text differs, port the fix pattern (`failures.length`), not the diff.
4. **Roster round-trip artifacts** — both halves of engine `baa04d6`: strip `hasKey`/`id` on the PUT path (`PUT /api/roster` 1962-2006 — kit has no `applyRoster`-adjacent dashboard strip) and clean the tracked `roster.json`. **Surgical rule:** the working tree carries deliberate tier retargets (`quick`/`standard_code`/`hard`) that recap `c47b41d` left uncommitted on purpose — strip only the provider-row artifact hunks; stage those, leave the tier drift uncommitted, exactly as found.

N/A here, stated so nobody "completes" them later: the chat `/run` fix and the swarm docstring (no `chat.html`, no `router/swarm.mjs` in this edition).

## W2 — the verification layer (engine `46dfa18`, `a2ed424`, `4ec250d`, kit-shaped)

1. **`tools/fake-upstream.mjs`** — verbatim port (zero-dep, model-name-encoded behaviors).
2. **`tools/probe-failover.mjs`** — kit-shaped adaptation: scaffold copies kit's own `probe-run-api.mjs` idiom (scratch home, kit apply, the home pins); ports 8510/8511/8512; providers injected via `extraUpstreams` (the `upstream()` merge takes them over ZCode's `provider_config.json` — verify at write time); checks E/A/B/C/B2/Q/D/P/F/G/H minus the swarm/chat-specific ones (`/route` verdict stays — the dedupe lands in W1). Walk constants here: `FAILOVER_STATUS` gate at 827, `forward` 945-990.
3. **`tools/run-probes.mjs` + `npm test`** — same glob runner; kit suites at first light: probe-memory-api, probe-memory, probe-run-api + the new ones. `verify-pack` deliberately excluded (needs a ZCode checkout for `yaml`; it is a pack check, not a router suite).
4. **CI** — one job, node 20, `npm test`; the file says why that is the whole gate here too.

## W3 — failure classification (engine `1b31661`)

Port `router/failclass.mjs` verbatim (pure module, the two laws, rejection memory) + `tools/unit-failclass.mjs`. Wire into the kit's walk: import, classify-before-bench in `attemptUpstream` (kit 795-943), `cooldownFor` gains the classified bench with roster override first and honest-kinds Retry-After, ledger reasons `+upstream-<status>:<kind>`, `keyRejections: keyRejectionView()` on `/api/state`. Extend probe-failover with the Q section (quota body never a key fault).

## W4 — atomic writes (engine `87311d8`, twin-count adapted)

**Deliberate deviation from the engine's three twins: the kit lands two.** The plane arrives by symlink and already exports `workflow-plane/atomic.mjs` with the memory save atomic through it — a kit-local `lib/workflow/` copy would trip check-plane's no-competing-copy assertion. So: `router/atomic.mjs` + `lib/atomic.mjs`, headers stating the boundary (router runtime self-contained; kit CLI's own; plane's comes over the symlink). Adoption sites: usage flush (`usage.mjs:326-336`), `writeEnvFile` (`lib/envstore.mjs:24-35`), the applyRoster tmp writes (1029-1049) **plus the PUT /api/roster path it guards**, and kit-only `lib/cli.mjs:98-103` writeJson (same defect class, one call). `tools/unit-atomic.mjs` runs the contract on both twins **and** `workflow-plane/atomic.mjs` through the symlink.

## W5 — capability caps + parity (engine `d5ad9fe`)

Render: caps from `manualModelRules` (`supportsImages`/`supportsTools`/`contextWindow`) onto every rendered candidate + `capsByModel` under routing. Walk: `parityFilter` between `decide` and `steerSingle` (kit forward 945-990), ledger rows `parity:<capability>`. Neutrality law unchanged: the kit roster declares `contextWindow` already (caps render immediately); `supportsImages`/`supportsTools` are undeclared — nothing gates until declared. The kit roster's provider-config-shaped `inputFormat.supportsImage` is noted, NOT mapped — the caps vocabulary stays byte-identical to the engine's; mapping ZCode's nested shape is a separate decision. Dashboard `renderProviders` (799) gains the Caps column; `/api/state` gains the `providerCaps` rollup.

## W6 — ledger pricing + attribution (engine `856bfab`)

`createUsage({ file, weightOf, priceOf })`; cost computed at the record chokepoint (`costUsd` + `costSource: "price-list"`, never estimated); `trigger` threaded from the kit's bearer gate (1443-1459) through forward → parityFilter/attemptUpstream/handleMixture (no swarm records here — none exist). Render builds `cfg.pricing` from provider `pricing`/`pricingByModel`. Dashboard recent table gains Cost + Who columns. No roster prices declared in either edition — rows stay null until someone declares them.

## W7 — documentation (in-wave, the user's explicit requirement)

- **README**: a verification-layer paragraph (`npm test`, what it runs, CI); the module map gains failclass/atomic; "How the router decides" steps rewritten to the classification/parity/trigger/cost contracts; the tiers bullet documents `manualModelRules` caps; Layout updated.
- **The three SVG text twins** (hand-maintained here — no render pipeline): `docs/img/architecture.svg` (module inventory gains failclass/atomic if nodes list router modules), `docs/img/quota.svg` (the steering/cooldown story → classified benches), `docs/img/request-lifecycle.svg` (the walk step gains classification + parity). Labels and any alt/description text inside the SVGs — checked against the new behavior, edited only where a claim is now false or a module list is now incomplete.
- **The archify plane diagram** (`docs/architecture/zcode-router-plane.html` + candidate): re-finalize ONLY if the wave changed the plane-boundary statement — it did not (the plane gained `atomic.mjs` engine-side, which the kit consumes through the existing symlink; if the diagram enumerates plane modules, update the count/list in the candidate and re-finalize — decided at W7 by reading the candidate).
- **Feature docs**: `quota-failover.md` rewritten to the classified walk (its cooldown table is pre-failclass), `dashboard.md`, `routing-tiers.md`, `memory.md` (atomic save note — inherited through the symlink).
- **Contracts**: FUNCTIONAL-SPECIFICATIONS §6 (Failover & Degraded States) rewritten to match production, mirroring the engine's §7; TECHNICAL-DOCUMENTATION §5/§12 gain `keyRejections`, cost/trigger fields, failclass/atomic in the inventory; TROUBLESHOOTING's cooldown table updated to the classified benches.
- **State + housekeeping**: `docs/STATE-SNAPSHOT.md` replaced (not appended) with post-wave truth; CLAUDE.md "Today's state" refreshed; plan closed `completed` with the honest deviations; session recap in `docs/recaps/`.

## Acceptance criteria

- [ ] **C0** W1: single `/route` block; `workflowLibrary` array-honest; probe-memory-api exits 0 on success; tracked roster free of `hasKey`/`id` with the tier retargets still uncommitted; PUT /api/roster strips artifacts.
- [ ] **C1** `npm test` green: glob runner, kit suites + the new ones; red proven with a deliberate failing suite; CI workflow committed.
- [ ] **C2** fake-upstream + probe-failover green on the kit (~25 checks): walk-on-429 with Retry-After, 401 bench, benched-fallback skip, all-fail envelope, 400 passthrough, `/route` live, classified ledger reasons, streaming metered.
- [ ] **C3** classification: unit table green; walk + cooldowns wired (roster override first); `/api/state.keyRejections` names key faults, never quota faults.
- [ ] **C4** atomic: unit-atomic green across both kit twins + the symlinked plane's; usage, envstore, applyRoster, cli writeJson all ride atomic writes; `npm run check:port` still green.
- [ ] **C5** caps: candidates carry caps; undeclared neutral (kit roster gates nothing today); parity probe proves a declared-doomed fallback is excluded, never tried.
- [ ] **C6** ledger: declared pricing → costUsd/costSource; trigger on the chat path; tokens still reported-only.
- [ ] **C7** docs in-wave: README (verification + decision steps + modules), three SVG text twins truthful, feature docs, both contract docs, TROUBLESHOOTING cooldown table, STATE-SNAPSHOT replaced, CLAUDE.md state, plan closed, recap.
- [ ] **C8** zero new runtime npm dependencies; `node --check` clean on every touched file; the ZCode seams untouched (`upstream()` merge, KIT_ROOT apply chain, `AGNOSTIC_ROUTER_KIT_HOME`/`MEMORY_FILE_PATH` pins, memory ceilings, operator gate).
- [ ] **C9** port discipline: `npm run check:port` green at the end; every engine block landed by region transplant adapted at the seams this plan names, not by positional patch.

## Out of scope (with reasons)

- The engine's chat/setup/agents surfaces, swarm runtime, probe-chat-surface/probe-memory-mcp/visual probes — separate features, never ported here.
- workflowlib `buildRegistry` object-vs-array divergence — pre-existing, the wave touches none of it.
- Declaring prices or image/tools caps in the kit roster — data decisions, not code; the wave makes them expressible.
- `inputFormat.supportsImage` → caps mapping — ZCode provider-config semantics deserve their own decision.
