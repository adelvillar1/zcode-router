/* zcode-workflow
description: "Triages a data bug end to end: reproduces from the bug report,
  verifies data prerequisites and xlsx row gates via the skill's own scripts,
  audits six data-integrity categories against the database, confirms the root
  cause independently, implements the fix with a human approval gate before any
  data write, and publishes a triage report. Embodies the data-triage skill."
whenToUse: When data is wrong or a data-shaped bug needs reproducing,
  root-causing, and fixing with a human approval gate before writes. Needs a
  reachable database for the audit stages.
args:
  bugReport:
    type: json
    description: "The bug report context: what is wrong, where, and any error text."
    required: true
  pageOrEndpoint:
    type: string
    description: The user-facing page or endpoint that misbehaves.
    required: false
  sourceFile:
    type: string
    description: The source file or export suspected, for prerequisite checks.
    required: false
  stagingEndpoint:
    type: string
    description: Staging endpoint to verify against, when one exists.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */

// Data-triage workflow
// Embodies the 10-step data-triage procedure from
// ~/.agents/skills/data-triage/SKILL.md as user-named phases
// with parallel subagents, independent review, bounded loops,
// deterministic gates via world.run, and a WorkflowReport return.

// --- Result types ---

interface Reproduction {
  /** What the user sees on the page */
  userView: string;
  /** What the API returns */
  apiOutput: string;
  /** What the database has */
  dbState: string;
  /** Whether the bug was successfully reproduced */
  reproduced: boolean;
}

interface ApiVerification {
  /** Each field the user complained about, checked */
  fieldChecks: { field: string; expected: string; actual: string }[];
  /** Whether the API output matches what the page shows */
  matchesPage: boolean;
}

interface DbVerification {
  /** Raw SQL query results */
  queryResults: string;
  /** What the source-of-truth tables actually contain */
  sourceOfTruth: string;
}

interface Divergence {
  /** The exact records where API and DB disagree */
  disagreeingRecords: string[];
  /** Likely root causes from the skill's patterns */
  rootCauses: string[];
  /** The pre-computed source involved (MV, cache, derived table) */
  precomputedSource: string;
}

interface DeployedAnalysis {
  /** Differences between local and deployed code */
  differences: string[];
  /** Where the bug lives in the deployed code */
  bugLocation: string;
}

interface FalsePositiveCheck {
  /** Source file path */
  sourceFile: string;
  /** Source row count */
  sourceRows: number;
  /** DB row count */
  dbRows: number;
  /** Match count (rows that match between source and DB) */
  matchCount: number;
  /** Distribution analysis: distinct, min/max, gap count, sorted head */
  distribution: string;
  /** Whether this is a false positive */
  isFalsePositive: boolean;
}

interface AuditCategory {
  /** Category name from the skill */
  name: string;
  /** Findings from the audit queries */
  findings: string[];
  /** Number of damaged records found */
  damageCount: number;
}

interface FixOutcome {
  /** What data was fixed (MV refresh, backfill, etc.) */
  dataFix: string;
  /** Whether the data fix was applied */
  applied: boolean;
  /** What fallback was added */
  fallback: string;
  /** Files modified */
  filesModified: string[];
  /** Whether the fallback was added */
  added: boolean;
}

interface StagingVerification {
  /** The endpoint tested */
  endpoint: string;
  /** The result */
  result: string;
  /** Whether the fix works for the user-reported case */
  userCasePassed: boolean;
  /** Whether the fix breaks other cases */
  otherCasesPassed: boolean;
  /** Overall pass/fail */
  passed: boolean;
}

interface Confirmation {
  /** True only when you reproduced the divergence yourself from the code and SQL — the finder does not get to confirm its own finding. */
  reproduced: boolean;
  /** What you did to check: the file you read, the query you ran, the output you saw. */
  note: string;
}

interface Finding {
  /** Where the problem is */
  where: string;
  /** What is wrong */
  what: string;
  /** Evidence */
  evidence: string;
  /** Verification status */
  status: "verified" | "unconfirmed";
  /** Severity */
  severity: "low" | "medium" | "high";
}

interface ApprovalSynthesis {
  /** Repair bundles, each naming the records it touches and the proposed repair */
  bundles: string[];
  /** What looks safe now vs what needs the data owner's judgement, and why */
  note: string;
}

interface ApprovalDecision {
  /** True only if the run owner explicitly approved at least one bundle */
  approved: boolean;
  /** Bundles the run owner answered yes to, verbatim from their reply */
  approvedBundles: string[];
  /** Bundles rejected by the owner, or left unapproved because nobody answered */
  rejectedBundles: string[];
  /** The owner's answer, or an explicit statement that no human approval was obtained */
  feedback: string;
}

interface TriageReport {
  /** Two or three sentences answering what the user asked for */
  conclusion: string;
  /** Findings from the investigation */
  findings: Finding[];
  /** What the run checked and how */
  verified: string[];
  /** What the run did not look at or could not check */
  notCovered: string[];
}

// --- Named inputs from the declared args block ---

const bugReport = typeof args.bugReport === "string" ? args.bugReport : JSON.stringify(args.bugReport ?? {});
const pageOrEndpoint = typeof args.pageOrEndpoint === "string" ? args.pageOrEndpoint : "";
const sourceFile = typeof args.sourceFile === "string" ? args.sourceFile : "";
const stagingEndpoint = typeof args.stagingEndpoint === "string" ? args.stagingEndpoint : "";

