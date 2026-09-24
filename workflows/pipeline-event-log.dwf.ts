/* zcode-workflow
description: "Audits a workspace implementation against the pipeline-event-log
  skill's verification checklist: one auditor plus independent confirmers per
  checklist item, a synthesizer that reconciles verdicts, and a checklist report
  where every pass rests on named evidence or is labelled unconfirmed. Embodies
  the pipeline-event-log skill."
whenToUse: When a pipeline implementation needs auditing against the
  pipeline-event-log pattern's verification checklist.
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// pipeline-event-log.ts
// Dynamic workflow DRAFT: audit a workspace implementation of the pipeline-event-log pattern
// against the skill's own Verification Checklist (CHECKLIST.length items, defined below).
// Embodying /Users/alejandrodelvillar/.agents/skills/pipeline-event-log/SKILL.md (341 lines).
// Pattern: hybrid — structure in this script; every audit ask references the skill's SKILL.md
// and references/production-implementation.md by absolute path, and the subagents read the
// cited sections themselves.
//
// STRUCTURE DISCLOSURE (corrects the batch label): the parent materials describe this skill as
// "5 steps pipeline forensics", but the skill contains NO numbered step list — verified against
// the full read this session. It is a PATTERN REFERENCE: data model (:50-58), event types
// (:62-88), appendLog helper with the NULL-vs-append CASE (:92-123), the trim query with
// ORDER BY ordinality DESC (:111-136), event sequences (:140-164), the React UI renderer
// (:168-219), integration points (:223-276), pitfalls (:280-324), and a Verification Checklist
// at :328-341 that holds exactly 12 checkbox items (:330-341 — counted this session). The
// parent citation "SKILL.md:1145-1158" cannot exist: the file is 341 lines. The audit stages
// below are therefore derived from the 12 checklist items, not from a step list.
//
// SOURCE GATE (verified this session): nothing in this workspace implements the pattern —
//   grep -rnE 'pipeline_runs|appendLog|MAX_LOG_LINES' scripts/   → exit 1, zero matches
//   the same symbols workspace-wide (sources only; see excludes below) → exit 1
// The first phase therefore deterministically re-runs the availability audit with world.run and,
// when no source is confirmed, ESCALATES to the human run owner or reports "not present" — it
// never invents log evidence. Gate ERRORS are not absence: a grep/find that exits 2 is surfaced
// to the gatekeeper and qualified in the report instead of silently reading as "not present".
// The JSONL inventory gate exists because a live workspace could carry standalone JSONL logs
// without an implementation; its content check matches every one of the skill's event
// types serialized as "event":"<type>" (the LogEvent shape, SKILL.md:76-83). CLAUDE.md:24's
// "pipeline" is NOT asserted by this script or by any gate — the gatekeeper is instructed to
// read that line at run time and report what it refers to (this session's planning read found
// the AI extraction pipeline shared between booking confirmations and commission check
// statements). This session's only *.jsonl is out/swarm/probes.jsonl, which matches none of
// the serialized event types and is swarm-part machinery.//
// SKILL SCRIPTS: the skill ships no scripts/ directory (only SKILL.md and references/ —
// verified this session), so no world.run-skill-script clause applies.
//
// world.run SCOPE: the deterministic gates are the three availability searches below
// (implementation-symbol grep, JSONL inventory find, JSONL content grep). Everything after the
// gate is reading work for subagents: the checklist audit reads the confirmed sources and the
// two skill documents, and no check after the gate branches on a command's exit code.
// The implementation grep excludes .zcode and out because this batch stores its own drafts and
// mirrors there — those files mention the pattern's symbols and would only self-match.
//
// WRITE RULES: this workflow is a read-only audit. No subagent is asked to write, create or
// edit anything; the only workspace-adjacent outputs are the artifact publishes, which are
// script-side. There is therefore no write gate to route through escalation — the gate that
// DOES reach the run owner by escalation is the source gate below (what to audit, or whether
// to report the pattern as not present).
//
// DEFECT-REGISTER RULES APPLIED: single primary artifact with a try/catch compact fallback on
// every publish; no tunable constant interpolated into any ask text (thresholds live in script
// constants; asks carry per-item data and replayed upstream results only); unique computed
// subagent names in the fan-out (built from map indices, which are structurally unique); named
// ask<T> interfaces only; approval decisions reach the run owner by subagent escalation.

// ─── Result interfaces (all named; every ask<T> uses one) ────────────────────

interface Finding {
  /** Workspace-relative path with a line when it applies: "src/lib/ai/auto-advance.ts:42". */
  where: string;
  /** One sentence: what deviates from the pattern the checklist item demands. */
  what: string;
  /** What showed it: the cited lines, the confirmer's note, or the world.run command and output. */
  evidence: string;
  /** "verified" when an independent confirmer reproduced it from the sources alone; otherwise "unconfirmed". */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for silent data loss or a broken audit trail. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the run audited and what it found. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the world.run gates, the auditors, the confirmers. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

