# Contributing back to ZCode

Everything in this kit was built against ZCode's real extension points. This
document maps the kit onto the upstream repo (`zai-org/ZCode`, Apache-2.0) so
the contribution is a merge, not a rewrite — and marks the spots that need a
maintainer decision before any PR.

**Nothing has been pushed to upstream yet.** Tier 3 has landed (its four
workflows are folded into `workflows/` below), so the sequencing condition is
met; the PR itself is the next action and has not been opened.

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
  saved-workflows/frontmatter.ts`, the contract lives in
  `apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts`, the runtime
  is `apps/zcode-cli/packages/dynamic-workflow-runtime/`, and the sandbox
  child is `apps/zcode-cli/packages/cli/src/dwf-child-command.ts`.
  The workflow library in `workflows/` is already in the upstream format.
- Skills ship in-repo at `.agents/skills/<name>/SKILL.md` — 8 of them, and
  nothing else is distributed that way.
- **No CI** (`.github/workflows/` does not exist) and **no project reference
  graph**. Conventions live in `AGENTS.md` / `CONTEXT.md` / `DESIGN.md` /
  `NOTICE.md` — all four read on 2026-09-24. `NOTICE.md` is the licensing and
  third-party disclosure doc; `CONTEXT.md` is the plugin-store vocabulary.

### What the channel does not have

- **Issues are disabled** on the repo (`has_issues: false`). There is no issue
  channel to ask a maintainer question in.
- **There are no pull requests at all** — zero open, zero closed, ever. The
  repo is pushed to directly. A PR is still openable, but there is no
  precedent for one being reviewed, so a PR must carry its own context: what
  it is, why it is inert, and what decision it is really asking for.
- Saved workflows are **undocumented in every README** (`README.md`,
  `README.en.md`, `apps/zcode-cli/README.md`), and there is **no user-facing
  CLI command** for them — `__zcode-dwf-child` is a hidden SEA-internal
  sandbox entry. Workflows are listed and run through the model-facing
  `SaveWorkflow` / `ListSavedWorkflows` / `CreateWorkflow` tools, so
  installing a pack is just copying files into `.zcode/workflows/` (project
  scope) or `~/.zcode/workflows/` (global scope).
- **No distribution path exists** for saved workflows. `CONTEXT.md` defines
  the plugin manifest as `plugin.json` with `commands/agents/skills/
  hooks/mcpServers/userConfig` — workflow is not a component kind, and
  `plugin-components.ts` confirms it. The Official Marketplace
  (`zcode-plugins-official`, builtin + CDN plugins) therefore cannot carry a
  workflow pack today. That is the real question the PR has to ask.

## The saved-workflow contract (what the pack must satisfy)

Verified against `saved-workflow.ts` and `frontmatter.ts`:

- File extension `.dwf.ts`; the name must match `^[A-Za-z0-9_.-]+$` and be
  ≤ 64 characters. Filenames double as the workflow name, which is why the
  pattern is a path-traversal defense rather than a style rule.
- Frontmatter opens with a line that is exactly `/* zcode-workflow` as the
  first non-blank line, and closes at a line whose trim is exactly `*/`.
- The body is YAML, and `SavedWorkflowMetaSchema` is `.strict()`: only
  `description` (required, non-empty), `whenToUse`, and `args`. Arg
  declarations are strict too: only `type` (`string|number|boolean|json`),
  `description`, `required`, `default`.
- Everything after the terminator is the script, preserved **byte for byte** —
  `serializeSavedWorkflow` re-emits it verbatim so a save/read round-trip is
  stable. A repo-wide formatter rewriting these files would break that.
- Listing tolerates one bad file rather than failing the whole scan, and names
  it as invalid rather than silently dropping it.

## Verification done on `workflows/` (2026-09-24)

Run with upstream's own `yaml` package and the rules above — checker kept at
`/tmp/dwf-conformance/check.cjs`:

- **32/32 conform**: names valid, frontmatter well formed, metadata
  strict-clean, non-empty scripts.
- **Every file round-trips byte-for-byte through `serializeSavedWorkflow`'s
  rules** (fixed key order `description` → `whenToUse` → `args`, sentinel line,
  YAML body, terminator line, script verbatim). Parse any of the 32, re-emit it,
  and you get the same bytes back — that is what makes a save/read cycle stable
  and what the resume comparison is measured against, and it is what justifies
  the `.prettierignore` entry. The four Tier-3 workflows were generated with the
  same `yaml` package and the same call shape, so their frontmatter is what the
  serializer emits rather than a hand-approximation of it.
  **This is a round-trip property, not a provenance claim.** 31 of the 32
  scripts were edited after the app wrote them, because upstream's own `pnpm
  lint` failed on this directory — see the lint bullet below. Only
  `swarm.dwf.ts` is untouched. The edits are all inside the script body, which
  the serializer preserves verbatim, so the round-trip still holds; but "these
  are exactly the bytes the app wrote" is **not** true of this pack and the PR
  body says so.
- **`pnpm lint` (oxlint) — measured, and it failed until the pack was fixed.**
  With upstream's own `.oxlintrc.json` and the pinned binary (1.57.0):
  pristine repo root exits 0 with 70 warnings and 0 errors over 2616 files;
  the same root with `workflows/` added exits **1** with 70 warnings and
  **21 errors**, every one of them `eslint(max-lines)` inside `workflows/`
  (2648 files); the same root after the fix below exits 0 again; and
  `workflows/` alone under that config reports 0 warnings and 0 errors.
  An earlier version of this file claimed the rule was "inert under
  `"plugins": null`" — **that claim was wrong and is corrected here.** It was
  never true: the repo's own long files survive `max-lines: 400` because
  `apps/zcode-cli`, `.agents/skills`, `packages/formal-proof`, the vendored
  `packages/ui/src/components/{ui,ai-elements}` and `docs/electron` sit in
  `ignorePatterns`, and the long files outside those carry an explicit
  `/* eslint-disable max-lines -- <reason> */`.
  Two rounds of real defects were found by that run and fixed rather than waived:
  - **13 `no-unused-vars` warnings.** Nine orphaned `interface WorkflowReport`
    blocks (declared once, never referenced) — removing them orphaned two more
    declarations, `decision-memo`'s `interface Finding` and `research-report`'s
    `interface WorkflowReport`, which went too. Also a redundant
    `const checked = await Promise.all(…)` in research-report whose value was
    never read (each check already reports and pushes inline), an orphaned
    `type DomainAuditList = DomainAudit[]` in ui-implementation-review
    (`DomainAudit[]` never appears in the file), and a dead
    `const tasksUsable = usableKind("tasks")` in weekly-review-planning (only
    the calendar kind is ever read; task-source availability is already
    disclosed by the source-availability report loop above it). All removed.
  - **21 `max-lines` errors.** A saved workflow is one self-contained script by
    contract and cannot be split into modules, so each of the 21 files carries
    `/* eslint-disable max-lines -- … */` as the first line of its *script
    body*. That keeps the suppression inside the bytes the app preserves, so
    `serializeSavedWorkflow` re-emits it verbatim and the byte-exact
    round-trip still holds; it is also the in-repo precedent for exactly this
    case. No shared lint config is touched, which means every other rule — the
    ones that caught the 13 warnings above — still applies to the directory.
- **`oxfmt` 0.41.0 rewrites these files, so `workflows/` is excluded from the
  formatter too.** Measured with the pinned binary: `oxfmt --check` on a
  scratch copy of `design-review.dwf.ts` grows it from 41255 to 42158 bytes
  (breaking a `||` chain across lines, appending a trailing comma), and
  `oxfmt --check .` on the pristine upstream repo already exits 1 with 32
  files flagged — `workflows/` without the ignore entry makes that 64, with it
  the number stays 32. `oxfmt` does read `.prettierignore`, confirmed by the
  count dropping to zero for the directory. `serializeSavedWorkflow` re-emits
  the script byte for byte so that a save/read round-trip is stable, and a pack
  that has been through the repo formatter is no longer what the app itself
  writes — that is the reason for the entry, not a style preference.
- The pack is inert by construction: the root `pnpm-workspace.yaml` globs are
  explicit (`packages/*`, `apps/zcode-cli`, `apps/zcode-cli/packages/*`,
  `apps/zcode-cli/tools/*`) so a new top-level directory is not a workspace
  package, and `pnpm typecheck` builds named projects, so no typecheck covers
  it. `verify:pre-push` runs `lint` over the whole repo, so it **did** fail on
  this pack until the `max-lines` errors above were fixed in the files; it is
  green now, and `architecture:check --changed` does not cover a directory that
  adds no package.
- No library file imports anything — the two `require(` hits are inside
  `world.run("node", ["-e", …])` strings. Every workflow is self-contained.

### Tier 3 fold-in (2026-09-24, this session)

The four Tier-3 drafts were produced by a 7-phase swarm run
(`dwfrun-30f13f09-cdce-434f-8b83-8994a475c4f5`): four parts built in parallel,
each with an independent reviewer and a bounded fix loop, then an integrator and
a fresh reader over the integrated deliverable. What was verified on the delivered
bytes before they were added to the pack:

- **The named compile check, run on the delivered bytes.** Each draft's script
  (taken from the pack file after the terminator, so this is exactly what ships)
  wrapped as `{ printf 'async function __probe__() {\n'; cat <script>; printf
  '\n}\n'; }` and checked with `npx tsc --noEmit --strict --target es2022
  --module esnext --moduleResolution bundler --skipLibCheck wrapped.ts
  workflow-facade.d.ts` — **EXIT=0, 0 diagnostics for all four**. The facade is
  the same minimal one the drafts were built against, so this is the check the
  drafts were authored to, not a re-derived one.
- **The check is not vacuous.** A deliberately broken body (`const x: number =
  "not a number"`) exits 2 with `error TS2322`, so a green result means the
  checker can fail.
- **The pack is inert to the installed copy too**: the four synced files in
  `~/.zcode/workflows` are byte-identical to the pack, and that directory also
  reports 32/32 conform.

Two defects the integrator confirmed by reading the bytes, fixed here before the
pack grew:

- `ui-implementation-review.ts` claimed confirmers ran "on every high/medium
  finding" while `MAX_CONFIRMATIONS_PER_DOMAIN = 8` ships a domain's 9th+ such
  finding as `confirm-cap-reached`/unconfirmed. The summary line now states the
  cap.
- `design-review.ts` had a phase named "…and publish the design review", where
  "publish" is facade machinery a user never chose. Renamed to "write up".

Two more phase names carried the machinery vocabulary the dynamic-workflows
skill's §8 forbids (`gate`, `grep`), and were renamed too: spec's "Survey the
repository's verification gates" / "Re-check the gates after the tree changed"
and ui's "Run the deterministic checklist greps". The part fix loops had already
cleared the rest of that class (including a banned `export {};` in design-review
and an orphan phase marker in spec).

`design-review.ts` also gained one behaviour fix so it can be delegated
honestly: `args.target` was fed straight to `files.glob`, so a router passing the
user's sentence through as the task argument would silently match nothing and
audit the whole workspace instead of the named surface. A value that carries glob
or path syntax is still used as a glob; anything else is now treated as a hint
and the discovery pass decides the surfaces.

### The lint/formatter sweep over the whole pack (same session)

After the fold-in, the entire 32-file pack was put through upstream's own
tools rather than assumed to pass. It did not: `oxlint` with the repo's
`.oxlintrc.json` reported 13 `no-unused-vars` warnings and 21 `max-lines`
errors, and `oxfmt --check` flagged all 32 files. Every one of those was
measured, fixed in the files, and re-measured — see
[Verification done on `workflows/`](#verification-done-on-workflows-2026-09-24)
for the commands and the before/after numbers. An earlier note in that section
had asserted the `max-lines` rule was inert; that was wrong and is corrected
there rather than quietly dropped.

## Contribution shape (the PR)

- New top-level `workflows/` holding the library exactly as ZCode's own
  `SaveWorkflow` writes it, plus `workflows/README.md` covering the two
  install directories, the scope difference, and the fact that these are
  model-facing rather than CLI-facing.
- One entry in `.prettierignore` for `workflows/`, with a comment in the
  file's existing voice citing the byte-exact script rule in
  `frontmatter.ts`. Everything else in that file is untouched.
- `eslint-disable max-lines` headers inside 21 of the scripts, and the dead
  declarations removed from the 12 files above. Both of those are inside the
  files themselves, so **no shared config is modified** — the PR is the
  directory plus the one `.prettierignore` line and nothing more.
- The PR body states what the pack is, that it touches no code path, and asks
  the one question upstream has to answer: where should saved workflows be
  distributed from — a bundled pack, a plugin component kind that does not
  exist yet, or first-run seeding of `~/.zcode/workflows/`? It also states
  plainly what was measured, including the lint run that failed first: a pack
  that ships green only because its directory is exempted would be a worse
  contribution than one that survived the repo's own rules.

### Prepared state, and the one thing that is not done

The PR is prepared to a single command and has **not** been opened — the
current PAT cannot reach `zai-org/ZCode`:

- `gh repo fork zai-org/ZCode --clone=false` → `HTTP 403: Resource not
  accessible by personal access token` (re-tried; still 403).
- Direct push to `zai-org/ZCode` is refused, and SSH push to it fails too.

Both were checked rather than assumed, and neither is a repo-state problem:
upstream `main` is at `29628c9` and the prepared branch is based on exactly
that commit.

The branch is already built and verified at `$TMPDIR/zcode-upstream-pr`
(`contrib/workflow-pack`, commit `253b1e0`): add-only, 34 files, 24511
insertions, 0 deletions, with `.prettierignore` the sole pre-existing file
touched (+6 lines). Re-verified on that branch with the pinned binaries:
`oxlint` exits 0 (70 warnings, 0 errors, 2648 files), `oxfmt --check` flags
32 files with none inside `workflows/`, and `tools/verify-pack.mjs` reports
32/32 conform and 32/32 byte-exact round-trip. A `diff -r` against
`workflows/` shows the prepared pack is byte-identical to this repo's.

Two pieces of tooling back this, both committed and pushed:

- `tools/verify-pack.mjs` — the contract check described in
  [Verification done on `workflows/`](#verification-done-on-workflows-2026-09-24),
  runnable on any checkout. It resolves upstream's own `yaml` package (the
  emitter the round-trip must match, so it cannot be substituted) from the
  script's location, then a checkout given by `ZCODE_REF_CLONE`.
- `bin/open-upstream-pr.sh` — the whole sequence in one idempotent command:
  fork, clean clone of `main`, copy the pack, add the `.prettierignore`
  entry, install the pin-matched gate tools, gate on lint plus the pack's
  own checks, commit, push, open the PR with `docs/upstream-pr-workflow-pack.md`
  as the body. A clean clone has no `node_modules`, which would have made
  both gates vacuous, so it installs `yaml@^2.9.0 oxlint@1.57.0
  oxfmt@0.41.0` — the versions every number in the PR body was measured
  with — into a scratch prefix first. The whole gate sequence was dry-run on
  a fresh clean clone with the pack applied and all three behaved as the PR
  body claims.

So the only remaining step is permission, not preparation: grant the PAT
fork access on `zai-org/ZCode` and run `bin/open-upstream-pr.sh`, or open the
PR by hand from the prepared branch using the body already in the repo.

There is a route that needs no fork permission at all, and it is deliberately
**not** taken here: push the prepared clone's `contrib/workflow-pack` branch
into any repo under `adelvillar1`, then `POST /repos/zai-org/ZCode/pulls`
with that branch as `head`. Because the branch was cloned from upstream it
shares history, so the computed diff is the same add-only 34-file patch — a
fork is only a convenience for how GitHub labels the head repo. The reason to
hold off is that it means publishing a repo containing a full copy of ZCode
to hand GitHub a head to compare, which is a bigger and more public act than
opening one PR; that is the user's call, not a workaround to take quietly.

## Candidate: the model router (not contributed)

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

## Candidate: roster-driven provider materialization (design argument, not a PR)

What this kit learned the hard way: `~/.zcode/v2/provider_config.json` is
strictly validated, and *any* malformed entry degrades the entire personal
config to account-only providers (providers silently vanish — a bad failure
mode for a settings file). The kit's mitigation — never rewrite unknown keys,
back up before write, re-parse before landing, keyless providers can't remove
working registrations — is a defense the app itself could own:
validate-then-merge with per-rule rollback, or per-provider error isolation
in `personal-provider-config-repository.ts`.

This is the strongest *design* contribution: a robustness argument backed by a
real support-shaped failure, not a feature request. It wants a PR against that
file plus the Chinese-language bug-cause comment `AGENTS.md` asks for, and it
should wait until the workflow-pack PR has been through review so the
maintainers' expectations are known.

## What NOT to contribute

- The roster file format and the `kit` CLI — local convenience, upstream has
  its own config surfaces.
- The launchd/systemd install logic — desktop app concern, not agent CLI.
- Machine-specific endpoints and keys — obviously.
- For any router PR, note `AGENTS.md` forbids credentials in logs, examples
  and commits and asks for bug-fix comments in Chinese; the kit's docs are
  English-first, so an upstream PR would be written to their conventions from
  the start.
