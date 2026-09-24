/* zcode-workflow
description: "Turns a repository's full GitHub history into an evidence-based
  project retrospective: pulls every commit through the skill's own analysis
  script as a deterministic gate, assembles and cross-checks headline figures
  against measured command output with independent audit rounds, and writes the
  retrospective. Embodies the git-history-project-retrospective skill."
whenToUse: When the request is a project retrospective or history analysis
  grounded in the actual commit record rather than memory.
args:
  branch:
    type: string
    description: Branch to analyze; empty uses the current branch.
    required: false
  repo:
    type: string
    description: Repository path to analyze; empty uses the workspace.
    required: false
  skillDir:
    type: string
    description: Path to the git-history-project-retrospective skill dir holding scripts/.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow draft — embodies ~/.agents/skills/git-history-project-retrospective/SKILL.md
// (the 7-step git-history project retrospective).
// Hybrid pattern: phases, fan-out, bounded loops, gates and the report live here; the fine
// detail (metric formulas, difficulty-type framework, doc structure, pitfalls) is left to the
// subagent asks, which point at the skill's SKILL.md and references/. The skill's shipped
// script (scripts/git_history_analysis.sh) runs as the deterministic extraction gate.
// Calling convention (declared in the zcode-workflow block below): repo = "owner/name" is
// required, branch defaults to "main", and skillDir points at the skill directory whose
// scripts/git_history_analysis.sh runs the extraction (probed for before the gate runs).

interface HeadlineMetrics {
  /** True commit count on GitHub, from the pagination header the extraction printed. */
  trueCount: number;
  /** "2019-03 .. 2026-09", read off the log itself. */
  dateRange: string;
  /** "12 commits in 2025-01", one entry per month, chronological. */
  byMonth: string[];
  /** "214 feat", one entry per conventional type, largest first. */
  typeDistribution: string[];
  /** Work-pattern facts: peak hour, peak weekday, weekend share. */
  workPatterns: string[];
  /** Author split with counts, carrying the skill's caveat that authorship undercounts agent-assisted work. */
  authors: string[];
  /** Every zero-commit month in range, each verified with a raw grep -c. */
  zeroCommitMonths: string[];
  /** The exact commands run to derive these, for the evidence trail. */
  commands: string[];
}

interface DomainSpec {
  /** Short domain name, e.g. "PDF extraction". */
  name: string;
  /** Strict grep -E regex applied to the commit subject only. */
  keywordRegex: string;
  /** One sentence: what work this bucket is meant to capture. */
  rationale: string;
}

interface Taxonomy {
  domains: DomainSpec[];
  /** Thematic subjects that fit no bucket, if any. */
  notes: string;
}

interface DomainBucket {
  /** Domain name, copied from the taxonomy. */
  domain: string;
  /** Commits matching the keyword regex (subject field only). */
  total: number;
  /** Matching commits whose subject starts with "fix". */
  fixes: number;
  /** fixes/total as a percentage; null when the bucket matched nothing. */
  fixRatePct: number | null;
  /** 3-5 real subjects, quoted verbatim with dates, spot-checked against the regex. */
  sampleSubjects: string[];
  /** Over-matches noticed while spot-checking, and what was tightened. */
  spotCheckNotes: string;
  /** The exact commands used, for the evidence trail. */
  commands: string[];
  /** False when this bucket's measurer failed and the numbers are missing. */
  ok: boolean;
}

interface MonthArcPoint {
  /** "2026-07". */
  month: string;
  /** Fix commits that month. */
  fix: number;
  /** Feat commits that month. */
  feat: number;
  /** fix/feat rounded to 2dp; null when there were no feat commits that month. */
  ratio: number | null;
  /** building | stabilizing | crunch | hardening | renaissance | silent */
  maturityPhase: string;
}

interface ArcAnalysis {
  months: MonthArcPoint[];
  /** The maturity story in 3-5 sentences, per the references' reading rules. */
  interpretation: string;
  /** The exact commands run, for the evidence trail. */
  commands: string[];
}

interface LandmarkFinding {
  /** What the landmark is, one sentence. */
  what: string;
  /** The command and its output that proved it. */
  evidence: string;
}

interface Landmarks {
  /** Busiest days, single-day build bursts, first appearance of each major subsystem, the schema-churn collapse point, verified zero-commit months, deploy-gate ratio. */
  findings: LandmarkFinding[];
  /** The exact commands run, for the evidence trail. */
  commands: string[];
}

interface DifficultyRanking {
  rankings: {
    /** Domain name, copied from the bucket. */
    domain: string;
    /** Measured fix rate, hardest first ordering. */
    fixRatePct: number | null;
    /** One of the seven difficulty types from references/metrics-and-interpretation.md. */
    difficultyType: string;
    /** front-loaded | distributed | one big peak | never settles | steady | spread. */
    monthlyShape: string;
    /** One sentence on what the difficulty means for maintenance, per the reading rules. */
    reading: string;
  }[];
  /** The cross-cutting pattern across all domains. */
  crossCuttingPattern: string;
}