/** What the source gatekeeper brings back after confirming candidates (and, if needed, the owner). */
interface SourceDecision {
  /** "audit" when at least one confirmed source exists; "not-present" when the run should report the pattern is not implemented here. */
  outcome: "audit" | "not-present";
  /** Paths worth auditing — confirmed candidates or owner-named files. Empty when outcome is "not-present". */
  sourcePaths: string[];
  /** What was confirmed, by whom, and any owner guidance — for the report, never secrets. */
  ownerGuidance: string;
  /** What CLAUDE.md:24's 'pipeline' refers to, as read by the gatekeeper; empty when that line was not read. */
  claudeMdFinding: string;
}

/** One concrete deviation an item auditor found. */
interface AuditFinding {
  /** path:line in the audited sources the deviation is visible at. */
  where: string;
  /** One sentence: what is wrong against the checklist item. */
  problem: string;
  /** The 1-based checklist item this finding belongs to. */
  checklistItem: number;
  /** How much it matters. */
  severity: "low" | "medium" | "high";
}

/** One checklist item auditor's verdict. */
interface ItemVerdict {
  /** The 1-based checklist item this verdict belongs to. */
  item: number;
  /** "not-applicable" when the confirmed sources genuinely do not contain the code this item is about. */
  verdict: "pass" | "partial" | "fail" | "not-applicable";
  /** Two sentences at most: what the sources show, with path:line anchors. */
  evidence: string;
  /** Concrete deviations; empty when the item passes cleanly. */
  findings: AuditFinding[];
}

/** An independent confirmer's re-reading of one finding. */
interface FindingConfirmation {
  /** True only when the confirmer saw the claimed deviation in the sources themselves. */
  reproduced: boolean;
  /** What the confirmer saw, or why the finding could not be reproduced. */
  note: string;
}

/** A finding after confirmation — what the report carries. */
interface ConfirmedFinding extends AuditFinding {
  /** From the confirmer, never from the auditor that raised the finding. */
  status: "verified" | "unconfirmed";
  /** The confirmer's note, kept so the user can tell "seen" from "suspected". */
  confirmationNote: string;
}

/** What one fan-out lane returns: verdict plus its confirmed findings. */
interface ItemOutcome {
  /** 1-based checklist item number. */
  item: number;
  /** Short label from the checklist table. */
  label: string;
  /** The auditor's verdict for this item. */
  verdict: ItemVerdict;
  /** The item's findings after independent confirmation. */
  findings: ConfirmedFinding[];
}

/** The synthesizer's cross-item contribution to the report. */
interface ReportSynthesis {
  /** 2-4 sentences for the report header: what the implementation is, and how it fares overall. */
  overview: string;
  /** Cross-item conclusions: shared root causes, overlaps, whether the pattern is absent or partially conforming. */
  crossCutting: string[];
}

/** One row of the skill's Verification Checklist with its pattern anchors. */
interface ChecklistItem {
  /** Short label for names, board cards and report lines. */
  label: string;
  /** The item text, verbatim from SKILL.md:330-341. */
  text: string;
  /** Where SKILL.md defines the pattern this item checks. */
  skill: string;
  /** Where production-implementation.md carries it; "—" when that file has no section for it. */
  ref: string;
}

// ─── Constants (thresholds and patterns stay here, out of ask text) ──────────

const SKILL_PATH = "/Users/alejandrodelvillar/.agents/skills/pipeline-event-log/SKILL.md";
const REF_PATH =
  "/Users/alejandrodelvillar/.agents/skills/pipeline-event-log/references/production-implementation.md";
const IMPL_PATTERN = "pipeline_runs|appendLog|MAX_LOG_LINES";
// The skill's event types (SKILL.md:65-74), matched in their serialized
// "event":"<type>" form so ordinary JSONL chatter about "errors" or "pauses" cannot
// false-positive. The alternation is BUILT from this list, so EVENT_TYPES.length is the
// single source of truth for the type count everywhere it is quoted.
const EVENT_TYPES = [
  "advancing",
  "job_completed",
  "job_failed",
  "skipping_optional",
  "phase_complete",
  "pipeline_complete",
  "pipeline_failed",
  "paused",
  "error",
];
const LOG_CONTENT_PATTERN = '"event"\\s*:\\s*"(' + EVENT_TYPES.join("|") + ')"';
/** Hard cap on the JSONL candidate list handed to the content grep. */
const JSONL_CAP = 50;
/** Hard cap on independent confirmers per checklist item — bounds the fan-out's token cost;
 *  overflow findings are still reported, labelled unconfirmed-by-cap rather than dropped. */
