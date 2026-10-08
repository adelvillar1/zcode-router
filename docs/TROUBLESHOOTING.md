# Troubleshooting

Symptom-first pointers. Deeper mechanics live in `router/README.md`; the feature docs in `docs/features/` explain each subsystem.

## Start here, always

```bash
npm run kit -- status          # installed? tiers resolved? health?
npm run kit -- doctor [--live] # whole-chain verification; changes nothing
```

Treat `!` lines as things to explain, and remaps as real (a fallback fired because a target had no key or was disabled — never for quality).

## Router not reachable / not on :8300

- `kit status` → is the launchd service loaded? Restart path: `kit apply` (renders, restarts, health-checks).
- Health endpoint: `curl http://127.0.0.1:8300/healthz` (no auth).
- The router binds loopback only — remote access is out of scope by design.

## 401 / auth failures from the dashboard or `/route`

- Local token mismatch: API calls need `Authorization: Bearer <localToken>` (roster `router.localToken`, default `local-auto-router`). The served dashboard page has the current token stamped in — reload it.

## Routing looks wrong (wrong model, lazy decisions)

- Read the response headers `x-router-execution` / `x-router-workload` / `x-router-workflow`; `x-router-failover` means a tier walk happened.
- `~/.zcode/router/logs/router.log`: `route`, `route-verdict`, `mixture` events; degraded judgments are tagged `judge:no-key`, `judge:error:…`, `judge:low-confidence`.
- Preview a verdict without a model call: `kit route "<task>"`.

## A plan seems exhausted / traffic not steering

- Quota is derived, not reported: check the roster's `quota.allowance` + `calibration.reads` (a stale console reading skews headroom), and off-peak weights.
- Failures are classified before benching (`router/failclass.mjs`): a usage-limit body is a **quota** window (30-min bench) even when it arrives as a 429; a bare rate limit benches 5 min (Retry-After wins); a key rejection (401, or 403 with key vocabulary) benches 60 min and is remembered on `/api/state` → `resolved.keyRejections`; a model gap (403/404 with model vocabulary) walks **without benching**; 5xx/connection failures bench 1 min. `routing.failover.cooldowns` overrides all of it. Ledger reasons carry the class (`+upstream-429:rate`, `+upstream-402:quota`), so "why did it walk" is readable in the dashboard.

## Provider missing from ZCode's picker / whole picker degraded

- Never hand-edit `~/.zcode/v2/provider_config.json`. Check `kit status`; then `kit apply --dry-run` to see what the kit would write.
- The kit only rewrites its own keys and aborts on an unknown `schemaVersion` — if the app's config was damaged some other way, restore the newest `*.bak-kit*` backup, then re-apply.
- Keyless roster providers keep their registration; removal requires explicit `enabled: false`.

## Workflows missing / doctor says 0 assignable

- `kit workflows sync` copies the library without deleting your local files.
- A workflow is router-assignable only with a task argument (metadata or `workflows.registry.<name>.taskArg`); structured-arg workflows are hand-launched by design.

## Key problems

- Keys live only in `~/.zcode/router/.env` (600): `kit env list` shows what's set vs required; `kit env set NAME=value` sets. A raw key in `roster.json` is a hard-rule violation — move it to the env file and reference `apiKeyEnv`.

## Browser-rendered scrapes / web_render

The local browsing stack (2026-10-07): rendered fetch and scrapes run through the operator-installed moli binary behind
the `browser` grant; search is keyless-first ([`docs/features/browsing.md`](features/browsing.md)).

