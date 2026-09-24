/* zcode-workflow
description: "Grades a plan against itself acceptance criterion by acceptance
  criterion: the checklist is read by a subagent that did not write the plan,
  every verification command the plan claims passed is re-executed as a real
  gate, findings are independently confirmed, gaps are adjudicated and
  challenged by a fresh session, and the verdict is a go, no-go, or
  go-with-caveats. Embodies the spec-compliance-review skill."
whenToUse: When work is claimed done against a written plan or spec and the
  question is whether every acceptance criterion actually holds — especially
  before treating a plan's own passed checks as evidence.
args:
  plan:
    type: string
    description: Optional path to the plan document to grade. Omit to discover the
      plan from the repository's plan files.
    required: false
  base:
    type: string
    description: Optional git ref anchoring the changes under review. Omit to use
      the working tree.
    required: false
  commit:
    type: string
    description: Optional commit sha or range identifying the phase under review.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: spec-compliance-review
//
// Converts ~/.agents/skills/spec-compliance-review/SKILL.md (507 lines: 7 workflow steps,
// 27 pitfalls, 8 worked examples) into a deep, exhaustive AC-by-AC compliance review with a
// go / no-go / go-with-caveats verdict. Tier 3: this is the heavyweight complement to
// review-sweep (quick diff read). Where review-sweep asks "does this diff look right", this
// run grades every acceptance criterion the plan enumerates, re-executes every verification
// command the plan claims passed, and converges the gaps back into the plan's task list.
//
// HYBRID PATTERN. Structure lives here: plan discovery, revision anchoring, the gate survey,
// the deterministic verification gates (world.run), the AC-group + checklist-domain fan-out,
// per-finding independent confirmation, calibrated adjudication, the fresh-eyes verdict
// challenge, the two owner-approval escalations, and the WorkflowReport. Procedure detail
// lives in the skill: every ask cites /Users/alejandrodelvillar/.agents/skills/
// spec-compliance-review/SKILL.md by section/line and points at the worked-example
// transcripts in its references/ directory (dnd-vtt, riderscout, river-lake, designcanvas,
// pattern-c) so subagents reuse proven evidence patterns instead of inventing their own.
//
// SKILL.md COVERAGE MAP (which step/pitfall each stage owns):
//   step 1 locate the plan            (:33-38)   -> "Locate the plan..." phase
//   step 2 build the AC checklist     (:39-58)   -> checklist reader + AC-group auditors
//   step 3 unintended changes         (:60-69)   -> change-scope auditor (+ gates phase anchoring)
//   step 4 verification per change    (:71-82)   -> "Run the plan's verification commands" (world.run)
//   step 5 incidental artifacts        (:84-93)   -> gates phase detection + owner-approved revert
//   step 6 report format              (:95-121)  -> report writer (the primary artifact)
//   step 7 converge gaps into tasks   (:123-135) -> adjudicator + owner approval + plan appender
//   pitfalls 1-27 are distributed across the domain auditor briefs and the personas below.
//
// DATA SAFETY (every ask repeats it, because a subagent only obeys what it is told): the
// review is read-only. No source, plan, config, or lockfile edits; no commit; no push; no
// DDL/DML outside SELECT; no paid or mutating live call. The ONLY writes this run can make
// are (a) the compliance report file under out/spec-review/, (b) the converge-task block
// appended to the plan, and (c) the revert of incidental build artifacts -- and (b) and (c)
// require the human run owner's answer through the Owner liaison escalation (SKILL.md:84-93,
// :123-135). Live/paid evidence also requires the owner's authorization unless the plan
// already stated the budget (Pitfall 8, :191-195).
//
// VERIFICATION SPLIT (§5, §10): the script runs the repository's own gates and branches on
// exit codes; subagents are told the gates already ran so they spend their turns on targeted
// evidence instead of re-running a suite three times. A world.run result is its own
// confirmation, so gate failures get no confirmer; judgment findings do.
//
// ARTIFACTS (§10, §16.3): one primary deliverable id "compliance-report" (kind: file)
// published from the path the writer subagent actually returned, in every branch including
// the degraded no-plan branch. Its catch-path fallback publishes a DIFFERENT id
// ("compliance-report-fallback", kind: markdown) and carries no primary flag. One dashboard
// ("ac-progress", kind: table) is declared once at top level and fed by report().
//
// FRESH EYES (§3): the AC checklist is read by a subagent that did not write the plan; every
// non-passing verdict and finding is reproduced by an independent confirmer; the adjudicated
// verdict is challenged by a fresh session that has seen nothing but the evidence tables. No
// reader-proxy is stacked on the final report: its findings were each confirmed, which is
// the report's independent read (§3, last bullet).

// ---------------------------------------------------------------------------
// Result types. Every ask<T> names one of these; no inline or array type
// literals are passed as type arguments.
// ---------------------------------------------------------------------------

/** One verification command as the plan states it. */
interface PlanCommand {
  /** The command verbatim from the plan's Verification section. */
  raw: string;
  /** What it decides, for the change-type matrix (SKILL.md:71-82). */
  kind: "build" | "lint" | "test" | "typecheck" | "generator" | "health" | "other";
  /** True when the plan requires this to have been executed for the AC it backs. */
  mustRun: boolean;
}

/** One acceptance criterion lifted from the plan. */
interface AcceptanceCriterion {
  /** The AC label as printed in the plan ("AC7", "1b", "AC10b"). */
  id: string;
  /** The criterion's wording, verbatim — this is the contract the audit grades against. */
  text: string;
  /** Which contract layer it belongs to: product feature, architecture/contract, or verification/deliverable (SKILL.md:52-58). */
  layer: "feature" | "architecture" | "verification";
  /** Files, routes, or surfaces the plan names for this criterion; empty when it names none. */
  namedSurfaces: string[];
  /** True when the plan or the delegation brief deliberately defers this to a later phase (SKILL.md:47). */
  deferred: boolean;
  /** True when the criterion needs a browser, a deployed environment, or a live endpoint rather than a code read (Pitfall 7, :175-189). */
  needsLiveEvidence: boolean;
  /** The external authority governing a concrete value in this AC (rulebook, regulatory table, upstream spec); empty when none (Pitfall 21.4, :315). */
  externalAuthority: string;
}

/** What the plan reader learned. */
interface PlanIndex {
  /** Workspace-relative path of the plan being graded against. */
  planPath: string;
  /** Feature name as the plan titles itself. */
  featureName: string;
  /** True for a greenfield whole-app build whose criteria split into contract layers (SKILL.md:52-58). */
  greenfield: boolean;
  /** True when the plan runs sequential phases landing one commit each (Pitfall 24, :333-344). */
  phased: boolean;
  /** True when the plan or brief already states a live/paid call budget (Pitfall 8, :191-195). */
  liveBudgetStated: boolean;
  /** Every acceptance criterion, in the plan's order. */
  criteria: AcceptanceCriterion[];
  /** Commands the plan's own Verification section enumerates, verbatim. */
  verificationCommands: PlanCommand[];
  /** The plan's "Files to be touched" list. */
  plannedFiles: string[];
  /** Judgments the plan explicitly asks the reviewer to make, verbatim (Pitfall 21, :307-316). */
  askedJudgments: string[];
  /** Concrete numeric claims the plan makes about this repository (test counts, table values) that must be checked against the repo, not trusted. */
  planSpotChecks: string[];
  /** Two or three sentences: what the implementation was supposed to do. */
  intentSummary: string;
}

/** One deterministic check the script is allowed to execute. */
interface GatePlan {
  /** What this gate decides, for the report line ("root test chain", "typecheck", "lint"). */
  label: string;
  /** Which literal command the script may use. Anything else the surveyor finds goes to planCommandsNotMapped. */
  tool: "npm" | "pnpm" | "npx" | "yarn" | "pytest" | "python" | "make" | "other";
  /** Arguments, in order. The script passes these as argv; it never builds a command name from them. */
  argv: string[];
  /** How much it decides. The script gives the strong tier the longer wall clock; the number itself never travels through a prompt. */
  tier: "fast" | "strong";
  /** True when a nonzero exit here must block the verdict (the plan's own quality gates). */
  blocking: boolean;
}

/** What the gate surveyor learned about this repository's checks. */
interface GateSurvey {
  /** The package manager this repository actually uses, as a word for the report ("npm", "pnpm", "yarn", "none"). */
  packageManager: string;
  /** The runnable gates, strongest tier included, in the order the script should run them. */
  gates: GatePlan[];
  /** Test-having workspaces the root test script does not chain (Pitfall 13, :232-240). */
  excludedTestWorkspaces: string[];
  /** Generator scripts whose output must be reproducible (Pitfall 4, :157-161). */
  generators: string[];
  /** Plan verification commands that could not be mapped to a runnable gate, verbatim — someone still has to account for them. */
  planCommandsNotMapped: string[];
  /** Where the repository says to verify: the package.json scripts, Makefile targets, CI config, or README line, each with its path. */
  surveyEvidence: string;
}

/** The outcome of one gate the script actually executed. */
interface GateOutcome {
  /** The gate label as surveyed. */
  label: string;
  /** The command and arguments as executed, for the report's verified section. */
  command: string;
  /** Process exit code; -1 when the command could not run at all. */
  exitCode: number;
  /** Tail of stdout, as evidence. */
  tail: string;
  /** Tail of stderr, as evidence. */
  errTail: string;
  /** True when a nonzero exit blocks the verdict. */
  blocking: boolean;
  /** False when the command could not be executed (unknown tool, spawn failure, or timeout). */
  ran: boolean;
  /** Why a gate did not run; empty when it ran. A skipped gate is unverified work, not a pass. */
  skipReason: string;
}

/** The owner's answer when no plan could be found automatically. */
interface PlanPointer {
  /** Workspace-relative path the owner supplied; empty when they gave none. */
  planPath: string;
  /** The owner's words, quoted for the report. */
  note: string;
}

/** One AC verdict as reported by the auditor who held it. */
interface AcVerdict {
  /** The AC id this verdict grades, exactly as the plan labels it. */
  id: string;
  /** PASS / PARTIAL / FAIL / PENDING / NOT VERIFIED (SKILL.md:44-47). PENDING means deferred by the plan, not unchecked. */
  result: "PASS" | "PARTIAL" | "FAIL" | "PENDING" | "NOT VERIFIED";
  /** The one check that decided it: the command and its output summary, or the grep/read that proved it (Pitfall 2, :145-149). */
  evidence: string;
  /** File paths with line numbers the verdict rests on. */
  anchors: string[];
  /** What the AC required that is missing; empty when fully met. */
  gap: string;
  /** True when this rests on indirect evidence (a type check standing in for a content check), which the report must say out loud. */
  indirect: boolean;
}