// --- Workflow ---

// Dashboard for the audit fan-out: one row per category as it lands.
// Declared before any phase; presets are top-level declarations.
artifact.table("audit-progress", {
  title: "Production data-integrity audit",
  key: "category",
  columns: [
    { field: "category", label: "Audit category" },
    { field: "damageCount", label: "Damaged records" },
  ],
});

phase("Reproduce what the user sees");

const reproduction = await agent("reproduction-investigator",
  "You reproduce data bugs by capturing exact user observations, API responses, and DB state. " +
  "The user's screenshot or description is the ground truth. " +
  "Cite path and line for every claim. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md step 1."
).ask<Reproduction>(
  `Reproduce this data bug. Capture exactly what the user sees, what the API returns, and what the database has. ` +
  `Bug report context: ${bugReport}. ` +
  `Page or endpoint: ${pageOrEndpoint || "NONE SUPPLIED"}. ` +
  `Follow the procedure in ~/.agents/skills/data-triage/SKILL.md step 1.`
);
report({ phase: "reproduce", ...reproduction });

// Deterministic gate on the USER-REPORTED endpoint. This is advisory by design: it
// feeds the report (reachable / not reachable) and nothing else — it must not gate
// any later work, because a page behind an auth wall or an internal-only URL is
// unreachable to curl while still being the surface the user saw. The staging
// endpoint is a different URL with its own gate in its own phase.
let apiGate: { exitCode: number; stdout: string; stderr: string } | undefined;
let endpointReachable = false;
if (pageOrEndpoint !== "") {
  try {
    apiGate = await world.run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", pageOrEndpoint], { timeoutMs: 30000 });
    endpointReachable = apiGate.exitCode === 0 && apiGate.stdout.trim() !== "000";
  } catch {
    endpointReachable = false;
  }
}

phase("Verify the API output and database state in parallel");

const [apiVerification, dbVerification] = await Promise.all([
  agent("api-verifier",
    "You verify tRPC/API output against what the page shows. " +
    "Check EACH data field the user is complaining about. " +
    "Note: local code may differ from deployed code. " +
    "Reference ~/.agents/skills/data-triage/SKILL.md step 2."
  ).ask<ApiVerification>(
    `Verify the API output. User sees: ${reproduction.userView}. API returned: ${reproduction.apiOutput}. ` +
    `Check each field. Reference ~/.agents/skills/data-triage/SKILL.md step 2.`
  ),

  agent("db-verifier",
    "You verify the database directly using raw SQL via $queryRaw. " +
    "Bypass application logic entirely. " +
    "Check the EXACT rows the API would be looking for. " +
    "Column naming: fields without @map are stored camelCase in PG and must be double-quoted. " +
    "See prisma/schema.prisma for the schema. " +
    "Reference ~/.agents/skills/data-triage/SKILL.md step 3 and references/production-data-integrity-audit.md."
  ).ask<DbVerification>(
    `Verify the database directly. Bug report: ${bugReport}. ` +
    `Page or endpoint: ${pageOrEndpoint || "NONE"}. ` +
    `Check the exact rows the API would be looking for. ` +
    `Reference ~/.agents/skills/data-triage/SKILL.md step 3.`
  )
]);
report({ phase: "api-db-verify", api: apiVerification, db: dbVerification });

// Hoisted so the re-confirm loop can reuse the same agent and accumulate context
// (patterns.md shape 3). A duplicate name would fail the whole run.
const divergenceAnalyzer = agent("divergence-analyzer",
  "You find the exact records where the API and DB disagree. " +
  "Common patterns: stale MV with wrong ID convention, missing MV rows, code path differs between dev and deployed, filter too strict, schema drift. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md step 4 and references/itinerary_port_conditions_mv_mismatch.md."
);

phase("Find the exact divergence between API and database");

const divergence = await divergenceAnalyzer.ask<Divergence>(
  `Find the divergence between API output and DB state. ` +
  `API verification: ${JSON.stringify(apiVerification)}. ` +
  `DB verification: ${JSON.stringify(dbVerification)}. ` +
  `Match records exactly and identify root causes. Reference ~/.agents/skills/data-triage/SKILL.md step 4.`
);
report({ phase: "divergence", ...divergence });

phase("Read the deployed code and compare with local");

const deployedAnalysis = await agent("deployed-code-reader",
  "You read deployed code via git show and compare with local code. " +
  "The divergence between deployed and local is often the bug. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md step 5 and references/itinerary_port_conditions_mv_mismatch.md."
).ask<DeployedAnalysis>(
  `Compare deployed code with local code. ` +
  `Divergence found: ${JSON.stringify(divergence)}. ` +
  `Use git show <deployed-commit>:path/to/file.ts to see what production actually runs. ` +
  `Find where they diverge. Reference ~/.agents/skills/data-triage/SKILL.md step 5.`
);
report({ phase: "deployed", ...deployedAnalysis });

phase("Rule out false positives using source-of-truth comparison");