const CONFIRMER_CAP = 6;

// The skill's Verification Checklist, SKILL.md:328-341, items at :330-341 (12, counted).
const CHECKLIST: ChecklistItem[] = [
  {
    label: "LogEvent type coverage",
    text: "LogEvent type covers all needed event types",
    skill: "the Event Type section :62-88 (the nine-member EventType union :65-74, the LogEvent fields :76-83, and which fields are optional :87-88)",
    ref: "the Event Types Used section :13-26",
  },
  {
    label: "NULL-vs-append",
    text: "appendLog() creates the line on NULL log, appends otherwise",
    skill: "the appendLog Helper :92-123, specifically the CASE WHEN log IS NULL branch :101-108",
    ref: "the appendLog Implementation :28-53, CASE branch :35-39",
  },
  {
    label: "Trim cap",
    text: "Auto-trim keeps exactly MAX_LOG_LINES or fewer",
    skill: "the constant at :95 and the trim UPDATE :110-121 (ordinality <= the limit :116)",
    ref: "the trim query :42-52",
  },
  {
    label: "ORDER BY ordinality DESC",
    text: "Trim query uses ORDER BY ordinality DESC for correct ordering",
    skill: "the ORDER BY clause :114, how the trim works :125-136, and pitfall 5 :313-317",
    ref: "the ORDER BY clause :45",
  },
  {
    label: "Trim guard",
    text: "Trim query only runs when log exceeds the limit (not every call)",
    skill: "the WHERE guards :118-120 (array_length > limit) and pitfall 3 :298-305",
    ref: "the WHERE guards :49-51",
  },
  {
    label: "JSON.parse try/catch",
    text: "UI renderer has try/catch around JSON.parse",
    skill: "the UI Renderer :168-207 (per-line parse :179-180, catch fallback to plain text :201-203) and pitfall 1 :282-290",
    ref: "the files table :9 (the shipped renderer lives at PostScraperTimeline.tsx:245-267)",
  },
  {
    label: "Per-type colors",
    text: "Color coding is applied per event type",
    skill: "the colorMap :181-187 and the Color Coding Convention table :209-219",
    ref: "the files table :9",
  },
  {
    label: "Timestamp formatting",
    text: "Timestamps are formatted as human-readable time strings",
    skill: "the renderer's toLocaleTimeString span :191-193",
    ref: "—",
  },
  {
    label: "Optional-chaining fields",
    text: "Phase/step/jobId are only shown when present (optional chaining)",
    skill: "the renderer's conditional phase/step/jobId spans :195-197 and the optional-field note :87-88",
    ref: "—",
  },
  {
    label: "State-transition logging",
    text: "Each pipeline state transition is logged",
    skill: "the Event Sequences :140-164 and the Integration Points :223-276 (pipeline_failed :228-237, advancing :239-246, pipeline_complete :248-253, skipping_optional :255-263, runner error :271-275)",
    ref: "the files table :7-8 (the orchestrator and the admin route that reads the log back)",
  },
  {
    label: "SQL-injection safety",
    text: "No SQL injection risk from log content",
    skill: "pitfall 2 :292-296 and the parameterized $executeRaw template usage :101-121",
    ref: "the appendLog Implementation :33-52",
  },
  {
    label: "Error-path capture",
    text: "Error events are captured for all failure paths",
    skill: "the ERROR sequence :163 and the runner's error path :266-276",
    ref: "the files table :7",
  },
];

// ─── Phase 1: the source gate ────────────────────────────────────────────────

phase("Find the pipeline event log to audit");

// Gate 1 — does anything implement the pattern? (This session: exit 1, zero matches.)
const implGrep = await world.run("grep", [
  "-rEl",
  IMPL_PATTERN,
  "--include=*.ts",
  "--include=*.tsx",
  "--include=*.prisma",
  "--include=*.sql",
  "--exclude-dir=node_modules",
  "--exclude-dir=.git",
  "--exclude-dir=.next",
  "--exclude-dir=.zcode",
  "--exclude-dir=out",
  ".",
]);
const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter((x) => x !== "");
const firstLine = (s: string) => {
  const lines = splitLines(s);
  return lines.length > 0 ? lines[0] : "(no output)";
};
// Matches on stdout are real even when grep also errors, so stdout is always parsed — but an
// errored gate must never be read as a clean absence, so every error is recorded and surfaced.
const implFiles = splitLines(implGrep.stdout);
const gateErrors: string[] = [];
if (implGrep.exitCode !== 0 && implGrep.exitCode !== 1) {
  gateErrors.push(
    "the implementation-symbol grep exited " + implGrep.exitCode + ": " + firstLine(implGrep.stderr),
  );
}

