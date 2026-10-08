# The diagram lane — archify diagrams kept anchored by a loop

*Ported 2026-10-08. Plan: `docs/plans/2026-10-08-diagram-refresh.md` (the engine edition). Source: the engine edition's diagram wave (`agnostic-router-kit` `docs/plans/2026-10-08-diagram-refresh.md`, `docs/features/diagram-lane.md`).*

This kit's decision lanes are inherited by construction: the plane surface (`world.diagram`'s `audit` / `repin` / `finalize`), the default-off `diagram` grant, the archify CLI resolution with its pinned refusal sentence, and the loop's five phases all live in the `workflow-plane` package this kit resolves from the engine checkout — so none of them are re-implemented here. What this edition ships is the kit-local shell: the doctor's freshness row, `workflows/diagram-refresh.dwf.ts` (the engine's loop, `.dwf`-re-header only), the four candidates under `docs/architecture/` re-pinned and re-finalized at the port's HEAD, and `tools/unit-services-diagram.mjs` — the engine's 27-case suite, passing here through `node_modules/workflow-plane`. `npm run check:port` is the drift guard for everything plane-side.

The plane, the request lifecycle, the quota chart, and the architecture view are this repo's claims about itself: every node, edge, and boundary carries a `sources` entry — a file, a line range, a label — and every candidate pins `meta.repository.revision`, the commit those refs were true at. Those pins are what make the diagrams auditable, and they are also what makes them go stale: any wave that moves code desyncs the map, and any wave that rewrites anchored code can make node text quietly false.

## The surface (inherited, not re-implemented)

`world.diagram` on the workflow plane (`lib/workflow/services.mjs` in the engine edition), three capabilities:

- **`audit({ dir, revision })`** — the drift check. Each source ref is classified against the pinned revision: **intact** (the bytes at `[line..end_line]` are identical to the bytes at that range in `git show <pinnedRevision>:<path>`), **moved** (the pinned range found verbatim elsewhere in the file, with its new lines reported), **changed** (the anchored bytes were edited), **missing** (the file is gone). One `git show` per distinct (revision, path). It writes nothing — so `kit doctor` runs it on every invocation and the number is cheap.
- **`repin(candidateJson, movedRefs, { head })`** — pure. Applies *moved* verdicts only: rewrite `line`/`end_line`, repin the revision, return `{ json, changes }`. Run it twice and the second run changes nothing.
- **`finalize({ type, candidate, outDir, repoRoot })`** — spawns the archify CLI, allowlisted to the one verb (`DIAGRAM_COMMANDS = ["finalize"]`; anything else is refused by name before a process is spawned), runs the gates into `outDir`, then moves the receipt JSONs (`<stem>.finalize.json`, `.finalize-summary.json`, `.delivery.json`, `.browser-check.json`) back beside the candidate.

The CLI is resolved in a pinned order — `ARCHIFY_BIN`, then `~/.zcode/skills/archify/bin/archify.mjs`, then `~/.agents/skills/archify/bin/archify.mjs` — and absence is the pinned refusal sentence, never a throw: *"archify CLI not found — the diagram grant needs the archify skill (set ARCHIFY_BIN=/path/to/archify.mjs; see docs)"*. The stills leg needs no new surface: `docs/architecture/render-png.mjs` is this kit's own script, driven under the process grant.

## The laws (the same, and they bind here harder)

- **Identity, not similarity.** The audit asks the only question with a deterministic answer: *are the pinned bytes still the same bytes?* Label matching fails on real data — 15 of the engine repo's 61 refs carry paraphrased labels that appear nowhere verbatim in the anchored code. A ref that moved reports where its content went; a ref whose content was *edited* is not a move — the claim may now be false, and only the agent may judge it.
- **The loop anchors claims; it never makes them.** The re-pin moves refs and repins the revision. It does not author nodes, edges, labels, or diagrams, and it does not decide that a `changed` ref is still true — every `changed` verdict lands in the report as the agent's repair list, with the old range and the current file to read.
- **The receipt dance is mechanical law, not folklore.** A fresh `refresh-<n>/` per finalize round (never reused), receipts back beside the candidate, and both the refresh dirs and the receipts stay untracked — `git add` the diagram files, never the round's scratch space.
- **The stills are read.** `render-png.mjs` writes them; the loop's report names them and commands the eye pass. A label-only edit keeps a still byte-identical — that is the expected outcome, not a render failure, and not something a check can accept for you.

## The consumer

**diagram-refresh** (`workflows/diagram-refresh.dwf.ts`, router-assignable, batch-only — it spawns no agents and makes no model calls) runs the engine's five phases: audit → re-pin (mechanical moves only; `--dry-run` reports without writing) → finalize what the re-pin touched into a fresh `refresh-<n>/` → stills (`render-png.mjs`; `--check` verifies sizes without Chrome) → a markdown artifact listing every unresolved ref as the agent's repair list and commanding the eye pass.

Run it with `kit workflows run diagram-refresh`. The kit's `.dwf.ts` header (`/* zcode-workflow`) differs from the engine's (`/* workflow`) on line one and nowhere else; the body is byte-identical, so a bug is fixed once in the engine and re-ported.

## The grant, and absence behavior

`world.diagram` rides the **`diagram`** capability — **default-off**, opted in at spawn (`--grant diagram`; runs also want the process grant for the stills leg). Every failure is fail-open by construction: archify absent, the dir absent, or git unavailable reads as a named refusal and the loop returns what it would have without the lane. `kit doctor` reports the row beside the tabular and semantic ones: the candidates' freshness counts from the audit, and a dim configured-absence note for the archify CLI when nothing resolves it.
