# State Snapshot

> Dated replacement file — **replace this content, don't append.** Stat tables live here, not in topical docs.

## 2026-10-07

- Hardening wave ported from the engine (plan `docs/plans/2026-10-07-hardening-wave-port.md`, completed): failclass + parity + ledger pricing/trigger + atomic writes + the verification layer. Suite: **6 suites green via `npm test`** — probe-failover (34 checks, fake upstreams on 8510-8512), probe-run-api (33), probe-memory (49), probe-memory-api (15), unit-atomic (27 across both twins + the symlinked plane), unit-failclass (17). CI: one job, node 20.
- Defects fixed: the duplicated `/route` handler, the non-array-honest `workflowLibrary`, probe-memory-api exiting 1 on success, the dashboard's `hasKey`/`id` round-trip (stripped on PUT; the tracked roster cleaned — the tier retargets remain uncommitted, as before).
- Atomic writes: usage ledger, `.env`, roster PUT, CLI rendered-config writes; the memory store's atomic 600 save arrives through the `workflow-plane` symlink (16 modules — atomic.mjs added engine-side; `npm run check:port` green).
- Classifier: quota-before-ratelimit, keys never blamed for quotas (rejections on `/api/state`), model gaps walk without benching; benches quota 30m / rate 5m / key 60m / transient 1m, roster overrides first. Ledger rows carry `trigger` and declared-price `costUsd` (no prices declared yet — rows show null).
- Working tree: `roster.json` still carries the uncommitted tier retargets (quick & standard_code → xiaomi-mimo/mimo-v2.6-flash · hard → stepfun/step-5-preview) — deliberately uncommitted, unchanged by this wave.
- Diagrams: `docs/img/request-lifecycle.svg` walk block updated (classification + parity); the plane diagram re-finalized at 16 modules. Untouched: `architecture.svg`, `quota.svg` (their claims still hold).