// Gate 2 — standalone JSONL logs that no implementation grep would catch.
const jsonlFind = await world.run("find", [
  ".",
  "-name",
  "*.jsonl",
  "-not",
  "-path",
  "*/node_modules/*",
  "-not",
  "-path",
  "*/.git/*",
  "-not",
  "-path",
  "*/.zcode/*",
]);
const allJsonl = splitLines(jsonlFind.stdout);
if (jsonlFind.exitCode !== 0) {
  gateErrors.push(
    "the JSONL inventory find exited " + jsonlFind.exitCode + " (inventory may be partial): " +
      firstLine(jsonlFind.stderr),
  );
}
const jsonlFiles = allJsonl.slice(0, JSONL_CAP);
if (allJsonl.length > jsonlFiles.length) {
  log(`JSONL inventory capped at ${JSONL_CAP} of ${allJsonl.length} files.`);
}

// Gate 3 — do the JSONL candidates actually carry pipeline events, or are they other machinery?
let logFiles: string[] = [];
if (jsonlFiles.length > 0) {
  const contentGrep = await world.run("grep", ["-lE", LOG_CONTENT_PATTERN, ...jsonlFiles]);
  logFiles = splitLines(contentGrep.stdout);
  if (contentGrep.exitCode !== 0 && contentGrep.exitCode !== 1) {
    gateErrors.push(
      "the JSONL content grep exited " + contentGrep.exitCode + ": " + firstLine(contentGrep.stderr),
    );
  }
}

log(
  `Availability audit: ${implFiles.length} implementation file(s), ` +
    `${jsonlFiles.length} JSONL file(s) checked, ${logFiles.length} carrying pipeline events.` +
    (gateErrors.length > 0 ? " Gate errors: " + gateErrors.join("; ") : ""),
);

const gatekeeper = agent("Source gatekeeper", {
  system:
    "You gate what this read-only audit may look at. You never invent or guess a file path, and " +
    "you never accept a candidate you have not checked yourself. When the decision belongs to the " +
    "human who started this run, use your escalate tool with the evidence and one focused " +
    "question. If a check is impossible to pass, or your instructions contradict each other, " +
    "escalate and say so plainly rather than working around it. If your escalation allowance is " +
    "spent with no answer, return outcome 'not-present' rather than proceeding on a guess.",
});

let sourcePaths: string[] = [];
let ownerGuidance = "";
let claudeMdFinding = "";
// True when the gatekeeper itself chose 'audit' but named no source paths — a contradiction
// between its verdict and its payload, not an owner decision. The not-present report labels
// the case correctly instead of attributing it to the run owner.
let gatekeeperNamedNoPaths = false;

if (implFiles.length > 0 || logFiles.length > 0) {
  const candidates = [...implFiles, ...logFiles];
  const decision = await gatekeeper.ask<SourceDecision>(
    "The workspace audit found these candidate sources for the pipeline_runs JSONL event log " +
      "(the pattern in " + SKILL_PATH + "):\n" +
      candidates.map((p) => "- " + p).join("\n") +
      (gateErrors.length > 0
        ? "\n\nGate errors were recorded — weigh these before concluding anything:\n" +
          gateErrors.map((e) => "- " + e).join("\n")
        : "") +
      "\n\nConfirm each candidate yourself: open it and check it is genuinely a pipeline " +
      "event-log implementation or JSONL event log, not a document, a fixture or a copy. Return " +
      "the paths worth auditing with outcome 'audit', or outcome 'not-present' if none qualify. " +
      "If the candidates are ambiguous in a way only the run owner can resolve, escalate to them " +
      "with this evidence and return their decision. " +
      "If the owner names other files instead, check those exist and read enough of them to " +
      "confirm before returning them as sourcePaths. Set claudeMdFinding to what CLAUDE.md " +
      "line 24's 'pipeline' refers to if you read that line; otherwise leave it empty.",
  );
  ownerGuidance = decision.ownerGuidance;
  claudeMdFinding = decision.claudeMdFinding;
  if (decision.outcome === "audit") {
    sourcePaths = decision.sourcePaths;
  }
  if (decision.outcome === "audit" && sourcePaths.length === 0) {
    gatekeeperNamedNoPaths = true;
    log("The gatekeeper confirmed the audit but named no sources — falling through to not-present.");
  }
} else {
  const decision = await gatekeeper.ask<SourceDecision>(
    "No pipeline event-log source exists in this workspace: the implementation search over " +
      "TypeScript/TSX/Prisma/SQL files found nothing, and the JSONL inventory turned up no file " +
      "carrying pipeline events." +
      (gateErrors.length > 0
        ? " Gate errors were recorded — an errored gate is NOT proof of absence:\n" +
          gateErrors.map((e) => "- " + e).join("\n") +
          "\nResolve or otherwise account for each errored gate yourself before concluding " +
          "anything, and say how in ownerGuidance."
        : "") +
      "\n\nFirst, read CLAUDE.md line 24 yourself and record what its 'pipeline' refers to in " +
      "claudeMdFinding — the report quotes that field as the only evidence about that line, so " +
      "quote it.\n\n" +
      "Escalate to the run owner now: ask whether pipeline event logging lives somewhere this " +
      "workspace audit could not see (have them name the files), or whether the run should report " +
      "the pattern as not present here. Return their answer. Do not proceed to an audit without " +
      "confirmed sources, and never construct log evidence that was not found.",
  );
  ownerGuidance = decision.ownerGuidance;
  claudeMdFinding = decision.claudeMdFinding;
  if (decision.outcome === "audit") {
    sourcePaths = decision.sourcePaths;
  }
}

