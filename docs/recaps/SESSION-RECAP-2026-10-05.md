# Session Recap — 2026-10-05

## What shipped

**The workflow plane is its own package, and `engine.mjs` is orchestration and nothing
else.** Two repos, ten commits, plan
[2026-10-05-plane-package-and-engine-split.md](../plans/2026-10-05-plane-package-and-engine-split.md)
(status: completed; C0–C11 all checked).

**Phase A — the package boundary.**

- **Engine `905e2fe`** — `tools/compare-journals.py` plus the step-1 journal baseline
  (checkpoint 50 events, context 99, commands 101). The comparator strips only `t` and
  `ms` and compares event kind and field sequence; it also proved itself by refusing a
  comparison assembled from two runs of the same launch rather than quietly matching.
- **Engine `37e7a77`** — `lib/workflow/` becomes `workflow-plane@1.0.0`: `type: module`,
  an exports entry per module, zero runtime dependencies. The package's `check` script
  is generated from the exports map, so a new module joins the syntax gate by declaring
  itself.
- **Engine `e45bdde`** — eight import sites repointed to the specifier; `grep
  "\.\./lib/workflow\|\./workflow/" lib router bin` returns nothing outside the package.
  `copyRuntime` now iterates `manifest.exports` and throws if a declared file is not on
  disk, so a missing module is an apply-time error rather than a hole in a running router.
- **Kit `50b43d1`** — the kit's tracked copy of the plane is deleted and the package is
  resolved as a `file:` dependency on the engine checkout; `tools/check-plane.mjs`
  (`npm run check:port`) asserts the resolution, the absence of a second copy, and the
  installed runtime beside the router. Broken on purpose once and it failed by name.

**Phase B — the engine split, ascending risk.** Four concerns out of `engine.mjs`, each
one commit, each with its own offline check: `coerce.mjs` (`873c14a`, 29 cases),
`transport.mjs` (`41004bc`, 9 cases against a stubbed fetch), `gitworld.mjs` (`a760878`,
8 cases against real repositories), `runstate.mjs` (`02a06a8`, 10 cases), and
`context.mjs` last (`7aa1415`, 11 cases). `engine.mjs` went from 1471 lines to 829 and
keeps only `runWorkflow`, `makeAgent`/`askLoop`, `answerEscalation` and the two
re-exports that keep its consumer-facing surface at four names.

