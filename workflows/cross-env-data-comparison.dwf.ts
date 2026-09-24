/* zcode-workflow
description: "Compares data across two environments: generates read-only compare
  scripts per entity, measures staging and production counts, confirms every
  count with an independent recount, and reports divergences behind an owner
  approval gate before any remediation. Embodies the cross-env-data-comparison
  skill. Never writes to either database."
whenToUse: When staging and production data need a count-by-count comparison
  with independently confirmed divergences. Needs read access to both databases.
args:
  entities:
    type: json
    description: Entities to compare across environments.
    required: false
  question:
    type: string
    description: The question the comparison should answer.
    required: false
*/
// cross-env-data-comparison.ts
// Dynamic workflow draft: cross-environment data comparison (staging vs production PostgreSQL).
// Embodying /Users/alejandrodelvillar/.agents/skills/cross-env-data-comparison/SKILL.md (225 lines):
//   warmup drift check :29–42 (bash scripts/detect-data-drift.sh :34–36) · entity-progress
//   Template Script :43–175 · Child Table Coverage Check :176–199 · 8 Pitfalls :200–217 ·
//   Reference files :218–221 · existing example :223–225.
//
// SEMANTICS: read-only comparison plus prepared-only remediation. Subagents may run SELECT-level
// reads against LIVE Railway staging/production Postgres from their own shells. This script never
// executes a write: status-drift fixes are UPDATE-only plans (references/status-drift-cleanup.md),
// any sync is gated behind references/sync-pre-flight.md, TRUNCATE/DELETE are prohibited, and
// every proposed write is escalated to the human run owner through the write-approval gate.
//
// ENVIRONMENT FACTS this draft encodes (each verified in this workspace, 2026-09-23):
// - Staging DATABASE_URL lives in CLAUDE.local.md and is read at run time only: the command
//   recipes cite it at :72/:76/:107/:114, and the Staging section pins it as "DB external" at
//   :37. Lines :85–:89 are the API-keys block (ANTHROPIC_API_KEY :86, NEXTAUTH_SECRET :87,
//   ENCRYPTION_KEY :88) — not the staging DB URL. Subagents read the URL themselves; it is never
//   interpolated into ask text, results, reports, or artifacts.
// - Production credentials are deliberately not pre-pinned (CLAUDE.local.md:52: "Production
//   secrets are deliberately not pre-pinned. Fetch from Railway only when an authorized
//   operation needs them."). The Production section does show a pinned "DB external" at :49
//   (junction.proxy.rlwy.net:47203), but it is demonstrably stale — the production-sync-procedure
//   skill pins the prod app DB as trolley.proxy.rlwy.net:50919 (its SKILL.md:144/:152/:160/:274).
//   So prod access goes through a run-time `railway` CLI fetch (the CLI is installed here), and
//   if it is unavailable the run owner decides staging-only vs abort by escalation.
// - The skill ships no scripts/ directory, and this repo's scripts/ has no detect-data-drift.sh,
//   no port-visit-progress.ts, and no sync-to-production-v3.ts (verified by ls this session), so
//   the parent batch's "run skill scripts via world.run" clause does not apply. The warmup drift
//   check (SKILL.md:29–42) is probed at run time and reported honestly when the script is absent.
// - Generated compare scripts go to out/cross-env-compare/ — out/ is gitignored (.gitignore:8)
//   while scripts/ is not — which satisfies pitfall 1 (SKILL.md:202) without editing .gitignore.
// - This repo's Prisma schema (16 models) contains none of the skill's example tables
//   (port_ship_visits, ship_itineraries, corridor_*), so entity scoping is schema-derived at run
//   time; the skill's tables are cited as illustrations only.
// - The parent batch description calls this skill "8 steps": the 8 is the pitfall count
//   (SKILL.md:200–217, pitfalls 1–8), not an 8-stage procedure. Every comparison ask carries
//   that disclosure.
//
// DESIGN NOTES:
// - world.run is used only for commands that decide WITHOUT credentials (availability checks,
//   leak greps): the facade has no env-var or shell support, so any command that needs
//   DATABASE_URL/PROD_DATABASE_URL runs inside a subagent's own shell, where the URL is read at
//   run time from CLAUDE.local.md or fetched from Railway. That division is deliberate.
// - The deliverable gets two review mechanisms, with the reason on record: per-entity count
//   confirmers (facts: is each number real?) and one independent auditor (procedure: did every
//   comparison carry the template, the child coverage, and the 8 pitfalls; did any credential
//   leak; is the write routing clean?). No reader-proxy is stacked on top (§3 ceiling).

// ─── Result interfaces ───────────────────────────────────────────────────────