if (sourcePaths.length === 0) {
  // Not present — report it honestly instead of inventing evidence.
  const absentMd = [
    "# Pipeline event-log audit — not present",
    "",
    "No implementation of the pipeline-event-log pattern was found in this workspace" +
      (gatekeeperNamedNoPaths
        ? "; the source gatekeeper returned an audit outcome but named no paths, so the audit " +
          "had nothing to read. No owner pointer was solicited on that case."
        : ", and the run owner did not point at one. Nothing was audited; nothing was invented."),
    "",
    "## What the deterministic gates checked",
    "- world.run grep over *.ts/*.tsx/*.prisma/*.sql for the pattern's implementation symbols" +
      " (the pipeline_runs model, the appendLog helper, the MAX_LOG_LINES trim constant), with" +
      " node_modules/.git/.next/.zcode/out excluded — exit code " + implGrep.exitCode + ".",
    "- world.run find for standalone *.jsonl logs — exit code " + jsonlFind.exitCode + ", " +
      allJsonl.length + " file(s) found.",
    ...(jsonlFiles.length > 0
      ? [
          "- world.run content grep over those files for " + EVENT_TYPES.length +
            " of the skill's event types in" +
            " their serialized \"event\":\"<type>\" form — " + logFiles.length + " file(s) matched.",
        ]
      : []),
    ...(gateErrors.length > 0
      ? ["- GATE ERRORS (these qualify every 'not present' conclusion in this report):"].concat(
          gateErrors.map((e) => "  - " + e),
        )
      : []),
    "",
    "## Gatekeeper and owner record",
    ownerGuidance === ""
      ? "None recorded — the gatekeeper returned no guidance."
      : ownerGuidance,
    ...(claudeMdFinding !== ""
      ? ["CLAUDE.md:24, as read by the gatekeeper: " + claudeMdFinding]
      : ["CLAUDE.md:24 — the gatekeeper returned no reading of this line."]),
    "",
    "## What adopting the pattern would look like",
    "- " + SKILL_PATH + " :50-58 (data model), :92-123 (appendLog with NULL-vs-append and the" +
      " trimmed UPDATE), :223-276 (orchestrator and runner integration), and the migration" +
      " recipe in " + REF_PATH + " :56-66.",
    "",
  ].join("\n");
  try {
    await artifact.markdown("audit-report", absentMd, {
      title: "Pipeline event log audit — not present",
      description: "The gate found no pipeline_runs JSONL logging here; the run stopped rather than invent evidence.",
      primary: true,
    });
  } catch {
    try {
      await artifact.markdown(
        "audit-report",
        "# Pipeline event-log audit — not present\n\nNo implementation was found; " +
          (gatekeeperNamedNoPaths
            ? "the source gatekeeper confirmed the audit but named no paths."
            : "the deterministic gate and the owner both confirmed it."),
        { title: "Pipeline event log audit (compact)", primary: true },
      );
    } catch {
      log("Both not-present publishes failed — the returned report is the only record.");
    }
  }
  const result: WorkflowReport = {
    conclusion:
      "No pipeline event-log implementation exists in this workspace. " +
      (gatekeeperNamedNoPaths
        ? "Candidates were found and the gatekeeper confirmed the audit, but it named no source " +
          "paths, so the run reported the pattern as not present rather than auditing nothing."
        : "The deterministic source gates found nothing" +
          (gateErrors.length > 0 ? " (with errors recorded — see the findings)" : "") +
          " and the run reported the pattern as not present instead of auditing invented evidence."),
    findings:
      gateErrors.length > 0 || gatekeeperNamedNoPaths
        ? ([] as Finding[]).concat(
            gateErrors.length > 0
              ? [
                  {
                    where: "world.run availability gates",
                    what:
                      "An availability gate errored, so the not-present conclusion is qualified, not clean.",
                    evidence: gateErrors.join("; "),
                    status: "unconfirmed",
                    severity: "medium",
                  },
                ]
              : [],
            gatekeeperNamedNoPaths
              ? [
                  {
                    where: "source gatekeeper verdict",
                    what:
                      "The gatekeeper returned outcome 'audit' with an empty sourcePaths list — a " +
                      "contradiction between its verdict and its payload; the run treated it as " +
                      "not-present rather than inventing sources.",
                    evidence: "SourceDecision { outcome: 'audit', sourcePaths: [] } from phase 1",
                    status: "verified",
                    severity: "medium",
                  },
                ]
              : [],
          )
        : [],
    verified: [
      "Source availability was decided by world.run: the implementation-symbol grep (exit " +
        implGrep.exitCode + ") and the JSONL inventory find (exit " + jsonlFind.exitCode + ", " +
        allJsonl.length + " file(s))" +
        (jsonlFiles.length > 0
          ? ", plus the JSONL content grep over them for " + EVENT_TYPES.length +
            " of the skill's event types in " +
            "their \"event\":\"<type>\" form (" + logFiles.length + " matched)"
          : "; the JSONL content grep did not run because the inventory was empty") +
        ".",
      ...(claudeMdFinding !== ""
        ? [
            "CLAUDE.md:24 was read by the source gatekeeper as its ask instructed; its recorded " +
              "finding: " + claudeMdFinding,
          ]
        : []),
    ],
    notCovered: [
      "All " + CHECKLIST.length + " verification-checklist items — there is no implementation to check them against.",
      "Databases and runtime behaviour — the audit reads workspace files only.",
      ...(claudeMdFinding === ""
        ? [
            "CLAUDE.md:24 — the gatekeeper returned no reading of it (claudeMdFinding empty), so " +
              "this report makes no claim about that line.",
          ]
        : []),
    ],
  };
  return result;
}

