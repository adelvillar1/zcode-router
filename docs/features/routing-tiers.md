# Feature: Routing tiers

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Workload tiers"), § Plans & Billing Safety.

## Purpose

Map a *workload* onto a concrete model for this machine, with ordered fallbacks so a machine missing a plan degrades to the next-best target instead of routing into a hole.

## The five tiers

| Tier | Used for | This machine resolves to |
|------|----------|--------------------------|
| `quick` | bulk delegation, cheap calls | token-plan/qwen3.8-flash |
| `standard_code` | ordinary coding | token-plan/qwen3.8-flash |
| `hard` | hard problems, mixture aggregator | zai-coding-plan/GLM-5.3-Flash |
| `prose` | writing | xiaomi-mimo/mimo-v2.6-flash |
| `deep_context` | very long inputs | stepfun/step-5-preview |

## Rules

- **Fallbacks fire only on absence** — target provider has no key or is `enabled: false`. Never for quality. Every fire is a *reported remap* (`kit status` / `apply` / `doctor`).
- `omniModel`, `wideModel`, and `mixture.aggregator` take ordered fallback lists the same way (first is preferred).
- **Capability rules always win over the judge**: images → `omniModel`; payload > `routing.wideChars` → `wideModel`. A text-only target cannot take an image; a small-context model cannot swallow a million characters.
- **Payg gate**: a `billing: "payg"` provider is refused as any tier target without `allowPayg: true` in the roster.
- `kit export` preserves fallback chains and tier notes from the roster it overwrites.

## Thinking levels

A picker profile may set `thinking: auto | deep | off` (default `auto` strips reasoning params). `deep`/`off` inject the provider's dialect param — `thinking` for zai/mimo, `enable_thinking` for token-plan/stepfun — mapped by `routing.thinkingStyles` (known providers pre-mapped). Built-ins: `deep` (hard tier, thinking on) and `bulk` (quick tier, thinking off). Thinking tokens share `max_tokens`; a thinking-on call at a tiny cap returns empty content.

## Where the code lives

- Tier resolution + fallbacks + payg refusal: `lib/roster.mjs`
- Tier table rendering: `lib/render.mjs`
- Runtime chain walk and thinking application: `router/server.js` (see `router/README.md`)