interface Finding {
  /** Stage and subject the finding is about. */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the command and its outcome, or the review evidence behind it. */
  evidence: string;
  /** "verified" only when a deterministic check or an independent confirmer established it. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

/** Availability of one thing the comparison needs, decided by a deterministic check or the probe. */
interface ProbeResult {
  /** "reachable" | "unreachable" | "unverified" — staging, from a SELECT 1 with the URL read at run time. */
  staging: string;
  /** "fetched" | "unavailable" | "unverified" — production, from the run-time Railway fetch (CLAUDE.local.md:52). */
  production: string;
  /** Masked endpoint host:port, or "n/a". Never a connection string, never a password. */
  stagingEndpoint: string;
  /** Masked endpoint host:port, or "n/a". Never a connection string, never a password. */
  productionEndpoint: string;
  /** "ran" | "unavailable-script" | "failed" — the SKILL.md:29–42 warmup drift check. */
  warmupDrift: string;
  /** Warmup drift script summary (table deltas), or the reason it could not run. */
  warmupDriftSummary: string;
  /** How each status was determined: command shapes only, never credential values. */
  evidence: string;
}

/** The run owner's decision when production credentials could not be fetched at run time. */
interface FallbackDecision {
  /** True = continue comparing staging-only; false = stop rather than report a partial parity claim. */
  proceedStagingOnly: boolean;
  /** What the owner said, for the record. */
  summary: string;
}

interface EntitySpec {
  /** Short ascii slug used in subagent names and generated file names. */
  slug: string;
  /** Postgres table (or Prisma model mapped to one) whose counts are compared. */
  table: string;
  /** Secondary dimensions to compare (unique counts, tier/category distributions), per SKILL.md:65–102. */
  dimensions: string[];
  /** Child tables whose counts must also be checked, per SKILL.md:176–199; empty when none. */
  childTables: string[];
}

interface EntityScope {
  /** The entities the run's question turns on, in priority order. */
  entities: EntitySpec[];
  /** Why these entities answer the question; names the schema files read. */
  rationale: string;
}

interface EntityComparison {
  /** Echoes the EntitySpec slug. */
  slug: string;
  /** Echoes the compared table. */
  table: string;
  /** "full" (both environments) or "staging-only". */
  mode: string;
  /** Staging total row count; null when the comparison could not run — never a fabricated zero. */
  stagingCount: number | null;
  /** Production total row count; null when production was unavailable — never a guess. */
  productionCount: number | null;
  /** Signed delta string ("+123", "0", "n/a"). */
  delta: string;
  /** Per-dimension staging vs production counts; production null when unavailable. */
  dimensions: { label: string; staging: number; production: number | null }[];
  /** Child-table coverage rows per SKILL.md:176–199; empty only when the spec had none. */
  childTables: { table: string; staging: number; production: number | null; drift: string }[];
  /** Last-recorded item per environment, or "none" (SKILL.md:82–87, :164–170). */
  lastRecordNote: string;
  /** Which of the 8 pitfalls (SKILL.md:202–216) applied and how, each citing its line. */
  pitfallsApplied: string[];
  /** "compared" | "unavailable" | "failed" for the production side. */
  prodStatus: string;
  /** Commands run, in shape only (env var NAMES, never values). */
  evidence: string;
  /** Anything the run owner should know about this comparison. */
  concerns: string[];
}

interface CountConfirmation {
  /** Echoes the compared slug. */
  slug: string;
  /** True when the independent recount reproduced the headline numbers exactly. */
  confirmed: boolean;
  /** The confirmer's own staging count; null when it could not run one. */
  independentStagingCount: number | null;
  /** The confirmer's own production count; null when unavailable or not runnable. */
  independentProductionCount: number | null;
  /** Every mismatch found, stated as "field: expected X, got Y". */
  discrepancies: string[];
  /** The commands the confirmer itself ran, in shape only. */
  evidence: string;
}

interface RemediationPlan {
  /** Status-drift fixes: UPDATE-only, from references/status-drift-cleanup.md:51–75. */
  statusDriftFixes: { table: string; fixCommand: string; referenceCited: string }[];
  /** Inactive-orphan cleanup plans, from references/status-drift-cleanup.md:77–101 and SKILL.md:216. */
  orphanCleanups: string[];
  /** Post-fix verification steps (materialized-view refresh, drift re-check), from references/status-drift-cleanup.md:103–111. */
  postFixVerification: string[];
  /** When a sync would be the remedy: the pre-flight steps that MUST run first, from references/sync-pre-flight.md. */
  syncPreFlightRequired: string[];
  /** "clean" when no drafted fix contains TRUNCATE or DELETE; "violations-found" otherwise. */
  truncateDeleteCheck: string;
  /** Any TRUNCATE/DELETE drafting slips, quoted. */
  violations: string[];
  summary: string;
}

interface WriteApproval {
  /** The proposed write, as prepared. */
  write: string;
  /** True only when the human run owner approved it through escalation. */
  approved: boolean;
  /** How the decision was obtained: "escalation-answer" or "unreachable". */
  obtainedBy: string;
}

interface WriteGateDecision {
  /** One entry per proposed write. */
  decisions: WriteApproval[];
  /** What was escalated and what came back. */
  summary: string;
}

interface ComplianceAudit {
  /** True when every comparison carried the entity-progress template (SKILL.md:43–175). */
  templateCarried: boolean;
  /** True when every comparison carried the child-table coverage check (SKILL.md:176–199). */
  childCoverageCarried: boolean;
  /** True when every comparison addressed the 8 pitfalls (SKILL.md:200–217). */
  pitfallsCarried: boolean;
  /** True when no credential material appears in any result, file, or plan. */
  credentialsClean: boolean;
  /** True when every proposed write is UPDATE-only, pre-flighted for sync, and owner-gated. */
  writeRoutingClean: boolean;
  /** True when the "8 steps is a pitfall count" disclosure is present where it matters. */
  disclosureCarried: boolean;
  /** Problems found, one per lens that failed or has a caveat. */
  concerns: { lens: string; concern: string; severity: "low" | "medium" | "high" }[];
  summary: string;
}

interface ReportDraft {
  /** The full markdown report. */
  markdown: string;
}

interface TableRow {
  /** Entity or "entity · child table" label; the dashboard key. */
  entity: string;
  staging: string;
  production: string;
  delta: string;
  confirmation: string;
}

// ─── Constants (control flow only — never interpolated into ask text) ────────

const SKILL_DIR = "/Users/alejandrodelvillar/.agents/skills/cross-env-data-comparison";
const SKILL_MD = `${SKILL_DIR}/SKILL.md`;
const SYNC_PRE_FLIGHT = `${SKILL_DIR}/references/sync-pre-flight.md`;
const STATUS_DRIFT_CLEANUP = `${SKILL_DIR}/references/status-drift-cleanup.md`;
const COMPARE_OUT_DIR = "out/cross-env-compare";
/** Fan-out cap. Entities beyond this are disclosed in notCovered, never silently dropped. */
const MAX_ENTITIES = 8;

// Slugs are LLM-emitted and land in generated file names and dashboard keys:
// sanitize to ascii and suffix the fan-out index so duplicate slugs and path
// separators cannot collide (review round 2).
function safeSlug(raw: string, index: number): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${cleaned === "" ? "entity" : cleaned}-${index + 1}`;
}

// ─── Run question (args) ─────────────────────────────────────────────────────

const ownerQuestion = typeof args.question === "string" ? args.question.trim() : "";
const ownerEntities = typeof args.entities === "string" ? args.entities.trim() : "";

// ─── Dashboard: one row per entity, replaced in place as confirmations land ──

artifact.table("env-compare", {
  title: "Staging vs production, entity by entity",
  description: "Counts land as each comparison finishes and update when the independent recount confirms them.",
  key: "entity",
  columns: [
    { field: "entity", label: "Entity" },
    { field: "staging", label: "Staging" },
    { field: "production", label: "Production" },
    { field: "delta", label: "Delta" },
    { field: "confirmation", label: "Confirmation" },
  ],
});

// ─── Findings: salvage by report (§10) ───────────────────────────────────────

const allFindings: Finding[] = [];
function emitFinding(finding: Finding): void {
  allFindings.push(finding);
  report(finding);
}

// ─── Shared personas (created once, top level; unique names run-wide) ────────

const READ_ONLY_RULES =
  "This is a READ-ONLY comparison against LIVE Railway staging/production Postgres. Run only " +
  "SELECT/COUNT/explain-level statements. Never run TRUNCATE, DELETE, UPDATE, INSERT, ALTER, DROP, " +
  "CREATE, or any migration against any database. Never write a connection string, password, or " +
  "credential value into a returned result, a generated file, or any text you produce — read " +
  "connection strings from CLAUDE.local.md or the Railway CLI at run time in your own shell and " +
  "keep them there. When citing evidence, name the command shape and env var NAMES, not values. " +
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say " +
  "so plainly rather than working around it or inventing numbers.";

const probe = agent("connection-probe", {
  system:
    "You are the availability probe for the cross-env-data-comparison skill at " +
    `${SKILL_MD}. You establish, without faking anything, what this comparison can reach. ` +
    READ_ONLY_RULES,
});

const scoper = agent("scope-planner", {
  system:
    "You plan comparison scope for the cross-env-data-comparison skill at " +
    `${SKILL_MD}. You read the workspace schema (prisma/schema.prisma) and the skill, and name ` +
    "the entities whose staging-vs-production counts answer the run's question. You do not run " +
    "database commands and you do not edit files. Cite path:line for every claim. If the run's " +
    "question is too vague to scope, escalate and ask rather than guessing. " +
    READ_ONLY_RULES,
});

const remediationPlanner = agent("remediation-planner", {
  system:
    "You prepare remediation plans for the cross-env-data-comparison skill at " +
    `${SKILL_MD}. You never execute anything against any database — you draft exact commands ` +
    "for the human run owner to approve and run. Cite path:line for every pattern you use. " +
    READ_ONLY_RULES,
});

const auditor = agent("skill-compliance-auditor", {
  system:
    "You are an independent auditor who has seen nothing but the collected results handed to you. " +
    `Read ${SKILL_MD} in full and audit the collected results against it. Report gaps only: ` +
    "what is missing, unsupported, or unsafe. You never edit files and never run database " +
    "commands. Cite path:line from the skill for every claim.",
});

const writeGate = agent("write-approval-gate", {
  system:
    "You are the write-approval gate for this run. Your only job: escalate to the human run " +
    "owner with the escalate tool ONCE, presenting the complete numbered list of proposed " +
    "writes — exactly what would run, on which environment, and why — and requesting one " +
    "answer that approves or denies each item by number. Record every decision. Never approve " +
    "a write on your own authority; never execute anything yourself; never soften a proposed " +
    "write; never split the list across several escalations (one ask gets three escalations " +
    "at most, so a per-item escalation loop would strand every write past the third). If the " +
    "escalation cannot reach the owner, return obtainedBy \"unreachable\" and approved false " +
    "for every item — do not guess what the owner would have said.",
});

const fallbackGate = agent("staging-only-decision-gate", {
  system:
    "You are a decision gate for this run. Your only job: escalate one blocking question to the " +
    "human run owner with the escalate tool and return their decision verbatim. Never decide on " +
    "your own authority; if the escalation cannot reach the owner, return the conservative " +
    "outcome (stop) and say the owner could not be reached.",
});

const writer = agent("report-writer", {
  system:
    "You write structured data-comparison reports from the results handed to you. Never invent " +
    "numbers or outputs not present in the input; never include credential material of any kind. " +
    "Mark unavailable data as unavailable — a gap is a fact, not a defect to paper over. Flag what " +
    "was not verified.",
});

// Publish helper: every publish carries primary:true and a try/catch compact
// fallback (batch-1 defect register), and the fallback itself never kills the run.
async function publishReport(markdown: string, compactMarkdown: string, title: string, description: string): Promise<void> {
  try {
    await artifact.markdown("cross-env-compare-report", markdown, { title, description, primary: true });
  } catch {
    try {
      await artifact.markdown("cross-env-compare-report", compactMarkdown, {
        title: `${title} (compact fallback)`,
        description: "The full report could not be published; this is the compact form of the same facts.",
        primary: true,
      });
    } catch {
      log("The report artifact could not be published in either form; the return value carries the findings.");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Deterministic availability gate: check before anyone touches data.
// world.run decides what it can (commands that need no credentials); the probe
// establishes live connectivity; production availability routes to the run owner.
// When something required is missing, this phase ABSTAINS (blocked report, no
// fabricated numbers) or ESCALATES — it never fakes its way past a gap.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Check what this comparison needs before reading any data");

// Deterministic checks. The awk anchor check prints only a count, so no
// credential value ever enters the script's memory; a zero count (or nonzero
// exit) means the staging anchor is missing.
const skillPresent = await world.run("ls", [SKILL_MD]);
const preFlightPresent = await world.run("ls", [SYNC_PRE_FLIGHT]);
const cleanupPresent = await world.run("ls", [STATUS_DRIFT_CLEANUP]);
const driftScript = await world.run("ls", ["scripts/detect-data-drift.sh"]);
const prismaClient = await world.run("ls", ["node_modules/@prisma/client"]);
const pgClient = await world.run("ls", ["node_modules/pg"]);
// Scoped to the Staging section so the production pin at CLAUDE.local.md:49
// cannot satisfy it; prints a count only — no credential value enters the run.
const stagingAnchor = await world.run(
  "awk",
  ["/^## Staging/,/^## Production/ { if (/proxy[.]rlwy[.]net/) anchors++ } END { print anchors + 0 }", "CLAUDE.local.md"],
);

const skillAvailable = skillPresent.exitCode === 0 && preFlightPresent.exitCode === 0 && cleanupPresent.exitCode === 0;
const driverAvailable = prismaClient.exitCode === 0 || pgClient.exitCode === 0;
const stagingUrlPresent = stagingAnchor.exitCode === 0 && stagingAnchor.stdout.trim() !== "0";
const warmupScriptPresent = driftScript.exitCode === 0;

log(
  `Availability: skill refs ${skillAvailable ? "present" : "MISSING"}, driver ${driverAvailable ? "present" : "MISSING"}, ` +
    `staging URL anchor ${stagingUrlPresent ? "present" : "MISSING"}, warmup drift script ${warmupScriptPresent ? "present" : "absent"}.`,
);

if (warmupScriptPresent) {
  emitFinding({
    where: "Phase 1: warmup drift check (SKILL.md:29–42)",
    what: "scripts/detect-data-drift.sh exists — the automated 19-table warmup check can run",
    evidence: "world.run ls scripts/detect-data-drift.sh exited 0",
    status: "verified",
    severity: "low",
  });
} else {
  emitFinding({
    where: "Phase 1: warmup drift check (SKILL.md:29–42)",
    what: "scripts/detect-data-drift.sh is absent — the automated warmup check cannot run and will not be simulated",
    evidence: "world.run ls scripts/detect-data-drift.sh exited nonzero",
    status: "verified",
    severity: "medium",
  });
}

// One probe ask establishes live connectivity for both environments. The probe
// reads the staging URL from CLAUDE.local.md at run time and fetches production
// from Railway (CLAUDE.local.md:52 policy — the pinned :49 value is stale; see
// header). It escalates only on contradictions; unavailability is a returned
// value, and the decision about it belongs to the run owner, not the probe.
const probeResult = await probe.ask<ProbeResult>(
  "Establish what this comparison can reach. Reference: " +
    `${SKILL_MD} lines 23–27 (Prerequisites) and lines 29–42 (warmup drift check); ` +
    "CLAUDE.local.md lines 72/76/107/114 (command recipes carrying the staging DATABASE_URL; " +
    "the Staging section also pins it at :37) and line 52 (production secrets are deliberately " +
    "not pre-pinned — fetch from Railway only when an authorized operation needs them; this " +
    "run's staging-vs-production comparison is that authorized operation).\n\n" +
    "Do each of these in your own shell, never returning a credential value:\n" +
    "1. STAGING: read the staging DATABASE_URL from CLAUDE.local.md at run time, run SELECT 1, " +
    "and report reachable/unreachable plus the endpoint as bare host:port only.\n" +
    "2. PRODUCTION: fetch the production DATABASE_URL from Railway with the railway CLI at run " +
    "time. Note in your evidence that CLAUDE.local.md:49 pins a junction.proxy.rlwy.net value " +
    "that the production-sync-procedure skill supersedes with trolley.proxy.rlwy.net:50919, so " +
    "the Railway fetch — not the pinned value — is the source of truth. If the CLI is missing, " +
    "cannot authenticate, or cannot find the production database, report production " +
    '"unavailable" — do NOT fall back to the pinned :49 value, and do NOT escalate (the run ' +
    "owner decides what unavailability means).\n" +
    "3. WARMUP DRIFT (SKILL.md:29–42): if scripts/detect-data-drift.sh exists, run it with the " +
    "staging DATABASE_URL (bash scripts/detect-data-drift.sh --json) and summarize which of the " +
    "19 tables drift; if it is absent, report warmupDrift \"unavailable-script\". Do not write " +
    "the script or a stand-in for it.\n\n" +
    "Return a ProbeResult. stagingEndpoint/productionEndpoint carry bare host:port, never a " +
    "connection string. evidence names command shapes only.",
);

let mode: "full" | "staging-only" = "full";
let abortReason = "";

if (!skillAvailable || !driverAvailable || !stagingUrlPresent || probeResult.staging !== "reachable") {
  abortReason = !skillAvailable
    ? "the skill or its reference files are not readable at their absolute paths"
    : !driverAvailable
      ? "neither @prisma/client nor pg is installed, so no supported driver can run the comparison"
      : !stagingUrlPresent
        ? "CLAUDE.local.md carries no Railway database URL anchor, so no staging connection can be read at run time"
        : "the staging database did not answer SELECT 1";
} else if (probeResult.production !== "fetched") {
  // Production unavailable: the run owner decides. One escalation point for the
  // whole run — the fan-out is told the decision rather than each ask re-asking.
  const fallback = await fallbackGate.ask<FallbackDecision>(
    "Production credentials could not be fetched from Railway at run time " +
      `(probe status: ${probeResult.production}; probe evidence: ${probeResult.evidence}). ` +
      "CLAUDE.local.md:52 policy: production secrets are fetched only when an authorized " +
      "operation needs them, and production access must not be faked from stale pinned values. " +
      "Escalate to the run owner: continue with a STAGING-ONLY comparison (production columns " +
      "reported as unavailable, no parity deltas), or stop the run rather than report a " +
      "one-sided number? Return their decision.",
  );
  if (fallback.proceedStagingOnly) {
    mode = "staging-only";
    emitFinding({
      where: "Phase 1: production availability",
      what: 'Run owner approved continuing staging-only; production columns will read "unavailable", not zero',
      evidence: fallback.summary,
      status: "verified",
      severity: "medium",
    });
  } else {
    abortReason = `the run owner declined to continue without production access (${fallback.summary})`;
  }
}

if (abortReason !== "") {
  log(`Abstaining: ${abortReason} — no comparison numbers will be produced.`);
  const blockedMd = [
    "# Cross-environment comparison — abstained at the availability gate",
    "",
    "This run produced NO comparison numbers: a required input was unavailable, and the skill's",
    "contract (and this workflow's) is to abstain rather than fake a number.",
    "",
    `Reason: ${abortReason}.`,
    "",
    "## Availability findings",
    ...allFindings.map((f) => `- [${f.status}] ${f.what} — ${f.evidence}`),
    "",
    "## What would unblock a re-run",
    `- The skill readable at ${SKILL_MD} (with references/sync-pre-flight.md and references/status-drift-cleanup.md)`,
    "- @prisma/client or pg installed in the workspace",
    "- A Railway staging URL present in CLAUDE.local.md and answering SELECT 1",
    "- For both-environment parity: production credentials fetchable from Railway at run time (CLAUDE.local.md:52)",
  ].join("\n");
  await publishReport(
    blockedMd,
    `# Cross-environment comparison — abstained\n\nReason: ${abortReason}. No numbers were produced.`,
    "Cross-environment comparison — abstained",
    "The availability gate blocked the run; nothing was compared and no numbers were produced.",
  );
  const blocked: WorkflowReport = {
    conclusion: `Abstained before comparing anything: ${abortReason}. No numbers were produced or guessed.`,
    findings: allFindings,
    verified: [
      "Availability was decided by deterministic checks: world.run ls on the skill file, both reference files, scripts/detect-data-drift.sh, node_modules/@prisma/client and node_modules/pg, and world.run awk counting proxy.rlwy.net matches inside the CLAUDE.local.md Staging section only (count only — no credential value entered the run).",
      `The connectivity probe reported: staging ${probeResult.staging}, production ${probeResult.production}, warmup drift ${probeResult.warmupDrift} (${probeResult.evidence}).`,
    ],
    notCovered: [
      "No entity was compared and no count was taken — the gate stopped the run.",
      "Production connectivity beyond the probe's report.",
    ],
  };
  return blocked;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Scope: which entities and child tables answer the run's question.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Pick the entities and child tables to compare");

