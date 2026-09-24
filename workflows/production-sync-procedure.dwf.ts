/* zcode-workflow
description: "Prepares and verifies a production database sync: enforces the
  never-sync-before-deprecating sequencing with the owner-supplied
  classification authoritative, builds the migration plan with dry-run gates,
  runs compliance review and post-sync drift checks from the skill's own scripts
  where present, and publishes a ready-to-execute plan whose verdicts are
  labelled as attestation where nothing measured them. Embodies the
  production-sync-procedure skill."
whenToUse: When a production database sync is planned and needs the
  deprecation-first sequencing, dry-run gates, and compliance review. Meant to
  run in the workspace that holds the drift evidence (the CI/data repo).
args:
  destructiveApproved:
    type: boolean
    description: Owner has approved destructive steps.
    required: false
    default: false
  isCleanupSync:
    type: boolean
    description: This is a cleanup sync after deprecation (never sync before deprecating).
    required: false
    default: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// production-sync-procedure.dwf.ts
// Dynamic workflow: Staging → Production sync for Cruising Intelligence
// Embodying ~/.agents/skills/production-sync-procedure/SKILL.md (34-step runbook)
// Pattern: hybrid — structure in this script; subagent asks reference the skill's
//          SKILL.md and references/ for fine procedural detail.
//
// SEMANTICS: this workflow PREPARES AND REVIEWS the sync plan. It executes nothing
// against any database: the runbook's hard rule is that each step needs its own user
// approval (SKILL.md line 43), and the destructive commands (prisma migrate deploy,
// deprecate-stale-*.ts --confirm, the live v3 sync, FLUSHALL) must be run by the
// human operator from the reviewed plan. Every result below says "planned/reviewed,
// not executed" — no field in this script ever claims a command was run.

// ─── Result interfaces ───────────────────────────────────────────────────────

interface Finding {
  /** Phase and step the finding is about. */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the review evidence behind it. */
  evidence: string;
  /** All findings here are "unconfirmed": no command was run and no independent confirmer reproduced them. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the reviews it performed, files it read. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

interface DriftCheckResult {
  /** "pass" | "fail" | "blocked" — the reviewer's assessment that the check was run and passed before this workflow started. */
  schemaDrift: string;
  branchDrift: string;
  dataDrift: string;
  summary: string;
}

interface DeprecationPlan {
  /** Owner-supplied or reviewer-escalated: is this the prod-side of a T1–T7 cleanup? */
  isCleanupSync: boolean;
  /** The exact prisma migrate deploy command for the operator. */
  migrateCommand: string;
  /** Tables to deprecate, each with the exact deprecator command. */
  tables: { table: string; deprecatorCommand: string }[];
  /** Exact prompt-version cleanup SQL, empty string when not applicable. */
  promptVersionCleanupCommand: string;
  concerns: string[];
  summary: string;
}

interface RecoveryPlan {
  /** The recovery sequence for P3009/42P07, from the cited reference. */
  steps: string[];
  /** The references/ file the plan was drawn from. */
  referenceCited: string;
  summary: string;
}

interface DeprecationDryRunReview {
  /** Per-table dry-run expectations the operator must verify. */
  tables: { table: string; whatToCheck: string }[];
  /** Concerns the operator must resolve before --confirm. */
  concerns: string[];
  summary: string;
}

interface PostDeprecationDriftCheck {
  /** True when every table's drift is within the 5% halt threshold (SKILL.md:89). */
  withinThreshold: boolean;
  /** Tables the operator must investigate before syncing. */
  tablesOverThreshold: string[];
  /** Confirmation the route_corridors.count expected increase was accounted for (SKILL.md:105). */
  routeCorridorsNote: string;
  summary: string;
}

interface StaleArtifactAssessment {
  /** Leftover _shadow/_tmp/_bak tables found in the schema, per the review. */
  tablesFound: { name: string; rowCountBasis: string; codeReferences: string; safeToDrop: boolean }[];
  /** Exact DROP statements prepared for user approval, empty when none are safe. */
  dropCommands: string[];
  summary: string;
}

interface DryRunAnalysis {
  /** Tables the plan intends to sync. */
  plannedTablesInScope: string[];
  /** Tables the plan does NOT cover that the operator must scope with --table=<name>. */
  tablesOutsideScope: string[];
  /** LargeBlob tables where any Deleted > 0 is the danger signal (SKILL.md:216). */
  largeBlobDeletionRisk: string[];
  /** True when the plan's table list is inside the reviewed scope. */
  scopeClean: boolean;
  /** True when the plan expects zero deletions after PK diff + backfill. */
  deletionFree: boolean;
  summary: string;
}

interface SyncPlanResult {
  /** Exact command sequence for the operator (pipeline-worker container). */
  containerRunbook: string;
  /** The --table=<name> scoping commands derived from the reviewed plan. */
  scopeCommands: string[];
  /** The mandatory post-sync content_embeddings verification procedure (SKILL.md:196–208). */
  contentEmbeddingsCheck: string;
  /** The DEV_DATABASE_URL vs DATABASE_URL trap and its fix (SKILL.md:99). */
  envVarWarning: string;
  summary: string;
}

interface MvRefreshPlan {
  /** Materialized view name. */
  name: string;
  /** "planned" when the refresh can proceed as specified; "blocked" when a gotcha blocks it. */
  status: "planned" | "blocked";
  /** Whether work_mem='128MB' is correctly specified for this MV when required. */
  workMemSpecified: boolean;
  /** One-line concern, empty string when none. */
  concern: string;
}

interface GraphTransferPlan {
  /** Exact command sequence (ioredis via migrate-environments.ts --phase=8 only). */
  commandSequence: string[];
  /** The GRAPH.QUERY verification queries the operator runs afterwards. */
  verificationQueries: string[];
  /** Approaches that corrupt the graph and must not be used. */
  forbiddenApproaches: string[];
  summary: string;
}

interface CacheFlushPlan {
  /** Exact FLUSHALL command for the operator. */
  flushCommand: string;
  /** Host:port the plan targets. */
  targetHostPort: string;
  /** True only when the reviewer confirmed the target is the app Redis, NOT FalkorDB (SKILL.md:352). */
  targetConfirmedAsAppRedis: boolean;
  /** The FalkorDB guard sentence the operator must heed. */
  falkordbGuard: string;
  summary: string;
}

interface VerificationChecklist {
  /** The five post-sync checks with command and pass criteria. */
  checks: { name: string; command: string; passCriteria: string }[];
  /** The per-environment redline procedure for route_corridors.signature (SKILL.md:416–431). */
  redlineProcedure: string;
  summary: string;
}