/** One AC-group auditor's whole answer. */
interface AcGroupAudit {
  /** The AC ids this auditor covered. */
  ids: string[];
  /** One verdict per AC in the group. */
  verdicts: AcVerdict[];
  /** What this auditor actually read and grepped, for the report's verified section. */
  coverage: string[];
  /** Checklist items it could not check, and why (SKILL.md:201 "say what was not verified"). */
  skipped: string[];
}

/** A finding a domain auditor wants the user to act on. */
interface AuditFinding {
  /** The AC id or checklist item this maps to ("AC7", "scope-creep", "wiring:SHORT_REST", "prompt-drift"). */
  item: string;
  /** One sentence: what is wrong, not how to fix it. */
  problem: string;
  /** How it was seen: the command and output, or the grep plus file:line (Pitfall 12 requires BOTH the definition site and the absent live path). */
  evidence: string;
  /** Workspace-relative path with line when it applies. */
  where: string;
  /** Reserve "high" for a wrong result, a crash, a dead trigger path, or a runtime contract break. */
  severity: "low" | "medium" | "high";
}

/** One domain auditor's whole answer. */
interface DomainAudit {
  /** The domain key, echoed back for matching. */
  domain: string;
  /** Findings worth the user's attention; empty when the domain is clean. */
  findings: AuditFinding[];
  /** The concrete checks run, one per entry, each naming the command or grep and what it returned. */
  coverage: string[];
  /** Checklist items in this domain that could not be checked, and why. */
  skipped: string[];
}

/** An independent re-check of one AC verdict. */
interface VerdictConfirmation {
  /** The AC id being re-checked. */
  id: string;
  /** confirmed = reproduced from the evidence alone; refuted = the evidence does not hold; unconfirmed = neither reproduced nor ruled out. */
  status: "confirmed" | "refuted" | "unconfirmed";
  /** The result this re-check can itself support, using the same vocabulary. */
  result: "PASS" | "PARTIAL" | "FAIL" | "PENDING" | "NOT VERIFIED";
  /** What the re-checker read or ran, and what it saw. */
  evidence: string;
}

/** An independent re-check of one domain finding. */
interface FindingConfirmation {
  /** The finding's item label, echoed back for matching. */
  item: string;
  /** confirmed / refuted / unconfirmed, as above. */
  status: "confirmed" | "refuted" | "unconfirmed";
  /** The re-checker's own calibration of how much it matters. */
  severity: "low" | "medium" | "high";
  /** What the re-checker ran or read, and what it saw. */
  evidence: string;
}

/** One adjudicated deviation. */
interface Judgment {
  /** The AC id or finding item being judged. */
  item: string;
  /** ACCEPTABLE = non-blocking as implemented; REQUIRED_FIX = a gap the user must close; DEFER = deliberately pending per the plan. */
  call: "ACCEPTABLE" | "REQUIRED_FIX" | "DEFER";
  /** The AC wording quoted first, then why the call follows from it — the parent must be able to re-derive the judgment (Pitfall 21.1 :312, Pitfall 27 :370-372). */
  reasoning: string;
}

/** One converge task: a gap turned back into work (SKILL.md:123-135). */
interface ConvergeTask {
  /** The AC id or finding this task closes. */
  item: string;
  /** Bite-sized task text an implementer can act on without re-deriving the finding. */
  task: string;
  /** The evidence line carried forward verbatim, so the fixer repairs the finding rather than the re-derivation (SKILL.md:135). */
  evidence: string;
}

/** The adjudicator's whole answer. */
interface Adjudication {
  /** One entry per deviation, PARTIAL, FAIL, PENDING, or plan-asked judgment. */
  judgments: Judgment[];
  /** Tasks to append to the plan so the gaps re-enter the task list. */
  tasks: ConvergeTask[];
  /** The ranked gap list: functional deviations first, then docs/process debt, then polish (SKILL.md:58). */
  rankedGaps: string[];
  /** Plan errors and stale plan claims to fix at close-out — never implementation FAILs (Pitfall 21.2 :313, 21.4 :315). */
  planCloseOuts: string[];
}

/** A fresh session's attempt to break the verdict. */
interface VerdictChallenge {
  /** True only when the challenge could not find a consequential call it would grade differently. */
  holds: boolean;
  /** AC ids or items whose stated result the evidence in front of it cannot support. */
  unsupportedItems: string[];
  /** What it would change and why, in two or three sentences. */
  reasoning: string;
}

/** A subagent-authored file plus the path it actually wrote. */
interface ReportFile {
  /** The workspace-relative path written, exactly as written. */
  path: string;
  /** One-paragraph description of what the document contains, for the card. */
  description: string;
}

/** The plan-append result. */
interface PlanWriteResult {
  /** True only when the block was actually appended and re-read. */
  written: boolean;
  /** What was added and where, or why nothing was. */
  detail: string;
}

/** The owner's batched answers on the writes this review would otherwise make unasked. */
interface OwnerApprovals {
  /** The owner's answer on appending the converge tasks to the plan; "not-asked" when there were none. */
  converge: "append" | "defer" | "unanswered" | "not-asked";
  /** The owner's answer on reverting incidental build artifacts (SKILL.md:84-93); "not-asked" when the tree was clean. */
  cleanup: "revert" | "keep" | "unanswered" | "not-asked";
  /** The owner's answer on spending live or paid evidence; "not-asked" when no AC needs it or the plan set its own budget. */
  liveEvidence: "authorized" | "declined" | "unanswered" | "not-asked";
  /** Anything else the owner said, quoted. */
  notes: string;
}

/** One row of the final AC table, after confirmation and adjudication. */
interface GradedCriterion {
  /** The AC id as the plan labels it. */
  id: string;
  /** The AC wording, verbatim, so a reader can re-derive the grade from the table alone. */
  wording: string;
  /** Which contract layer it sits in (SKILL.md:52-58). */
  layer: "feature" | "architecture" | "verification";
  /** The result that survived confirmation. */
  result: "PASS" | "PARTIAL" | "FAIL" | "PENDING" | "NOT VERIFIED";
  /** The evidence line, with the re-check outcome appended when one ran. */
  evidence: string;
  /** Whether an independent session reproduced it, or "not-checked" / "decided-by-command". */
  check: "confirmed" | "refuted" | "unconfirmed" | "not-checked" | "decided-by-command";
  /** What is missing; empty when fully met. */
  gap: string;
  /** The adjudicated call on the deviation, when there was one. */
  call: "ACCEPTABLE" | "REQUIRED_FIX" | "DEFER" | "none";
}

/** A checklist domain this workflow audits as its own lens. */
interface DomainSpec {
  /** Machine key, used for finding labels and the dashboard. */
  key: string;
  /** The user-facing name of what this auditor is checking. */
  title: string;
  /** The SKILL.md steps and pitfalls this domain owns, with line anchors, written into the ask. */
  brief: string;
  /** The worked-example transcripts to read for technique, written into the ask. */
  examples: string;
  /** Optional scoped persona for this domain auditor when the global READ_ONLY rule is narrowed by owner authorization (live domain only). */
  scopedPersona?: string;
}

/** One auditor plus the independent re-checks of its contested results. */
interface AcGroupRun {
  /** The auditor's answer. */
  audit: AcGroupAudit;
  /** Re-checks of this group's non-passing verdicts. */
  checks: VerdictConfirmation[];
}

/** One domain auditor plus the independent re-checks of its findings. */
interface DomainRun {
  /** The domain audited. */
  spec: DomainSpec;
  /** The auditor's answer. */
  audit: DomainAudit;
  /** Re-checks of the findings that matter. */
  checks: FindingConfirmation[];
}

/** A finding in the shape the run returns (§10). */
interface Finding {
  /** Workspace-relative path, with a line when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and the output that proved it. */
  evidence: string;
  /** "verified" when an independent subagent or a deterministic check confirmed it; "unconfirmed" when confirmation failed or was not attempted. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

/** The handoff the main agent presents (§10). */
interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ---------------------------------------------------------------------------
// Knobs. These live in control flow only: no ask text mentions them, so an
// AmendWorkflow that retunes one leaves every prompt byte-identical (§13).
// ---------------------------------------------------------------------------

const AC_GROUP_SIZE = 3;
const MAX_AC_GROUPS = 8;
const CONFIRM_CAP = 4;
const MAX_GATE_SECONDS = 1800000;
const FAST_GATE_SECONDS = 900000;

// ---------------------------------------------------------------------------
// Shared discipline, spoken to each actor in its persona (§14: honesty is the
// cheap move only when the ask says so).
// ---------------------------------------------------------------------------

const IMPOSSIBLE_CHECK =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it. " +
  "Never report a check you did not run as passed, and never cite a file you did not actually read.";

const DEDUP_TRAP =
  "If a file read comes back 'unchanged since last read' with no content, you do not have it: force fresh content with an explicit offset and limit, or read it through the terminal (wc -l then sed -n) — a verdict anchored to content you never saw is fabricated evidence (SKILL.md:298-306).";

const BIG_DIFF =
  "A large diff can come back truncated ('... more changes truncated'). Redirect it to a scratch file with git diff and read that with offset and limit until you reach the trailing stat line before grading anything (SKILL.md:359-366).";

const NO_SELF_GATES =
  "The script runs the build, type-check, lint, and test gates and already has their exit codes, which are given to you below — do not re-run them, and do not send a pass claim about them. Spend your turns on the targeted evidence the gates cannot produce (SKILL.md:145-149).";

const READ_ONLY =
  "This review is read-only: do not edit, create, or delete any file in the repository, do not stage, commit, or push, and do not run any write, DDL, or data-changing SQL. " +
  "Do not spend money and do not mutate shared state: no paid LLM call, no SMS, no payment intent, no POST/PUT/PATCH/DELETE against a real user resource (SKILL.md:191-195).";

const OUTPUT_CONTRACT =
  "Output contract (Pitfall 19, SKILL.md:288-296): your FINAL response must be a single JSON object matching the requested shape and nothing else — no preamble, no summary, no code fence, no trailing prose. " +
  "Double-quote every key and string, no single quotes, no trailing commas, escape newlines inside strings, and include every required field; a missing field degrades to an unaudited row in the parent's table. " +
  "Do all reading and running in earlier turns; the last turn contains only the JSON. Keep evidence inside string fields as 'VERDICT — file:line — evidence' lines so the parent can act on shape alone.";

// ---------------------------------------------------------------------------
// Dashboard: the AC table is the thing worth watching in a 50-plus-checklist
// review. Declared once, at top level, fed by report() as verdicts land.
// ---------------------------------------------------------------------------

artifact.table("ac-progress", {
  title: "Acceptance criteria as they are graded",
  description: "One row per AC, replaced by the independent re-check when one runs.",
  key: "id",
  columns: [
    { field: "id", label: "AC" },
    { field: "result", label: "Result" },
    { field: "note", label: "Evidence" },
  ],
});

// ---------------------------------------------------------------------------
// Run arguments (values a future caller changes between runs):
//   plan   — workspace-relative path of the plan to grade against
//   base   — git ref the change set is diffed against
//   commit — for phased plans, the single commit that carries the phase under review
// ---------------------------------------------------------------------------

const planArg = typeof args.plan === "string" ? args.plan.trim() : "";
const baseArg = typeof args.base === "string" ? args.base.trim() : "";
const commitArg = typeof args.commit === "string" ? args.commit.trim() : "";

const liaison = agent("Owner liaison", {
  system:
    "You carry this run's owner-only decisions. A spec-compliance review may not silently defer work to the user, and it may not silently write to their repository either (SKILL.md:175-189, :84-93, :123-135). " +
    "Collect every owner-only question you are given into ONE escalation, each answerable in a sentence, and never invent an answer: an unanswered question is reported as unanswered. " +
    "Ask about the things only the run owner can decide — which plan to grade against, whether live or paid evidence may be spent, whether to append converge tasks to the plan, whether to revert incidental build artifacts. " +
    IMPOSSIBLE_CHECK,
});

const writer = agent("Compliance report writer", {
  system:
    "You write the compliance report in the exact format the skill prescribes (SKILL.md:95-121): a Review Summary heading, the recommendation line, the spec-compliance table with one row per AC and its evidence, the code-quality table, and a Notes section. " +
    "For a greenfield plan the spec-compliance section is three separate tables, one per contract layer, graded MET/PARTIAL/UNMET instead of PASS/FAIL, followed by the ranked gap list (SKILL.md:52-58). " +
    "Write 'true but irrelevant' passes apart from real verification of the change, and say what was not verified (SKILL.md:120-121). " +
    "You are the only actor allowed to create a file, and only the one report file you are told to write: do not edit, create, or delete any repository source, plan, config, or lockfile; do not stage, commit, or push; run no write, DDL, or data-changing SQL; spend no money and mutate no shared state. " +
    IMPOSSIBLE_CHECK,
});

function clipTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  return "…" + text.slice(text.length - keep);
}