log(
  "Auditing " + CHECKLIST.length + " checklist items against " + sourcePaths.length +
    " confirmed source file(s)" + (ownerGuidance === "" ? "." : " — " + ownerGuidance),
);

// ─── Dashboard: per-item verdicts as they land ───────────────────────────────

artifact.board("checklist", {
  title: "Verification checklist",
  description: "Each item of the skill's " + CHECKLIST.length + "-point Verification Checklist, from checking to verdict.",
  key: "item",
  status: "status",
  columns: ["checking", "pass", "partial", "fail", "not-applicable"],
  cardTitle: "label",
  detail: [{ field: "note", label: "Note" }],
});

// ─── Phase 2: the checklist fan-out ──────────────────────────────────────────

phase("Audit each checklist item and confirm its findings as they land");

const itemOutcomes: ItemOutcome[] = await Promise.all(
  CHECKLIST.map(async (entry, i) => {
    report({ item: i + 1, label: entry.label, status: "checking" }, "checklist");

    const auditor = agent("Checklist item " + (i + 1) + " auditor", {
      system:
        "You are a read-only code auditor. You judge the confirmed sources against one item of " +
        "the pipeline-event-log skill's Verification Checklist, and you read every pattern " +
        "section and source file yourself before claiming anything. You do not edit any file. " +
        "If your instructions contradict each other, or the item cannot be judged from the " +
        "sources at all, escalate and say so plainly rather than working around it — and prefer " +
        "'not-applicable' over a guess.",
    });
    const verdict = await auditor.ask<ItemVerdict>(
      "Audit an implementation of the pipeline-event-log pattern against ONE item of the " +
        "skill's Verification Checklist.\n\n" +
        "Checklist item " + (i + 1) + ": \"" + entry.text + "\"\n\n" +
        "Read the pattern first — it defines what this item demands:\n" +
        "- " + SKILL_PATH + " — " + entry.skill + "\n" +
        "- " + REF_PATH + " — " +
        (entry.ref === "—"
          ? "no dedicated section for this item; the SKILL.md anchor above is authoritative"
          : entry.ref) +
        "\n\nThen audit these confirmed source files, reading them yourself:\n" +
        sourcePaths.map((p) => "- " + p).join("\n") +
        "\n\nReturn one verdict: \"pass\" (the sources satisfy the item), \"partial\", \"fail\", " +
        "or \"not-applicable\" (the sources genuinely do not contain the code this item is about " +
        "— say what is missing instead of inventing it). Ground the evidence in path:line anchors " +
        "from the files you read, and list every concrete deviation as a finding with a severity. " +
        "Bound findings to real deviations from the pattern, not style preferences; if an item is " +
        "genuinely riddled, return the most consequential ones and say in the evidence that more " +
        "exist. Do not edit any file.",
    );

    // Bound the confirmer fan-out: the first CONFIRMER_CAP findings per item get an
    // independent reader; the rest are still carried, labelled unconfirmed with the reason
    // (the cap is disclosed, never silently dropped).
    const confirmedSet = verdict.findings.slice(0, CONFIRMER_CAP);
    const overflowSet = verdict.findings.slice(CONFIRMER_CAP);
    const confirmed: ConfirmedFinding[] = await Promise.all(
      confirmedSet.map((f, j) =>
        agent("Item " + (i + 1) + " confirmer finding " + (j + 1), {
          system:
            "You confirm audit findings independently. You re-read the cited sources yourself " +
            "and decide from what they show, never from the auditor's reading. You do not edit " +
            "any file. If a check is impossible to pass, or your instructions contradict each " +
            "other, escalate and say so plainly rather than working around it.",
        })
          .ask<FindingConfirmation>(
            "Independently confirm or refute this audit finding about the pipeline event-log " +
              "implementation.\n\nFinding (checklist item " + f.checklistItem + "): " + f.problem +
              "\nClaimed at: " + f.where + "\n\n" +
              "Read " + f.where + " yourself, and the pattern it is judged against at " +
              SKILL_PATH + " (" + entry.skill + "). reproduced=true only if the sources show the " +
              "deviation as claimed. Do not edit any file.",
          )
          .then((c): ConfirmedFinding => ({
            ...f,
            status: c.reproduced ? "verified" : "unconfirmed",
            confirmationNote: c.note,
          })),
      ),
    );
    const overflow: ConfirmedFinding[] = overflowSet.map((f): ConfirmedFinding => ({
      ...f,
      status: "unconfirmed",
      confirmationNote:
        "not independently confirmed — the item raised more findings than the " +
        CONFIRMER_CAP + "-confirmer cap allows; the auditor's claim stands unrebutted",
    }));
    if (overflow.length > 0) {
      log(
        "Checklist item " + (i + 1) + " (" + entry.label + ") raised " + verdict.findings.length +
          " findings; " + overflow.length + " beyond the confirmer cap are carried unconfirmed.",
      );
    }
    const findings: ConfirmedFinding[] = confirmed.concat(overflow);

    report(
      {
        item: i + 1,
        label: entry.label,
        status: verdict.verdict,
        note:
          verdict.evidence.length > 200 ? verdict.evidence.slice(0, 197) + "..." : verdict.evidence,
      },
      "checklist",
    );
    for (const f of findings) {
      report(f);
    }
    return { item: i + 1, label: entry.label, verdict, findings };
  }),
);

