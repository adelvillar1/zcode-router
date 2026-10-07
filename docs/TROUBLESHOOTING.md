# Troubleshooting

Symptom-first pointers. Deeper mechanics live in `router/README.md`; the feature docs in `docs/features/` explain each subsystem.

## Start here, always

```bash
npm run kit -- status          # installed? tiers resolved? health?
npm run kit -- doctor [--live] # whole-chain verification; changes nothing
```

Treat `!` lines as things to explain, and remaps as real (a fallback fired because a target had no key or was disabled — never for quality).

## Router not reachable / not on :8300

- `kit status` → is the launchd service loaded? Restart path: `kit apply` (renders, restarts, health-checks).
- Health endpoint: `curl http://127.0.0.1:8300/healthz` (no auth).
- The router binds loopback only — remote access is out of scope by design.

## 401 / auth failures from the dashboard or `/route`

- Local token mismatch: API calls need `Authorization: Bearer <localToken>` (roster `router.localToken`, default `local-auto-router`). The served dashboard page has the current token stamped in — reload it.

## Routing looks wrong (wrong model, lazy decisions)

- Read the response headers `x-router-execution` / `x-router-workload` / `x-router-workflow`; `x-router-failover` means a tier walk happened.
- `~/.zcode/router/logs/router.log`: `route`, `route-verdict`, `mixture` events; degraded judgments are tagged `judge:no-key`, `judge:error:…`, `judge:low-confidence`.
- Preview a verdict without a model call: `kit route "<task>"`.

## A plan seems exhausted / traffic not steering

- Quota is derived, not reported: check the roster's `quota.allowance` + `calibration.reads` (a stale console reading skews headroom), and off-peak weights.
- Failures are classified before benching (`router/failclass.mjs`): a usage-limit body is a **quota** window (30-min bench) even when it arrives as a 429; a bare rate limit benches 5 min (Retry-After wins); a key rejection (401, or 403 with key vocabulary) benches 60 min and is remembered on `/api/state` → `resolved.keyRejections`; a model gap (403/404 with model vocabulary) walks **without benching**; 5xx/connection failures bench 1 min. `routing.failover.cooldowns` overrides all of it. Ledger reasons carry the class (`+upstream-429:rate`, `+upstream-402:quota`), so "why did it walk" is readable in the dashboard.

## Provider missing from ZCode's picker / whole picker degraded

- Never hand-edit `~/.zcode/v2/provider_config.json`. Check `kit status`; then `kit apply --dry-run` to see what the kit would write.
- The kit only rewrites its own keys and aborts on an unknown `schemaVersion` — if the app's config was damaged some other way, restore the newest `*.bak-kit*` backup, then re-apply.
- Keyless roster providers keep their registration; removal requires explicit `enabled: false`.

## Workflows missing / doctor says 0 assignable

- `kit workflows sync` copies the library without deleting your local files.
- A workflow is router-assignable only with a task argument (metadata or `workflows.registry.<name>.taskArg`); structured-arg workflows are hand-launched by design.

## Key problems

- Keys live only in `~/.zcode/router/.env` (600): `kit env list` shows what's set vs required; `kit env set NAME=value` sets. A raw key in `roster.json` is a hard-rule violation — move it to the env file and reference `apiKeyEnv`.

## Browser-rendered scrapes / web_render

The local browsing stack (2026-10-07): rendered fetch and scrapes run through the operator-installed moli binary behind
the `browser` grant; search is keyless-first ([`docs/features/browsing.md`](features/browsing.md)).

- **`web_render` refused.** Either the run was spawned without the grant (`capability not granted in this run: browser`
  — the refusal is journalled) or moli is not on PATH (*"browser not installed — the browser grant needs moli on
  PATH"*). Remediation: re-spawn with `--grant browser`, and install the pinned moli release per
  [`docs/features/browsing.md`](features/browsing.md) — `kit doctor` reports which of the two it is (green moli line =
  the grant was missing; dim moli note = the binary is).
- **Rendered content is still thin.** Some sites only paint behind moli's layout mode, which the `browser-layout`
  grant (not plain `browser`) gates. Remediation: spawn with `--grant browser-layout` and a `waitSelector` for the
  selector the page paints late.
- **Search returned few rows.** DuckDuckGo rate-limits or comes up empty; `auto` falls back to Firecrawl only when
  `FIRECRAWL_API_KEY` resolves — without the key, DDG's (possibly empty) answer is the honest result. Remediation:
  check the run journal's search line — the `via`/backend names which leg answered — then set the key
  (`kit env set FIRECRAWL_API_KEY=…`) or pin `backend: "duckduckgo"|"firecrawl"` explicitly.

## Tabular loops / world.tabular

The dev-decisions batch lane (2026-10-07): forecast bands, flake scores, revert-risk priors, fleet anomalies behind the
`tabular` grant, default-off ([`docs/features/tabular-decisions.md`](features/tabular-decisions.md)).

- **A tabular loop says unavailable.** Three distinct absences wear the same "proceeds without it" shape, and the log
  line names which: *dev-decisions missing* (the pinned refusal — "dev-decisions not installed — the tabular grant
  needs the dev-decisions CLI (see docs)"; remediation: install the CLI or point `DEV_DECISIONS_BIN` at it), *no sdm1*
  (the CLI answers "tabpfn-hosted backend is not configured: set TABPFN_API_KEY" — remediation: set the key, or accept
  the mechanical-fallback rows some verbs still print), and *empty table* (the verb ran but its store table has no rows
  yet — `risk_prior.csv`, `quota-spend.csv`, `probe-outcomes.csv` under `~/.local/share/dev-decisions/tables/` grow
  only when their producers run: dev-decisions' own verbs, `npm run record:quota`, `npm test`). This is fail-open by
  design: findings unannotated, triage byte-identical, watchdog proceeding. Remediation: none required — run the
  producer whose table is empty and the next loop run picks it up.
- **The forecast band flags a plan I know is fine.** The quota-forecast band is a quantile band over the *recorded
  weighted spend* in `quota-spend.csv`, not over the provider console's own remaining-quota read — a top-up on the
  console, a changed allowance, or a weekend-long idle stretch makes the table and the console disagree, and the band
  flags a plan the console says is fine. Remediation: re-run `npm run record:quota` so the table carries the current
  reality, and treat a band crossing as a prompt to reconcile the two reads — the loop escalates so an owner can
  answer, not because it measured the console.
