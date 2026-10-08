# The media lane — gen1 generates what the work needs heard and seen

*Ported 2026-10-08. Plan: `docs/plans/2026-10-08-media-loops.md` in the engine edition (this port is that plan's W4). Source: the engine edition's media wave (`agnostic-router-kit` `docs/features/media-lane.md`).*

The kit's four decision lanes are inherited by construction: sys1 reads what the work **says**, sdm1 scores what the work
**measures**, sem1 indexes what the work **looks like** — and all three live in the `workflow-plane` package this kit
resolves from the engine checkout through `node_modules/workflow-plane`, so `world.media` (its `--json`-injected machine
contract, its seven-verb allowlist, its advisory-exit and stdout-refusal handling, the workspace-cwd binding, its pinned
refusal sentence), the default-off `media` grant, and the grant-checked world bindings are already in this kit's
dependency tree. The fourth lane (dev-decisions' `gen1` library: Qwen TTS and Wan images on DashScope, StepFun audio, a
local Kokoro voice) generates what the work needs **heard and seen**. What this edition ships is the kit-local shell:
the doctor row, the three loops (re-flavored to the kit's `.dwf.ts`), the content-production voice leg, the producer, and
the probes — `npm run check:port` is the drift guard for everything plane-side.

## The laws (identical to the engine's — they are the lane's, not the edition's)

- **The composition law, extended:** *sys1 reads what the work says, sdm1 scores what the work measures, sem1 indexes
  what the work looks like, gen1 generates what the work needs heard and seen.*
- **dev-decisions is the gate.** This surface speaks only dev-decisions verbs and journals `via "gen1"`; it never calls a
  provider's API directly. The kit executes what dev-decisions surfaces — one grant is one thing to police, and the
  rows are the accountability surface.
- **Every render is eval-only, and a media-gate verdict is advisory and never a block.** Its agreement score rides an
  uncalibrated ASR until `record-asr` earns floors, so a loop that gates a render reports the verdict and lets the
  deliverable stand exactly as its author wrote it.
- **The batch-only law,** inherited: no provider call inside the router's 4-second judge budget, the swarm gate, or any
  synchronous path. Loops call `world.media` between agent rounds.
- **Every provider serves its own container.** qwen answers mp3, StepFun and Kokoro answer wav; a row's `format` is the
  container truth, so a render that lands in a `.mp3` filename while being a wav is *named* as a disagreement rather
  than hidden, and the gate reads it by content either way.

## The kit-local consumers

1. **asr-calibrate** (`workflows/asr-calibrate.dwf.ts`, router-assignable) — the lane's promotion evidence.
   `record-asr` grades the pinned fixture per provider leg; the loop renders the per-leg accuracy table as an artifact
   and escalates exactly once, naming the cleared legs. It writes nothing to the engine's config or the eval-only tag —
   the marker `media-loops: this workflow has no gen1_raw write path` lives as its own line in the file.
2. **media-budget-watch** (`workflows/media-budget-watch.dwf.ts`, router-assignable) — the daily cadence. It ingests the
   gen1 telemetry (`record-media-runs`, idempotent — a second pass lands 0 new rows) and forecasts audio-seconds per
   provider (`media-budget`). Fewer than four recorded days reads as a *named* degraded reason and never escalates; a
   crossing of the named budget escalates exactly once. The loop writes nothing of its own — the ingest verb owns its
   table — and it reads no file, so the forecast is the engine's row, never the loop's arithmetic.
3. **narrate** (`workflows/narrate.dwf.ts`, hand-launched — the args are structured and a render spends real provider
   seconds) — a render leg, a gate leg, and a loop that blocks nothing either way. Verify mode gates a planted
   script/audio pair; render mode speaks each line of a request file, assembles the hyperframes seam's `audio_meta.json`
   **from the speak rows themselves** rather than shelling gen1's route under the process grant, and gates the seam it
   just built. A `--project` path-escape is the engine's refusal, passed through verbatim.
4. **content-production's voice leg** (`workflows/content-production.dwf.ts`) — the producing consumer. With the grant,
   the finished piece gains a voice track: the deliverable is read back off disk, its markdown scaffolding stripped (a
   heading marker is not a spoken word), the prose spoken through `media-speak`, and that exact script gated against
   the render. The verdict rides the conclusion as an advisory line and the track rides beside the deliverable as a
   second artifact. **Grant absent, or any refusal, and the result object is byte-identical to the workflow that
   always was.**

## Producers, probes, absence behavior

Producer: `npm run record:media` (`tools/record-media-telemetry.mjs`) runs `record-media-runs` over the machine's gen1
telemetry (`~/.config/gen1/telemetry.jsonl` by default, overridable with `--telemetry` or `GEN1_TELEMETRY_FILE`) into
dev-decisions' own store (`~/.local/share/dev-decisions/tables/media_runs.csv`). It is the lane's only producer, and the
cadence is what buys the forecast its floors: the forecast degrades by name until four days of history exist. Rows
carry agreement, token counts, durations and sha256s — never transcript content, never key material.

Probes: `tools/probe-media-loops.mjs` drives the three `.dwf.ts` bodies through the plane's own text transform over the
plane's own `media()` bridge pointed at stub CLIs answering in the lane's pinned machine rows, with the plane's own
`worldRun` writing the seam files into a real temp workspace so they are read back off disk. It pins the port's own
claim too: the four `.dwf.ts` files are the engine's loops with line 1 rewritten, verified by byte-identity whenever the
engine checkout sits beside this one. `tools/unit-services-media.mjs` and `tools/unit-workflow-inventory.mjs` are the
hermetic surface and inventory checks.

Absence behavior is the engine's, verbatim: CLI absent, gen1 not importable, a key missing (the refusal names the
variable), or a table with too little history → the consumer names the absence and returns exactly what it would have
without the lane. `kit doctor` reports the lane beside the tabular and semantic ones: green when the CLI speaks the
media verbs, a dim configured-absence note when it predates the lane — and never a key value in its output.

## The promotion path

`record-asr` is the **only gradeable verb in the lane** and the exit from `gen1_raw`: it is the one place a render is
scored against ground truth rather than against itself. Until its floors land, every media-gate verdict rides an
uncalibrated ASR — which is exactly why the gate's verdict is advisory and every loop above reports rather than blocks.
The path out is the same shape as the other lanes' shadow laws: the loop logs what it would have done, and those counts
are the promotion evidence.