// The skill's first rule: a data-bug report can be 100% perception — the stored
// data is correct but its *shape* mimics the bug. Rule it out before touching code
// or data. The check needs the source-of-truth input; the DB alone cannot disprove
// "the import mangled it". When a source file is supplied, xlsx_rows.py is the
// deterministic reader; the checker subagent then compares and characterizes the
// distribution. When no source is supplied the check is inconclusive and we say so.
let xlsxGate: { exitCode: number; stdout: string; stderr: string } | undefined;
if (sourceFile !== "") {
  try {
    xlsxGate = await world.run(
      "python3",
      [
        "/Users/alejandrodelvillar/.agents/skills/data-triage/scripts/xlsx_rows.py",
        sourceFile,
        "--json",
      ],
      { timeoutMs: 30000 }
    );
  } catch {
    // world.run itself could not execute — fall back to handing the subagent the path.
    xlsxGate = undefined;
  }
}

const falsePositiveResult = await agent("false-positive-checker",
  "You rule out false positives by comparing the source-of-truth input against stored data. " +
  "Key on the full identity tuple, not name-only — name-keying hides duplicate-source rows. " +
  "Report match counts and explain every delta. " +
  "Characterize the distribution: distinct count, min/max, gap count, sorted head. " +
  "Sequential-looking head + gaps elsewhere + max >> count = canonical data; " +
  "auto-assignment gives count == distinct == max with zero gaps. " +
  "If no source file is available you cannot disprove 'the import mangled it' — set " +
  "isFalsePositive=false and say in distribution that the check was inconclusive. " +
  "If xlsx_rows.py output is too large or unavailable, run scripts/xlsx_rows.py yourself " +
  "or work from a capped excerpt of the source file; do not paste the whole file into this ask. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md (Rule out the false positive section) " +
  "and references/canonical-numbers-look-sequential.md."
).ask<FalsePositiveCheck>(
  `Rule out the false positive. ` +
  `Source file: ${sourceFile === "" ? "NONE SUPPLIED — report inconclusive" : sourceFile}. ` +
  (sourceFile === ""
    ? `xlsx_rows.py was not run. `
    : `xlsx_rows.py exit: ${xlsxGate ? xlsxGate.exitCode : "could not run"}. ` +
      (xlsxGate && xlsxGate.exitCode === 0
        ? `Use a capped excerpt or run scripts/xlsx_rows.py yourself; do not paste the whole JSON here.`
        : `stderr: ${xlsxGate?.stderr ?? "none"}. Run scripts/xlsx_rows.py yourself or read the file directly.`)) +
  `Stored DB state (source-of-truth): ${dbVerification.sourceOfTruth}. ` +
  `Compare row-by-row and report match counts; explain every delta. ` +
  `Then characterize the distribution.`
);
falsePositiveResult.sourceFile = sourceFile;
report({ phase: "false-positive", ...falsePositiveResult });

if (falsePositiveResult.isFalsePositive) {
  // STOP. Fix nothing. Present the evidence table + distribution explanation.
  // The surface the user names may reveal a different real issue.
  const fpReport: TriageReport = {
    conclusion: `This is a false positive. Source has ${falsePositiveResult.sourceRows} rows, ` +
      `DB has ${falsePositiveResult.dbRows} rows, ${falsePositiveResult.matchCount} match. ` +
      `Distribution: ${falsePositiveResult.distribution}. The stored data is correct; ` +
      `its shape mimics the bug. Nothing was fixed — ask the user where they saw the symptom.`,
    findings: [],
    verified: [
      sourceFile === "" ? "false-positive check inconclusive (no source file)" : `xlsx_rows.py ran on ${sourceFile}`,
      "source-vs-DB row-by-row comparison",
      "distribution analysis",
    ],
    notCovered: ["no data fix applied — false positive, per the skill's STOP rule"],
  };

  const fpMarkdown = [
    `# Data Triage Report: False Positive`,
    ``,
    `**Verdict:** this is a false positive — no code or data was changed.`,
    ``,
    `Source file: ${falsePositiveResult.sourceFile || "none"}`,
    `Source rows: ${falsePositiveResult.sourceRows}`,
    `DB rows: ${falsePositiveResult.dbRows}`,
    `Match count: ${falsePositiveResult.matchCount}`,
    ``,
    `## Distribution analysis`,
    falsePositiveResult.distribution,
    ``,
    `## Next step`,
    fpReport.conclusion,
  ].join("\n");
  // Same repair-republish idiom as the main path: a rejected publish must not end the
  // run without its deliverable.
  try {
    await artifact.markdown("triage-report", fpMarkdown, {
      title: "Data Triage Report: False Positive",
      description: "Evidence table + distribution explanation for a disproven bug report.",
      primary: true,
    });
  } catch {
    log("artifact.markdown rejected the false-positive report — republishing a minimal version");
    await artifact.markdown("triage-report", [
      `# Data Triage Report: False Positive`,
      ``,
      fpReport.conclusion,
      ``,
      `Source: ${falsePositiveResult.sourceFile || "none"} — ${falsePositiveResult.sourceRows} rows, ` +
      `${falsePositiveResult.dbRows} DB rows, ${falsePositiveResult.matchCount} matched.`,
    ].join("\n"), {
      title: "Data Triage Report: False Positive",
      description: "Minimal fallback: full report exceeded the artifact cap.",
      primary: true,
    });
  }

  return fpReport;
}

