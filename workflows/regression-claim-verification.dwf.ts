/* zcode-workflow
description: "Verifies a regression claim against evidence in three branches
  (code audit, production audit, prerequisite check): independent confirmers
  reproduce each finding from served bytes and git history rather than trusting
  the finder, handoff conditions are evaluated at the end, and the verdict
  separates script-observed facts from subagent-reported ones. Embodies the
  regression-claim-verification skill. Assumes a Railway-deployed project with
  hashed CSS bundles."
whenToUse: When someone claims a regression and the question is whether the
  evidence supports it — before anyone fixes or reverts anything.
args:
  claim:
    type: string
    description: The regression claim to verify (e.g. 'the new CSS broke the pricing page').
    required: true
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: regression-claim-verification
// Embodies the 13-step procedure from ~/.agents/skills/regression-claim-verification/SKILL.md
// Hybrid pattern: structure (phases, fan-out, bounded loops, WorkflowReport) lives in
// this script; subagent asks reference the skill's own SKILL.md and references/ for
// per-claim check detail. This skill ships no scripts/, so no world.run gates are expected.

// ---------------------------------------------------------------------------
// Result types (all ask<T> type arguments are interfaces declared here)
// ---------------------------------------------------------------------------

interface GitHistoryHit {
  /** Full commit hash. */
  hash: string;
  /** First line of the commit message. */
  subject: string;
  /** ISO date of the commit. */
  date: string;
  /** Path to any recap file associated with this commit, when found. */
  recapPath?: string;
}

interface CodeAuditEntry {
  /** Branch name audited. */
  branch: string;
  /** True when the fix pattern is present on this branch. */
  fixPresent: boolean;
  /** Exact classes, patterns, or strings found (or explicitly not found). */
  evidence: string;
  /** File path and line number where the fix lives, when present. */
  location?: string;
}

interface ProdDeployInfo {
  /** Most recent production deploy ID. */
  deployId: string;
  /** Whether the deploy succeeded. */
  success: boolean;
  /** ISO timestamp of the deploy. */
  timestamp: string;
  /** True when the critical class or pattern was found in the prod bundle. */
  fixInBundle: boolean;
  /** Evidence from the bundle check (class count, grep output). */
  bundleEvidence: string;
}

interface ClaimFact {
  /** The exact verifiable assertion extracted from the recap or plan. */
  assertion: string;
  /** Verdict on this single claim. */
  verdict: "TRUE" | "FALSE" | "PARTIALLY TRUE";
  /** Evidence: file path and line, or command output that proved it. */
  evidence: string;
}

interface RevertState {
  /** Whether the working tree is clean. */
  workingTreeClean: boolean;
  /** Whether expected commits are present or absent as the recap claims. */
  commitsAsExpected: boolean;
  /** Whether there are uncommitted changes. */
  hasUncommittedChanges: boolean;
  /** Whether artifacts the revert claimed to remove are actually gone. */
  artifactsRemoved: boolean;
  /** Human-readable details of the revert verification. */
  details: string;
}

interface PrereqCheck {
  /** The symbol, method, or module the handoff claimed exists. */
  claimedSymbol: string;
  /** Whether the symbol exists in the claimed file. */
  exists: boolean;
  /** What actually exists at that layer (routes, schemas, DB). */
  actualLayer: string;
  /** True when filling the gap is purely additive (no existing signature touched). */
  isAdditive: boolean;
  /** Evidence from reading the file, quoting the exact lines. */
  evidence: string;
}

interface ConfirmationResult {
  /** True only when you reproduced the check yourself, from the evidence alone. */
  confirmed: boolean;
  /** One sentence: what you ran or read, and what it showed. */
  note: string;
}

interface SymbolConfirmation {
  /** Whether the claimed symbol exists when you read and grep the file yourself. */
  exists: boolean;
  /** One sentence quoting the exact lines you found (or did not find). */
  note: string;
}

interface AdditivityDecision {
  /** True when filling the gap touches no existing signature or consumer. */
  isAdditive: boolean;
  /** True when proceeding requires a user scope decision first. */
  isBlocker: boolean;
  /** Why this decision was reached, citing the layer you inspected. */
  reason: string;
}