interface ComplianceReview {
  /** Whether the drafted plan covers every mandatory runbook step in order. */
  allStepsCovered: boolean;
  concerns: { step: string; concern: string; severity: "low" | "medium" | "high" }[];
  /** Runbook steps the drafted plan does not cover. */
  missingSteps: string[];
  summary: string;
}

// ─── Owner-supplied facts (args) ─────────────────────────────────────────────
// isCleanupSync and destructiveApproved are facts only the run owner knows
// (SKILL.md:34, :91). They are read from args; when absent, the reviewer persona
// is instructed to escalate rather than guess (SKILL.md authoring rules §14).

const ownerSaysCleanup = args.isCleanupSync === true;
const ownerSaysNotCleanup = args.isCleanupSync === false;
const destructiveApproved = args.destructiveApproved === true;

// ─── Dashboard ───────────────────────────────────────────────────────────────

artifact.board("sync-progress", {
  title: "Production sync plan progress",
  key: "phase",
  status: "status",
  columns: ["in-progress", "planned", "blocked", "skipped"],
  cardTitle: "phase",
  detail: [
    { field: "step", label: "Runbook step" },
    { field: "result", label: "Outcome" },
  ],
});

function boardItem(
  phase: string,
  status: string,
  step: string,
  result: string,
): { phase: string; status: string; step: string; result: string } {
  return { phase, status, step, result };
}

// ─── Findings: salvage by report ─────────────────────────────────────────────
// Every finding is reported the moment it lands (§10), so a failure in a later
// phase still delivers everything the earlier phases produced.

const allFindings: Finding[] = [];
function emitFinding(finding: Finding): void {
  allFindings.push(finding);
  report(finding);
}

// ─── Shared personas ─────────────────────────────────────────────────────────

const REVIEWER_SYSTEM =
  "You are an operations plan reviewer for the Cruising Intelligence production-sync-procedure " +
  "skill at ~/.agents/skills/production-sync-procedure/SKILL.md and its references/ directory. " +
  "Read the cited SKILL.md sections and references files for fine detail; cite path:line for every claim. " +
  "This workflow PREPARES the sync plan — it must not execute anything: do not run any command " +
  "against any database, container, or host; produce the reviewed plan instead. " +
  "If a fact is impossible to determine from the workspace — for example whether this run is the " +
  "prod-side of a T1–T7 cleanup plan, or whether the user approved a destructive step — escalate " +
  "and say so plainly rather than working around it or guessing.";

const runbookReviewer = agent("runbook-reviewer", { system: REVIEWER_SYSTEM });

const complianceReviewer = agent("compliance-reviewer", {
  system:
    "You are an independent plan auditor who has seen nothing but the drafted results handed to you. " +
    "Read ~/.agents/skills/production-sync-procedure/SKILL.md and audit the drafted plan against it. " +
    "Report gaps only: steps that are missing, out of order, or missing their approval gates. " +
    "Cite path:line from the skill for every claim. You never edit files and never run commands.",
});