const scope = await scoper.ask<EntityScope>(
  (ownerQuestion
    ? `The run owner's question for this comparison: "${ownerQuestion}".\n\n`
    : "The run owner gave no specific question; scope the comparison to the entities this " +
      "workspace's data model turns on.\n\n") +
    (ownerEntities
      ? `The run owner also named these entities to include (verify each against the schema and ` +
        `correct the table names if needed): ${ownerEntities}.\n\n`
      : "") +
    "Reference: " +
    `${SKILL_MD} lines 16–21 (when to use), lines 43–175 (the entity-progress template and its ` +
    "EnvStats shape — total count, unique secondary dimension, last record, tier/category " +
    "distribution), lines 176–199 (child-table coverage: tables with FK references to the target " +
    "tables; the corridor_* list at :182–186 is the skill's illustration, NOT this schema's " +
    "tables — derive child tables from the actual schema's relations), and lines 223–225 (the " +
    "port-visit example).\n\n" +
    "Read prisma/schema.prisma and name the entities (tables) whose staging-vs-production counts " +
    "answer the question, each with: an ascii slug, the table name, the secondary dimensions " +
    "worth comparing, and the child tables (FK-derived) whose coverage must be checked. Prefer " +
    "the entities the question turns on; the script caps the fan-out and discloses anything " +
    "beyond the cap.\n\n" +
    "Return an EntityScope.",
);