// §10: the subagent that found the divergence does not get to confirm it. A fresh
// confirmer reads the code the data path uses and runs the skill's diagnostic SQL
// itself, trying to refute the finding. Both the repair approval and the fix rest on
// this, so the check is spent here — before a human is asked to approve a write and
// before any data or code is touched — where a wrong claim is expensive.
// When the confirmer cannot reproduce, the divergence-analyzer gets one revision in
// light of the refutation and we re-check; bounded to MAX_RECONFIRM rounds so an
// ambiguous bug cannot loop forever, and the outcome is labelled, not hidden.
phase("Independently confirm the root cause before touching data or code");

const MAX_RECONFIRM = 3;
let rootCause: Confirmation = { reproduced: false, note: "not yet checked" };
let rootCauseStatus: "verified" | "unconfirmed" = "unconfirmed";
let divergenceForFix = divergence;

for (let reconfirmRound = 1; reconfirmRound <= MAX_RECONFIRM; reconfirmRound++) {
  // Each round gets its own actor: a literal name inside a loop is the duplicate
  // case the compiler rejects, and a fresh confirmer per round is the point —
  // independence, not a reviewer anchored to its own earlier refutation.
  rootCause = await agent("root-cause-confirmer-" + reconfirmRound,
    "You independently confirm a data-bug root cause. Read the code the data path uses " +
    "and run the skill's diagnostic SQL yourself to reproduce the divergence. Do NOT edit " +
    "any file and do NOT fix anything. If you cannot reproduce it, say so plainly. " +
    "Reference ~/.agents/skills/data-triage/SKILL.md (diagnostic SQL patterns) and " +
    "references/itinerary_port_conditions_mv_mismatch.md."
  ).ask<Confirmation>(
    // The round number is inherent to the item; the cap stays in the loop condition
    // (§13: a tunable interpolated into an ask rewrites the prompt and forfeits its cache).
    `Round ${reconfirmRound}. Reproduce this divergence from the code and SQL alone — do not trust the finder's word.\n` +
    `Divergence: ${JSON.stringify(divergenceForFix)}.\n` +
    `API verification: ${JSON.stringify(apiVerification)}.\n` +
    `DB verification: ${JSON.stringify(dbVerification)}.\n` +
    `Deployed analysis: ${JSON.stringify(deployedAnalysis)}.`
  );
  rootCauseStatus = rootCause.reproduced ? "verified" : "unconfirmed";
  // The second (tag) argument must be a compile-time literal, so items from inside
  // a loop are untagged and carry their discriminator as ordinary data fields.
  report({ kind: "root-cause-confirmation", round: reconfirmRound, of: MAX_RECONFIRM, ...rootCause });

  if (rootCause.reproduced) {
    break;
  }

  if (reconfirmRound < MAX_RECONFIRM) {
    // Give the original finder one revision in light of the refutation.
    // Reuse the hoisted divergenceAnalyzer so context accumulates (patterns.md shape 3).
    divergenceForFix = await divergenceAnalyzer.ask<Divergence>(
      `Your divergence was NOT reproduced by an independent confirmer.\n` +
      `Confirmer note: ${rootCause.note}\n` +
      `Revise the divergence analysis using the same evidence. ` +
      `Return updated disagreeingRecords, rootCauses, and precomputedSource.`
    );
    report({ kind: "divergence-revision", round: reconfirmRound, ...divergenceForFix });
    log(`root cause NOT reproduced in round ${reconfirmRound}; divergence-analyzer revised the finding`);
  }
}

if (!rootCause.reproduced) {
  log(`root cause still NOT reproduced after ${MAX_RECONFIRM} rounds: ${rootCause.note} — continuing, but every later artefact labels it unconfirmed`);
}

phase("Run the production data-integrity audit in parallel");

// Failure-isolated fan-out: one rejection must not kill the whole audit.
// patterns.md shape 10: catch inside the callback or use Promise.allSettled.
// We use allSettled so one bad category costs one category, and we report
// failures individually so they are not lost.
const auditSubagents = [
  { name: "audit-live-children", category: "Parents with live children but missing derived data", queryRef: "category 1" },
  { name: "audit-dangling-children", category: "Dangling children on soft-deleted parents", queryRef: "category 2" },
  { name: "audit-soft-deleted-owners", category: "Children referencing soft-deleted owners", queryRef: "category 3" },
  { name: "audit-duplicates", category: "Duplicate active records", queryRef: "category 4" },
  { name: "audit-derived-mismatches", category: "Derived-field mismatches", queryRef: "category 5" },
  { name: "audit-cross-tenant", category: "Cross-tenant leaks", queryRef: "category 6" },
];

const auditSettled = await Promise.allSettled(
  auditSubagents.map(async (audit) => {
    const outcome = await agent(audit.name,
      `You run read-only audit queries for the "${audit.category}" category. ` +
      `All queries are read-only; run them against the real environment's DB. ` +
      `The skill's reference (production-data-integrity-audit.md) uses Trip-Ledger table names ` +
      `(bookings, commission_checks, commission_check_items, agent_payments, users). ` +
      `Map those names onto THIS repo's actual table and column names in prisma/schema.prisma ` +
      `before running any query — do not run the literal Trip-Ledger SQL. ` +
      `Reference ~/.agents/skills/data-triage/references/production-data-integrity-audit.md ${audit.queryRef}.`
    ).ask<AuditCategory>(
      `Run the ${audit.category} audit. ` +
      `Use the read-only queries from ~/.agents/skills/data-triage/references/production-data-integrity-audit.md. ` +
      `Report findings and damage count.`
    );
    report({ category: audit.category, ...outcome }, "audit-progress");
    return outcome;
  })
);