function reportSlug(name: string, plan: string): string {
  const seed = `${name} ${plan}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return seed === "" ? "un-named" : seed.slice(0, 60);
}

function sanitizeArgv(list: string[]): string[] {
  const safe: string[] = [];
  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed === "" || trimmed.length > 200) continue;
    if (/[\n\r\t]/.test(trimmed)) continue;
    safe.push(trimmed);
    if (safe.length >= 12) break;
  }
  return safe;
}

function runGate(gate: GatePlan): Promise<GateOutcome> {
  const argv = sanitizeArgv(gate.argv);
  const command = gate.tool + " " + argv.join(" ");
  // The wall clock lives here, in control flow — never in a prompt, so amending it
  // does not rewrite any ask (§13).
  const budget = gate.tier === "strong" ? MAX_GATE_SECONDS : FAST_GATE_SECONDS;
  const attempt = async (): Promise<GateOutcome> => {
    try {
      let result: WorldRunResult;
      if (gate.tool === "npm") {
        result = await world.run("npm", argv, { timeoutMs: budget });
      } else if (gate.tool === "pnpm") {
        result = await world.run("pnpm", argv, { timeoutMs: budget });
      } else if (gate.tool === "npx") {
        result = await world.run("npx", argv, { timeoutMs: budget });
      } else if (gate.tool === "yarn") {
        result = await world.run("yarn", argv, { timeoutMs: budget });
      } else if (gate.tool === "pytest") {
        result = await world.run("pytest", argv, { timeoutMs: budget });
      } else if (gate.tool === "python") {
        result = await world.run("python", argv, { timeoutMs: budget });
      } else if (gate.tool === "make") {
        result = await world.run("make", argv, { timeoutMs: budget });
      } else {
        return {
          label: gate.label,
          command: command,
          exitCode: -1,
          tail: "",
          errTail: "",
          blocking: gate.blocking,
          ran: false,
          skipReason: "the script's approved command set has no literal command for this tool",
        };
      }
      return {
        label: gate.label,
        command: command,
        exitCode: result.exitCode,
        tail: clipTail(result.stdout, 900),
        errTail: clipTail(result.stderr, 900),
        blocking: gate.blocking,
        ran: true,
        skipReason: "",
      };
    } catch {
      return {
        label: gate.label,
        command: command,
        exitCode: -1,
        tail: "",
        errTail: "",
        blocking: gate.blocking,
        ran: false,
        skipReason: "the command could not be executed (spawn failure or timeout) — recorded as unverified, never as a pass",
      };
    }
  };
  return attempt();
}

function planCommandText(commands: PlanCommand[]): string {
  if (commands.length === 0) return "The plan enumerates no verification commands.";
  return commands.map((c) => `- [${c.kind}${c.mustRun ? ", must run" : ""}] ${c.raw}`).join("\n");
}

function criterionText(list: AcceptanceCriterion[]): string {
  return list.map((c) => `${c.id}: ${c.text}`).join("\n");
}

function gateSummaryText(outcomes: GateOutcome[]): string {
  if (outcomes.length === 0) return "No gate ran yet.";
  return outcomes
    .map((g) => `- ${g.label}: ${g.command} -> exit ${g.exitCode}${g.ran ? "" : ` (did not run: ${g.skipReason})`}`)
    .join("\n");
}

function publishReport(writtenPath: string, fallbackTitle: string, fallbackBody: string): Promise<boolean> {
  const attempt = async (): Promise<boolean> => {
    try {
      await artifact.file("compliance-report", writtenPath, {
        title: "Spec compliance review",
        description: fallbackTitle,
        primary: true,
      });
      return true;
    } catch {
      try {
        await artifact.markdown("compliance-report-fallback", fallbackBody, {
          title: "Spec compliance review",
          description: "The report file could not be published, so the same findings are inlined here.",
        });
        return false;
      } catch {
        log("Neither the report file nor the inline fallback could be published; the findings are in the run's returned report.");
        return false;
      }
    }
  };
  return attempt();
}

// ---------------------------------------------------------------------------
// Phase 1 — locate the plan and build the AC checklist (SKILL.md steps 1-2).
// ---------------------------------------------------------------------------

phase("Locate the plan and read its acceptance criteria");

let planPath = planArg;
const ownerPlanNote: string[] = [];

if (planPath === "") {
  // SKILL.md:35 names docs/plans/ and .hermes/plans/. The PR/issue description is not
  // reachable from a workspace read, so a miss here goes to the owner, not to a guess.
  // Both `**` and single-star patterns are tried: whether the harness glob treats `**` as
  // matching zero directory segments is not verifiable from inside a run, and plans sit
  // flat in docs/plans/ in this repository.
  let candidates: string[] = [];
  for (const pattern of ["docs/plans/**/*.md", "docs/plans/*.md", ".hermes/plans/**/*.md", ".hermes/plans/*.md"]) {
    try {
      candidates = candidates.concat(await files.glob(pattern));
    } catch {
      log(`The ${pattern} search did not complete; the plan may live elsewhere in this repository.`);
    }
  }
  const uniqueCandidates = candidates.filter((p, i) => candidates.indexOf(p) === i).sort();
  if (uniqueCandidates.length === 1) {
    planPath = uniqueCandidates[0];
    log(`One plan found in the workspace; grading against ${planPath}.`);
  } else {
    // Recency comes from ls -t (the facade cannot stat), but the choice is the owner's
    // whenever discovery is ambiguous (SKILL.md:35): the lexicographically-last match is
    // not evidence of which plan governs this review.
    let recency = "";
    try {
      const probeDir =
        uniqueCandidates.length > 0
          ? uniqueCandidates[0].lastIndexOf("/") === -1
            ? "."
            : uniqueCandidates[0].slice(0, uniqueCandidates[0].lastIndexOf("/"))
          : ".";
      const ls = await world.run("ls", ["-t", probeDir]);
      recency = ls.exitCode === 0 ? clipTail(ls.stdout, 600) : "";
    } catch {
      recency = "";
    }
    const pointer = await liaison.ask<PlanPointer>(
      (uniqueCandidates.length === 0
        ? "No plan could be found under docs/plans/ or .hermes/plans/"
        : `More than one plan was found: ${uniqueCandidates.join(", ")}. Most-recently-modified first, per ls -t:\n${recency === "" ? "(recency could not be read)" : recency}`) +
        ", and this review grades against a plan's acceptance criteria (SKILL.md:33-38). " +
        "Ask the run owner which workspace-relative plan path governs this review, or for the issue/PR text if there is no plan file. " +
        "If they give none, this run cannot grade ACs and will say so instead of inventing them. " +
        `${OUTPUT_CONTRACT}`,
    );
    planPath = pointer.planPath.trim();
    if (pointer.note !== "") ownerPlanNote.push(pointer.note);
  }
}

if (planPath === "") {
  // Degraded branch: nothing to grade against. Still deliver a report the user can open, and
  // still use the one primary artifact id.
  phase("Report that no plan could be graded against");
  const noPlanBody = [
    "# Spec compliance review: no plan to grade against",
    "",
    "The reviewer looked in docs/plans/ and .hermes/plans/ and asked the run owner; no plan path came back.",
    "An AC-by-AC compliance verdict is not possible without the plan (SKILL.md:33-38), so nothing was graded.",
    "",
    ownerPlanNote.length > 0 ? `Owner's words: ${ownerPlanNote.join(" ")}` : "The owner's answer carried no path.",
    "",
    "What to do next: pass the plan path as this workflow's plan argument, or run review-sweep for a quick diff read.",
  ].join("\n");
  const noPlanReport: WorkflowReport = {
    conclusion:
      "No review was produced: no plan with acceptance criteria could be located, and this workflow grades implementations against a plan rather than against its own opinion. " +
      "Nothing in the working tree was modified.",
    findings: [],
    verified: ["plan discovery over docs/plans/ and .hermes/plans/, then an escalation to the run owner for the path"],
    notCovered: [
      "every acceptance criterion — there was no plan to read them from",
      "the repository's quality gates, which were deliberately not run because there was nothing to grade them against",
    ],
  };
  const noPlanWritten = await writer.ask<ReportFile>(
    `Write this exact content to out/spec-review/no-plan-compliance-review.md and reply with the path you wrote:\n\n${noPlanBody}\n\n${OUTPUT_CONTRACT}`,
  );
  await publishReport(
    noPlanWritten.path.trim(),
    "Why this run graded nothing, and what to hand it next time.",
    noPlanBody,
  );
  return noPlanReport;
}

const checklistReader = agent("AC checklist reader", {
  system:
    "You read a plan and lift its acceptance criteria into a checklist without grading anything (SKILL.md:33-58). " +
    "Verbatim wording matters: later auditors grade against your copy of the AC text, and the AC's wording — not the plan's approach table — is the contract (SKILL.md:368-372). " +
    "You may run read-only shell commands (grep, sed, wc, git status, git log, git diff, git show) and you must not edit, create, or delete any file, stage, commit, or push, or run any write or data-changing SQL, paid call, or mutating request. " +
    IMPOSSIBLE_CHECK,
});