const reportWriter = agent("report-writer", {
  system:
    "You write structured operations plan reports. The plan is PREPARED, not executed: every step " +
    "must read as awaiting human execution and approval. Never invent numbers or outputs not present " +
    "in the input. Flag what was not verified.",
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Prerequisite checks (runbook §Prerequisites, SKILL.md:37–43)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Check prerequisites and staging pipeline state");

report(boardItem("prerequisites", "in-progress", "§Prerequisites", "reviewing"), "sync-progress");

const preflight = await runbookReviewer.ask<DriftCheckResult>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 37–43 (Prerequisites).\n\n" +
    "A production sync must not be planned unless all of these held BEFORE it started:\n" +
    "1. Schema drift check passed: STAGING_PG_PASSWORD=\"$STAGING_DB_PW\" python3 scripts/detect-schema-drift.py --cron\n" +
    "2. Branch drift check passed: bash scripts/detect-branch-drift.sh\n" +
    "3. Data drift check passed: bash scripts/detect-data-drift.sh\n" +
    "4. Staging pipeline phases 1–11 complete (corridors enriched, LLM profiles, embeddings built)\n" +
    "5. Explicit user approval obtained per step (CLAUDE.md hard rule, SKILL.md:43)\n\n" +
    "You cannot run these checks (plan-prep only). Assess what evidence exists in the workspace " +
    "that each check ran and passed (recaps, logs, docs). Anything you cannot confirm is 'blocked'.\n\n" +
    "Return a DriftCheckResult with schemaDrift/branchDrift/dataDrift each 'pass', 'fail', or 'blocked', " +
    "and a human summary naming the evidence you found or the absence of it.",
);

report(boardItem("prerequisites", "planned", "§Prerequisites", preflight.summary), "sync-progress");

for (const drift of [
  { name: "Schema drift", value: preflight.schemaDrift },
  { name: "Branch drift", value: preflight.branchDrift },
  { name: "Data drift", value: preflight.dataDrift },
]) {
  if (drift.value !== "pass") {
    emitFinding({
      where: "Phase 1: pre-flight checks",
      what: `${drift.name}: ${drift.value} — no evidence it was run and passed before planning`,
      evidence: preflight.summary,
      status: "unconfirmed",
      severity: drift.value === "fail" ? "high" : "medium",
    });
  }
}

if (preflight.schemaDrift !== "pass" || preflight.branchDrift !== "pass" || preflight.dataDrift !== "pass") {
  log("Pre-flight drift state not confirmed — blocking plan as unsafe to execute.");
  report(boardItem("prerequisites", "blocked", "§Prerequisites", "drift state unconfirmed"), "sync-progress");
  const blockedMd = [
    "# Production sync plan — BLOCKED at pre-flight",
    "",
    "This plan was NOT executed. It is blocked because the pre-flight drift state could not be confirmed.",
    "",
    `- Schema drift: ${preflight.schemaDrift}`,
    `- Branch drift: ${preflight.branchDrift}`,
    `- Data drift: ${preflight.dataDrift}`,
    "",
    "## Reviewer summary",
    preflight.summary,
    "",
    "## Before executing",
    "Run the three drift checks for real (SKILL.md:40–42) and obtain per-step approval (SKILL.md:43).",
  ].join("\n");
  await artifact.markdown("production-sync-report", blockedMd, {
    title: "Production sync plan — blocked at pre-flight",
    description: "The sync plan was not prepared past Phase 1: drift state unconfirmed.",
    primary: true,
  });
  const blocked: WorkflowReport = {
    conclusion:
      "Sync plan blocked at pre-flight: the schema/branch/data drift checks could not be confirmed " +
      "as run-and-passed. Nothing was executed. Run the checks for real, then re-run this workflow.",
    findings: allFindings,
    verified: [`Phase 1 reviewer assessment: ${preflight.summary}`],
    notCovered: [
      "The three drift-check commands were not run by this workflow (plan-prep only; scripts live in the CI repo).",
      "Every later runbook phase — plan preparation never started.",
      "Staging pipeline phase completeness (1–11) was not independently verified.",
    ],
  };
  return blocked;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Step 0 decision: pre-sync deprecation (SKILL.md:47–106)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Determine whether this sync needs pre-deprecation");

report(boardItem("pre-sync-deprecation", "in-progress", "Step 0 (conditional)", "evaluating"), "sync-progress");

const deprecationPlan = await runbookReviewer.ask<DeprecationPlan>(
  (ownerSaysCleanup
    ? "The run owner has supplied: this IS the prod-side of a T1–T7 cleanup plan.\n\n"
    : ownerSaysNotCleanup
      ? "The run owner has supplied: this is a routine data refresh, NOT a cleanup-plan sync.\n\n"
      : "The run owner did NOT say whether this is a cleanup-plan sync. If you cannot determine it, " +
        "escalate and ask rather than guessing (SKILL.md:34).\n\n") +
    "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 47–106 (Step 0) and the " +
    "Critical sequencing rules at lines 85–95. Canonical order: migrate → deprecate → sync.\n\n" +
    "Prepare the Step 0 plan: the exact prisma migrate deploy command (0a), the per-table " +
    "deprecate-stale-*.ts --dry-run then --confirm commands run against $PROD_DB (0b/0c), and the " +
    "optional prompt-version cleanup as its own separately-approved UPDATE (0d, SKILL.md:93).\n\n" +
    "Traps to bake into the plan: prod row counts can legitimately EXCEED staging's (SKILL.md:101); " +
    "T6 prod may be entirely at the obsolete prompt_version so the cleanup deprecates ALL active rows " +
    "(SKILL.md:103); route_corridors.count will INCREASE ~685 across the sync and that is NOT a " +
    "redline violation (SKILL.md:105).\n\n" +
    "Return a DeprecationPlan. isCleanupSync=false (routine refresh) is a valid answer — then return " +
    "empty commands and say why in the summary.",
);

// Owner-supplied fact is authoritative when present (SKILL.md:34, :91).
// When supplied, it gates the Step 0 branch; a reviewer disagreement is recorded
// as a high-severity finding but does NOT override the owner (SKILL.md:87).
const isCleanupSync = ownerSaysCleanup || (!ownerSaysNotCleanup && deprecationPlan.isCleanupSync === true);

if (ownerSaysCleanup && !deprecationPlan.isCleanupSync) {
  emitFinding({
    where: "Phase 2: Step 0 decision",
    what: "Run owner classified this as a cleanup-plan sync (args.isCleanupSync=true) but the reviewer assessed it as a routine refresh — owner classification takes precedence per SKILL.md:34; Step 0 branch proceeds",
    evidence: "args.isCleanupSync=true; reviewer deprecationPlan.isCleanupSync=false",
    status: "unconfirmed",
    severity: "high",
  });
}

// Declared here so the final audit and report can reference them even when Step 0 is skipped.
let recoveryPlan: RecoveryPlan | null = null;
let dryRunReview: DeprecationDryRunReview | null = null;
let postDeprecationDrift: PostDeprecationDriftCheck | null = null;

if (!isCleanupSync) {
  log("Routine refresh — no pre-sync deprecation needed.");
  report(boardItem("pre-sync-deprecation", "skipped", "Step 0", "routine sync — skipped"), "sync-progress");
} else {
  report(boardItem("pre-sync-deprecation", "in-progress", "Step 0", "plan prepared — see next phases"), "sync-progress");
  emitFinding({
    where: "Phase 2: Step 0 plan",
    what: "Pre-sync deprecation plan prepared — migrate → deprecate → sync, each step a separate user approval",
    evidence: deprecationPlan.summary,
    status: "unconfirmed",
    severity: "low",
  });

  // ── PHASE 3 — P3009/42P07 recovery readiness (SKILL.md:354–391 + references/) ──
  phase("Prepare the migration-failure recovery plan");

  report(boardItem("migration-recovery", "in-progress", "Migration Failure Recovery §", "preparing"), "sync-progress");

  recoveryPlan = await runbookReviewer.ask<RecoveryPlan>(
    "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 354–391 (Migration Failure " +
      "Recovery, P3009/42P07) AND the worked recovery transcript at " +
      "~/.agents/skills/production-sync-procedure/references/" +
      "prisma-migration-p3009-42p07-recovery-2026-06-28.md.\n\n" +
      "Step 0a deploys a Prisma migration to prod. If it fails with 42P07 ('relation already exists'), " +
      "Prisma records a failed migration and every later deploy dies with P3009. The reference " +
      "transcript records what did NOT work (removing the migration file alone; recreating with " +
      "IF NOT EXISTS alone) and what DID: idempotent SQL plus " +
      "./node_modules/.bin/prisma migrate resolve --applied <name>, then redeploy. Note the transcript's " +
      "trap: npx prisma fails on macOS — use ./node_modules/.bin/prisma directly (reference line 60).\n\n" +
      "Prepare the recovery plan the operator follows if Step 0a fails this way, and cite the reference " +
      "file you drew it from.\n\n" +
      "Return a RecoveryPlan.",
  );

  emitFinding({
    where: "Phase 3: P3009/42P07 recovery plan",
    what: "Migration-failure recovery plan prepared from the cited references/ transcript",
    evidence: recoveryPlan.summary,
    status: "unconfirmed",
    severity: "low",
  });
  report(boardItem("migration-recovery", "planned", "Migration Failure Recovery §", recoveryPlan.summary), "sync-progress");

  // ── PHASE 4 — Dry-run counts review + destructive approval gate (SKILL.md:58–66, :91) ──
  phase("Review the deprecation dry-run counts and approval gate");

  report(boardItem("deprecation-dry-run", "in-progress", "Step 0b", "reviewing dry-run expectations"), "sync-progress");

  dryRunReview = await runbookReviewer.ask<DeprecationDryRunReview>(
    "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 58–66 (Step 0b), lines 76–83 " +
      "(the verified Plan A Phase 5 run), and lines 97–105 (known traps).\n\n" +
      "For each table in the prepared deprecation plan, state what the operator must verify in the " +
      "--dry-run output BEFORE --confirm:\n" +
      "  - prod row count may match or EXCEED staging's (prod had 10,694 orphans vs staging's 10,495 " +
      "in the verified run — SKILL.md:81) — the extra orphans were valid on staging but absent from " +
      "prod's route_corridors;\n" +
      "  - re-running --dry-run after --confirm must print '0 rows to deprecate' (idempotent, SKILL.md:95);\n" +
      "  - the plan's deprecator commands are exactly the scripts/insights/deprecate-stale-<table>.ts " +
      "form run against $PROD_DB.\n\n" +
      "Do not execute anything. Return a DeprecationDryRunReview listing the per-table checks and any " +
      "concerns the operator must resolve before running --confirm.",
  );

  for (const concern of dryRunReview.concerns) {
    emitFinding({
      where: "Phase 4: deprecation dry-run review",
      what: concern,
      evidence: dryRunReview.summary,
      status: "unconfirmed",
      severity: "medium",
    });
  }
  report(boardItem("deprecation-dry-run", "planned", "Step 0b", dryRunReview.summary), "sync-progress");

  if (!destructiveApproved) {
    log("Destructive deprecation not approved by the run owner — plan stops short of --confirm.");
    report(boardItem("deprecation-approval", "blocked", "Step 0c", "awaiting explicit approval"), "sync-progress");
    const approvalMd = [
      "# Production sync plan — BLOCKED awaiting destructive-step approval",
      "",
      "This plan was NOT executed. The deprecation --confirm step (SKILL.md:66) requires its own",
      "explicit user approval: per CLAUDE.md, 'Approval for one action does not extend to others' (SKILL.md:91).",
      "",
      "## Prepared sequence (awaiting approval, then human execution)",
      deprecationPlan.migrateCommand,
      ...deprecationPlan.tables.map((t) => `- ${t.table}: \`${t.deprecatorCommand}\``),
      deprecationPlan.promptVersionCleanupCommand ? `- prompt-version: \`${deprecationPlan.promptVersionCleanupCommand}\`` : "",
      "",
      "## Dry-run review",
      dryRunReview.summary,
      ...dryRunReview.concerns.map((c) => `- CONCERN: ${c}`),
      "",
      "## Recovery readiness",
      recoveryPlan.summary,
    ].join("\n");
    await artifact.markdown("production-sync-report", approvalMd, {
      title: "Production sync plan — awaiting deprecation approval",
      description: "Plan prepared through Step 0b; --confirm is blocked pending explicit user approval.",
      primary: true,
    });
    const awaitingApproval: WorkflowReport = {
      conclusion:
        "Deprecation plan prepared through the dry-run review, but the destructive --confirm step has " +
        "no explicit approval (SKILL.md:91). Nothing was executed; the plan stops short of --confirm.",
      findings: allFindings,
      verified: [
        `Step 0 plan prepared: ${deprecationPlan.summary}`,
        `Dry-run review: ${dryRunReview.summary}`,
        `Recovery plan: ${recoveryPlan.summary}`,
      ],
      notCovered: [
        "No command was executed — the workflow prepares and reviews only.",
        "Later runbook phases (stale artifacts, v3 sync, MVs, FalkorDB, Redis, post-sync checks) were not planned past this gate.",
      ],
    };
    return awaitingApproval;
  }
  emitFinding({
    where: "Phase 4: approval gate",
    what: "Run owner supplied destructiveApproved=true for the deprecation --confirm step",
    evidence: "args.destructiveApproved === true",
    status: "unconfirmed",
    severity: "low",
  });

  // ── PHASE 5 — Post-deprecation drift check (SKILL.md:89, :105) ──────────────
  phase("Check data drift between deprecation and sync");

  report(boardItem("post-deprecation-drift", "in-progress", "SKILL.md:89 drift check", "preparing"), "sync-progress");

  postDeprecationDrift = await runbookReviewer.ask<PostDeprecationDriftCheck>(
    "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md line 89 (Critical sequencing rule #2: " +
      "'Drift check between deprecation and sync' — bash scripts/detect-data-drift.sh after prod " +
      "deprecation, confirms prod's missing tables/rows are exactly what the sync is expected to add; " +
      "drift >5% on any table = halt and investigate) and line 105 (trap: route_corridors.count will " +
      "INCREASE by ~685 across the sync — the signature column on existing rows is untouched, so this " +
      "is NOT a redline violation and must not trip the check).\n\n" +
      "Prepare this check: the exact command, which tables the operator compares, the 5% threshold, " +
      "and the route_corridors expected-increase exemption so the check does not misfire.\n\n" +
      "Assess from the workspace whether there is any evidence this drift check has already run since " +
      "the deprecation. Return a PostDeprecationDriftCheck.",
  );

  emitFinding({
    where: "Phase 5: post-deprecation drift check",
    what: postDeprecationDrift.withinThreshold
      ? "Post-deprecation drift within threshold (or no evidence of a violation)"
      : `Drift over the 5% halt threshold on: ${postDeprecationDrift.tablesOverThreshold.join(", ")}`,
    evidence: postDeprecationDrift.summary,
    status: "unconfirmed",
    severity: postDeprecationDrift.withinThreshold ? "low" : "high",
  });
  report(boardItem("post-deprecation-drift", "planned", "SKILL.md:89 drift check", postDeprecationDrift.summary), "sync-progress");

  if (!postDeprecationDrift.withinThreshold) {
    log("Post-deprecation drift over 5% on at least one table — halting plan per SKILL.md:89.");
    report(boardItem("post-deprecation-drift", "blocked", "SKILL.md:89 drift check", "drift >5% — halt"), "sync-progress");
    const driftMd = [
      "# Production sync plan — HALTED: post-deprecation drift over threshold",
      "",
      "This plan was NOT executed. Per SKILL.md:89, drift >5% on any table between deprecation and sync",
      "means halt and investigate.",
      "",
      `Tables over threshold: ${postDeprecationDrift.tablesOverThreshold.join(", ")}`,
      "",
      "## Reviewer summary",
      postDeprecationDrift.summary,
      "",
      "## route_corridors exemption applied in this check",
      postDeprecationDrift.routeCorridorsNote,
    ].join("\n");
    await artifact.markdown("production-sync-report", driftMd, {
      title: "Production sync plan — halted on post-deprecation drift",
      description: "Drift over the 5% threshold between deprecation and sync (SKILL.md:89).",
      primary: true,
    });
    const driftHalt: WorkflowReport = {
      conclusion:
        "Plan halted between deprecation and sync: drift over the 5% threshold on " +
        `${postDeprecationDrift.tablesOverThreshold.join(", ") || "at least one table"} (SKILL.md:89). ` +
        "Nothing was executed; investigate the drift before syncing.",
      findings: allFindings,
      verified: [`Post-deprecation drift review: ${postDeprecationDrift.summary}`],
      notCovered: [
        "The drift-check command itself was not run (plan-prep only).",
        "Later runbook phases were not planned past this halt.",
      ],
    };
    return driftHalt;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6 — Step 1: stale leftover tables (SKILL.md:107–127)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Check production for stale leftover tables");

report(boardItem("stale-artifacts", "in-progress", "Step 1", "reviewing"), "sync-progress");

const staleArtifacts = await runbookReviewer.ask<StaleArtifactAssessment>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 107–127 (Step 1).\n\n" +
    "The sync should not start with leftover tables from prior migrations (_shadow, _tmp, _bak " +
    "patterns; the historical case was regions_shadow with 24 rows matching regions — a stale copy " +
    "with no code references, SKILL.md:127).\n\n" +
    "Prepare the Step 1 procedure: the information_schema query, the code-reference grep " +
    "(grep -rl '<table>' lib/ app/ server/ scripts/), the row-count-before-drop rule, and the exact " +
    "DROP TABLE statements ready for user approval. Search this workspace for any record of which " +
    "leftover tables exist on prod; anything unconfirmed goes in the assessment as such.\n\n" +
    "Return a StaleArtifactAssessment.",
);

for (const table of staleArtifacts.tablesFound) {
  if (!table.safeToDrop) {
    emitFinding({
      where: `Phase 6: stale table ${table.name}`,
      what: "Leftover table found that is NOT confirmed safe to drop — resolve before the sync",
      evidence: `rowCountBasis: ${table.rowCountBasis}; codeReferences: ${table.codeReferences}`,
      status: "unconfirmed",
      severity: "medium",
    });
  }
}
report(boardItem("stale-artifacts", "planned", "Step 1", staleArtifacts.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 7 — Step 2 dry-run plan review (SKILL.md:129–244)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Review the v3 dry-run plan against the reviewed scope");

report(boardItem("v3-sync", "in-progress", "Step 2 (dry-run)", "reviewing"), "sync-progress");

const dryRunAnalysis = await runbookReviewer.ask<DryRunAnalysis>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 129–244 (Step 2), lines 164–181 " +
    "(connection-string traps), and lines 183–216 (count-level vs content-level drift; largeBlob " +
    "delete hazard).\n\n" +
    "The v3 sync is a differential upsert across 63 tables. The dry-run compares CONTENT — it surfaces " +
    "drift the count-only detect-data-drift.sh cannot see (2026-09-22: counts ≤2.5% everywhere while " +
    "14 tables had content changes, SKILL.md:185–192). 'A dry-run whose Tables with changes list " +
    "exceeds the reviewed plan is a STOP' (SKILL.md:193); scope with --table=<name>.\n\n" +
    "LargeBlob hazard (SKILL.md:216): route_map_svgs staging-wins DELETE can drop prod PKs that live " +
    "prod itineraries still serve; row-count parity masks it. Deleted > 0 is the danger signal — the " +
    "operator must diff PK sets (COPY ... TO STDOUT both envs, comm -13), check every prod-only PK " +
    "against ACTIVE prod itineraries, backfill prod→staging, and re-dry-run until Deleted: 0.\n\n" +
    "Connection-string traps to bake into the plan (SKILL.md:164–181): exclude backticks from the grep " +
    "character class; pin the prod app DB by host AND port (trolley.proxy.rlwy.net:50919); never echo " +
    "the URL into logs.\n\n" +
    "Assess the plan: which tables are in scope, which content-bearing tables the dry-run is expected " +
    "to flag, and whether the plan can honestly claim deletion-free. Return a DryRunAnalysis.",
);

emitFinding({
  where: "Phase 7: v3 dry-run scope",
  what: dryRunAnalysis.scopeClean
    ? `Plan scope is clean: ${dryRunAnalysis.plannedTablesInScope.length} tables, all inside the reviewed scope`
    : `Plan scope is NOT clean — tables outside the reviewed plan: ${dryRunAnalysis.tablesOutsideScope.join(", ")}`,
  evidence: dryRunAnalysis.summary,
  status: "unconfirmed",
  severity: dryRunAnalysis.scopeClean ? "low" : "high",
});
report(boardItem("v3-sync", "in-progress", "Step 2 (dry-run)", dryRunAnalysis.summary), "sync-progress");

if (!dryRunAnalysis.scopeClean) {
  log("Plan scope not clean — STOP per SKILL.md:193.");
  report(boardItem("v3-sync", "blocked", "Step 2 (dry-run)", "scope STOP (SKILL.md:193)"), "sync-progress");
  const scopeMd = [
    "# Production sync plan — STOP: dry-run scope exceeds the reviewed plan",
    "",
    "This plan was NOT executed. Per SKILL.md:193: 'A dry-run whose Tables with changes list exceeds",
    "the reviewed plan is a STOP.' Scope with --table=<name> and re-review.",
    "",
    `Tables outside scope: ${dryRunAnalysis.tablesOutsideScope.join(", ")}`,
    "",
    "## Reviewer summary",
    dryRunAnalysis.summary,
  ].join("\n");
  await artifact.markdown("production-sync-report", scopeMd, {
    title: "Production sync plan — STOP on dry-run scope",
    description: "The planned table set exceeds the reviewed scope (SKILL.md:193).",
    primary: true,
  });
  const scopeStop: WorkflowReport = {
    conclusion:
      "Plan STOPPED at the v3 dry-run scope check: the planned table set exceeds the reviewed scope " +
      "(SKILL.md:193). Nothing was executed; narrow with --table=<name> and re-review.",
    findings: allFindings,
    verified: [`Dry-run scope review: ${dryRunAnalysis.summary}`],
    notCovered: [
      "No dry-run command was executed (plan-prep only).",
      "Live sync, MV, FalkorDB, Redis, and post-sync phases were not planned past this STOP.",
    ],
  };
  return scopeStop;
}

if (!dryRunAnalysis.deletionFree) {
  log("Plan cannot claim deletion-free — STOP pending PK diff + backfill per SKILL.md:216.");
  report(boardItem("v3-sync", "blocked", "Step 2 (dry-run)", "deletion hazard (SKILL.md:216)"), "sync-progress");
  const delMd = [
    "# Production sync plan — STOP: largeBlob deletion hazard unresolved",
    "",
    "This plan was NOT executed. Per SKILL.md:216, Deleted > 0 on a largeBlob table is the danger",
    "signal: the route_map_svgs staging-wins DELETE can drop prod PKs that LIVE prod itineraries serve.",
    "",
    `Tables with deletion risk: ${dryRunAnalysis.largeBlobDeletionRisk.join(", ") || "see summary"}`,
    "",
    "## Required before any live sync",
    "Diff PK sets (COPY ... TO STDOUT both envs, comm -13); check every prod-only PK against ACTIVE",
    "prod itineraries; backfill prod→staging; re-dry-run until Deleted: 0.",
    "",
    "## Reviewer summary",
    dryRunAnalysis.summary,
  ].join("\n");
  await artifact.markdown("production-sync-report", delMd, {
    title: "Production sync plan — STOP on deletion hazard",
    description: "LargeBlob Deleted > 0 unresolved (SKILL.md:216).",
    primary: true,
  });
  const deletionStop: WorkflowReport = {
    conclusion:
      "Plan STOPPED at the largeBlob deletion hazard: the plan cannot claim Deleted: 0 " +
      "(SKILL.md:216). Nothing was executed; run the PK diff + backfill loop first.",
    findings: allFindings,
    verified: [`Dry-run deletion review: ${dryRunAnalysis.summary}`],
    notCovered: [
      "No dry-run command was executed (plan-prep only).",
      "Live sync, MV, FalkorDB, Redis, and post-sync phases were not planned past this STOP.",
    ],
  };
  return deletionStop;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 8 — Step 2 live runbook (SKILL.md:129–215) — prepared, not executed
// ═══════════════════════════════════════════════════════════════════════════════

phase("Prepare the live v3 sync runbook");

report(boardItem("v3-sync-live", "in-progress", "Step 2 (live)", "preparing runbook"), "sync-progress");

const syncPlan = await runbookReviewer.ask<SyncPlanResult>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 129–163 (Step 2 commands), " +
    "lines 195–208 (MANDATORY post-sync content_embeddings verification), and line 99 (the " +
    "DEV_DATABASE_URL trap: v3 requires DEV_DATABASE_URL for the source; if DATABASE_URL is already " +
    "set to prod from a prior deprecation step, v3 bails with 'source and target resolve to the same " +
    "database' — fix: unset DATABASE_URL; export DEV_DATABASE_URL=$STAGING_DB).\n\n" +
    "Prepare the operator runbook for the LIVE sync: copy-script-to-container command, dry-run " +
    "command, live command (pipeline-worker container form), then the per-table --table=<name> " +
    "scoping commands derived from the reviewed plan, then the MANDATORY content_embeddings check " +
    "(SELECT COUNT(*) on staging AND prod — they MUST match; v3's syncEmbeddingTable silently " +
    "swallows errors and returns {inserted: 0}, SKILL.md:196–208).\n\n" +
    "This is a prepared runbook — the operator executes it. Return a SyncPlanResult.",
);

emitFinding({
  where: "Phase 8: live v3 sync runbook",
  what: "Live sync runbook prepared, including the mandatory content_embeddings post-sync check",
  evidence: syncPlan.summary,
  status: "unconfirmed",
  severity: "low",
});
report(boardItem("v3-sync-live", "planned", "Step 2 (live)", syncPlan.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 9 — Step 3: materialized view refresh plan (SKILL.md:246–298) — fan-out
// ═══════════════════════════════════════════════════════════════════════════════

phase("Prepare the materialized view refresh plan");

report(boardItem("materialized-views", "in-progress", "Step 3", "preparing 11 MV plans"), "sync-progress");

const materializedViews = [
  { name: "itinerary_port_visits", needsWorkMem: true, note: "~2.17M rows, ~73s refresh" },
  { name: "itinerary_port_conditions", needsWorkMem: true, note: "~2.17M rows" },
  { name: "port_active_lineages", needsWorkMem: true, note: "~18K rows" },
  { name: "dashboard_stats", needsWorkMem: false, note: "1 row" },
  { name: "insights_breakdown_stats", needsWorkMem: false, note: "20 rows" },
  { name: "mv_destination_cruise_lines", needsWorkMem: false, note: "437 rows" },
  { name: "mv_clan_seasonal_metrics", needsWorkMem: false, note: "62 rows" },
  { name: "mv_deployment_grid", needsWorkMem: false, note: "1,716 rows" },
  { name: "mv_region_active_months", needsWorkMem: false, note: "NOT in phase 7 — manual refresh (SKILL.md:262)" },
  { name: "mv_region_persona_deployments", needsWorkMem: false, note: "NOT in phase 7; pre-existing duplicate (region_id, ship_id) data quality failure (SKILL.md:296)" },
  { name: "mv_region_signature_itineraries", needsWorkMem: false, note: "NOT in phase 7 — manual refresh (SKILL.md:264)" },
] as const;

// Fan-out: one planner per MV — unique subagent names per view.
const mvPlans = await Promise.all(
  materializedViews.map((mv) =>
    agent(`mv-plan-${mv.name}`).ask<MvRefreshPlan>(
      "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 246–298 (Step 3).\n\n" +
        `Prepare the refresh plan for materialized view '${mv.name}' (${mv.note}).\n` +
        (mv.needsWorkMem
          ? "This MV needs SET work_mem = '128MB' before REFRESH — Railway Hobby tier default 4MB fails with 53100 (SKILL.md:294).\n"
          : "") +
        (mv.name === "mv_region_persona_deployments"
          ? "KNOWN pre-existing failure: ship_deployments has duplicate (region_id, ship_id) tuples, so " +
            "REFRESH CONCURRENTLY fails with 'duplicate rows without any null columns'. Plan the " +
            "non-CONCURRENTLY refresh, and note the fallback (add startDate to the unique index or dedup " +
            "the source data) if it still fails (SKILL.md:296). CONCURRENTLY is also worse on Hobby tier " +
            "generally — more shared memory workers (SKILL.md:297).\n"
          : "") +
        "Plan-review only: state the exact psql command the operator runs and whether the plan for THIS " +
        "view is blocked by any gotcha. Do not execute anything.\n\n" +
        "Return an MvRefreshPlan for this one view.",
    ),
  ),
);

for (const plan of mvPlans) {
  if (plan.status === "blocked") {
    emitFinding({
      where: `Phase 9: MV ${plan.name}`,
      what: `Refresh plan blocked: ${plan.concern}`,
      evidence: "per-MV planner review",
      status: "unconfirmed",
      severity: "medium",
    });
  }
}
const mvAllPlanned = mvPlans.every((p) => p.status === "planned");
log(`${mvPlans.filter((p) => p.status === "planned").length}/${materializedViews.length} MV plans are unblocked`);
report(boardItem("materialized-views", mvAllPlanned ? "planned" : "blocked", "Step 3", `${mvPlans.filter((p) => p.status === "planned").length}/${materializedViews.length} MV plans unblocked`), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 10 — Step 4: FalkorDB graph transfer plan (SKILL.md:299–339)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Prepare the FalkorDB graph transfer plan");

report(boardItem("falkordb", "in-progress", "Step 4", "preparing"), "sync-progress");

const graphPlan = await runbookReviewer.ask<GraphTransferPlan>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 299–339 (Step 4).\n\n" +
    "CRITICAL (SKILL.md:301): redis-cli DUMP/RESTORE does NOT work for FalkorDB's graphdata key type " +
    "(even redis-cli 8.0.0 fails with 'DUMP payload version or checksum are wrong'). The ONLY working " +
    "method is migrate-environments.ts --phase=8 via ioredis (dumpBuffer + restore) from the " +
    "pipeline-worker container. Deprecated: the RDB file approach (falkordb-copy-to-production.ts) — " +
    "FalkorDB overwrites dump.rdb on restart. redis-cli corrupts the binary RESTORE argument through " +
    "shell pipes (SKILL.md:336); the staging app container has no redis-cli/scripts/psql (SKILL.md:338).\n\n" +
    "Prepare the operator command sequence (copy script → run phase 8 --yes → expected output), the " +
    "GRAPH.QUERY verification queries (node count, edge count), and the forbidden approaches.\n\n" +
    "Return a GraphTransferPlan.",
);

emitFinding({
  where: "Phase 10: FalkorDB transfer plan",
  what: "Graph transfer plan prepared — ioredis phase 8 only, with verification queries",
  evidence: graphPlan.summary,
  status: "unconfirmed",
  severity: "low",
});
report(boardItem("falkordb", "planned", "Step 4", graphPlan.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 11 — Step 5: Redis flush plan (SKILL.md:341–352)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Prepare the production Redis flush plan");

report(boardItem("redis-flush", "in-progress", "Step 5", "preparing"), "sync-progress");

const flushPlan = await runbookReviewer.ask<CacheFlushPlan>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 341–352 (Step 5).\n\n" +
    "The plan must flush the production APP Redis (shinkansen.proxy.rlwy.net:50726) so the cache " +
    "regenerates from freshly-synced PG — and NEVER FalkorDB (switchyard.proxy.rlwy.net:17324): " +
    "flushing FalkorDB would delete the graph just restored in Step 4 (SKILL.md:352). Redis is a " +
    "speed cache; PG is the durable source of truth (SKILL.md:350).\n\n" +
    "Confirm from the runbook which host:port is the app Redis and which is FalkorDB, and state " +
    "explicitly whether the planned flush command targets the app Redis only. If you cannot confirm " +
    "the target distinction, say so in targetConfirmedAsAppRedis=false rather than assuming.\n\n" +
    "Return a CacheFlushPlan.",
);

emitFinding({
  where: "Phase 11: Redis flush plan",
  what: flushPlan.targetConfirmedAsAppRedis
    ? "Flush plan confirmed to target the app Redis, not FalkorDB"
    : "Flush target NOT confirmed as app Redis — executing FLUSHALL against FalkorDB would destroy the restored graph (SKILL.md:352)",
  evidence: flushPlan.summary,
  status: "unconfirmed",
  severity: flushPlan.targetConfirmedAsAppRedis ? "low" : "high",
});

if (!flushPlan.targetConfirmedAsAppRedis) {
  log("Flush target not confirmed as app Redis — blocking plan per SKILL.md:352.");
  report(boardItem("redis-flush", "blocked", "Step 5", "FalkorDB hazard — target unconfirmed"), "sync-progress");
  const flushMd = [
    "# Production sync plan — BLOCKED: Redis flush target unconfirmed",
    "",
    "This plan was NOT executed. SKILL.md:352: NEVER flush FalkorDB — it would delete the graph",
    "restored in Step 4. The reviewer could not confirm the planned flush targets the app Redis",
    `(${flushPlan.targetHostPort}).`,
    "",
    "## Reviewer summary",
    flushPlan.summary,
    "",
    "## Resolve before executing",
    "Confirm shinkansen.proxy.rlwy.net:50726 (app Redis) vs switchyard.proxy.rlwy.net:17324 (FalkorDB)",
    "and only then run the FLUSHALL by hand.",
  ].join("\n");
  await artifact.markdown("production-sync-report", flushMd, {
    title: "Production sync plan — blocked on Redis flush target",
    description: "FLUSHALL target unconfirmed against the SKILL.md:352 FalkorDB hazard.",
    primary: true,
  });
  const flushHalt: WorkflowReport = {
    conclusion:
      "Plan BLOCKED at the Redis flush step: the flush target could not be confirmed as the app Redis. " +
      "Per SKILL.md:352, flushing FalkorDB destroys the Step 4 graph. Nothing was executed.",
    findings: allFindings,
    verified: [`Redis flush review: ${flushPlan.summary}`],
    notCovered: [
      "No FLUSHALL was executed (plan-prep only).",
      "Post-sync verification checklist and final audit were not planned past this block.",
    ],
  };
  return flushHalt;
}
report(boardItem("redis-flush", "planned", "Step 5", flushPlan.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 12 — Post-sync verification checklist (SKILL.md:394–431)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Assemble the post-sync verification checklist");

report(boardItem("post-sync-checklist", "in-progress", "Post-Sync Verification §", "assembling"), "sync-progress");

const verificationChecklist = await runbookReviewer.ask<VerificationChecklist>(
  "Reference: ~/.agents/skills/production-sync-procedure/SKILL.md lines 394–431 (Post-Sync Verification " +
    "and the redline section).\n\n" +
    "Assemble the five post-sync checks with exact command and pass criteria:\n" +
    "1. PG counts: route_corridors and content_embeddings match staging (SKILL.md:399–400)\n" +
    "2. FalkorDB populated: GRAPH.QUERY node count (SKILL.md:402–404)\n" +
    "3. MVs refreshed: itinerary_port_visits ~2.17M (SKILL.md:407–408)\n" +
    "4. App responsive: curl HTTP status (SKILL.md:410)\n" +
    "5. Redis repopulating: DBSIZE > 0 after requests (SKILL.md:413–414)\n\n" +
    "REDLINE (SKILL.md:416–431): route_corridors.signature is a PER-ENVIRONMENT redline — the test is " +
    "same-environment pre/post SHA256, NOT staging-vs-prod (cross-env hashes WILL differ; that is " +
    "expected — 199 inserts + 99 updates are enrichment columns and signature is not in the upsert " +
    "key, SKILL.md:433–435). Put the exact BEFORE/AFTER sha256 procedure in redlineProcedure.\n\n" +
    "Return a VerificationChecklist.",
);

emitFinding({
  where: "Phase 12: post-sync verification checklist",
  what: "Five-check verification checklist assembled with the per-environment redline procedure",
  evidence: verificationChecklist.summary,
  status: "unconfirmed",
  severity: "low",
});
report(boardItem("post-sync-checklist", "planned", "Post-Sync Verification §", verificationChecklist.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 13 — Independent audit of the drafted plan (fresh eyes, §3)
// The auditor gets the collected plan results as its evidence (§3: give the eyes
// the same evidence) — it audits the DRAFT, not an execution record.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Audit the prepared plan against the full runbook");

report(boardItem("compliance-audit", "in-progress", "Full Compliance Review", "auditing drafted plan"), "sync-progress");

const complianceReview = await complianceReviewer.ask<ComplianceReview>(
  "You are auditing a DRAFTED plan (nothing was executed). Below is every result the drafting " +
    "produced. Audit it against ~/.agents/skills/production-sync-procedure/SKILL.md.\n\n" +
    "Drafted plan results:\n" +
    JSON.stringify({
      prerequisites: preflight,
      step0_deprecation_plan: isCleanupSync ? deprecationPlan : { isCleanupSync: false, note: "routine refresh — Step 0 skipped per SKILL.md:49" },
      step0_recovery_plan: isCleanupSync ? recoveryPlan : null,
      step0_dry_run_review: isCleanupSync ? dryRunReview : null,
      step0_post_deprecation_drift: isCleanupSync ? postDeprecationDrift : null,
      step1_stale_artifacts: staleArtifacts,
      step2_dry_run_analysis: dryRunAnalysis,
      step2_live_runbook: syncPlan,
      step3_mv_plans: mvPlans,
      step4_graph_transfer: graphPlan,
      step5_redis_flush: flushPlan,
      post_sync_checklist: verificationChecklist,
    }, null, 2) +
    "\n\nMandatory checklist (SKILL.md sections): prerequisites (:37–43); Step 0 conditional " +
    "migrate→deprecate→sync with per-step approvals (:47–106); Step 1 stale artifacts (:107–127); " +
    "Step 2 dry-run-then-live with content_embeddings check (:129–215); Step 3 all 11 MVs (:246–298); " +
    "Step 4 ioredis-only FalkorDB transfer (:299–339); Step 5 app-Redis-only FLUSHALL (:341–352); " +
    "post-sync verification incl. per-environment redline (:394–431); P3009 recovery readiness " +
    "(:354–391) — checklist this item only when Step 0a applies (recoveryPlan is null on routine " +
    "refreshes by design, so do not flag it as missing when step0_recovery_plan below is null).\n\n" +
    "Also check the sequencing rules (:85–95): drift check between deprecation and sync; separate " +
    "approval per step; prompt-version cleanup as its own operation.\n\n" +
    "Return a ComplianceReview: allStepsCovered, per-step concerns, and any missingSteps.",
);

for (const concern of complianceReview.concerns) {
  emitFinding({
    where: `Phase 13 audit: ${concern.step}`,
    what: concern.concern,
    evidence: complianceReview.summary,
    status: "unconfirmed",
    severity: concern.severity,
  });
}
for (const missing of complianceReview.missingSteps) {
  emitFinding({
    where: "Phase 13 audit",
    what: `Runbook step missing from the drafted plan: ${missing}`,
    evidence: complianceReview.summary,
    status: "unconfirmed",
    severity: "high",
  });
}
report(boardItem("compliance-audit", "planned", "Full Compliance Review", complianceReview.summary), "sync-progress");

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 14 — Write and publish the final plan report (deliverable)
// ═══════════════════════════════════════════════════════════════════════════════

phase("Write the final sync plan report");

report(boardItem("final-report", "in-progress", "Deliverable", "writing"), "sync-progress");

const reportMarkdown = await reportWriter.ask<string>(
  "Write a structured markdown report of this PREPARED-AND-REVIEWED production sync plan. Nothing was " +
    "executed: every step reads as awaiting human execution and its own approval. Never invent numbers " +
    "or outputs. Use the runbook's section order and end with a verdict: " +
    "READY-TO-EXECUTE (with the per-step approval list) / NEEDS MANUAL INTERVENTION.\n\n" +
    "Drafted plan results:\n" +
    JSON.stringify({
      prerequisites: preflight,
      step0_deprecation_plan: isCleanupSync ? deprecationPlan : { isCleanupSync: false, note: "routine refresh — Step 0 skipped per SKILL.md:49" },
      step0_recovery_plan: isCleanupSync ? recoveryPlan : null,
      step0_dry_run_review: isCleanupSync ? dryRunReview : null,
      step0_post_deprecation_drift: isCleanupSync ? postDeprecationDrift : null,
      step1_stale_artifacts: staleArtifacts,
      step2_dry_run_analysis: dryRunAnalysis,
      step2_live_runbook: syncPlan,
      step3_mv_plans: mvPlans,
      step4_graph_transfer: graphPlan,
      step5_redis_flush: flushPlan,
      post_sync_checklist: verificationChecklist,
      compliance_audit: complianceReview,
    }, null, 2),
);

await artifact.markdown("production-sync-report", reportMarkdown, {
  title: "Production sync plan",
  description: "Reviewed runbook plan — all steps prepared, none executed; per-step approval list included.",
  primary: true,
});
report(boardItem("final-report", "planned", "Deliverable", "plan report published"), "sync-progress");

// ─── Final WorkflowReport ─────────────────────────────────────────────────────

const result: WorkflowReport = {
  conclusion:
    `Prepared and reviewed the full production-sync runbook plan (${isCleanupSync ? "including Step 0 pre-sync deprecation" : "routine refresh, Step 0 skipped"}); ` +
    `${allFindings.length} findings recorded, all "unconfirmed" — nothing was executed and no check ran as a command. ` +
    complianceReview.allStepsCovered
      ? "The independent audit found the drafted plan covers every mandatory runbook step."
      : `The independent audit found missing steps: ${complianceReview.missingSteps.join("; ")}.`,
  findings: allFindings,
  verified: [
    "Every runbook phase was reviewed by a subagent that read the cited SKILL.md sections and references; their assessments and concerns are recorded as findings.",
    isCleanupSync
      ? "Step 0 sequence, P3009 recovery plan (from references/prisma-migration-p3009-42p07-recovery-2026-06-28.md), dry-run review, and post-deprecation drift check were planned and gated."
      : "Step 0 was skipped as a routine refresh (SKILL.md:49).",
    "The independent compliance auditor re-read the full skill against the collected plan results.",
    "No command was executed against any database, container, or host — by design (per-step approval rule, SKILL.md:43).",
  ],
  notCovered: [
    "No deterministic gates: the runbook's commands (detect-schema-drift.py, detect-branch-drift.sh, detect-data-drift.sh, sync-to-production-v3.ts, migrate-environments.ts, deprecate-stale-*.ts, psql/redis-cli checks) were never run — plan-prep by design; every execution claim would need a world.run gate when this workflow is adapted for the CI repo.",
    "The drift-check scripts do not exist in this workspace (commissiontracker), so even their presence could not be verified here.",
    "Dry-run table scope, deletion counts, and content_embeddings counts are reviewer expectations, not measured output.",
    "MV gotchas (work_mem, mv_region_persona_deployments duplicates) are review claims with no checkable outcome until the operator runs the refresh.",
    "The actual production sync itself — this workflow stops at the reviewed plan by design.",
  ],
};

return result;
