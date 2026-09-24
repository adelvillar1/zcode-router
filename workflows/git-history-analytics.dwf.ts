/* zcode-workflow
description: "Turns a repository's history into measured analytics: pulls every
  commit through the skill's own script as a deterministic gate, runs the
  analytics dimensions in parallel with independent audit rounds against
  measured command output, and publishes the analytics report. Embodies the
  git-history-analytics skill."
whenToUse: When a repository's history needs measured analytics — activity,
  churn, fix rates — grounded in the commit record.
args:
  branch:
    type: string
    description: Branch to analyze; empty uses the current branch.
    required: false
  repo:
    type: string
    description: Repository slug or path to analyze.
    required: false
  skillDir:
    type: string
    description: Path to the git-history-analytics skill dir holding scripts/.
    required: false
  timezone:
    type: string
    description: Timezone for date handling.
    required: false
*/
// Dynamic-workflow draft — embodies ~/.agents/skills/git-history-analytics/SKILL.md (103 lines).
// Hybrid pattern: phases, fan-out, bounded loops and deterministic gates live here; the fine
// detail (dimension recipes, the maturity table, the anchored bucket patterns, the pitfalls)
// is left to the subagent asks, which point at the skill's SKILL.md and references/recipes.md.
//
// Skill coverage:
// - CRITICAL depth check (SKILL.md:30-55, pitfall 1 at :81) → the first phase. The skill's own
//   scripts/history_report.sh runs as a world.run gate — 'bash' stays a compile-time literal
//   while the script's absolute path and the ownerRepo/branch arguments go in the args array,
//   because world.run's cwd is the workspace and the skill lives outside it. The local half of
//   the cross-check only reads the workspace clone when its origin names the analysed
//   repository; otherwise the run records the cross-check as unavailable rather than comparing
//   a different repository's counts against GitHub.
// - Standard dimensions (SKILL.md:57-59, recipes §2) → six analysts in the fan-out, started
//   alongside the curve and attribution analysts and joined once.
// - Maturity curve (SKILL.md:60, :65-77, recipes §3) → its own analyst; the ratio boundaries
//   are re-checked script-side from constants.
// - Fix attribution (SKILL.md:61-62, pitfalls 2-3 at :82-88, recipes §4-§5) → its own analyst;
//   the spot-check floor and misattribution tolerance are script constants.
// - Narration (SKILL.md:63) → a writer that leads with the arc and names the phases.
// - Pitfalls 4-6 (timezone :89-90, merge commits :91-93, agent authors :94-96) are carried by
//   the asks that need them, by reference to the skill.
// The deliverable is the narrated report; it is published only after the run owner approves it
// by escalation, and every publish has a compact fallback.

interface LocalCount {
  /** `git rev-list --count --all` in the workspace clone; -1 when unavailable. */
  localAll: number;
  /** Count on the like-for-like ref (origin/<branch>, else <branch>); -1 when neither resolves. */
  likeForLike: number;
  /** Which ref the like-for-like count came from; "" when none resolved. */
  localRef: string;
}

interface GateOutcome extends LocalCount {
  failed: boolean;
  /** What went wrong, for the owner relay and the failure report. */
  cause: string;
  /** True commit count from the pagination header; -1 when it printed its fallback. */
  trueCount: number;
  /** Log lines the paginated fetch wrote; -1 when unparseable. */
  fetchedCount: number;
  /** Where the script saved the raw log; "" when unparseable. */
  tmpLog: string;
}

interface OwnerRelayReply {
  /** "retry" only when the owner supplied a corrected target; otherwise "abort". */
  action: "retry" | "abort";
  /** The owner's corrected repository slug (owner/name); empty unless retrying. */
  repo: string;
  /** The owner's corrected branch; empty unless retrying. */
  branch: string;
  /** What the owner said, or how the attempt to reach them ended. */
  note: string;
}

interface DimensionSpec {
  /** Stable id, also the analyst subagent's name suffix. */
  id: string;
  /** Human dimension name, shown on cards and rows. */
  label: string;
  /** What this analyst measures, in one or two sentences. */
  focus: string;
}

interface DimensionResult {
  /** The dimension name, copied from the ask. */
  dimension: string;
  /** The one finding a reader should take away, with its headline number. */
  headline: string;
  /** The derived numbers, as short human-readable lines. */
  rows: string[];
  /** The caveats the skill attaches to this dimension, as short lines. */
  caveats: string[];
  /** The exact commands run, for the evidence trail. */
  commands: string[];
}

interface DimensionAttempt {
  ok: boolean;
  value: DimensionResult;
}

interface MonthPoint {
  /** "2026-03". */
  month: string;
  /** Fix commits that month. */
  fix: number;
  /** Feat commits that month. */
  feat: number;
  /** fix/feat to two decimals; null when the month had no feat commits. */
  ratio: number | null;
  /** The skill's table phase: building, stabilizing, hardening, crunch, renaissance — or silent. */
  phase: string;
}

interface MaturityCurve {
  months: MonthPoint[];
  /** The arc read per the skill: phases named, a dominant fix month named as the wall. */
  interpretation: string;
  /** The exact commands run, for the evidence trail. */
  commands: string[];
}

interface CurveAttempt {
  ok: boolean;
  value: MaturityCurve;
}

interface SpotCheckOutcome {
  /** How many matched subjects the analyst read and judged. */
  sampleCount: number;
  /** How many of those were not the category their bucket claims. */
  misattributed: number;
  /** What the misattributed ones actually were, briefly. */
  notes: string;
}

interface AttributionBucket {
  /** Bucket name, e.g. "data pipeline". */
  name: string;
  /** Fix commits matching the bucket's anchored pattern. */
  count: number;
  /** count / totalFixes as a percentage. */
  shareOfFixesPct: number;
}

interface FixAttribution {
  /** Total fix commits extracted before bucketing. */
  totalFixes: number;
  /** One entry per strict bucket, largest first. */
  buckets: AttributionBucket[];
  /** The skill's spot check: samples read and misattributions found. */
  spotCheck: SpotCheckOutcome;
  /** What the per-file churn cross-check (recipes §5) showed, or why it could not run. */
  churnCrossCheck: string;
  /** The method and its caveat, per the skill: a signal, not an audit. */
  methodCaveat: string;
  /** The exact commands run, for the evidence trail. */
  commands: string[];
}

interface AttributionAttempt {
  ok: boolean;
  value: FixAttribution;
}

interface DepthSummary {
  trueCount: number;
  fetchedCount: number;
  likeForLike: number;
  localRef: string;
  localAll: number;
  timezone: string;
  materiallyShallow: boolean;
  /** The workspace's origin remote, "" when none resolves. */
  remoteUrl: string;
  /** Whether that origin names the analysed repository — local counts are a depth signal only when it does. */
  cloneIsTarget: boolean;
}

interface NarrationDraft {
  /** Workspace-relative path the narration was written to. */
  path: string;
  /** The one-sentence headline of the story. */
  headline: string;
  /** The opening paragraph: the arc first, per the skill's final step. */
  arc: string;
  /** The named phases in order, e.g. "build (Feb-Apr), stabilize (May), hardening wall (Jun)". */
  phases: string[];
}

interface ReaderNotes {
  /** Where the text is unclear or unsupported, judged from the text alone. */
  issues: { where: string; what: string }[];
  /** What the reader expects the owner to ask next. */
  likelyQuestions: string[];
}

interface RevisionNotes {
  /** What changed in the document this round. */
  changed: string;
}

interface PublicationDecision {
  /** True only for an explicit owner yes. */
  approved: boolean;
  /** What the owner said, or how the attempt to reach them ended. */
  ownerReply: string;
  /** Changes the owner asked for, verbatim; empty on a plain yes or no. */
  requestedChanges: string;
}