**Phase C — close-out.** Eleven model-calling regression runs, every one through the
kit's own bin so the plane loaded was the kit's resolved package; the three guards
(journal baseline, both editions' doctor, config sha) green; both editions' contract
docs updated; plan flipped to completed.

## Criteria status (verification evidence)

**The three guards, after every step and again at close-out** (`tools/guard.sh`):

- guard 1 — `compare-journals.py` exit 0 against the step-1 baseline: checkpoint-probe
  identical (50 events), commands-probe (101), context-probe (99), `t`/`ms` stripped.
- guard 2 — the kit's doctor green ("everything checks out"); the engine edition at its
  pre-existing 13 problems, which is the development checkout with no `.env`, no
  provider keys and no installed service. The guard is that the count does not move, and
  it did not.
- guard 3 — `shasum -a 256 ~/.zcode/router/config.json` =
  `d32a694cde0b25ce2ff91d91b7274c7766dceb1d340d6f9a0f9581b277672f07`, recorded before
  step 2, after step 9, and again at close-out.

**Check 3 (close-out).** The kit resolves `workflow-plane` → the engine checkout, and its
`engine.mjs` prints exactly `KIT_WORKFLOW_RUNS, answerEscalation, fmtTokens, runWorkflow`.
`npm run check:port` green.

**Check 10 (close-out): the model-calling regression set**, run through
`node <kit>/bin/zcode-router-kit.mjs workflows run <engine workflows/*.ts>` in a scratch
git workspace, journals under a throwaway `AGNOSTIC_ROUTER_KIT_HOME`:

| Probe | Result |
|---|---|
| `grants-probe`, default | 3 fired inside their grant, 2 refused outside |
| `grants-probe`, `--grant package` | 4 fired, 1 refused — the install fires |
| `services-probe`, no grants | 9/9 as their grants allow |
| `services-probe`, `--grant package,net-fetch --allow-domain example.com` | 9/9, the live allowlisted fetch and the dev-server lifetime cap included |
| `services-probe`, `--grant net-fetch` with no allowlist | 9/9 — fail closed: a grant without an allowlist fetches nothing |
| `edit-probe` | the unique edit applied; the zero-match and the ambiguous match refused |
| `delegate-probe`, granted | a real sub-agent read the ledger and its answer returned to the parent intact (2 agent calls) |
| `delegate-probe`, ungranted | refused, and the refusal named the capability |
| `escalation-probe`, `--answers` | the operator's answer came back verbatim |
| `escalation-probe`, no answers | the no-owner clause came back |
| `runtime-surface-probe` | 4 phases, 2 agent calls, artifact published, escalation reachable from inside an agent |

Two of these landed in the same second and produced `…-grants-probe` and
`…-grants-probe-2`, both journals intact — the collision path proved live rather than
only in the unit check.

A first pass of the same set, run into an empty scratch directory, reported
`grants-probe` 2 fired / 3 refused and one `services-probe` UNEXPECTED. Both were
workdir artifacts (no `package.json` to read, none to restore), not plane behavior; the
table above is the re-run in a proper scratch repository. The workdir is an input to a
probe, so it belongs in the evidence.

**C9's two probes** (`budgets-probe`, `tokens-probe`) pass by journal *shape*, not by
content. This was established rather than asserted: running the pre-move plane against
itself produced different token counts and different summarizer prose, while the
structural comparison held (19/19 on budgets, 10/10 on tokens with one differing field —
the summarizer's own text).

## Security notes

No secrets were written to tracked files or outputs. The probes ran against the live
router on `127.0.0.1:8300` with its own token; the only credentials touched were read
from the kit's `.env` by the CLI itself. The one experiment that needed a different
`HOME` (`kit apply --dry-run` against a throwaway home, to see the copy step fire) wrote
nothing and left the live install and config untouched — verified by sha and by file
count afterwards. `~/.zcode/router/config.json` is byte-identical across the whole
session, and the installed runtime beside the router is a faithful copy of the package's
exports (all 14 modules).

## Notes / follow-ups

- **No `index.mjs`.** It was a recommendation, not a criterion, and the split argued
  against it: `engine.mjs` re-exports `KIT_WORKFLOW_RUNS` (from `runstate.mjs`) and
  `fmtTokens` (from `context.mjs`), which is what keeps the consumer-facing surface at
  four names and both editions' CLIs diff-free.
- **C10's literal wording is unsatisfiable, and the working form is recorded.**
  "The union of every module's exports matches the pre-split export list exactly" cannot
  hold, because package-internal cross-module imports must be exported for specifier
  imports to resolve. The guarantee that survives is the consumer-facing one, and it held
  at every step.
- **`emit_compact` is dead code and stayed.** Unreachable since the compaction work
  landed (`e350061`); moved with its concern rather than deleted, to keep the split pure
  code motion. Deleting it is a deliberate one-line change someone can make.
- **A latent `briefIdx` issue, found but not fixed.** After the first compaction shifts
  `messages`, `acct.briefIdx` is not re-captured, so a second compaction in the same ask
  can take the brief by a stale index and drop it. It predates this work and is invisible
  at the current compaction frequency. It is exactly the invariant the step-9 ordering
  existed to protect, which is why it is written down here.
- **The engine edition's doctor stays red on this machine by design** — no `.env`, no
  provider keys, no installed service. Anyone re-running the guard on another machine
  should record that machine's own `ENGINE_BASELINE_PROBLEMS`.
- **`kit apply --dry-run` names no copy step while the install is current**, because
  `copyRuntime`'s lines are idempotent. The shipping path is evidenced by the install's
  history instead: each module appeared beside the router at its own step's apply.

## The board — later the same day

**The plan→recap graph became a kanban board, because "where does the work stand"
is a board question, not a graph question.** Plan
[2026-10-05-kanban-board.md](../plans/2026-10-05-kanban-board.md) (status:
completed; twelve checkboxes — the three use cases as C0–C2 and nine acceptance
criteria as C3–C11). The tab keeps the DAG one toggle away over the same model,
and the board is the default view.

**The board on this machine's real data**: 2 planned, 3 executing, 46 completed,
2 abandoned — 53 cards, six plan items plus 47 bare runs.
`plan:harness-run-memory`'s card reads `11/11` criteria · `16 runs` and
`recall · 55 tools`; a card's "now" row was driven from "no journal events" to
`p1 → write_file "out/x.py"` by replaying a real journal line through the page's
own SSE handler, which is the stalled-run-visible-in-the-first-minute proof.
Column derivation was checked against both item kinds: driving a synthetic
heartbeat with `active: false` moved a live card from Executing/"running" to
Completed/"ended", and a following `summary` frame moved it to "ok" — the
headers read `Planned=2 Executing=2 Completed=46 Abandoned=2` with no reload. A
run that ended with no summary reads Completed with an `ended` badge rather than
being guessed either way.

**Click-to-detail tells the whole task's story**: `plan:agnostic-router-kit`'s
detail rendered all 12 acceptance criteria with ✓/▢ marks, its 4 phase chips and
the 2 commits recorded against it, and the run detail for
`run:2026-10-05_17-27-41-adversarial-solve` rendered the contract row
`nfc-normalize-hyphenate — owns 2 files — 11 acceptance criteria — provides: …`
straight from that run's journal. Both snapshots describe live data, so the
counts describe the moment they were measured.

**The Graph toggle redrew the DAG from the same model** — 521 nodes, 550 edges
(plan 6, criterion 70, phase 18, run 100, agent 261, artifact 3, gate 20,
commit 40, recap 3) — with `localStorage` holding the chosen mode across a
reload. The dashboard stayed one self-contained HTML file with no new
dependency: `node --check` on the extracted 1,485-line inline script, the token
still stamped at line 433, and card contrast measured 14.84:1 light / 14.64:1
dark on the `--dim/--warn/--ok/--err` palette the graph legend already used — no
new tokens. The Activity tab rendered its 50 run rows unregressed, and
`npm run check:port` still reports the kit's plane is the engine's package.

## The package boundary, drawn — the same evening, committed now

The kit's share of the plane-split's doc work landed after `112b280` and had no
commit until this one. An interactive **package-boundary diagram** (archify,
showcase quality) now lives at `docs/architecture/zcode-router-plane.html` with
its candidate JSON beside it, and the README and the architecture overview both
link it. The README gained the paragraph that the commit message of `112b280`
already promised — *the workflow plane lives outside this repo, resolved as a
`file:` dependency on the engine checkout* — plus the Node ≥ 20 floor (the CLI
loads the plane, so the kit inherits its engines range) and the
`kit workflows run/watch/graph` CLI lines. `TECHNICAL-DOCUMENTATION.md` and
`package.json` record the floor and the dependency; `.gitignore` excludes
`.archify/` and archify's run receipts while committing the candidate and its
render. `docs/architecture/system.drawio` and `system.svg` — unreferenced by any
tracked doc at `HEAD` — are retired in the same commit; both remain in git
history if the static copies are ever wanted back.

**No secrets ride with any of this.** The diagram is roster-derived by
construction; nothing reads a key, and the scratch rigs used dummy tokens.

## The port into the engine edition

**The same board now ships in `agnostic-router-kit`**, so the two editions stay
in step on the feature. The port was composition, not hand-editing: the engine's
current dashboard with the board patch re-applied on top, provable in both
directions — the ported file against the kit's current file is exactly the
branding delta (10 hunks), and against the engine's own `HEAD` it is exactly the
board patch (11 hunks, 526 diff lines). The browser pass on a scratch engine
router rendered its own real data: 101 cards (1 planned / 3 executing / 89
completed / 8 abandoned), every detail kind opening with content, the DAG one
toggle away at 411 nodes / 264 edges, the Activity tab unregressed, and the
engine's `kit doctor` unchanged at its standing 13 problems. The engine repo's
own recap of the port — the first recap that repo has — is
`agnostic-router-kit/docs/recaps/SESSION-RECAP-2026-10-05.md`.
