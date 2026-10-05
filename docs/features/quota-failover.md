# Feature: Usage ledger, quota & failover

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Plans & Billing Safety, § Failover & Degraded States. Deep mechanics: `router/README.md` (Quota & steering).

## Usage ledger (`router/usage.mjs`)

The router is the only vantage point that sees *every* upstream call, mixture proposers included — a prepaid plan pays for those too. Per model and per day it meters calls, errors, prompt/completion tokens, latency; tokens are recorded **only when the upstream reported them** (unknown counts stay unknown, never estimated). State is in memory, persisted atomically to `~/.zcode/router/logs/usage.json` a few seconds after the last change; 30-day retention plus a 200-entry recent-request ring for the live view.

Hourly buckets (`providerId → UTC hour → calls/tokens`) are the raw material for off-peak weighting and rolling windows. Per-judge-backend counts land here too, so the cascade handoff rate is measured, not assumed.

## Quota derivation & steering (`router/quota.mjs`)

No prepaid plan exposes a quota API, so the router derives what it can:

1. The ledger meters **weighted spend** per provider — off-peak hours count at their declared weight (`offpeak.from/to/weight/tz`).
2. A **console reading** ("plan is N% used") calibrates the declared allowance: delta spend over delta percent.
3. **Headroom drives steering**: candidates under `routing.quotaMinHeadroom` (default 40%) are passed over for healthier ones in the same chain; plans under 5% headroom are never suggested as primaries. Undeclared providers are left alone.

## Runtime failover

A serving upstream answering `402/403/408/429/5xx` — or failing to connect — sends the tier walk to the next roster-ordered candidate and benches the failure:

| Status | Cooldown |
|--------|----------|
| 429 | 5 min |
| 402 | 15 min |
| 403 | 30 min |
| 5xx | 1 min |

`Retry-After` wins over the table; `routing.failover.cooldowns` overrides it. Client-caused failures (400/404) pass through untouched. A walk is marked `x-router-failover`, and the failed attempt and the winner are separate ledger rows.

## Where the code lives

`router/usage.mjs`, `router/quota.mjs`, tier-walk logic in `router/server.js`; steering tuning via roster `routing.*`.
