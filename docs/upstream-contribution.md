# Contributing back to ZCode

Everything in this kit was built against ZCode's real extension points. This
document maps the kit onto the upstream repo (`zai-org/ZCode`, Apache-2.0) so
the contribution is a merge, not a rewrite — and marks the spots that need a
maintainer decision before any PR.

**Nothing here has been pushed. This is a plan; the user reviews before
anything lands on their GitHub account.**

## Repo facts (verified 2026-09-24)

- pnpm workspace; the agent CLI is its own workspace at `apps/zcode-cli`
  (`apps/zcode-cli/packages/*`).
- Personal providers are a first-class, file-backed system:
  `packages/provider-node/src/personal-provider-config-repository.ts`,
  `provider-config-file-codec.ts`, `provider-config-runtime.ts`, and the
  built-in-config materializers (`zcode-builtin-provider-config-*.ts`).
  `~/.zcode/v2/provider_config.json` — the file this kit surgically merges
  into — is that repository's own format (`schemaVersion: 1`).
- Saved dynamic workflows are native: the `/* zcode-workflow */` metadata
  block is parsed by `apps/zcode-cli/packages/core/src/tool/handlers/
  saved-workflows/frontmatter.ts`, the runtime is
  `apps/zcode-cli/packages/dynamic-workflow-runtime/`, and `.dwf` files are
  first-class CLI subjects (`apps/zcode-cli/packages/cli/src/dwf-child-command.ts`).
  The workflow library in `workflows/` is already in the upstream format.
- Skills ship in-repo at `.agents/skills/<name>/SKILL.md`.
- No `CONTRIBUTING.md`; conventions live in `AGENTS.md` / `CONTEXT.md` /
  `DESIGN.md` / `NOTICE.md` (read all four first — `NOTICE.md` covers
  licensing/third-party scope).

## Contribution candidates, ordered by upstream fit

### 1. The workflow library → `.agents/skills/`-adjacent "workflow pack" (best fit)

What: `workflows/*.dwf.ts` — 28+ compiler-proven workflows (swarm with
router-decided topology, review-sweep, bug-hunt, migration, deep-dive,
adversarial-solve, postmortem, …), each a saved dynamic workflow in the
repo's own format.

Why it fits: it needs no new machinery — the runtime, the CLI (`dwf`), and
the metadata parser all exist. A "pack" is just files plus a way to install
them into the user's saved-workflows directory.

Open question for maintainers: is there an intended distribution path for
saved workflows (a bundled pack, a plugin marketplace entry, or
`~/.zcode/workflows/` seeding at first run)? If yes, this is a docs-and-files
PR. If not, candidate 2's `kit workflows sync` logic is the implementation
reference.

### 2. The model router → an optional local provider (needs a decision)

What: `router/server.js` — an OpenAI-compatible local proxy that routes each
request by workload, with a judge (TypeSafe Jev or any pluggable judge)
picking workload + execution style, mixture-of-agents for hard one-shot work,
and a cached judgment per task.

Why it fits: ZCode's provider layer already accepts arbitrary
`openai-chat-completions` personal providers — the router registers as one
provider with a single `auto` model. The interesting upstream question is
whether that should be a shipped **provider template** (registerable through
the app's provider UI) rather than a hand-written personal-provider entry.

Needs a maintainer decision:
- Should a local proxy be a first-class provider template, or is the
  personal-provider path enough?
- The judge dependency (`@typesafe-ai/sdk`) is external; upstream will want a
  pluggable judge or a built-in default.

### 3. Roster-driven provider materialization (design smell worth upstreaming)

What this kit learned the hard way: `~/.zcode/v2/provider_config.json` is
strictly validated, and *any* malformed entry degrades the entire personal
config to account-only providers (providers silently vanish — a bad failure
mode for a settings file). The kit's mitigation — never rewrite unknown keys,
back up before write, re-parse before landing, keyless providers can't remove
working registrations — is a defense the app itself could own:
validate-then-merge with per-rule rollback, or per-provider error isolation
in `personal-provider-config-repository.ts`.

This is the strongest *design* contribution: it is a robustness argument
backed by a real support-shaped failure, not a feature request.

## Suggested sequence

1. Read `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, `NOTICE.md`.
2. Open an **issue** titled around the workflow pack (candidate 1) — smallest
   blast radius, highest immediate value, no architectural decisions.
3. Issue for candidate 2 (local router provider) describing the routing
   contract and asking the provider-template question.
4. Only then a PR; expect review to push toward in-repo conventions over the
   kit's bespoke roster format (that is fine — the roster is the kit's local
   convenience, not a proposal for upstream config).

## What NOT to contribute

- The roster file format and the `kit` CLI — local convenience, upstream has
  its own config surfaces.
- The launchd/systemd install logic — desktop app concern, not agent CLI.
- Machine-specific endpoints and keys — obviously.