const planIndex = await checklistReader.ask<PlanIndex>(
  `Read the plan at ${planPath} (also check the issue/PR text if the plan references one) and build the AC checklist exactly as /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/SKILL.md steps 1 and 2 prescribe (:33-58). ` +
    `For every acceptance criterion record: its label as printed, its wording verbatim, which contract layer it belongs to (must-have feature, architecture/contract, or verification/deliverable — SKILL.md:52-58), the files or surfaces the plan names for it, whether the plan or the brief deliberately defers it (that is PENDING, not a failure: SKILL.md:47), whether it can only be satisfied by a browser, a deployed environment, or a live endpoint (SKILL.md:175-189), and which external authority governs any concrete value inside it (SKILL.md:315). ` +
    `Set greenfield true when this is a whole-app build plan whose criteria split into contract layers rather than a feature diff. Set phased true when the plan runs sequential phases landing one commit each (SKILL.md:333-344). ` +
    `Set liveBudgetStated true only when the plan or the brief itself states how many live or paid calls may be spent (:191-195). ` +
    `Also transcribe the plan's Verification section as commands (:71-82), its Files-to-be-touched list, every judgment the plan explicitly asks the reviewer to make (:307-316), and every numeric claim it makes about this repository (test counts, file counts, table values) which must later be checked against the repo rather than trusted (:313). ` +
    `${READ_ONLY} ${DEDUP_TRAP} If the plan cannot be read at all, escalate with the path and the error instead of inventing criteria. ${OUTPUT_CONTRACT}`,
);

const criteria = planIndex.criteria;
log(`Grading ${criteria.length} acceptance criteria for ${planIndex.featureName} against ${planIndex.planPath !== "" ? planIndex.planPath : planPath}.`);

// ---------------------------------------------------------------------------
// Phase 2 — anchor the review to one revision (Pitfall 11, :209-220).
// ---------------------------------------------------------------------------

phase("Record the exact revision under review");

const headRun = await world.run("git", ["rev-parse", "--short", "HEAD"]);
const anchorSha = headRun.exitCode === 0 ? headRun.stdout.trim() : "";

let treeStatus: GitStatus | null = null;
try {
  treeStatus = await git.status();
} catch {
  log("git status is unavailable here, so the report will not claim anything about the working tree.");
}

let recentCommits: GitCommit[] = [];
try {
  recentCommits = await git.log(15);
} catch {
  log("Commit history could not be read; the change-scope audit will anchor to the working tree instead.");
}

let changedPaths: string[] = [];
try {
  changedPaths = baseArg !== "" ? await git.changedFiles(baseArg) : await git.changedFiles();
} catch {
  log("The changed-file list could not be read through the git facade; auditors will derive it themselves.");
}

const dirtyAtStart: string[] = treeStatus === null ? [] : treeStatus.unstaged.concat(treeStatus.untracked).concat(treeStatus.staged);
const anchorLine =
  `Anchor revision: ${anchorSha === "" ? "unknown (git rev-parse failed)" : anchorSha}` +
  `${baseArg !== "" ? `, base ref: ${baseArg}` : ""}${commitArg !== "" ? `, phase commit under review: ${commitArg}` : ""}. ` +
  `Working tree: ${treeStatus === null ? "unknown" : treeStatus.clean ? "clean" : `${dirtyAtStart.length} dirty or untracked path(s)`}. ` +
  `Changed files against the anchor: ${changedPaths.length}. ` +
  (recentCommits.length > 0
    ? `Recent commits: ${recentCommits.slice(0, 5).map((c) => `${c.hash.slice(0, 7)} ${c.subject}`).join("; ")}.`
    : "No commits were readable.");

if (dirtyAtStart.length > 0) {
  log(`The working tree is not clean (${dirtyAtStart.length} paths). Verdicts will be anchored to the committed state and the delta reported separately (SKILL.md:209-220).`);
}

// ---------------------------------------------------------------------------
// Phase 3 — find the checks this repository actually has (§5), before running
// any of them, so the gate is the strongest the request implies.
// ---------------------------------------------------------------------------

phase("Find the checks this repository actually runs");

const surveyor = agent("Verification surveyor", {
  system:
    "You find out what checks a repository actually has and rank them by how much they decide: a unit suite over fixtures decides less than an integration suite, which decides less than the acceptance command the README names (dynamic-workflows §5). " +
    "You read package.json scripts (including every workspace's), Makefiles, CI configs, pyproject/pytest config, and the README's 'run this to verify' line. " +
    "You run only inspection commands (cat, ls, grep, --help listings, find) — you do not run the project's build, type-check, lint, tests, or generators, because the script executes those as gates and must own their exit codes. " +
    `You must not edit, create, or delete any file, stage, commit, or push, and you must not run any write, DDL, or data-changing SQL, any paid call, or any mutating request. ${READ_ONLY} ${IMPOSSIBLE_CHECK}`,
});

const gateSurvey = await surveyor.ask<GateSurvey>(
  `This review must re-execute the plan's verification criteria rather than trust any claim that they passed (SKILL.md:197-201). ` +
    `The plan's own commands are:\n${planCommandText(planIndex.verificationCommands)}\n\n` +
    `Survey this repository and return the gates the script should run, in order, mapping each to one of the tools the script can execute literally: npm, pnpm, npx, yarn, pytest, python, make. Anything that needs another binary, a network, credentials, or a shell pipe goes into planCommandsNotMapped verbatim so the run can account for it. ` +
    `Include the strongest tier the plan implies, not only the cheap one: type-check, build, lint, and the full test chain when the repository declares them, plus any acceptance or E2E command the plan names and the repository actually has. Set blocking true for the gates the plan itself lists as quality criteria, and false for informational ones. ` +
    `Set tier strong for full builds and whole test chains and fast for type-check and lint; the script owns the wall clock each tier gets. ` +
    `Enumerate excludedTestWorkspaces per Pitfall 13 (:232-240): read the root test script, name the workspaces it chains, then find test files in every workspace and list the ones the root run silently misses. ` +
    `List generators under Pitfall 4's rule (:157-161): scripts whose committed output must be reproducible. ` +
    `Put the evidence for all of it in surveyEvidence: the file you read and the exact script or target text. ${DEDUP_TRAP} ${OUTPUT_CONTRACT}`,
);

const extraWorkspaceGates: GatePlan[] = gateSurvey.excludedTestWorkspaces.map((ws) => {
  const plan: GatePlan = {
    label: `tests in ${ws} (excluded from the root run)`,
    tool: gateSurvey.packageManager === "pnpm" ? "pnpm" : "npm",
    argv: ["--prefix", ws, "test"],
    tier: "strong",
    blocking: false,
  };
  return plan;
});
const generatorGates: GatePlan[] = gateSurvey.generators.map((gen) => {
  const plan: GatePlan = {
    label: `regenerate ${gen}`,
    tool: "npx",
    argv: ["tsx", gen],
    tier: "fast",
    blocking: false,
  };
  return plan;
});
const allGates: GatePlan[] = gateSurvey.gates.concat(extraWorkspaceGates).concat(generatorGates);
log(`Gates queued for this repository: ${allGates.length} (${gateSurvey.gates.length} surveyed, ${extraWorkspaceGates.length} workspaces the root run excludes, ${generatorGates.length} generators).`);

// ---------------------------------------------------------------------------
// Phase 4 — run the gates as code (SKILL.md step 4, :71-82), then catch the
// incidental artifacts the run itself created (step 5, :84-93).
// ---------------------------------------------------------------------------

phase("Run the plan's verification commands");

const gateOutcomes: GateOutcome[] = [];
const regenerated: string[] = [];
let preGenSnapshot: GitStatus | null = null;

for (const gate of allGates) {
  const isGenerator = generatorGates.includes(gate);

  // Snapshot git status immediately before each generator gate so we can
  // attribute only the paths it newly dirties (Fix 6: per-generator drift
  // scoping, not "any generator exists therefore every new dirty file is drift").
  if (isGenerator && preGenSnapshot === null && treeStatus !== null) {
    try {
      preGenSnapshot = await git.status();
    } catch {
      preGenSnapshot = null;
    }
  }

  const outcome = await runGate(gate);
  gateOutcomes.push(outcome);
  log(`${outcome.label}: ${outcome.ran ? `exit ${outcome.exitCode}` : `did not run (${outcome.skipReason})`}`);

  // After each generator, snapshot again and attribute the delta to that
  // generator alone. Non-generator dirty paths are never labelled drift.
  if (isGenerator) {
    let postSnapshot: GitStatus | null = null;
    try {
      postSnapshot = await git.status();
    } catch {
      postSnapshot = null;
    }
    if (preGenSnapshot !== null && postSnapshot !== null) {
      const before: GitStatus = preGenSnapshot;
      const after: GitStatus = postSnapshot;
      const newPaths = after.unstaged.filter((p) => {
        const wasClean =
          dirtyAtStart.indexOf(p) === -1 &&
          before.unstaged.indexOf(p) === -1 &&
          before.staged.indexOf(p) === -1 &&
          before.untracked.indexOf(p) === -1;
        return wasClean;
      });
      regenerated.push(...newPaths);
    }
    preGenSnapshot = postSnapshot;
  }
}

// Pitfall 4: a regeneration that differs from the committed output is either
// upstream drift or a bug — the script detects the difference, a subagent
// judges it. `postRegenStatus` is the final tree state for incidental-artifact
// detection; `regenerated` is now scoped per generator above.
const postRegenStatus: GitStatus | null = treeStatus === null ? null : await git.status().catch(() => null);
const incidentalArtifacts: string[] = postRegenStatus === null
  ? []
  : postRegenStatus.unstaged.filter((p) => /tsbuildinfo$|\.pyc$|^\.pytest_cache/.test(p) && dirtyAtStart.indexOf(p) === -1);

const blockingGateFailures = gateOutcomes.filter((g) => g.ran && g.blocking && g.exitCode !== 0);
const softGateFailures = gateOutcomes.filter((g) => g.ran && !g.blocking && g.exitCode !== 0);
const unrunGates = gateOutcomes.filter((g) => !g.ran);

if (blockingGateFailures.length > 0) {
  log(`${blockingGateFailures.length} of the plan's own quality gates exited nonzero — a direct violation of its verification criterion (SKILL.md:197-201).`);
}

// ---------------------------------------------------------------------------
// Phase 5 — owner authorization for anything that can cost money or touch
// shared state (Pitfall 8, :191-195). Asked before the auditor that might
// spend it, never after.
// ---------------------------------------------------------------------------

