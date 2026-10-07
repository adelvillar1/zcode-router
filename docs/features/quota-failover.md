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

A serving upstream answering `402/403/408/429/5xx` — or failing to connect — is first **classified** (`router/failclass.mjs`, pure functions; unit-table tested in `tools/unit-failclass.mjs`), then walked and benched per its class:

| Class | Trigger | Bench |
|-------|---------|-------|
| `quota` | 402, or usage-limit vocabulary in the body — **matched before the 429 pattern**: a subscription cap is a window hours away, not a rate limit | 30 min |
| `rate` | 429 without usage vocabulary, rate-limit/overloaded bodies | 5 min; `Retry-After` wins |
| `key` | 401, or 403 with key vocabulary | 60 min; remembered on `/api/state` → `keyRejections` (base-url + fingerprint, never key material) |
| `model` | 403/404 with model vocabulary | **none — walk, don't bench**: another provider may carry the model |
| `transient` | 408, 5xx, connection failures | 1 min |

Client-caused failures (400/404) pass through untouched. A quota-classified 429 does *not* honor `Retry-After` — a short header would unbench into a still-closed window. `routing.failover.cooldowns` overrides every bench. A benched provider steers as zero headroom, so it leaves the target slot while a healthy candidate exists and the walk skips it in fallback position.

**Capability parity**: a fallback the roster declares unable to carry what the request holds (`manualModelRules`: `supportsImages`, `supportsTools`) is excluded from the chain *before* steering and journalled as a `parity:<capability>` ledger row. Undeclared caps gate nothing.

Every walk is marked `x-router-failover`, the failed attempt and the winner are separate ledger rows with the class in the reason (`+upstream-429:rate`, `+upstream-402:quota`), and each row carries `trigger` (operator / `app:<name>`) plus `costUsd` when the roster declares prices.

## Where the code lives

`router/usage.mjs`, `router/quota.mjs`, tier-walk logic in `router/server.js`; steering tuning via roster `routing.*`.
