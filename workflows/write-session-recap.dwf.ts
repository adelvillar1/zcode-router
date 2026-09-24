/* zcode-workflow
description: "Writes a session recap: walks the session's git evidence and areas
  with parallel walkers and proposers, holds shape/criteria/doc decisions with
  the run owner by escalation, fills the recap template with per-line
  substitution safety (concurrent-session-safe append/replace semantics), and
  runs the recap sweep with owner approval. Embodies the write-session-recap
  skill."
whenToUse: When a session's work should be written up as a structured recap in
  the skills' template format.
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: write-session-recap
// Embodies the procedure in /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md
// (template: /Users/alejandrodelvillar/.agents/skills/write-session-recap/templates/recap.md.template).
//
// Hybrid pattern: phases, fan-outs, bounded loops, and the WorkflowReport live in this
// script; every subagent ask points at the skill's SKILL.md (and the template) by absolute
// path for the step detail. Deterministic decisions are world.run / files.* / git.* gates:
// pre-flight existence checks (SKILL.md:36-43), change detection (:45-65), the active-plan
// grep (:69-73), template fill (:155-172), and verification (:198-209).
//
// This is the most human-in-the-loop skill of the batch. Every interactive step is an
// escalation to the run owner — never an autonomous mutation:
//   - recap shape when ambiguous            (SKILL.md:83-91)  -> Owner liaison escalation
//   - acceptance-criteria walk              (SKILL.md:93-104) -> per-plan walker escalation
//   - contract-doc apply/defer/modify       (SKILL.md:106-142, "always propose,
//                                             never auto-write") -> Owner liaison
//                                             escalation, per-item or batch approval
//   - plan status changes                   (SKILL.md:187-196 + :233 "unambiguous
//                                             confirmation") -> walker escalation, then edit
//   - process-registry sweep --kill         (SKILL.md:174-185) -> Owner liaison escalation
//   - creating docs/recaps/                 (SKILL.md:39)      -> owner acknowledgment in the
//                                             phase-4 batch; a "skip" answer means no file is
//                                             written and the recap ships as markdown only
// Nothing is ever committed or pushed (SKILL.md:220, :231); verification asserts both that
// nothing is staged and that HEAD did not move during the run.

// ---------------------------------------------------------------------------
// Result types (every ask<T> names an interface declared here)
// ---------------------------------------------------------------------------

interface PlanEvidence {
  /** Workspace-relative path of the plan file this evidence came from. */
  planPath: string;
  /** Feature name from the plan's title. */
  featureName: string;
  /** The plan's `status:` line exactly as found. */
  statusLine: string;
  /** Acceptance-criterion texts, verbatim from the plan's checkboxes, in order. */
  criteria: string[];
  /** How the session's changed files line up with the plan's "Files to be touched" section. */
  alignment: string;
  /** Contract docs the plan names in its "Linked artifacts" section. */
  linkedArtifacts: string[];
}

interface CriterionAssessment {
  /** The acceptance criterion, verbatim. */
  criterion: string;
  /** The walker's own read of the observed file changes. */
  proposed: "met" | "partial" | "unmet" | "deferred";
  /** One-sentence justification based on the changes seen. */
  justification: string;
  /** What the run owner said when asked to confirm or correct. */
  ownerVerdict: "confirmed" | "corrected" | "unanswered";
  /** The criterion's status after the owner's answer — never rounded from "unanswered". */
  final: "met" | "partial" | "unmet" | "deferred";
  /** The owner's correction or remark, quoted when present. */
  ownerNote: string;
}

interface PlanWalk {
  /** Workspace-relative path of the walked plan. */
  planPath: string;
  /** Feature name from the plan's title. */
  featureName: string;
  /** One assessment per acceptance criterion, in the plan's order. */
  assessments: CriterionAssessment[];
  /** True only when the owner unambiguously said the plan is done. */
  ownerSaysComplete: boolean;
  /** True only when the owner unambiguously approved the status: completed edit. */
  statusEditApproved: boolean;
  /** True when the owner approved bumping `updated` on a plan that stays active. */
  updatedBumpApproved: boolean;
}

type TouchedAreas = TouchedArea[];

interface TouchedArea {
  /** Short feature-area name ("payment queue", "database schema"). */
  name: string;
  /** Workspace-relative paths in this area, from the actual file changes. */
  paths: string[];
  /** One sentence on what changed in this area, grounded in the diff. */
  change: string;
  /** True when the changed files look like substantial feature work rather than upkeep. */
  looksLikeFeatureWork: boolean;
}

interface OwnerDecisions {
  /** The recap shape the owner chose. */
  shape: "feature" | "maintenance";
  /** Why this shape — the owner's words when they chose, else "unambiguous from evidence". */
  shapeRationale: string;
  /** Whether CLAUDE.local.md was edited this session (git cannot see it). */
  claudeLocalChanged: boolean;
  /** High-level description of that change — never any secret content. */
  claudeLocalSummary: string;
  /** Answer to the no-active-plan question, when it was asked; empty otherwise. */
  noPlanAnswer: string;
  /** The template's current path, when the owner supplied one because the default was missing; empty otherwise. */
  templatePathAnswer: string;
  /**
   * "create" when the owner agreed docs/recaps/ will be created; "skip" when they object;
   * "unanswered" when they never answered — consent is never defaulted. Only ever asked when
   * the pre-flight found the directory missing: when docs/recaps/ exists the recap is written
   * without a consent question (creating nothing is not an owner decision).
   */
  recapsDirConsent: "create" | "skip" | "unanswered";
}

type DocProposals = DocProposal[];

interface DocProposal {
  /** Index of the touched area this proposal came from. */
  areaIndex: number;
  /** Area name, repeated for the reader's convenience. */
  area: string;
  /** Workspace-relative contract doc the proposed text belongs in. */
  docPath: string;
  /** Section heading the update targets, when the doc exists and has one. */
  section: string;
  /** The actual proposed markdown, ready to paste — never "you should add a section about X". */
  proposedText: string;
  /** Why this update. */
  rationale: string;
  /** True when the honest answer is that this doc needs no update. */
  noUpdateNeeded: boolean;
  /** Why no update is needed (set whenever noUpdateNeeded is true). */
  noUpdateReason: string;
}

type DocDecisions = DocDecision[];

interface DocDecision {
  /** Index of the touched area whose proposal this decision answers — two areas may target the same doc. */
  areaIndex: number;
  /** Area name, echoed for the reader. */
  area: string;
  /** Workspace-relative contract doc the decision is about. */
  docPath: string;
  /** Section the decision is about, when known. */
  section: string;
  /** The owner's per-item decision. */
  decision: "apply" | "defer" | "modify" | "drop" | "unanswered";
  /** The owner's words — modification requests go here verbatim. */
  ownerNote: string;
}

interface DocApplyResult {
  /** Workspace-relative doc that was edited. */
  docPath: string;
  /** Section that received the approved text. */
  section: string;
  /** True when the edit landed. */
  applied: boolean;
  /** Where the change landed, as path:line. */
  location: string;
  /** One line on what was done, or why it was not. */
  note: string;
}

interface OwnerAnswer {
  /** The owner's words, verbatim. */
  answer: string;
}

interface SweepPathAnswer {
  /** "skip" when the owner is fine skipping the sweep; "path" when they gave a new script location. */
  choice: "skip" | "path";
  /** The script path the owner supplied, verbatim, when choice is "path". */
  scriptPath: string;
}

interface KillApproval {
  /** True only when the owner clearly approved the kill sweep. */
  approved: boolean;
  /** Their words, quoted into the recap. */
  ownerWords: string;
}

interface SweepOutcome {
  /** Whether the session-process-registry script exists on this machine. */
  registryAvailable: boolean;
  /** Whether the owner approved `sweep --kill`. */
  killApproved: boolean;
  /** Whether `sweep --kill` ran and exited zero. */
  killRan: boolean;
  /** The sweep summary, quoted into the recap's Notes. */
  sweepSummary: string;
  /** Report-only `orphans` listing. */
  orphansSummary: string;
  /** Report-only `docker-orphans` listing. */
  dockerOrphansSummary: string;
}

interface PlanStatusResult {
  /** Workspace-relative plan whose frontmatter was edited. */
  planPath: string;
  /** True when the edit landed. */
  changed: boolean;
  /** Where the change landed, as path:line. */
  location: string;
  /** What was written ("status: completed", "updated bumped"), or why nothing was. */
  note: string;
}

interface RecapNarrative {
  /** 1-2 sentences: the session's headline accomplishment. */
  summary: string;
  /** Prose on new capabilities; "Nothing new this session." when none. */
  added: string;
  /** Prose on bug fixes; "Nothing fixed this session." when none. */
  fixed: string;
  /** Prose on other changes (refactors, conventions, infra); may be "None.". */
  changed: string;
  /** Open questions and what the next session should pick up. */
  openQuestions: string[];
  /** Free-form notes and gotchas for future sessions. */
  notes: string[];
}

interface ReaderCritique {
  /** True when the recap reads clearly and says only what its evidence supports. */
  acceptable: boolean;
  /** What is unclear or unsupported, each item concrete and actionable. */
  issues: string[];
}