const auditResults: AuditCategory[] = [];
const auditFailures: { name: string; reason: string }[] = [];
for (const settled of auditSettled) {
  if (settled.status === "fulfilled") {
    auditResults.push(settled.value);
  } else {
    auditFailures.push({ name: settled.reason.message ?? "unknown", reason: String(settled.reason) });
  }
}
for (const failure of auditFailures) {
  report({ phase: "audit-failure", ...failure });
}

phase("Present audit findings and obtain explicit per-bundle approval before any write");

// references/production-data-integrity-audit.md:91 — "Present findings first... get
// explicit per-bundle approval". Approval has to come from the person who owns the
// data, so the approver's job is to PUT THE BUNDLES TO THE RUN OWNER: the facade's
// designed channel for that is subagent escalation (SKILL.md §14), which reaches the
// run owner mid-run and waits. A second model agreeing with the first is only a
// pre-screen, so it is not what authorizes a write here.
const approvalSynthesist = agent("approval-synthesist",
  "You synthesize production audit findings into repair bundles for an approver. " +
  "Group related records, explain the risk of each bundle, and keep read-only queries read-only. " +
  "Reference ~/.agents/skills/data-triage/references/production-data-integrity-audit.md (Repair discipline)."
);
const approvalSynth = await approvalSynthesist.ask<ApprovalSynthesis>(
  `Synthesize these audit results into repair bundles the data owner can say yes/no to. ` +
  `Audit results: ${JSON.stringify(auditResults)}. ` +
  `Audit failures (categories that could not run): ${JSON.stringify(auditFailures)}. ` +
  `Return the bundles plus a short note on what is safe to repair now vs what needs human judgement.`
);
report({ phase: "approval-synthesis", ...approvalSynth });
const approval = await agent("repair-approver",
  "You are the gate between audit findings and any production write. " +
  "You never edit files and never run write commands. " +
  "Per ~/.agents/skills/data-triage/references/production-data-integrity-audit.md:91 the approval " +
  "must be the data owner's explicit yes, bundle by bundle — your own judgement is only a " +
  "pre-screen and never authorizes a write. " +
  "For every bundle you consider safe, escalate (using your escalate tool) to the run owner with " +
  "the bundle's records, the proposed repair, and its risk, and wait for their answer. " +
  "Record only an explicit owner yes in approvedBundles; put everything else — owner no, owner " +
  "unreachable, unanswered, or a bundle you pre-screened out — in rejectedBundles with the reason. " +
  "If you cannot reach the owner, return approved=false and say plainly that no human approval was obtained. " +
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it."
).ask<ApprovalDecision>(
  `Pre-screen these bundles, then get the run owner's explicit per-bundle approval by escalation. ` +
  `Bundles: ${JSON.stringify(approvalSynth.bundles)}. ` +
  `Note from synthesist: ${approvalSynth.note}. ` +
  `Root-cause status the owner must be told before answering: ${rootCauseStatus} — ` +
  `${rootCause.reproduced ? `independently reproduced: ${rootCause.note}` : `NOT reproduced by an independent confirmer: ${rootCause.note}`}. ` +
  `Escalate with the bundle list, that status, and a yes/no request for each bundle. ` +
  `Return approvedBundles = ONLY bundles the owner explicitly approved (quote their reply in feedback), ` +
  `rejectedBundles = everything else with the reason.`
);
report({ phase: "approval", ...approval });

if (!approval.approved || approval.approvedBundles.length === 0) {
  log(`No repair bundles were approved (${approval.rejectedBundles.length} rejected). Stopping before writes.`);
  const noApprovalReport: TriageReport = {
    conclusion: `Audit findings are present, but no repair bundle received the data owner's explicit approval ` +
      `(${approval.rejectedBundles.length} rejected or unanswered). No data or code was changed. Feedback: ${approval.feedback}`,
    findings: [],
    verified: [
      `Reproduced: ${reproduction.reproduced}`,
      `API/DB checked by separate verifiers (raw SQL for the DB)`,
      `Root cause ${rootCauseStatus} by an independent confirmer: ${rootCause.note}`,
      `Audit: ${auditResults.length} categories ran, ${auditFailures.length} failed`,
      `Approval: no human yes obtained — approver's report: ${approval.feedback}`,
    ],
    notCovered: ["no fix applied — explicit owner approval was not obtained", ...auditFailures.map((f) => `audit category failed: ${f.name}`)],
  };
  const noApprovalMarkdown = [
    `# Data Triage Report: No Approval Granted`,
    ``,
    `**Outcome:** no repair bundle received the data owner's explicit approval; no data or code was changed.`,
    ``,
    `## Approved bundles (owner yes)`,
    approval.approvedBundles.length === 0 ? "none" : approval.approvedBundles.join("\n"),
    ``,
    `## Rejected or unanswered bundles`,
    approval.rejectedBundles.length === 0 ? "none" : approval.rejectedBundles.join("\n"),
    ``,
    `## Approver / owner feedback`,
    approval.feedback,
  ].join("\n");
  // Same repair-republish idiom as the main path: a rejected publish must not end the
  // run without its deliverable.
  try {
    await artifact.markdown("triage-report", noApprovalMarkdown, {
      title: "Data Triage Report",
      description: "No fix applied — explicit owner approval not obtained.",
      primary: true,
    });
  } catch {
    log("artifact.markdown rejected the no-approval report — republishing a minimal version");
    await artifact.markdown("triage-report", [
      `# Data Triage Report: No Approval Granted`,
      ``,
      noApprovalReport.conclusion,
      ``,
      `Approved: ${approval.approvedBundles.length} · Rejected/unanswered: ${approval.rejectedBundles.length}`,
    ].join("\n"), {
      title: "Data Triage Report",
      description: "Minimal fallback: full report exceeded the artifact cap.",
      primary: true,
    });
  }
  return noApprovalReport;
}