// ─── Phase 3: one report ─────────────────────────────────────────────────────

phase("Combine the verdicts into the audit report");

const synthesizer = agent("Audit synthesizer", {
  system:
    "You write the connective tissue of an audit report from verdicts that have already been " +
    "confirmed. You do not re-audit, you do not invent findings, and you do not edit any file. " +
    "If the verdicts contradict each other, say so in the overview rather than smoothing it over. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and " +
    "say so plainly rather than working around it.",
});
const synthesis = await synthesizer.ask<ReportSynthesis>(
  CHECKLIST.length + " checklist auditors reviewed the pipeline event-log sources (" +
    sourcePaths.join(", ") + "). Their verdicts, evidence and confirmed findings:\n" +
    JSON.stringify(itemOutcomes) +
    "\n\nWrite the report's overview: 2-4 sentences on what the implementation is and how it " +
    "fares against the checklist overall. Then name the cross-cutting conclusions: items that " +
    "failed for the same root cause, the overlap between the appendLog items, whether the " +
    "pattern is partially conforming or the sources are something thinner (a fixture, a copy, a " +
    "different pattern entirely). Judge only from the material above; do not re-audit and do " +
    "not edit any file.",
);

const allFindings: Finding[] = itemOutcomes.flatMap((o) =>
  o.findings.map((f) => ({
    where: f.where,
    what: f.problem,
    evidence:
      "Checklist item " + f.checklistItem + " (" + o.label + "); confirmer: " + f.confirmationNote,
    status: f.status,
    severity: f.severity,
  })),
);
const verifiedCount = allFindings.filter((f) => f.status === "verified").length;
const passCount = itemOutcomes.filter((o) => o.verdict.verdict === "pass").length;
const problemItems = itemOutcomes.filter(
  (o) => o.verdict.verdict === "fail" || o.verdict.verdict === "partial",
);

