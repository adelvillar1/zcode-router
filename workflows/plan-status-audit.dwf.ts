/* zcode-workflow
description: "Audits existing plans: discovers candidate plans with
  deterministic gates, runs each plan's evidence checks (git history, branches,
  recaps) through a verifier and independent confirmer, renders the verdict
  table with a fresh-eyes review, and flips only owner-approved plan statuses.
  Embodies the plan-status-audit skill."
whenToUse: When plan files need an evidence-based status audit and
  owner-approved status flips.
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: plan-status-audit
// Embodies the 6-step procedure (plus the §3.5 fast path) from
// /Users/alejandrodelvillar/.agents/skills/plan-status-audit/SKILL.md — a 126-line file whose
// Workflow section spans lines 33-114 (verified this session; the batch ask's "lines 563-643"
// do not exist in this skill).
//
// Hybrid pattern: the deterministic skeleton lives here (candidate discovery, checkbox
// prefilter, §3.5 same-shot gates, ancestor/branch confirmation, post-flip verification,
// WorkflowReport); subagent asks cite the skill's SKILL.md and its two existing references
// by absolute path for per-plan judgment detail.
//
// The skill ships no scripts/ (verified: ls of scripts/ is ENOENT), so the deterministic
// gates are world.run calls running the exact commands the SKILL.md specifies:
//   SKILL.md:38-39  grep -l '^status: active|draft' docs/plans/*.md .hermes/plans/*.md
//   SKILL.md:46-48  per-file checkbox counts (grep -c '^- \[x\]' / '^- \[ \]')
//   SKILL.md:76-80  git log --oneline -- <plan>; git show --stat; git branch --contains;
//                   git log --all --grep=<slug>; grep -rn <slug> docs/recaps
//   SKILL.md:89     git merge-base --is-ancestor <sha> <branch>
// Facade adaptation (world.run takes fixed argv, never a shell): the shell globs are
// expanded by files.glob into the args array, the for-loop prefilter becomes a per-file
// map, and `&& echo IN || echo OUT` becomes a branch on merge-base's exit code. Command
// names, flags and patterns are unchanged.
//
// Known defect of the source skill, deliberately not surfaced to subagents: SKILL.md:126
// lists references/verifying-follow-up-claims.md, which does not exist (references/ holds
// only stale-plan-audit-dnd-vtt-2026-08-05.md and stale-plan-audit-dnd-vtt-2026-08-07.md).
// Every ask cites only the SKILL.md and those two real files.

// ---------------------------------------------------------------------------
// Result types (every ask<T> type argument is an interface declared here)
// ---------------------------------------------------------------------------

interface CandidatePlan {
  /** Workspace-relative path of the plan file. */
  path: string;
  /** The frontmatter status field that made it a candidate. */
  statusField: "active" | "draft";
  /** Count of "- [x]" lines (SKILL.md:47); 0 when grep errored. */
  checkedBoxes: number;
  /** Count of "- [ ]" lines (SKILL.md:47); 0 when grep errored. */
  uncheckedBoxes: number;
}

interface PlanCommit {
  /** Abbreviated commit hash from git log --oneline. */
  sha: string;
  /** Commit subject line. */
  subject: string;
}

interface SameShotEvidence {
  /** Commits touching the plan file (SKILL.md:76). */
  planCommits: PlanCommit[];
  /** Subject of the first "feat…" commit touching the plan, when one exists. */
  featureCommitSubject: string;
  /** git show --stat output for the feature commit (SKILL.md:77), trimmed. */
  showStat: string;
  /** Branches containing the feature commit (SKILL.md:78). */
  containingBranches: string[];
  /** True when main/staging/master contains the feature commit — already deployed. */
  onDeployedBranch: boolean;
  /** Commits whose message mentions the plan slug (SKILL.md:79) — a later close-out? */
  closeOutCommitCount: number;
  /** Mentions of the slug in docs/recaps (SKILL.md:80); empty means no recap walked the ACs. */
  recapMentionCount: number;
  /** False when docs/recaps does not exist and the recap search could not run. */
  recapSearchRan: boolean;
  /** True when the feature commit is an ancestor of the current branch (SKILL.md:89); null when it could not be decided. */
  ancestorOfCurrentBranch: boolean | null;
  /** One line on how the ancestry verdict was reached. */
  ancestryNote: string;
  /** SKILL.md:82-84 heuristic: exactly one commit (the feature commit) and zero recap mentions. */
  sameShotLikely: boolean;
}

interface AcMapping {
  /** The acceptance criterion, in the plan's own words, one line. */
  criterion: string;
  /** met = in the code; unmet = not found; deviation = a deliberate alternative covers the policy (SKILL.md:108-110). */
  state: "met" | "unmet" | "deviation";
  /** File:line, or the command and output that decided it. */
  evidence: string;
}