interface EvidencePack {
  shape: string;
  areas: TouchedArea[];
  walks: PlanWalk[];
  applied: DocApplyResult[];
  deferred: DocDecision[];
  proposalsNoUpdate: string[];
  sweep: SweepOutcome;
  commits: string[];
  changedPaths: string[];
  owner: OwnerDecisions;
  preflight: string[];
  /** What was left out of the pack for size, so the recap discloses it instead of inventing it. */
  omissions: string[];
}

interface FillPayload {
  date: string;
  /**
   * How the fill treats the output file. "write" creates or appends on first touch;
   * "overwrite" replaces a file this run created (its own region only — anything appended
   * after this run's write, bounded by prevLen, is re-appended); "append" adds this run's
   * block to a recap that already existed; "replace-appended" swaps the block this run
   * appended — without it a revision round would stack a second copy in the deliverable.
   * The revision-round mode is chosen from round 1's observed stdout, not from run-start
   * state, because the file can change while the run is parked on owner escalations.
   */
  mode: "write" | "overwrite" | "append" | "replace-appended";
  /**
   * File length, in characters, right after this run's round-1 fill. Only set on revision
   * rounds: replace-appended searches for this run's marker within [0, prevLen) and
   * re-appends anything a second session appended since; overwrite keeps cur.slice(prevLen)
   * as a trailing tail. Foreign content is never truncated by a revision.
   */
  prevLen?: number;
  /**
   * Anchor keys are matched as substrings of template lines, so each key must be unique to
   * its line: plain words ("observation") also occur in surrounding prose and would fill the
   * wrong line. Keys that are not template-specific keep the {{placeholder}} braces.
   */
  anchors: Record<string, string>;
  drop: string[];
}

interface ProgressItem {
  /** Short label of what advanced ("recap shape", "criteria walk", "doc decision"). */
  item: string;
  /** Where it stands ("evidence", "with-owner", "decided", "applied", "deferred"). */
  stage: string;
  /** One line a reader can act on. */
  detail: string;
}