phase("Fix the data and add a defensive fallback for approved bundles only");

const fixResult = await agent("fix-implementer",
  "You fix data bugs and add defensive fallbacks. " +
  "Apply ONLY the approved bundles below. " +
  "The data fix refreshes the materialized view (use REFRESH MATERIALIZED VIEW CONCURRENTLY " +
  "with work_mem set high) or runs a backfill/recompute. " +
  "The defensive fallback queries source-of-truth tables when the pre-computed path misses. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md step 6 and the defensive fallback pattern section. " +
  "Also reference the derived-field recompute rule for delete handlers and " +
  "~/.agents/skills/data-triage/references/itinerary_port_conditions_mv_mismatch.md for the worked fix. " +
  "If any approved bundle is impossible to apply safely, escalate and say so plainly rather than working around it."
).ask<FixOutcome>(
  `Apply ONLY these approved bundles: ${JSON.stringify(approval.approvedBundles)}. ` +
  `Divergence: ${JSON.stringify(divergenceForFix)}. ` +
  `Root-cause status after independent confirmation: ${rootCauseStatus}. ` +
  (rootCause.reproduced
    ? `A fresh confirmer reproduced the divergence: ${rootCause.note}. `
    : `WARNING — after the confirmation rounds an independent confirmer could NOT reproduce this ` +
      `divergence; its last note: ${rootCause.note}. Treat the root cause as unconfirmed: apply only ` +
      `reversible, owner-approved data repairs, keep the defensive fallback narrow, and state in your ` +
      `report that the root cause was never reproduced. If an unconfirmed root cause makes a bundle ` +
      `unsafe to apply, escalate instead of guessing. `) +
  `Deployed analysis: ${JSON.stringify(deployedAnalysis)}. ` +
  `Audit results: ${JSON.stringify(auditResults)}. ` +
  `Run the MV refresh, backfill, or recompute yourself, then implement the defensive fallback in code. ` +
  `Report what you applied and what fallback you added.`
);
report({ phase: "fix", ...fixResult });

phase("Verify the fix on staging");

let stagingGate: { exitCode: number; stdout: string; stderr: string } | undefined;
let stagingCurlRan = false;
if (stagingEndpoint !== "") {
  // The curl IS the reachability test for staging: run it whenever a staging
  // endpoint was supplied and hand the raw result to the verifier as a value.
  // A 000 HTTP code or nonzero exit means unreachable — the verifier's call,
  // not a script-level skip. (It must not be gated on the user-page gate above:
  // pageOrEndpoint and stagingEndpoint are different URLs, and one being
  // unreachable says nothing about the other.)
  try {
    stagingGate = await world.run("curl", ["-s", "-w", "\nHTTP:%{http_code}", stagingEndpoint], { timeoutMs: 30000 });
    stagingCurlRan = true;
  } catch {
    stagingGate = undefined; // curl itself could not run — staging not checked
  }
}

const stagingResult = await agent("staging-verifier",
  "You verify fixes on staging by curling the live endpoint. " +
  "Confirm the fix works for the user-reported case. " +
  "Confirm the fix doesn't break other cases (run a broader test). " +
  "Reference ~/.agents/skills/data-triage/SKILL.md step 7. " +
  "Report passed=false if you could not actually exercise the endpoint."
).ask<StagingVerification>(
  `Verify the fix on staging. ` +
  `Staging endpoint: ${stagingEndpoint === "" ? "NONE SUPPLIED — set passed=false and say staging was not checked" : stagingEndpoint}. ` +
  (stagingCurlRan
    ? `A deterministic curl of it exited ${stagingGate!.exitCode}; output (body plus trailing HTTP:<code>):\n${stagingGate!.stdout}\n` +
      `A 000 code or an error body means unreachable — set passed=false and say so. `
    : `No deterministic curl result — curl could not run; run your own curl against the endpoint now, and if that also fails set passed=false. `) +
  `User-reported case: ${reproduction.userView}. ` +
  `Confirm the fix works for that case and does not break other cases.`
);
report({ phase: "staging", ...stagingResult });

phase("Write the triage report and publish the deliverable");

const reportWriter = agent("report-writer",
  "You write data-triage reports for engineers. " +
  "Include reproduction, divergence analysis, root cause, fix applied, and verification results. " +
  "Be specific: cite paths, line numbers, SQL queries, and commands run. " +
  "Keep the report compact: summarize counts instead of dumping long record lists. " +
  "Reference ~/.agents/skills/data-triage/SKILL.md throughout."
);