interface PlanVerdict {
  /** The skill's verdict vocabulary (SKILL.md:99-106): stale → complete; stale → complete pending verification; active; inconclusive. */
  verdict: "stale-complete" | "stale-complete-pending-verification" | "active" | "inconclusive";
  /** One sentence: the plan's actual state (phases shipped, feature commit, deployment). */
  actualState: string;
  /** One mapping per acceptance criterion. */
  acs: AcMapping[];
  /** Deliberate deviations and externally-blocked ACs — caveats, not failures (SKILL.md:108-110, 120). */
  caveats: string[];
  /** Code-complete-but-unverified tells found (SKILL.md:93-97): missing sibling tests, no e2e-review doc, ACs never exercised. */
  unverifiedTells: string[];
  /** True when the feature has a user-facing UI surface (a persona E2E would be needed before flip per SKILL.md:100). */
  uiFeature: boolean;
  /** The strongest evidence for the verdict, one paragraph with file:line citations. */
  evidence: string;
}

interface VerdictConfirmation {
  /** True only when you reproduced the verdict yourself from the plan and the code. */
  confirmed: boolean;
  /** One sentence: what you checked and what it showed, or what you found instead. */
  note: string;
}

interface PlanAudit {
  path: string;
  statusField: "active" | "draft";
  checkedBoxes: number;
  uncheckedBoxes: number;
  sameShot: SameShotEvidence;
  verdict: PlanVerdict["verdict"];
  actualState: string;
  caveats: string[];
  unverifiedTells: string[];
  uiFeature: boolean;
  evidence: string;
  confirmation: VerdictConfirmation;
}

interface VerdictRow {
  /** Plan file path. */
  plan: string;
  /** The frontmatter status field today. */
  statusField: string;
  /** The plan's actual state, one line. */
  actualState: string;
  /** The verdict in the skill's wording. */
  verdict: string;
  /** Caveat for this row, when one applies. */
  caveat: string;
}

interface VerdictTable {
  /** One row per audited plan, in the skill's table format (SKILL.md:102-106). */
  rows: VerdictRow[];
  /** Cross-plan caveats: deliberate deviations and external blockers worth reading together. */
  crossPlanCaveats: string[];
  /** Two-sentence summary of the table. */
  summary: string;
}

interface Review {
  approved: boolean;
  /** What would break these verdicts or is missing before a flip should happen. */
  gaps: string[];
  /** Overall assessment in one paragraph. */
  assessment: string;
}

interface FlipProposal {
  /** Plan file path. */
  path: string;
  /** Current frontmatter status. */
  fromStatus: string;
  /** Verdict in the skill's wording. */
  verdict: string;
  /** True when a persona E2E would be expected before flip (SKILL.md:100) and none ran here. */
  uiFeature: boolean;
  /** One line of the strongest evidence. */
  evidence: string;
  /** This plan's caveats the approver should see. */
  caveats: string[];
}

interface FlipOutcome {
  /** Plan files actually edited to status: complete. */
  flipped: string[];
  /** Proposed plans the run owner declined or that did not make the approved list. */
  notFlipped: string[];
  /** The approval answer in the run owner's words, plus any conditions attached. */
  approvalNote: string;
}

interface FlipLanding {
  path: string;
  landed: boolean;
}