const needsLive = criteria.some((c) => c.needsLiveEvidence);
let ownerApprovals: OwnerApprovals = {
  converge: "not-asked",
  cleanup: "not-asked",
  liveEvidence: "not-asked",
  notes: "",
};

if (needsLive && !planIndex.liveBudgetStated) {
  phase("Ask the owner what live evidence this review may spend");
  const liveQuestion = await liaison.ask<OwnerApprovals>(
    `Some acceptance criteria in ${planPath} can only be satisfied by a browser check, a deployed environment, or a live endpoint: ${criteria.filter((c) => c.needsLiveEvidence).map((c) => c.id).join(", ")}. ` +
      `The skill forbids spending money or mutating shared data during a read-only review and prescribes evidence reuse first, then a throwaway resource with one allowed paid call, then deletion (SKILL.md:191-195); it equally forbids deferring a deterministic flow to the user when a browser tool can run it (SKILL.md:175-189). ` +
      `Ask the owner, in one escalation: may this run exercise deployed-environment and browser checks, and if so is it authorized to spend at most one paid or mutating call against a throwaway resource it deletes afterwards? Offer the alternative of a code-level pass with the deploy check left as the plan's own gate (SKILL.md:314). ` +
      `Record the answer verbatim in notes. If they do not answer, report liveEvidence as unanswered — do not assume either way. ${READ_ONLY} ${OUTPUT_CONTRACT}`,
  );
  ownerApprovals.liveEvidence = liveQuestion.liveEvidence;
  if (liveQuestion.notes !== "") ownerApprovals.notes = liveQuestion.notes;
}

// ---------------------------------------------------------------------------
// Phase 6 — the exhaustive audit: one auditor per AC group plus one auditor
// per checklist domain, each chained to its own independent re-checkers, and
// one join at the end (§7). Verdicts are reported as they land (§10).
// ---------------------------------------------------------------------------

const groupSize = criteria.length === 0 ? AC_GROUP_SIZE : Math.max(AC_GROUP_SIZE, Math.ceil(criteria.length / MAX_AC_GROUPS));
const acGroups: AcceptanceCriterion[][] = [];
for (let start = 0; start < criteria.length; start += groupSize) {
  acGroups.push(criteria.slice(start, start + groupSize));
}

const domainBriefs: DomainSpec[] = [
  {
    key: "scope",
    title: "Change-scope",
    brief:
      "Own SKILL.md step 3 (:60-69) and the dating rules: unintended changes in unrelated areas (Pitfall 3, :151-155), incidental artifacts the run leaves behind (:163-167), the three-state separation of committed / uncommitted / deployed when a parallel fixer is moving the tree (Pitfall 11, :209-220), pre-existing violations never blamed on the reviewed commits (Pitfall 14, :241-245), phase-commit anchoring and blame-dating of later-phase markers (Pitfall 24A, :333-344), zero-diff proof for negative claims instead of state inspection (Pitfall 25, :346-357), and truncated-diff recovery (:359-366). " +
      "Prove absence with an empty diff scoped to the reviewed commit; prove a marker is not this change's with git blame or git log -S.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/dnd-vtt-fog-opt-in-phase1-review.md (blame-dating a phase-2 marker to exonerate phase 1, and the stale-dist freshness grep) and references/dnd-vtt-board-first-tabletop-review.md (the empty --stat diff that proves no new opcodes, and the /tmp diff pagination) and references/river-lake-centerline-review-transcript.md (the name-only plus per-sensitive-file diff pattern).",
  },
  {
    key: "wiring",
    title: "Live-path and integration wiring",
    brief:
      "Own Pitfall 12 (:222-230): for every AC asserting a trigger-to-effect chain, prove the chain is live, not merely present — grep call sites for each named feature element, trace new branches against every earlier guard to ask whether the condition can ever be true and whether the derived value is actually consumed downstream, and confirm every exported service function has a route or UI caller outside its own test. " +
      "Own Pitfall 22 (:317-321): for each new symbol (op type, enum member, schema field, migration, module), grep every registry, union, payload-schema map, dispatch switch, barrel export, and migration registration array that must enumerate it, and report wiring as its own section because it is exactly what behavioral tests miss. " +
      "Own Pitfall 16 (:257-269) when judging whether a test that asserts an async pipeline's terminal state proves anything at all. A definition plus a green unit test is NOT a shipped feature.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/dnd-vtt-audio-monster-review.md (cues defined with zero call sites; a derivation branch made unreachable by an earlier 400 guard; the derived variable never consumed) and references/dnd-vtt-spellcasting-enforcement-review.md (the three-registry wiring checklist and the persistence-chain reachability trace).",
  },
  {
    key: "contracts",
    title: "Contract and guard semantics",
    brief:
      "Own the cross-layer contract checks: the plan's declared contract shape against BOTH the types and the handler that assembles the request (SKILL.md:203-207); every LLM call site's prompt text diffed against the message construction so nothing the prompt claims ('below', 'attached', 'in context') is unbuilt (Pitfall 10); presence-based guards whose intent is 'being changed' but which fire on no-op full-payload updates (Pitfall 17, :272-280); raw-dict handlers whose alias map silently drops camelCase keys if someone swapped in a plain body model (Pitfall 18, :282-286); and new pages that hit authenticated endpoints with headerless fetch — grep the bootstrap for a global fetch wrapper and check the sibling reference page uses the same transport before calling it a failure (Pitfall 23, :323-331). " +
      "Report each mismatch as PARTIAL with the exact line numbers on both sides.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/designcanvas-greenfield-review.md (the prompt that promised frame HTML the code never sent) and references/riderscout-walker-dismissal-review.md (the headerless fetch that passed because main.jsx installs a token wrapper) and references/riderscout-student-management-review.md (the in-queue guard's real semantics, read from the handler rather than assumed).",
  },
  {
    key: "design-quality",
    title: "Design-system and UI completeness",
    brief:
      "Own SKILL.md:82 and Pitfall 6 (:169-173): a type check cannot see a design-system violation or a missing required UI element. Grep the new UI files for arbitrary-value classes and off-token colors, compare the component against the sibling panel the plan says to mirror, and enumerate every UI element the plan requires (link, badge, column, chip, error toast) against what is actually rendered. Missing required elements are FAIL lines with the plan's wording quoted, not notes.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/pattern-c-phase2-review-transcript.md — the multi-surface review where tsc passed and the UI still failed on non-Harbor color tokens, an omitted dollar delta, and a missing required link.",
  },
  {
    key: "claims",
    title: "Plan-claim and authority",
    brief:
      "Own the plan's own claims: verify numeric and structural assertions against the repository and report a mismatch as plan staleness, never as an implementation failure (Pitfall 21.2, :313); where an AC embeds a concrete value governed by an external authority (rulebook, regulatory table, upstream spec), verify against that authority and PASS an implementation that follows the source while flagging the plan text for close-out (Pitfall 21.4, :315); check deliverables the plan promised against the actual tree (the planned-files diff); and confirm the change-type matrix was honoured — a generated data file is verified by regenerating and asserting content, not by a green application test suite (Pitfall 1, :139-143).",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/riderscout-student-management-review.md (the plan's '5 tests' vs the repo's 6, verified by collection and reported as staleness) and references/dnd-vtt-spellcasting-enforcement-review.md (the plan's spell-slot table contradicted by the PHB, implementation PASSed on the authority's side).",
  },
  {
    key: "architecture",
    title: "Architecture and deliverables",
    brief:
      "Greenfield only (SKILL.md:52-58): audit the architecture and contracts layer as its own table — file layout, data model, API and LLM contracts, declared stack choices, and security decisions the plan pinned (sandboxing, auth boundaries, secrets hygiene). Compare the plan's file layout to the actual tree, and judge consolidated or relocated modules explicitly rather than as missing files.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/designcanvas-greenfield-review.md — the three-table verdict format and the find-based planned-files diff that caught a missing toolbar, a promised docs directory, and an acceptably merged prompts module.",
  },
  {
    key: "live",
    title: "Deployed and browser evidence",
    brief:
      "Own Pitfall 7 (:175-189) and Pitfall 8 (:191-195): deterministic flows (does login work, does the page load, does the socket connect, does the route exist in the deployed build) are NOT human-judgment checks — run them with the browser tools if you have them, and probe the deployed revision cheaply by requesting a route that exists only in the reviewed change. " +
      "When the owner has authorized live evidence, reuse artifacts first, then a free throwaway CRUD round-trip, then exactly one paid or mutating call against a throwaway resource you create, read back, and delete — naming it and its deletion in the report so no residue is unknown. " +
      "Defer to a human only for pixel-level visual judgment, credentials nobody gave this run, or physical hardware, and say which. Mark a browser AC that could only be checked at code level as PASS with the deploy gate named as the plan's own separate AC (SKILL.md:314), never as silently deferred scope.",
    examples:
      "Read /Users/alejandrodelvillar/.agents/skills/spec-compliance-review/references/designcanvas-greenfield-review.md — the zero-paid-call second pass (evidence reuse plus a free CRUD round-trip), the throwaway-project pattern for the case you must spend, and the deployed-revision probe that showed prod predated the fixes.",
    scopedPersona:
      `This is a scoped override for exactly this run: the owner authorized live evidence. You may perform one paid or mutating call against a throwaway resource you create and delete, and you may run browser checks. Everything else in the global READ_ONLY rule still applies — no source, plan, config, or lockfile edits; no commit; no push; no write, DDL, or data-changing SQL outside that one authorized call. ${IMPOSSIBLE_CHECK}`,
  },
];

const activeDomains: DomainSpec[] = domainBriefs.filter((d) => {
  if (d.key === "architecture") return planIndex.greenfield;
  if (d.key === "live") return needsLive && ownerApprovals.liveEvidence === "authorized";
  return true;
});

const uiPattern = /\.(tsx|jsx|vue|svelte|css|scss|html|swift|kt)$/;
const uiEvidenceText = planIndex.plannedFiles.join(" ") + " " + changedPaths.join(" ") + " " + criteria.map((c) => c.namedSurfaces.join(" ")).join(" ");
const hasUiWork = uiPattern.test(uiEvidenceText);
const auditDomains = hasUiWork ? activeDomains : activeDomains.filter((d) => d.key !== "design-quality");

log(`Auditing ${acGroups.length} AC group(s) and ${auditDomains.length} checklist domain(s): ${auditDomains.map((d) => d.title).join(", ")}.`);