interface HandoffDecision {
  /** True when the skill is exhausted and runtime triage should take over. */
  needsRuntimeTriage: boolean;
  /** Which of the skill's ceiling signals were observed, if any. */
  ceilingSignals: string[];
  /** The concrete next action, in the skill's phrasing. */
  nextStep: string;
}

interface Review {
  approved: boolean;
  /** What would break this or is missing. */
  gaps: string[];
  /** Overall assessment in one paragraph. */
  assessment: string;
}

interface Finding {
  /** Workspace-relative path, with a line when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what is wrong or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and output that proved it. */
  evidence: string;
  /** "verified" when an independent confirmer reproduced it; "unconfirmed" when confirmation failed or the two independent reads disagreed. */
  status: "verified" | "unconfirmed";
  /** low, medium, or high. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how. Attribute each entry to the subagent that reported it; never state a command's output as fact. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

interface ClaimClassification {
  /** Which verification path to take. */
  mode: "core-regression" | "audit-of-audit" | "prerequisite-existence";
  /** The user's exact claim or the recap/plan path. */
  claim: string;
  /** Keywords extracted for git log search. */
  keywords: string[];
  /** Files the user named, if any. */
  namedFiles: string[];
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

artifact.board("verification-progress", {
  title: "Verification progress",
  key: "step",
  status: "status",
  columns: ["pending", "in-progress", "verified", "unverified", "blocked"],
  detail: [{ field: "detail" }],
});

// ---------------------------------------------------------------------------
// Phase 1: classify the claim
// ---------------------------------------------------------------------------

phase("Classify the regression claim");
const claim = await agent("claim-classifier", {
  system:
    "You read a user's regression claim and classify it into one of three shapes: " +
    "(a) core-regression — the user says a fix 'used to work' or 'was reverted'; " +
    "(b) audit-of-audit — the user distrusts a previous session's recap or plan and asks you to verify its claims; " +
    "(c) prerequisite-existence — an incoming task asserts that some helper, module, or API already exists and you must build on top of it. " +
    "Return only the classification and extracted fields. Do not investigate yet.",
}).ask<ClaimClassification>(`Classify this claim:\n\n${String(args.claim)}`);

log(`Claim classified as: ${claim.mode}`);

// ---------------------------------------------------------------------------
// Core regression path (Steps 1-4 + ceiling decision from the skill)
// ---------------------------------------------------------------------------

if (claim.mode === "core-regression") {
  phase("Find the claimed fix in git history");
  const gitHistory = await agent("git-historian", {
    system:
      "You are a git historian. Search commit messages and recap archives for the claimed fix. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md and its references/ for the exact recipe. " +
      "Return commit hashes, dates, subjects, and any recap paths you find. Do not edit files.",
  }).ask<GitHistoryHit[]>(`Find the claimed fix for these keywords: ${claim.keywords.join(", ")}. ` +
    `Named files: ${claim.namedFiles.join(", ") || "none"}. ` +
    `Search with: git log --all --oneline --grep for the keywords, and ls docs/recaps/ for matching recaps. ` +
    `Read the skill's SKILL.md Step 1 and the worked example in references/cruising-intelligence-2026-07-10-filters-rail.md for the exact approach.`);

  report({ step: "git-history", status: "in-progress", detail: `found ${gitHistory.length} candidate commits` }, "verification-progress");

  phase("Audit the current state of the claimed-fixed code");
  const codeAudit = await agent("code-auditor", {
    system:
      "You audit the CURRENT state of the claimed-fixed code across branches. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md Step 2 for the recipe. " +
      "For each named file, run git show branch:path and grep for the fix-pattern classes or strings. " +
      "Return one CodeAuditEntry per branch (HEAD, develop, origin/staging, origin/main). " +
      "Do not edit files.",
  }).ask<CodeAuditEntry[]>(`Audit the fix pattern on these files: ${claim.namedFiles.join(", ") || "infer from git history"}. ` +
    `Branches: HEAD, develop, origin/staging, origin/main. ` +
    `Candidate commits from history: ${JSON.stringify(gitHistory.map((h) => ({ hash: h.hash, subject: h.subject, date: h.date, recapPath: h.recapPath })))}. ` +
    `Use git show <branch>:<path> and grep for the critical class names or patterns.`);

  report({ step: "code-audit", status: "in-progress", detail: `audited ${codeAudit.length} branch entries` }, "verification-progress");

  if (codeAudit.length === 0) {
    const emptyReport: WorkflowReport = {
      conclusion: "The code audit returned no branch entries, so the run cannot decide whether the claimed fix is present. The named files may not exist on the audited branches, or the fix-pattern extraction failed; the verification needs to be re-run with corrected file paths or patterns.",
      findings: [],
      verified: ["script-observed: git history search completed", "script-observed: code audit issued; it returned zero branch entries"],
      notCovered: [
        "per-branch fix-pattern confirmation (no entries to confirm)",
        "production audit (skipped: nothing to verify against)",
        "ceiling decision (no evidence to evaluate)",
      ],
    };
    await artifact.markdown(
      "regression-report",
      [
        `# Regression claim verification`,
        "",
        `## Conclusion`,
        emptyReport.conclusion,
        "",
        `## Findings`,
        "(none — the code audit returned no branch entries)",
        "",
        `## Verified`,
        ...emptyReport.verified.map((v) => `- ${v}`),
        "",
        `## Not covered`,
        ...emptyReport.notCovered.map((n) => `- ${n}`),
      ].join("\n"),
      {
        title: "Regression claim verification report",
        description: "The audit produced no branch entries; no verdict was reached.",
        primary: true,
      },
    );
    return emptyReport;
  }

  phase("Confirm each code audit finding independently");
  const codeConfirmations = await Promise.all(
    codeAudit.map((entry, i) =>
      agent(`code-confirmer-${i}`).ask<ConfirmationResult>(`Reproduce this code audit finding from its evidence alone. ` +
        `Do not edit any file.\n` +
        `Branch: ${entry.branch}\n` +
        `Fix present: ${entry.fixPresent}\n` +
        `Evidence: ${entry.evidence}\n` +
        `Location: ${entry.location ?? "none"}\n` +
        `Run git show ${entry.branch}:<path> yourself and grep for the fix pattern. ` +
        `Return whether you confirmed the finding and a one-sentence note.`),
    ),
  );

  report({ step: "code-confirmation", status: "in-progress", detail: `confirmed ${codeConfirmations.filter((c) => c.confirmed).length} of ${codeConfirmations.length} code audit entries` }, "verification-progress");

  phase("Audit the production deployment");
  const prodAudit = await agent("prod-auditor", {
    system:
      "You audit the PRODUCTION deployment metadata, not just source. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md Step 3 and references/ for the recipe. " +
      "Check Railway deploy metadata (railway deployment list) and record the most recent SUCCESS deploy. " +
      "Return one ProdDeployInfo. Do not edit files.",
  }).ask<ProdDeployInfo>(`Verify the prod deploy metadata for the claimed fix. ` +
    `Candidate commits: ${JSON.stringify(gitHistory.map((h) => ({ hash: h.hash, subject: h.subject, date: h.date })))}. ` +
    `Critical patterns from code audit: ${JSON.stringify(codeAudit.map((e) => ({ branch: e.branch, evidence: e.evidence, location: e.location })))}. ` +
    `Check: railway deployment list for the most recent SUCCESS and its commit hash. ` +
    `Also read references/browser-cache-invisible-deploy.md for the deployment-metadata layer of the five-layer evidence chain.`);

  report({ step: "prod-audit", status: "in-progress", detail: `deploy ${prodAudit.deployId} ${prodAudit.success ? "SUCCESS" : "FAILED"}` }, "verification-progress");

  phase("Confirm what production actually serves");
  const prodConfirmation = await agent("prod-confirmer", {
    system:
      "You independently confirm the SERVED BYTES of production, which is a different layer from the deploy metadata. " +
      "Read ~/.agents/skills/regression-claim-verification/references/browser-cache-invisible-deploy.md and references/nginx-spa-index-html-no-cache.md. " +
      "Do NOT check Railway deployment list — the prod-auditor already covered that layer. Your check is what the server actually serves: " +
      "fetch the live page, extract the hashed CSS/JS bundle URLs, download the bundles, and grep for the critical class or identifier " +
      "(choose markers that survive minification: state variables and camelCase field names, not component names). " +
      "Also check the Cache-Control header on the served index.html: curl -sI and grep for cache-control — a missing header is the invisible-deploy root cause. " +
      "Derive the production URL from the repository's config or recaps. Do not edit files.",
  }).ask<ConfirmationResult>(`Independently verify what production serves, from the evidence alone. ` +
    `Critical patterns the code audit found: ${JSON.stringify(codeAudit.map((e) => ({ branch: e.branch, evidence: e.evidence, location: e.location })))}. ` +
    `The deploy-metadata audit recorded deploy ${prodAudit.deployId} with success=${prodAudit.success}; treat that as a claim from another subagent, not as your evidence. ` +
    `Fetch the live page and bundle yourself, grep for the critical markers, and check the Cache-Control header on index.html. ` +
    `Return whether the served bytes and headers confirm the claim, with a one-sentence note citing what you fetched.`);

  report({ step: "prod-confirmation", status: prodConfirmation.confirmed ? "verified" : "unverified", detail: prodConfirmation.note }, "verification-progress");

  phase("Independent review of findings");
  const codeAuditSlim = codeAudit.map((e, i) => ({
    branch: e.branch,
    fixPresent: e.fixPresent,
    confirmed: codeConfirmations[i].confirmed,
    confirmerNote: codeConfirmations[i].note,
  }));
  const review = await agent("independent-reviewer", {
    system:
      "You are an independent reviewer who has seen nothing else in this run. " +
      "Read the slimmed evidence below, then open the referenced files and deploy state yourself where a claim looks thin. " +
      "Ask what would break these findings, what is missing, and restate the evidence in your own words. " +
      "Do not edit files.",
  }).ask<Review>(`Review these regression-claim verification findings. ` +
    `Git history: ${JSON.stringify(gitHistory.map((h) => ({ hash: h.hash, subject: h.subject, date: h.date })))}. ` +
    `Code audit with confirmation verdicts: ${JSON.stringify(codeAuditSlim)}. ` +
    `Prod deploy metadata: deploy ${prodAudit.deployId}, success=${prodAudit.success}, timestamp=${prodAudit.timestamp}. ` +
    `Served-bytes confirmation: ${JSON.stringify(prodConfirmation)}. ` +
    `What would break these findings? What is missing from the evidence?`);

  report({ step: "independent-review", status: review.approved ? "verified" : "unverified", detail: review.assessment }, "verification-progress");

  phase("Decide whether runtime triage takes over");
  const handoff = await agent("handoff-evaluator-regression", {
    system:
      "You apply the skill's ceiling decision tree. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md sections 'When to actually fix' and 'When verification says fix is intact but the user keeps insisting'. " +
      "Ceiling signals: all audited branches byte-identical on the relevant file; the served prod bundle carries the critical class; the latest deploy is SUCCESS with a recent timestamp; user pushback or a symptom that persists after a hard refresh. " +
      "When the evidence says 'fix intact everywhere', the skill is exhausted: the handoff is the runtime-triage skill, which Playwrights the live page the user is actually on (enumerating sibling routes, not just the named pages). " +
      "When a branch or the served bundle is actually missing the fix, no handoff is needed: the claim holds and the next step is the fix itself (or a re-deploy when only the deploy is stale). " +
      "Do not edit files.",
  }).ask<HandoffDecision>(`Decide the handoff from the verification evidence. ` +
    `Code audit with confirmation verdicts: ${JSON.stringify(codeAuditSlim)}. ` +
    `Prod deploy metadata: deploy ${prodAudit.deployId}, success=${prodAudit.success}, timestamp=${prodAudit.timestamp}. ` +
    `Served-bytes confirmation: ${JSON.stringify(prodConfirmation)}. ` +
    `Reviewer assessment: ${review.assessment}. ` +
    `Return whether the skill's ceiling was reached, which ceiling signals you observed, and the concrete next step.`);

  report({ step: "handoff-decision", status: handoff.needsRuntimeTriage ? "blocked" : "verified", detail: handoff.nextStep }, "verification-progress");

  phase("Synthesize the final report");
  const reportWriter = await agent("report-writer-regression", {
    system:
      "You synthesize a WorkflowReport from regression-claim verification findings. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md Step 4 for the reporting recipe. " +
      "In the verified array, attribute every entry to its source ('<subagent name> reported: ...'); never state a command's output as fact — only the script-observed entries handed to you may be stated without attribution. " +
      "Return a WorkflowReport with conclusion, findings array, verified list, and notCovered list.",
  }).ask<WorkflowReport>(`Synthesize the verification report. ` +
    `Git history: ${JSON.stringify(gitHistory.map((h) => ({ hash: h.hash, subject: h.subject, date: h.date })))}. ` +
    `Code audit with confirmation verdicts: ${JSON.stringify(codeAuditSlim)}. ` +
    `Prod deploy metadata: deploy ${prodAudit.deployId}, success=${prodAudit.success}, timestamp=${prodAudit.timestamp}. ` +
    `Served-bytes confirmation: ${JSON.stringify(prodConfirmation)}. ` +
    `Review: ${JSON.stringify(review)}. ` +
    `Handoff decision: ${JSON.stringify(handoff)}. ` +
    `Apply the skill's Step 4 reporting rules: DO NOT say 'you're right, let me fix it' without evidence. ` +
    `Report: (1) what the user remembers, (2) what actually happened, (3) what's in code on each branch, (4) what's deployed AND served, (5) most likely causes of the symptom. ` +
    `End with the handoff decision's next step. Return the WorkflowReport.`);

  const confirmedCount = codeConfirmations.filter((c) => c.confirmed).length;
  const finalReport: WorkflowReport = {
    conclusion: reportWriter.conclusion,
    findings: reportWriter.findings,
    verified: [
      `script-observed: ${confirmedCount} of ${codeConfirmations.length} independent code confirmations returned confirmed`,
      `script-observed: the served-bytes confirmation ${prodConfirmation.confirmed ? "confirmed" : "did not confirm"} the deploy audit`,
      ...reportWriter.verified,
    ],
    notCovered: reportWriter.notCovered,
  };

  await artifact.markdown(
    "regression-report",
    [
      `# Regression claim verification`,
      "",
      `## Conclusion`,
      finalReport.conclusion,
      "",
      `## Findings`,
      ...finalReport.findings.map((f) => `- **${f.where}** [${f.severity}] ${f.what} — ${f.evidence} (${f.status})`),
      "",
      `## Next step`,
      handoff.nextStep,
      "",
      `## Verified`,
      ...finalReport.verified.map((v) => `- ${v}`),
      "",
      `## Not covered`,
      ...finalReport.notCovered.map((n) => `- ${n}`),
    ].join("\n"),
    {
      title: "Regression claim verification report",
      description: "What the claimed fix's actual state is across branches, deploy metadata, and served bytes.",
      primary: true,
    },
  );

  return finalReport;
}

// ---------------------------------------------------------------------------
// Audit-of-audit path (Steps 5-8 + next-action decision from the skill)
// ---------------------------------------------------------------------------

if (claim.mode === "audit-of-audit") {
  phase("Extract factual claims from the recap or plan");
  const extractedClaims = await agent("claim-extractor", {
    system:
      "You extract every factual, verifiable claim from a recap or plan document. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Audit-of-audit pattern' Step 1. " +
      "Return one ClaimFact per assertion, with the exact assertion text. Do not investigate yet.",
  }).ask<ClaimFact[]>(`Extract verifiable claims from this source: ${claim.claim}. ` +
    `Return each claim as an assertion string. Examples of verifiable claims: 'sitemap lists 23 region URLs', '6 feature pages missing from sitemap', 'hardcoded stats stale'.`);

  report({ step: "claim-extraction", status: "in-progress", detail: `extracted ${extractedClaims.length} claims` }, "verification-progress");

  phase("Verify each claim against source code");
  const claimVerdicts = await Promise.all(
    extractedClaims.map((c) =>
      agent().ask<ClaimFact>(`Verify this claim from the recap/plan against the actual source code. ` +
        `Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Audit-of-audit pattern' Step 2. ` +
        `Claim: ${c.assertion}. ` +
        `Check the actual files. Do not trust the recap's framing. ` +
        `Return TRUE, FALSE, or PARTIALLY TRUE with file:line evidence. Do not edit files.`),
    ),
  );

  report({ step: "claim-verification", status: "in-progress", detail: `verified ${claimVerdicts.length} claims` }, "verification-progress");

  phase("Verify the cleanup or revert was clean");
  const revertState = await agent("revert-auditor", {
    system:
      "You verify that a cleanup or revert was clean. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Audit-of-audit pattern' Step 3. " +
      "Check git status, git log, git diff, and whether claimed-removed artifacts are actually gone. " +
      "Return a RevertState. Do not edit files.",
  }).ask<RevertState>(`Verify the cleanup/revert state for this claim. ` +
    `Run: git status --short, git log --oneline -10, git diff HEAD --stat. ` +
    `Then verify each artifact the revert claimed to remove: plan file deleted? created modules deleted? restored files correct? ` +
    `Return whether the working tree is clean, commits are as expected, and artifacts are gone.`);

  report({ step: "revert-audit", status: revertState.workingTreeClean ? "verified" : "unverified", detail: revertState.details }, "verification-progress");

  phase("Independent review of the verdict table");
  const verdictReview = await agent("verdict-reviewer", {
    system:
      "You are an independent reviewer who has seen nothing else in this run. " +
      "Read the claim verdict table and the revert state. " +
      "Ask what the previous session missed, what is directionally correct but operationally wrong, and restate the verdict table in your own words. " +
      "Do not edit files.",
  }).ask<Review>(`Review this audit-of-audit verdict table. ` +
    `Claims and verdicts: ${JSON.stringify(claimVerdicts)}. ` +
    `Revert state: ${JSON.stringify(revertState)}. ` +
    `What did the previous session miss? What is directionally correct but operationally sloppy?`);

  report({ step: "verdict-review", status: verdictReview.approved ? "verified" : "unverified", detail: verdictReview.assessment }, "verification-progress");

  phase("Decide the next action from the verdict table");
  const handoff = await agent("handoff-evaluator-audit", {
    system:
      "You apply the skill's 'When to actually fix' decision table to the audit verdicts. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md section 'When to actually fix' and 'When verification says fix is intact but the user keeps insisting'. " +
      "Signals: claims FALSE on a branch with prod missing the class → the fix really is reverted, proceed with the fix (read the recap for what worked). " +
      "Source correct but deploy older than the fix commit → stale deploy, trigger a re-deploy, no code change. " +
      "Everything correct but the user sees a symptom → ask for a screenshot, or go straight to the server-side Cache-Control fix when the audience is non-technical (references/nginx-spa-index-html-no-cache.md); runtime triage takes over for live-behavior symptoms. " +
      "Do not edit files.",
  }).ask<HandoffDecision>(`Decide the next action from the audit evidence. ` +
    `Claims and verdicts: ${JSON.stringify(claimVerdicts)}. ` +
    `Revert state: ${JSON.stringify(revertState)}. ` +
    `Reviewer assessment: ${verdictReview.assessment}. ` +
    `Return whether runtime triage or a server-side fix is needed, which decision-table signals you observed, and the concrete next step.`);

  report({ step: "handoff-decision", status: handoff.needsRuntimeTriage ? "blocked" : "verified", detail: handoff.nextStep }, "verification-progress");

  phase("Synthesize the audit report");
  const reportWriter = await agent("report-writer-audit", {
    system:
      "You synthesize a WorkflowReport from an audit-of-audit verification. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Audit-of-audit pattern' Step 4. " +
      "In the verified array, attribute every entry to its source ('<subagent name> reported: ...'); never state a command's output as fact. " +
      "Return a WorkflowReport with conclusion, findings array, verified list, and notCovered list.",
  }).ask<WorkflowReport>(`Synthesize the audit-of-audit report. ` +
    `Claims and verdicts: ${JSON.stringify(claimVerdicts)}. ` +
    `Revert state: ${JSON.stringify(revertState)}. ` +
    `Review: ${JSON.stringify(verdictReview)}. ` +
    `Handoff decision: ${JSON.stringify(handoff)}. ` +
    `Present findings as: claim -> TRUE/FALSE/PARTIALLY TRUE -> evidence (file:line). ` +
    `Flag anything the previous session missed. Return the WorkflowReport.`);

  const finalReport: WorkflowReport = {
    conclusion: reportWriter.conclusion,
    findings: reportWriter.findings,
    verified: [
      `script-observed: ${claimVerdicts.length} claims each verified by an independent per-claim subagent (fresh context per claim)`,
      `script-observed: the revert audit ran git status, git log, and git diff via revert-auditor`,
      ...reportWriter.verified,
    ],
    notCovered: reportWriter.notCovered,
  };

  await artifact.markdown(
    "audit-report",
    [
      `# Audit-of-audit report`,
      "",
      `## Conclusion`,
      finalReport.conclusion,
      "",
      `## Verdict table`,
      ...claimVerdicts.map((v) => `| ${v.verdict} | ${v.assertion} | ${v.evidence} |`),
      "",
      `## Revert state`,
      `Working tree clean: ${revertState.workingTreeClean}`,
      `Commits as expected: ${revertState.commitsAsExpected}`,
      `Artifacts removed: ${revertState.artifactsRemoved}`,
      `Details: ${revertState.details}`,
      "",
      `## Next step`,
      handoff.nextStep,
      "",
      `## Verified`,
      ...finalReport.verified.map((v) => `- ${v}`),
      "",
      `## Not covered`,
      ...finalReport.notCovered.map((n) => `- ${n}`),
    ].join("\n"),
    {
      title: "Audit-of-audit report",
      description: "Verdict table for each claim from the recap or plan, plus revert state and the next action.",
    },
  );

  return finalReport;
}

// ---------------------------------------------------------------------------
// Prerequisite-existence path (Steps 9-12 + proceed/blocker decision)
// ---------------------------------------------------------------------------

if (claim.mode === "prerequisite-existence") {
  phase("Read the claimed file and confirm the symbol independently");
  const [prereqCheck, symbolConfirmation] = await Promise.all([
    agent("module-checker", {
      system:
        "You verify whether a claimed symbol exists in a named file. " +
        "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims' recipe Step 1. " +
        "You MUST open and read the named file — a grep without reading the surrounding context is not enough; quote the exact lines in your evidence. " +
        "Return a PrereqCheck. Do not edit files.",
    }).ask<PrereqCheck>(`The handoff claims this symbol exists: ${claim.claim}. ` +
      `Read the named file, then grep for the symbol, and quote the exact lines in your evidence. ` +
      `Return whether it exists, what the module actually exports, and the evidence with line numbers.`),
    agent("symbol-confirmer", {
      system:
        "You independently verify a symbol-existence claim from the claim text alone, without seeing the other subagent's verdict. " +
        "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims' recipe Step 1. " +
        "Open the named file yourself, read it, and grep for the symbol. Do not edit files.",
    }).ask<SymbolConfirmation>(`Independently check whether this symbol exists: ${claim.claim}. ` +
      `Open and read the file yourself, grep for the symbol, and return whether it exists with a one-sentence note quoting the lines you found (or the grep count of zero).`),
  ]);

  const verdictsAgree = prereqCheck.exists === symbolConfirmation.exists;
  report({ step: "module-check", status: verdictsAgree ? "verified" : "unverified", detail: `module-checker says exists=${prereqCheck.exists}; symbol-confirmer says exists=${symbolConfirmation.exists}` }, "verification-progress");

  phase("Inspect the layer below for actual implementations");
  const layerInspection = await agent("layer-inspector", {
    system:
      "You inspect the layer below a missing helper to see what actually exists. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims' recipe Step 2. " +
      "Check routes, shared Zod schemas, DB tables — whatever layer the claimed helper would wrap. " +
      "Return what actually exists at that layer. Do not edit files.",
  }).ask<string>(`The claimed symbol ${prereqCheck.claimedSymbol} ${prereqCheck.exists ? "exists" : "does NOT exist"} (${prereqCheck.evidence}). ` +
    `Inspect the layer below: routes, schemas, DB. What actually exists that the handoff could have meant? ` +
    `Return a description of the actual layer.`);

  report({ step: "layer-inspection", status: "in-progress", detail: layerInspection }, "verification-progress");

  phase("Decide additive fix versus blocker");
  const decision = await agent("additivity-judge", {
    system:
      "You decide whether a missing helper gap is purely additive or a blocker. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims' recipe Step 3. " +
      "Purely additive means new methods/types with no existing signature touched. " +
      "Return whether the gap is additive and whether it is safe to proceed.",
  }).ask<AdditivityDecision>(`Claimed symbol: ${prereqCheck.claimedSymbol}. ` +
    `Exists: ${prereqCheck.exists}. Actual layer: ${layerInspection}. ` +
    `Is filling this gap purely additive? Is it a blocker that requires user approval?`);

  report({ step: "additivity-decision", status: decision.isAdditive ? "verified" : "blocked", detail: decision.reason }, "verification-progress");

  phase("Decide whether to proceed or surface the blocker");
  const handoff = await agent("handoff-evaluator-prereq", {
    system:
      "You apply the skill's prerequisite recipe Step 3 and the 'Flag the deviation explicitly' rule. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims'. " +
      "The runtime-triage handoff never applies here — this path verifies claims about code existence, not live behavior; record that no runtime handoff is needed. " +
      "When the gap is purely additive and the task is impossible without it, the next step is the minimal additive fix with the deviation flagged in the final report. " +
      "When filling the gap modifies existing signatures, touches other consumers, or is real feature work, the next step is to STOP and surface the blocker as a scope decision for the user. " +
      "Do not edit files.",
  }).ask<HandoffDecision>(`Decide whether to proceed or surface a blocker. ` +
    `Symbol verdicts ${verdictsAgree ? "agree" : "DISAGREE"}: module-checker exists=${prereqCheck.exists}, symbol-confirmer exists=${symbolConfirmation.exists}. ` +
    `Actual layer: ${layerInspection}. ` +
    `Additivity decision: ${JSON.stringify(decision)}. ` +
    `Return whether a runtime handoff is needed (it should not be), which signals you observed, and the concrete next step.`);

  report({ step: "handoff-decision", status: decision.isBlocker ? "blocked" : "verified", detail: handoff.nextStep }, "verification-progress");

  phase("Synthesize the prerequisite report");
  const reportWriter = await agent("report-writer-prereq", {
    system:
      "You synthesize a WorkflowReport from a prerequisite-existence verification. " +
      "Read ~/.agents/skills/regression-claim-verification/SKILL.md 'Prerequisite-existence claims' recipe Step 4. " +
      "In the verified array, attribute every entry to its source ('<subagent name> reported: ...'); never state a command's output as fact. " +
      "Return a WorkflowReport with conclusion, findings array, verified list, and notCovered list.",
  }).ask<WorkflowReport>(`Synthesize the prerequisite-existence report. ` +
    `Claimed symbol: ${prereqCheck.claimedSymbol}. ` +
    `Module-checker verdict: exists=${prereqCheck.exists}, evidence: ${prereqCheck.evidence}. ` +
    `Symbol-confirmer verdict: exists=${symbolConfirmation.exists}, note: ${symbolConfirmation.note}. ` +
    `The two verdicts ${verdictsAgree ? "AGREE — findings may be marked verified" : "DISAGREE — findings must be marked unconfirmed"}. ` +
    `Actual layer: ${layerInspection}. ` +
    `Additivity decision: ${JSON.stringify(decision)}. ` +
    `Handoff decision: ${JSON.stringify(handoff)}. ` +
    `Flag the deviation explicitly: name what the handoff claimed, what was actually there, what you did about it, and why it was safe. ` +
    `Return the WorkflowReport.`);

  const finalReport: WorkflowReport = {
    conclusion: reportWriter.conclusion,
    findings: reportWriter.findings,
    verified: [
      `script-observed: module-checker and symbol-confirmer ran in parallel on the same claim; their exists-verdicts ${verdictsAgree ? "agree" : "DISAGREE"}`,
      ...reportWriter.verified,
    ],
    notCovered: reportWriter.notCovered,
  };

  await artifact.markdown(
    "prereq-report",
    [
      `# Prerequisite-existence verification`,
      "",
      `## Conclusion`,
      finalReport.conclusion,
      "",
      `## Findings`,
      ...finalReport.findings.map((f) => `- **${f.where}** [${f.severity}] ${f.what} — ${f.evidence} (${f.status})`),
      "",
      `## Next step`,
      handoff.nextStep,
      "",
      `## Verified`,
      ...finalReport.verified.map((v) => `- ${v}`),
      "",
      `## Not covered`,
      ...finalReport.notCovered.map((n) => `- ${n}`),
    ].join("\n"),
    {
      title: "Prerequisite-existence verification report",
      description: `Whether ${prereqCheck.claimedSymbol} exists, independently confirmed, and whether the gap is additive.`,
    },
  );

  return finalReport;
}