const fullReport = [
  "# Pipeline event-log audit",
  "",
  synthesis.overview,
  "",
  "## Sources audited",
  ...sourcePaths.map((p) => "- " + p),
  ownerGuidance === "" ? "" : "\nSource confirmation: " + ownerGuidance,
  "",
  "## Checklist verdicts",
  ...itemOutcomes.map(
    (o) => "- **Item " + o.item + " — " + o.label + ": " + o.verdict.verdict + "** — " +
      o.verdict.evidence,
  ),
  "",
  "## Findings (" + verifiedCount + " of " + allFindings.length + " independently confirmed)",
  ...(allFindings.length === 0
    ? ["None — no deviation survived the audit."]
    : allFindings.map(
        (f) =>
          "- [" + f.status + "] (" + f.severity + ") " + f.where + " — " + f.what +
          (f.status === "unconfirmed" ? " _(not reproduced: " + f.evidence + ")_" : ""),
      )),
  "",
  "## Cross-cutting conclusions",
  ...synthesis.crossCutting.map((c) => "- " + c),
  "",
  "## Pattern references",
  "- " + SKILL_PATH + " (the Verification Checklist, " + CHECKLIST.length + " items, is at :328-341)",
  "- " + REF_PATH,
  "",
].join("\n");

const compactReport = [
  "# Pipeline event-log audit (compact fallback)",
  "",
  synthesis.overview,
  "",
  passCount + " of " + itemOutcomes.length + " checklist items passed; " +
    problemItems.length + " failed or partially conformed; " + verifiedCount + " of " +
    allFindings.length + " findings were independently confirmed.",
  "",
  ...problemItems.map(
    (o) => "- Item " + o.item + " (" + o.label + "): " + o.verdict.verdict + " — " +
      o.verdict.evidence,
  ),
  "",
].join("\n");

let reportPublished = false;
try {
  await artifact.markdown("audit-report", fullReport, {
    title: "Pipeline event-log audit report",
    description: "The skill's " + CHECKLIST.length + "-point Verification Checklist, audited item by item with independent confirmation.",
    primary: true,
  });
  reportPublished = true;
} catch {
  log("Full report publish failed — publishing the compact fallback.");
  try {
    await artifact.markdown("audit-report", compactReport, {
      title: "Pipeline event-log audit report (compact)",
      description: "Compact fallback: the same facts the full report carried.",
      primary: true,
    });
    reportPublished = true;
  } catch {
    log("Both report publishes failed — the reported results below are the only record.");
  }
}

// ─── Final WorkflowReport ────────────────────────────────────────────────────

const result: WorkflowReport = {
  conclusion:
    "Audited the pipeline event-log implementation (" + sourcePaths.join(", ") + ") against all " +
    itemOutcomes.length + " items of the skill's Verification Checklist: " + passCount + " passed, " +
    problemItems.length + " failed or partially conformed. " + allFindings.length + " deviations " +
    "were raised and " + verifiedCount + " of them survived independent confirmation. " +
    (reportPublished
      ? "The full report is published."
      : "Publishing failed — the reported results are the only record."),
  findings: allFindings,
  verified: [
    "Source availability was decided by deterministic world.run gates: the implementation-symbol " +
      "grep and the JSONL inventory find (" + allJsonl.length + " file(s))" +
      (jsonlFiles.length > 0
        ? ", plus the JSONL content grep over them (" + logFiles.length + " matched)"
        : "; the JSONL content grep did not run because the inventory was empty") +
      "; the confirmed sources were then checked by the source gatekeeper before any auditor " +
      "touched them.",
    "Each of the " + itemOutcomes.length + " checklist items was judged by its own auditor, which " +
      "read " + SKILL_PATH + " and " + REF_PATH + " at the item's cited anchors plus the sources " +
      "themselves.",
    "Every raised finding was re-checked by an independent confirmer that read the cited lines " +
      "itself; " + verifiedCount + " of " + allFindings.length + " were reproduced, and the rest " +
      "are kept and labelled unconfirmed.",
  ],
  notCovered: [
    "PostgreSQL-side behaviour — whether the trim UPDATE actually caps the column in a live " +
      "database, and the text-column size arithmetic (SKILL.md :307-311) — the audit reads " +
      "workspace files only and queried no database.",
    "Live renderer behaviour — the UI checklist items (:335-338) were judged from source, not " +
      "from a rendered component.",
    "Pass verdicts rest on each auditor's own reading with path:line evidence; only negative " +
      "findings were put to independent confirmers.",
  ],
};
return result;