const acAuditorPersona =
  "You audit acceptance criteria against a plan, one AC at a time, and you report what you actually verified. " +
  "Verdict vocabulary and its meaning are in SKILL.md:39-58 — PARTIAL for a named sub-piece that is missing, PENDING when the plan deferred it (with what will complete it), NOT VERIFIED when you could not check either way; those are not interchangeable (:44-47). " +
  "For every AC you must run a targeted check that asserts the AC's actual content; a green type check is not evidence about behavior (Pitfall 2, SKILL.md:145-149), and a PASS resting on indirect evidence must be labelled indirect so the report says so. " +
  "Grade against the AC's exact wording; the plan's approach or phase table is a hint, so extras it does not repeat become notes, not FAILs (Pitfall 27, :368-372). " +
  "You may read, grep, and run inspection and read-only commands (git status, git log, git diff, git show, git blame, rg, sed, wc, SELECT-only SQL). " +
  `${READ_ONLY} ${NO_SELF_GATES} ${DEDUP_TRAP} ${BIG_DIFF} ${IMPOSSIBLE_CHECK}`;

const confirmerPersona =
  "You are an independent re-checker. You have not seen the original reviewer's reasoning — only its claim and the evidence lines it cited. " +
  "Reproduce the claim from those lines yourself: read the file, run the grep or the read-only command, and decide what result you could support on your own. " +
  "Do not take the claim on trust and do not soften it; if the evidence does not say what the claim says, say so. A claim you cannot reproduce either way is unconfirmed, not refuted. " +
  `${READ_ONLY} ${DEDUP_TRAP} ${IMPOSSIBLE_CHECK}`;

phase("Audit each acceptance criterion and checklist domain");

const groupRuns = acGroups.map(async (group, gi): Promise<AcGroupRun> => {
  const first = group[0];
  const last = group[group.length - 1];
  const label = first.id === last.id ? first.id : `${first.id} to ${last.id}`;
  const auditor = agent(`AC auditor ${gi + 1} (${label})`, { system: acAuditorPersona });
  const audit = await auditor.ask<AcGroupAudit>(
    `You are auditing ${group.length} acceptance criteria of the plan at ${planIndex.planPath !== "" ? planIndex.planPath : planPath}, for: ${planIndex.intentSummary} ` +
      `Anchor state for every claim: ${anchorLine} ` +
      `The criteria, verbatim:\n${criterionText(group)}\n\n` +
      `Per-AC surfaces the plan names: ${group.map((c) => `${c.id} -> ${c.namedSurfaces.length > 0 ? c.namedSurfaces.join(", ") : "none named"}`).join("; ")}. ` +
      `Deferred by the plan: ${group.filter((c) => c.deferred).map((c) => c.id).join(", ") || "none"}. External authorities in play: ${group.filter((c) => c.externalAuthority !== "").map((c) => `${c.id} -> ${c.externalAuthority}`).join("; ") || "none named"}. ` +
      `Already-decided gates (do not re-run, and do not re-report as your own finding):\n${gateSummaryText(gateOutcomes)}\n\n` +
      `For each criterion fill one AcVerdict row: result, the single targeted check that decided it with its output summary, file:line anchors, the precise gap if the result is not PASS, and indirect true when the evidence is a type check or a build standing in for a content check. ` +
      `Where the plan asked you to judge a known deviation, quote the AC wording in your evidence and give the verdict the wording supports (SKILL.md:307-316). ` +
      `Record in coverage what you read and ran, and in skipped anything you could not check with the reason. ${OUTPUT_CONTRACT}`,
);

  const contested = audit.verdicts.filter((v) => v.result === "FAIL" || v.result === "PARTIAL" || v.result === "NOT VERIFIED");
  const toCheck = contested.slice(0, CONFIRM_CAP);
  const checks: VerdictConfirmation[] = [];
  for (const verdict of toCheck) {
    const rechecker = agent(`AC re-check ${gi + 1} (${verdict.id})`, { system: confirmerPersona });
    const confirmation = await rechecker.ask<VerdictConfirmation>(
      `A reviewer graded AC ${verdict.id} of the plan at ${planIndex.planPath !== "" ? planIndex.planPath : planPath} as ${verdict.result}. ` +
        `Its claim: ${verdict.gap === "" ? verdict.evidence : `${verdict.evidence} — gap: ${verdict.gap}`} ` +
        `Its cited anchors: ${verdict.anchors.join(", ") || "none given"}. ` +
        `Anchor state: ${anchorLine} ` +
        `Reproduce it yourself from those anchors. Return the AC id, your status (confirmed / refuted / unconfirmed), the result you can support on your own evidence, and what you actually ran or read. ${OUTPUT_CONTRACT}`,
    );
    checks.push(confirmation);
  }

  for (const verdict of audit.verdicts) {
    const matched = checks.find((c) => c.id === verdict.id);
    const finalResult = matched === undefined || matched.status === "unconfirmed" ? verdict.result : matched.result;
    report(
      {
        id: verdict.id,
        result: finalResult,
        note: clipTail(matched === undefined ? verdict.evidence : `${verdict.evidence} | re-check ${matched.status}: ${matched.evidence}`, 200),
      },
      "ac-progress",
    );
  }
  return { audit: audit, checks: checks };
});

const domainRuns = auditDomains.map(async (spec, di): Promise<DomainRun> => {
  const auditor = agent(`${spec.title} auditor`, {
    system:
      `You own one lens of a spec-compliance review: ${spec.title.toLowerCase()} checks. ${spec.brief} ` +
      `You may read, grep, and run inspection and read-only commands (git status, git log, git diff, git show, git blame, rg, sed, wc, SELECT-only SQL). ` +
      (spec.scopedPersona !== undefined ? `${spec.scopedPersona} ` : `${READ_ONLY} ${NO_SELF_GATES} `) +
      `${DEDUP_TRAP} ${BIG_DIFF} ${IMPOSSIBLE_CHECK}`,
  });
  const audit = await auditor.ask<DomainAudit>(
    `Domain: ${spec.title}. Review target: ${planIndex.featureName}, plan at ${planIndex.planPath !== "" ? planIndex.planPath : planPath}. ${anchorLine} ` +
      `Worked examples of this technique done well — read them before you start: ${spec.examples} ` +
      `The plan's Files-to-be-touched list: ${planIndex.plannedFiles.join(", ") || "the plan names none"}. ` +
      (spec.key === "scope" && planIndex.phased
        ? `This plan runs sequential phases landing one commit each (phased: true) — blame-date every phase-commit marker you see so you do not blame a later phase's marker on an earlier phase's commit (Pitfall 24A, SKILL.md:333-344). `
        : "") +
      (spec.key === "scope"
        ? `Changed paths against the anchor (from git status at review start): ${changedPaths.join(", ") || "none readable"}. Use this list to separate intended from unintended changes; do not derive the changed-file list yourself. `
        : "") +
      `Acceptance criteria in scope: ${criteria.length === 0 ? "none enumerated" : `${criteria.map((c) => c.id).join(", ")}`}. ` +
      `Already-decided gates (do not re-run; branch on these exit codes):\n${gateSummaryText(gateOutcomes)}\n` +
      (regenerated.length > 0
        ? `Regeneration produced content differences in: ${regenerated.join(", ")} — judge whether that is upstream data drift or a bug (SKILL.md:157-161).\n`
        : "") +
      `Report every finding with the item label it maps to, one sentence on what is wrong, the evidence (command plus output summary, or grep plus file:line — for a dead-wiring finding both the definition site and the absent live path), the path, and severity. ` +
      `An empty findings list is a valid answer when the domain is clean; put the checks that proved it in coverage. Anything you could not check goes in skipped with the reason. ${OUTPUT_CONTRACT}`,
);

  const risky = audit.findings.filter((f) => f.severity === "high" || f.severity === "medium");
  const toCheck = risky.slice(0, CONFIRM_CAP);
  const checks: FindingConfirmation[] = [];
  for (const finding of toCheck) {
    const rechecker = agent(`${spec.title} re-check ${di + 1}.${checks.length + 1}`, { system: confirmerPersona });
    const confirmation = await rechecker.ask<FindingConfirmation>(
      `A ${spec.title.toLowerCase()} audit reported this against ${finding.item}: ${finding.problem} ` +
        `Evidence claimed: ${finding.evidence} At: ${finding.where}. ${anchorLine} ` +
        `Reproduce it yourself. Return the item label, status (confirmed / refuted / unconfirmed), your own severity call, and what you ran or read. ${OUTPUT_CONTRACT}`,
);
    checks.push(confirmation);
    report({ item: finding.item, status: confirmation.status, severity: confirmation.severity, where: finding.where });
  }
  return { spec: spec, audit: audit, checks: checks };
});

const [groupResults, domainResults] = await Promise.all([Promise.all(groupRuns), Promise.all(domainRuns)]);

phase("Adjudicate gaps and challenge the verdict");

// Fold the audited results into one graded table per AC, applying re-checks.
const graded: GradedCriterion[] = [];
const verdictLookups: AcVerdict[] = [];
for (const run of groupResults) {
  for (const verdict of run.audit.verdicts) verdictLookups.push(verdict);
}
for (const criterion of criteria) {
  const verdict = verdictLookups.find((v) => v.id === criterion.id);
  const check = groupResults.flatMap((r) => r.checks).find((c) => c.id === criterion.id);
  if (verdict === undefined) {
    graded.push({
      id: criterion.id,
      wording: criterion.text,
      layer: criterion.layer,
      result: "NOT VERIFIED",
      evidence: "no auditor returned a verdict for this criterion",
      check: "not-checked",
      gap: "unaudited",
      call: "none",
    });
    continue;
  }
  const finalResult = check === undefined || check.status === "unconfirmed" ? verdict.result : check.result;
  const gateBacked = criterion.layer === "verification" && gateOutcomes.length > 0;
  graded.push({
    id: criterion.id,
    wording: criterion.text,
    layer: criterion.layer,
    result: finalResult,
    evidence:
      verdict.evidence +
      (verdict.indirect ? " [indirect evidence: a compile or build result standing in for a content check]" : "") +
      (check === undefined ? "" : ` [independent re-check ${check.status}: ${check.evidence}]`),
    check: check === undefined ? (gateBacked ? "decided-by-command" : "not-checked") : check.status,
    gap: verdict.gap,
    call: "none",
  });
}

const allFindings = domainResults.flatMap((r) => r.audit.findings.map((f) => ({ finding: f, domain: r.spec.title, checks: r.checks })));
const adjudicator = agent("Gap adjudicator", {
  system:
    "You adjudicate a compliance review's deviations on one consistent scale, because the verdict the user acts on is the ranking and the go/no-go, not the raw grep output. " +
      "For every deviation you are given: quote the AC's exact wording and derive the call from it (Pitfall 21.1, SKILL.md:312; Pitfall 27, :368-372). ACCEPTABLE is a judgment you must justify, never a default that hides a gap. " +
      "Distinguish an implementation failure from a plan error: a stale plan claim or a plan text contradicted by the governing external authority is a close-out note, not a FAIL (:313, :315). " +
      "Rank gaps functional first, then docs and process debt, then polish (:58). " +
      "For every gap you turn into a converge task, carry its evidence line forward verbatim so the implementer repairs the finding rather than a re-derivation of it (:123-135). " +
      "When a gap touches Pitfall 15 (:247-255) — a derived value, promptOverride, rules-of-hooks ordering, or hook-above-early-return constraint — the converge task text must tell the fixer to trace the decision point, keep hooks above early returns, and pass the derived value or promptOverride through to the runtime. " +
      `You read and reason over the evidence in front of you; do not run gates or edit files. ${READ_ONLY} ${IMPOSSIBLE_CHECK}`,
});