const compareUnits = scope.entities
  .slice(0, MAX_ENTITIES)
  .map((spec, index) => ({ ...spec, slug: safeSlug(String(spec.slug), index) }));
const overflow = scope.entities.slice(MAX_ENTITIES);
log(
  `Comparing ${compareUnits.length} entities` +
    (overflow.length > 0 ? `; ${overflow.length} scoped entities beyond the cap are disclosed in the report` : ""),
);

if (overflow.length > 0) {
  emitFinding({
    where: "Phase 2: scope",
    what: `Scope named ${scope.entities.length} entities; the fan-out cap limits this run to the first ${MAX_ENTITIES} — the remainder (${overflow
      .map((e) => e.table)
      .join(", ")}) are disclosed, not compared`,
    evidence: scope.rationale,
    status: "verified",
    severity: "low",
  });
}

if (compareUnits.length === 0) {
  log("Scoping returned no entities — stopping without producing numbers.");
  await publishReport(
    "# Cross-environment comparison — nothing to compare\n\nScoping returned an empty entity list; no numbers were produced.",
    "# Cross-environment comparison — nothing to compare\n\nScoping returned an empty entity list.",
    "Cross-environment comparison — nothing to compare",
    "Scoping produced no entities; no numbers were produced.",
  );
  const noscope: WorkflowReport = {
    conclusion: "Stopped after scoping: no entities to compare. No numbers were produced.",
    findings: allFindings,
    verified: [`Availability gate passed; scope rationale: ${scope.rationale}`],
    notCovered: ["No entity was compared — scoping produced an empty entity list."],
  };
  return noscope;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Per-entity comparison with independent confirmation, chained per
// item and joined once (§7): each entity's recount starts the moment its
// comparison lands. One phase marker at the top level, none inside callbacks.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Compare each entity and confirm every count independently");

function dashboardRow(c: EntityComparison, confirmation: string): TableRow {
  return {
    entity: c.slug,
    staging: c.stagingCount === null ? "not measured" : c.stagingCount.toLocaleString("en-US"),
    production: c.productionCount === null ? "unavailable" : c.productionCount.toLocaleString("en-US"),
    delta: c.delta,
    confirmation,
  };
}

// One bad entity costs one item, not the run (§7): allSettled keeps a failed or
// schema-invalid result from rejecting the whole join; the mapping below turns
// every rejection into a degraded record with an unconfirmed finding.
interface EntityRecord {
  comparison: EntityComparison;
  confirmation: CountConfirmation;
}

function degradedRecord(unit: EntitySpec, failure: string): EntityRecord {
  return {
    comparison: {
      slug: unit.slug,
      table: unit.table,
      mode,
      stagingCount: null,
      productionCount: null,
      delta: "n/a",
      dimensions: [],
      childTables: [],
      lastRecordNote: "none",
      pitfallsApplied: [],
      prodStatus: "failed",
      evidence: "",
      concerns: [`Comparison did not complete: ${failure}`],
    },
    confirmation: {
      slug: unit.slug,
      confirmed: false,
      independentStagingCount: null,
      independentProductionCount: null,
      discrepancies: ["comparison did not complete — nothing was recounted"],
      evidence: "",
    },
  };
}

const settled = await Promise.allSettled(
  compareUnits.map(async (unit, index) => {
    const comparison = await agent(`entity-compare-${index + 1}-${unit.slug}`).ask<EntityComparison>(
      `Compare the table "${unit.table}" (slug ${unit.slug}) between staging and production, as ` +
        `part of answering: ${ownerQuestion || "the run owner's staging-vs-production parity question"}.\n\n` +
        `Reference: ${SKILL_MD}. EVERY comparison in this run must carry all three of these, and ` +
        "your result must show it:\n" +
        "1. THE ENTITY-PROGRESS TEMPLATE (SKILL.md:43–175): write " +
        `${READ_ONLY_RULES}\n\n` + `${COMPARE_OUT_DIR}/${unit.slug}-progress.ts following the template (EnvStats shape, ` +
        "STAGING vs PRODUCTION rows, DELTA column, optional tier distribution and last record) " +
        "customized to this table, then run it with npx tsx. Adaptation: read BOTH connection " +
        "URLs from the environment only (env vars at run time) — the template's fallback " +
        "literal URLs at :62–63 must NOT be copied; this workspace's out/ directory is " +
        "gitignored (.gitignore:8), which satisfies pitfall 1 (SKILL.md:202) without putting " +
        "anything credential-adjacent in a tracked path.\n" +
        "2. THE CHILD-TABLE COVERAGE CHECK (SKILL.md:176–199): compare counts for these child " +
        `tables from the scope: ${unit.childTables.join(", ") || "(none named — derive any FK children yourself)"}; ` +
        "AND any further FK-derived children you find in the schema. The corridor_* list at " +
        ":182–186 is the skill's illustration from another schema — verify against this " +
        "workspace's prisma/schema.prisma, and say in the result which children you checked " +
        "and which do not exist here. A parent can be in sync while its children drift.\n" +
        "3. ALL 8 PITFALLS (SKILL.md:200–217). Address each in pitfallsApplied with its line: " +
        ":202 gitignore the compare script; :204 groupBy/_count or raw aggregation instead of " +
        "distinct over hundreds of thousands of rows; :206 before any sync talk, the pre-flight " +
        "checklist applies (you are not syncing — just route any sync remedy there); :208 " +
        'always report against the production baseline, never a staging-only "X new records"; ' +
        ":210 format dates as ISO (toISOString().split('T')[0]) not system locale; :212 add " +
        "connection_limit=2 to both clients so two pools do not exhaust Railway's limit; :214 " +
        "silent status drift — identical row sets with different status values — is detected by " +
        "comparing status distributions, and its fix is UPDATE-only per " +
        `${STATUS_DRIFT_CLEANUP} lines 51–75 (TRUNCATE/DELETE prohibited); :216 inactive-orphan ` +
        "cleanup (active itineraries referencing inactive ships/lines) via the skill's query.\n\n" +
        "DISCLOSURE you must carry into your result and any summary you write: the batch " +
        'description of this skill as "8 steps" refers to the 8 PITFALLS at SKILL.md:200–217, ' +
        "not an 8-stage procedure; the procedure is the template plus the coverage check plus " +
        "the pitfalls as constraints.\n\n" +
        `Connections (mode for this run: ${
          mode === "full"
            ? "both environments"
            : 'STAGING-ONLY by run-owner decision — do not fetch production, return prodStatus "unavailable" and null counts'
        }):\n` +
        "- STAGING: read DATABASE_URL from CLAUDE.local.md at run time in your own shell " +
        "(command recipes cite it at :72/:76/:107/:114; the Staging section pins it at :37). " +
        "Never copy the value into any file, command output you return, or text.\n" +
        "- PRODUCTION (only in full mode): fetch from Railway with the railway CLI at run time " +
        "per CLAUDE.local.md:52 (the pinned :49 value is stale — do not use it). If the fetch " +
        'fails, return prodStatus "unavailable" with null production numbers — never a guess ' +
        "or a zero.\n" +
        "- Set connection_limit=2 on both clients (SKILL.md:212).\n\n" +
        "Return an EntityComparison. productionCount is null when production was not compared. " +
        "evidence names commands and env var NAMES only — no connection strings, no passwords. " +
        "If the numbers will not come without violating a rule above, escalate instead of " +
        `faking them.\n\n${READ_ONLY_RULES}`,
    );

    report(dashboardRow(comparison, "recount pending"), "env-compare");

    // Independent recount by a fresh subagent that has not seen the executor's
    // work: the finder of a number does not get to confirm it (§10).
    const confirmation = await agent(`count-confirm-${index + 1}-${unit.slug}`).ask<CountConfirmation>(
      `Independently re-derive the headline counts for "${unit.table}" (slug ${unit.slug}) and ` +
        "check the claimed numbers below. Do NOT read or run the compare script another agent " +
        `wrote under ${COMPARE_OUT_DIR}/ — write your own queries (psql or a one-off Prisma ` +
        "snippet) from scratch. Staging: read DATABASE_URL from CLAUDE.local.md in your own " +
        "shell" +
        (mode === "full"
          ? "; Production: fetch from Railway with the railway CLI per CLAUDE.local.md:52"
          : "; this run is staging-only by run-owner decision — do not fetch production, return independentProductionCount null") +
        ". connection_limit=2 on any Prisma client (SKILL.md:212). Read-only: SELECT/COUNT " +
        "only; never TRUNCATE, DELETE, UPDATE, INSERT, or DDL; never return a credential value.\n\n" +
        `Claimed numbers (JSON):\n${JSON.stringify(
          {
            stagingCount: comparison.stagingCount,
            productionCount: comparison.productionCount,
            dimensions: comparison.dimensions,
            childTables: comparison.childTables,
          },
          null,
          2,
        )}\n\n` +
        "Return a CountConfirmation: confirmed true only when the claimed staging count is a " +
        "number (not null) and your own recount reproduces it exactly" +
        (mode === "full"
          ? " AND the claimed production count is a number (not null) and your recount reproduces it exactly"
          : "") +
        "; list every mismatch in discrepancies with expected vs got. evidence names " +
        "your commands in shape only.",
    );

    report(
      dashboardRow(comparison, confirmation.confirmed ? "confirmed by independent recount" : "MISMATCH — see findings"),
      "env-compare",
    );

    if (!confirmation.confirmed) {
      emitFinding({
        where: `Phase 3: ${unit.slug} (${unit.table})`,
        what: "Independent recount did not reproduce the comparison's headline numbers",
        evidence: `${confirmation.discrepancies.join("; ") || "confirmer could not reproduce"} | confirmer evidence: ${confirmation.evidence}`,
        status: "unconfirmed",
        severity: "high",
      });
    } else {
      emitFinding({
        where: `Phase 3: ${unit.slug} (${unit.table})`,
        what:
          mode === "full"
            ? `Staging ${comparison.stagingCount === null ? "not measured" : comparison.stagingCount.toLocaleString("en-US")} vs production ${comparison.productionCount === null ? "unavailable" : String(comparison.productionCount)} (${comparison.delta}), confirmed by independent recount`
            : `Staging ${comparison.stagingCount === null ? "not measured" : comparison.stagingCount.toLocaleString("en-US")} (staging-only run), confirmed by independent recount`,
        evidence: confirmation.evidence,
        status: "verified",
        severity: "low",
      });
    }

    for (const child of comparison.childTables) {
      if (child.drift !== "0" && child.drift !== "") {
        emitFinding({
          where: `Phase 3: ${unit.slug} child table ${child.table}`,
          what: `Child-table drift: staging ${child.staging} vs production ${
            child.production === null ? "unavailable" : child.production
          } (drift ${child.drift}) — SKILL.md:176–199; not independently recounted`,
          evidence: comparison.evidence,
          status: "unconfirmed",
          severity: "medium",
        });
      }
    }

    for (const concern of comparison.concerns) {
      emitFinding({
        where: `Phase 3: ${unit.slug}`,
        what: concern,
        evidence: comparison.evidence,
        status: "unconfirmed",
        severity: "medium",
      });
    }

    return { comparison, confirmation };
  }),
);

const perEntity: EntityRecord[] = settled.map((outcome, index) => {
  if (outcome.status === "fulfilled") return outcome.value;
  const unit = compareUnits[index];
  const failure = outcome.status === "rejected" ? String(outcome.reason) : "unknown";
  const degraded = degradedRecord(unit, failure);
  emitFinding({
    where: `Phase 3: ${unit.slug} (${unit.table})`,
    what: "Comparison failed and was skipped — this entity cost one item, not the run",
    evidence: failure,
    status: "unconfirmed",
    severity: "high",
  });
  report(dashboardRow(degraded.comparison, "failed — see findings"), "env-compare");
  return degraded;
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Route drift into safe, owner-approved fix plans. Nothing executes:
// the plans are prepared, every write goes through the escalation gate.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Route any drift into safe, owner-approved fix plans");

const remediation = await remediationPlanner.ask<RemediationPlan>(
  "Draft the remediation plan for the drift found in these results (an empty plan that says so " +
    "is a valid answer when nothing drifted).\n\n" +
    `Collected comparisons and confirmations (JSON):\n${JSON.stringify({ perEntity }, null, 2)}\n\n` +
    "FIX ROUTING, which is mandatory:\n" +
    "- Status drift (same row sets, different status/categorical values) is UPDATE-only, via " +
    `${STATUS_DRIFT_CLEANUP}: detection :5–12, CSV comparison for 100K+ rows :14–29, profile ` +
    "before fixing :31–49, the temp-table UPDATE fix :51–75, orphan cleanup :77–101, and the " +
    "post-fix verification (REFRESH MATERIALIZED VIEW dashboard_stats, re-run drift check) " +
    ":103–111. Pitfalls :113–118 apply: always on staging first (:117), never IN (...) with " +
    "5K+ ids — temp table plus \\copy (:118). SKILL.md:214 is the same pattern.\n" +
    "- TRUNCATE and DELETE are prohibited everywhere in this plan; if any drafted fix wants " +
    "one, record it under violations and replace the approach with the UPDATE pattern.\n" +
    "- If a sync would otherwise be the remedy, it is gated behind " +
    `${SYNC_PRE_FLIGHT}: migration status :7–14, deploy pending migrations :18–22, verify ` +
    "tables exist :26–36, verify Prisma column mapping on BOTH environments :52–72, dry-run " +
    ":40–44 — list those as syncPreFlightRequired steps that must run first; do not draft the " +
    "sync itself.\n" +
    "- Everything you draft is PREPARED, NOT EXECUTED: each item reads as awaiting run-owner " +
    "approval and human execution.\n\n" +
    'Return a RemediationPlan with truncateDeleteCheck "clean" or "violations-found".',
);

const proposedWrites: string[] = [
  ...remediation.statusDriftFixes.map((f) => `${f.table}: ${f.fixCommand}`),
  ...remediation.orphanCleanups,
];

let gateDecision: WriteGateDecision | null = null;
if (proposedWrites.length > 0) {
  gateDecision = await writeGate.ask<WriteGateDecision>(
    "These writes are prepared but NOT executed. Escalate ONCE to the run owner: present this " +
      "complete numbered list — what would run, on which environment (staging first per " +
      `${STATUS_DRIFT_CLEANUP}:117), and why — and ask for one answer that approves or denies ` +
      "each item by number. Do not escalate per item: one ask gets three escalations at most, " +
      "and a longer list would strand writes past the third. Then record every decision.\n\n" +
      `Proposed writes (JSON):\n${JSON.stringify(proposedWrites, null, 2)}\n\n` +
      "Return a WriteGateDecision with one decision per write. approved true only on an " +
      'explicit owner yes through escalation; obtainedBy "unreachable" when the owner could ' +
      "not be reached. You never execute anything yourself.",
  );
  for (const d of gateDecision.decisions) {
    emitFinding({
      where: "Phase 4: write-approval gate",
      what: d.approved
        ? `Run owner APPROVED (via escalation, still awaiting human execution): ${d.write}`
        : `Write NOT approved (${d.obtainedBy}); plan remains prepared-only: ${d.write}`,
      evidence: gateDecision.summary,
      status: "verified",
      severity: d.approved ? "low" : "medium",
    });
  }
} else {
  log("No writes proposed — the remediation plan is prepared-only with an empty write set.");
}

if (remediation.truncateDeleteCheck !== "clean") {
  emitFinding({
    where: "Phase 4: fix routing",
    what: "TRUNCATE or DELETE appeared in drafted fixes — prohibited; the plan must be redrafted as UPDATE-only",
    evidence: remediation.violations.join(" | ") || remediation.summary,
    status: "unconfirmed",
    severity: "high",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5 — Independent audit against the skill, plus the deterministic
// credential-leak check over everything the run wrote to the workspace.
// ═══════════════════════════════════════════════════════════════════════════════

phase("Audit the comparison against the skill");

// Deterministic leak gate: any generated script carrying a literal postgres or
// postgresql URL with embedded credentials fails here (the pattern covers both
// schemes — the template fallback literals at SKILL.md:62–63 are postgresql://).
// The command prints file NAMES only (-l), never match text, so no credential
// value enters the run.
const leakScan = await world.run("grep", ["-rlE", 'postgres(ql)?://[^@"\' ]+@', COMPARE_OUT_DIR]);
if (leakScan.exitCode === 0) {
  emitFinding({
    where: "Phase 5: credential leak check",
    what: "A generated compare script contains a literal connection string with embedded credentials — remove it and re-write the script env-only (SKILL.md:202)",
    evidence: `world.run grep -rlE with the postgres(ql)?:// credential-URL pattern over ${COMPARE_OUT_DIR} exited 0; files named: ${leakScan.stdout.trim()}`,
    status: "verified",
    severity: "high",
  });
} else if (leakScan.exitCode === 1) {
  emitFinding({
    where: "Phase 5: credential leak check",
    what: "No literal credential-bearing connection string in any generated compare script",
    evidence: `world.run grep -rlE with the postgres(ql)?:// credential-URL pattern over ${COMPARE_OUT_DIR} exited 1 (no matches)`,
    status: "verified",
    severity: "low",
  });
} else {
  emitFinding({
    where: "Phase 5: credential leak check",
    what: "Credential leak scan could not run (directory missing or grep error) — leak status unknown",
    evidence: `world.run grep exited ${leakScan.exitCode}: ${leakScan.stderr.trim()}`,
    status: "unconfirmed",
    severity: "medium",
  });
}

const audit = await auditor.ask<ComplianceAudit>(
  "Audit this comparison run against the skill. Reference: " +
    `${SKILL_MD} (read it in full) and the two references at ${SYNC_PRE_FLIGHT} and ` +
    `${STATUS_DRIFT_CLEANUP}.\n\n` +
    `Collected results (JSON):\n${JSON.stringify(
      {
        mode,
        probe: probeResult,
        scope,
        perEntity,
        remediation,
        writeGate: gateDecision,
        leakScan: { exitCode: leakScan.exitCode, stdoutFiles: leakScan.stdout.trim() },
      },
      null,
      2,
    )}\n\n` +
    "Six lenses, each a boolean plus concerns:\n" +
    "1. templateCarried — did EVERY comparison carry the entity-progress template (SKILL.md:43–175), shown in its result?\n" +
    "2. childCoverageCarried — did EVERY comparison carry the child-table coverage check (:176–199), schema-derived rather than copied from the corridor_* illustration?\n" +
    "3. pitfallsCarried — did EVERY comparison address all 8 pitfalls (:200–217) individually?\n" +
    "4. credentialsClean — any credential material in any result, generated file path, or plan? (The deterministic grep already ran; look for subtler leaks like endpoints with usernames.)\n" +
    "5. writeRoutingClean — every proposed write UPDATE-only (status-drift-cleanup.md:51–75), sync gated behind the pre-flight checklist (sync-pre-flight.md), TRUNCATE/DELETE absent, every write escalated to the run owner?\n" +
    '6. disclosureCarried — is the "8 steps is a pitfall count (:200–217), not an 8-stage procedure" disclosure present in the comparison results?\n\n' +
    "Also flag: any number that looks unconfirmed, any production count reported where the run " +
    "was staging-only, any claim the evidence does not support.\n\n" +
    "Return a ComplianceAudit.",
);

for (const concern of audit.concerns) {
  emitFinding({
    where: `Phase 5 audit (${concern.lens})`,
    what: concern.concern,
    evidence: audit.summary,
    status: "unconfirmed",
    severity: concern.severity,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6 — Write and publish the deliverable (compact fallback in publishReport).
// ═══════════════════════════════════════════════════════════════════════════════

phase("Write the comparison report and hand it over");

const draft = await writer.ask<ReportDraft>(
  "Write the markdown report of this staging-vs-production comparison. Use the collected results " +
    "below verbatim for every number — invent nothing. Structure: what was asked and the mode " +
    "decided; availability (warmup drift check state per SKILL.md:29–42); one table per entity " +
    "with staging/production/delta and per-dimension and child-table rows (SKILL.md:176–199); " +
    "drift findings and the prepared remediation plan (UPDATE-only, owner-gated, nothing " +
    'executed); what was NOT covered. Required disclosures: production numbers read "unavailable" ' +
    "where the run was staging-only; the warmup drift script's absence where it was absent; and " +
    'that the batch description\'s "8 steps" is the pitfall count at SKILL.md:200–217, not an ' +
    "8-stage procedure. No credential material anywhere — host:port at most. End with the " +
    "findings list, each marked verified or unconfirmed.\n\n" +
    `Collected results (JSON):\n${JSON.stringify(
      {
        mode,
        probe: probeResult,
        scope,
        perEntity,
        remediation,
        writeGate: gateDecision,
        audit,
        findings: allFindings,
        overflowEntities: overflow.map((e) => e.table),
      },
      null,
      2,
    )}`,
);

const compactRows = perEntity.map(({ comparison, confirmation }) => {
  const label = confirmation.confirmed
    ? "confirmed"
    : confirmation.discrepancies.some((d) => d.includes("comparison did not complete"))
      ? "failed"
      : "MISMATCH";
  return dashboardRow(comparison, label);
});
const compactMd = [
  `# Cross-environment comparison (${mode})`,
  "",
  `Scoped entities compared: ${perEntity.length}. Findings: ${allFindings.length} (${allFindings.filter((f) => f.status === "verified").length} verified).`,
  "",
  "| Entity | Staging | Production | Delta | Confirmation |",
  "|---|---|---|---|---|",
  ...compactRows.map((r) => `| ${r.entity} | ${r.staging} | ${r.production} | ${r.delta} | ${r.confirmation} |`),
  "",
  "Full report body could not be published; this is the compact fallback.",
].join("\n");

await publishReport(
  draft.markdown,
  compactMd,
  "Cross-environment comparison report",
  `Staging vs production (${mode === "full" ? "both environments" : "staging-only by run-owner decision"}), with confirmed counts, child-table coverage, and owner-gated fix plans.`,
);

// ─── Final WorkflowReport ─────────────────────────────────────────────────────

const confirmedCount = perEntity.filter((p) => p.confirmation.confirmed).length;
const result: WorkflowReport = {
  conclusion:
    `Compared ${perEntity.length} entities between staging and production (${
      mode === "full" ? "both environments" : "staging-only — production credentials were not fetchable and the run owner chose to continue"
    }); ` +
    `${confirmedCount} of ${perEntity.length} headline counts were confirmed by independent recount. ` +
    `Prepared ${remediation.statusDriftFixes.length + remediation.orphanCleanups.length} UPDATE-only fix plan(s), none executed; every write went through the owner-approval gate. ` +
    `${allFindings.length} findings recorded.`,
  findings: allFindings,
  verified: [
    "Availability was decided by deterministic world.run checks: ls on the skill file and both reference files, ls on scripts/detect-data-drift.sh, ls on node_modules/@prisma/client and node_modules/pg, and awk counting proxy.rlwy.net matches inside the CLAUDE.local.md Staging section only (count only — no credential value entered the run).",
    mode === "full"
      ? `The connectivity probe established staging ${probeResult.staging} and production ${probeResult.production} at run time (${probeResult.evidence}); production access came from a Railway fetch per CLAUDE.local.md:52, never from the stale pinned value at :49.`
      : `The connectivity probe established staging ${probeResult.staging} at run time (${probeResult.evidence}); production was not reached — the run is staging-only by run-owner decision, so no production-access claim is made.`,
    `Each headline count was re-derived from scratch by an independent confirmer subagent that did not read the compare script; ${confirmedCount}/${perEntity.length} reproduced exactly and only those are labelled verified.`,
    `A deterministic credential-leak grep (world.run grep -rlE with the postgres(ql)?:// credential-URL pattern over ${COMPARE_OUT_DIR}, file names only) decided whether any generated script carried a literal credential-bearing URL.`,
    "The independent auditor re-read the skill in full and audited template, child coverage, pitfalls, credentials, write routing, and disclosure.",
  ],
  notCovered: [
    ...(overflow.length > 0
      ? [`${overflow.length} scoped entities beyond the fan-out cap were not compared: ${overflow.map((e) => e.table).join(", ")}.`]
      : []),
    ...(mode === "staging-only"
      ? ['Production numbers: the run is staging-only by run-owner decision; all production columns read "unavailable" and parity deltas are unknown.']
      : []),
    ...(warmupScriptPresent
      ? []
      : ["The automated warmup drift check (SKILL.md:29–42) could not run: scripts/detect-data-drift.sh does not exist in this workspace, and no stand-in was written."]),
    "Remediation plans are prepared, not executed — every write awaits run-owner approval and human execution by design.",
    "Prompt sizes were never exercised against a live model: the audit and report asks embed the per-entity results as JSON, so a full 8-entity scope with unusually wide evidence could hit a context limit (§16.3); the fan-out cap is the only mitigation in the script.",
    "The skill's corridor_* child-table list (:182–186) belongs to another schema; child coverage here was derived from this workspace's prisma/schema.prisma, so coverage is only as complete as that schema's declared relations.",
    "Counts drift in real time: confirmed numbers reflect the moment of the recount, not the moment of reading.",
  ],
};

return result;