const reportMarkdown = await reportWriter.ask<string>(
  `Write a data-triage report in markdown, in the order the triage ran. Include: ` +
  `1. Reproduction summary ` +
  `2. API and DB verification results ` +
  `3. Divergence analysis (root cause) and whether an independent confirmer reproduced it ` +
  `4. Deployed code differences ` +
  `5. False-positive ruling ` +
  `6. Production data-integrity audit findings ` +
  `7. Approval outcome (what was approved, what was rejected) ` +
  `8. Fix applied (data fix + defensive fallback) ` +
  `9. Staging verification result ` +
  `10. Recommendations ` +
  `Mark any finding whose status is "unconfirmed" as unconfirmed in the prose. ` +
  `Do not paste raw file contents; cite paths instead. ` +
  `Keep the report under ~200 lines — summarize long lists as counts plus a few examples. ` +
  `\nData: ` +
  `Reproduction: ${JSON.stringify(reproduction)}. ` +
  `API verification: ${JSON.stringify(apiVerification)}. ` +
  `DB verification: ${JSON.stringify(dbVerification)}. ` +
  `Divergence: ${JSON.stringify(divergenceForFix)}. ` +
  `Root-cause confirmation (status ${rootCauseStatus}): ${JSON.stringify(rootCause)}. ` +
  `Deployed analysis: ${JSON.stringify(deployedAnalysis)}. ` +
  `False positive: ${JSON.stringify(falsePositiveResult)}. ` +
  `Audit results: ${JSON.stringify(auditResults)}. ` +
  `Audit failures: ${JSON.stringify(auditFailures)}. ` +
  `Approval: ${JSON.stringify(approval)}. ` +
  `Fix: ${JSON.stringify(fixResult)}. ` +
  `Staging: ${JSON.stringify(stagingResult)}.`
);

// Independent read of the report before it is published.
// §10: the report-writer cannot see its own gaps. A fresh reader-proxy tells us
// what is unclear, unsupported, or missing, while there is still time to fix it.
const readerProxy = await agent("report-reader",
  "You read a draft report as a reader would, from the text alone. " +
  "You do not verify claims against the repository. " +
  "Tell the author what is unclear, unsupported, or missing, and what the engineer who acts on this report will ask next."
).ask<string>(
  `Read this data-triage report draft. ` +
  `Flag anything that is unclear, unsupported by the evidence given, or missing. ` +
  `Do not edit files; return a short list of issues in priority order. ` +
  `\n${reportMarkdown}`
);

let finalReportMarkdown = reportMarkdown;
if (readerProxy && readerProxy.trim().length > 0) {
  const repairWriter = agent("report-repairer",
    "You revise reports to close reader-proxy gaps. " +
    "Do not change facts; add the missing evidence or clarify the prose."
  );
  finalReportMarkdown = await repairWriter.ask<string>(
    `Repair this report to address the reader-proxy issues. ` +
    `Keep the same structure. Do not add new findings that are not in the evidence. ` +
    `\nIssues: ${readerProxy}\n\nReport:\n${reportMarkdown}`
  );
}

// Build the report payload BEFORE publishing so the artifact fallback below can
// render a compact version from it if the writer's markdown is over the cap.
const findings: Finding[] = [
  {
    where: "API output",
    what: apiVerification.matchesPage ? "API output matches what the page shows" : "API output does not match what the page shows",
    // Same rule as the Database finding below (fix 6 / §10): the api-verifier's own
    // field check is not self-confirmation, so this carries the confirmer's status.
    evidence: apiVerification.fieldChecks.map((f) => `${f.field}: expected ${f.expected}, got ${f.actual}`).join("; ") +
      (rootCause.reproduced ? ` — confirmed: ${rootCause.note}` : ` — not independently confirmed: ${rootCause.note}`),
    status: rootCauseStatus,
    severity: apiVerification.matchesPage ? "low" : "high",
  },
  {
    where: "Database",
    what: dbVerification.queryResults ? "DB state contains expected data" : "DB state does not contain expected data",
    // §10: the db-verifier's own queryResult string is not self-confirmation. This
    // finding is verified only if the independent confirmer reproduced the divergence
    // that rests on this DB state.
    evidence: `${dbVerification.queryResults} ` +
      (rootCause.reproduced
        ? `Independently reproduced by confirmer: ${rootCause.note}`
        : `NOT independently confirmed — confirmer's last note: ${rootCause.note}`),
    status: rootCauseStatus,
    severity: "medium",
  },
  {
    where: divergenceForFix.precomputedSource || "data path",
    what: divergenceForFix.rootCauses[0] || "Divergence found between API and DB",
    evidence: `Records: ${divergenceForFix.disagreeingRecords.join(", ")}. ` +
      (rootCause.reproduced
        ? `Independently reproduced by confirmer: ${rootCause.note}`
        : `Independent confirmer could NOT reproduce the finding after ${MAX_RECONFIRM} rounds: ${rootCause.note}`),
    status: rootCauseStatus,
    severity: "high",
  },
  ...auditResults.flatMap((audit) =>
    audit.findings.map((f) => ({
      where: audit.name,
      what: f,
      evidence: `Production audit (${audit.name}), read-only query result: ${f}`,
      status: "unconfirmed" as const,
      severity: "medium" as const,
    }))
  ),
  ...auditFailures.map((f) => ({
    where: f.name,
    what: "Audit category could not run",
    evidence: f.reason,
    status: "unconfirmed" as const,
    severity: "medium" as const,
  })),
];