const adjudication = await adjudicator.ask<Adjudication>(
  `Adjudicate the review of ${planIndex.featureName} (plan: ${planIndex.planPath !== "" ? planIndex.planPath : planPath}). ${anchorLine} ` +
    `Graded AC table after independent re-checks:\n${graded.map((g) => `${g.id} [${g.layer}] ${g.result}${g.gap === "" ? "" : ` — gap: ${g.gap}`} — ${clipTail(g.evidence, 320)}`).join("\n")}\n\n` +
    `Findings with their re-check status:\n${allFindings.map((f) => `${f.domain} / ${f.finding.item} (${f.finding.severity}) — ${f.finding.problem} — ${clipTail(f.finding.evidence, 240)}`).join("\n") || "none"}\n\n` +
    `Gate outcomes the script executed itself:\n${gateSummaryText(gateOutcomes)}\n` +
    (softGateFailures.length > 0 ? `Non-blocking gate failures: ${softGateFailures.map((g) => `${g.label} exit ${g.exitCode}`).join("; ")}\n` : "") +
    (blockingGateFailures.length > 0 ? `Blocking gate failures (the plan's own criteria): ${blockingGateFailures.map((g) => `${g.label} exit ${g.exitCode}`).join("; ")}\n` : "") +
    `The plan explicitly asked the reviewer to judge: ${planIndex.askedJudgments.join(" | ") || "nothing"}\n` +
    `The plan's numeric or authority-bound claims about this repository: ${planIndex.planSpotChecks.join(" | ") || "none"}\n` +
    `Plan-close-out material already found: ${planIndex.verificationCommands.length > 0 ? "verification section was re-executed by the script" : "no verification section"}\n\n` +
    `Before you return, audit your own list: for every judgment you marked ACCEPTABLE, quote the AC wording that supports it and, if you cannot, reclassify it as REQUIRED_FIX. ` +
      `For every REQUIRED_FIX, confirm the evidence actually shows it rather than restating an approach-table hint (SKILL.md:368-372). ` +
      `Re-emit the whole adjudication — judgments, converge tasks, ranked gaps, plan close-outs — with those corrections applied. Do not soften anything to make the verdict tidier. ` +
      `Return one Judgment per deviation, PARTIAL, FAIL, PENDING, NOT VERIFIED, and plan-asked item; the converge task list; the ranked gap list; and the plan close-out notes. ${OUTPUT_CONTRACT}`,
);

const freshChallenger = agent("Verdict challenger", {
  system:
    "You have seen nothing of this review except the tables in front of you. Your job is to break the recommendation, not to bless it (dynamic-workflows §3: ask what would break it). " +
    "Name the specific criteria whose stated result the quoted evidence cannot support — a PASS whose evidence is a build result, a FAIL whose anchor was never read, a PENDING with no deferral source, a gap missing from the ranking that the findings show. " +
    `Do not investigate the repository and do not edit anything; judge the evidence as given. ${IMPOSSIBLE_CHECK}`,
});

const challenge = await freshChallenger.ask<VerdictChallenge>(
  `A spec-compliance review of ${planIndex.featureName} reached the results below. What would make this wrong? ` +
    `AC table:\n${graded.map((g) => `${g.id} ${g.result} — ${clipTail(g.evidence, 200)}`).join("\n")}\n\n` +
    `Findings:\n${allFindings.map((f) => `${f.finding.item} (${f.finding.severity}) ${f.finding.problem}`).join("\n") || "none"}\n\n` +
    `Gates the script ran:\n${gateSummaryText(gateOutcomes)}\n\n` +
    `Adjudicated gaps: ${adjudication.rankedGaps.join(" | ") || "none"}\n` +
    `Return holds, the item labels whose evidence cannot support their stated result, and your reasoning. ${OUTPUT_CONTRACT}`,
);

for (const item of challenge.unsupportedItems) {
  const row = graded.find((g) => g.id === item);
  if (row !== undefined && row.result === "PASS") {
    row.result = "NOT VERIFIED";
    row.check = "unconfirmed";
    row.gap = "an independent reviewer of the evidence tables could not support this PASS from the quoted evidence";
    row.evidence = `${row.evidence} [challenged: ${clipTail(challenge.reasoning, 200)}]`;
  }
}

const requiredFixes = graded.filter((g) => g.call === "REQUIRED_FIX").length + adjudication.tasks.length;
const unmetAcs = graded.filter((g) => g.result === "FAIL" && g.call !== "ACCEPTABLE");
const partialAcs = graded.filter((g) => g.result === "PARTIAL");
const pendingAcs = graded.filter((g) => g.result === "PENDING");
const unverifiableAcs = graded.filter((g) => g.result === "NOT VERIFIED");
const highConfirmed = allFindings.filter((f) => {
  const matched = f.checks.find((c) => c.item === f.finding.item);
  return f.finding.severity === "high" && (matched === undefined || matched.status === "confirmed");
});

let recommendation = "APPROVED";
if (blockingGateFailures.length > 0 || unmetAcs.length > 0 || highConfirmed.length > 0) {
  recommendation = "NO-GO";
} else if (
  partialAcs.length > 0 ||
  pendingAcs.length > 0 ||
  unverifiableAcs.length > 0 ||
  softGateFailures.length > 0 ||
  unrunGates.length > 0 ||
  requiredFixes > 0 ||
  adjudication.planCloseOuts.length > 0 ||
  !challenge.holds
) {
  recommendation = "APPROVED WITH CAVEATS";
}

// ---------------------------------------------------------------------------
// Phases 7-8 — the two writes this skill prescribes (converge tasks into the
// plan, revert of incidental artifacts), each gated on the owner's answer.
// ---------------------------------------------------------------------------

const convergeText = adjudication.tasks
  .map((t) => `- [ ] ${t.task}\n  Evidence from the review: ${t.evidence}`)
  .join("\n");