interface WrittenDraft {
  /** Workspace-relative path of the retrospective document. */
  path: string;
  /** discovery | execution — the project archetype per references/plan-driven-app-notes.md, classified before writing. */
  archetype: string;
  /** The document's headline finding, one sentence. */
  headline: string;
  /** Section headings in order. */
  sections: string[];
}

interface AuditDiscrepancy {
  /** The figure as the draft states it. */
  inDraft: string;
  /** What the auditor recomputed from the raw log. */
  recomputed: string;
  /** The command that produced the recomputation. */
  command: string;
}

interface FigureAudit {
  /** True only when every figure the auditor recomputed matches the draft. */
  clean: boolean;
  /** Figures that disagree, each with the recomputed value and the command. */
  discrepancies: AuditDiscrepancy[];
  /** Figures that were recomputed and matched. */
  confirmed: string[];
}

interface ReaderNotes {
  /** Where the text is unclear or unsupported, judged from the text alone. */
  issues: { where: string; what: string }[];
  /** Questions the reader expects the user to ask next. */
  likelyQuestions: string[];
}

interface RevisionNotes {
  /** What changed in the document this round. */
  changed: string;
}

interface RetroFinding {
  /** Where the finding lives: a path, a month, a domain. */
  where: string;
  /** One sentence: what was found. */
  what: string;
  /** What showed it: the command and its output, or the subagent check. */
  evidence: string;
  /** "verified" when an independent check or subagent confirmed it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for a wrong result the user would act on. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: RetroFinding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

const repo = String(args.repo ?? "").trim();
const branch = String(args.branch ?? "main").trim() || "main";
// Where the skill lives is a machine fact, not a constant: it is an argument (declared in the
// zcode-workflow block above) with the common location as its default, and the script file is
// probed for before the gate runs so a wrong path reads as a missing file — not as bad
// GitHub credentials.
const DEFAULT_SKILL_DIR = "/Users/alejandrodelvillar/.agents/skills/git-history-project-retrospective";
const SKILL_DIR = String(args.skillDir ?? DEFAULT_SKILL_DIR).trim().replace(/\/+$/, "") || DEFAULT_SKILL_DIR;
const ANALYSIS_SCRIPT = `${SKILL_DIR}/scripts/git_history_analysis.sh`;
const TMP_LOG = `/tmp/gh_commits_${branch}.txt`;
const LOG_PATH = `out/git-retrospective/commits-${branch}.txt`;
// Keyed on repo AND branch: two runs on different branches of one repository must not overwrite
// each other's document (measured on this repo — main and development are different histories).
const DOC_PATH = `out/git-retrospective/retrospective-${repo.replace(/[^a-zA-Z0-9]+/g, "-")}-${branch}.md`;

// The host validates the declared args, but a non-slug must stop here rather than default
// silently to somebody's repository.
if (!repo.includes("/")) {
  const badArg: WorkflowReport = {
    conclusion: `Pass the repository as owner/name (args.repo); got ${repo === "" ? "an empty value" : `"${repo}"`}. Nothing was analysed.`,
    findings: [],
    verified: [],
    notCovered: ["everything — no extraction ran without a repository slug"],
  };
  return badArg;
}

phase("Pull the full commit history from GitHub");
log(`fetching the full history of ${repo}@${branch} from the GitHub API — never the local clone (skill step 1)`);

// Deterministic gate #0: the skill's script must exist before anything is blamed on credentials.
const scriptProbe = await world.run("test", ["-f", ANALYSIS_SCRIPT]);
if (scriptProbe.exitCode !== 0) {
  log(`skill script missing: ${ANALYSIS_SCRIPT}`);
  const failed: WorkflowReport = {
    conclusion: `${ANALYSIS_SCRIPT} is not on this machine, so the history could not be extracted. Pass args.skillDir as the directory holding the git-history-project-retrospective skill (the directory whose scripts/git_history_analysis.sh runs the extraction).`,
    findings: [],
    verified: [`test -f ${ANALYSIS_SCRIPT} → exit ${scriptProbe.exitCode}`],
    notCovered: [`everything — no extraction ran for ${repo}@${branch}`],
  };
  return failed;
}

// Deterministic gate #1: the skill's own re-runnable script pulls the FULL GitHub history
// with pagination and prints the headline metrics. Slow by design (skill pitfall: gh api is
// slow for bulk), so it gets a long timeout. Wrapped so an uncatchable run rejection (oversized
// output, timeout, spawn failure) lands as a legible report instead of a dead run.
const extractionRun = await world
  .run("bash", [ANALYSIS_SCRIPT, repo, branch], { timeoutMs: 1_800_000 })
  .then(
    (result) => ({ ran: true as const, result }),
    (error: unknown) => ({ ran: false as const, message: String(error) }),
  );
if (!extractionRun.ran) {
  log(`history extraction could not run: ${extractionRun.message}`);
  const failed: WorkflowReport = {
    conclusion: `The extraction command could not be executed for ${repo}@${branch}, so no retrospective was produced — its output could not be captured (oversized output, timeout or spawn failure). Reported cause: ${extractionRun.message}`,
    findings: [],
    verified: [`bash ${ANALYSIS_SCRIPT} ${repo} ${branch} → the run produced no result`],
    notCovered: [`everything — no history could be fetched for ${repo}@${branch}`],
  };
  return failed;
}
const extraction = extractionRun.result;
if (extraction.exitCode !== 0) {
  // Fail closed, but name the actual cause: an auth hint is wrong for a missing branch, and a
  // 404 hint is wrong for a missing gh binary. Each phrase below was matched against the real
  // stderr the script produces for that case.
  const errTail = `${extraction.stderr}\n${extraction.stdout}`.slice(-600).trim();
  const cause = /command not found|no such file or directory/i.test(errTail)
    ? `the gh CLI is not installed or not on PATH for this run (the script exited ${extraction.exitCode})`
    : /bad credentials|401|authentication|not logged in|gh auth|please run: gh auth login/i.test(errTail)
      ? `gh is not authenticated for this host — check \`gh auth status\` (the script exited ${extraction.exitCode} and its output names credentials)`
      : /404|not found|could not resolve|must give repository|invalid repository|no git repositories found/i.test(errTail)
        ? `${repo} is not visible to this gh token, or the branch ${branch} does not exist — check the repository slug and the branch name (the script exited ${extraction.exitCode})`
        : `the extraction command failed and its output is quoted below (exit ${extraction.exitCode})`;
  log(`history extraction failed (exit ${extraction.exitCode}): ${extraction.stderr.slice(-500)}`);
  const failed: WorkflowReport = {
    conclusion: `Could not pull the history of ${repo}@${branch} from GitHub, so no retrospective was produced: ${cause}. Output tail: ${errTail}`,
    findings: [],
    verified: [`bash scripts/git_history_analysis.sh ${repo} ${branch} → exit ${extraction.exitCode}`],
    notCovered: [`everything downstream — no full history could be fetched for ${repo}@${branch}`],
  };
  return failed;
}

// Parse the two counts the gate printed, guarding the single-page fallback (which prints
// "1 (or single page)" and must never be read as a count).
const trueMatch = extraction.stdout.match(/=== TRUE COMMIT COUNT[^\n]*===\s*\n(\d+)\s*\n/);
const trueCount = trueMatch ? Number(trueMatch[1]) : -1;
const savedMatch = extraction.stdout.match(/Saved (\d+) commits/);
const fetchedCount = savedMatch ? Number(savedMatch[1]) : -1;

// Free deterministic check: the pagination header and the paginated fetch must describe the
// same history. A short fetch means every figure downstream is a floor, not a total.
const paginationGap = trueCount >= 0 && fetchedCount >= 0 && trueCount !== fetchedCount;
const truncationFinding: RetroFinding | undefined = paginationGap
  ? {
      where: "history extraction",
      what: `the pagination header counted ${trueCount} commits but the paginated fetch wrote ${fetchedCount} log lines${
        fetchedCount < trueCount ? ` — the log is short by ${trueCount - fetchedCount} commits` : ""
      }; every count derived from it is a floor, not a total`,
      evidence: `=== TRUE COMMIT COUNT header → ${trueCount}; "Saved ${fetchedCount} commits" from the same script run`,
      status: "verified",
      severity: "high",
    }
  : undefined;
if (truncationFinding) report(truncationFinding);

// Deterministic gate #2: the skill's headline pitfall — the local clone's count is not the
// history's count. Compared like-for-like against the SAME branch GitHub was asked about, and
// deliberately WITHOUT a git fetch first: refreshing the remote-tracking ref would erase the
// stale/squashed/shallow-clone signal this check exists to catch. HEAD is a last resort and is
// recorded as not comparable, because the checked-out branch is not the analysed branch.
const localRefs = [`origin/${branch}`, branch, "HEAD"];
let localCount = -1;
let localRef = "";
for (const ref of localRefs) {
  const listed = await world.run("git", ["rev-list", "--count", ref]);
  const parsed = Number(listed.stdout.trim());
  if (listed.exitCode === 0 && Number.isFinite(parsed)) {
    localCount = parsed;
    localRef = ref;
    break;
  }
}
const likeForLike = localRef === `origin/${branch}` || localRef === branch;

// Bring the pipe-delimited log into the workspace so the subagents can read it.
await world.run("mkdir", ["-p", "out/git-retrospective"]);
const copy = await world.run("cp", [TMP_LOG, LOG_PATH]);
if (copy.exitCode !== 0) {
  const failed: WorkflowReport = {
    conclusion: `The history was fetched from GitHub but the raw log could not be copied into the workspace (cp exited ${copy.exitCode}), so the analysis could not run.`,
    findings: [],
    verified: [`bash scripts/git_history_analysis.sh ${repo} ${branch} → exit 0`],
    notCovered: ["everything downstream — the fetched log at /tmp was not readable"],
  };
  return failed;
}

// The fix:feat arc chart the skill's step 5 asks for, fed live as the months are analysed.
artifact.chart("fixfeat-arc", {
  title: `fix:feat ratio by month — ${repo}@${branch}`,
  x: { field: "month", label: "Month" },
  y: { field: "ratio", label: "fix:feat" },
  baseline: { field: "one", label: "parity (1.0)" },
});

log(`GitHub history: ${trueCount >= 0 ? `${trueCount} commits (pagination header)` : "single page or unknown count"}, ${fetchedCount >= 0 ? `${fetchedCount} fetched` : "fetch count unparsed"}; local clone: ${localCount >= 0 ? `${localCount} via ${localRef}` : "unknown"}`);
const undercountFinding: RetroFinding | undefined =
  likeForLike && localCount >= 0 && trueCount >= 0 && localCount < trueCount
    ? {
        where: "local repository history",
        what: `the local clone's ${localRef} holds ${localCount} commits but GitHub's ${branch} holds ${trueCount} — the retrospective runs on the GitHub log, as the skill's step 1 requires`,
        evidence: `git rev-list --count ${localRef} → ${localCount}; the pagination header gh api reported for ${repo}@${branch} → ${trueCount}`,
        status: "verified",
        severity: "low",
      }
    : undefined;
if (undercountFinding) report(undercountFinding);

phase("Assemble and spot-check the headline metrics");
// Skill step 2. The extraction gate already printed these; the metrics pass cross-checks them
// against the raw log with its own commands and formats them. The printout is passed trimmed,
// not whole: the log itself is on disk for the subagent to re-derive from, and the
// month-by-month sections are the part that grows with the repo's age.
const PRINTOUT_CAP = 8000;
const printout =
  extraction.stdout.length > PRINTOUT_CAP
    ? `${extraction.stdout.slice(0, PRINTOUT_CAP)}\n[printout trimmed here — recompute anything past this point from the raw log at ${LOG_PATH}]`
    : extraction.stdout;
const metrics = await agent("headline-metrics", {
  system:
    "You compile git-history statistics from raw logs. You never state a number you did not compute with a command you ran, and you quote the command for every figure.",
}).ask<HeadlineMetrics>(
  `Compile the headline metrics for the retrospective of ${repo}@${branch}.
Read ${SKILL_DIR}/SKILL.md — step 2 and the whole "Pitfalls" section — and ${SKILL_DIR}/references/plan-driven-app-notes.md ("Monthly-stats computation (pitfall)"): count months with awk on field 1, never chained cut/grep; trust a raw grep -c over a wrapped wc -l; on macOS there is no tac.
The raw log (DATE|AUTHOR|SUBJECT, one commit per line) is at ${LOG_PATH}. Recompute or verify anything you return with your own commands against it.
The extraction script's own printout, to cross-check rather than re-derive from scratch:
${printout}
Return: trueCount (should be ${trueCount >= 0 ? String(trueCount) : "unknown — say so"}), dateRange, byMonth, typeDistribution, workPatterns, authors (with the agent-assisted-work caveat noted), every zeroCommitMonths entry verified with a raw grep -c, and the exact commands you ran.`,
);
log(`metrics compiled: ${metrics.dateRange}, ${metrics.byMonth.length} months in range, ${metrics.zeroCommitMonths.length} silent month(s)`);
// Skill step 5 treats "a month with zero commits" as a landmark, and the skill's notes insist
// the cause is never assumed — stability or abandonment is the user's call. Reported the moment
// they land, so a run that dies later keeps them (salvage-by-report).
const zeroMonthFindings: RetroFinding[] = metrics.zeroCommitMonths.map((m) => ({
  where: m,
  what: "zero-commit month — surfaced as a landmark finding; the cause (stability or abandonment) is the user's to confirm, never assumed",
  evidence: `each entry verified with a raw grep -c by the metrics pass; its commands: ${metrics.commands.join("; ")}`,
  status: "unconfirmed",
  severity: "medium",
}));
for (const zeroFinding of zeroMonthFindings) report(zeroFinding);
// The subagent's independent recount of the same history must agree with the pagination header,
// or something was misread. When its number merely repeats the header-vs-log-line gap already
// reported above, it adds nothing and stays silent rather than filing the same gap twice.
const countMismatch = trueCount >= 0 && metrics.trueCount >= 0 && metrics.trueCount !== trueCount;
const countMismatchFinding: RetroFinding | undefined =
  countMismatch && !(paginationGap && metrics.trueCount === fetchedCount)
    ? {
        where: "repository history",
        what: `the pagination header said ${trueCount} commits but the metrics pass counted ${metrics.trueCount} in the fetched log`,
        evidence: `scripts/git_history_analysis.sh pagination header → ${trueCount}; the metrics pass's own recount → ${metrics.trueCount} (commands: ${metrics.commands.join("; ")})`,
        status: "verified",
        severity: "medium",
      }
    : undefined;
if (countMismatchFinding) report(countMismatchFinding);

phase("Group the commits into work domains");
// Skill step 3: strict keyword buckets, designed against the real subjects.
const taxonomy = await agent("domain-taxonomist", {
  system:
    "You design strict keyword buckets over commit subjects: precise regexes, no sweeping keywords, and you say what each bucket is for.",
}).ask<Taxonomy>(
  `Design the domain buckets for ${repo}'s retrospective.
Read ${SKILL_DIR}/SKILL.md steps 3-4 and ${SKILL_DIR}/references/plan-driven-app-notes.md ("Domain keyword sets" — a reusable starting point for Next.js/Prisma line-of-business apps; adapt it to what this log actually contains).
Skim the commit subjects in ${LOG_PATH} first. Return 6-10 domains with STRICT grep -E regexes over the subject line only — the skill warns that loose keywords ("port", "ship") sweep in unrelated UI commits. Overlap is expected: a commit may match several buckets; do not try to make them disjoint. Note in "notes" the recurring subjects that fit no bucket.`,
);
log(`${taxonomy.domains.length} domain buckets: ${taxonomy.domains.map((d) => d.name).join(", ")}`);

phase("Measure each domain's commit count and fix rate");
// Skill steps 3-4, one independent measurer per domain — the buckets are unrelated questions,
// so they fan out. One fixed name would collide once per item, so the name carries the index.
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "domain";
const buckets = await Promise.all(
  taxonomy.domains.map(async (d, i): Promise<DomainBucket> => {
    try {
      return await agent(`domain-measurer-${i}-${slug(d.name)}`, {
        system:
          "You count things in a git log with real commands and quote your command and its output for every number. You never estimate or round.",
      }).ask<DomainBucket>(
        `Measure one domain bucket of the ${repo} log at ${LOG_PATH} (pipe-delimited DATE|AUTHOR|SUBJECT).
Domain: ${d.name} — ${d.rationale}
Keyword regex (grep -E, applied to the SUBJECT field only, case-insensitive): ${d.keywordRegex}
Read ${SKILL_DIR}/SKILL.md steps 3-4 first. Apply the regex to the subject field only (awk -F'|'), count matching commits, count matching commits whose subject starts with "fix", compute the fix rate as a percentage. Then spot-check: quote 3-5 real matched subjects verbatim with their dates, and record any over-matches you notice in spotCheckNotes — the skill's warning is that loose keywords sweep in unrelated commits. Expect overlap with other buckets; do not deduplicate against them. If the bucket matches nothing, return total 0 and fixRatePct null. Return the exact commands you ran.`,
      );
    } catch (error) {
      log(`the measurer for ${d.name} failed: ${String(error)}`);
      return {
        domain: d.name,
        total: 0,
        fixes: 0,
        fixRatePct: null,
        sampleSubjects: [],
        spotCheckNotes: `measurer failed: ${String(error)}`,
        commands: [],
        ok: false,
      };
    }
  }),
);
for (const b of buckets) report(b);
const liveBuckets = buckets.filter((b) => b.ok && b.total > 0);
log(`${liveBuckets.length} of ${buckets.length} buckets measured non-empty`);

phase("Read the maturity arc and hunt the landmarks");
// Skill steps 5-6, two independent questions in parallel.
const [arc, landmarks] = await Promise.all([
  agent("arc-analyst", {
    system:
      "You read monthly commit statistics for the story they tell about a project's maturity, and you never state a number you did not verify with a command.",
  }).ask<ArcAnalysis>(
    `Chart and read the monthly fix:feat arc for ${repo}@${branch}.
Read ${SKILL_DIR}/SKILL.md step 5 and ${SKILL_DIR}/references/metrics-and-interpretation.md ("fix:feat ratio (per month)" formula and the reading rules): building (<1.0) → stabilizing (~1.0) → crunch (>1.5) → hardening (>3.0) → renaissance (back <1.0).
Recompute fix and feat per month yourself from ${LOG_PATH} (the extraction printout already lists them — cross-check at least three months against the raw log). Return one MonthArcPoint per month, with ratio null for months with no feat commits and maturityPhase "silent" for months with no commits at all. Write the interpretation per the reading rules — the arc is a maturity story, not a quality story; a 4:1 fix month is usually the bill for months of learning coming due.`,
  ),
  agent("landmark-hunter", {
    system:
      "You find the events that anchor a project's story in its commit history, and you prove every one with a command.",
  }).ask<Landmarks>(
    `Find the landmarks in ${repo}@${branch}'s history. The raw log is at ${LOG_PATH}.
Read ${SKILL_DIR}/SKILL.md step 6 and the "Zero-commit months are evidence, not absence" and "Deploy gate ratio is context-dependent" sections of ${SKILL_DIR}/references/plan-driven-app-notes.md.
Find, each with the command and output that proves it: the busiest days and any single-day build bursts; the first appearance of each major subsystem or integration; the schema-churn collapse point (the month schema/migration/model commits collapse — the references' formula); every zero-commit month re-verified with a raw grep -c; and the deploy-gate ratio (staging merges vs prod merges), read against how many users sit behind the app rather than as an absolute.`,
  ),
]);
for (const m of arc.months) report({ ...m, one: 1 }, "fixfeat-arc");
log(`arc read: ${arc.months.length} months; ${landmarks.findings.length} landmarks found`);

phase("Rank the domains by difficulty type");
// Skill steps 4-5 interpretation: one calibrated judge, because the difficulty-type label and
// the ordering only mean something if they are assigned on one consistent scale.
const ranking = await agent("difficulty-classifier", {
  system:
    "You rank engineering workstreams on one consistent difficulty scale and commit to it across a whole batch.",
}).ask<DifficultyRanking>(
  `Classify and rank every domain from the ${repo} retrospective.
Read ${SKILL_DIR}/references/metrics-and-interpretation.md — "The difficulty-type framework" table and the reading rules under it — and classify each domain below by its difficulty type (one of the table's seven), its monthly shape, and a one-sentence reading. Order the rankings hardest first by fix rate.
Measured buckets: ${JSON.stringify(buckets)}
Monthly fix:feat arc: ${JSON.stringify(arc.months)}
Apply the reading rules: front-loaded difficulty is healthier than distributed; integration surfaces inherit everyone else's bugs; the arc is a maturity story, not a quality report; bottom-up structures cost more but produce truth. Also give the single cross-cutting pattern across the domains.`,
);
for (const r of ranking.rankings) report({ kind: "difficulty ranking", ...r });
log(`ranked ${ranking.rankings.length} domains; hardest: ${ranking.rankings[0]?.domain ?? "none measured"}`);

phase("Write the retrospective draft");
// Skill step 7: the synthesis. One writer, because the document is one voice and needs every
// input at once. The structure and evidence discipline live in the skill's references.
const writer = agent("retrospective-writer", {
  system:
    "You write evidence-based engineering retrospectives. Every number in your prose traces to a command someone ran; you quote real commit subjects as evidence and never round or invent a figure.",
});
const draft = await writer.ask<WrittenDraft>(
  `Write the retrospective document for ${repo}@${branch} to ${DOC_PATH} (create it with your file tools).
Read ${SKILL_DIR}/references/metrics-and-interpretation.md ("Retrospective document structure" — The Numbers / Origin / Workstreams / Difficulty Ranking / Key Patterns & Lessons / The Product That Emerged) and follow that section order.
BEFORE writing, classify the project archetype per ${SKILL_DIR}/references/plan-driven-app-notes.md (blank-slate discovery vs written-plan execution) — it sets the narrative frame. Say which archetype you chose and why in one line under the title.
Evidence discipline, from the same reference: quote real commit subjects with dates as primary evidence; caveat keyword-bucket figures as signals, not precise audits; surface any zero-commit month as a headline finding and flag its cause as a question for the user (stability vs abandonment) rather than asserting it; note that authorship undercounts agent-assisted work.
The material, all verified upstream:
Headline metrics: ${JSON.stringify(metrics)}
Landmarks: ${JSON.stringify(landmarks.findings)}
Monthly arc: ${JSON.stringify(arc.months)}
Arc interpretation: ${arc.interpretation}
Difficulty ranking: ${JSON.stringify(ranking.rankings)}
Cross-cutting pattern: ${ranking.crossCuttingPattern}
Per-domain buckets (use the sample subjects as workstream evidence): ${JSON.stringify(buckets.map((b) => ({ domain: b.domain, total: b.total, fixes: b.fixes, fixRatePct: b.fixRatePct, samples: b.sampleSubjects, notes: b.spotCheckNotes })))}
Unbucketed subjects: ${taxonomy.notes}
Return the doc path, the archetype, the headline, and the section list.`,
);
log(`draft written to ${draft.path} (${draft.archetype}): ${draft.sections.join(" / ")}`);

phase("Fact-check the draft and publish the corrected version");
// The numbers are claims the user will quote, so they get an independent auditor that
// recomputes them from the raw log; the prose gets one cold read. Two mechanisms, one each.
const auditor = agent("figure-auditor", {
  system:
    "You re-compute figures from raw data with your own commands and compare them to a document's claims. You never edit any file.",
});
const reader = agent("independent-reader", {
  system:
    "You read a document cold, as its reader, and judge it from the text alone. You do not verify it against the repository.",
});
const [audit0, read0] = await Promise.all([
  auditor.ask<FigureAudit>(
    `Fact-check the figures in ${DOC_PATH} against the raw log at ${LOG_PATH}.
Read ${SKILL_DIR}/references/plan-driven-app-notes.md ("Monthly-stats computation (pitfall)") before computing — count months with awk on field 1, trust raw grep -c.
Recompute at least: the total commit count, the type distribution, the fix:feat ratio for three months of your choosing, three domain fix rates of your choosing, and the busiest day. Compare each against what the document states. Do not edit any file. Return clean=true only if every figure you recomputed matches the document.`,
  ),
  reader.ask<ReaderNotes>(
    `You have not seen this document before. Read ${DOC_PATH} from the text alone — do not verify it against the repository.
What is unclear, what does the text itself fail to support, what is missing for a reader who was not part of the project, and what will the user ask next?`,
  ),
]);
let audit = audit0;
let proseIssues = read0.issues;
let proseQuestions = read0.likelyQuestions;
let rounds = 0;
if (!audit.clean) log(`${audit.discrepancies.length} figure(s) disagree with the raw log`);
if (proseIssues.length > 0) log(`the cold read raised ${proseIssues.length} issue(s)`);

// Salvage-by-report: a discrepancy the audit found is a finding the moment it lands — a run that
// dies before the report is assembled must still carry the audit's work. The key dedupes a
// figure that survives across rounds into one item rather than two.
const reportedDiscrepancies = new Set<string>();
const reportNewDiscrepancies = (a: FigureAudit) => {
  for (const d of a.discrepancies) {
    const key = `${d.inDraft}|${d.recomputed}`;
    if (reportedDiscrepancies.has(key)) continue;
    reportedDiscrepancies.add(key);
    report({
      where: DOC_PATH,
      what: `the document states ${d.inDraft}; the recomputed value from the raw log is ${d.recomputed}`,
      evidence: d.command,
      status: "verified",
      severity: "high",
    });
  }
};
reportNewDiscrepancies(audit0);

// Bounded revision loop: fix from the findings, then re-check with the persistent auditor AND a
// brand-new reader each round, so the final state of the document is judged by eyes that never
// saw an earlier draft. Stops when both come back clean or the round cap is hit.
const fixer = agent("draft-reviser", {
  system:
    "You revise a document to fix specific findings. Change only what the findings require. When a figure disagrees with the recomputed value, fix the figure to the recomputed value — never the other way around.",
});
for (let round = 1; round <= 2 && (!audit.clean || proseIssues.length > 0); round++) {
  phase("Fix what the fact-check found");
  const revision = await fixer.ask<RevisionNotes>(
    `Revise ${DOC_PATH}.
Figure discrepancies (fix the document's figures to the recomputed values): ${JSON.stringify(audit.discrepancies)}
Cold-read issues to address${round > 1 ? " (the previous revision already took the earlier set — fix what is still wrong)" : ""}: ${JSON.stringify(proseIssues)}
Questions the cold reader expects the user to ask next (answer them where the document can): ${JSON.stringify(proseQuestions)}
Keep the document's structure and evidence discipline; change nothing else.`,
  );
  log(`revision ${round}: ${revision.changed}`);
  phase("Re-check the numbers and cold-read the revised draft");
  const [recheck, freshRead] = await Promise.all([
    auditor.ask<FigureAudit>(
      `The document at ${DOC_PATH} was just revised. Re-check the figures that disagreed last time — and any two others of your choosing — against the raw log at ${LOG_PATH}. Do not edit any file. Return clean=true only if every figure you recomputed now matches.`,
    ),
    agent(`round-cold-reader-${round}`, {
      system:
        "You read a document cold, as its reader, and judge it from the text alone. You do not verify it against the repository.",
    }).ask<ReaderNotes>(
      `You have not seen this document before. Read ${DOC_PATH} from the text alone — do not verify it against the repository.
What is unclear, what does the text itself fail to support, what is missing for a reader who was not part of the project, and what will the user ask next?`,
    ),
  ]);
  reportNewDiscrepancies(recheck);
  rounds = round;
  audit = recheck;
  proseIssues = freshRead.issues;
  proseQuestions = freshRead.likelyQuestions;
  log(`round ${round}: ${audit.clean ? "figures clean" : `${audit.discrepancies.length} still disagree`}; ${proseIssues.length} prose issue(s) from a reader with no memory of the earlier draft`);
}
// Whatever the last cold reader still objects to is left to the user, listed rather than
// silently revised past the round cap.
const unresolvedProse = proseIssues;
const proseFindings: RetroFinding[] = unresolvedProse.map((issue) => ({
  where: `${DOC_PATH} — ${issue.where}`,
  what: `a cold reader still raises this after ${rounds} revision round(s): ${issue.what}`,
  evidence: "a cold read of the revised document, judged from the text alone",
  status: "unconfirmed",
  severity: "low",
}));
for (const p of proseFindings) report(p);

// Publish the deliverable, with the repair idiom if the file is missing when published.
try {
  await artifact.file("retrospective", DOC_PATH, {
    title: `Project retrospective: ${repo}@${branch}`,
    description: draft.headline,
    primary: true,
  });
} catch {
  log("the retrospective file was not publishable — asking the writer to restore it");
  await writer.ask<RevisionNotes>(
    `The file at ${DOC_PATH} is missing or unreadable. Re-write the full retrospective document to exactly that path, same content and structure as before.`,
  );
  await artifact.file("retrospective", DOC_PATH, {
    title: `Project retrospective: ${repo}@${branch}`,
    description: draft.headline,
    primary: true,
  });
}

// Assemble the report from what actually happened. Each finding object was already reported the
// moment it landed (the salvage trail); this array states the run's FINAL condition, so the
// audit's entries reflect the last re-check rather than the first one.
const findings: RetroFinding[] = [];
if (truncationFinding) findings.push(truncationFinding);
if (undercountFinding) findings.push(undercountFinding);
if (countMismatchFinding) findings.push(countMismatchFinding);
for (const d of audit.discrepancies) {
  findings.push({
    where: DOC_PATH,
    what: `the document still states ${d.inDraft} after ${rounds} revision round(s); the raw log gives ${d.recomputed}`,
    evidence: d.command,
    status: "verified",
    severity: "high",
  });
}
for (const z of zeroMonthFindings) findings.push(z);
for (const p of proseFindings) findings.push(p);

const hardest = ranking.rankings[0];
const commitsPhrase = trueCount >= 0
  ? `${trueCount} commits`
  : fetchedCount >= 0
    ? `${fetchedCount} commits fetched`
    : "the commit history";
const hardestClause = hardest
  ? hardest.fixRatePct === null
    ? `, hardest being ${hardest.domain}, whose fix rate could not be measured`
    : `, hardest being ${hardest.domain} at a ${hardest.fixRatePct}% fix rate`
  : "";
// What the run did NOT establish, stated only for the cases that actually occurred.
const localRefLabel = localRef === "" ? `none of ${localRefs.join(", ")}` : localRef;
const notCovered: string[] = [
  `history outside branch ${branch} and any other remotes`,
  "keyword-bucket counts overlap by design — they are signals, not precise audits (skill step 3)",
  "the authorship split undercounts agent-assisted work (skill pitfall)",
  "figures the auditor did not recompute rest on their measuring subagent's quoted commands only",
];
if (trueCount < 0) {
  notCovered.push("the pagination header printed its single-page fallback, so the true total is unknown and only the fetched log's line count stands");
}
if (truncationFinding) {
  notCovered.push(`the fetched log holds ${fetchedCount} of the ${trueCount} commits the header counted — every count above is a floor, not a total`);
}
if (localCount < 0) {
  notCovered.push(`the local-clone comparison was impossible: git rev-list resolved ${localRefLabel} in this checkout`);
} else if (!likeForLike) {
  notCovered.push(`the local-clone comparison was skipped as not like-for-like: this checkout resolves only ${localRef}, a different branch from the analysed ${branch}`);
}
if (zeroMonthFindings.length > 0) {
  const silentMonths = zeroMonthFindings.map((f) => f.where).join(", ");
  notCovered.push(`the cause of ${zeroMonthFindings.length === 1 ? `the silent month ${silentMonths}` : `${zeroMonthFindings.length} silent months (${silentMonths})`} — surfaced for the user to confirm, not assumed`);
}
if (unresolvedProse.length > 0) {
  notCovered.push(`${unresolvedProse.length} clarity issue(s) the last cold reader raised were left listed rather than revised past the round cap`);
}
notCovered.push("the document and the fetched log live under out/, which this repository's .gitignore excludes — the published card carries the bytes, but a clean checkout will not have them and committing them needs git add -f");

const completenessClause =
  trueCount >= 0 && fetchedCount >= 0
    ? paginationGap
      ? `the header counted ${trueCount} commits but the paginated fetch wrote ${fetchedCount} log lines — the counts are floors`
      : `the header's ${trueCount} and the fetched log's ${fetchedCount} agree, so the fetch is complete`
    : "one of the two counts could not be parsed, so no completeness claim is made";
const zeroClause =
  zeroMonthFindings.length === 0
    ? ""
    : `; ${zeroMonthFindings.length} silent month(s) (${zeroMonthFindings.map((f) => f.where).join(", ")}) surfaced for the user to explain`;
const auditClause = audit.clean
  ? `An independent audit recomputed the draft's figures against the raw log and found them clean${rounds === 0 ? " on the first pass" : ` after ${rounds} revision round(s)`}`
  : `An independent audit still flags ${audit.discrepancies.length} figure(s) against the raw log after ${rounds} revision round(s), listed in findings`;
const proseClause =
  unresolvedProse.length === 0
    ? "a cold reader found nothing left to raise in the document as published"
    : `${unresolvedProse.length} clarity point(s) a cold reader raised are listed for you rather than revised past the round cap`;
const result: WorkflowReport = {
  conclusion: `${commitsPhrase} from ${metrics.dateRange}, read as a ${draft.archetype}-type retrospective: ${liveBuckets.length} domains ranked${hardestClause}${zeroClause}. ${auditClause}; ${proseClause}. The full document is at ${DOC_PATH} and the fix:feat arc chart accompanies it.`,
  findings,
  verified: [
    `test -f ${ANALYSIS_SCRIPT} — the skill's extraction script was confirmed present before the gate ran`,
    `bash scripts/git_history_analysis.sh ${repo} ${branch} — the skill's own extraction script, exit 0; the paginated GitHub log is at ${LOG_PATH}`,
    `pagination header vs paginated fetch: ${completenessClause}`,
    `git rev-list --count ${localRefLabel} — local clone count ${localCount >= 0 ? String(localCount) : "unavailable"}, ${likeForLike ? `compared like-for-like with GitHub's ${branch}` : `not comparable with GitHub's ${branch} (see notCovered)`}`,
    `headline metrics recomputed by the metrics compiler from ${LOG_PATH} with raw grep -c / awk (commands in its return)`,
    `${liveBuckets.length} domain fix rates measured by independent per-domain subagents, each quoting its commands and spot-checked subjects`,
    `figure audit: the auditor independently recomputed ${audit.confirmed.length} figure(s) that matched the draft and flagged ${audit.discrepancies.length} that did not, after ${rounds} revision round(s)${rounds === 0 ? " (the first audit was already clean)" : ""}`,
    rounds === 0
      ? "cold read by an independent reader who saw nothing but the document"
      : `cold reads by ${rounds + 1} separate reader session(s) — one on the draft and one per revision round, each judging only the version in front of it`,
  ],
  notCovered,
};
return result;
