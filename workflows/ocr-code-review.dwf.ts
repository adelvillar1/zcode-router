/* zcode-workflow
description: "Runs a coverage-guaranteed code review over a git range using the
  alibaba open-code-review CLI as its scaffolding: the delegate preview fixes
  the manifest up front, every file on it is reviewed and its findings confirmed
  as they land, a ledger accounts for every file and every finding so nothing is
  silently skipped, the paid review round runs behind an owner gate, and this
  repository's OCR GitHub Action is audited against the hardening rules.
  Embodies the ocr-code-review skill."
whenToUse: When a wide range of files needs a uniform, coverage-checked review —
  every file accounted for, every finding confirmed — rather than a sampled
  read.
args:
  from:
    type: string
    description: Git ref the reviewed range starts at. Defaults to HEAD~1.
    required: false
  to:
    type: string
    description: Git ref the reviewed range ends at. Defaults to HEAD.
    required: false
  skillPath:
    type: string
    description: Optional override for the path to the skill's SKILL.md, for a
      checkout that lives somewhere other than this machine's default.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// ocr-code-review.ts
// Dynamic-workflow DRAFT: a deep, coverage-guaranteed code review of a git range,
// scaffolded by the alibaba/open-code-review `ocr` CLI, embodying
// /Users/alejandrodelvillar/.agents/skills/ocr-code-review/SKILL.md.
//
// Pattern: hybrid — structure (phases, fan-outs, the coverage ledger, bounded retry,
// WorkflowReport) lives in this script; every ask references the skill's SKILL.md by
// absolute path and section line-anchors so subagents read the procedure themselves.
//
// MISSING-REFERENCES DISCLOSURE (verified this session): contrary to the batch premise,
// this skill ships NO references/ directory — `ls ~/.agents/skills/ocr-code-review/`
// shows only SKILL.md, and `ls .../ocr-code-review/references/` exits
// "No such file or directory". There is also no scripts/ directory: the skill's
// "scripts" are the `ocr` CLI itself. So the asks here cite the single SKILL.md only,
// and the world.run gates call `ocr` directly (its subcommands are the skill's own
// deterministic scaffolding: SKILL.md:78-101). The gap is pushed into the run's structured
// notCovered array immediately after that array is declared — before any branch — so it
// reaches the WorkflowReport on EVERY path, including the stage-0 abort return, and is
// restated to the report writer, so the skill author sees it however the run ends.
//
// STEP MAP — the skill carries no numbered 10-step list; the ten operational moves it
// documents, and where each is embodied:
//   1 install/availability check ............ phase "Probe the review toolchain..." (SKILL.md:16-20)
//   2 provider-not-llm.* config gotchas ..... gatekeeper evidence + escalation (SKILL.md:22-27, :35-43)
//   3 url-not-base_url field gotcha ......... gatekeeper: config fixes are owner-only (SKILL.md:28-31)
//   4 state read via `ocr llm test` ......... world.run gate (SKILL.md:32)
//   5 verify endpoint before a real run ..... the LLM round starts only after llm test passed (SKILL.md:33)
//   6 key->model routing .................... gatekeeper ask text; secrets never handled by this run (SKILL.md:48-62)
//   7 model quality changes the answer ...... paid-round approval context (SKILL.md:64-76)
//   8 slow run, json -o, read warnings ...... unawaited world.run + defensive JSON parse (SKILL.md:78-93)
//   9 delegate mode ledger .................. preview manifest + per-file fan-out + rule checklist (SKILL.md:95-101)
//  10 stage-0 coverage gate + CI hardening ... ledger close-out + GitHub Action audit (SKILL.md:103-136)
//
// AVAILABILITY (verified on this machine this session):
//   TWO `ocr` binaries are installed and a run resolves whichever is first on PATH —
//   /usr/local/bin/ocr -> "open-code-review v1.11.9" (npm global) and
//   ~/.local/bin/ocr -> "open-code-review v1.12.9" (~/.local/bin precedes /usr/local/bin in
//   this session's later shells). Both are >= 1.10, so the `--format json -o` form
//   (SKILL.md:86-87) is supported either way. The run still probes at run time and gates on
//   the probe rather than assuming.
//   `ocr llm test` -> exit 0 on both binaries, "Source: provider:ollama-cloud /
//   URL: https://ollama.com/v1 / Model: glm-5.3-flash" — the exact path SKILL.md:50
//   recommends. It prints no secret values, so quoting its first lines to the gatekeeper is
//   safe.
//   `ocr delegate preview --from HEAD~1 --to HEAD` -> byte-identical shape on BOTH binaries:
//   "# Files (0 reviewable / 3 total)", "- merge_base: <hash>", reviewable bullets
//   "- `path` [status] +a/-b", excluded bullets struck through "(excluded: <reason>)".
//   parsePreview() below is written against that captured shape and was executed verbatim
//   against live output this session (see out/swarm/compile-probes/ocr-code-review.probe.ts):
//   it returns files=[], excluded=[CLAUDE.md, docs/daily-recaps/2026-09-21.md,
//   docs/plans/...typesafe-system-one-integration.md] all "unsupported_ext", mergeBase
//   05210b17..., parsed=true — i.e. THIS repository's HEAD commit has nothing OCR can review,
//   which the ledger reports as such rather than as a clean pass.
//   `ocr delegate rule <paths>` -> "### Rule Group N: <origin> / <glob>" blocks with
//   "Applies to:" bullets and "#### Content" — identical on both binaries; reviewers are
//   told to fetch each file's checklist themselves.
//   This repository also ships .github/workflows/ocr-review.yml (read this session) already
//   carrying all four hardening requirements, so the skill's CI section is auditable against
//   a real file here.
//
// world.run SCOPE — the script's whole command set is {"ocr", "mkdir"}:
//   ocr --version | ocr llm test | ocr delegate preview | ocr delegate rule | ocr review
//   (gates, all read-only except `ocr review`, which per SKILL.md:93 only writes session
//   state to ~/.opencodereview and does NOT dirty the repo); and `mkdir -p out/ocr-review`
//   so `ocr review -o` and the report writer have a gitignored destination (out/ is
//   gitignored: .gitignore:8, verified this session). Command names are compile-time
//   literals; runtime values go in the args arrays (§16.3). Besides those gates the script
//   performs two world READs: files.read of SKILL_MD (phase 1 — args.skillPath is
//   caller-settable, so the file every ask cites is checked readable once and the result is
//   evidence for the gatekeeper plus a notCovered entry when it is missing) and files.read of
//   the paid round's JSON file (phase 6).
//
// WRITE GATE / OWNER APPROVAL (lesson 8): starting the paid LLM round spends the run
// owner's quota; installing/upgrading the CLI or configuring a provider changes their
// machine and touches credentials. None of that is decided here: the gatekeeper subagent
// holds the evidence and ESCALATES each owner-only question to the human who started the
// run, and only proceeds on the owner's answer or on the stated no-answer default.
//
// CREDENTIAL RULES (lesson 9): this run never reads, writes, prints or interpolates any
// API key. `ocr config set` is off-limits to every subagent (SKILL.md:35-43 recipe is for
// the owner to run themselves). The single safety clause below is repeated verbatim in
// EVERY persona and in EVERY ask — reviewer, confirmer, repair reviewer, repair confirmer,
// gatekeeper, triage, auditor, writer — not just the ones that obviously touch data, since
// any subagent here has a shell and could otherwise run a write command.
//
// Compiler-enforced lessons applied, each at its site:
//  (1) one primary:true id ("review-report") at exactly one publish site in publishReport().
//  (2) no facade references: facade results are annotated with the named types GitStatus,
//      GitCommit, WorldRunResult, Agent; no typeof/ReturnType on facade members anywhere.
//  (3) every ask<T> passes a named interface declared in this file.
//  (4) one kind per id: "review-report" is only ever artifact.file, "review-report-compact"
//      only artifact.markdown, "coverage" only the board preset.
//  (5) every content publish is wrapped; the compact fallback is composed from in-memory
//      slices only and is itself wrapped in a swallowing catch that only calls log().
//  (6) no tunable constant (caps, timeouts, thresholds) appears inside any ask text — they
//      live in script control flow only; asks interpolate upstream result values (§13).
//  (7) fan-out agents get unique computed names (file path, comment index, retry round).
//  (8) owner approvals and write gates reach the human via escalate (gatekeeper persona).
//  (9) the read-only + credential clause is in every persona and every ask (see CREDENTIAL
//      RULES above), not only in the data-holding ones.
// (10) the deliverable is published from the path the report writer actually returned,
//      never from a path this script assumes; an unusable returned path falls through to
//      the compact publish, not to a hardcoded guess.

// ─── Named result types (every ask<T> type argument; lesson 3) ────────────────

/** The stage-0 scope decision, made by the gatekeeper with the run owner. */
interface ScopeDecision {
  /** "proceed" runs the review; "abort" publishes a facts-only report and stops. */
  proceed: "proceed" | "abort";
  /** True only when the owner approved the paid `ocr review` LLM round. */
  llmRound: boolean;
  /** What the owner actually said via escalation, or the stated default used. */
  ownerNote: string;
}

