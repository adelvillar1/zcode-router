# The memory plane, in ZCode

> Ported 2026-10-06 from the engine edition, where the plane lives:
> `agnostic-router-kit/lib/workflow/memory.mjs`. The engine's feature doc
> (`agnostic-router-kit/docs/features/memory-plane.md`) is the reference for
> the store's semantics — format, mnemosyne machinery, tiers, ranked recall.
> What this doc owns is what is specific to this edition: the one-store pin,
> the wires, the CLI group, and the probes.

ZCode's durable memory is the engine edition's JSONL graph — **one file on this
machine**, `~/.agnostic-router-kit/memory/memory.jsonl`, which ZCode's own
`mcpServers.memory` config already points its memory server at. The plane
module is shared (the kit resolves `workflow-plane` as a symlink to the engine
checkout), so this edition cannot drift from the store's semantics; what it
adds is its own surfaces onto the same file.

## The pin: one store, not one per edition

`memoryStorePath()` resolves `MEMORY_FILE_PATH` first, then the kit home. This
edition's kit home is `~/.zcode/router`, so without a pin the suite's memory
routes would have quietly created a **second graph** that never meets the one
ZCode's MCP server serves. Both entry points pin it:

- `router/server.js`, beside the `AGNOSTIC_ROUTER_KIT_HOME` pin — `MEMORY_FILE_PATH ??= ~/.agnostic-router-kit/memory/memory.jsonl`
- `lib/memory.mjs`, the CLI side's single place — same default, overridable for probes

`tools/probe-memory.mjs` section J proves the pin lands on the engine's store
when nothing overrides it, and `tools/probe-memory-api.mjs` section C proves a
probe-pinned store is honored by the server instead.

## The wires

| Wire | Who | Law |
|---|---|---|
| MCP stdio (`agnostic-router-kit/bin/agnostic-router-memory.mjs`) | any MCP harness — this is what ZCode's `mcpServers.memory` points at | nine tools, official-server names/schemas; `MEMORY_FILE_PATH` overrides the default |
| `GET/POST /api/memory` | operator token | search (`?q=`), stats, write — inside the operator-only `/api/` gate |
| `GET/POST /v1/memory` | app token | refused by name unless the app's `grantCeiling` includes `memory`; writes typed `app:<name>` |
| `kit memory …` | the terminal | the same store, atomically rewritten |

## The `/api/` gate is operator-only (the security fix)

The `/api/` block used to admit **any** valid bearer token — operator or app —
so an app token with an empty `grantCeiling` could hit the control plane from a
browser. Everything under `/api/` is operator-class now (roster rewrites, the
ledger, run answers); everything an app legitimately needs lives under `/v1`
and is scoped there. An app token gets `403 this surface needs the operator
token — apps act through /v1` on the whole block, memory included. The memory
probe asserts it directly (`app token gets 403 on the whole /api block`).

## The CLI group

```
kit memory stats | search <q> | remember <text> | scratch add|list|clear
kit memory facts [--conflicts] | consolidate [--dry-run] | resolve <loser> <winner>
kit memory invalidate <id> | gc [--dry-run] | config | import --from mnemosyne|official
```

`kit memory config` prints the `mcpServers.memory` snippet pointing at the
engine checkout's MCP bin (found as this kit's sibling; override with
`AGNOSTIC_ROUTER_KIT_DIR`) and names the pinned store. `kit doctor` gains a
memory-store line once the store exists. Consolidation's summaries are
deterministic-first with one fail-open `model: auto` call through this
edition's router (`lib/memory-summarize.mjs` reads `~/.zcode/router/config.json`
for the token and port) — an outage degrades to the extractive digest, it never
fails.

## Probes

| Probe | Checks | What it proves |
|---|---|---|
| `tools/probe-memory.mjs` | 49 | the full store + CLI contract through this edition's binary, with a scratch `MEMORY_FILE_PATH`, a scratch `ZCODE_HOME`, and the pin checks |
| `tools/probe-memory-api.mjs` | 15 | the wire law on a scratch router (8392): ceiling refusals, operator-only `/api/`, attribution in the router log, and the store landing on the pinned path — not this edition's kit home |

Both spawn scratch state only; neither touches the live service, the
canonical store, or the launchd label.

## Known limits

Same as the engine edition, stated here so this doc is honest standing alone:
concurrency is read-modify-write of the whole file under atomic rename (last
writer wins per write), search is substring rather than semantic, and the
store records what agents and operators declare — it extracts nothing on its
own.