interface Finding {
  /** Workspace-relative path, with a line when it applies: "docs/plans/x.md:3". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and the output that proved it. */
  evidence: string;
  /** "verified" when an independent check or the owner confirmed it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the session recap run did and found. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ---------------------------------------------------------------------------
// Script-side knobs: loop caps and fixed paths live HERE, never in ask text
// (an AmendWorkflow that tunes them must not rewrite a single prompt).
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = "/Users/alejandrodelvillar/.agents/skills/write-session-recap/templates/recap.md.template";
const REGISTRY_SCRIPT = "/Users/alejandrodelvillar/.hermes/skills/software-development/session-process-registry/scripts/process_registry.py";
const RECAPS_GLOB = "docs/recaps/SESSION-RECAP-*.md";
const PLANS_GLOB = "docs/plans/*.md";
/** Serialized-evidence-pack budget in characters, so the writer ask cannot hit a ContextLimit. */
const EVIDENCE_PACK_CHAR_CAP = 60000;

// Accumulators filled by the phases below; the recap and the report read them at the end.
const walks: PlanWalk[] = [];
const applyResults: DocApplyResult[] = [];
const statusResults: PlanStatusResult[] = [];
const findings: Finding[] = [];
let decisions: DocDecision[] = [];
let registryScript = REGISTRY_SCRIPT;

// Every finding is reported to the board the moment it is created — never accumulated and
// reported in one loop at the end (§10: the array is what you lose; a failure after the
// sweep phase must not take earlier findings with it).
function addFinding(f: Finding): Finding {
  findings.push(f);
  progress({ item: `finding: ${f.where}`, stage: "decided", detail: `${f.severity}: ${f.what}` });
  return f;
}

// Every board row is built through this helper so the shape matches the declared columns
// (ProgressItem is the row type; the board reads item/stage/detail).
function progress(p: ProgressItem): void {
  report(p, "recap-progress");
}

// ---------------------------------------------------------------------------
// Dashboard: one board the owner can watch while the run is parked on their answers
// ---------------------------------------------------------------------------

artifact.board("recap-progress", {
  title: "Session recap progress",
  key: "item",
  status: "stage",
  columns: ["evidence", "with-owner", "decided", "applied", "deferred"],
  cardTitle: "item",
  detail: [{ field: "detail", label: "Detail" }],
});

// ---------------------------------------------------------------------------
// Phase 1 — Pre-flight: what does this session have to work with? (SKILL.md:36-43)
// Deterministic existence checks. docs/recaps/ is known to be missing in this repo;
// the run records that and tells the owner rather than failing.
// ---------------------------------------------------------------------------

phase("Check what this session has to work with");

const planFiles = await files.glob(PLANS_GLOB);
const priorRecaps = await files.glob(RECAPS_GLOB);
const recapsDir = await world.run("test", ["-d", "docs/recaps"]);
const claudeMd = await world.run("test", ["-f", "CLAUDE.md"]);
const registryPresent = await world.run("test", ["-f", REGISTRY_SCRIPT]);

const preflight: string[] = [];
if (recapsDir.exitCode !== 0) preflight.push("docs/recaps/ does not exist — the owner will be asked to consent to creating it before the recap is written (SKILL.md:39)");
if (claudeMd.exitCode !== 0) preflight.push("CLAUDE.md not found — contract-doc housekeeping context is unavailable in this repo");
if (planFiles.length === 0) preflight.push("docs/plans/ has no plan files");
if (registryPresent.exitCode !== 0) preflight.push("session-process-registry script not found at its expected path — the owner will be asked whether to skip the sweep or where the script lives");
for (const w of preflight) log(`Pre-flight: ${w}`);
if (priorRecaps.length > 0) log(`Pre-flight: ${priorRecaps.length} prior recap(s) found; the most recent sets the change cutoff`);

// ---------------------------------------------------------------------------
// Phase 2 — Detect what changed and find the active plans (SKILL.md:45-73)
// Git evidence and the active-plan grep are deterministic; the "last recap" cutoff is
// filtered in script code because a prior recap sets it.
// ---------------------------------------------------------------------------

phase("Detect what changed and find the active plans");

let changedPaths: string[] = [];
try {
  changedPaths = await git.changedFiles();
} catch {
  try {
    changedPaths = await files.glob("**/*");
  } catch {
    changedPaths = [];
    log("Could not enumerate changed files (git unavailable and the workspace glob overran its cap)");
  }
}

let gitStatus: GitStatus = { clean: true, staged: [], unstaged: [], untracked: [] };
let gitStatusAvailable = true;
try {
  gitStatus = await git.status();
} catch {
  gitStatusAvailable = false;
  log("git status unavailable — the staged-empty check and commit-state lines will say so instead of asserting");
}
// Commits carry the facade's commit shape without naming any ambient type (strict TS).
let commits: GitCommit[] = [];
try {
  commits = await git.log(20);
} catch {
  log("git log unavailable — the recap will say so instead of inventing commits");
}
// HEAD at run start, for the never-commit assertion at verification time.
const startHead = commits[0] ? commits[0].hash : "";
if (startHead === "") log("HEAD-unchanged check will be skipped: no commits were readable at run start");

const lastRecapPath = priorRecaps.length > 0 ? priorRecaps[priorRecaps.length - 1] : "";
let recapCutoff = "";
if (lastRecapPath !== "") {
  recapCutoff = lastRecapPath.split("/").slice(-1)[0].replace("SESSION-RECAP-", "").replace(".md", "");
}
const sessionCommits =
  recapCutoff !== "" ? commits.filter((c) => c.date.slice(0, 10) >= recapCutoff) : commits;

// SKILL.md:62-64 asks for the files changed since the last recap — committed AND uncommitted.
// git.changedFiles() covers only the working tree, so when the recap window holds commits,
// fold in everything that differs from the window's oldest commit; otherwise the area mapper
// and the plan walkers judge alignment against an incomplete change set. The git facade takes
// one ref (no ranges), so the oldest commit's own delta stays a disclosed residual.
if (recapCutoff !== "" && sessionCommits.length > 0) {
  try {
    const sinceBase = sessionCommits[sessionCommits.length - 1].hash;
    for (const p of await git.changedFiles(sinceBase)) {
      if (!changedPaths.includes(p)) changedPaths.push(p);
    }
  } catch {
    log("Could not enumerate committed files since the cutoff — the change set stays working-tree only");
  }
}

const activeMatches = await files.grep("^status: active", PLANS_GLOB);
const activePlanPaths: string[] = [];
for (const m of activeMatches) {
  if (!activePlanPaths.includes(m.path)) activePlanPaths.push(m.path);
}
log(`${activePlanPaths.length} active plan(s), ${changedPaths.length} changed file(s), ${sessionCommits.length} commit(s) since the cutoff`);

const templateCheck = await world.run("test", ["-f", TEMPLATE_PATH]);
if (templateCheck.exitCode !== 0) {
  preflight.push("the recap template is missing at its expected path — the owner will be asked for its current location (SKILL.md:157 requires the template)");
  log("WARNING: the recap template is missing at its expected path — the owner will be asked where it moved");
}

// ---------------------------------------------------------------------------
// Phase 3 — Read each active plan and map the changed areas (SKILL.md:75-79, :111)
// One walker per active plan (names keyed on the glob-unique plan path), plus one
// shared area mapper that must see every change at once for a consistent grouping.
// ---------------------------------------------------------------------------

phase("Read each active plan and map the changed areas");

const commitSubjects = sessionCommits.map((c) => `${c.hash.slice(0, 7)} ${c.subject}`);
const mapper = agent("Area mapper", {
  system:
    "You group a session's file changes into feature areas for a session recap. " +
    "Ground every area in the actual file paths given — never speculate about areas the diff does not show " +
    "(SKILL.md:234: use the file diff as the ground truth). Do not edit any file. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});

const mapperTask = mapper.ask<TouchedAreas>(
  `Group this session's changes into feature areas. Follow /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 6a (:111) for how areas map to features. ` +
  `Changed files: ${JSON.stringify(changedPaths)}. ` +
  `Commit subjects this session: ${JSON.stringify(commitSubjects)}. ` +
  `For each area: a short name, its file paths, one grounded sentence on what changed, and whether the changes look like substantial feature work rather than maintenance. ` +
  `Return every area; an empty list only if nothing changed.`,
);

interface WalkerOutcome {
  evidence: PlanEvidence;
  /** The same subagent instance, re-asked in the criteria phase so its context is retained. */
  walker: Agent;
}

const walkerOutcomes: WalkerOutcome[] = [];
if (activePlanPaths.length > 0) {
  const outcomes = await Promise.all(
    activePlanPaths.map(async (planPath) => {
      const walker = agent(`Plan walker for ${planPath}`, {
        system:
          "You gather evidence from one plan file for a session recap. Read-only: do not edit any file, and never judge acceptance criteria on your own authority — that walk happens with the run owner. " +
          "Cite path:line for everything you report. " +
          "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
      });
      const evidence = await walker.ask<PlanEvidence>(
        `Read the plan at ${planPath} in full and gather evidence for the session recap, following /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 3 (:75-79). ` +
        `This session's changed files: ${JSON.stringify(changedPaths)}. Commits: ${JSON.stringify(commitSubjects)}. ` +
        `Report: feature name, the status line exactly as found, every acceptance-criterion checkbox verbatim and in order, how the changed files align with the plan's "Files to be touched" section, and the plan's "Linked artifacts" — the contract docs that need updating (:79). ` +
        `Do not assess the criteria yet. Return PlanEvidence.`,
      );
      progress({ item: `plan evidence: ${evidence.featureName}`, stage: "evidence", detail: `${evidence.criteria.length} criterion(a) found in ${planPath}` });
      return { evidence, walker };
    }),
  );
  walkerOutcomes.push(...outcomes);
}

const areas = await mapperTask;
log(`Mapped ${areas.length} touched area(s): ${areas.map((a) => a.name).join(", ") || "none"}`);

// Contract docs the session's plans themselves name as needing updates (SKILL.md:79); the
// proposers check these first, alongside the repo's standard contract docs.
const planLinkedArtifacts = [...new Set(walkerOutcomes.map((o) => o.evidence.linkedArtifacts).flat())];
if (planLinkedArtifacts.length > 0) log(`Plans name ${planLinkedArtifacts.length} linked artifact(s) for the proposal phase`);

// ---------------------------------------------------------------------------
// Phase 4 — Settle the run-level questions with the run owner
// (SKILL.md:81, :83-91, :144-153, plus template location and docs/recaps consent).
// One batched escalation. This is one of two owner channels: run-level questions are
// serialized here on the liaison; per-plan questions escalate in parallel from the
// walkers in the next phase (independent plans, independent questions).
// ---------------------------------------------------------------------------

phase("Settle the recap shape with the run owner");

const liaison = agent("Owner liaison", {
  system:
    "You are the run-level voice between this recap workflow and the run owner. " +
    "Put every owner-only question into ONE escalation call, each answerable in a sentence, and never re-escalate something already asked. " +
    "Never decide on the owner's behalf and never round an ambiguous answer to a decision — record it as unanswered. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});

const anyFeatureSignal = areas.some((a) => a.looksLikeFeatureWork);
const shapeQuestion =
  activePlanPaths.length > 0
    ? "the active plan(s) make this a feature recap unless the owner says the session was really maintenance"
    : anyFeatureSignal
      ? "there are no active plans but the changes look like feature work, so the shape is genuinely ambiguous"
      : "there are no active plans and the changes look small, so maintenance is the likely shape";

const ownerDecisions = await liaison.ask<OwnerDecisions>(
  `Ask the run owner the questions only they can answer, per /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md: the recap shape when ambiguous (:83-91 — ask which shape when it is ambiguous), the no-active-plan question when it applies (:81 — substantial feature work with no active plan: maintenance, or backfill a plan for the record?), and whether CLAUDE.local.md was edited this session with a high-level summary only, never any secret content (:146-153). ` +
  `Also, only when the pre-flight notes call for it: if the recap template is missing at its expected path, ask the owner for its current path (templatePathAnswer); and ask the owner to explicitly agree or object to creating docs/recaps/ to hold the recap (recapsDirConsent: "create" or "skip") — if they do not answer, set "unanswered"; never default to creating (:39). ` +
  `Evidence for them: ${shapeQuestion}. Active plans: ${JSON.stringify(activePlanPaths)}. Touched areas: ${JSON.stringify(areas.map((a) => a.name))}. Commits: ${JSON.stringify(commitSubjects)}. ` +
  `Pre-flight notes to mention: ${JSON.stringify(preflight)}. ` +
  `Escalate once with all of the applicable questions together. Return OwnerDecisions; for any question the owner did not answer, say so in the matching field rather than filling it in.`,
);

progress({ item: "recap shape", stage: "decided", detail: `${ownerDecisions.shape} — ${ownerDecisions.shapeRationale}` });
log(`Recap shape: ${ownerDecisions.shape}`);

// Resolve the template: the default path, or the path the owner supplied when it moved.
const templatePath = ownerDecisions.templatePathAnswer.trim() !== "" ? ownerDecisions.templatePathAnswer.trim() : TEMPLATE_PATH;
const templateResolved = await world.run("test", ["-f", templatePath]);
if (templateResolved.exitCode !== 0) {
  log(`WARNING: the recap template is unresolvable at ${templatePath === TEMPLATE_PATH ? "its expected path" : "the owner-supplied path"} — the fill will fail and the owner will be told`);
}

// ---------------------------------------------------------------------------
// Phase 5 — Walk each plan's acceptance criteria WITH the run owner (SKILL.md:93-104)
// Feature shape only. Each walker re-asks its own subagent (context retained) and that
// subagent escalates to the owner with all of its criteria at once. No status is invented.
//
// Deviation from the letter of SKILL.md:95 ("one criterion at a time"), and why: the
// facade caps every ask at three escalations (§14), so a plan with more than three
// criteria cannot be walked one escalation per criterion. The faithful adaptation is one
// batched escalation per plan, each criterion still individually confirm-or-correct.
// Walkers escalate in parallel by design — plans are independent — so the owner may see
// several plan escalations at once; run-level questions stay serialized on the liaison.
// ---------------------------------------------------------------------------

if (ownerDecisions.shape === "feature" && walkerOutcomes.length > 0) {
  phase("Walk each plan's acceptance criteria with the run owner");
  log(`Walking the acceptance criteria of ${walkerOutcomes.length} plan(s) with the run owner`);

  await Promise.all(
    walkerOutcomes.map(async ({ evidence, walker }) => {
      const walk = await walker.ask<PlanWalk>(
        `Walk the acceptance criteria of ${evidence.planPath} WITH the run owner, following /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 5 (:93-104). ` +
        `Your evidence: ${JSON.stringify(evidence)}. ` +
        `For each criterion: state your assessment (met / partial / unmet / deferred), justify it from the file changes you observed, then escalate ONCE to the run owner presenting every criterion with your assessment and asking them to confirm or correct each one. ` +
        `In the same escalation, ask whether the plan is complete, and get their explicit yes or no before any status edit (:233: status changes require unambiguous confirmation); if it stays active, ask whether to bump its updated date. ` +
        `Use the owner's word as the final status; anything they did not answer stays "unanswered" and must not be rounded to a verdict. Return PlanWalk.`,
      );
      walks.push(walk);
      progress({
        item: `criteria walk: ${walk.featureName}`,
        stage: "decided",
        detail: walk.assessments.map((a) => a.final).join(", ") + (walk.statusEditApproved ? " — completion approved" : " — stays active"),
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 6 — Propose contract-doc updates for each touched area (SKILL.md:106-136)
// Feature shape only. One proposer per area (index-named), always propose, never write.
// Proposers check the plans' own "Linked artifacts" first, then the standard contract
// docs. Proposer references are kept so a "modify" decision returns to the same context.
// ---------------------------------------------------------------------------

let proposals: DocProposal[] = [];
const proposerRefs: Agent[] = [];
if (ownerDecisions.shape === "feature" && areas.length > 0) {
  phase("Propose contract-doc updates for each touched area");

  proposals = (
    await Promise.all(
      areas.map(async (area, i) => {
        const proposer = agent(`Contract-doc proposer for area ${i + 1}`, {
          system:
            "You propose contract-doc update text for one feature area of a session recap. " +
            "Always propose, never auto-write: do not edit any file — the run owner is the editor of last resort (SKILL.md:18, :142). " +
            "Cite path:line for the behavior your text describes. " +
            "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
        });
        proposerRefs[i] = proposer;
        return proposer.ask<DocProposals>(
          `Propose the contract-doc updates for the "${area.name}" area, following /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 6 (:106-136). ` +
          `Area files and change: ${JSON.stringify(area)}. ` +
          `The session's plans name these contract docs in their "Linked artifacts" sections — check these first (:79: these are the contract docs that need updating): ${JSON.stringify(planLinkedArtifacts)}. ` +
          `Then check the repo's standard contract docs and read the relevant ones that exist: TECHNICAL-DOCUMENTATION.md, FUNCTIONAL-SPECIFICATIONS.md, and docs/features/ for this area. ` +
          `For each relevant doc, return actual proposed markdown text ready to paste (:120) with the section it belongs in — never "you should add a section about X". ` +
          `When a change is too small or not user-visible for a doc, say so explicitly instead of inventing an update (:125, :129), with noUpdateNeeded true and the reason. ` +
          `When a contract doc does not exist in this repository, return a proposal with noUpdateNeeded true and the reason "doc does not exist in this repo" rather than skipping the area silently. ` +
          `Return one DocProposal per relevant contract doc, each echoing areaIndex ${i} and area "${area.name}" exactly — proposals are keyed by area plus doc, not doc alone.`,
        );
      }),
    )
  ).flat();
  log(`${proposals.length} contract-doc proposal(s) across ${areas.length} area(s)`);
  for (const p of proposals) {
    progress({
      item: `proposal (area ${p.areaIndex}): ${p.docPath}`,
      stage: p.noUpdateNeeded ? "decided" : "with-owner",
      detail: p.noUpdateNeeded ? p.noUpdateReason : p.section === "" ? p.rationale : `targets ${p.section}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 7 — The owner decides apply / defer / modify, and only then is anything written
// (SKILL.md:138-142, :226). One batched escalation per round over ONLY the proposals still
// undecided — earlier apply/defer decisions carry forward and are never re-asked (the
// liaison persona's own rule). Modifications loop back to the same proposer (context
// retained) and re-escalate, bounded at two rounds; anything still "modify" at the cap is
// recorded as deferred debt, never dropped and never applied. Proposals and decisions are
// keyed by areaIndex + docPath + section, never docPath alone: two areas can legitimately
// propose updates to the same contract doc (the normal case for TECHNICAL-DOCUMENTATION.md
// in a multi-area session), and a docPath-keyed merge would silently drop one area's
// owner-approved decision and could route a revision to the wrong area's proposer.
// ---------------------------------------------------------------------------

// A proposal's identity: area + doc + section (see the phase comment for why).
function decisionKey(x: { areaIndex: number; docPath: string; section: string }): string {
  return `${x.areaIndex}:${x.docPath}:${x.section}`;
}

let actionable = proposals.filter((p) => !p.noUpdateNeeded);
if (actionable.length > 0) {
  phase("Get the owner's apply, defer, or modify decision on the proposed doc updates");

  const proposerByArea = new Map<number, Agent>();
  for (let i = 0; i < proposerRefs.length; i++) proposerByArea.set(i, proposerRefs[i]);

  let pendingProposals = actionable;
  for (let round = 1; round <= 2 && pendingProposals.length > 0; round++) {
    const roundDecisions = await liaison.ask<DocDecisions>(
      `Ask the run owner what to do with the proposed contract-doc updates: "Should I apply these updates to the docs, defer them, or modify them first?" (/Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md:138). Per-update or batch approval, exactly as they prefer (:142, :226). ` +
      `Round ${round} — only these proposals are still undecided${round > 1 ? "; the owner's earlier apply and defer decisions stand and are NOT re-asked" : ""}: ${JSON.stringify(pendingProposals.map((p) => ({ key: decisionKey(p), area: p.area, doc: p.docPath, section: p.section, rationale: p.rationale })))}. ` +
      `Escalate once with every still-undecided proposal, each answerable in a sentence. Return one DocDecision per proposal listed, echoing each proposal's areaIndex, area, docPath, and section exactly — two areas may target the same doc, so the combination, not the doc alone, identifies the proposal. For any proposal the owner did not answer, return decision "unanswered" rather than omitting it.`,
    );
    const decidedKeys = new Set(roundDecisions.map((d) => decisionKey(d)));
    decisions = decisions.filter((d) => !decidedKeys.has(decisionKey(d))).concat(roundDecisions);

    const toModify = roundDecisions.filter((d) => d.decision === "modify");
    if (toModify.length === 0 || round === 2) break;

    progress({ item: "doc decisions", stage: "decided", detail: `${toModify.length} proposal(s) sent back for modification` });
    await Promise.all(
      toModify.map(async (d) => {
        const targetIndex = actionable.findIndex((p) => decisionKey(p) === decisionKey(d));
        if (targetIndex < 0) return;
        const proposer = proposerByArea.get(actionable[targetIndex].areaIndex);
        if (!proposer) return;
        const revised = await proposer.ask<DocProposals>(
          `The run owner asked for changes before approving this proposal: ${JSON.stringify(d)}. ` +
          `Revise that exact proposal — keep its areaIndex (${d.areaIndex}), docPath (${d.docPath}), and section ("${d.section}") unchanged — and return the revised DocProposal list for ${d.docPath}. Same rules as before: actual markdown text, propose only, edit nothing.`,
        );
        const replacement = revised.find((p) => decisionKey(p) === decisionKey(d));
        if (replacement) {
          proposals = proposals.map((p) => (decisionKey(p) === decisionKey(d) ? replacement : p));
          actionable = actionable.map((p) => (decisionKey(p) === decisionKey(d) ? replacement : p));
        } else {
          addFinding({
            where: d.docPath,
            what: `The revision round for the area-${d.areaIndex} proposal on ${d.docPath} returned no matching proposal, so the owner's requested changes could not be folded in; the original proposal stays pending.`,
            evidence: `proposer ask returned ${revised.length} proposal(s), none keyed ${decisionKey(d)}`,
            status: "verified",
            severity: "low",
          });
        }
      }),
    );
    pendingProposals = toModify
      .map((d) => actionable.find((p) => decisionKey(p) === decisionKey(d)))
      .filter((p): p is DocProposal => p !== undefined);
  }

  // A "modify" still standing at the round cap becomes recorded debt, not silence.
  decisions = decisions.map((d) =>
    d.decision === "modify"
      ? { ...d, decision: "defer" as const, ownerNote: "owner requested further changes past the revision limit: " + d.ownerNote }
      : d,
  );

  // Completeness: a proposal the liaison's escalation never returned a decision for must not
  // vanish — record it as unanswered, disclosed in the deferred list and as a finding.
  const decidedKeys = new Set(decisions.map((d) => decisionKey(d)));
  for (const p of actionable) {
    if (!decidedKeys.has(decisionKey(p))) {
      decisions.push({
        areaIndex: p.areaIndex,
        area: p.area,
        docPath: p.docPath,
        section: p.section,
        decision: "unanswered",
        ownerNote: "the decision escalation never returned an answer for this proposal",
      });
      addFinding({
        where: p.docPath,
        what: `The area-${p.areaIndex} proposal on ${p.docPath} received no owner decision, so nothing was applied and it is carried as open debt.`,
        evidence: `no DocDecision keyed ${decisionKey(p)} in ${decisions.length} returned decision(s)`,
        status: "verified",
        severity: "low",
      });
    }
  }

  const approved = decisions.filter((d) => d.decision === "apply");
  const deferred = decisions.filter(
    (d) => d.decision === "defer" || d.decision === "drop" || d.decision === "unanswered",
  );
  progress({
    item: "doc decisions",
    stage: "decided",
    detail:
      `${approved.length} approved, ${deferred.filter((d) => d.decision !== "unanswered").length} deferred, ` +
      `${deferred.length - deferred.filter((d) => d.decision !== "unanswered").length} unanswered`,
  });

  if (approved.length > 0) {
    phase("Apply the doc updates the owner approved");
    await Promise.all(
      approved.map(async (d, i) => {
        const target = actionable.find((p) => decisionKey(p) === decisionKey(d));
        if (!target) return;
        const applier = agent(`Contract-doc updater ${i + 1}`, {
          system:
            "You apply one owner-approved contract-doc update. Edit exactly the named doc and section with the approved text, nothing else. " +
            "Never run git add, git commit, or git push — the owner owns commits (SKILL.md:220, :231). " +
            "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
        });
        const result = await applier.ask<DocApplyResult>(
          `Apply this owner-approved update: decision ${JSON.stringify(d)}, approved text ${JSON.stringify(target)}. ` +
          `Edit ${d.docPath} at the named section with the approved text. Return DocApplyResult with the path:line of the change.`,
        );
        applyResults.push(result);
        progress({ item: `applied (area ${d.areaIndex}): ${result.docPath}`, stage: "applied", detail: result.note });
      }),
    );
  }
  for (const d of deferred) {
    progress({ item: `deferred (area ${d.areaIndex}): ${d.docPath}`, stage: "deferred", detail: d.ownerNote === "" ? "owner deferred, no reason given" : d.ownerNote });
  }
}

function deferredDecisions(): DocDecision[] {
  return decisions.filter(
    (d) => d.decision === "defer" || d.decision === "drop" || d.decision === "unanswered",
  );
}

// ---------------------------------------------------------------------------
// Phase 8 — Sweep this session's processes before wrapping up (SKILL.md:174-185)
// The registry script is checked at pre-flight. Report-only listings run as gates;
// `sweep --kill` runs only after the owner approves it. A missing registry script is
// escalated: the owner either accepts the skip or supplies a path, which is re-checked
// before anything runs — never a silent skip.
// ---------------------------------------------------------------------------

phase("Sweep this session's processes before wrapping up");

const sweep: SweepOutcome = {
  registryAvailable: registryPresent.exitCode === 0,
  killApproved: false,
  killRan: false,
  sweepSummary: "",
  orphansSummary: "",
  dockerOrphansSummary: "",
};

if (!sweep.registryAvailable) {
  // Bounded re-ask: one bad owner-supplied path gets exactly one more try before the honest
  // skip — never a silent skip, but also not an unbounded path-typo loop.
  for (let attempt = 1; attempt <= 2 && !sweep.registryAvailable; attempt++) {
    const answer = await liaison.ask<SweepPathAnswer>(
      // The registry path IS interpolated here, unlike a tuning constant: if REGISTRY_SCRIPT
      // is amended, this escalation must name the new path — asking the owner about a stale
      // location would be worse than re-paying this one ask. The default is what is missing in
      // this branch (the owner-supplied path, if any, is named separately below).
      `The session-process-registry script was not found at ${REGISTRY_SCRIPT}, so the end-of-session process sweep (/Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md:174-185) cannot run. ` +
      `Escalate once: ask the owner whether skipping the sweep is fine, or where the script lives now${attempt > 1 ? ` — a previous answer (${registryScript}) turned out not to exist, so double-check the path with them` : ""}. Return their choice; when they give a path, put it in scriptPath verbatim.`,
    );
    if (answer.choice === "path" && answer.scriptPath.trim() !== "") {
      registryScript = answer.scriptPath.trim();
      const recheck = await world.run("test", ["-f", registryScript]);
      if (recheck.exitCode === 0) {
        sweep.registryAvailable = true;
        log(`Using the owner-supplied registry script at ${registryScript}`);
      } else if (attempt === 1) {
        log(`WARNING: the owner-supplied registry path does not exist (${registryScript}) — asking the owner once more before skipping`);
      } else {
        sweep.sweepSummary = `Registry sweep skipped — the owner-supplied path does not exist (${registryScript}).`;
        addFinding({
          where: registryScript,
          what: "Owner-supplied process-registry path does not exist after a second try; the sweep was skipped.",
          evidence: `world.run("test", ["-f", "${registryScript}"]) exited ${recheck.exitCode} on both attempts`,
          status: "verified",
          severity: "low",
        });
      }
    } else {
      sweep.sweepSummary = `Process sweep skipped at the owner's direction.`;
      break;
    }
  }
}

if (sweep.registryAvailable) {
  const orphans = await world.run("python3", [registryScript, "orphans"]);
  const dockerOrphans = await world.run("python3", [registryScript, "docker-orphans"]);
  sweep.orphansSummary = orphans.stdout.trim() === "" ? "no orphaned processes reported" : orphans.stdout.trim();
  sweep.dockerOrphansSummary = dockerOrphans.stdout.trim() === "" ? "no orphaned docker stacks reported" : dockerOrphans.stdout.trim();
  log(`Registry report-only checks done: ${sweep.orphansSummary}; ${sweep.dockerOrphansSummary}`);

  const approval = await liaison.ask<KillApproval>(
    `Ask the run owner to approve the session's process sweep, per /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md:174-185: "sweep --kill" kills exactly what this session registered (other sessions' entries stay untouched; docker volumes are never removed). ` +
    `Report-only findings to include: orphans — ${sweep.orphansSummary}; docker-orphans — ${sweep.dockerOrphansSummary}. ` +
    `Escalate once: may the run kill this session's registered processes? Return their answer verbatim in ownerWords and set approved only on a clear yes.`,
  );
  sweep.killApproved = approval.approved;

  if (sweep.killApproved) {
    const killed = await world.run("python3", [registryScript, "sweep", "--kill"]);
    sweep.killRan = killed.exitCode === 0;
    sweep.sweepSummary = killed.stdout.trim() === "" ? `sweep exited ${killed.exitCode} with no output` : killed.stdout.trim();
    if (killed.exitCode !== 0) {
      sweep.sweepSummary += ` (stderr: ${killed.stderr.trim().slice(0, 200)})`;
      addFinding({
        where: registryScript,
        what: "sweep --kill was approved but exited nonzero; the recap notes quote its stderr.",
        evidence: `world.run("python3", [..., "sweep", "--kill"]) exited ${killed.exitCode}; stderr: ${killed.stderr.trim().slice(0, 300)}`,
        status: "verified",
        severity: "medium",
      });
    }
  } else {
    sweep.sweepSummary = `Owner declined the kill sweep; report-only findings stand. Their words: ${approval.ownerWords}`;
  }
  progress({ item: "process sweep", stage: "decided", detail: sweep.sweepSummary });
}

// ---------------------------------------------------------------------------
// Phase 9 — Draft the recap from the template and have it read before hand-off
// (SKILL.md:155-172). Narrative comes from the writer; the fill itself is a
// deterministic world.run over the template, anchored line-by-line, appending when a
// recap for today already exists (:172). Each fill declares its mode: round 1 writes or
// appends; a revision round then replaces what this run itself wrote (overwrite on a fresh
// file, replace-appended on a pre-existing one), so a revision never stacks a stale second
// copy into the deliverable. A fresh reader passes over the prose (§3), and
// one bounded revision round feeds its findings back to the same writer. A failed fill or
// an unreadable file escalates to the owner and still delivers the markdown fallback.
// ---------------------------------------------------------------------------

phase("Draft the recap from the template and have it read");

const dateRun = await world.run("date", ["+%Y-%m-%d"]);
const recapDate = dateRun.exitCode === 0 ? dateRun.stdout.trim() : (commits[0] ? commits[0].date.slice(0, 10) : "unknown-date");
const recapPath = `docs/recaps/SESSION-RECAP-${recapDate}.md`;
// Snapshot taken from the phase-1 glob: when a recap for today already exists, this run's
// first fill appends (SKILL.md:172 — multi-session days), and a revision round replaces
// only the block this run appended rather than stacking a second, stale copy.
const recapPreexisted = priorRecaps.includes(recapPath);

const writer = agent("Recap writer", {
  system:
    "You write the narrative parts of a session recap. Diffs are evidence, not narrative (SKILL.md:229): use what the owner and the evidence pack tell you, and escalate ONCE with any remaining intent question you cannot answer from them rather than guessing. " +
    "Never paste secret content; describe CLAUDE.local.md changes at a high level only (:232). Keep the length proportionate to the session (:235). " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});

// Serialized-evidence budget: shrink the pack rather than risk a ContextLimit, and record
// every shrink so the recap can disclose it instead of inventing the missing detail.
function buildEvidencePack(): EvidencePack {
  const pack: EvidencePack = {
    shape: ownerDecisions.shape,
    areas,
    walks,
    applied: applyResults,
    deferred: deferredDecisions(),
    proposalsNoUpdate: proposals.filter((p) => p.noUpdateNeeded).map((p) => `${p.docPath}: ${p.noUpdateReason}`),
    sweep,
    commits: commitSubjects,
    changedPaths,
    owner: ownerDecisions,
    preflight,
    omissions: [],
  };
  if (JSON.stringify(pack).length > EVIDENCE_PACK_CHAR_CAP) {
    pack.changedPaths = [];
    pack.omissions.push("the full changed-file list was dropped from the writer's evidence pack for size; the per-area groupings still carry each area's files");
  }
  if (JSON.stringify(pack).length > EVIDENCE_PACK_CHAR_CAP) {
    pack.areas = areas.map((a) => ({ name: a.name, paths: [], change: a.change, looksLikeFeatureWork: a.looksLikeFeatureWork }));
    pack.omissions.push("per-area file paths were dropped from the writer's evidence pack for size; only area names and change summaries remain");
  }
  if (JSON.stringify(pack).length > EVIDENCE_PACK_CHAR_CAP) {
    pack.commits = commitSubjects.slice(0, 10);
    pack.omissions.push("commit subjects were truncated to the ten most recent for size");
  }
  for (const o of pack.omissions) log(`Evidence pack: ${o}`);
  return pack;
}

const evidencePack = buildEvidencePack();

let narrative = await writer.ask<RecapNarrative>(
  `Draft the narrative parts of today's session recap, following /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 8 (:155-172). ` +
  `Read the template at ${templatePath} so your pieces fit it, and the most recent prior recap for the project's style when one exists: ${lastRecapPath === "" ? "none exists" : lastRecapPath}. ` +
  `Everything gathered this session: ${JSON.stringify(evidencePack)}. ` +
  `Anything listed in omissions was left out of your pack for size — reflect the omission honestly in the recap instead of inventing the missing detail. ` +
  `Return RecapNarrative: the 1-2 sentence summary, the added/fixed/changed prose, open questions, and notes. Plain prose and bullets only — never leave a placeholder in your text.`,
);

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function criteriaTable(walk: PlanWalk): string {
  return walk.assessments
    .map((a) => `| ${escapeCell(a.criterion)} | ${a.final} | ${escapeCell(a.justification)}${a.ownerNote === "" ? "" : ` — owner: ${escapeCell(a.ownerNote)}`} |`)
    .join("\n");
}

function plansBody(): string {
  if (walks.length === 0) {
    return ownerDecisions.noPlanAnswer !== ""
      ? `No active plan in docs/plans/. Owner, on the record: ${ownerDecisions.noPlanAnswer}`
      : "No active plan — this was maintenance work.";
  }
  const blocks = walks.map((w) => {
    const statusLine = w.statusEditApproved ? "completed" : "active";
    const note = w.statusEditApproved
      ? "Marked completed this session with the owner's explicit confirmation."
      : `Stays active${w.updatedBumpApproved ? "; updated date bumped with the owner's approval" : ""}. Open criteria: ${w.assessments.filter((a) => a.final !== "met").map((a) => a.criterion).join("; ") || "none"}.`;
    return [
      `### \`docs/plans/${w.planPath.replace("docs/plans/", "")}\` — ${w.featureName}`,
      "",
      `Status after this session: **${statusLine}**`,
      "",
      "| Acceptance criterion | Status | Notes |",
      "|---|---|---|",
      criteriaTable(w),
      "",
      note,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

function commitsBody(): string {
  if (sessionCommits.length === 0) {
    if (!gitStatusAvailable) {
      return "No commits were readable this run, and git status is unavailable — the working-tree state could not be checked.";
    }
    return gitStatus.clean
      ? "No commits yet — the working tree is clean."
      : `No commits yet — work is uncommitted${gitStatus.branch ? ` on the ${gitStatus.branch} branch` : ""}.`;
  }
  return sessionCommits.map((c) => `| \`${c.hash.slice(0, 7)}\` | ${escapeCell(c.subject)} |`).join("\n");
}

function commitsSection(): string {
  return sessionCommits.length === 0 ? commitsBody() : ["| Hash | Message |", "|---|---|", commitsBody()].join("\n");
}

function filesBody(): string {
  const lines: string[] = [];
  for (const area of areas) {
    lines.push(`**${area.name}**`, "");
    for (const p of area.paths) lines.push(`- \`${p}\` — ${area.change}`);
    lines.push("");
  }
  const grouped = new Set(areas.flatMap((a) => a.paths));
  const rest = changedPaths.filter((p) => !grouped.has(p));
  if (rest.length > 0) {
    lines.push("**Other**", "");
    for (const p of rest) lines.push(`- \`${p}\``);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function bullets(items: string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

function docAppliedBody(): string {
  if (applyResults.length === 0) {
    return deferredDecisions().length > 0
      ? "No contract doc updates applied this session — see deferred below."
      : "No contract doc updates needed — the change is too small or not user-visible.";
  }
  return bullets(applyResults.map((r) => `\`${r.docPath}\`${r.section === "" ? "" : ` § ${r.section}`} — ${r.note}`));
}

function docDeferredBody(): string {
  const deferred = deferredDecisions();
  if (deferred.length === 0) return "None.";
  return bullets(
    deferred.map(
      (d) =>
        `\`${d.docPath}\`${d.section === "" ? "" : ` § ${d.section}`} — ${d.decision === "unanswered" ? "no decision returned by the owner" : "deferred"}. ${d.ownerNote === "" ? "Owner gave no reason." : `Owner: ${d.ownerNote}`} Pick up next session.`,
    ),
  );
}

function claudeLocalBody(): string {
  if (!ownerDecisions.claudeLocalChanged) return "(None — CLAUDE.local.md was not edited this session.)";
  return `- Updated: ${ownerDecisions.claudeLocalSummary}`;
}

function openQuestionsBody(): string {
  return bullets(narrative.openQuestions.length > 0 ? narrative.openQuestions : ["None — everything raised this session was resolved."]);
}

function notesBody(): string {
  const notes = [...narrative.notes];
  if (sweep.sweepSummary !== "") notes.push(`Wrapped up: ${sweep.sweepSummary}`);
  return bullets(notes.length > 0 ? notes : ["None."]);
}

function buildPayload(mode: FillPayload["mode"]): FillPayload {
  return {
    date: recapDate,
    mode,
    anchors: {
      "Session Recap": `# Session Recap — ${recapDate}`,
      "hallway": narrative.summary,
      "For each active plan touched": plansBody(),
      "If a plan was marked completed": walks.some((w) => w.statusEditApproved)
        ? "Status changes this session: " + walks.filter((w) => w.statusEditApproved).map((w) => `${w.planPath} -> completed`).join(", ") + "."
        : "",
      "If the work was maintenance": "",
      "If no commits yet": commitsSection(),
      "Prose description of new capabilities": narrative.added,
      "Prose description of bug fixes": narrative.fixed,
      "strictly additions or fixes": narrative.changed,
      "**Frontend**": filesBody(),
      "If no contract docs needed updating": docAppliedBody(),
      "Empty list is good": docDeferredBody(),
      "Only include this section if": claudeLocalBody(),
      "open question or TBD": openQuestionsBody(),
      "follow-up task": "",
      "Empty list is fine": "",
      "{{observation}}": notesBody(),
    },
    drop: [
      "**Backend / API**",
      "**Database**",
      "**Documentation**",
      "**Configuration / Infra**",
      "(Delete sections that don't apply.)",
      // The template's own table header rows (recap.md.template:15-16 and :28-29) contain no
      // {{placeholder}}, so the {{ filter would not remove them — drop them explicitly; the
      // generated blocks in plansBody()/commitsSection() emit their own header pairs.
      "| Acceptance criterion | Status | Notes |",
      "|---|---|---|",
      "| Hash | Message |",
      "|------|---------|",
    ],
  };
}

const reader = agent("Recap reader", {
  system:
    "You are a reader seeing this recap for the first time. Judge the text as a reader would, from the text alone: what is unclear, what the text itself fails to support, what the owner will ask next. " +
    "Do not verify it against the repository and do not edit anything — say what reads wrong, not what the files say. " +
    "If your instructions contradict each other, escalate and say so plainly rather than working around it.",
});

let recapWritten = false;
let fillLog = "";
// Consent gates only the CREATION of docs/recaps/ (SKILL.md:39). When the directory already
// exists the recap file is ordinary output — no question is ever asked about it, so no answer
// can gate it; requiring "create" here would false-block the deliverable in every repo that
// already has docs/recaps/.
const mayWriteRecap = recapsDir.exitCode === 0 || ownerDecisions.recapsDirConsent === "create";
if (mayWriteRecap) {
  // Length of the recap file right after this run's first fill, so a revision round can
  // replace exactly its own block and keep anything another session appended since.
  let prevLen = -1;
  // What round 1 actually did to the file, parsed from its own stdout ("wrote:" vs
  // "appended:"). The phase-1 recapPreexisted snapshot can go stale while this run is parked
  // on owner escalations — another session can create today's recap in that window — so the
  // revision round's mode follows the observed outcome, never the snapshot.
  let round1Outcome: "wrote" | "appended" | "" = "";
  for (let round = 1; round <= 2; round++) {
    // Fill mode: round 1 keeps the skill's append-if-exists behavior (:172) — and even mode
    // "write" appends if the file sprang into existence mid-run, which its stdout reports.
    // Round 2 then replaces or overwrites exactly the region this run is responsible for
    // (bounded by prevLen), so neither a stale second copy nor another session's content is
    // ever truncated into the deliverable.
    const fillMode: FillPayload["mode"] =
      round === 1
        ? recapPreexisted
          ? "append"
          : "write"
        : round1Outcome === "appended"
          ? "replace-appended"
          : "overwrite";
    const fill = await world.run("node", [
      "-e",
      'const fs=require("fs");const path=require("path");' +
      'const [tpl,out,payloadJson]=process.argv.slice(1);' +
      'const p=JSON.parse(payloadJson);' +
      'let lines=fs.readFileSync(tpl,"utf8").split("\\n");' +
      'const used=new Set();' +
      'const subst=[];' +
      'lines=lines.map(function(l){for(const a of Object.keys(p.anchors)){if(l.indexOf(a)!==-1){used.add(a);subst.push(true);return p.anchors[a];}}subst.push(false);return l;});' +
      'const missing=Object.keys(p.anchors).filter(function(a){return !used.has(a);});' +
      'lines=lines.filter(function(l,i){return p.drop.indexOf(l)===-1&&(subst[i]||l.indexOf("{{")===-1);});' +
      'let t=lines.join("\\n").replace(/\\n{3,}/g,"\\n\\n").trim()+"\\n";' +
      'fs.mkdirSync(path.dirname(out),{recursive:true});' +
      'const marker="\\n\\n---\\n\\n# Session Recap (continued) — "+p.date;' +
      'const block=marker+"\\n\\n"+t;' +
      'if(p.mode==="append"){fs.appendFileSync(out,block);console.log("appended:"+out);}' +
      'else if(p.mode==="replace-appended"){const cur=fs.readFileSync(out,"utf8");const win=(typeof p.prevLen==="number"&&p.prevLen>=0&&p.prevLen<=cur.length)?p.prevLen:cur.length;const idx=cur.slice(0,win).lastIndexOf(marker);if(idx===-1){fs.appendFileSync(out,block);console.log("appended:"+out);}else{fs.writeFileSync(out,cur.slice(0,idx)+block+cur.slice(win));console.log("replaced-appended:"+out);}}' +
      'else if(p.mode==="overwrite"){const cur=fs.existsSync(out)?fs.readFileSync(out,"utf8"):"";let tail="";if(cur!==""&&typeof p.prevLen==="number"&&p.prevLen>=0&&p.prevLen<=cur.length){tail=cur.slice(p.prevLen);}fs.writeFileSync(out,t+tail);console.log("wrote:"+out);}' +
      'else{if(fs.existsSync(out)){fs.appendFileSync(out,block);console.log("appended:"+out);}else{fs.writeFileSync(out,t);console.log("wrote:"+out);}}' +
      'if(missing.length>0){console.log("MISSING-ANCHORS:"+missing.join(" | ").slice(0,400));}',
      templatePath,
      recapPath,
      round === 1 ? JSON.stringify(buildPayload(fillMode)) : JSON.stringify({ ...buildPayload(fillMode), prevLen }),
    ]);
    fillLog = fill.stdout.trim() + (fill.stderr.trim() !== "" ? "\nSTDERR: " + fill.stderr.trim() : "");
    log(`Template fill (round ${round}): ${fillLog.split("\n")[0]}`);
    if (round === 1) {
      round1Outcome = fill.stdout.includes("appended:") ? "appended" : fill.stdout.includes("wrote:") ? "wrote" : "";
    }

    if (fill.exitCode !== 0) {
      addFinding({
        where: recapPath,
        what: "The template fill command failed, so no recap file was written this round.",
        evidence: `world.run("node", ["-e", ...]) exited ${fill.exitCode}; stderr: ${fill.stderr.trim().slice(0, 300) || "(empty)"}`,
        status: "verified",
        severity: "high",
      });
      const answer = await liaison.ask<OwnerAnswer>(
        `The recap template fill failed, so the recap file at ${recapPath} was not written. stderr: ${fill.stderr.trim().slice(0, 400) || "(empty)"}. ` +
        `Escalate once: unless the owner says otherwise, the run will deliver the full recap as a published markdown artifact instead of a file. Record their preference.`,
      );
      addFinding({
        where: recapPath,
        what: "The owner was told the fill failed; the markdown fallback ships unless they said stop.",
        evidence: answer.answer,
        status: "verified",
        severity: "low",
      });
      break;
    }

    let filled = "";
    try {
      filled = await files.read(recapPath);
    } catch {
      filled = "";
    }
    if (filled === "") {
      addFinding({
        where: recapPath,
        what: "The fill exited zero but the recap file could not be read back for the reader pass.",
        evidence: `files.read("${recapPath}") rejected after a zero-exit fill`,
        status: "verified",
        severity: "high",
      });
      break;
    }
    recapWritten = true;
    if (round === 1) prevLen = filled.length;

    // Observability tripwire for the fill: the file-level leftover-placeholder count cannot
    // see a filled line being DROPPED (e.g. an exact-line drop collision), so verify each
    // non-empty anchor value actually reached the written file.
    const sentAnchors = buildPayload(fillMode).anchors;
    for (const [anchorKey, value] of Object.entries(sentAnchors)) {
      if (value !== "" && !filled.includes(value)) {
        addFinding({
          where: recapPath,
          what: `The filled value for template anchor "${anchorKey}" is absent from the written recap — its line was dropped by the fill's filters or the anchor matched an unexpected line.`,
          evidence: `payload value (start): ${value.slice(0, 120).replace(/\n/g, " ")}`,
          status: "verified",
          severity: "medium",
        });
      }
    }

    const leftoverPlaceholders = filled.split("\n").filter((l) => l.includes("{{")).length;
    if (leftoverPlaceholders > 0) log(`WARNING: ${leftoverPlaceholders} line(s) still contain a template placeholder`);

    const critique = await reader.ask<ReaderCritique>(
      `Read the session recap at ${recapPath} as a first-time reader and tell the writer what to fix before the owner sees it. ` +
      `The fill run reported: ${fillLog}. ` +
      `${leftoverPlaceholders > 0 ? `${leftoverPlaceholders} line(s) still contain an unfilled placeholder — name them.` : "No leftover placeholders were detected."} ` +
      `Return ReaderCritique: acceptable true only when the recap reads clearly, matches what the session actually did per the evidence you were given, and carries no leftover template scaffolding.`,
    );

    if (critique.acceptable && leftoverPlaceholders === 0) break;
    if (round === 2) break;

    narrative = await writer.ask<RecapNarrative>(
      `The recap reader flagged the draft at ${recapPath}. Reader issues: ${JSON.stringify(critique.issues)}. ` +
      `Revise your narrative parts to fix exactly these — same evidence pack as before: ${JSON.stringify(evidencePack)}. Return the revised RecapNarrative.`,
    );
  }
} else {
  addFinding({
    where: "docs/recaps/",
    what:
      ownerDecisions.recapsDirConsent === "skip"
        ? "The owner objected to creating docs/recaps/, so no recap file was written; the full recap ships as the published markdown artifact instead."
        : "The owner never answered the docs/recaps/ consent question, so consent was not defaulted: no directory was created and no file was written; the full recap ships as the published markdown artifact instead.",
    evidence: `OwnerDecisions.recapsDirConsent was "${ownerDecisions.recapsDirConsent}" from the phase-4 escalation`,
    status: "verified",
    severity: "low",
  });
}

// ---------------------------------------------------------------------------
// Phase 10 — Update plan statuses exactly as the owner confirmed (SKILL.md:187-196, :233)
// Runs only when a walk produced an approved edit; the marker sits inside the guard so
// an empty stage never appears on the graph.
// ---------------------------------------------------------------------------

const statusEdits = walks.filter((w) => w.statusEditApproved || w.updatedBumpApproved);
if (statusEdits.length > 0) {
  phase("Update plan statuses as the owner confirmed");

  await Promise.all(
    statusEdits.map(async (w) => {
      const statusWriter = agent(`Plan status writer for ${w.planPath}`, {
        system:
          "You apply exactly one owner-confirmed frontmatter edit to a plan file. Change nothing else in the file. " +
          "Never run git add, git commit, or git push — the owner owns commits (SKILL.md:220, :231). " +
          "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
      });
      const instruction = w.statusEditApproved
        ? `Set its frontmatter to status: completed and updated: ${recapDate} — the owner unambiguously approved this during the criteria walk.`
        : `Bump its frontmatter updated field to ${recapDate} and leave status untouched — the owner approved the bump only.`;
      const result = await statusWriter.ask<PlanStatusResult>(
        `Edit the frontmatter of ${w.planPath}. ${instruction} Reference: /Users/alejandrodelvillar/.agents/skills/write-session-recap/SKILL.md step 9 (:187-196). Return PlanStatusResult with the path:line of the change.`,
      );
      statusResults.push(result);
      progress({ item: `plan status: ${w.planPath}`, stage: "applied", detail: result.note });
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 11 — Verify the recap and hand it off (SKILL.md:198-220)
// The skill's own verification commands, then the publish with its compact fallback,
// then the WorkflowReport. Nothing is ever committed or pushed: asserted by both a
// staged-empty check and a HEAD-unchanged check across the run.
// ---------------------------------------------------------------------------

phase("Verify the recap and hand it off");

const headCheck = await world.run("head", ["-20", recapPath]);
if (recapWritten && (headCheck.exitCode !== 0 || !headCheck.stdout.includes("Session Recap"))) {
  addFinding({
    where: recapPath,
    what: "The recap file does not open with the expected title.",
    evidence: `world.run("head", ["-20", "${recapPath}"]) exited ${headCheck.exitCode}; stdout started: ${headCheck.stdout.trim().slice(0, 120)}`,
    status: "verified",
    severity: "high",
  });
}

const statusAfter = await files.grep("^status:", PLANS_GLOB);
for (const w of walks) {
  if (!w.statusEditApproved) continue;
  const line = statusAfter.find((m) => m.path === w.planPath);
  if (!line || !line.text.includes("completed")) {
    addFinding({
      where: w.planPath,
      what: "The owner approved completion but the plan's status line does not read completed.",
      evidence: line ? `${line.path}:${line.line} reads "${line.text.trim()}"` : `no status line found for ${w.planPath}`,
      status: "verified",
      severity: "high",
    });
  }
}

let statusAtEnd: GitStatus | null = null;
try {
  statusAtEnd = await git.status();
} catch {
  log("git status unavailable at verification — the staged-empty check cannot run");
}
if (statusAtEnd !== null && statusAtEnd.staged.length > 0) {
  addFinding({
    where: ".",
    what: "Something is staged — the run must leave nothing staged; only the owner commits.",
    evidence: `git.status() staged: ${JSON.stringify(statusAtEnd.staged)}`,
    status: "verified",
    severity: "high",
  });
}
let endHead = "";
try {
  const endLog = await git.log(1);
  endHead = endLog[0] ? endLog[0].hash : "";
} catch {
  log("git log unavailable at verification — the HEAD-unchanged check could not run");
}
if (startHead !== "" && endHead !== "" && startHead !== endHead) {
  addFinding({
    where: ".",
    what: "HEAD moved during the run — a commit was made, which this run must never do; only the owner commits.",
    evidence: `git.log(1) hash changed from ${startHead.slice(0, 7)} to ${endHead.slice(0, 7)} between run start and verification`,
    status: "verified",
    severity: "high",
  });
}
let touchedByRunCount = -1;
try {
  touchedByRunCount = (await git.changedFiles()).length;
  log(`Files the run leaves for the owner to review: ${touchedByRunCount}`);
} catch {
  log("git changedFiles unavailable at verification — the handoff file count could not be enumerated");
}

const missingAnchors = fillLog.split("\n").filter((l) => l.startsWith("MISSING-ANCHORS:"));
if (missingAnchors.length > 0) {
  addFinding({
    where: recapPath,
    what: "Some template anchors never matched, so part of the template was not filled.",
    evidence: missingAnchors.join(" ").slice(0, 400),
    status: "verified",
    severity: "medium",
  });
}
for (const w of walks) {
  for (const a of w.assessments) {
    if (a.ownerVerdict === "unanswered") {
      addFinding({
        where: w.planPath,
        what: `Criterion left unanswered by the owner and recorded as "${a.final}" without their confirmation.`,
        evidence: a.justification,
        status: "unconfirmed",
        severity: "low",
      });
    }
  }
}
for (const p of proposals) {
  if (p.noUpdateNeeded && p.noUpdateReason.includes("doc does not exist")) {
    addFinding({
      where: p.docPath,
      what: `Contract doc proposed for the "${p.area}" area does not exist in this repository.`,
      evidence: p.noUpdateReason,
      status: "verified",
      severity: "low",
    });
  }
}
if (recapCutoff === "") {
  addFinding({
    where: "docs/recaps/",
    what: "No prior recap existed, so the change window is the last 20 commits plus the working tree.",
    evidence: `files.glob("${RECAPS_GLOB}") returned no files`,
    status: "verified",
    severity: "low",
  });
}

const appliedDocs = applyResults.map((r) => r.docPath);
const deferredDocs = deferredDecisions().map((d) => d.docPath);
const handoff = [
  recapWritten ? `Recap drafted at ${recapPath}.` : "",
  appliedDocs.length > 0 ? `Updated: ${appliedDocs.join(", ")}. Review the diff before committing.` : "",
  deferredDocs.length > 0 ? `Deferred updates to: ${deferredDocs.join(", ")} — noted in the recap for next session.` : "",
  ...walks.filter((w) => w.statusEditApproved).map((w) => `Marked ${w.planPath} as completed.`),
  "Don't commit yet — review the recap and any doc updates first.",
].filter((s) => s !== "");

// The compact fallback carries every skill step-8 section, composed from the same builders
// as the file — a full recap, not a stub, whenever the file path is unavailable.
const fallbackMarkdown = [
  `# Session recap — ${recapDate}`,
  "",
  narrative.summary,
  "",
  "## Plans worked on",
  plansBody(),
  "",
  "## Commits",
  commitsSection(),
  "",
  "## What was added",
  narrative.added,
  "",
  "## What was fixed",
  narrative.fixed,
  "",
  "## What was changed",
  narrative.changed,
  "",
  "## Files changed",
  filesBody(),
  "",
  "## Doc updates applied",
  docAppliedBody(),
  "",
  "## Doc updates deferred (debt)",
  docDeferredBody(),
  "",
  "## CLAUDE.local.md changes",
  claudeLocalBody(),
  "",
  "## Open questions / next steps",
  openQuestionsBody(),
  "",
  "## Notes",
  notesBody(),
  "",
  "## Handoff",
  bullets(handoff),
].join("\n");

// Publish the deliverable: the recap file itself, with the full-content markdown fallback
// when the file is absent (failed fill, owner-declined directory) or the publish rejects.
// Exactly two `primary: true` literals exist, one per publish API, and control flow
// guarantees at most one of them executes per run (§16.3: at most one artifact carries
// primary). Both publishes sit inside one try/catch + fallback, so a rejected file publish
// can never leave the run without its deliverable.
let publishedFromFile = false;
if (recapWritten) {
  try {
    await artifact.file("session-recap", recapPath, {
      title: `Session recap — ${recapDate}`,
      description: handoff[0],
      primary: true,
    });
    publishedFromFile = true;
  } catch {
    addFinding({
      where: recapPath,
      what: "The recap file exists but could not be published from disk; the full recap ships as the markdown fallback instead.",
      evidence: 'artifact.file("session-recap", ...) rejected; artifact.markdown fallback used',
      status: "verified",
      severity: "medium",
    });
  }
}
if (!publishedFromFile) {
  try {
    await artifact.markdown("session-recap-fallback", fallbackMarkdown, {
      title: `Session recap — ${recapDate}`,
      description: "Full fallback: no recap file could be published this run; the complete recap content follows.",
    });
  } catch {
    addFinding({
      where: recapPath,
      what: "The markdown fallback publish rejected too, so the run ends without a published deliverable.",
      evidence: "artifact.markdown(\"session-recap-fallback\", ...) rejected after the file publish also failed or was skipped; the first 4000 characters of the recap are logged for salvage",
      status: "verified",
      severity: "high",
    });
    log("Recap content for salvage (truncated):");
    log(fallbackMarkdown.slice(0, 4000));
  }
}

const conclusion =
  (recapWritten
    ? `Session recap drafted at ${recapPath}. `
    : !mayWriteRecap && ownerDecisions.recapsDirConsent === "skip"
      ? "The owner declined the recap file, so the full recap ships as the published markdown artifact. "
      : !mayWriteRecap
        ? "The owner never answered the docs/recaps/ consent question, so no directory was created and no file was written; the full recap ships as the published markdown artifact. "
        : "The recap file could not be confirmed on disk; the full recap ships as the published markdown artifact. ") +
  (handoff.length > 0 ? handoff.filter((s) => s !== `Recap drafted at ${recapPath}.`).join(" ") : "");

const result: WorkflowReport = {
  conclusion,
  findings,
  verified: [
    `pre-flight existence checks ran as world.run test calls (docs/recaps/, CLAUDE.md, template, registry script), plus the template re-check after the owner's answer`,
    `change detection ran through git.changedFiles/git.log/files.grep: ${changedPaths.length} changed files, ${sessionCommits.length} commits in window`,
    `template fill ran as world.run("node", ["-e", ...]) against ${templatePath}, with stderr captured and gated: ${fillLog.split("\n")[0]}`,
    `verification ran per SKILL.md:198-209: head of recap, files.grep("^status:") over docs/plans${
      statusAtEnd !== null ? ", git.status staged-empty check" : " (git.status was unavailable — the staged-empty check could not run)"
    }${startHead !== "" && endHead !== "" ? ", and a HEAD-unchanged check" : " (the HEAD-unchanged check was skipped — no commits were readable at both ends)"} (${statusResults.filter((r) => r.changed).length} plan status edit(s) applied as confirmed)`,
    `owner gates were reached by escalation: recap shape and docs/recaps consent${ownerDecisions.shape === "feature" ? ", acceptance-criteria walks" : ""}${actionable.length > 0 ? ", doc apply/defer/modify" : ""}${sweep.registryAvailable ? ", sweep --kill approval" : " (sweep skipped with the owner's answer)"}`,
  ],
  notCovered: [
    ...(ownerDecisions.shape === "maintenance" ? ["acceptance-criteria walk and contract-doc proposals were skipped — the owner chose a maintenance recap"] : []),
    ...(activePlanPaths.length === 0 ? ["no active plan exists, so no plan evidence was gathered"] : []),
    ...(sweep.killRan
      ? []
      : [
          !sweep.registryAvailable
            ? "sweep --kill did not run — the registry script is unavailable"
            : !sweep.killApproved
              ? "sweep --kill did not run — the owner declined"
              : "sweep --kill was approved but exited nonzero — see the sweep finding; the recap notes quote its stderr",
        ]),
    ...(sessionCommits.length > 0
      ? ["the commits table comes from the git facade, which cannot express --no-merges (SKILL.md:57-59), so merge commits may appear in the table"]
      : []),
    ...(recapCutoff !== "" && sessionCommits.length > 0
      ? ["the committed change set is diffed against the window's oldest commit (the git facade takes one ref, not a range), so that commit's own files may be absent from the change evidence"]
      : []),
    ...(!gitStatusAvailable
      ? ["git.status was unavailable at run start — the recap says so instead of asserting working-tree state, and the staged-empty assertion could not run"]
      : []),
    ...(statusAtEnd === null
      ? ["git.status was unavailable at verification — the staged-empty check (nothing committed on the run's watch) did not run"]
      : []),
    ...(touchedByRunCount < 0
      ? ["git.changedFiles was unavailable at verification — the handoff could not enumerate the files left for the owner"]
      : []),
    ...evidencePack.omissions,
    "nothing was committed or pushed; the run leaves every change uncommitted for the owner",
  ],
};
return result;