interface Finding {
  /** Workspace-relative path, with a line when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what was found. */
  what: string;
  /** What showed it: the lines read, or the command and output that proved it. */
  evidence: string;
  /** "verified" when the independent confirmer agreed or a deterministic check decided it; "unconfirmed" otherwise. */
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

// ---------------------------------------------------------------------------
// Dashboard: one row per audited plan, updated as each audit lands
// ---------------------------------------------------------------------------

artifact.table("plan-verdicts", {
  title: "Plan verdicts",
  description: "Per-plan verdicts from the status audit, with each independent confirmer's outcome.",
  key: "plan",
  columns: [
    { field: "plan", label: "Plan" },
    { field: "statusField", label: "Status field" },
    { field: "verdict", label: "Verdict" },
    { field: "confirmation", label: "Confirmer" },
  ],
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Plan slug as the SKILL.md's git-grep commands use it: file name without directories or .md. */
function slugOf(planPath: string): string {
  return planPath.replace(/^.*\//, "").replace(/\.md$/, "");
}

/** The skill's verdict vocabulary, in the wording SKILL.md:99-106 uses. */
function verdictLabel(verdict: PlanVerdict["verdict"]): string {
  if (verdict === "stale-complete") return "Stale → complete";
  if (verdict === "stale-complete-pending-verification") return "Stale → complete, pending verification";
  if (verdict === "active") return "Active (open work)";
  return "Inconclusive";
}

function nonEmptyLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function countFromGrepCount(outcome: { exitCode: number; stdout: string }): number {
  // grep -c prints the count and exits 0 when it is positive, 1 when it is zero.
  const n = Number(outcome.stdout.trim());
  return (outcome.exitCode === 0 || outcome.exitCode === 1) && Number.isFinite(n) ? n : 0;
}

function parseOnelineLog(stdout: string): PlanCommit[] {
  const commits: PlanCommit[] = [];
  for (const line of nonEmptyLines(stdout)) {
    const match = /^([0-9a-f]{7,40})\s+(.*)$/.exec(line);
    if (match) commits.push({ sha: match[1], subject: match[2] });
  }
  return commits;
}

/** The "Status flips" section of the report; empty when nothing was proposed. */
function flipsSection(flipped: string[], declined: string[], approvalNote: string): string {
  if (flipped.length === 0 && declined.length === 0) {
    return "## Status flips\n\nNone proposed: no plan met the flip bar (a confirmed stale verdict and passing repository checks).";
  }
  return [
    "## Status flips",
    "",
    `Applied after run-owner approval: ${flipped.length > 0 ? flipped.join(", ") : "none"}`,
    `Declined or not approved: ${declined.length > 0 ? declined.join(", ") : "none"}`,
    approvalNote.length > 0 ? `Approval answer: ${approvalNote}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// §3.5 deterministic gates — the exact commands from SKILL.md:76-89, one branch
// on merge-base's exit code in place of the skill's `&& echo IN || echo OUT`
// ---------------------------------------------------------------------------

async function gatherSameShotEvidence(planPath: string, slug: string, currentBranch?: string): Promise<SameShotEvidence> {
  const evidence: SameShotEvidence = {
    planCommits: [],
    featureCommitSubject: "",
    showStat: "",
    containingBranches: [],
    onDeployedBranch: false,
    closeOutCommitCount: 0,
    recapMentionCount: 0,
    recapSearchRan: false,
    ancestorOfCurrentBranch: null,
    ancestryNote: "no feature commit touching the plan was identified",
    sameShotLikely: false,
  };

  // SKILL.md:76 — a "feat" commit touching the plan file = likely same-shot implementation.
  const planLog = await world.run("git", ["log", "--oneline", "--", planPath]);
  if (planLog.exitCode === 0) evidence.planCommits = parseOnelineLog(planLog.stdout);
  const featureCommit = evidence.planCommits.find((c) => c.subject.toLowerCase().startsWith("feat"));

  if (featureCommit) {
    evidence.featureCommitSubject = featureCommit.subject;
    // SKILL.md:77 — enumerate touched files → map to ACs.
    const show = await world.run("git", ["show", "--stat", featureCommit.sha]);
    evidence.showStat = (show.exitCode === 0 ? show.stdout : `git show exited ${show.exitCode}`).slice(0, 4000);
    // SKILL.md:78 — on staging/main = already deployed.
    const contains = await world.run("git", ["branch", "--contains", featureCommit.sha]);
    if (contains.exitCode === 0) {
      evidence.containingBranches = nonEmptyLines(contains.stdout).map((b) => b.replace(/^\*\s*/, ""));
      evidence.onDeployedBranch = evidence.containingBranches.some(
        (b) => b === "main" || b === "staging" || b === "master",
      );
    }
    // SKILL.md:89 — confirm the feature is actually in *your* branch: exit 0 = IN, 1 = OUT.
    if (currentBranch) {
      const ancestor = await world.run("git", ["merge-base", "--is-ancestor", featureCommit.sha, currentBranch]);
      evidence.ancestorOfCurrentBranch = ancestor.exitCode === 0 ? true : ancestor.exitCode === 1 ? false : null;
      evidence.ancestryNote = `git merge-base --is-ancestor ${featureCommit.sha} ${currentBranch} exited ${ancestor.exitCode}`;
    } else {
      evidence.ancestryNote = "current branch unknown (detached HEAD or not a git repository); ancestry not checked";
    }
  }

  // SKILL.md:79 — any later close-out commit mentioning the plan slug?
  const closeOut = await world.run("git", ["log", "--oneline", "--all", `--grep=${slug}`]);
  if (closeOut.exitCode === 0) evidence.closeOutCommitCount = nonEmptyLines(closeOut.stdout).length;

  // SKILL.md:80 — empty = no recap ever walked the ACs. grep -r on the directory stands in
  // for the skill's docs/recaps/*.md glob; exit 2 means the directory is not there.
  const recap = await world.run("grep", ["-rn", "--include=*.md", slug, "docs/recaps"]);
  evidence.recapSearchRan = recap.exitCode !== 2;
  if (recap.exitCode === 0) evidence.recapMentionCount = nonEmptyLines(recap.stdout).length;

  // SKILL.md:82-84 — one commit (the feature commit) and zero recap mentions = built, never closed out.
  evidence.sameShotLikely =
    evidence.planCommits.length === 1 && evidence.recapSearchRan && evidence.recapMentionCount === 0;
  return evidence;
}

// ---------------------------------------------------------------------------
// Phase 1 — candidate discovery and checkbox prefilter (SKILL.md:35-53)
// ---------------------------------------------------------------------------

phase("Find candidate plans and prefilter them by checkbox count");

let docsPlanFiles: string[] = [];
let hermesPlanFiles: string[] = [];
try {
  docsPlanFiles = await files.glob("docs/plans/*.md");
} catch {
  docsPlanFiles = [];
}
try {
  hermesPlanFiles = await files.glob(".hermes/plans/*.md");
} catch {
  hermesPlanFiles = [];
}
const planFiles: string[] = docsPlanFiles.concat(hermesPlanFiles);
log(`Plan file search found ${planFiles.length} files (docs/plans: ${docsPlanFiles.length}, .hermes/plans: ${hermesPlanFiles.length}).`);

let activePaths: string[] = [];
let draftPaths: string[] = [];
// Declared at this scope, not inside the if-block below: the empty-path report
// and the main-path report both read it, and const is block-scoped.
const unreadablePlans: string[] = [];
if (planFiles.length > 0) {
  // SKILL.md:38-39, with the shell globs expanded into the args array. A batch
  // grep exits 2 when any one operand is unreadable, and reading that as "no
  // matches" would conclude "nothing to audit" over a broken search — so an
  // errored batch falls back to one grep per file, where a single vanished path
  // costs only its own line, and the fallback is logged, never silent. A file
  // whose own grep still exits >1 is unreadable: it is collected in
  // unreadablePlans and surfaced (log + notCovered), never silently dropped
  // from the candidate set.
  const batchGrep = async (status: string): Promise<string[]> => {
    const batch = await world.run("grep", ["-l", status].concat(planFiles));
    if (batch.exitCode <= 1) return nonEmptyLines(batch.stdout);
    log(`grep -l '${status}' exited ${batch.exitCode} over the batch — falling back to one grep per file.`);
    const salvaged: string[] = [];
    for (const p of planFiles) {
      const single = await world.run("grep", ["-l", status, p]);
      if (single.exitCode === 0) salvaged.push(p);
      else if (single.exitCode > 1 && !unreadablePlans.includes(p)) unreadablePlans.push(p);
    }
    return salvaged;
  };
  activePaths = await batchGrep("^status: active");
  draftPaths = await batchGrep("^status: draft");
  if (unreadablePlans.length > 0) {
    log(
      `${unreadablePlans.length} plan file(s) could not be read by grep and are excluded from candidacy: ${unreadablePlans.join(", ")}.`,
    );
  }
}

const candidatePaths = activePaths
  .concat(draftPaths)
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();
log(`${candidatePaths.length} candidate plans carry status active or draft.`);

if (candidatePaths.length === 0) {
  const emptyReport: WorkflowReport = {
    conclusion:
      "No plan files with frontmatter status active or draft were found in docs/plans/ or .hermes/plans/, so there is nothing to audit. If plans live somewhere else in this workspace, point the audit at that directory.",
    findings: [],
    verified: [
      `script-observed: files.glob found ${planFiles.length} plan file(s) across the searched directories (docs/plans: ${docsPlanFiles.length}, .hermes/plans: ${hermesPlanFiles.length}), and none carries frontmatter status active or draft`,
      `script-observed: grep -l for '^status: active' and '^status: draft' ${planFiles.length > 0 ? "ran over the plan files found" : "did not run because no plan files exist"} and matched nothing`,
    ],
    notCovered: [
      "acceptance-criteria mapping (no candidate plans exist)",
      ...(hermesPlanFiles.length === 0
        ? [".hermes/plans/*.md matched nothing — the directory is absent here or the glob does not descend into hidden directories"]
        : [`${hermesPlanFiles.length} .hermes/plans file(s) were found but none carries frontmatter status active or draft`]),
      ...(unreadablePlans.length > 0
        ? [`${unreadablePlans.length} plan file(s) could not be read by grep and could not be considered: ${unreadablePlans.join(", ")}`]
        : []),
    ],
  };
  try {
    await artifact.markdown(
      "plan-status-audit-report",
      `# Plan status audit\n\nNo candidate plans found.\n\n${emptyReport.conclusion}\n`,
      {
        title: "Plan status audit",
        description: "No plans with status active or draft exist in the searched directories.",
        primary: true,
      },
    );
  } catch {
    // Register rule: the deliverable survives a rejected publish as a compact
    // fallback — and the fallback itself is guarded, so even a total publish
    // failure still returns the report instead of erroring the run.
    log("Report publish failed; publishing a one-line compact fallback.");
    try {
      await artifact.markdown(
        "plan-status-audit-report",
        `# Plan status audit (compact)\n\n${emptyReport.conclusion}\n`,
        {
          title: "Plan status audit (compact)",
          description: "Compact fallback: the full report publish was rejected.",
          primary: true,
        },
      );
    } catch {
      log("Report publish failed entirely; the run's return value still carries the full result.");
    }
  }
  return emptyReport;
}

// SKILL.md:46-48 prefilter, per file instead of as a shell for-loop.
const MAX_AUDITED = 48;
const candidates: CandidatePlan[] = (
  await Promise.all(
    candidatePaths.map(async (p) => {
      const checked = await world.run("grep", ["-c", "^- \\[x\\]", p]);
      const unchecked = await world.run("grep", ["-c", "^- \\[ \\]", p]);
      return {
        path: p,
        statusField: activePaths.indexOf(p) >= 0 ? ("active" as const) : ("draft" as const),
        checkedBoxes: countFromGrepCount(checked),
        uncheckedBoxes: countFromGrepCount(unchecked),
      };
    }),
  )
).sort((a, b) => (a.path < b.path ? -1 : 1));

const auditedCandidates = candidates.slice(0, MAX_AUDITED);
if (candidates.length > auditedCandidates.length) {
  log(`Auditing the first ${auditedCandidates.length} of ${candidates.length} candidates; the rest stay unaudited.`);
}

let currentBranch: string | undefined;
try {
  currentBranch = (await git.status()).branch;
} catch {
  currentBranch = undefined;
}

// ---------------------------------------------------------------------------
// Phase 2 — per-plan pipeline: §3.5 gates, AC mapping, independent confirmation.
// One join at the end; each plan's confirmer starts the moment its verifier lands.
// ---------------------------------------------------------------------------

phase("Audit each candidate plan and confirm its verdict as it lands");
log(`Auditing ${auditedCandidates.length} candidate plans — one acceptance-criteria verifier and one independent confirmer each.`);

const audits: PlanAudit[] = await Promise.all(
  auditedCandidates.map(async (c) => {
    const sameShot = await gatherSameShotEvidence(c.path, slugOf(c.path), currentBranch);

    const verdict = await agent(`plan-verifier-${c.path}`, {
      system:
        "You audit whether a plan file's acceptance criteria are already met by the committed code. " +
        "Read /Users/alejandrodelvillar/.agents/skills/plan-status-audit/SKILL.md — Workflow steps 1-3 (lines 35-66), " +
        "the §3.5 fast stale-detection section (lines 69-100), and Common Pitfalls (lines 116-120) — plus " +
        "/Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-05.md " +
        "for worked per-plan AC-mapping examples and " +
        "/Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-07.md " +
        "for the close-out sequencing and the code-complete-but-unverified tells. These three files are the only " +
        "procedure references for this audit. Do not edit any file; the status flip happens later and only after " +
        "the run owner approves it. If the plan's criteria cannot be decided from this repository, say so plainly " +
        "rather than guessing.",
    }).ask<PlanVerdict>(
      `Audit the plan file ${c.path} (frontmatter status: ${c.statusField}; checkbox prefilter: ${c.checkedBoxes} checked, ${c.uncheckedBoxes} unchecked).\n\n` +
        `Deterministic context the script already established — weigh it, do not trust it:\n${JSON.stringify(sameShot)}\n\n` +
        `With your own tools:\n` +
        `1. Read the plan's Acceptance Criteria section. Some plans write criteria as bold **ACn:** lines or phase ` +
        `summaries rather than "- [ ]" checkboxes — a checkbox count is not evidence (SKILL.md:51-53 and 118).\n` +
        `2. Map every criterion to actual code per SKILL.md:59-66: grep the code-reference hints, git log the touched ` +
        `files, and confirm the feature is in this branch by grepping the plan's main symbols across the source trees ` +
        `(SKILL.md:90). Follow the worked examples in the 2026-08-05 reference.\n` +
        `3. Check the code-complete-but-unverified tells of SKILL.md:93-97 — implementation files without sibling test ` +
        `files, no docs/e2e-review entry for the feature, criteria never exercised — as the 2026-08-07 reference describes.\n` +
        `4. Record deliberate deviations as caveats, not failures (SKILL.md:108-110); check commit messages before ` +
        `assuming a bug (SKILL.md:119); a criterion blocked on external factors is a caveat alongside a flip, not open ` +
        `work (SKILL.md:120).\n` +
        `5. Return the verdict in the skill's vocabulary, the plan's actual state in one sentence, and evidence with ` +
        `file:line citations.`,
    );

    const confirmation = await agent(`plan-confirmer-${c.path}`, {
      system:
        "You independently confirm or refute another auditor's verdict on a plan file, from the primary sources alone. " +
        "Read /Users/alejandrodelvillar/.agents/skills/plan-status-audit/SKILL.md (Workflow steps 2-3, lines 55-66, and " +
        "§3.5 lines 69-100) and " +
        "/Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-05.md " +
        "for the mapping recipe. You have not seen how the verdict was argued and must not take its word. " +
        "Do not edit any file.",
    }).ask<VerdictConfirmation>(
      `Independently confirm or refute this verdict on ${c.path}. Claimed verdict: ${verdictLabel(verdict.verdict)} ` +
        `(${verdict.verdict}); claimed actual state: ${verdict.actualState}.\n\n` +
        `Reproduce it yourself: read the plan's acceptance criteria, grep the referenced code, and check the §3.5 tells ` +
        `(SKILL.md:93-97). Spot-check enough criteria to be sure. Deterministic gate output from the script, for ` +
        `cross-reference only:\n${JSON.stringify(sameShot)}\n\n` +
        `Return confirmed=true only when your own reading of plan and code supports the verdict; otherwise ` +
        `confirmed=false with what you found instead.`,
    );

    const audit: PlanAudit = {
      path: c.path,
      statusField: c.statusField,
      checkedBoxes: c.checkedBoxes,
      uncheckedBoxes: c.uncheckedBoxes,
      sameShot,
      verdict: verdict.verdict,
      actualState: verdict.actualState,
      caveats: verdict.caveats,
      unverifiedTells: verdict.unverifiedTells,
      uiFeature: verdict.uiFeature,
      evidence: verdict.evidence,
      confirmation,
    };
    report(
      {
        plan: c.path,
        statusField: c.statusField,
        verdict: verdictLabel(verdict.verdict),
        confirmation: confirmation.confirmed ? "confirmed" : "unconfirmed",
      },
      "plan-verdicts",
    );
    return audit;
  }),
);

const confirmedCount = audits.filter((a) => a.confirmation.confirmed).length;
log(`${confirmedCount} of ${audits.length} verdicts were independently confirmed.`);

// ---------------------------------------------------------------------------
// Phase 3 — the verdict table (SKILL.md steps 4-5). One shared subagent, because
// the table must be consistent across plans — the one job a shared context is for.
// ---------------------------------------------------------------------------

phase("Render the verdict table across all candidates");

const slimAudits = audits.map((a) => ({
  plan: a.path,
  statusField: a.statusField,
  verdict: verdictLabel(a.verdict),
  actualState: a.actualState,
  caveats: a.caveats,
  unverifiedTells: a.unverifiedTells,
  uiFeature: a.uiFeature,
  confirmerConfirmed: a.confirmation.confirmed,
  confirmerNote: a.confirmation.note,
}));

const table = await agent("verdict-table-compiler", {
  system:
    "You render the audit's verdict table for the user. Read " +
    "/Users/alejandrodelvillar/.agents/skills/plan-status-audit/SKILL.md step 4 (lines 102-106) and step 5 " +
    "(lines 108-110), and the Final Verdict Table in " +
    "/Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-05.md " +
    "for the format. One row per plan, in the skill's verdict wording; deviations and blockers are caveats, never " +
    "failures. Also surface anything inconsistent across plans — contradictory evidence, duplicated claims. " +
    "Do not edit any file.",
}).ask<VerdictTable>(
  `Render the verdict table for these audited plans:\n${JSON.stringify(slimAudits)}\n\n` +
    `Return one row per plan plus any cross-plan caveats and a two-sentence summary.`,
);

// ---------------------------------------------------------------------------
// Phase 4 — fresh eyes on the table before anything is proposed to the owner
// ---------------------------------------------------------------------------

phase("Have someone new challenge the verdict table");

const review = await agent("verdict-table-reviewer", {
  system:
    "You are an independent reviewer who has seen nothing else in this run. Judge the verdict table the way its " +
    "reader would: ask what would break each verdict, which rows rest on thin evidence, and what is missing before " +
    "any plan status should be flipped. Open plan files and grep code yourself to spot-check any row that looks " +
    "thin. Do not edit any file.",
}).ask<Review>(
  `Challenge this verdict table:\n${JSON.stringify(table.rows)}\n\nCross-plan caveats: ${JSON.stringify(table.crossPlanCaveats)}\n\n` +
    `Confirmer outcomes: ${JSON.stringify(audits.map((a) => ({ plan: a.path, confirmed: a.confirmation.confirmed, note: a.confirmation.note })))}\n\n` +
    `What would break these verdicts? What is missing? Restate in your own words any row you distrust.`,
);

// ---------------------------------------------------------------------------
// Phase 5 — the repository's own checks, the strong tier a flip depends on
// (SKILL.md:100: flip only after the ACs pass — run test/typecheck/build)
// ---------------------------------------------------------------------------

let repoCheckScripts: Record<string, string | undefined> = {};
try {
  const parsed = JSON.parse(await files.read("package.json")) as { scripts?: Record<string, string | undefined> };
  repoCheckScripts = parsed.scripts ?? {};
} catch {
  repoCheckScripts = {};
}
const checkNames = ["test", "typecheck", "build"].filter((name) => repoCheckScripts[name] !== undefined);

const repoCheckLines: string[] = [];
let suiteRan = false;
let suitePassed: boolean | null = null; // null = the repository declares none of the checks
if (checkNames.length > 0) {
  phase("Run the repository's checks before proposing any flip");
  suitePassed = true;
  for (const name of checkNames) {
    const check = await world.run("npm", ["run", name], { timeoutMs: 1_800_000 });
    repoCheckLines.push(`npm run ${name}: exit ${check.exitCode}`);
    if (check.exitCode !== 0) {
      suitePassed = false;
      repoCheckLines.push(`npm run ${name} failed: ${check.stderr.slice(0, 500)}`);
    }
  }
  suiteRan = true;
  log(`Repository checks: ${repoCheckLines.join(" · ")}`);
}

// A flip requires the checks to pass (SKILL.md:100); a failed check proposes nothing.
const flippable = audits.filter(
  (a) =>
    suitePassed !== false &&
    (a.verdict === "stale-complete" || a.verdict === "stale-complete-pending-verification") &&
    a.confirmation.confirmed,
);
const proposals: FlipProposal[] = flippable.map((a) => ({
  path: a.path,
  fromStatus: a.statusField,
  verdict: verdictLabel(a.verdict),
  uiFeature: a.uiFeature,
  evidence: a.evidence.slice(0, 300),
  caveats: a.caveats,
}));
log(`${proposals.length} of ${audits.length} plans qualify to be proposed for a status flip.`);

// ---------------------------------------------------------------------------
// Phase 6 — the approval gate (SKILL.md:114, "Get user approval before flipping"):
// the flip executor reaches the run owner by escalation and edits only what is approved
// ---------------------------------------------------------------------------

let flipOutcome: FlipOutcome | null = null;
let flipLanding: FlipLanding[] = [];
let unexpectedFlips: string[] = [];
if (proposals.length > 0) {
  phase("Get approval and flip only the approved plans");

  const dateOut = await world.run("date", ["+%Y-%m-%d"]);
  const updatedDate =
    dateOut.exitCode === 0 && dateOut.stdout.trim().length > 0
      ? dateOut.stdout.trim()
      : "today's date (confirm the exact date in the approval answer)";

  flipOutcome = await agent("status-flip-executor", {
    system:
      "You execute plan-status flips and nothing else. A flip rewrites a plan file's frontmatter, so it happens only " +
      "after the run owner explicitly approves the exact list: compose the approval question, wait for the answer, " +
      "then edit only what was approved. If you cannot complete this as instructed, or the instructions contradict " +
      "each other, escalate and say so plainly rather than working around it.",
  }).ask<FlipOutcome>(
    `Proposed status flips, pending run-owner approval:\n${JSON.stringify(proposals)}\n\n` +
      `The proposed frontmatter change per approved plan: the status line becomes "status: complete" and "updated: ${updatedDate}" is set.\n\n` +
      `Context the approver needs: repository check results ${JSON.stringify(repoCheckLines)}; independent reviewer ` +
      `gaps ${JSON.stringify(review.gaps)}.\n\n` +
      `1. Escalate ONE question to the run owner listing every proposed flip — plan path, current status, the exact ` +
      `frontmatter change, one line of evidence — and state two things in that question: plans marked uiFeature had ` +
      `no persona E2E run in this workflow (SKILL.md:100 expects one for UI features), and ` +
      `${suiteRan ? "the repository's own automated checks all passed" : "the repository declares no automated test, typecheck, or build script, so the criteria were verified by reading code only"}. ` +
      `Ask which flips are approved.\n` +
      `2. Wait for the answer. Edit ONLY the approved plans: set the frontmatter status line to "status: complete" and ` +
      `set (or add) "updated:" to the approved date. Change nothing else in any file, and edit nothing before the ` +
      `answer arrives.\n` +
      `3. Return the flipped paths, the proposed paths you did not flip, and the approval answer verbatim.`,
  );

  flipLanding = await Promise.all(
    flipOutcome.flipped.map(async (p) => {
      const check = await world.run("grep", ["-c", "^status: complete", p]);
      return { path: p, landed: check.exitCode === 0 };
    }),
  );
  log(`${flipLanding.filter((f) => f.landed).length} of ${flipOutcome.flipped.length} flips verified on disk.`);

  // The executor's word is not the approval's scope: a path it claims to have
  // flipped that no proposal named is cross-checked here and surfaced as a
  // finding in the write-up, never printed as an approved flip without challenge.
  const proposedPaths = new Set(proposals.map((p) => p.path));
  unexpectedFlips = flipOutcome.flipped.filter((p) => !proposedPaths.has(p));
  if (unexpectedFlips.length > 0) {
    log(`The flip executor reported editing ${unexpectedFlips.length} plan(s) that no proposal named: ${unexpectedFlips.join(", ")} — flagged in the findings.`);
  }
} else {
  log("No flips to propose" + (suitePassed === false ? " — the repository's checks did not pass." : "."));
}

// ---------------------------------------------------------------------------
// Phase 7 — verify the tree state, write up the audit, publish the deliverable
// ---------------------------------------------------------------------------

phase("Write up the audit and verify the flips landed");

const treeStatus = await world.run("git", ["status", "--short"]);
const treeLine = treeStatus.exitCode === 0 ? treeStatus.stdout.trim().slice(0, 2000) : `git status exited ${treeStatus.exitCode}`;

const findings: Finding[] = [];
for (const a of audits) {
  findings.push({
    where: a.path,
    what: `${verdictLabel(a.verdict)} — ${a.actualState}`,
    evidence: `${a.evidence} Independent confirmer: ${a.confirmation.note}`,
    status: a.confirmation.confirmed ? "verified" : "unconfirmed",
    severity: a.verdict === "active" || a.verdict === "inconclusive" ? "low" : "medium",
  });
}
if (suitePassed === false) {
  findings.push({
    where: "package.json",
    what: "The repository's declared checks did not pass, so no status flips were proposed (SKILL.md:100).",
    evidence: repoCheckLines.join(" · "),
    status: "verified",
    severity: "medium",
  });
}
for (const f of flipLanding) {
  if (!f.landed) {
    findings.push({
      where: f.path,
      what: "A status flip was approved and reported but is not on disk — the frontmatter does not read status: complete.",
      evidence: "script-observed: grep -c '^status: complete' on the file exited nonzero after the flip step",
      status: "verified",
      severity: "medium",
    });
  }
}
for (const p of unexpectedFlips) {
  findings.push({
    where: p,
    what: "The flip executor reported editing this plan, but no approved proposal named it — check whether this frontmatter edit should be reverted.",
    evidence: `the executor's flipped list contains ${p}; the proposal list was: ${proposals.map((pr) => pr.path).join(", ") || "empty"}`,
    status: "verified",
    severity: "medium",
  });
}

const verified: string[] = [
  "script-observed: candidate discovery ran grep -l '^status: active' and grep -l '^status: draft' over the plan files found (SKILL.md:38-39)",
  `script-observed: checkbox prefilter counted "- [x]" and "- [ ]" lines per candidate (SKILL.md:46-48)`,
  `script-observed: §3.5 gates ran per candidate — git log --oneline -- <plan>, git show --stat, git branch --contains, git log --all --grep=<slug>, grep -rn <slug> docs/recaps, git merge-base --is-ancestor (SKILL.md:76-89)`,
  `script-observed: ${confirmedCount} of ${audits.length} verdicts were reproduced by an independent confirmer that saw only the plan, the code, and the deterministic gate output`,
];
if (suiteRan) verified.push(`script-observed: the repository's own checks ran before any flip was proposed — ${repoCheckLines.join(" · ")}`);
if (flipLanding.length > 0) {
  verified.push(
    `script-observed: ${flipLanding.filter((f) => f.landed).length} of ${flipLanding.length} approved flips verified on disk with grep, and git status --short shows: ${treeLine || "(clean tree — flips were already committed or nothing changed)"}`,
  );
}

const notCovered: string[] = [];
if (!suiteRan) notCovered.push("no automated test/typecheck/build scripts are declared in package.json, so ACs were verified by reading code only");
if (audits.some((a) => a.uiFeature)) {
  notCovered.push("persona E2E for UI features (SKILL.md:100) cannot run in this workflow — flagged to the run owner in the approval question instead");
}
if (audits.some((a) => !a.sameShot.recapSearchRan)) notCovered.push("docs/recaps does not exist here, so the recap-mention check (SKILL.md:80) could not run for some plans");
if (hermesPlanFiles.length === 0) notCovered.push(".hermes/plans/*.md matched nothing — the directory is absent here or the glob does not descend into hidden directories; only docs/plans was searched");
if (unreadablePlans.length > 0) {
  notCovered.push(`${unreadablePlans.length} plan file(s) could not be read by grep (exit >1) and were excluded from the candidate set: ${unreadablePlans.join(", ")}`);
}
if (candidates.length > auditedCandidates.length) {
  notCovered.push(`${candidates.length - auditedCandidates.length} candidates beyond the first ${auditedCandidates.length} were not audited`);
}
for (const a of audits) {
  if (!a.confirmation.confirmed) {
    notCovered.push(`${a.path}: the confirmer disputed the verdict, so treat it as suspected, not seen`);
  }
}

const flippedPaths = flipOutcome ? flipOutcome.flipped : [];
const declinedPaths = flipOutcome ? flipOutcome.notFlipped : [];
const staleCount = audits.filter((a) => a.verdict === "stale-complete" || a.verdict === "stale-complete-pending-verification").length;

const finalReport: WorkflowReport = {
  conclusion:
    `${audits.length} candidate plans audited: ${staleCount} stale (of which ${flippedPaths.length} flips were approved and applied, ` +
    `${declinedPaths.length} declined), ${audits.filter((a) => a.verdict === "active").length} still active, ` +
    `${audits.filter((a) => a.verdict === "inconclusive").length} inconclusive. ` +
    `${confirmedCount} verdicts were independently confirmed.` +
    (suitePassed === false ? " The repository's checks failed, so no flips were proposed." : ""),
  findings,
  verified,
  notCovered,
};

const markdown = [
  `# Plan status audit\n\n${finalReport.conclusion}`,
  `## Verdict table\n\n| Plan | Status field | Actual state | Verdict | Caveat |\n|------|--------------|--------------|---------|--------|\n${table.rows
    .map((r) => `| ${r.plan} | ${r.statusField} | ${r.actualState} | ${r.verdict} | ${r.caveat || "—"} |`)
    .join("\n")}`,
  `## Caveats and deliberate deviations\n\n${
    table.crossPlanCaveats.length > 0 ? table.crossPlanCaveats.map((c) => `- ${c}`).join("\n") : "- none recorded"
  }`,
  flipsSection(flippedPaths, declinedPaths, flipOutcome ? flipOutcome.approvalNote : ""),
  `## Reviewer challenge\n\n${review.assessment}${
    review.gaps.length > 0 ? `\n\n${review.gaps.map((g) => `- gap: ${g}`).join("\n")}` : ""
  }`,
  repoCheckLines.length > 0 ? `## Repository checks\n\n${repoCheckLines.map((l) => `- ${l}`).join("\n")}` : "",
  `## Procedure references used\n\n- /Users/alejandrodelvillar/.agents/skills/plan-status-audit/SKILL.md\n- /Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-05.md\n- /Users/alejandrodelvillar/.agents/skills/plan-status-audit/references/stale-plan-audit-dnd-vtt-2026-08-07.md`,
  `## Verified\n\n${finalReport.verified.map((v) => `- ${v}`).join("\n")}`,
  `## Not covered\n\n${
    finalReport.notCovered.length > 0
      ? finalReport.notCovered.map((n) => `- ${n}`).join("\n")
      : "- nothing: the audit covered its whole procedure"
  }`,
]
  .filter((section) => section.length > 0)
  .join("\n\n");

try {
  await artifact.markdown("plan-status-audit-report", markdown, {
    title: "Plan status audit",
    description: `Verdicts for ${audits.length} candidate plans; ${flippedPaths.length} status flips applied after approval.`,
    primary: true,
  });
} catch {
  log("Full report publish failed; publishing a compact fallback.");
  const compact = [
    "# Plan status audit (compact)",
    "",
    finalReport.conclusion,
    "",
    ...finalReport.findings.map((f) => `- **${f.where}** [${f.status}] ${f.what}`),
    "",
    `Flips applied: ${flippedPaths.length > 0 ? flippedPaths.join(", ") : "none"}`,
  ].join("\n");
  try {
    await artifact.markdown("plan-status-audit-report", compact, {
      title: "Plan status audit (compact)",
      description: "Compact fallback: verdicts and flips, after the full report failed to publish.",
      primary: true,
    });
  } catch {
    log("Report publish failed entirely; the run's return value still carries the full report.");
  }
}

return finalReport;