if (adjudication.tasks.length > 0 || incidentalArtifacts.length > 0 || regenerated.length > 0) {
  phase("Settle the plan edits and cleanup with the owner");
  const approvals = await liaison.ask<OwnerApprovals>(
    `The review of ${planIndex.featureName} says: ${recommendation}. ` +
      (adjudication.tasks.length > 0
        ? `SKILL.md step 7 (:123-135) requires each gap to be appended to the plan as a bite-sized task carrying its evidence forward, then looped. ${adjudication.tasks.length} task(s) are ready:\n${clipTail(convergeText, 1800)}\n Ask the owner whether to append them to ${planIndex.planPath !== "" ? planIndex.planPath : planPath} now, or defer.`
        : "No converge tasks were generated, so do not ask about plan edits.") +
      (incidentalArtifacts.length > 0
        ? ` Reverting incidental build artifacts (SKILL.md:84-93) means running git checkout on: ${incidentalArtifacts.join(", ")}. Ask whether to revert them or leave the tree as it is.`
        : " No incidental artifacts were left dirty by this run, so do not ask about cleanup.") +
      (regenerated.length > 0
        ? ` Regenerating the committed output produced differences in: ${regenerated.join(", ")} — ask whether the owner wants those kept for inspection or reverted; do not decide for them.`
        : "") +
      ` Record the answers, and quote anything the owner adds in notes. An unanswered question means no write happens. ${READ_ONLY} ${OUTPUT_CONTRACT}`,
);
  ownerApprovals.converge = approvals.converge;
  ownerApprovals.cleanup = approvals.cleanup;
  if (approvals.liveEvidence !== "not-asked") ownerApprovals.liveEvidence = approvals.liveEvidence;
  if (approvals.notes !== "") {
    ownerApprovals.notes = ownerApprovals.notes === "" ? approvals.notes : `${ownerApprovals.notes} | ${approvals.notes}`;
  }

  if (ownerApprovals.converge === "append" && adjudication.tasks.length > 0) {
    const appender = agent("Plan task appender", {
      system:
        "You append a converge block to one plan file and nothing else. Add only; never rewrite, reorder, or delete the plan's existing content (SKILL.md:123-135). " +
        "Each task keeps the review's evidence line so the implementer repairs the finding, not a re-derivation of it. " +
        "The only file you may edit is the plan you are given: no other source, config, or lockfile; no staging, commit, or push; no write, DDL, or data-changing SQL; no paid or mutating live call. " +
        IMPOSSIBLE_CHECK,
    });
    const writeResult = await appender.ask<PlanWriteResult>(
      `Append a "## Converge tasks (spec review)" section to ${planIndex.planPath !== "" ? planIndex.planPath : planPath}, containing exactly:\n${convergeText}\n\n` +
        `Re-read the file afterwards and report written true only if the section is present, with the line range you added. ${OUTPUT_CONTRACT}`,
    );
    if (!writeResult.written) {
      log(`The owner approved appending the converge tasks but the appender could not confirm the write: ${writeResult.detail}`);
    }
  }

  if (ownerApprovals.cleanup === "revert" && incidentalArtifacts.length > 0) {
    const revert = await world.run("git", ["checkout", "--"].concat(incidentalArtifacts));
    log(
      revert.exitCode === 0
        ? `Reverted ${incidentalArtifacts.length} incidental artifact(s) with the owner's approval (SKILL.md:84-93).`
        : `The owner approved the artifact revert but git checkout exited ${revert.exitCode}: ${clipTail(revert.stderr, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 9 — the tree may have moved under the review (Pitfall 11 step 6):
// re-run the blocking gates and say which tree the numbers reflect.
// ---------------------------------------------------------------------------

let gateRecheckNote = "";
const treeMoved = treeStatus !== null && postRegenStatus !== null && postRegenStatus.unstaged.length !== treeStatus.unstaged.length;
const writesHappened = ownerApprovals.converge === "append" || ownerApprovals.cleanup === "revert";
if (treeMoved || writesHappened) {
  phase("Re-run the checks after the tree changed");
  const recheckGates = allGates.filter((g) => g.blocking);
  const recheckOutcomes: GateOutcome[] = [];
  for (const gate of recheckGates) {
    const again = await runGate(gate);
    recheckOutcomes.push(again);
  }
  gateRecheckNote = recheckOutcomes.map((g) => `${g.label}: ${g.command} -> exit ${g.exitCode}${g.ran ? "" : " (did not run)"}`).join("; ");
  log(`Re-ran ${recheckOutcomes.length} blocking gate(s) after the tree changed.`);
} else {
  log("The tree did not move during the review, so the first gate results still describe the state under review.");
}

// ---------------------------------------------------------------------------
// Phase 10 — the deliverable: the skill's own report format (§6), published
// from the path the writer returned.
// ---------------------------------------------------------------------------

phase("Write the compliance report");

const reportPath = `out/spec-review/${reportSlug(planIndex.featureName, planIndex.planPath !== "" ? planIndex.planPath : planPath)}-compliance-review.md`;

const scopeAudit = domainResults.find((r) => r.spec.key === "scope");
const scopeFindingSummary = scopeAudit === undefined ? "the change-scope domain did not run" : scopeAudit.audit.findings.map((f) => f.problem).join("; ") === "" ? "no unintended-change finding" : scopeAudit.audit.findings.map((f) => f.problem).join("; ");

const layerTables = (["feature", "architecture", "verification"] as const).map((layer) => {
  const rows = graded.filter((g) => g.layer === layer);
  if (rows.length === 0) return "";
  const header = layer === "feature" ? "Must-have acceptance criteria" : layer === "architecture" ? "Architecture & contracts" : "Verification & deliverables";
  return `### ${header}\n| AC | Result | Evidence |\n|---|---|---|\n${rows.map((r) => `| ${r.id} | ${r.result} | ${r.evidence.replace(/\|/g, "/")} |`).join("\n")}`;
});

const reportBody = [
  `## Review Summary: ${planIndex.featureName}`,
  "",
  `**Recommendation:** ${recommendation}`,
  "",
  `Plan: ${planIndex.planPath !== "" ? planIndex.planPath : planPath}. Anchored to: ${anchorLine}`,
  "",
  planIndex.greenfield
    ? layerTables.filter((t) => t !== "").join("\n\n")
    : `### Spec Compliance\n| AC | Result | Evidence |\n|---|---|---|\n${graded.map((g) => `| ${g.id} | ${g.result} | ${g.evidence.replace(/\|/g, "/")} |`).join("\n") || "| — | NOT VERIFIED | no criteria were enumerated |"}`,
  "",
  "### Code Quality",
  "| Check | Result | Evidence |",
  "|---|---|---|",
  `| Intended files only | ${changedPaths.length > 0 && planIndex.plannedFiles.length > 0 ? "see change-scope audit" : "NOT VERIFIED"} | ${clipTail(scopeFindingSummary, 300)} |`,
  gateOutcomes.map((g) => `| ${g.label} | ${g.ran ? (g.exitCode === 0 ? "PASS" : "FAIL") : "NOT RUN"} | ${g.command} -> exit ${g.exitCode}${g.ran ? "" : ` (${g.skipReason})`} |`).join("\n"),
  "",
  "### Findings",
  allFindings.length === 0
    ? "None beyond the AC table."
    : allFindings
        .map((f) => {
          const matched = f.checks.find((c) => c.item === f.finding.item);
          const status = matched === undefined ? "not independently re-checked" : `re-check ${matched.status}`;
          return `- **${f.domain} / ${f.finding.item}** (${f.finding.severity}, ${status}) — ${f.finding.problem} — ${f.finding.where} — ${f.finding.evidence}`;
        })
        .join("\n"),
  "",
  "### Converge tasks",
  adjudication.tasks.length === 0
    ? "None: no gap needs re-entering the task list."
    : `${adjudication.tasks.map((t) => `- [ ] ${t.task} — evidence: ${t.evidence}`).join("\n")}\n\nOwner decision on appending these to the plan: ${ownerApprovals.converge}.`,
  "",
  "### Ranked gaps",
  adjudication.rankedGaps.length === 0 ? "None." : adjudication.rankedGaps.map((g) => `- ${g}`).join("\n"),
  "",
  "### Plan close-outs",
  adjudication.planCloseOuts.length === 0 ? "None." : adjudication.planCloseOuts.map((c) => `- ${c}`).join("\n"),
  "",
  "### Notes",
  `- Verdicts are anchored to the committed state named above${dirtyAtStart.length > 0 ? `; ${dirtyAtStart.length} path(s) were already dirty when the run started and are reported as a separate delta (SKILL.md:209-220)` : ""}.`,
  gateRecheckNote === "" ? "- The blocking gates were run once by the script and the tree did not change under them." : `- Re-run after the tree moved, reflecting the state at handover: ${gateRecheckNote}.`,
  `- Owner answers: live evidence ${ownerApprovals.liveEvidence}; converge append ${ownerApprovals.converge}; artifact revert ${ownerApprovals.cleanup}${ownerApprovals.notes === "" ? "" : `. Owner notes: ${ownerApprovals.notes}`}.`,
  `- Fresh-eyes challenge on the verdict: ${challenge.holds ? "held" : "did not hold"} — ${clipTail(challenge.reasoning, 300)}`,
  `- Domain coverage gaps reported by the auditors themselves: ${domainResults.flatMap((r) => r.audit.skipped.map((s) => `${r.spec.title}: ${s}`)).join("; ") || "none"}.`,
  `- Auditor skipped items on the AC side: ${groupResults.flatMap((r) => r.audit.skipped).join("; ") || "none"}.`,
].join("\n");

const reportFileResult = await writer.ask<ReportFile>(
  `Write the compliance report below to ${reportPath} exactly as given — keep the skill's §6 section order (SKILL.md:95-121), add nothing that contradicts the evidence lines, and reply with the path you actually wrote. ` +
    `The only file you may create or overwrite is that report path: no source, plan, config, or lockfile edits, no staging, commit, or push, no write or data-changing SQL, no paid or mutating live call. ` +
    `If the directory does not exist, create it. If the write is impossible, escalate rather than writing it somewhere else.\n\n${reportBody}\n\n${OUTPUT_CONTRACT}`,
);

const writtenPath = reportFileResult.path.trim();
const publishable = writtenPath.endsWith(".md");
const published = await publishReport(
  publishable ? writtenPath : reportPath,
  `Go / no-go against ${planIndex.featureName}: ${recommendation}, ${graded.length} criteria graded with their evidence.`,
  reportBody,
);

const findingsForReturn: Finding[] = allFindings.map((f) => {
  const matched = f.checks.find((c) => c.item === f.finding.item);
  const status: Finding["status"] = matched === undefined ? "unconfirmed" : matched.status === "confirmed" ? "verified" : "unconfirmed";
  const severity: Finding["severity"] = matched === undefined ? f.finding.severity : matched.severity;
  const what = matched !== undefined && matched.status === "refuted" ? `${f.finding.problem} (independent re-check refuted the evidence for this)` : f.finding.problem;
  return { where: f.finding.where === "" ? f.finding.item : f.finding.where, what: `${f.domain}: ${what}`, evidence: f.finding.evidence, status: status, severity: severity };
});

for (const gate of blockingGateFailures) {
  findingsForReturn.push({
    where: gate.command,
    what: `The plan's own quality gate "${gate.label}" exited ${gate.exitCode}; a verification criterion in the plan is not met (SKILL.md:197-201)`,
    evidence: clipTail(`${gate.errTail === "" ? gate.tail : gate.errTail}`, 400),
    status: "verified",
    severity: "high",
  });
}
for (const gate of unrunGates) {
  findingsForReturn.push({
    where: gate.command,
    what: `Gate "${gate.label}" could not be executed, so the criterion it decides is unverified rather than passing`,
    evidence: gate.skipReason,
    status: "unconfirmed",
    severity: "medium",
  });
}

const result: WorkflowReport = {
  conclusion:
    `${recommendation} for ${planIndex.featureName}: ${graded.filter((g) => g.result === "PASS").length}/${graded.length} acceptance criteria pass with evidence` +
    `${unmetAcs.length > 0 ? `, ${unmetAcs.map((g) => g.id).join(", ")} fail` : ""}${partialAcs.length > 0 ? `, ${partialAcs.length} partial` : ""}${pendingAcs.length > 0 ? `, ${pendingAcs.length} deferred by the plan` : ""}${unverifiableAcs.length > 0 ? `, ${unverifiableAcs.length} unverifiable` : ""}. ` +
    `${blockingGateFailures.length > 0 ? `The plan's own gates failed: ${blockingGateFailures.map((g) => g.label).join(", ")}. ` : `Every gate the script ran exited zero. `}` +
    `The long-form AC-by-AC report is ${published ? `published at ${publishable ? writtenPath : reportPath}` : "inlined as the fallback artifact because the report file could not be published"}.`,
  findings: findingsForReturn,
  verified: [
    `${criteria.length} acceptance criteria graded from ${planIndex.planPath !== "" ? planIndex.planPath : planPath}; ${graded.filter((g) => g.check === "confirmed").length} non-passing verdicts independently re-checked`,
    `gates executed by this script (exit codes, not claims): ${gateOutcomes.map((g) => `${g.command}=${g.ran ? g.exitCode : "not run"}`).join(", ") || "none were runnable"}`,
    `revision anchored before any verdict: ${anchorLine}`,
    `domain audits run: ${auditDomains.map((d) => d.title).join(", ")}; AC auditor coverage: ${groupResults.map((r) => `${r.audit.ids.join(",")}: ${r.audit.coverage.join("; ")}`).join(" | ")}; domain coverage: ${domainResults.map((r) => `${r.spec.title}: ${r.audit.coverage.join("; ")}`).join(" | ")}`,
    `owner gates reached by escalation: live-evidence spend (${ownerApprovals.liveEvidence}), converge-task append (${ownerApprovals.converge}), artifact revert (${ownerApprovals.cleanup})`,
  ],
  notCovered: [
    ...(gateSurvey.planCommandsNotMapped.length > 0
      ? [`plan verification commands the script has no literal command for, which no auditor reported running either: ${gateSurvey.planCommandsNotMapped.join("; ")}`]
      : []),
    ...(unrunGates.length > 0 ? [`gates that could not execute: ${unrunGates.map((g) => g.label).join(", ")}`] : []),
    ...(needsLive && ownerApprovals.liveEvidence !== "authorized"
      ? [`no live, browser, or deployed-environment evidence was gathered: the owner's answer on spending it was "${ownerApprovals.liveEvidence}", so the affected criteria are graded at code level with the deploy gate named`]
      : []),
    ...(!hasUiWork ? ["the design-system and UI-completeness audit did not run: no UI surface appears in the plan's file list or the change set"] : []),
    ...(planIndex.greenfield ? [] : ["the architecture-and-deliverables layer table is only produced for greenfield plans (SKILL.md:52-58); this plan was read as a feature diff"]),
    ...domainResults.flatMap((r) => r.audit.skipped.map((s) => `${r.spec.title} could not check: ${s}`)),
    ...groupResults.flatMap((r) => r.audit.skipped),
    ...(published ? [] : ["the report file could not be published; the same facts are in the fallback markdown and in this handoff"]),
    "no source file, plan, config, or lockfile was edited without the owner's answer, nothing was committed or pushed, and no paid or mutating live call was spent without authorization",
  ],
};

return result;