/** One file's ledger row: the skill's guarantee is that every file ends this way. */
interface ReviewOutcome {
  /** Workspace-relative path, copied from the ask verbatim. */
  path: string;
  /** "reviewed" = the file was audited; "skipped" = consciously not audited, needs reason. */
  verdict: "reviewed" | "skipped";
  /** Mandatory non-empty reason when verdict is "skipped"; empty when "reviewed". */
  reason: string;
  /** Problems found in this file; empty array is a clean pass, not a failure. */
  findings: FileFinding[];
}

/** One problem in one file, as the reviewer states it before confirmation. */
interface FileFinding {
  /** File and line range, e.g. "src/api/x.ts:120-131". */
  where: string;
  /** One sentence: what is wrong, not how to fix it. */
  what: string;
  /** What showed it: the cited lines, or the read-only command and its output. */
  evidence: string;
  /** Impact. Reserve "high" for a crash, data loss, or a wrong result. */
  severity: "low" | "medium" | "high";
  /** The OCR rule-group heading this violates, or "general" when outside the checklist. */
  rule: string;
}

/** An independent reproduction attempt for one finding, from its evidence alone. */
interface Confirmation {
  /** True only when you reproduced the problem yourself from the code alone. */
  confirmed: boolean;
  /** One sentence: what you read or ran, and what it showed (or failed to show). */
  note: string;
}

/** The merged finding pool after confirmation, carrying identity for triage. */
interface ReviewFinding {
  /** Stable 1-based id across this run, used by the triage ask. */
  id: number;
  /** Where the problem is: "path:lines" for code, "ledger:<path>" for coverage leaks. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** What showed it: the confirmer's note, the lines read, or the gate's exit code. */
  evidence: string;
  /** "verified" when an independent confirmer or the script's own gate settled it. */
  status: "verified" | "unconfirmed";
  /** How much it matters; "high" only for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
  /** Which review pass produced it. */
  source: "per-file" | "ocr-round" | "ledger" | "action-audit";
}

/** The deduplication-and-ranking verdict over the merged pool. */
interface TriageResult {
  /** Ids to surface, best-to-fix first. Any id not listed is kept after these, unordered. */
  order: number[];
  /** Ids judged duplicates, each paired with the id it duplicates. Nothing else is dropped. */
  duplicates: { id: number; ofId: number }[];
}

/** One of the skill's CI-hardening requirements checked against a real workflow file. */
interface ActionCheck {
  /** The requirement, in the skill's own phrasing (SKILL.md:103-128). */
  requirement: string;
  /** "pass" = proven satisfied from quoted lines; "fail" = proven violated; "unclear". */
  status: "pass" | "fail" | "unclear";
  /** Exact quoted YAML lines, or what you searched and could not find. */
  evidence: string;
}

/** The repository's OpenCodeReview GitHub Action audit result. */
interface ActionAudit {
  /** False when this repo has no workflow using alibaba/open-code-review. */
  applicable: boolean;
  /** Workspace-relative path of the audited workflow file, empty when none. */
  file: string;
  /** The skill's hardening requirements, each judged once; empty when not applicable. */
  checks: ActionCheck[];
}

/** What the report writer produced and where. */
interface ReportDoc {
  /** Workspace-relative path of the report file you actually wrote — publish reads it. */
  path: string;
  /** Two or three sentences: the review's headline answer. */
  summary: string;
}

/** The §10 finding shape for the returned report. */
interface Finding {
  /** Workspace-relative path, with a line range when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, the confirmer's note, or the command and output. */
  evidence: string;
  /** "verified" when an independent subagent or a deterministic check confirmed it. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

/** The §10 handoff shape returned at the end. */
interface WorkflowReport {
  /** Two or three sentences answering what the review found and how far it could go. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the exact world.run commands and their exits. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

/** The paid round's outcome, converted to a VALUE before anything can await it. world.run
 *  rejects on spawn failure and on timeout; both handlers are attached at creation so the
 *  promise the script holds can never reject (an unhandled rejection between phase 3 and
 *  phase 6 would otherwise error the run mid-fan-out). */
interface SettledRound {
  /** The command result, or null when the run rejected. */
  result: WorldRunResult | null;
  /** Rejection text when result is null; empty otherwise. */
  failure: string;
}

/** OCR's JSON result file, defensively typed (keys per SKILL.md:88-90). */
interface OcrJsonShape {
  summary?: { files_reviewed?: number; comments?: number; total_tokens?: number; elapsed?: string };
  comments?: {
    path?: string;
    start_line?: number;
    end_line?: number;
    severity?: string;
    category?: string;
    content?: string;
  }[];
  warnings?: unknown[];
  manifest?: unknown;
}

// ─── Script constants (control flow only; none reach ask text — lesson 6) ─────

/** Read one caller-supplied arg as a non-empty string, else fall back. Takes `unknown` so
 *  the typeof narrowing happens on a local parameter — never on a facade member (lesson 2). */
function argString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** Where the source skill lives. Absolute by default (this draft is project-scoped, written
 *  against this machine); args.skillPath overrides it for another checkout without editing
 *  the script. */
const SKILL_MD = argString(args.skillPath, "/Users/alejandrodelvillar/.agents/skills/ocr-code-review/SKILL.md");
const OUT_DIR = "out/ocr-review";
const RESULTS_JSON = OUT_DIR + "/ocr-review.json";
/** Wall-clock ceiling for the paid round; SKILL.md:85 says it takes minutes, and the
 *  repo's own CI job caps at 30 minutes (.github/workflows/ocr-review.yml:24). */
const LLM_TIMEOUT_MS = 1_800_000;
/** Bounded ledger-repair rounds (§2: every loop needs a cap). */
const RETRY_ROUNDS = 1;
/** report() journal caps — 256 items per run AND 32KB per item — both fail the whole run
 *  (§16.2 "Two caps, and both fail the whole run"), and a tagged report counts against the
 *  item cap too. Findings, ledger rows and leak findings all journal, so ONE shared counter
 *  budgets every item this run emits; over-budget items fold into the report file instead.
 *  Script-side knobs only, never ask text (lesson 6). */
const JOURNAL_ITEM_BUDGET = 240;
/** "skipped"/"failed" ledger cards keep this reserve so the rows that mark the coverage
 *  guarantee breaking always journal before clean rows do, and findings keep the tail. */
const JOURNAL_LEDGER_CAP = 190;
/** Clean "reviewed" cards stop here — past it they fold into the report file — so a large
 *  clean manifest cannot crowd out failures, skips or findings on the board. */
const JOURNAL_LEDGER_CLEAN_CAP = 150;
/** Sentinel reason for reviewer-ask failures; deliberate skips use real text instead. */
const REVIEWER_FAILED = "<<reviewer attempt produced no result>>";

/** The read-only + credential clause — repeated in every persona and every command-
 *  holding ask verbatim (lesson 9). It is a normative rule block, not a tunable knob,
 *  so interpolating it into ask text is safe (§13 warns only about constants an amendment
 *  would tune); and when safety wording does change, re-running those asks is wanted. */
const SAFETY_RULES =
  "You work read-only. You never edit, create or delete any file, except a report path " +
  "that an ask explicitly assigns to you under the gitignored out/ directory. You never run " +
  "any git write command (commit, add, checkout, switch, reset, stash, clean, push), never " +
  "run 'ocr config set' or anything else that writes configuration, never run 'ocr llm test' " +
  "or 'ocr review' (the script owns those gates), and never read or print credential stores " +
  "(~/.hermes/.env, ~/.zcode/**, keychain) or echo any secret value you happen to see — cite " +
  "environment-variable NAMES and config KEYS only, never values. Cite evidence as path:line " +
  "or as the exact read-only command you ran plus its output; never report a check you did " +
  "not run. If a check is impossible to pass, or your instructions contradict each other, " +
  "escalate and say so plainly rather than working around it or inventing results.";

// ─── Pure helpers (traceable script logic, no facade references) ──────────────

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "")[0] ?? "";
}