- **`web_render` refused.** Either the run was spawned without the grant (`capability not granted in this run: browser`
  — the refusal is journalled) or moli is not on PATH (*"browser not installed — the browser grant needs moli on
  PATH"*). Remediation: re-spawn with `--grant browser`, and install the pinned moli release per
  [`docs/features/browsing.md`](features/browsing.md) — `kit doctor` reports which of the two it is (green moli line =
  the grant was missing; dim moli note = the binary is).
- **Rendered content is still thin.** Some sites only paint behind moli's layout mode, which the `browser-layout`
  grant (not plain `browser`) gates. Remediation: spawn with `--grant browser-layout` and a `waitSelector` for the
  selector the page paints late.
- **Search returned few rows.** DuckDuckGo rate-limits or comes up empty; `auto` falls back to Firecrawl only when
  `FIRECRAWL_API_KEY` resolves — without the key, DDG's (possibly empty) answer is the honest result. Remediation:
  check the run journal's search line — the `via`/backend names which leg answered — then set the key
  (`kit env set FIRECRAWL_API_KEY=…`) or pin `backend: "duckduckgo"|"firecrawl"` explicitly.

## Tabular loops / world.tabular

The dev-decisions batch lane (2026-10-07): forecast bands, flake scores, revert-risk priors, fleet anomalies behind the
`tabular` grant, default-off ([`docs/features/tabular-decisions.md`](features/tabular-decisions.md)).

- **A tabular loop says unavailable.** Three distinct absences wear the same "proceeds without it" shape, and the log
  line names which: *dev-decisions missing* (the pinned refusal — "dev-decisions not installed — the tabular grant
  needs the dev-decisions CLI (see docs)"; remediation: install the CLI or point `DEV_DECISIONS_BIN` at it), *no sdm1*
  (the CLI answers "tabpfn-hosted backend is not configured: set TABPFN_API_KEY" — remediation: set the key, or accept
  the mechanical-fallback rows some verbs still print), and *empty table* (the verb ran but its store table has no rows
  yet — `risk_prior.csv`, `quota-spend.csv`, `probe-outcomes.csv` under `~/.local/share/dev-decisions/tables/` grow
  only when their producers run: dev-decisions' own verbs, `npm run record:quota`, `npm test`). This is fail-open by
  design: findings unannotated, triage byte-identical, watchdog proceeding. Remediation: none required — run the
  producer whose table is empty and the next loop run picks it up.
- **The forecast band flags a plan I know is fine.** The quota-forecast band is a quantile band over the *recorded
  weighted spend* in `quota-spend.csv`, not over the provider console's own remaining-quota read — a top-up on the
  console, a changed allowance, or a weekend-long idle stretch makes the table and the console disagree, and the band
  flags a plan the console says is fine. Remediation: re-run `npm run record:quota` so the table carries the current
  reality, and treat a band crossing as a prompt to reconcile the two reads — the loop escalates so an owner can
  answer, not because it measured the console.

## Semantic lane / world.semantic

The dev-decisions embeddings lane (2026-10-07 port): vector index, near-dupe pairs, nearest graded neighbors behind the
`semantic` grant, default-off ([`docs/features/semantic-lane.md`](features/semantic-lane.md)).

- **A semantic loop says unavailable.** Four absences wear the same "proceeds
  without it" shape, and the log line names which: *dev-decisions missing* (the
  pinned refusal — "dev-decisions not installed — the semantic grant needs the
  dev-decisions CLI with sem1"; remediation: install the CLI or point
  `DEV_DECISIONS_BIN` at it), *sem1 not importable* (set `DEV_DECISIONS_SEM1_PATH`
  or install `~/Projects/sem1`), *embedding server down* (llama-server on
  127.0.0.1:8901 unreachable; remediation:
  `launchctl kickstart -k gui/$(id -u)/com.adelvillar1.sem1-llama`), and *no
  index* ("no index — run `dev-decisions semantic-index` first"). Fail-open by
  design: sweep unchanged, eval unchanged, nothing skipped.
- **The shadow router disagrees with the judge.** Expected — that disagreement
  is the data the logger collects (`router/logs/router.log`,
  `kind: "semroute-shadow"`, `applied: false`). It cannot steer: fire-and-forget
  after the verdict, nothing reads its return. Remediation: none — accrue rows;
  a fitted agreement floor is a later wave's promotion evidence.
- **dupe-watch reports a pair I know is not a dupe.** Near-dupe is over
  *surrogate* text — what each redacted row still references — so shared plan
  files can land close without similar inputs. Every pair is a lead to confirm,
  nothing merges without an owner.

## Media / world.media

The dev-decisions gen1 lane (2026-10-08 port): text spoken to audio, a render transcribed and graded against its script,
ASR calibrated against pinned fixtures, and the audio-seconds forecast behind the `media` grant, default-off
([`docs/features/media-lane.md`](features/media-lane.md)). Three kit-local consumers ride it — asr-calibrate and
media-budget-watch (router-assignable, their task arg is a plain string), narrate (hand-launched), plus
content-production's voice leg.

- **A media loop says "dev-decisions not installed".** The pinned absence
  sentence — *"dev-decisions not installed — the media grant needs the
  dev-decisions CLI with gen1 (see docs)"* — is an ENOENT on the spawn, not a
  throw, so the run proceeds and the leg reports its absence in its own words.
  Remediation: install the CLI or point `DEV_DECISIONS_BIN` at it. `kit doctor`
  shows the row dim when the CLI is absent and green when it answers.
- **A media verb failed (exit 3).** Exit 3 with a row on stdout is a *pre-row
  refusal*: the CLI named why before it logged anything, and the row's `error`
  is the sentence the loop reports. A missing key says so by variable name
  (`DASHSCOPE_API_KEY` for the Qwen/Wan legs, `STEPFUN_API_KEY` for StepFun,
  Kokoro needs none) — this machine keeps `STEPFUN_API_KEY` in
  `~/.hermes/.env` and both keys in `~/Projects/design-canvas/.env.local`,
  injected process-locally, never committed. gen1 resolves its keys from
  `os.environ` first, then `~/.config/gen1/env` (chmod 600). Remediation: set
  the named variable and re-run; the key value never appears in a row, a log,
  or `kit doctor`.
- **A staged script reads back as unreadable.** The media CLI runs with the
  run's workspace as its cwd, because the lane's paths are workspace-relative —
  so a leg that stages a file and then calls a verb on it works. If you see
  `cannot read --text-file` (or `--script`/`--audio`) against a file you know
  is on disk, the cwd is wrong: check that the call is going through
  `world.media` and not a hand-rolled `execFile`, and that the path is
  workspace-relative rather than machine-absolute.
- **media-gate's verdict is `gaps`.** Advisory by the lane's law, and the loop
  does not block on it — the deliverable stands exactly as its author wrote it.
  The row's per-line `missing`/`extra` token counts name the drift; the note
  says how many lines were verified, refused, and gapped. Remediation:
  re-render the line (a different voice or a slower `--speed` often closes a
  gap the ASR split) or accept it by hand. Remember the verdict rides an
  *uncalibrated* ASR until `record-asr` earns floors, so a low agreement is a
  prompt to look, not a defect.
- **The render's format disagrees with its filename.** Every gen1 provider
  serves its own container and ignores the requested one — qwen answers mp3,
  StepFun and Kokoro answer wav. A `.mp3` filename holding a wav is not
  corruption: the row's `format` is the container truth, the gate reads the
  file by content, and the loop names the disagreement rather than hiding it.
  Remediation: none — read the row's format, or rename to match.
- **media-budget says degraded.** Fewer than four recorded days of history —
  the forecast needs four to render bands, so it names the reason per provider
  (*"only 1 recorded day(s) — forecast needs 4"*) and escalates nothing. The
  table `~/.local/share/dev-decisions/tables/media_runs.csv` grows only when
  the cadence runs: `npm run record:media`. Remediation: run the daily cadence
  and the next forecast has its floors.
- **record-asr reports no graded rows.** Every fixture refused, which means the
  ASR leg could not run — almost always a missing key (the refusal names it) or
  an unreadable fixture pair. `record-asr` is the lane's only gradeable verb,
  so a run with no graded rows leaves every media-gate verdict uncalibrated.
  Remediation: set the named key and re-run; the pinned fixture lives in
  dev-decisions' `scripts/fixtures/media/`.
- **content-production produced no voice track.** Expected when the `media`
  grant is absent, the CLI is missing, or any leg refused — the workflow's
  result is byte-identical to the pre-leg workflow, one artifact, no advisory
  line. Grant absent is the default; the leg only appears with `--grant media`
  at spawn. Remediation: none if you did not ask for it; otherwise confirm the
  grant and that `kit doctor`'s media row is green.
- **A ported `.dwf.ts` loop refuses every argument you pass it.** The refusal
  reads *"unknown argument "task" — asr-calibrate.dwf declares: (none)"*, and
  it names an arg the file plainly declares. The plane's `parseHeader` matches
  the engine's `/* workflow` marker; every kit file carries
  `/* zcode-workflow` (the kit's own parser in `lib/workflowlib.mjs` reads that
  one), so the plane sees an empty declaration and rejects the first key. This
  is kit-wide and predates the media port — it hits the tabular, semantic and
  diagram loops identically, and it is why the loops ship with their defaults
  pinned rather than a documented override. Remediation: run the loop with no
  `--args` and edit the default in the file, or wait for the marker tolerance
  in the plane (trigger: this wave — the port's assignable loops are the first
  consumers whose whole point is a caller-supplied arg).

## Diagram lane / world.diagram

The archify diagram refresh (2026-10-08 port): drift audit, ref re-pin, finalize, stills behind the `diagram` grant,
default-off ([`docs/features/diagram-lane.md`](features/diagram-lane.md)).

- **diagram-refresh says refs moved, or says a ref changed.** Two verdicts, two
  jobs. *Moved* means the anchored bytes are identical somewhere else in the
  file — the wave shifted lines around them; the loop re-pins these itself and
  the next audit says intact. *Changed* means the bytes at the pinned range were
  edited — the claim the node makes may no longer be true, and the loop refuses
  to touch it by design: the report lists it with its label and old range as the
  agent's repair list. Remediation: for a changed ref, grep the label's anchor in
  the current file (the label is the hint; the old lines are only a
  neighborhood), read the range, then decide — update the candidate's ref, or
  edit the node's text, or delete the node — and re-run the loop to finalize.
  Nothing here is automatic because "the lines moved" and "the claim died" are
  different facts and only the second one is an author's problem.
- **The loop says the archify CLI was not found.** The pinned refusal —
  "archify CLI not found — the diagram grant needs the archify skill (set
  ARCHIFY_BIN=/path/to/archify.mjs; see docs)". The CLI is resolved in a pinned
  order: `ARCHIFY_BIN`, `~/.zcode/skills/archify/bin/archify.mjs`,
  `~/.agents/skills/archify/bin/archify.mjs`. Remediation: install the skill or
  point `ARCHIFY_BIN` at its `bin/archify.mjs`. Fail-open by design: the re-pin
  still landed (the audit and re-pin need only git), the finalize phase declined
  by name, and nothing half-wrote.
- **finalize rejects the candidate (layout gate).** The two known rejections:
  a sublabel long enough to make the layout gate's legibility minimum fail
  (shorten the text rather than widen the node), and a new node placed at a
  guessed position overlapping a neighbor (the gate's 8px-overlap rule — its
  error names both boxes; move the new node beside its intended sibling and
  re-finalize). Also: `finalize architecture` on a workflow-type candidate fails
  with a misleading "lanes" schema error — read `diagram_type` from the
  candidate and pass that type. Remediation: one repair round per failure, then
  re-run the loop; a `--out-dir` must be fresh every round because the existing
  HTML owns its browser-evidence path (the loop does this itself — by hand, use
  `refresh-<n>` with n one past the max existing).
- **The stills are byte-identical to last wave.** Expected, not a failure: a
  label-only or links-only edit leaves the layout, and therefore the render,
  unchanged — that is success reported honestly. Remediation: none; confirm the
  PNG dimensions with `node docs/architecture/render-png.mjs --check` and move
  on. If a *content* edit still renders identical bytes, the HTML and the still
  disagree — re-run render and, if they still agree, read the PNG: the eye pass
  is the acceptance gate, never a hash.
- **A refresh round leaves an untracked `plane.png` beside the tracked
  `zcode-router-plane.png`.** The kit's `plane.candidate.json` declares its
  rendered output as `zcode-router-plane.html`, while the finalize surface names
  the output from the candidate's own stem — so the round writes a second,
  byte-identical copy of the same diagram under the stem. Bug in the kit's
  candidate/output naming, not in the loop: the stills are identical, so delete
  the `plane.html`/`plane.png` pair (or rename the candidate to the name it
  renders to) and re-run. Do not commit both — one diagram, one still.
