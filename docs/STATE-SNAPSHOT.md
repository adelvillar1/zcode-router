# State Snapshot

> Dated replacement file — **replace this content, don't append.** Stat tables live here, not in topical docs.

## 2026-10-06

- Memory plane: live. The store is the engine edition's `~/.agnostic-router-kit/memory/memory.jsonl` (460 entities, 10 relations at port time), pinned by `MEMORY_FILE_PATH` in `router/server.js` and `lib/memory.mjs`. Probes: `tools/probe-memory.mjs` (49 checks) and `tools/probe-memory-api.mjs` (15 checks); `tools/probe-run-api.mjs` unchanged at 33.
- Router runtime: `kit apply --only router` shipped the plane beside the router (`~/.zcode/lib/workflow`, 15 modules current per `npm run check:port`); the serving process still runs the pre-port `server.js` until the service restarts.

## 2026-09-29

- Router: up on `127.0.0.1:8300`; launchd `com.zcode.model-router` loaded; `kit doctor` fully green.
- Workflows: **32** installed in `~/.zcode/workflows` — 19 router-assignable, 13 hand-launched.
- Tiers resolved: quick & standard_code → token-plan/qwen3.8-flash · hard → zai-coding-plan/GLM-5.3-Flash · prose → xiaomi-mimo/mimo-v2.6-flash · deep_context → stepfun/step-5-preview. No remaps.
- Providers: deepseek, xiaomi-mimo, token-plan, stepfun registered in ZCode's picker; zai-coding-plan router-only; mixture proposers 3 usable; aggregator zai-coding-plan/GLM-5.3-Flash.
- Mixture aggregator tier: `hard`.
- Registry: 19 task-arg registrations in the roster.
- Working tree: `roster.json` modified (uncommitted).