function severityFromOcr(label: string): "low" | "medium" | "high" {
  const s = label.toLowerCase();
  if (s.includes("critical") || s.includes("high") || s.includes("major")) return "high";
  if (s.includes("medium") || s.includes("moderate") || s.includes("warning")) return "medium";
  return "low";
}

function severityRank(s: "low" | "medium" | "high"): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

/** Parse `ocr delegate preview` markdown — written against the exact output shape
 *  captured from this CLI this session (see header). */
function parsePreview(out: string): {
  files: string[];
  excluded: { path: string; reason: string }[];
  mergeBase: string;
  reviewableCount: number;
  totalCount: number;
  parsed: boolean;
} {
  const result = {
    files: [] as string[],
    excluded: [] as { path: string; reason: string }[],
    mergeBase: "",
    reviewableCount: -1,
    totalCount: -1,
    parsed: false,
  };
  const header = /(\d+)\s+reviewable\s*\/\s*(\d+)\s+total/.exec(out);
  if (header) {
    result.reviewableCount = Number(header[1]);
    result.totalCount = Number(header[2]);
  }
  const mb = /^-\s*merge_base:\s*([0-9a-f]{7,40})\s*$/m.exec(out);
  if (mb) result.mergeBase = mb[1];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    const ex = /^~~-\s*`([^`]+)`.*\(excluded:\s*([^)]+)\)~~$/.exec(line);
    if (ex) {
      result.excluded.push({ path: ex[1], reason: ex[2].trim() });
      continue;
    }
    const inc = /^-\s*`([^`]+)`\s*\[/.exec(line);
    if (inc) result.files.push(inc[1]);
  }
  result.parsed = header !== null || result.files.length > 0 || result.excluded.length > 0;
  return result;
}

function countRuleGroups(out: string): number {
  return (out.match(/^### Rule Group/gm) ?? []).length;
}

/** Attach BOTH handlers to a world.run promise and convert its outcome into a value. The
 *  returned promise never rejects, so holding it unawaited cannot produce an unhandled
 *  rejection while the fan-out runs (§7: a started-but-unawaited promise still needs its
 *  rejection handled at the start site). */
function settleRound(promise: Promise<WorldRunResult>): Promise<SettledRound> {
  return promise.then(
    (round) => ({ result: round as WorldRunResult | null, failure: "" }),
    (err: unknown) => ({
      result: null,
      failure: err instanceof Error ? err.message : String(err),
    }),
  );
}

// ─── Arguments: the review range ──────────────────────────────────────────────

const fromRef = argString(args.from, "HEAD~1");
const toRef = argString(args.to, "HEAD");

const findingsPool: ReviewFinding[] = [];
const verified: string[] = [];
const notCovered: string[] = [];
let nextFindingId = 1;

// The batch-premise gap (verified: the skill directory holds only SKILL.md) is a STRUCTURED
// notCovered entry, pushed here before any branch — so it reaches the returned
// WorkflowReport on every path, including the stage-0 abort return, not only the long-form
// report when one gets written.
notCovered.push(
  "the source skill ships no references/ directory and no scripts/ directory (verified: the " +
    "skill directory contains only SKILL.md) — every ask cites the single SKILL.md, and the " +
    "ocr CLI's own subcommands stand in for scripts/",
);

let journalUsed = 0;
let journalOverflowLogged = false;

/** Claim ONE slot of the single shared journal budget before a report() call. report() is
 *  capped twice — 256 items per run AND 32KB per item — and both caps fail the WHOLE run
 *  (§16.2), and a tagged item counts too, so ledger rows, finding briefs and leak findings
 *  budget against this one counter. `cap` lets a class of items reserve headroom: ledger
 *  cards stop at their cap so findings still journal on a huge manifest. The budget's LAST
 *  slot is reserved for the ledger close-out card (`reserved: true`), so ordinary items stop
 *  one short of JOURNAL_ITEM_BUDGET and a truncated board can always say so on itself. When a
 *  slot is refused the item is not journaled — it still lives in the report file and the
 *  returned result, and the refusal is logged once. The tag stays literal at each call
 *  site (§16.3). */
function journalSlot(cap: number, reserved = false): boolean {
  const ceiling = reserved ? JOURNAL_ITEM_BUDGET : JOURNAL_ITEM_BUDGET - 1;
  if (journalUsed >= cap || journalUsed >= ceiling) {
    if (!journalOverflowLogged) {
      journalOverflowLogged = true;
      log(
        "Journal item budget reached — remaining ledger rows and findings fold into the " +
          "report file and the returned result instead of the journal.",
      );
    }
    return false;
  }
  journalUsed++;
  return true;
}

/** Clip every string field of a journal item (2000 chars per field) so no item can near the
 *  32KB per-item cap even when a model wrote a wall of text. */
function journalBrief<T extends object>(item: T): Record<string, unknown> {
  const source = item as Record<string, unknown>;
  const clipped: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    clipped[key] = typeof value === "string" ? value.slice(0, 2000) : value;
  }
  return clipped;
}

let ledgerCardAttempts = 0;
let ledgerCardsJournaled = 0;

/** Journal ONE coverage card under class-aware caps: clean "reviewed" rows stop at
 *  JOURNAL_LEDGER_CLEAN_CAP so a large clean manifest cannot crowd the board, while
 *  "skipped"/"failed" rows — the ones that mark the coverage guarantee breaking — keep the
 *  full JOURNAL_LEDGER_CAP reserve. Both share the single journalSlot counter with the
 *  findings channel. Attempts and landings are counted so the ledger close-out can state
 *  exactly what the board omits. `closeOut` is the synthetic close-out card only: it spends
 *  the budget's reserved last slot and is not a file card (it does not count as an attempt).
 *  The report tag stays a compile-time literal here. */
function journalLedgerCard(row: LedgerRow, closeOut = false): void {
  if (!closeOut) ledgerCardAttempts++;
  const cap = closeOut
    ? JOURNAL_ITEM_BUDGET
    : row.verdict === "reviewed"
      ? JOURNAL_LEDGER_CLEAN_CAP
      : JOURNAL_LEDGER_CAP;
  if (journalSlot(cap, closeOut)) {
    ledgerCardsJournaled++;
    report(journalBrief(row), "coverage");
  }
}

/** The coverage ledger board — declared once at top level, fed by report(item, "coverage"). */
artifact.board("coverage", {
  title: "Coverage ledger: every file OCR selected",
  key: "path",
  status: "verdict",
  columns: ["reviewed", "skipped", "failed"],
  cardTitle: "path",
  detail: [{ field: "note" }, { field: "findingCount" }],
});

/** Single publish site (lesson 1): the writer's returned file is primary; the compact
 *  fallback carries no primary flag and cannot throw (lesson 5). */
async function publishReport(docPath: string, compactMarkdown: string): Promise<void> {
  // Card titles are capped at 120 characters, so a caller-supplied long ref cannot reject
  // the publish of an otherwise good report.
  const title = ("Deep code review " + fromRef + ".." + toRef).slice(0, 120);
  try {
    await artifact.file("review-report", docPath, {
      title,
      description:
        "The coverage-guaranteed review: every file reviewed or skipped with a reason, " +
        "findings with their evidence, and the exact gates that ran.",
      primary: true,
    });
  } catch {
    try {
      await artifact.markdown("review-report-compact", compactMarkdown.slice(0, COMPACT_MARKDOWN_MAX_CHARS), {
        title: "Deep code review (compact)",
      });
    } catch {
      log("Neither publish landed; the report file remains in the workspace at " + docPath);
    }
  }
}

/** Markdown artifacts are capped at 256KB of BYTES (§16.2), while JS slice() counts UTF-16
 *  code units, so a char cap must be chosen from the worst case: 60 000 chars × 4 bytes
 *  (the largest UTF-8 sequence) = 240KB, under the cap for any content. Every compact
 *  publish goes through this builder, so the bound holds on both fallback paths. */
const COMPACT_MARKDOWN_MAX_CHARS = 60_000;

function compactMarkdown(topLine: string): string {
  const lines = [
    "# Deep code review " + fromRef + ".." + toRef,
    "",
    topLine,
    "",
    "## Findings",
    ...findingsPool
      .slice()
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .slice(0, 40)
      .map(
        (f) =>
          "- [" + f.severity + "/" + f.status + "] " + f.where + " — " + f.what +
          " (evidence: " + f.evidence.slice(0, 300) + ")",
      ),
    "",
    "## Verified gates",
    ...verified.map((v) => "- " + v),
    "",
    "## Not covered",
    ...notCovered.map((n) => "- " + n),
  ];
  return lines.join("\n").slice(0, COMPACT_MARKDOWN_MAX_CHARS);
}

/** Chain one finding to an independent confirmer and into the pool + journal.
 *  agentKey names the finding for unique computed subagent names (lesson 7). */
async function confirmAndPool(
  agentPrefix: string,
  agentKey: string,
  index: number,
  source: ReviewFinding["source"],
  where: string,
  what: string,
  evidence: string,
  severity: "low" | "medium" | "high",
): Promise<ReviewFinding> {
  const id = nextFindingId++;
  const confirmer = agent(agentPrefix + " " + agentKey + " #" + index, {
    system:
      "You confirm one review finding with fresh eyes, from its evidence alone. You were " +
      "not part of the review that produced it and you take nothing on trust: open the cited " +
      "lines, rerun a read-only command if that decides it. confirmed=true only for what you " +
      "reproduced yourself. A finding you cannot reproduce is still reported — you just say " +
      "what you saw. " +
      SAFETY_RULES,
  });
  const verdict = await confirmer.ask<Confirmation>(
    "Confirm this finding from the code alone (range under review: " + fromRef + ".." + toRef +
      ").\n\nFinding: " + JSON.stringify({ where: where, what: what, evidence: evidence, severity: severity }) +
      "\n\nReproduce it yourself — read the cited lines, or rerun a read-only command that " +
      "decides it — then return confirmed and a one-sentence note of what you saw. If the " +
      "finding rests on an OCR rule, the checklist for a path comes from 'ocr delegate rule " +
      "<path>' (read-only, instant); only the finding's own path needs that.\n\n" +
      SAFETY_RULES,
  );
  const pooled: ReviewFinding = {
    id: id,
    where: where,
    what: what,
    evidence: verdict.confirmed ? evidence + " | confirmer: " + verdict.note : "UNCONFIRMED — confirmer: " + verdict.note + " | original: " + evidence,
    status: verdict.confirmed ? "verified" : "unconfirmed",
    severity: severity,
    source: source,
  };
  findingsPool.push(pooled);
  if (journalSlot(JOURNAL_ITEM_BUDGET)) {
    report(journalBrief({ id: id, where: where, what: what, severity: severity, status: pooled.status, source: source }));
  }
  return pooled;
}

// ─── Phase 1: deterministic toolchain + manifest probes ───────────────────────

phase("Probe the review toolchain and pin the file manifest");
log("Checking the ocr CLI, its LLM endpoint, and OCR's authoritative file list for " + fromRef + ".." + toRef + ".");

// Every world read below is failure-tolerant: git.* rejects outside a repository and
// world.run rejects when a command cannot be spawned (§5, §16.3) — both are the skill's
// own expected starting conditions (no CLI installed, no repo), so they must reach the
// stage-0 gate as evidence rather than kill the run.
let headCommits: GitCommit[] = [];
let treeStatus: GitStatus = { clean: false, staged: [], unstaged: [], untracked: [] };
let gitReadable = true;
try {
  headCommits = await git.log(1);
  treeStatus = await git.status();
} catch {
  gitReadable = false;
  notCovered.push("the git reads were rejected — this workspace is not a readable git repository (every git.* call rejects outside one)");
}
const headSubject = headCommits[0] ? headCommits[0].subject : "";

let versionRun: WorldRunResult | null = null;
let versionSpawnError = "";
try {
  versionRun = await world.run("ocr", ["--version"]);
} catch {
  versionSpawnError = "the ocr command could not be spawned at all (not installed or not on PATH)";
}
const versionOut =
  versionRun === null
    ? versionSpawnError
    : versionRun.stdout.trim() !== ""
      ? versionRun.stdout
      : versionRun.stderr;
const versionMatch = /v(\d+)\.(\d+)\.(\d+)/.exec(versionOut);
const cliPresent = versionRun !== null && versionRun.exitCode === 0 && versionMatch !== null;
const cliSupportsJsonFile = versionMatch
  ? Number(versionMatch[1]) > 1 || (Number(versionMatch[1]) === 1 && Number(versionMatch[2]) >= 10)
  : false;
verified.push(
  versionRun === null
    ? "world.run ocr --version -> rejected: " + versionSpawnError
    : "world.run ocr --version -> exit " + versionRun.exitCode + " (" + firstLine(versionOut) + ")",
);

let llmTest: WorldRunResult | null = null;
let llmTestError = "";
if (cliPresent) {
  try {
    llmTest = await world.run("ocr", ["llm", "test"], { timeoutMs: 120_000 });
    verified.push(
      "world.run ocr llm test -> exit " + llmTest.exitCode + " (" + firstLine(llmTest.stdout) + "; prints Source/URL/Model only, never a secret)",
    );
  } catch {
    llmTestError = "the endpoint test timed out or failed to spawn";
    verified.push("world.run ocr llm test -> rejected (timeout/spawn failure) after 120s");
  }
}
const llmReady = llmTest !== null && llmTest.exitCode === 0;

// The skill file every ask cites must actually be there: args.skillPath is caller-settable,
// so a wrong path would otherwise silently starve all seven asks (and the leak-finding text)
// of their referenced procedure. One script-side read settles it; over-cap rejection is
// caught like any other world read.
let skillReadable = false;
let skillReadNote = "";
try {
  const skillText = await files.read(SKILL_MD);
  skillReadable = skillText.trim().length > 0;
  if (!skillReadable) skillReadNote = "exists but is empty";
} catch {
  skillReadNote = "missing or unreadable at the configured path";
}
if (skillReadable) {
  verified.push("files.read(" + SKILL_MD + ") -> readable; the procedure every ask cites is present");
} else {
  notCovered.push("the source skill file at " + SKILL_MD + " " + skillReadNote + " — every ask's pointer to the skill's procedure dangles until args.skillPath is fixed or the file is restored");
}

let preview: WorldRunResult | null = null;
let previewError = "";
if (cliPresent) {
  try {
    preview = await world.run("ocr", ["delegate", "preview", "--from", fromRef, "--to", toRef]);
    verified.push("world.run ocr delegate preview --from " + fromRef + " --to " + toRef + " -> exit " + preview.exitCode);
  } catch {
    previewError = "the preview command failed to spawn or timed out";
  }
}

const manifest = preview && preview.exitCode === 0 ? parsePreview(preview.stdout) : null;
if (manifest && !manifest.parsed) {
  notCovered.push("the delegate preview output did not match the documented shape (SKILL.md:97) — the manifest is treated as unparseable");
}
let ledgerFiles: string[] = manifest ? manifest.files.slice() : [];
const ledgerSource = manifest && manifest.parsed ? "ocr-delegate-preview" : "git-changedFiles-fallback";

// Cross-check against journaled git when the two views are comparable at all:
// a clean tree with the range ending at HEAD.
let gitOnlyFiles: string[] = [];
let gitCrossCheckNote = "";
if (gitReadable && treeStatus.clean && toRef === "HEAD") {
  try {
    const changed = await git.changedFiles(fromRef);
    const accounted = new Set<string>([
      ...ledgerFiles,
      ...(manifest ? manifest.excluded.map((e) => e.path) : []),
    ]);
    gitOnlyFiles = changed.filter((c) => !accounted.has(c));
    verified.push("git.changedFiles(" + fromRef + ") cross-checked the OCR manifest on a clean tree");
  } catch {
    gitCrossCheckNote = "git.changedFiles rejected (missing base ref or unreadable repo) — no cross-check";
    notCovered.push(gitCrossCheckNote);
  }
} else if (gitReadable) {
  gitCrossCheckNote = treeStatus.clean
    ? "the range does not end at HEAD — the git cross-check was skipped as not comparable"
    : "the working tree is dirty — uncommitted changes are NOT part of a " + fromRef + ".." + toRef + " review and the git cross-check was skipped";
  notCovered.push(gitCrossCheckNote);
}
if (manifest && manifest.reviewableCount >= 0 && manifest.reviewableCount !== manifest.files.length) {
  notCovered.push("the preview header count (" + manifest.reviewableCount + ") disagrees with the parsed reviewable bullets (" + manifest.files.length + ") — the header is quoted to the gatekeeper as a ledger-integrity fact");
}

// ─── Phase 2: stage-0 gate with the run owner ─────────────────────────────────

phase("Decide with the run owner how far this review can go");
const gatekeeper: Agent = agent("Stage-0 gatekeeper", {
  system:
    "You are the stage-0 gate of the ocr-code-review skill at " + SKILL_MD + " (its 'Integrating " +
    "into a review process' section, SKILL.md:130-136, says OCR's real value is the coverage " +
    "ledger computed before any reviewer runs). You decide what this review may do, and you " +
    "escalate every decision that belongs to the human who started the run — installing or " +
    "upgrading a global CLI, configuring or repairing an LLM provider (that involves API keys, " +
    "which you must never handle), approving token spend for the paid `ocr review` round, or " +
    "resolving a manifest you cannot trust. Your escalate allowance is SMALL, so when several " +
    "owner-only questions arise, escalate AT MOST ONE — the one that blocks the most of this " +
    "review (paid-round spend first, then an untrusted manifest, then install/config/upgrade) — " +
    "with the evidence and one focused question, and apply the stated no-answer default to " +
    "every other one, recording each decision and whether it came from the owner or a default " +
    "in ownerNote. You never write anything: not repo files, not ocr config, not credentials. " +
    SAFETY_RULES,
});
const decision = await gatekeeper.ask<ScopeDecision>(
  "Environment evidence for this review run (range " + fromRef + ".." + toRef +
    "; HEAD subject: " + (headSubject === "" ? "unknown" : headSubject) + "):\n" +
    "- ocr CLI present: " + (cliPresent ? "yes (" + firstLine(versionOut) + ")" : "NO — " + (versionRun === null ? versionSpawnError : "exit " + versionRun.exitCode + ", output: " + firstLine(versionOut))) + "\n" +
    "- CLI supports '--format json -o' (v1.10+, SKILL.md:86-87): " + (cliSupportsJsonFile ? "yes" : "NO — per SKILL.md:86-87 the fix is an upgrade, which is an owner decision") + "\n" +
    "- endpoint test (ocr llm test): " + (llmTest === null ? (llmTestError === "" ? "not run (CLI missing)" : llmTestError) : "exit " + llmTest.exitCode + "; first lines: " + llmTest.stdout.split("\n").slice(0, 3).join(" / ")) + "\n" +
    "- skill file readable (every ask cites it): " + (skillReadable ? "yes (" + SKILL_MD + ")" : "NO — " + skillReadNote + "; the fix is the owner's (correct args.skillPath or restore the file); no-answer default: proceed, with reviewers leaning on general correctness and the CLI's own checklists") + "\n" +
    "- delegate preview: " + (preview === null ? (previewError === "" ? "not run (CLI missing)" : previewError) : "exit " + preview.exitCode + "; parsed: " + (manifest ? manifest.parsed : false) + "; reviewable header count " + (manifest ? manifest.reviewableCount : -1) + " / total " + (manifest ? manifest.totalCount : -1) + "; parsed reviewable files " + ledgerFiles.length + "; excluded by OCR rules " + (manifest ? manifest.excluded.length : 0) + (manifest && manifest.excluded.length > 0 ? " (" + manifest.excluded.map((e) => e.path + ": " + e.reason).join("; ").slice(0, 600) + ")" : "")) + "\n" +
    "- merge_base reported: " + (manifest ? manifest.mergeBase : "") + "\n" +
    "- files git sees but the manifest does not account for: " + (gitOnlyFiles.length === 0 ? "none" : gitOnlyFiles.join(", ")) + "\n" +
    "- git readable: " + gitReadable + (gitReadable ? " — working tree clean: " + treeStatus.clean + " (branch " + (treeStatus.branch ?? "detached") + ")" : "") + "\n\n" +
    "Decide proceed and llmRound. Read the skill sections cited above yourself before ruling. " +
    "Owner-only questions, each with its no-answer default. Your escalation allowance is " +
    "small, so raise AT MOST ONE escalation — the single question that blocks the most of " +
    "this review (paid-round spend outranks an untrusted manifest, which outranks install/" +
    "upgrade or provider repair) — and apply the stated default to every other owner-only " +
    "question, recording each decision in ownerNote with whose call it was (the owner's " +
    "answer, or the default). The questions: (a) the CLI is missing or too old " +
    "— install/upgrade is a global system change; no-answer default: proceed in git-derived " +
    "ledger mode without OCR's paid round. (b) the endpoint test failed or was never configured " +
    "— configuring it needs the owner's own API keys (SKILL.md:35-43 is their recipe; this run " +
    "must never handle keys); no-answer default: delegate-only (SKILL.md:95-101 — free, no LLM, " +
    "you supply the reasoning). (c) the paid 'ocr review' round spends the owner's model quota " +
    "and takes minutes (SKILL.md:64-76 argues the better model is worth it; SKILL.md:85 says run " +
    "it backgrounded — this run does, concurrently with its own per-file review). Ask the owner " +
    "to approve it when the endpoint is ready; no-answer default when the endpoint is NOT ready: " +
    "decline. (d) the manifest is unparseable or wildly disagrees with git — escalate; no-answer " +
    "default: proceed with the git-derived manifest, labelled as such. Set proceed='abort' only " +
    "when even a git-derived review is impossible (e.g. no repository). Report in ownerNote " +
    "exactly what the owner answered or which default you used, quoted from their escalation " +
    "reply where there was one.\n\n" +
    SAFETY_RULES,
);
if (decision.proceed === "abort") {
  log("The stage-0 gate aborted the review: " + decision.ownerNote);
  notCovered.push("the entire review: the stage-0 gate ruled abort — " + decision.ownerNote.slice(0, 400));
  const abortTop = "The review did not run: the stage-0 gate (" + SKILL_MD + " coverage gate) ruled abort. " + decision.ownerNote;
  await publishCompactOnly(abortTop);
  const abortReport: WorkflowReport = {
    conclusion: abortTop,
    findings: [],
    verified: verified,
    notCovered: notCovered,
  };
  return abortReport;
}
async function publishCompactOnly(topLine: string): Promise<void> {
  // Early-exit path: no writer ran, so the compact publish is this run's only artifact —
  // and it carries no primary flag (lesson 1: "review-report" is the single primary id).
  // Awaited so it lands before the run ends, and wrapped so it cannot throw (lesson 5).
  try {
    await artifact.markdown("review-report-compact", compactMarkdown(topLine), {
      title: "Deep code review (compact)",
    });
  } catch {
    log("The compact report could not be published; the gate's verdict stands in the run's result.");
  }
}
log("Stage-0 gate: " + (decision.llmRound ? "delegate fan-out + paid OCR round" : "delegate fan-out only (free)") + ". " + decision.ownerNote);
if (ledgerSource === "git-changedFiles-fallback") {
  log("OCR's manifest is unusable or absent — building the ledger from journaled git and the delegate preview fallback.");
  try {
    ledgerFiles = await git.changedFiles(fromRef);
  } catch {
    ledgerFiles = [];
    notCovered.push("the git fallback manifest failed too — there are no files to review");
  }
}

// ─── Phase 3: rule checklist + (approved) paid round started, not awaited ─────

phase("Pull OCR's rule checklist and open the paid review round");
let ruleGroupCount = -1;
if (cliPresent && ledgerFiles.length > 0) {
  try {
    const rulesRun = await world.run("ocr", ["delegate", "rule", ...ledgerFiles]);
    if (rulesRun.exitCode === 0) {
      ruleGroupCount = countRuleGroups(rulesRun.stdout);
      verified.push("world.run ocr delegate rule <" + ledgerFiles.length + " manifest files> -> exit 0 (" + ruleGroupCount + " rule groups; format per this session's capture: '### Rule Group N: <origin> / <glob>' + 'Applies to:' bullets)");
    } else {
      notCovered.push("ocr delegate rule exited " + rulesRun.exitCode + " — reviewers were told to fetch each file's checklist themselves");
    }
  } catch {
    notCovered.push("ocr delegate rule failed to run — reviewers fetch each file's checklist themselves");
  }
}
/** The paid round, started here and collected in its own phase. Its promise is settled into
 *  a value AT CREATION (settleRound), so it can sit unawaited across the whole fan-out
 *  without ever becoming an unhandled rejection. */
let ocrRun: Promise<SettledRound> | null = null;
if (decision.llmRound && cliPresent && cliSupportsJsonFile && llmReady && ledgerFiles.length > 0) {
  let mkdir: WorldRunResult | null = null;
  let mkdirSpawnError = "";
  try {
    mkdir = await world.run("mkdir", ["-p", OUT_DIR]);
  } catch {
    mkdirSpawnError = "could not be spawned";
  }
  if (mkdir === null || mkdir.exitCode !== 0) {
    notCovered.push(
      "mkdir -p " + OUT_DIR + " " +
        (mkdir === null ? mkdirSpawnError : "exited " + mkdir.exitCode) +
        " — the paid round cannot write its JSON file and was skipped",
    );
  } else {
    log("Starting the paid 'ocr review' round in the background (SKILL.md:85: never foreground) while the per-file fan-out works.");
    // Unawaited on purpose (§7): the slow LLM round runs concurrently with the fan-out.
    // No extra CLI flag: SKILL.md:85-87 documents no backgrounding flag ("run it as a
    // background process" = do not block on it, which the unawaited world.run does), and
    // this CLI errors on undocumented flags (SKILL.md:87).
    ocrRun = settleRound(
      world.run(
        "ocr",
        [
          "review",
          "--from",
          fromRef,
          "--to",
          toRef,
          "--audience",
          "agent",
          "--format",
          "json",
          "-o",
          RESULTS_JSON,
        ],
        { timeoutMs: LLM_TIMEOUT_MS },
      ),
    );
  }
} else if (decision.llmRound) {
  notCovered.push("the owner approved the paid round but a precondition failed (CLI present: " + cliPresent + ", json -o supported: " + cliSupportsJsonFile + ", endpoint ready: " + llmReady + ", reviewable files: " + ledgerFiles.length + ") — the round did not start");
} else {
  notCovered.push("the paid 'ocr review' LLM round: declined at the stage-0 gate — " + decision.ownerNote.slice(0, 300));
}

// ─── Phase 4: per-file deep review, confirmers chained per file ───────────────

phase("Review every file on the manifest and confirm its findings as they land");
log("Fan-out sized: " + ledgerFiles.length + " file(s) on the ledger.");
const excludedSummary =
  manifest && manifest.parsed && manifest.excluded.length > 0
    ? " OCR also excluded " + manifest.excluded.length + " changed file(s) by its own rules: " +
      manifest.excluded.map((e) => "`" + e.path + "` (" + e.reason + ")").join(", ") + "."
    : "";

interface LedgerRow {
  path: string;
  verdict: "reviewed" | "skipped" | "failed";
  note: string;
  findingCount: number;
}
const ledgerRows: LedgerRow[] = [];

function reviewerAskText(path: string, attempt: number): string {
  return (
    "You are the per-file reviewer on the coverage ledger for the range " + fromRef + ".." + toRef +
    " (attempt " + attempt + "). The contract is the ocr-code-review skill's closing section (" +
    SKILL_MD + ":130-136): every file must end 'reviewed' or 'skipped' WITH A REASON — a file that " +
    "silently disappears is the defect this whole workflow exists to prevent.\n\n" +
    "Your file: " + path + "\n\n" +
    "Steps: (1) get this file's own rule checklist by running 'ocr delegate rule " + path + "' " +
    "yourself — instant, zero-cost, read-only (SKILL.md:95-101); if it errors, say so in your " +
    "reasoning and review against general correctness plus what you can read of the skill. " +
    "(2) read the file's diff for the range (git diff " + fromRef + " " + toRef + " -- " + path +
    ", read-only) and enough of the file itself to judge each hunk. (3) audit against EVERY rule " +
    "heading in the checklist (typos, dead code, the code-quality list, framework best practices " +
    "where the language fits) and against correctness, security and data-safety of the change " +
    "itself. Set rule to the exact checklist heading violated, or 'general'.\n\n" +
    "Only report problems in THIS file, and only those this change makes relevant — a pre-existing " +
    "smell the diff does not touch is out of scope. An empty findings array is a clean pass. " +
    "If the file genuinely does not merit review (pure rename, generated, vendored), return " +
    "verdict 'skipped' with the concrete reason; do not fabricate findings to look busy, and do " +
    "not return 'reviewed' without having read the diff.\n\n" +
    "Return path (exactly as given above), verdict, reason, findings.\n\n" +
    SAFETY_RULES
  );
}

async function chainConfirmers(
  path: string,
  agentPrefix: string,
  findings: FileFinding[],
): Promise<void> {
  let count = 0;
  for (const f of findings) {
    await confirmAndPool(
      agentPrefix,
      path,
      count,
      "per-file",
      f.where === "" ? path : f.where,
      f.what,
      f.evidence,
      f.severity,
    );
    count++;
  }
}

const firstPassRows = await Promise.all(
  ledgerFiles.map(async (path): Promise<LedgerRow> => {
    const reviewer = agent("Code reviewer " + path, {
      system:
        "You are a senior engineer auditing one file of a changeset against the rule checklist " +
        "the open-code-review CLI generates for it, and against correctness. You read and run " +
        "read-only commands only; the script runs the paid LLM round, not you. " +
        SAFETY_RULES,
    });
    try {
      const outcome = await reviewer.ask<ReviewOutcome>(reviewerAskText(path, 1));
      await chainConfirmers(path, "Finding confirmer", outcome.findings);
      const row: LedgerRow = {
        path: path,
        verdict: outcome.verdict,
        note: outcome.verdict === "skipped" ? outcome.reason : outcome.findings.length + " finding(s)",
        findingCount: outcome.findings.length,
      };
      journalLedgerCard(row);
      ledgerRows.push(row);
      return row;
    } catch {
      const row: LedgerRow = { path: path, verdict: "skipped", note: REVIEWER_FAILED, findingCount: 0 };
      ledgerRows.push(row);
      return row;
    }
  }),
);
verified.push("per-file review fan-out: " + firstPassRows.length + " manifest file(s) asked for a terminal ledger verdict");

// ─── Phase 5: close the ledger (bounded repair rounds, then leak findings) ────

phase("Close the coverage ledger");
let openFailures = firstPassRows.filter((r) => r.note === REVIEWER_FAILED).map((r) => r.path);
for (let round = 1; round <= RETRY_ROUNDS; round++) {
  if (openFailures.length === 0) break;
  log("Ledger repair pass: " + openFailures.length + " file(s) still lack a verdict.");
  const repairRows = await Promise.all(
    openFailures.map(async (path): Promise<LedgerRow | null> => {
      const retry = agent("Repair reviewer " + path + " (round " + round + ")", {
        system:
          "You are the repair reviewer for files whose first review pass never delivered a " +
          "result. Same contract, fresh context, read-only. " + SAFETY_RULES,
      });
      try {
        const outcome = await retry.ask<ReviewOutcome>(reviewerAskText(path, round + 1));
        await chainConfirmers(path, "Repair confirmer", outcome.findings);
        const row: LedgerRow = {
          path: path,
          verdict: outcome.verdict,
          note: outcome.verdict === "skipped" ? outcome.reason : outcome.findings.length + " finding(s)",
          findingCount: outcome.findings.length,
        };
        journalLedgerCard(row);
        ledgerRows.push(row);
        return row;
      } catch {
        return null;
      }
    }),
  );
  openFailures = openFailures.filter((p, i) => repairRows[i] === null);
}
for (const path of openFailures) {
  // No confirmer for this one: the script's own loop decided it (§10 — a check the script
  // ran is already confirmed; a confirmer could not reproduce "a reviewer never answered").
  const row: LedgerRow = { path: path, verdict: "failed", note: "no reviewer pass produced a result", findingCount: 1 };
  ledgerRows.push(row);
  journalLedgerCard(row);
  const leak: ReviewFinding = {
    id: nextFindingId++,
    where: "ledger:" + path,
    what:
      "File " + path + " could not be reviewed by any pass — the coverage guarantee of the " +
      "stage-0 ledger (" + SKILL_MD + ":130-136) is broken for it",
    evidence:
      "script-observed: the first reviewer and every repair ask for this path produced no " +
      "usable result; no independent reproduction is possible for a missing reviewer",
    status: "verified",
    severity: "high",
    source: "ledger",
  };
  findingsPool.push(leak);
  if (journalSlot(JOURNAL_ITEM_BUDGET)) {
    report(journalBrief({ id: leak.id, where: leak.where, what: leak.what, severity: leak.severity, status: leak.status, source: leak.source }));
  }
}
// Last-write-wins per path: a file whose first pass failed and whose repair pass answered
// shows once, with its final verdict, instead of double-counting the ledger.
const ledgerByPath = new Map<string, LedgerRow>();
for (const row of ledgerRows) ledgerByPath.set(row.path, row);
const finalLedger = Array.from(ledgerByPath.values());
const reviewedCount = finalLedger.filter((r) => r.verdict === "reviewed").length;
const skippedCount = finalLedger.filter((r) => r.verdict === "skipped").length;
const failedCount = finalLedger.filter((r) => r.verdict === "failed").length;
const ledgerTotal = ledgerFiles.length;
const coverageRate = ledgerTotal === 0 ? 1 : (reviewedCount + skippedCount) / ledgerTotal;
verified.push(
  "coverage ledger closed: " + reviewedCount + " reviewed, " + skippedCount + " skipped with a reason, " +
    failedCount + " failed, of " + ledgerTotal + " manifest file(s) (coverage_rate " +
    (Math.round(coverageRate * 1000) / 10) + "%)",
);
// If the board could not hold every card, say so ON the board: one close-out card states the
// omission instead of letting a truncated board read as complete coverage. Clean rows were
// refused first (JOURNAL_LEDGER_CLEAN_CAP), by design; the full ledger lives in the report
// file and the returned result either way.
const cardsOnBoard = ledgerCardsJournaled;
const cardsAttempted = ledgerCardAttempts;
const ledgerCardsOmitted = cardsAttempted - cardsOnBoard;
if (ledgerCardsOmitted > 0) {
  // Counts are captured BEFORE this card is journaled so the note and the notCovered entry
  // describe the file cards only; the reserved slot means this card itself always lands.
  journalLedgerCard(
    {
      path: "(ledger close-out)",
      verdict: "failed",
      note:
        "board truncated: " + cardsOnBoard + " of " + cardsAttempted +
        " file card(s) fit the journal budget (clean rows refused first, by design); the omitted " +
        "card(s) are in the report file's ledger table and the returned result, not on this board",
      findingCount: failedCount,
    },
    true,
  );
  notCovered.push(
    "the coverage board carries " + cardsOnBoard + " of " + cardsAttempted +
      " file card(s) (journal budget; the reserved last slot carries a close-out card saying so); the " +
      ledgerCardsOmitted + " omitted card(s) are in the report file's ledger table and the returned result",
  );
}

// ─── Phase 6: collect the paid round, read its warnings, confirm its findings ─

phase("Collect the paid review round and confirm its findings");
let ocrRoundNote = "the paid round did not run (delegate-only or a precondition failed)";
if (ocrRun !== null) {
  // settleRound attached both handlers at creation, so this await cannot throw — the
  // outcome arrives as a value.
  const settled = await ocrRun;
  const round = settled.result;
  if (round === null) {
    ocrRoundNote =
      "the paid round never returned a result: " +
      (settled.failure === "" ? "no result and no recorded error" : settled.failure.slice(0, 300));
    notCovered.push("the paid 'ocr review' round failed to spawn or hit its wall-clock ceiling (SKILL.md:85: it is slow): " + settled.failure.slice(0, 300));
  } else if (round.exitCode === 0) {
    let parsedJson: OcrJsonShape | null = null;
    try {
      const raw = await files.read(RESULTS_JSON);
      parsedJson = JSON.parse(raw) as OcrJsonShape;
    } catch {
      ocrRoundNote = "ocr review exited 0 but its JSON file at " + RESULTS_JSON + " could not be read or parsed";
      notCovered.push(ocrRoundNote);
    }
    if (parsedJson !== null) {
      const commentCount = parsedJson.comments ? parsedJson.comments.length : 0;
      const warningLines = (parsedJson.warnings ?? []).map((w) =>
        typeof w === "string" ? w : JSON.stringify(w).slice(0, 400),
      );
      // SKILL.md:91-92: ALWAYS read warnings — a dropped round means coverage is
      // worse than the file count implies.
      const roundFailed = warningLines.some((w) => w.includes("review_round_failed") || w.includes("429"));
      ocrRoundNote =
        "ocr review: " + commentCount + " comment(s); summary files_reviewed " +
        (parsedJson.summary && typeof parsedJson.summary.files_reviewed === "number" ? parsedJson.summary.files_reviewed : "n/a") +
        ", total_tokens " + (parsedJson.summary && typeof parsedJson.summary.total_tokens === "number" ? parsedJson.summary.total_tokens : "n/a") +
        "; warnings: " + (warningLines.length === 0 ? "none" : warningLines.join(" | ").slice(0, 800));
      if (roundFailed) {
        notCovered.push("the paid round reported review_round_failed/429 warnings — its own coverage is worse than its file count implies (SKILL.md:91-92); the per-file ledger fan-out is what the report leans on");
      }
      verified.push("world.run ocr review --from " + fromRef + " --to " + toRef + " --format json -o " + RESULTS_JSON + " -> exit 0; warnings read (SKILL.md:91-92)");
      let idx = 0;
      for (const c of parsedJson.comments ?? []) {
        const where =
          (c.path ?? "") + (typeof c.start_line === "number" ? ":" + c.start_line + (typeof c.end_line === "number" ? "-" + c.end_line : "") : "");
        const what = (c.content ?? "(no content in JSON comment)").slice(0, 800);
        const evidence = "OCR paid-round comment" + (c.category ? " in category " + c.category : "") + "; severity label '" + (c.severity ?? "none") + "'";
        await confirmAndPool("OCR-round confirmer", where === "" ? "comment" : where, idx, "ocr-round", where === "" ? "(unpathed comment)" : where, what, evidence, severityFromOcr(c.severity ?? ""));
        idx++;
      }
    }
  } else {
    ocrRoundNote = "ocr review exited " + round.exitCode + ": " + firstLine(round.stderr);
    notCovered.push("the paid round failed: " + ocrRoundNote.slice(0, 300));
  }
  log("Paid round: " + ocrRoundNote.slice(0, 400));
}

// ─── Phase 7: audit this repo's OCR GitHub Action against the hardening rules ─

phase("Audit this repository's OCR GitHub Action against the hardening rules");
let actionPaths: string[] = [];
try {
  const hits = await files.grep("alibaba/open-code-review", ".github/workflows/*");
  actionPaths = Array.from(new Set(hits.map((h) => h.path)));
} catch {
  notCovered.push("the workflow-file search failed or overran its cap — the CI audit reports on whatever paths it finds itself");
}
const auditor = agent("GitHub Action auditor", {
  system:
    "You audit a repository's OpenCodeReview GitHub Action against the four non-obvious " +
    "hardening requirements the skill verified across 11 repos (" + SKILL_MD + ":103-128), " +
    "quoting exact YAML lines as evidence. You never edit files and never run any gh write " +
    "command. " + SAFETY_RULES,
});
const actionAudit = await auditor.ask<ActionAudit>(
  "Audit this repository's OpenCodeReview GitHub Action. Requirements to check, all from " +
    SKILL_MD + ":103-128 — read that section first and quote it accurately: (1) llm_use_anthropic " +
    "is the STRING 'false', not an empty string (an empty string silently selects Anthropic and " +
    "the run dies on llm_reasoning_effort); (2) a per-PR concurrency group with " +
    "cancel-in-progress: true; (3) the issue_comment trigger gated to " +
    "author_association OWNER/MEMBER/COLLABORATOR; (4) same-repo PRs only " +
    "(head.repo.full_name == github.repository) so fork PRs are skipped, not reddened. Plus: " +
    "actions/checkout with fetch-depth: 0 (merge-base resolution), and the secrets rule — a " +
    "fine-grained PAT cannot set Actions secrets on PUBLIC repos (403), so public repos need " +
    "OCR_LLM_URL / OCR_LLM_AUTH_TOKEN / OCR_LLM_MODEL added via the web UI; check repo " +
    "visibility read-only (gh repo view --json visibility -R <owner>/<repo>, or the git remote) " +
    "and mark 'unclear' rather than guessing when you cannot tell.\n\n" +
    "Workflow files the script's own search found referencing the action: " +
    (actionPaths.length === 0 ? "none — verify yourself with a read-only search of .github/workflows/; if truly absent return applicable=false with empty checks" : actionPaths.join(", ")) +
    ".\n\nReturn applicable, file, checks (one per requirement, with exact quoted lines as evidence).\n\n" +
    SAFETY_RULES,
);
if (actionAudit.applicable) {
  let checkIdx = 0;
  for (const chk of actionAudit.checks) {
    if (chk.status === "fail") {
      await confirmAndPool(
        "Action-check confirmer",
        actionAudit.file,
        checkIdx,
        "action-audit",
        actionAudit.file,
        "CI hardening requirement not met: " + chk.requirement,
        chk.evidence.slice(0, 600),
        "medium",
      );
    }
    checkIdx++;
  }
  verified.push("GitHub Action audit over " + actionAudit.checks.length + " hardening requirement(s) from " + actionAudit.file);
} else {
  notCovered.push("CI hardening audit: this repo has no workflow using alibaba/open-code-review (verified by the auditor's own read-only search)");
}

// ─── Phase 8: merge, dedupe, rank, and write the report ───────────────────────

phase("Merge and rank the findings, then write the long-form report");
const ledgerTable = finalLedger
  .slice()
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((r) => ({ path: r.path, verdict: r.verdict, note: r.note.slice(0, 200) }));
const poolBrief = findingsPool.map((f) => ({
  id: f.id,
  where: f.where,
  what: f.what.slice(0, 300),
  severity: f.severity,
  status: f.status,
  source: f.source,
}));
const triage = agent("Finding triage", {
  system:
    "You deduplicate and rank the merged findings of one review run on a single fixed scale: " +
    "what a developer should fix first. You never invent findings and never drop one that is " +
    "not a duplicate. " + SAFETY_RULES,
});
const ranked = await triage.ask<TriageResult>(
  "These are all findings from one review pass over " + fromRef + ".." + toRef + " (per-file " +
    "deep review, the paid OCR round, coverage-ledger leaks, and a CI hardening audit). Return " +
    "order: the ids worth surfacing, best-to-fix first; and duplicates: ids that restate another " +
    "finding, each mapped to the id it duplicates. A finding confirmed=false/'unconfirmed' still " +
    "ranks on what it claims — status is not a reason to duplicate-discard it.\n\n" +
    JSON.stringify(poolBrief) +
    "\n\nYou judge the JSON above only — open nothing, run nothing.\n\n" +
    SAFETY_RULES,
);
const byId = new Map<number, ReviewFinding>();
for (const f of findingsPool) byId.set(f.id, f);
const surfaced: ReviewFinding[] = [];
const seenIds = new Set<number>();
for (const id of ranked.order) {
  const f = byId.get(id);
  if (f && !seenIds.has(id)) {
    surfaced.push(f);
    seenIds.add(id);
  }
}
const dupPairs: { id: number; ofId: number }[] = [];
for (const d of ranked.duplicates) {
  if (byId.has(d.id) && byId.has(d.ofId) && d.id !== d.ofId) {
    dupPairs.push(d);
    seenIds.add(d.id);
  }
}
for (const f of findingsPool) {
  if (!seenIds.has(f.id)) surfaced.push(f);
}
const foldedCount = dupPairs.length;

const writer = agent("Report writer", {
  system:
    "You turn a finished review's structured results into one long-form Markdown report a " +
    "developer can act from. You state only what the inputs support, you keep each finding's " +
    "verified/unconfirmed status visible, and you attribute every claim to the evidence given. " +
    "You run nothing and read nothing outside the input; you write exactly one file, under the " +
    "gitignored out/ directory, and return the path you wrote. " + SAFETY_RULES,
});
// The writer's input is composed of briefs, not raw state: every string field is sliced and
// the ledger table is row-capped (overflow is stated, not silently dropped), because a
// ContextLimit in this one ask would otherwise kill the run and lose the deliverable.
const LEDGER_TABLE_MAX_ROWS = 800;
const writerFindings = surfaced.map((f) => ({
  id: f.id,
  where: f.where.slice(0, 300),
  what: f.what.slice(0, 400),
  evidence: f.evidence.slice(0, 900),
  status: f.status,
  severity: f.severity,
  source: f.source,
}));
const writerLedgerRows = ledgerTable.slice(0, LEDGER_TABLE_MAX_ROWS);
const writerLedgerDropped = ledgerTable.length - writerLedgerRows.length;
const writerActionAudit = {
  applicable: actionAudit.applicable,
  file: actionAudit.file,
  checks: actionAudit.checks.map((c) => ({
    requirement: c.requirement.slice(0, 300),
    status: c.status,
    evidence: c.evidence.slice(0, 700),
  })),
};
let doc: ReportDoc | null = null;
try {
  doc = await writer.ask<ReportDoc>(
  "Write the deep-review report for range " + fromRef + ".." + toRef + " to " + OUT_DIR +
    "/report.md (that path is yours to create; nothing else). Structure:\n" +
    "1. Headline: coverage_rate, the ledger counts, and the paid-round status in one paragraph.\n" +
    "2. The coverage ledger: every manifest file with its verdict and reason — this table is the " +
    "product (SKILL.md:130-136); files OCR excluded by its rules belong here with OCR's reason: " +
    excludedSummary + (writerLedgerDropped > 0
      ? " If ledgerTableRowsDropped below is positive, render the rows given, then state plainly " +
        "that the remaining " + writerLedgerDropped + " ledger rows live in the run's coverage " +
        "journal and returned result — never imply they were reviewed clean."
      : "") + "\n" +
    "3. Findings ranked best-to-fix first, each with severity, its verified/unconfirmed status, " +
    "and its evidence as given below (long fields arrive truncated by design).\n" +
    "4. Duplicates folded away, listed as 'id restates id'.\n" +
    "5. What the paid OCR round added or failed to add, including its warnings summary (the " +
    "skill's rule that warnings are always read, SKILL.md:91-92).\n" +
    "6. The CI hardening audit result, if applicable.\n" +
    "7. Verified / Not-covered sections reproducing the gate records given below.\n" +
    "8. A closing line about this skill's known gap: it ships no references/ directory and no " +
    "scripts/, so this run leaned on the single SKILL.md and the ocr CLI itself.\n\n" +
    "INPUTS (JSON — state only these facts, add no findings of your own):\n" +
    JSON.stringify({
      range: fromRef + ".." + toRef,
      head: headSubject,
      mergeBase: manifest ? manifest.mergeBase : "",
      ledgerSource: ledgerSource,
      counts: {
        reviewed: reviewedCount,
        skippedWithReason: skippedCount,
        failed: failedCount,
        manifestTotal: ledgerTotal,
        coverageRatePercent: Math.round(coverageRate * 1000) / 10,
        ocrExcluded: manifest && manifest.parsed ? manifest.excluded.length : 0,
        ruleGroups: ruleGroupCount,
      },
      ledgerTable: writerLedgerRows,
      ledgerTableRowsDropped: writerLedgerDropped,
      findings: writerFindings,
      duplicates: dupPairs,
      paidRound: ocrRoundNote.slice(0, 1000),
      actionAudit: writerActionAudit,
      ownerGate: decision.ownerNote.slice(0, 1000),
      verified: verified.map((v) => v.slice(0, 500)),
      notCovered: notCovered.map((n) => n.slice(0, 500)),
    }) +
    "\n\nReturn path (the exact file you wrote) and summary (two or three sentences answering " +
    "what the review found).\n\n" +
    SAFETY_RULES,
  );
} catch {
  // ask<T> failures (validation, ContextLimit) reject — catch them here so the run still
  // ships its results through the compact publish instead of dying at the last step.
  notCovered.push("the report writer ask failed (its input was too large or the result invalid) — the compact report published by this script carries the same results");
}

const finalFindings: Finding[] = surfaced.map((f) => ({
  where: f.where,
  what: f.what,
  evidence: f.evidence.slice(0, 1500) + (f.source === "ocr-round" ? " [from the paid OCR round]" : ""),
  status: f.status,
  severity: f.severity,
}));

// Awaited: a floating publish would be cut off when the script returns. When the writer
// ran, its RETURNED path is what is published (lesson 10) — never a path this script
// assumed; a non-string returned path falls through publishReport to the compact artifact.
// When the writer ask itself failed, the compact publish is composed script-side from the
// same arrays, so the run still ships a deliverable.
if (doc === null) {
  await publishCompactOnly(
    "The long-form writer could not run; this compact report is assembled by the script from " +
      "the same results. Coverage: " + reviewedCount + " reviewed / " + skippedCount +
      " skipped with a reason / " + failedCount + " failed, of " + ledgerTotal +
      " manifest file(s); " + findingsPool.length + " finding(s) pooled.",
  );
} else {
  await publishReport(
    typeof doc.path === "string" ? doc.path : "",
    compactMarkdown(typeof doc.summary === "string" ? doc.summary : "The writer returned no summary."),
  );
}

// §3 fresh-eyes accounting: every finding in this report was confirmed by an independent
// confirmer (or, for script-observed ledger leaks, decided by the script's own loop), so
// the report gets NO additional reader pass — a reader on top of confirmers is the
// correlated-review waste §3/§10 warn about. The report writer is itself a fresh context.

const conclusion =
  "Coverage-guaranteed review of " + fromRef + ".." + toRef + ": " + reviewedCount + " of " +
  ledgerTotal + " manifest file(s) fully reviewed, " + skippedCount + " skipped with a reason, " +
  failedCount + " unrecoverable (coverage_rate " + (Math.round(coverageRate * 1000) / 10) + "%). " +
  (finalFindings.length === 0
    ? "No findings survived review."
    : finalFindings.length + " finding(s) after triage (" + foldedCount + " duplicates folded). ") +
  ocrRoundNote + ". " +
  (doc === null
    ? "Report: the compact fallback artifact."
    : typeof doc.path === "string" ? "Report: " + doc.path + "." : "Report: the compact fallback artifact.");

const result: WorkflowReport = {
  conclusion: conclusion.slice(0, 1500),
  findings: finalFindings,
  verified: verified,
  notCovered: notCovered,
};
return result;