const verified: string[] = [
  `Reproduced the bug: ${reproduction.reproduced ? "yes" : "no"}`,
  pageOrEndpoint === ""
    ? "Endpoint reachability not checked (no pageOrEndpoint supplied)"
    : `Endpoint reachable via curl: HTTP ${apiGate?.stdout.trim() ?? "unknown"}, ${endpointReachable ? "reachable" : "NOT reachable"}`,
  `API output checked field-by-field against the user's view by a separate verifier`,
  `DB state read directly via raw SQL, bypassing application logic`,
  `Found divergence: ${divergenceForFix.disagreeingRecords.length} disagreeing records`,
  rootCause.reproduced
    ? `Root cause independently reproduced by a fresh confirmer: ${rootCause.note}`
    : `Root cause NOT independently reproduced (labelled unconfirmed): ${rootCause.note}`,
  `Read deployed code via git show`,
  falsePositiveResult.isFalsePositive
    ? `False positive check: false positive detected`
    : (sourceFile === ""
        ? `False positive check: inconclusive (no source file supplied)`
        : `False positive check: not a false positive (${falsePositiveResult.matchCount}/${falsePositiveResult.sourceRows} source rows matched)`),
  `Production audit: ${auditResults.length} categories checked, ${auditFailures.length} failed to run`,
  `Approval: ${approval.approvedBundles.length} bundle(s) approved, ${approval.rejectedBundles.length} rejected`,
  `Fix applied: ${fixResult.dataFix}`,
  `Defensive fallback added: ${fixResult.fallback}`,
  stagingEndpoint === ""
    ? "Staging verification: not checked (no staging endpoint supplied)"
    : (stagingCurlRan
        ? `Staging verification: ${stagingResult.passed ? "passed" : "failed"} (curl exit ${stagingGate?.exitCode ?? "unknown"})`
        : "Staging verification: not checked (curl could not run)"),
];

const notCovered: string[] = [
  ...(sourceFile === "" ? ["False-positive ruling is inconclusive — no source-of-truth file supplied"] : []),
  ...(stagingEndpoint === "" ? ["Staging verification — no staging endpoint supplied"] : []),
  ...(pageOrEndpoint === "" ? ["End-to-end confirmation against the live user page"] : []),
  ...(pageOrEndpoint !== "" && !endpointReachable
    ? ["The user-reported endpoint did not answer curl — reachability recorded in the report only; no phase was skipped on it"]
    : []),
  ...auditFailures.map((f) => `Audit category could not run: ${f.name}`),
  "The defensive fallback's runtime behaviour — confirmed only if the staging curl exercised the fixed code path",
];

const conclusion =
  `Data triage complete. ` +
  `${reproduction.reproduced ? "Bug reproduced." : "Could not reproduce."} ` +
  `Root cause: ${divergenceForFix.rootCauses[0] ?? "unknown"} ` +
  `(${rootCauseStatus === "verified" ? "independently reproduced" : `NOT independently reproduced after ${MAX_RECONFIRM} confirmation rounds — unconfirmed`}). ` +
  (falsePositiveResult.isFalsePositive
    ? "This is a false positive — no fix needed."
    : `Approved bundles applied: ${approval.approvedBundles.length}. ` +
      `Fix: ${fixResult.dataFix} Defensive fallback: ${fixResult.fallback}.`) +
  ` Staging: ${
    stagingEndpoint === ""
      ? "not checked (no endpoint supplied)."
      : (stagingCurlRan
          ? (stagingResult.passed ? "passed." : "failed.")
          : "not checked (curl could not run).")
  }`;

// Publish the deliverable last, with a repair-republish fallback (§10): if the
// writer's markdown is rejected (over the artifact cap), publish a compact
// machine-rendered version built from the result object so the run still ships
// its deliverable.
try {
  await artifact.markdown("triage-report", finalReportMarkdown, {
    title: "Data Triage Report",
    description: "Investigation findings, root cause, fix applied, and verification results.",
    primary: true,
  });
} catch {
  log("artifact.markdown rejected the writer's report — republishing a compact fallback");
  const compactMarkdown = [
    `# Data Triage Report`,
    ``,
    `## Conclusion`,
    conclusion,
    ``,
    `## Findings`,
    ...findings.map((f) => `- [${f.status}/${f.severity}] ${f.where}: ${f.what} — ${f.evidence}`),
    ``,
    `## Verified`,
    ...verified.map((v) => `- ${v}`),
    ``,
    `## Not covered`,
    ...notCovered.map((n) => `- ${n}`),
  ].join("\n");
  await artifact.markdown("triage-report", compactMarkdown, {
    title: "Data Triage Report (compact)",
    description: "Machine-rendered fallback: the writer's report exceeded the artifact cap.",
    primary: true,
  });
}

const result: TriageReport = {
  conclusion,
  findings,
  verified,
  notCovered,
};

return result;
