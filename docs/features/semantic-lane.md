# The semantic lane — embeddings over the graded history, and the loops that read it

*Ported 2026-10-07. Plan: `docs/plans/2026-10-07-semantic-lane-port.md`. Source: the engine edition's semantic wave
(`agnostic-router-kit` `docs/plans/2026-10-07-semantic-loops.md`).*

The kit's two decision lanes are inherited by construction: sys1 reads what the work **says**, sdm1 scores what the work
**measures** — both live in the `workflow-plane` package this kit resolves from the engine checkout, so `world.semantic`
(its `--json`-injected machine contract, its three-verb allowlist, its pinned refusal sentence), the default-off
`semantic` grant, the grant-checked world bindings, and the pure `world.repeatFromRows` dedup rule are already in this
kit's dependency tree. What this edition ships is the kit-local shell: the doctor row, the two loops (re-flavored to the
kit's `.dwf.ts`), the two consumer transplants, the router tap, and the probes — `npm run check:port` is the drift
guard for everything plane-side.

## The laws (identical to the engine's — they are the lane's, not the edition's)

- **The composition law, extended:** *sys1 reads what the work says, sdm1 scores what the work measures, sem1 indexes
  what the work looks like* — under the operating rule **embeddings propose, sys1/sdm1 dispose.** A similarity score is
  a lead to confirm, never a verdict, a label, or a join.
- **The batch-only law:** loops call `world.semantic` between agent rounds, never inside an ask; nothing embedding-side
  ever runs in the router's 4-second judge budget or a synchronous path.
- **The shadow law:** a loop that *would* change a decision starts by logging what it would have done; its counts are
  the promotion evidence. In this edition: render-watch's skip is unwritable in its file, review-sweep's repeats stay
  visible annotated, and the shadow router's tap is fire-and-forget with nothing reading its return.

## The kit-local consumers

1. **dupe-watch** (`workflows/dupe-watch.dwf.ts`, hand-launched like the tabular loops) — near-dupe pairs over the
   calibration store's index: divergent grades escalate, agreeing pairs render merge proposals, nothing writes. The
   surrogate-text caveat rides in the file: near-dupe is over what each redacted row still references, so every pair is
   a lead.
2. **render-watch** (`workflows/render-watch.dwf.ts`, hand-launched) — a wave's PNGs embedded against the
   last-accepted baseline; 1.0000 cosine (the deterministic re-encode) counts as would-skip, everything else as
   dispatch-needed. Shadow: nothing is skipped, the only escalation is the owner-held baseline promotion.
3. **review-sweep's dedup head** (`workflows/review-sweep.dwf.ts`) — a finding whose text nearly matches an
   already-dispositioned finding in the `findings` corpus carries that disposition as an annotation and does not
   re-enter the confirm gate; repeats stay in the report, marked. No corpus → the head is off, the sweep unchanged.
4. **router-eval's neighbor pre-pass** (`workflows/router-eval.ts`) — each golden task prints its nearest graded
   neighbors as EVAL-ONLY grading context; the mechanical grep-grade never sees it.
5. **the shadow router** (`router/semroute-shadow.mjs` + the `server.js` tap) — the kit roster's shape sentences
   embedded at startup (re-warmed on config reload); after each fresh judge verdict a fire-and-forget log line names
   what the geometry would have picked, `evalOnly: true, applied: false`, into `router/logs/router.log`. One flavor
   adaptation from the engine: this kit's judge also answers `mixture`, so the picked value records it too.

## Producers, probes, absence behavior

Producers: `tools/record-findings-index.mjs` (a findings JSONL → per-finding text files carrying `disposition=` lines)
and `tools/record-render-index.mjs` (a wave's PNGs into a baseline corpus) — both write into dev-decisions' own store
convention (`~/.local/share/dev-decisions/`), identical in both editions. Probes: `tools/unit-services-semantic.mjs`
(hermetic, plane by specifier) plus the executed probes for the dedup head, render-watch's shadow law, the shadow
router, and dupe-watch/router-eval structure. Absence behavior is the engine's, verbatim: CLI absent, sem1 not
importable, the embedding server down, or the corpus empty → the consumer names the absence and proceeds exactly as
today; `kit doctor` reports the lane beside the tabular one.
