# zcode-router-kit

Installable, config-controlled model routing and workflow delegation for
[ZCode](https://github.com/zai-org/ZCode).

One roster file decides what a machine has; `kit apply` renders everything
ZCode reads. Clone the repo on a new machine, write its roster, set its keys,
and it comes up identical.

```
roster.json ──kit apply──┬── ~/.zcode/router/config.json      tier table, MoA, workflow registry
                         ├── ~/.zcode/v2/provider_config.json the providers the model picker shows
                         ├── ~/.zcode/workflows/*.dwf.ts       the delegation library
                         └── launchd / systemd service          keeps the router running
```

Requires Node ≥ 18 and nothing else. The router itself additionally needs
one npm dependency (`@typesafe-ai/sdk`), installed by `kit apply` into the
runtime dir when missing.

## What you get

- **A model roster** — the plans this machine has (token plan, Step plan, MiMo
  plan, Z.AI coding plan, …), each with its endpoint, its models, and its key
  referenced by env-var name only. Keys live in `~/.zcode/router/.env`
  (chmod 600) and in ZCode's own provider config — never in the roster, never
  in git.
- **A workload tier table** — `quick` / `standard_code` / `hard` / `prose` /
  `deep_context`, each mapping a workload onto a concrete model, with ordered
  fallbacks. A machine missing a plan falls back to the next-best target
  instead of routing into a hole.
- **Pay-per-token safety** — a provider marked `billing: "payg"` can never be
  a routing target unless the roster explicitly sets `allowPayg: true`.
  Registering one for the picker is still allowed; billing it as the router's
  default is not.
- **Router-decided delegation** — the router (one TypeSafe judgment per task,
  cached) picks the workload, the execution style (single / mixture / swarm),
  and which saved workflows run, in what order. The workflow registry is
  generated from the library's own `zcode-workflow` metadata blocks, so the
  library and the registry can never drift.
- **A workflow library** — the saved dynamic workflows in `workflows/`,
  installed into `~/.zcode/workflows/` without ever deleting files the user
  added locally.

## New-machine quickstart

```bash
git clone <this repo> zcode-router-kit && cd zcode-router-kit

# 1. a roster to edit — either the documented template or a copy of a live machine's
node bin/zcode-router-kit.mjs init --template      # or: kit init   (on the source machine, then commit roster.json)

# 2. the keys this machine has (names come from the roster)
node bin/zcode-router-kit.mjs env set XIAOMI_MIMO_API_KEY=… STEPFUN_API_KEY=…

# 3. render + install everything, then check it
node bin/zcode-router-kit.mjs apply --dry-run      # see exactly what would change
node bin/zcode-router-kit.mjs apply
node bin/zcode-router-kit.mjs doctor               # --live also probes each provider
```

Then in ZCode: run `LogModels` to confirm the roster appears, and pick
`auto-router/auto` (or a pin like `quick` / `hard` / `long-context`).

## Everyday use

```bash
kit status                 # what is installed, which tiers resolved, router health
kit doctor [--live]        # full verification of the whole chain; changes nothing
kit workflows list         # library, install state, and router-assignability per workflow
kit workflows sync         # copy the library into ~/.zcode/workflows
kit route "audit the docs tree for staleness"   # ask the running router for its verdict
kit apply                  # render + install + restart + health-check (idempotent)
kit upgrade                # git pull && kit apply
```

## Configuring the roster

`roster.json` is the only file you edit by hand. Full documented example:
`templates/roster.defaults.json`.

**Providers** — what exists on this machine:

```json
"providers": {
  "xiaomi-mimo": {
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "apiKeyEnv": "XIAOMI_MIMO_API_KEY",
    "billing": "plan",
    "models": ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
    "featured": ["mimo-v2.6-pro", "mimo-v2.6-flash"]
  },
  "zai-coding-plan": {
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "apiKeyEnv": "ZAI_CODING_API_KEY",
    "billing": "plan",
    "routerOnly": true
  }
}
```

`routerOnly` providers keep their key in the router's `.env` (they are not
registered in ZCode's picker); everyone else gets a provider-config entry
generated from the roster. `templateId` (no `baseUrl`) reuses a template the
app already knows, e.g. DeepSeek. `featured` sets `personalModelIds`; omit it
to expose every model.

**Capabilities the app can't infer** — context windows, reasoning knobs,
input formats:

```json
"manualModelRules": [
  { "providerId": "xiaomi-mimo", "modelId": "mimo-v2.6-pro",
    "config": { "enabled": true,
      "properties": { "contextWindow": 1000000, "inputFormat": { "supportsImage": true, "supportsVideo": true } },
      "optionSpecs": { "reasoningLevel": { "values": ["disabled", "enabled"] }, "maxOutputTokens": { "max": 131072 } } } }
]
```

**Tiers** — workload → model, with fallbacks for machines that lack a plan:

```json
"tiers": {
  "hard": { "target": "zai-coding-plan/GLM-5.3-Flash",
            "fallbacks": ["stepfun/step-5-preview", "xiaomi-mimo/mimo-v2.6-pro"] },
  "prose": { "target": "xiaomi-mimo/mimo-v2.6-flash", "fallbacks": ["token-plan/qwen3.8-flash"] }
}
```

**Delegation** — picker profiles map onto tiers; `mixture` fans a hard task
out to several proposers with a judge that integrates when merging adds value:

```json
"profiles": { "quick": { "workload": "quick" }, "vision": { "use": "omniModel" }, "mixture": { "use": "mixture" } },
"mixture": { "proposers": ["zai-coding-plan/GLM-5.3-Flash", "xiaomi-mimo/mimo-v2.6-pro", "stepfun/step-5-preview"],
             "aggregator": "zai-coding-plan/GLM-5.3-Flash", "proposerTimeoutMs": 240000 }
```

**Workflow assignment shapes** — one line per saved workflow describing the
problem shape that should route to it (auto-derived from the workflow's own
metadata when omitted):

```json
"workflows": { "shapes": { "swarm": "a large task that decomposes into several substantial independent parts…" },
               "registry": { "review-sweep": { "taskArg": "task", "defaults": { "base": "" } } } }
```

## Adding a workflow

Drop the `.dwf.ts` file into `workflows/` and run `kit apply`. Its metadata
block supplies the description, the task argument, and (if you add the
shape) the routing entry. Nothing else to register.

## Safety model

- `kit apply` backs up `provider_config.json` before every write and refuses
  to write a schema it doesn't understand (`schemaVersion` must be 1). The
  app validates that file strictly: any violation degrades the whole personal
  config to account-only providers, so the merge is surgical — it rewrites
  only the keys the kit owns and leaves app-managed rules untouched.
- A keyless roster provider can never remove a working registration; removal
  is an explicit `enabled: false` in the roster.
- Pay-per-token providers are unreachable as routing targets unless the
  roster opts in.
- `kit apply --dry-run` writes nothing and prints the planned diff.

## Layout

```
roster.json                 this machine's roster (gitignored; contains no keys)
roster.json.example-style template: templates/roster.defaults.json
bin/, lib/                   the CLI (zero runtime dependencies)
router/server.js             the router itself (OpenAI-compatible proxy)
router/README.md             router internals: routing order, judgment, MoA, logs
workflows/                   the delegation library (.dwf.ts files)
templates/roster.defaults.json       every roster field, documented
templates/systemd/                   the Linux user unit
docs/upstream-contribution.md        plan for contributing back to ZCode
```

## Known limits

- Routing is OpenAI chat-completions only.
- The judgment (TypeSafe Jev) adds ~1–3s to the first request of a task;
  subsequent requests in the same task are cache hits. A judge outage
  degrades to the default workload — it never fails a request.
- `kit` manages macOS launchd and Linux systemd user units; on other
  platforms it tells you how to run the router by hand.
- No artificial token limits are imposed anywhere; `routing.wideChars` only
  diverts payloads beyond a smaller model's window to a 1M-context model.