interface AnalyticsFinding {
  /** Where the finding lives: a month, a dimension, a path. */
  where: string;
  /** One sentence: what was found. */
  what: string;
  /** What showed it: the command and its output, or the check that decided it. */
  evidence: string;
  /** "verified" when a deterministic check or an independent party confirmed it. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for a wrong result the owner would act on. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: AnalyticsFinding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ---------------------------------------------------------------------------
// Constants. Every tunable number lives here and stays out of ask text: the
// asks point at the skill, which carries the same numbers in its own prose.
// ---------------------------------------------------------------------------
const DEFAULT_SKILL_DIR = "/Users/alejandrodelvillar/.agents/skills/git-history-analytics";
const SKILL_DIR = String(args.skillDir ?? DEFAULT_SKILL_DIR).trim().replace(/\/+$/, "") || DEFAULT_SKILL_DIR;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
const RECIPES_FILE = `${SKILL_DIR}/references/recipes.md`;
const HISTORY_SCRIPT = `${SKILL_DIR}/scripts/history_report.sh`;

// The history pull is paginated gh api over the whole repository — slow by design, and never
// timed against a very large repository; a timeout rejects into the failed-gate relay, where
// the owner can retry, but the generous ceiling keeps that from being the normal path.
const GATE_TIMEOUT_MS = 3_600_000;
// Owner-relay retries when the depth gate fails; approval re-asks after requested changes;
// cold-read fix rounds before the narration goes to the owner as it stands.
const RELAY_ATTEMPTS = 2;
const APPROVAL_REASKS = 2;
const NARRATION_ROUNDS = 1;
// Cold-read issues become report() findings, and report() caps items per run — never let one
// reader's list consume the run's report budget.
const COLD_ISSUE_REPORT_CAP = 20;
// report() caps items per run (256). This run's worst-case feed is 8 measurement-table rows +
// the chart points + at most ~40 findings (one per check site, 6 dimension failures, and the
// cold-read issues up to their own cap) — so the curve dashboard thins its feed well inside the
// ceiling rather than letting a month-by-month fan-out on a long-lived repository approach it.
const CHART_POINT_CAP = 120;
// The depth comparison: below this share of GitHub's count, the local clone is materially
// shallow (the skill's worked example is 50 local vs 2583 remote).
const MATERIALLY_SHALLOW_RATIO = 0.95;
// The skill's maturity table: below parity is building, above this is hardening/crunch.
const RATIO_PARITY = 1.0;
const RATIO_CRUNCH = 2.0;
// A month holding at least this share of the lifetime fix count is "the wall" (skill: ~half).
const WALL_FIX_SHARE = 0.5;
// The skill's spot-check floor for fix buckets, and the share of misattributed samples above
// which a bucket count is not trustworthy.
const SPOT_CHECK_MIN = 20;
const MISATTRIBUTION_RATE = 0.2;

const ANALYST_SYSTEM =
  "You measure one dimension of a git log with real commands, and you quote the command and " +
  "its output with every number you return. You never estimate, round, or state a figure you " +
  "did not compute. If a measurement is impossible, or your instructions contradict each " +
  "other, escalate and say so plainly rather than working around it.";

let repo = String(args.repo ?? "").trim();
let branch = String(args.branch ?? "main").trim() || "main";
const tzArg = String(args.timezone ?? "").trim();
let tzLabel = tzArg;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "default";

// The run's own state, reported as it lands so a failed run keeps its work.
const findings: AnalyticsFinding[] = [];
const pushFinding = (f: AnalyticsFinding): void => {
  findings.push(f);
  report(f);
};

const guard = async <A extends { ok: boolean }>(task: PromiseLike<A>, fallback: A, label: string): Promise<A> => {
  try {
    return await task;
  } catch (error) {
    log(`${label} failed: ${String(error)}${String(error).includes("ContextLimit") ? " — ASK TOO LARGE (ContextLimit): split the work or send less per §16.3" : ""}`);
    return fallback;
  }
};

const failedDimension = (d: DimensionSpec): DimensionResult => ({
  dimension: d.label,
  headline: "this dimension could not be measured — its analyst failed",
  rows: [],
  caveats: ["the measurement is missing from every downstream summary"],
  commands: [],
});

const EMPTY_CURVE: MaturityCurve = { months: [], interpretation: "", commands: [] };
const FAILED_ATTRIBUTION: FixAttribution = {
  totalFixes: 0,
  buckets: [],
  spotCheck: { sampleCount: 0, misattributed: 0, notes: "the analyst failed; nothing was spot-checked" },
  churnCrossCheck: "unavailable — the analyst failed",
  methodCaveat: "",
  commands: [],
};

const countLocal = async (ref: string): Promise<LocalCount> => {
  const allRun = await world.run("git", ["rev-list", "--count", "--all"]);
  const parsedAll = Number(allRun.stdout.trim());
  const localAll = allRun.exitCode === 0 && Number.isFinite(parsedAll) ? parsedAll : -1;
  const preferred = await world.run("git", ["rev-list", "--count", `origin/${ref}`]);
  let likeForLike = -1;
  let localRef = `origin/${ref}`;
  if (preferred.exitCode === 0) {
    const parsed = Number(preferred.stdout.trim());
    if (Number.isFinite(parsed)) likeForLike = parsed;
  } else {
    const alt = await world.run("git", ["rev-list", "--count", ref]);
    const parsedAlt = Number(alt.stdout.trim());
    if (alt.exitCode === 0 && Number.isFinite(parsedAlt)) {
      likeForLike = parsedAlt;
      localRef = ref;
    }
  }
  return { localAll, likeForLike, localRef };
};

// The skill's own re-runnable script: pulls the FULL history from GitHub with pagination and
// prints the standard dimension tables. 'bash' must stay a literal (the command set is part of
// what the user approves); the script's absolute path and the target go in the args array,
// because world.run's cwd is the workspace and the skill lives outside it.
const runDepthGate = async (repoSlug: string, ref: string): Promise<GateOutcome> =>
  await world
    .run("bash", [HISTORY_SCRIPT, repoSlug, ref], { timeoutMs: GATE_TIMEOUT_MS })
    .then(
      (result): GateOutcome => {
        if (result.exitCode !== 0) {
          return {
            failed: true,
            cause:
              `the skill's history script exited ${result.exitCode} for ${repoSlug}@${ref}: ` +
              `${`${result.stderr}\n${result.stdout}`.slice(-400).trim()}`,
            trueCount: -1,
            fetchedCount: -1,
            tmpLog: "",
            localAll: -1,
            likeForLike: -1,
            localRef: "",
          };
        }
        const totalMatch = result.stdout.match(/total commits: (\d+)/);
        // BSD wc pads its count with leading spaces inside the script's $( ), so the digits
        // do not sit directly after the colon (reproduced on the default macOS host).
        const fetchedMatch = result.stdout.match(/fetched:\s+(\d+)/);
        const pathMatch = result.stdout.match(/Full log saved at: (\S+)/);
        const tmpLog = pathMatch ? pathMatch[1] : "";
        if (tmpLog === "") {
          return {
            failed: true,
            cause:
              `the skill's history script ran but did not report where it saved the log; ` +
              `output tail: ${result.stdout.slice(-400).trim()}`,
            trueCount: -1,
            fetchedCount: -1,
            tmpLog: "",
            localAll: -1,
            likeForLike: -1,
            localRef: "",
          };
        }
        return {
          failed: false,
          cause: "",
          trueCount: totalMatch ? Number(totalMatch[1]) : -1,
          fetchedCount: fetchedMatch ? Number(fetchedMatch[1]) : -1,
          tmpLog,
          localAll: -1,
          likeForLike: -1,
          localRef: "",
        };
      },
      (error: unknown): GateOutcome => ({
        failed: true,
        cause:
          `the skill's history script could not be executed for ${repoSlug}@${ref} ` +
          `(timeout, spawn failure or oversized output): ${String(error)}`,
        trueCount: -1,
        fetchedCount: -1,
        tmpLog: "",
        localAll: -1,
        likeForLike: -1,
        localRef: "",
      }),
    );

// The six standard dimensions of the skill's step 3 (recipes §2).
const DIMENSIONS: DimensionSpec[] = [
  {
    id: "by-month",
    label: "commits by month",
    focus:
      "Monthly volume across the whole range, the overall date range, and the busiest individual days.",
  },
  {
    id: "hours-local-tz",
    label: "commits by hour in the owner's timezone",
    focus:
      "The hour-of-day distribution, described only after conversion to the owner's timezone — " +
      "the skill's timezone pitfall warns the raw feed is UTC and will mislabel the day.",
  },
  {
    id: "day-of-week",
    label: "commits by day of week",
    focus: "The weekday distribution — which days of the week the work lands on, per the recipe's encoding.",
  },
  {
    id: "commit-type-mix",
    label: "commit-type distribution",
    focus: "The conventional-commit prefix distribution (feat, fix, chore, docs and the rest), largest first.",
  },
  {
    id: "deploy-cadence",
    label: "deploy cadence",
    focus:
      "Staging merges versus production merges, counted separately as the skill's merge-commit " +
      "pitfall requires, with the staging-gate ratio and its reading from the recipe.",
  },
  {
    id: "authorship-split",
    label: "authorship split",
    focus:
      "The human-versus-agent author split, carrying the skill's agent-author caveat that the " +
      "explicit count is a floor rather than the true figure, and noting the recency cluster.",
  },
];

// A bad slug must stop here rather than default silently to somebody's repository.
if (!repo.includes("/")) {
  const badArg: WorkflowReport = {
    conclusion: `Pass the repository as owner/name (args.repo); got ${repo === "" ? "an empty value" : `"${repo}"`}. Nothing was analysed.`,
    findings: [],
    verified: [],
    notCovered: ["everything — no history was pulled without a repository slug"],
  };
  return badArg;
}

// Dashboards for the person watching: one row per measurement as it lands, and the curve.
artifact.table("measurements", {
  title: `Git history measurements — ${repo}@${branch}`,
  columns: [
    { field: "dimension", label: "Dimension" },
    { field: "headline", label: "Headline" },
    { field: "caveat", label: "Caveat" },
  ],
  key: "dimension",
});
artifact.chart("fixfeat-curve", {
  title: `fix:feat ratio by month — ${repo}@${branch}`,
  x: { field: "month", label: "Month" },
  y: { field: "ratio", label: "fix:feat" },
  baseline: { field: "one", label: "parity" },
});

phase("Verify the clone holds the full history before analyzing");
log(
  `cross-checking the local clone against GitHub for ${repo}@${branch} — the skill's #1 pitfall ` +
    `is analysing a shallow or squashed local clone`,
);

// The skill's script must exist before anything is blamed on GitHub credentials.
const scriptProbe = await world.run("test", ["-f", HISTORY_SCRIPT]);
if (scriptProbe.exitCode !== 0) {
  log(`the skill's history script is missing: ${HISTORY_SCRIPT}`);
  const noScript: WorkflowReport = {
    conclusion: `${HISTORY_SCRIPT} is not on this machine, so the full history could not be pulled. Pass args.skillDir as the directory holding the git-history-analytics skill (the directory whose scripts/history_report.sh pulls the history).`,
    findings: [],
    verified: [`test -f ${HISTORY_SCRIPT} → exit ${scriptProbe.exitCode}`],
    notCovered: [`everything — no history could be pulled for ${repo}@${branch}`],
  };
  return noScript;
}

let gate = await runDepthGate(repo, branch);
const firstLocal = await countLocal(branch);
gate = { ...gate, localAll: firstLocal.localAll, likeForLike: firstLocal.likeForLike, localRef: firstLocal.localRef };

// The gate is deterministic, but its failure usually has a human fix (wrong slug, unauthenticated
// host, renamed branch). Relay it to the run owner rather than failing silently or — worse —
// falling back to the unverified local clone, which is exactly the pitfall this phase exists for.
const relay = agent("owner-relay", {
  system:
    "You relay a broken check to the run owner and bring back exactly their decision. " +
    "Escalate (using your escalate tool) with the cause, and wait for their answer. " +
    "Only the owner's explicit instruction to retry, with a corrected target, is action 'retry'; " +
    "a decline, an unreachable owner, or no answer is action 'abort'. " +
    "Say plainly in note when no human answer was obtained. " +
    "If your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
for (let attempt = 1; attempt <= RELAY_ATTEMPTS && gate.failed; attempt++) {
  log(`the depth check failed (attempt ${attempt}): ${gate.cause}`);
  const reply = await relay.ask<OwnerRelayReply>(
    `The check that pulls the full commit history failed, and this run cannot analyse anything until it succeeds.\n` +
      `What ran: the git-history-analytics skill's scripts/history_report.sh for ${repo}@${branch}.\n` +
      `Cause: ${gate.cause}\n` +
      `Escalate to the run owner with the cause and ask whether to retry with a corrected owner/repo and branch, or to abort. ` +
      `Return action 'retry' only with the owner's corrected slug in repo and branch; return 'abort' for a decline, an unreachable owner, or no answer.`,
  );
  if (reply.action !== "retry" || reply.repo.trim() === "" || reply.branch.trim() === "") {
    const aborted: WorkflowReport = {
      conclusion: `The depth check failed and the run owner did not supply a working target, so nothing was analysed. Last cause: ${gate.cause}`,
      findings: [
        {
          where: "history pull",
          what: `the full history could not be pulled for ${repo}@${branch}`,
          evidence: gate.cause,
          status: "verified",
          severity: "high",
        },
      ],
      verified: [`bash <skill>/scripts/history_report.sh ${repo} ${branch} → failed; the run owner was asked and did not supply a working target`],
      notCovered: [`everything downstream for ${repo}@${branch} — the skill forbids analysing an unverified local clone`],
    };
    return aborted;
  }
  repo = reply.repo.trim();
  branch = reply.branch.trim();
  gate = await runDepthGate(repo, branch);
  const recount = await countLocal(branch);
  gate = { ...gate, localAll: recount.localAll, likeForLike: recount.likeForLike, localRef: recount.localRef };
}
if (gate.failed) {
  const stillBroken: WorkflowReport = {
    conclusion: `The depth check failed after ${RELAY_ATTEMPTS} owner-relay attempt(s), so nothing was analysed. Last cause: ${gate.cause}`,
    findings: [
      {
        where: "history pull",
        what: `the full history could not be pulled for ${repo}@${branch}`,
        evidence: gate.cause,
        status: "verified",
        severity: "high",
      },
    ],
    verified: [`bash <skill>/scripts/history_report.sh ${repo} ${branch} → failed on every relay attempt`],
    notCovered: [`everything downstream for ${repo}@${branch} — the skill forbids analysing an unverified local clone`],
  };
  return stillBroken;
}

// Paths derive from the (possibly owner-corrected) branch, then the raw log moves into the
// workspace where the analysts' file tools can read it.
const branchSlug = slugify(branch);
const LOG_PATH = `out/git-analytics/commits-${branchSlug}.txt`;
const DOC_PATH = `out/git-analytics/history-narrative-${branchSlug}.md`;

// The hour dimension needs the owner's timezone; without an explicit arg, read the machine's.
const tzRun = await world.run("date", ["+%z %Z"]);
if (tzLabel === "") {
  tzLabel = tzRun.exitCode === 0 && tzRun.stdout.trim() !== "" ? tzRun.stdout.trim() : "UTC (machine timezone unavailable)";
}

const copyDir = await world.run("mkdir", ["-p", "out/git-analytics"]);
const copy = await world.run("cp", [gate.tmpLog, LOG_PATH]);
if (copyDir.exitCode !== 0 || copy.exitCode !== 0) {
  const noCopy: WorkflowReport = {
    conclusion: `The history was pulled from GitHub but the raw log could not be copied into the workspace (mkdir exit ${copyDir.exitCode}, cp exit ${copy.exitCode}), so the analysis could not run.`,
    findings: [],
    verified: [`bash <skill>/scripts/history_report.sh ${repo} ${branch} → exit 0; the script's log at ${gate.tmpLog}`],
    notCovered: ["everything downstream — the fetched log was not readable from the workspace"],
  };
  return noCopy;
}

// The skill's depth cross-check compares the analysed repository's OWN local clone with
// GitHub. This run executes in whatever workspace it started in, so ask git what that
// workspace's origin is before any local count is read as a depth signal — counts from a
// different repository's clone say nothing about the analysed history. GitHub stays the
// source of truth either way; the local clone is only ever context.
const remoteUrlRun = await world.run("git", ["remote", "get-url", "origin"]);
const originUrl = remoteUrlRun.exitCode === 0 ? remoteUrlRun.stdout.trim() : "";
const cloneIsTarget = originUrl !== "" && originUrl.toLowerCase().includes(repo.toLowerCase());
if (!cloneIsTarget) {
  pushFinding({
    where: "local repository history",
    what:
      originUrl !== ""
        ? `this run executes in a workspace whose origin (${originUrl}) is not the analysed repository ${repo} — the skill's local-versus-GitHub depth cross-check has no like-for-like local view here, and the analysis rests entirely on the GitHub pull`
        : `this workspace has no origin remote, so the skill's local-versus-GitHub depth cross-check has no local view to compare — the analysis rests entirely on the GitHub pull`,
    evidence:
      originUrl !== ""
        ? `git remote get-url origin → ${originUrl}`
        : `git remote get-url origin → exit ${remoteUrlRun.exitCode}`,
    status: "verified",
    severity: "low",
  });
}

const likeForLikeShallow =
  cloneIsTarget &&
  gate.likeForLike >= 0 &&
  gate.trueCount > 0 &&
  gate.likeForLike < gate.trueCount * MATERIALLY_SHALLOW_RATIO;
const allRefsShallow =
  !likeForLikeShallow &&
  cloneIsTarget &&
  gate.likeForLike < 0 &&
  gate.localAll >= 0 &&
  gate.trueCount > 0 &&
  gate.localAll < gate.trueCount * MATERIALLY_SHALLOW_RATIO;
const localAhead =
  cloneIsTarget && gate.likeForLike >= 0 && gate.trueCount > 0 && gate.likeForLike > gate.trueCount;
const countsAgree =
  cloneIsTarget && gate.likeForLike >= 0 && gate.trueCount > 0 && gate.likeForLike === gate.trueCount;
const materiallyShallow = likeForLikeShallow || allRefsShallow;

log(
  `GitHub holds ${gate.trueCount >= 0 ? String(gate.trueCount) : "an unknown number of"} commits on ${repo}@${branch}, ` +
    `${gate.fetchedCount >= 0 ? `${String(gate.fetchedCount)} fetched` : "fetch count unparsed"}; ` +
    (cloneIsTarget
      ? `local clone: ${gate.likeForLike >= 0 ? `${String(gate.likeForLike)} on ${gate.localRef}` : gate.localAll >= 0 ? `${String(gate.localAll)} across all refs` : "unavailable"}`
      : originUrl !== ""
        ? `this workspace's origin (${originUrl}) is not ${repo} — no comparable local clone`
        : `this workspace has no origin remote — no comparable local clone`),
);
if (likeForLikeShallow) {
  pushFinding({
    where: "local repository history",
    what: `the local clone's ${gate.localRef} holds ${gate.likeForLike} commits but GitHub's ${branch} holds ${gate.trueCount} — the local view would have produced a wrong analysis, so the run runs on the GitHub log`,
    evidence: `git rev-list --count ${gate.localRef} → ${gate.likeForLike}; the pagination header the skill's script read for ${repo}@${branch} → ${gate.trueCount}`,
    status: "verified",
    severity: "high",
  });
} else if (allRefsShallow) {
  pushFinding({
    where: "local repository history",
    what: `the local clone holds ${gate.localAll} commits across all refs but GitHub's ${branch} alone holds ${gate.trueCount} — no like-for-like ref resolved, so the comparison is all-refs-against-one-branch; the run runs on the GitHub log`,
    evidence: `git rev-list --count --all → ${gate.localAll}; the pagination header for ${repo}@${branch} → ${gate.trueCount}`,
    status: "verified",
    severity: "medium",
  });
}
if (localAhead) {
  pushFinding({
    where: "local repository history",
    what: `the local clone's ${gate.localRef} holds ${gate.likeForLike} commits but GitHub's ${branch} shows ${gate.trueCount} — the checkout tracks something other than the analysed branch`,
    evidence: `git rev-list --count ${gate.localRef} → ${gate.likeForLike}; the pagination header → ${gate.trueCount}`,
    status: "verified",
    severity: "medium",
  });
}
if (gate.trueCount < 0) {
  pushFinding({
    where: "history pull",
    what:
      gate.fetchedCount >= 0
        ? `the pagination header printed its fallback, so the true commit count is unknown; the only surviving total is the fetched log's ${String(gate.fetchedCount)} line count`
        : `the pagination header printed its fallback and the fetched line count could not be parsed either, so no total stands at all — only the raw log at ${LOG_PATH}, and every count derived from it is a raw recount rather than a checked total`,
    evidence: `the skill's script prints 'total commits: ?' when the Link header carries no last page; its fetched line parsed to ${gate.fetchedCount >= 0 ? String(gate.fetchedCount) : "nothing"}`,
    status: "verified",
    severity: "medium",
  });
}

const depthSummary: DepthSummary = {
  trueCount: gate.trueCount,
  fetchedCount: gate.fetchedCount,
  likeForLike: gate.likeForLike,
  localRef: gate.localRef,
  localAll: gate.localAll,
  timezone: tzLabel,
  materiallyShallow,
  remoteUrl: originUrl,
  cloneIsTarget,
};

phase("Measure the history along every dimension");
log(`asking ${DIMENSIONS.length + 2} analysts to measure the fetched log in parallel`);

// The churn cross-check's availability is a fact about this clone, computed here so the ask
// carries the situation, not a rule.
const churnNote =
  cloneIsTarget && gate.likeForLike >= 0 && gate.trueCount > 0 && gate.likeForLike >= gate.trueCount
    ? "the local clone is the analysed repository and matches GitHub's count, so the recipes' per-file churn commands can run locally"
    : "the local clone is not a verified full copy of the analysed repository, so run the per-file churn commands only if git itself shows you enough history of this repository, and say plainly in churnCrossCheck if you had to skip them";

// Start every measurement before awaiting any of them — all eight asks are independent, so
// they go in flight together and join once, instead of three sequential barriers where the
// curve and attribution analysts would idle behind the dimension fan-out.
const dimensionTasks = DIMENSIONS.map((d) =>
  guard(
    agent(`analyst-${d.id}`, { system: ANALYST_SYSTEM })
      .ask<DimensionResult>(
        `Measure one dimension of the ${repo}@${branch} commit history from the raw log at ${LOG_PATH} (pipe-delimited DATE|AUTHOR|SUBJECT, one commit per line).\n` +
          `Dimension: ${d.label}. What to produce: ${d.focus}\n` +
          `Read ${SKILL_FILE} — the workflow's step 3 and the whole Pitfalls section — and ${RECIPES_FILE} §2 first, then run the recipes' commands against the log, adapting them where this log's shape demands.\n` +
          (d.id === "hours-local-tz"
            ? `This machine reads ${tzLabel} — convert the log's UTC hours to it before describing any rhythm.\n`
            : "") +
          `Recompute every figure you return with your own commands and quote the command with each. Put the derived numbers into "rows" as short human-readable lines, the caveats the skill attaches to this dimension into "caveats", and the exact commands you ran into "commands".`,
      )
      .then((value): DimensionAttempt => ({ ok: true, value })),
    { ok: false, value: failedDimension(d) },
    `the ${d.label} analyst`,
  ),
);
const curveTask = guard(
  agent("maturity-curve-analyst", {
    system:
      "You read monthly commit statistics for the maturity story they tell, per the skill's phase " +
      "table, and you never state a number you did not compute with a command you ran. If the table " +
      "cannot classify what you found, say so plainly rather than forcing a label.",
  })
    .ask<MaturityCurve>(
      `Build the monthly fix:feat maturity curve for ${repo}@${branch} from the raw log at ${LOG_PATH}.\n` +
        `Read ${SKILL_FILE} — the "Interpreting the fix:feat maturity curve" table and the workflow's step 4 — and ${RECIPES_FILE} §3.\n` +
        `Compute the fix and feat counts per month yourself with the recipes' commands and classify each month with the table's phases. A month with no commits at all is phase "silent" with ratio null.\n` +
        `Write "interpretation" the way the skill demands: the arc first, the phases named, and a month that dominates the lifetime fix count called out as the wall and connected to the volume spike. Put the exact commands you ran in "commands".`,
    )
    .then((value): CurveAttempt => ({ ok: true, value })),
  { ok: false, value: EMPTY_CURVE },
  "the maturity-curve analyst",
);
const attributionTask = guard(
  agent("fix-attribution-analyst", {
    system:
      "You attribute fixes to categories with strict anchored patterns, and you distrust your own " +
      "buckets until you have spot-checked them. You never present a bucket count without its " +
      "method and its caveat. If a check is impossible to pass, or your instructions contradict " +
      "each other, escalate and say so plainly rather than working around it.",
  })
    .ask<FixAttribution>(
      `Attribute the fix commits of ${repo}@${branch} to categories, from the raw log at ${LOG_PATH}.\n` +
        `Read ${SKILL_FILE} — the workflow's step 5 and the pitfalls on keyword buckets and on commit-message analysis — and ${RECIPES_FILE} §4 and §5.\n` +
        `Extract the fix subjects, bucket them with the recipes' strict anchored patterns, and report each bucket's count and its share of all fixes.\n` +
        `Then spot-check before trusting the buckets: sample matched subjects, read them, and judge whether each belongs to the category its bucket claims; record how many samples you checked and how many were misattributed in "spotCheck", with what the wrong ones actually were in notes.\n` +
        `Cross-check against per-file churn: ${churnNote}\n` +
        `Put the method and its caveat into "methodCaveat" — the skill is explicit that commit-message analysis is a signal, not an audit — and the exact commands you ran into "commands".`,
    )
    .then((value): AttributionAttempt => ({ ok: true, value })),
  { ok: false, value: FAILED_ATTRIBUTION },
  "the fix-attribution analyst",
);

const [dimensionAttempts, curveAttempt, attributionAttempt] = await Promise.all([
  Promise.all(dimensionTasks),
  curveTask,
  attributionTask,
]);

const dimensionValues = dimensionAttempts.map((a) => a.value);
const curve = curveAttempt.value;
const attribution = attributionAttempt.value;

for (const row of [
  ...dimensionAttempts.map((a) => ({
    dimension: a.value.dimension,
    headline: a.value.headline,
    caveat: a.value.caveats.length > 0 ? a.value.caveats[0] : "",
    ok: a.ok,
  })),
  {
    dimension: "fix:feat maturity curve",
    headline: curve.interpretation.slice(0, 200),
    caveat: curveAttempt.ok ? "" : "the curve analyst failed",
    ok: curveAttempt.ok,
  },
  {
    dimension: "fix attribution",
    headline: `${attribution.totalFixes} fixes across ${attribution.buckets.length} bucket(s)`,
    caveat: attribution.methodCaveat.slice(0, 200),
    ok: attributionAttempt.ok,
  },
]) {
  report(row, "measurements");
}
const chartStep = Math.max(1, Math.ceil(curve.months.length / CHART_POINT_CAP));
for (let i = 0; i < curve.months.length; i += chartStep) {
  const m = curve.months[i];
  report({ month: m.month, ratio: m.ratio, one: 1 }, "fixfeat-curve");
}

for (const a of dimensionAttempts) {
  if (!a.ok) {
    pushFinding({
      where: "measurements",
      what: `the ${a.value.dimension} analyst failed — that dimension is missing from the narration inputs`,
      evidence: "the run log carries the analyst's failure",
      status: "unconfirmed",
      severity: "medium",
    });
  }
}
if (!curveAttempt.ok) {
  pushFinding({
    where: "maturity curve",
    what: "the maturity-curve analyst failed — the arc and the phases rest on nothing",
    evidence: "the run log carries the analyst's failure",
    status: "unconfirmed",
    severity: "high",
  });
}
if (!attributionAttempt.ok) {
  pushFinding({
    where: "fix attribution",
    what: "the fix-attribution analyst failed — no bucket numbers were measured",
    evidence: "the run log carries the analyst's failure",
    status: "unconfirmed",
    severity: "high",
  });
}

// Headline numbers never rest on an analyst's arithmetic alone: the lifetime fix total is the
// wall's denominator and the attribution's total, so it is recounted once, straight from the
// log, before either claim is allowed to quote it.
const totalFixRun = await world.run("awk", ["-F", "|", `$3 ~ /^fix/ {n++} END {print n+0}`, LOG_PATH]);
const recountedFixes = Number(totalFixRun.stdout.trim());
const recountedFixesOk = totalFixRun.exitCode === 0 && Number.isFinite(recountedFixes);

// The wall is a headline claim, so it is verified the deterministic way: recount the wall
// month's fix and feat commits straight from the log. The month string is sanitised before it
// may touch an awk program.
const totalFixesOnCurve = curve.months.reduce((sum, m) => sum + m.fix, 0);
const lifetimeFixTotalAgrees = recountedFixesOk && recountedFixes === totalFixesOnCurve;
let wall: MonthPoint | undefined;
for (const m of curve.months) {
  if (totalFixesOnCurve > 0 && m.fix >= totalFixesOnCurve * WALL_FIX_SHARE && (wall === undefined || m.fix > wall.fix)) {
    wall = m;
  }
}
if (wall) {
  const safeMonth = wall.month.replace(/[^0-9-]/g, "");
  if (safeMonth === wall.month) {
    const wallFixRun = await world.run("awk", ["-F", "|", `$1 ~ /^${safeMonth}/ && $3 ~ /^fix/ {n++} END {print n+0}`, LOG_PATH]);
    const wallFeatRun = await world.run("awk", ["-F", "|", `$1 ~ /^${safeMonth}/ && $3 ~ /^feat/ {n++} END {print n+0}`, LOG_PATH]);
    const wallFix = Number(wallFixRun.stdout.trim());
    const wallFeat = Number(wallFeatRun.stdout.trim());
    const recounts =
      wallFixRun.exitCode === 0 && wallFeatRun.exitCode === 0 && Number.isFinite(wallFix) && Number.isFinite(wallFeat);
    // The compound claim needs all three recounts to agree: the month's fix count, its feat
    // count, and the lifetime fix denominator behind the share.
    const agrees = recounts && lifetimeFixTotalAgrees && wallFix === wall.fix && wallFeat === wall.feat;
    pushFinding({
      where: wall.month,
      what: agrees
        ? `the wall: ${wall.month} holds ${wall.fix} of the ${String(recountedFixes)} lifetime fixes — name it in the narration and connect it to that month's volume`
        : `the curve analyst's numbers for the wall do not match a direct recount of the log (month ${wall.month}: analyst fix ${wall.fix} feat ${wall.feat}, recount fix ${recounts ? String(wallFix) : "unreadable"} feat ${recounts ? String(wallFeat) : "unreadable"}; lifetime fixes: analyst total ${String(totalFixesOnCurve)}, recount ${recountedFixesOk ? String(recountedFixes) : "unreadable"}) — treat the month counts and the share of the lifetime total as suspect`,
      evidence: `awk -F'|' recount of ${LOG_PATH} for ${safeMonth} and for the lifetime fix total; the curve analyst's commands: ${curve.commands.join("; ")}`,
      status: agrees ? "verified" : "unconfirmed",
      severity: agrees ? "medium" : "high",
    });
  } else {
    pushFinding({
      where: wall.month,
      what: `a month (${wall.month}) holds ${wall.fix} of ${totalFixesOnCurve} lifetime fixes, but the label could not be used in a recount — treat the wall as unconfirmed`,
      evidence: `derived from the curve analyst's months; its commands: ${curve.commands.join("; ")}`,
      status: "unconfirmed",
      severity: "medium",
    });
  }
}

// The attribution's total must agree with that same recount of the lifetime fix total.
if (attributionAttempt.ok && (!recountedFixesOk || recountedFixes !== attribution.totalFixes)) {
  pushFinding({
    where: "fix attribution",
    what: `the attribution analyst counted ${attribution.totalFixes} fix commits but a direct recount of the log gives ${recountedFixesOk ? String(recountedFixes) : "an unreadable count"} — treat the bucket shares as suspect`,
    evidence: `the same awk -F'|' recount of ${LOG_PATH} that checks the wall's denominator; the analyst's commands: ${attribution.commands.join("; ")}`,
    status: "verified",
    severity: "high",
  });
}

// The skill's table, re-applied in code: a phase label that contradicts its own ratio is a
// defect in the curve, and the narration must not inherit it.
const labelMismatches: string[] = [];
for (const m of curve.months) {
  if (m.ratio === null) continue;
  const expected: string[] =
    m.ratio < RATIO_PARITY ? ["building"] : m.ratio > RATIO_CRUNCH ? ["hardening", "crunch"] : ["stabilizing"];
  if (!expected.includes(m.phase) && m.phase !== "renaissance" && m.phase !== "silent") {
    labelMismatches.push(`${m.month}: ratio ${String(m.ratio)} labelled "${m.phase}", the table gives ${expected.join(" or ")}`);
  }
}
if (labelMismatches.length > 0) {
  pushFinding({
    where: "maturity curve",
    what: `${labelMismatches.length} month(s) carry a phase label that contradicts their own ratio: ${labelMismatches.join("; ")}`,
    evidence: `re-applied the skill's table to the curve analyst's own numbers (commands: ${curve.commands.join("; ")})`,
    status: "unconfirmed",
    severity: "medium",
  });
}

// The skill will not trust a bucket count without its spot check; the floor and the tolerance
// live in constants here, and the check runs on the analyst's own tally.
if (attributionAttempt.ok && attribution.spotCheck.sampleCount < SPOT_CHECK_MIN) {
  pushFinding({
    where: "fix attribution",
    what: `the buckets were spot-checked with only ${attribution.spotCheck.sampleCount} sample(s), below the skill's floor of ${SPOT_CHECK_MIN} — the bucket counts are not trustworthy and are labelled so`,
    evidence: `the analyst's own tally: ${JSON.stringify(attribution.spotCheck)}`,
    status: "verified",
    severity: "high",
  });
}
if (
  attributionAttempt.ok &&
  attribution.spotCheck.sampleCount > 0 &&
  attribution.spotCheck.misattributed / attribution.spotCheck.sampleCount > MISATTRIBUTION_RATE
) {
  pushFinding({
    where: "fix attribution",
    what: `${attribution.spotCheck.misattributed} of ${attribution.spotCheck.sampleCount} spot-checked samples were misattributed — above the tolerated share of ${MISATTRIBUTION_RATE}; the bucket counts sweep in the wrong work`,
    evidence: `the analyst's own tally: ${JSON.stringify(attribution.spotCheck)}`,
    status: "verified",
    severity: "high",
  });
}

phase("Write the narrated history");
// The skill's last step: narrate, don't tabulate. One writer, because the story is one voice
// and needs every measured input at once.
const writer = agent("history-narrator", {
  system:
    "You narrate a repository's history the way the git-history-analytics skill demands: the arc " +
    "first, phases named, every number traceable to a measured result, the caveats carried " +
    "instead of dropped. You never invent a figure. If your instructions contradict each other, " +
    "escalate and say so plainly rather than working around it.",
});
const draft = await writer.ask<NarrationDraft>(
  `Write the narrated history of ${repo}@${branch} to ${DOC_PATH} (create it with your file tools).\n` +
    `Read ${SKILL_FILE} — the final workflow step ("Narrate, don't just tabulate — lead with the arc, name the phases") and the maturity-curve table — and follow them: open with the arc as a story, then name each phase with its months, then the work rhythm, the fix landscape, the deploy cadence, and who did the work.\n` +
    `Carry the caveats the skill insists on: keyword-bucket counts are signals, not an audit; the authorship split is a floor, not the true figure; merge commits are counted separately; the hours are in the owner's timezone (${tzLabel}).\n` +
    `The measured material, all upstream:\n` +
    `Depth: ${JSON.stringify(depthSummary)}\n` +
    `Dimensions: ${JSON.stringify(dimensionValues)}\n` +
    `Maturity curve: ${JSON.stringify(curve)}\n` +
    `Fix attribution: ${JSON.stringify(attribution)}\n` +
    `Return the doc path, the one-sentence headline, the opening arc paragraph, and the phase names in order.`,
);
log(`narration drafted at ${draft.path}: ${draft.phases.join(" → ")}`);

phase("Have the narration read cold and fix what the read finds");
const firstRead = await agent("cold-reader", {
  system:
    "You read a document cold, as its reader, and judge it from the text alone. You do not verify " +
    "it against the repository. If your instructions contradict each other, escalate and say so " +
    "plainly rather than working around it.",
}).ask<ReaderNotes>(
  `You have not seen this document before. Read ${DOC_PATH} from the text alone — do not verify it against the repository.\n` +
    `What is unclear, what does the text itself fail to support, and what will the owner ask next that it does not answer? Return issues and likelyQuestions.`,
);
let issues = firstRead.issues;
let questions = firstRead.likelyQuestions;
let readRounds = 0;
for (let round = 1; round <= NARRATION_ROUNDS && issues.length > 0; round++) {
  const revision = await writer.ask<RevisionNotes>(
    `A cold reader raised these issues in ${DOC_PATH}: ${JSON.stringify(issues)}\n` +
      `The reader also expects these questions the document does not answer: ${JSON.stringify(questions)}\n` +
      `Fix the issues and answer the questions where the document can — fix what the read found, not the prose style. Return what changed.`,
  );
  log(`cold-read revision: ${revision.changed}`);
  const recheck = await agent(`cold-reader-${round + 1}`, {
    system:
      "You read a document cold, as its reader, and judge it from the text alone. You do not verify " +
      "it against the repository. If your instructions contradict each other, escalate and say so " +
      "plainly rather than working around it.",
  }).ask<ReaderNotes>(
    `You have not seen this document before. It was just revised; judge only the text in front of you. Read ${DOC_PATH} from the text alone — do not verify it against the repository.\n` +
      `What is still unclear, still unsupported, or still missing? Return issues and likelyQuestions.`,
  );
  issues = recheck.issues;
  questions = recheck.likelyQuestions;
  readRounds = round;
  log(`cold read ${round}: ${issues.length} issue(s) still open`);
}
for (const issue of issues.slice(0, COLD_ISSUE_REPORT_CAP)) {
  pushFinding({
    where: `${DOC_PATH} — ${issue.where}`,
    what: `a cold reader still raises this: ${issue.what}`,
    evidence: "a cold read of the narration, judged from the text alone",
    status: "unconfirmed",
    severity: "low",
  });
}

phase("Get the run owner's approval and publish the story");
// The narrative characterises the owner's own work; publishing it is the owner's call, reached
// by escalation — never the approver's own judgement.
const approver = agent("publication-approver", {
  system:
    "You operate this run's publication approval. The decision to publish a narrative about the " +
    "owner's own work belongs to the run owner, not to you. For every decision, escalate (using " +
    "your escalate tool) to the run owner with the headline, the arc and the named phases, and " +
    "wait for their answer. Record approved=true only for an explicit owner yes; a decline, an " +
    "unreachable owner, or no answer is approved=false, with what happened in ownerReply and " +
    "anything they want changed verbatim in requestedChanges. Say plainly when no human approval " +
    "was obtained. If your instructions contradict each other, escalate and say so plainly rather " +
    "than working around it.",
});
let decision = await approver.ask<PublicationDecision>(
  `This run wrote a narrated history of ${repo}@${branch} to ${DOC_PATH}. Before it is published as the run's deliverable, the run owner must approve it.\n` +
    `Headline: ${draft.headline}\n` +
    `Arc (opening paragraph): ${draft.arc}\n` +
    `Named phases: ${JSON.stringify(draft.phases)}\n` +
    `Escalate to the run owner with exactly those three things plus the document path, and ask whether to publish it. ` +
    `Return approved=true only for an explicit owner yes; put what the owner said in ownerReply and anything they want changed, verbatim, in requestedChanges. An unreachable or silent owner is approved=false.`,
);
let approvalRounds = 0;
for (let round = 1; round <= APPROVAL_REASKS && !decision.approved && decision.requestedChanges.trim() !== ""; round++) {
  const revision = await writer.ask<RevisionNotes>(
    `The run owner reviewed the narrated history at ${DOC_PATH} and declined publication with this feedback: ${decision.ownerReply}\n` +
      `Requested changes: ${decision.requestedChanges}\nApply exactly those changes; change nothing else. Return what changed.`,
  );
  log(`owner-requested revision: ${revision.changed}`);
  decision = await approver.ask<PublicationDecision>(
    `The narrated history at ${DOC_PATH} was revised in response to the owner's feedback: ${revision.changed}\n` +
      `Escalate to the run owner again — same headline, arc and phases, revised per their feedback — and ask whether to publish now. Same rule: only an explicit owner yes is approved=true.`,
  );
  approvalRounds = round;
}

const withheldReason = decision.approved
  ? ""
  : decision.ownerReply.trim() === ""
    ? "the approval could not reach the run owner"
    : `the run owner declined: ${decision.ownerReply}`;

// The compact fallback: the measured facts, composed here from the same values the return uses.
const measurementRows = [
  ...dimensionAttempts.map((a) => ({
    dimension: a.value.dimension,
    headline: a.value.headline,
    caveat: a.value.caveats.length > 0 ? a.value.caveats[0] : "",
    ok: a.ok,
  })),
  {
    dimension: "fix:feat maturity curve",
    headline: curve.interpretation.slice(0, 200),
    caveat: curveAttempt.ok ? "" : "the curve analyst failed",
    ok: curveAttempt.ok,
  },
  {
    dimension: "fix attribution",
    headline: `${attribution.totalFixes} fixes across ${attribution.buckets.length} bucket(s)`,
    caveat: attribution.methodCaveat.slice(0, 200),
    ok: attributionAttempt.ok,
  },
];
const compactMarkdown = (statusLine: string): string =>
  [
    `# Git history analytics — ${repo}@${branch}`,
    "",
    statusLine,
    "",
    "## Depth verification",
    `- GitHub true commit count on ${branch}: ${gate.trueCount >= 0 ? String(gate.trueCount) : "unknown (single page or unparseable header)"}`,
    `- Fetched log lines: ${gate.fetchedCount >= 0 ? String(gate.fetchedCount) : "unknown"} (raw log at ${LOG_PATH})`,
    `- Local clone: ${gate.likeForLike >= 0 ? `${String(gate.likeForLike)} on ${gate.localRef}` : gate.localAll >= 0 ? `${String(gate.localAll)} across all refs` : "count unavailable"}`,
    "",
    "## Measurements",
    ...measurementRows.map((r) =>
      `- **${r.dimension}${r.ok ? "" : " (failed)"}** — ${r.headline}${r.caveat !== "" ? ` _caveat: ${r.caveat}_` : ""}`,
    ),
    "",
    "## fix:feat by month",
    ...curve.months.map((m) => `- ${m.month}: fix=${m.fix} feat=${m.feat} ratio=${m.ratio === null ? "n/a" : String(m.ratio)} — ${m.phase}`),
    "",
    "## Fix attribution",
    `- ${attribution.methodCaveat}`,
    ...attribution.buckets.map((b) => `- ${b.name}: ${b.count} (${String(b.shareOfFixesPct)}%)`),
    `- Spot check: ${attribution.spotCheck.sampleCount} sample(s), ${attribution.spotCheck.misattributed} misattributed — ${attribution.spotCheck.notes}`,
    `- Per-file churn: ${attribution.churnCrossCheck}`,
    "",
    `Named phases: ${draft.phases.join(" → ")}`,
  ]
    .join("\n")
    .slice(0, 100_000);

// One id, one kind, as many versions as the paths need: the deliverable publishes the
// narration the writer wrote (read from the workspace), the restore republishes it after the
// writer re-creates it, and the compact fallback mints the final version of the same id.
const NARRATIVE_TITLE = `Git history narrative: ${repo}@${branch}`;
if (decision.approved) {
  let published = false;
  try {
    await artifact.markdown("history-narrative", await files.read(DOC_PATH), {
      title: NARRATIVE_TITLE,
      description: draft.headline,
      primary: true,
    });
    published = true;
  } catch {
    log("the narration would not publish — asking the writer to restore it");
    try {
      await writer.ask<RevisionNotes>(
        `The file at ${DOC_PATH} is missing or unreadable. Re-write the full narrated history to exactly that path — same structure and content as before.`,
      );
      await artifact.markdown("history-narrative", await files.read(DOC_PATH), {
        title: NARRATIVE_TITLE,
        description: draft.headline,
        primary: true,
      });
      published = true;
    } catch {
      log("the restore failed too — publishing the compact fallback");
    }
  }
  if (!published) {
    try {
      await artifact.markdown(
        "history-narrative",
        compactMarkdown(
          "The full narrated document could not be published from this run; these are the measured facts it was built from.",
        ),
        {
          title: `Git history measurements: ${repo}@${branch}`,
          description: draft.headline,
          primary: true,
        },
      );
    } catch (error) {
      log(`even the compact fallback failed to publish: ${String(error)}`);
    }
  }
} else {
  try {
    await artifact.markdown(
      "history-narrative",
      compactMarkdown(
        `**The full narrative was withheld — ${withheldReason}.** The measured facts stand on their own below; the narrative document remains in the workspace at ${DOC_PATH}.`,
      ),
      {
        title: `Git history measurements: ${repo}@${branch}`,
        description: "Measured dimensions only — the narrative was not owner-approved",
        primary: true,
      },
    );
  } catch (error) {
    log(`the compact fallback failed to publish: ${String(error)}`);
  }
  pushFinding({
    where: DOC_PATH,
    what: `the narrated history was written to the workspace but not published as the run's deliverable — ${withheldReason}`,
    evidence: `publication decision: approved=${String(decision.approved)}; what the owner (or the attempt to reach them) said: ${decision.ownerReply}`,
    status: "verified",
    severity: "medium",
  });
}

const liveDimensions = dimensionAttempts.filter((a) => a.ok).length;
// The figures are the analysts' own work; this counts how many actually returned the command
// lists they were asked for, so the report claims only what their returns show.
const analystsQuoted = dimensionAttempts.filter((a) => a.ok && a.value.commands.length > 0).length;
// Whether out/ is ignored is a fact about this workspace, so ask git rather than asserting a
// particular repository's ignore rules in prose.
const outIgnoredRun = await world.run("git", ["check-ignore", "-q", "out/"]);
const commitsPhrase =
  gate.trueCount >= 0
    ? `${String(gate.trueCount)} commits`
    : `${gate.fetchedCount >= 0 ? String(gate.fetchedCount) : "an unknown number of"} fetched commits`;
const curveClause =
  curveAttempt.ok
    ? `${curve.months.length} months classified into the skill's phases${labelMismatches.length > 0 ? ` (${labelMismatches.length} label(s) contradicted their ratio and are listed in findings)` : ""}`
    : "the maturity curve failed and the arc rests on the dimension data alone";
const spotCheckClause = attributionAttempt.ok
  ? `fix buckets spot-checked with ${attribution.spotCheck.sampleCount} sample(s), ${attribution.spotCheck.misattributed} misattributed`
  : "fix attribution failed";
const publishClause = decision.approved
  ? `the owner approved publication and the narrative is published from ${DOC_PATH}`
  : `publication was not owner-approved (${withheldReason}); the measured facts were published instead`;

const result: WorkflowReport = {
  conclusion: `${commitsPhrase} on ${repo}@${branch}, measured along ${liveDimensions} of ${DIMENSIONS.length} dimensions plus the maturity curve and fix attribution, and read as a ${draft.phases.length}-phase arc (${draft.phases.join(" → ")}). ${curveClause}; ${spotCheckClause}. ${publishClause}.`,
  findings,
  verified: [
    `test -f ${HISTORY_SCRIPT} — the skill's history script confirmed present before it ran`,
    `bash <skill>/scripts/history_report.sh ${repo} ${branch} → exit 0; the paginated GitHub log is at ${LOG_PATH} (${gate.fetchedCount >= 0 ? `${String(gate.fetchedCount)} lines` : "line count unparsed"}, pagination header ${gate.trueCount >= 0 ? String(gate.trueCount) : "unavailable"})`,
    cloneIsTarget
      ? countsAgree
        ? `git rev-list --count ${gate.localRef} → ${gate.likeForLike}, matching GitHub's ${branch} — the local clone is full, and the GitHub log was used anyway`
        : `git rev-list --count ${gate.likeForLike >= 0 ? gate.localRef : "--all"} → ${gate.likeForLike >= 0 ? String(gate.likeForLike) : gate.localAll >= 0 ? String(gate.localAll) : "unavailable"}, compared against GitHub's ${branch} at ${gate.trueCount >= 0 ? String(gate.trueCount) : "an unknown count"}`
      : originUrl !== ""
        ? `git remote get-url origin → ${originUrl}, not the analysed repository — the local-versus-GitHub depth cross-check has no like-for-like local clone here, so the skill's script's GitHub pull is the sole history source`
        : `git remote get-url origin → exit ${remoteUrlRun.exitCode} — this workspace has no origin remote, so the depth cross-check could not run and the skill's script's GitHub pull is the sole history source`,
    `date +%z %Z — the owner's timezone for the hour dimension: ${tzLabel}`,
    analystsQuoted === liveDimensions && liveDimensions > 0
      ? `${liveDimensions} dimension analysts were instructed to recompute their figures from ${LOG_PATH} and quote their commands; all ${String(liveDimensions)} returned command lists (attested by their returns, not re-run here)`
      : `${liveDimensions} dimension analysts were instructed to recompute their figures from ${LOG_PATH} and quote their commands; ${String(analystsQuoted)} of ${String(liveDimensions)} returned command lists — the figures are analyst-attested and were not re-run here`,
    wall
      ? `the wall month's fix and feat counts and the lifetime fix denominator behind its share were recounted directly from the log with awk`
      : "no single month dominated the lifetime fix count",
    attributionAttempt.ok
      ? `the lifetime fix total was recounted directly from the log with awk and compared against the attribution analyst's count`
      : "fix attribution failed; no bucket numbers stand",
    `${readRounds + 1} separate cold-reader session(s) read the narration; ${issues.length} issue(s) left open${issues.length > COLD_ISSUE_REPORT_CAP ? `, of which findings lists the first ${String(COLD_ISSUE_REPORT_CAP)}` : " are listed in findings"}`,
    `the run owner's publication decision was obtained by escalation: ${decision.approved ? "approved" : "not approved"}${approvalRounds > 0 ? ` after ${String(approvalRounds)} revision round(s)` : ""}`,
  ],
  notCovered: [
    `history outside branch ${branch}, and any other remotes`,
    "keyword-bucket counts overlap by design — they are signals, not an audit (the skill's own caveat, carried into the narration)",
    "the authorship split undercounts agent-assisted work — the explicit count is a floor (the skill's own caveat)",
    ...(gate.trueCount < 0
      ? [
          gate.fetchedCount >= 0
            ? "the pagination header printed its fallback, so the true commit total is unknown; the fetched log's line count is the only total that stands"
            : "the pagination header printed its fallback and the fetched line count could not be parsed either, so no commit total stands — every figure is a raw recount of the log",
        ]
      : []),
    ...(!cloneIsTarget
      ? [
          originUrl !== ""
            ? `the skill's local-versus-GitHub depth cross-check: this workspace's origin (${originUrl}) is not the analysed repository ${repo}, so there was no like-for-like local clone to compare`
            : `the skill's local-versus-GitHub depth cross-check: this workspace has no origin remote, so there was no local clone to compare`,
        ]
      : gate.likeForLike < 0
        ? [`no like-for-like local ref resolved, so the depth comparison used ${gate.localAll >= 0 ? "the all-refs count" : "no local count"}`]
        : []),
    ...dimensionAttempts.filter((a) => !a.ok).map((a) => `the ${a.value.dimension} measurement failed and is missing`),
    ...(!curveAttempt.ok ? ["the maturity curve failed; the arc and the phases could not be verified"] : []),
    ...(!attributionAttempt.ok ? ["fix attribution failed; no bucket counts stand"] : []),
    ...(attributionAttempt.ok && attribution.spotCheck.sampleCount < SPOT_CHECK_MIN
      ? ["the bucket spot-check fell below the skill's floor, so the bucket counts are labelled untrustworthy rather than repaired"]
      : []),
    ...(readRounds === 0 && issues.length > 0
      ? ["the cold read's issues are listed in findings but were not revised out (the revision budget was spent elsewhere)"]
      : []),
    ...(issues.length > 0
      ? [
          `${issues.length} cold-read issue(s) remained after the revision budget; the first ${String(Math.min(issues.length, COLD_ISSUE_REPORT_CAP))} are listed in findings${issues.length > COLD_ISSUE_REPORT_CAP ? ` and ${String(issues.length - COLD_ISSUE_REPORT_CAP)} more are counted here only` : ""} — none silently fixed`,
        ]
      : []),
    ...(!decision.approved ? [`the narrated history at ${DOC_PATH} was never published as a deliverable — ${withheldReason}`] : []),
    ...(outIgnoredRun.exitCode === 0
      ? [
          "git check-ignore -q out/ reports this workspace ignores out/, so the working files under out/git-analytics live only in the run's outputs — a clean checkout will not carry them (the published card carries the bytes)",
        ]
      : outIgnoredRun.exitCode > 1
        ? ["git check-ignore -q out/ failed, so whether the working files under out/git-analytics survive a clean checkout is unknown"]
        : []),
  ],
};
return result;
