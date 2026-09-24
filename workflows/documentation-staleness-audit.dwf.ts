/* zcode-workflow
description: "Audits documentation staleness: inventories docs, checks each
  against the code and drift signals in parallel (deep audits on the worst,
  confirmed findings), brokers open decisions to the run owner, and publishes a
  staleness report. Embodies the documentation-staleness-audit skill; its
  detect-* drift scripts are used as gates when the audited repo has them."
whenToUse: When a docs tree needs a staleness audit — which pages lie about the
  code, with confirmed findings and open decisions surfaced.
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: documentation-staleness-audit
// Embodies the 8-step procedure from ~/.agents/skills/documentation-staleness-audit/SKILL.md
// ("5-phase methodology": steps 1-4 are the four numbered items of Phase 1 — inventory,
// git-log recency, gap-window cross-reference, stale-term grep — and steps 5-8 are Phase 2
// severity classification, Phase 3 user clarification, Phase 4 phase-per-commit execution,
// Phase 5 verification. The same 8 steps also exist as sections 1-8 of
// references/audit-checklist.md; every one is mapped below.)
// Hybrid pattern: structure (phases, fan-outs, bounded loops, WorkflowReport) lives in
// this script; subagent asks reference the skill's SKILL.md, references/, and templates/
// for fine detail. This skill ships NO scripts/ (it ships templates/ instead), so no
// world.run gates are wired from the skill; world.run appears only where the procedure
// itself names a fixed deterministic command: the per-file `git log -1` recency check, and
// the audited repo's own scripts/detect-* drift checks when that repo happens to have them.
//
// Step map (SKILL.md Phase 1 items 1-4, then Phases 2-5):
//   steps 1-2 inventory + recency ...... phase "Take stock of every doc and check when each was last touched"
//   steps 3-4 gap window + stale grep .. phase "Find what changed since the docs were last reviewed" (analyst +
//                                        deterministic greps) and "Audit each flagged doc and confirm its findings as they land"
//   step 5  severity classification .... phases "Grade the findings and lay out the commit plan" (checklist 6's
//                                        live-count truth folded into the per-doc audit and the plan)
//   step 6  user clarification ......... phase "Get the user's call on the decisions this audit cannot make"
//   step 7  phase-per-commit execution . phases "Apply one group's doc fixes and commit them" +
//                                        "Review that group's commit before the next group starts" (checklist 5, 6, 8)
//   step 8  verification ............... phase "Confirm nothing stale is left behind" (checklist 7-8)

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface DocRecord {
  /** Workspace-relative path of the markdown file. */
  path: string;
  /** ISO 8601 author date of the last commit touching this file; null when git has never seen it. */
  lastTouched: string | null;
  /** Subject of that last commit; empty when there is none. */
  lastSubject: string;
  /** Path-based first guess: "current", "historical" (recaps/plans/archives), or "unknown". */
  kindGuess: string;
}

interface HitLine {
  /** Workspace-relative file the match was found in. */
  path: string;
  /** One-based line number of the match. */
  line: number;
  /** Full text of the matching line. */
  text: string;
}

interface ChangeWindow {
  /** ISO 8601 date documentation last got attention; the audit window starts here. Date-only is acceptable. */
  gapStart: string;
  /** Code paths that changed in the window with no matching doc update — the skill's red flags. */
  undocumentedChanges: { codePath: string; why: string }[];
  /** Deprecated things the docs may still present as current. `term` is a ripgrep-compatible regex. */
  staleTerms: { term: string; whyDeprecated: string }[];
  /** Secret shapes that must not live in committed docs (checklist section 5, adapted to this repo), as regexes. */
  secretPatterns: { label: string; regex: string }[];
  /** Files or commands the analyst could not read or run, plainly stated. */
  notCovered: string[];
}

interface AuditFinding {
  /** Workspace-relative path of the doc, with a line when it applies: "docs/arch/x.md:42". */
  where: string;
  /** One sentence: what the doc says that is no longer true, or what it fails to say. */
  what: string;
  /** What showed it: the lines read, or the command run and the output that proved it. */
  evidence: string;
  /** Where the truth lives: the code file, config, or query this finding was checked against (references/code-source-of-truth.md). */
  codeTruth: string;
  /** Tier proposed by the auditor using the SKILL.md Phase 2 table: "P0" | "P1" | "P2" | "P3". */
  proposedSeverity: string;
}

interface AuditResult {
  /** Every staleness finding this one doc produced; empty when the doc held up. */
  findings: AuditFinding[];
}

interface Confirmation {
  /** True only when you reproduced the finding yourself from its evidence. */
  reproduced: boolean;
  /** What you did to check, one sentence. */
  note: string;
}

interface TierCall {
  /** "P0" | "P1" | "P2" | "P3" on the scale the triage persona was given. */
  tier: string;
}

interface ConfirmedFinding extends AuditFinding {
  /** "verified" when the confirmer reproduced it; "unconfirmed" when it could not. */
  status: "verified" | "unconfirmed";
  /** The confirmer's one-line account of what it checked. */
  confirmNote: string;
  /** Tier from the shared severity scale, consistent across every doc. */
  triageTier: string;
}

interface PlanFinding {
  /** Where the stale claim lives, as the auditor reported it. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** "P0" | "P1" | "P2" | "P3" per the SKILL.md Phase 2 table, graded once on one scale. */
  tier: string;
  /** Which of the five commit groups fixes it (1 snapshot+root, 2 foundational, 3 secrets, 4 environment, 5 remainder). */
  group: number;
  /** "verified" | "unconfirmed", carried from the confirmer. */
  status: string;
  /** Evidence trimmed to one line. */
  evidence: string;
  /** One sentence: what to change. */
  fix: string;
  /** When set: the fix needs a human decision the run must not assume (SKILL.md Phase 3). */
  needsDecision?: string;
  /** When this finding restates the same shared-infrastructure claim: the authoritative sibling's location. */
  siblingOf?: string;
}

interface AuditPlan {
  /** Every finding, tiered, grouped, and deduplicated across files. */
  findings: PlanFinding[];
  /** Markdown table of tier x file counts, for the user to scope the work before anything is committed. */
  planTable: string;
  /** Decision points from SKILL.md Phase 3 that block execution; empty when none apply. */
  openDecisions: string[];
  /** Files or checks the planner could not cover, with the reason. */
  notCovered: string[];
}

interface Critique {
  /** False when the plan mis-tiers, mis-groups, drops a sibling copy, or contradicts the code. */
  sound: boolean;
  /** One entry per problem; empty when sound. */
  objections: string[];
}

interface Decision {
  /** The question the audit could not answer alone. */
  question: string;
  /** The answer in force for execution. */
  answer: string;
  /** "user" when an escalation was answered, "skill default" when SKILL.md's documented default applied, "assumed" otherwise. */
  source: string;
}

interface DecisionSet {
  decisions: Decision[];
}

interface GroupFix {
  /** What this commit group changed, two or three sentences. */
  summary: string;
  /** Workspace-relative paths this group edited. */
  filesChanged: string[];
  /** Full hash of the single commit this group made; empty string when nothing was committed. */
  commitHash: string;
  /** Findings deliberately deferred, each with the reason. */
  deferred: string[];
  /** Anything this group could not do, plainly. */
  notCovered: string[];
}

interface GroupReview {
  /** True only when the commit exists, touches only this group's files, and every edit matches the code or an approved decision. */
  passed: boolean;
  /** One entry per problem the editor must fix in the next round. */
  problems: string[];
}

interface DocJudgement {
  /** Workspace-relative doc path. */
  path: string;
  /** "acceptable" (historical by scope, bannered, or a legitimate wildcard) or "leftover" (still presented as current). */
  status: string;
  /** The remaining hit lines and why each is acceptable — or what is still broken. */
  reason: string;
}

interface DriftResult {
  /** Script that ran, workspace-relative. */
  check: string;
  /** Process exit code; nonzero is a real outcome, not a skipped check. -1 means the command could not run at all. */
  exitCode: number;
  /** The output tail that matters, plus the triager's note when there was one. */
  evidence: string;
  /** True when the failure is environmental (missing credentials, missing tool), not a regression. */
  environmental: boolean;
}

interface DriftTriage {
  /** One entry per drift check that exited nonzero. */
  items: { check: string; environmental: boolean; note: string }[];
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked: how stale the docs were, what was fixed, what remains. */
  conclusion: string;
  /** Every finding that reached the plan, with its tier, commit group, and confirmation status. */
  findings: PlanFinding[];
  /** The severity x file-count table the work was scoped against. */
  planTable: string;
  /** The decisions in force, each marked user / skill default / assumed. */
  decisions: string[];
  /** One line per executed commit group: what landed and its hash, or why execution stopped. */
  commits: string[];
  /** What the run checked and how: the commands it ran, the files it covered, the greps that came back clean. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ---------------------------------------------------------------------------
// Fixed procedure constants — the five atomic commits from SKILL.md Phase 4's table
// ---------------------------------------------------------------------------

const SKILL = "/Users/alejandrodelvillar/.agents/skills/documentation-staleness-audit";

const COMMIT_GROUPS: { id: number; scope: string }[] = [
  { id: 1, scope: "STATE-SNAPSHOT refresh plus the root AGENTS.md/CLAUDE.md stale-bullet fix" },
  { id: 2, scope: "Design-system or other foundational doc rewrite" },
  { id: 3, scope: "Secrets hygiene: hostname placeholders plus the CLAUDE.local.md env-var table" },
  { id: 4, scope: "Environment and sweep corrections (decommissioned things documented as active)" },
  { id: 5, scope: "Remaining stale doc fixes, missing feature docs, and any historical banners the user approved" },
];

// Cost bounds for the fan-out. Each flagged doc costs one auditor plus one confirmer per
// finding, so an unbounded tree (or one auditor hallucinating fifty findings) is an unbounded
// bill. Docs past MAX_DEEP_AUDITS are not audited at all — disclosed in the report, never
// silently skipped; findings past MAX_CONFIRMATIONS_PER_DOC reach the plan as auditor-only,
// clearly labelled as never independently confirmed.
const MAX_DEEP_AUDITS = 40;
const MAX_CONFIRMATIONS_PER_DOC = 25;

function guessKind(p: string): string {
  const lower = p.toLowerCase();
  if (/(^|\/)(archive|plans|recaps|postmortems|retros)\//.test(lower) || /(^|\/)(session[-_])?recap/.test(lower)) {
    return "historical";
  }
  if (/^(agents|claude|deployments?|functional-specifications?|readme)\.md$/.test(lower)) {
    return "current";
  }
  return "unknown";
}

function tail(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n").slice(0, 600);
}

// One dashboard row per audited file, updated as the run makes up its mind about it.
artifact.table("audit-progress", {
  title: "Docs audited",
  key: "path",
  columns: [
    { field: "path", label: "Doc" },
    { field: "status", label: "Status" },
    { field: "tier", label: "Severity" },
  ],
});

// Disclosed shortfalls from every later stage, in one list the report publishes verbatim.
// Declared before Phase 1 because the inventory cap below is the first thing that can trip.
const executionNotes: string[] = [];

// ---------------------------------------------------------------------------
// Steps 1-2: inventory + git-log recency, both deterministic
// ---------------------------------------------------------------------------

phase("Take stock of every doc and check when each was last touched");

// A glob over-runs its cap by REJECTING rather than truncating; the run must not die on an
// enormous docs tree, so a failed glob is disclosed as a gap instead.
const globGaps: string[] = [];
const found = await Promise.all([
  files.glob("*.md").catch(() => {
    globGaps.push("the root-level *.md glob overran the file cap; only the docs tree was inventoried");
    return [];
  }),
  files.glob("docs/**/*.md").catch(() => {
    globGaps.push("the docs/**/*.md glob overran the file cap; the inventory is incomplete");
    return [];
  }),
]);
// The recency check is one journaled `git log` world.run per file, so the inventory itself is
// capped the same way the agent fan-out is: a 2000-file glob must not become 2000 git
// invocations in one Promise.all. Files past the cap are disclosed, not silently dropped.
const INVENTORY_CAP = 500;
const docPathsAll = [...new Set(found.flat())].sort();
const docPaths = docPathsAll.slice(0, INVENTORY_CAP);
if (docPathsAll.length > docPaths.length) {
  executionNotes.push(
    `inventory capped at ${INVENTORY_CAP} files; not inventoried this run (no recency check, no audit): ${docPathsAll.slice(INVENTORY_CAP).join(", ")}`,
  );
}
log(`${docPaths.length} markdown files inventoried`);

// SKILL.md Phase 1 step 2: git log per file, never mtime ("a doc touched a week ago may have
// had only a typo fix while the content is 6 months stale"). A fixed, machine-checkable
// command per doc — run as code, not trusted as a claim.
const docs: DocRecord[] = await Promise.all(
  docPaths.map(async (p): Promise<DocRecord> => {
    let lastTouched: string | null = null;
    let lastSubject = "";
    try {
      const rec = await world.run("git", ["log", "-1", "--format=%aI|%s", "--", p]);
      const out = rec.stdout.trim();
      if (rec.exitCode === 0 && out.length > 0 && out.includes("|")) {
        const bar = out.indexOf("|");
        lastTouched = out.slice(0, bar);
        lastSubject = out.slice(bar + 1);
      }
    } catch {
      // git unreadable for this path: keep the doc in scope with a null date.
    }
    return { path: p, lastTouched, lastSubject, kindGuess: guessKind(p) };
  }),
);

const historicalDocs = docs.filter((d) => d.kindGuess === "historical");
const liveDocs = docs.filter((d) => d.kindGuess !== "historical");
log(
  `${liveDocs.length} current docs, ${historicalDocs.length} historical (recaps/plans/archives — SKILL.md scope default: not touched as current state)`,
);

// ---------------------------------------------------------------------------
// Steps 3-4: the gap window, red flags, deprecated terms, secret shapes
// ---------------------------------------------------------------------------

phase("Find what changed since the docs were last reviewed");

const recentCommits = await git.log(100);
const recencyLines = liveDocs
  .map((d) => `${d.path} — ${d.lastTouched ?? "never committed"} — ${d.lastSubject}`)
  .join("\n");

const changeWindow = await agent("Change-window analyst", {
  system:
    `You are auditing a repository's documentation for staleness. Read ${SKILL}/SKILL.md fully — ` +
    "especially the Quick start and Phase 1 steps 3 and 4 — and references/audit-checklist.md " +
    "sections 3, 4, and 5, then run the commands they name with your own tools. " +
    "Deprecated terms are project-specific: derive them from the gap-window commits, the code, and " +
    "the pitfall list in SKILL.md (decommissioned environments, migrated libraries, dropped tables, " +
    "renamed routes, design-system classes the build silently purges). " +
    "Never invent a term you could not ground in a commit or in the code. If a command cannot run, " +
    "say so plainly in notCovered rather than guessing around it.",
}).ask<ChangeWindow>(
  `The doc inventory and each current doc's last-commit date:\n${recencyLines}\n` +
    `The last ${recentCommits.length} commits (newest first):\n${JSON.stringify(recentCommits)}\n\n` +
    "Determine, per SKILL.md Phase 1 steps 3-4: (1) gapStart — the calendar date documentation " +
    "last got attention, as a date-only ISO string (YYYY-MM-DD, no time component); (2) undocumentedChanges — architecture or foundational files that changed in the " +
    "window with no matching doc update; (3) staleTerms — regex-compatible patterns for deprecated " +
    "things still documented as current, each with why it is deprecated; (4) secretPatterns — regex " +
    "shapes like the ones in checklist section 5 (proxy hostnames, key prefixes) that must not sit " +
    "in committed docs. Keep each regex narrow: the grep rejects rather than truncating when a " +
    "pattern overruns its cap, so a pattern that would match thousands of lines is worse than none.",
);

let gapStart = changeWindow.gapStart;
if (!gapStart) {
  const dated = docs
    .map((d) => d.lastTouched)
    .filter((t): t is string => t !== null)
    .sort();
  gapStart = dated.length > 0 ? dated[0] : "1970-01-01";
  log(`analyst returned no gapStart; falling back to the oldest doc date ${gapStart}`);
}

// Step 4, executed deterministically: one grep per deprecated term and secret shape over the
// docs tree and the root docs — the checklist sections 4-5 command set. The terms come from an
// LLM, so each is compile-checked here first: a term that is not a valid regex is searched as a
// literal string rather than silently disabling that category of detection. An over-cap
// rejection falls back to a word-bounded retry; if that fails too, the term is disclosed, not
// skipped. Gap notes are deduplicated: this helper runs three times against one shared array.
function searchPattern(term: string, gaps: string[]): string {
  try {
    new RegExp(term);
    return term;
  } catch {
    const note = `"${term}" is not a valid regex; it was searched as a literal string instead — the analyst should phrase such terms with escaped syntax`;
    if (!gaps.includes(note)) gaps.push(note);
    return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

function addGap(gaps: string[], note: string): void {
  if (!gaps.includes(note)) gaps.push(note);
}

async function grepAll(patterns: { term: string; why: string }[], gaps: string[]): Promise<Map<string, HitLine[]>> {
  const hitsByPath = new Map<string, HitLine[]>();
  for (const entry of patterns) {
    const term = searchPattern(entry.term, gaps);
    let matches: HitLine[] = [];
    try {
      matches = (await files.grep(term, "docs/**/*.md")).concat(await files.grep(term, "*.md"));
    } catch {
      try {
        matches = (await files.grep(`\\b(?:${term})\\b`, "docs/**/*.md")).concat(
          await files.grep(`\\b(?:${term})\\b`, "*.md"),
        );
      } catch {
        addGap(gaps, `the grep for "${entry.term}" (${entry.why}) exceeded the search cap twice; auditors were told to catch it by reading`);
      }
    }
    for (const m of matches) {
      const prior = hitsByPath.get(m.path);
      if (prior) prior.push(m);
      else hitsByPath.set(m.path, [m]);
    }
  }
  return hitsByPath;
}

const grepGaps: string[] = [...globGaps, ...changeWindow.notCovered];
const patterns = [
  ...changeWindow.staleTerms.map((t) => ({ term: t.term, why: t.whyDeprecated })),
  ...changeWindow.secretPatterns.map((s) => ({ term: s.regex, why: s.label })),
];
const hitsByPath = await grepAll(patterns, grepGaps);
log(
  `${changeWindow.staleTerms.length} deprecated terms and ${changeWindow.secretPatterns.length} secret patterns grepped; hits in ${hitsByPath.size} files`,
);

// ---------------------------------------------------------------------------
// Deep audit: one fresh auditor per flagged doc, confirmers chained, one shared scale
// ---------------------------------------------------------------------------

phase("Audit each flagged doc and confirm its findings as they land");

const audited = new Set<string>();
// The per-file recency comes from `git log --format=%aI` (full ISO timestamp); the analyst's
// gapStart may be date-only or a full timestamp. Compare on the date component alone so a
// format mismatch can never shift a doc across the staleness line.
const dayOf = (t: string) => t.slice(0, 10);
const gapDay = dayOf(gapStart);
for (const d of liveDocs) {
  const staleByDate = d.lastTouched === null || dayOf(d.lastTouched) < gapDay;
  if (staleByDate || hitsByPath.has(d.path)) audited.add(d.path);
}
// Historical docs are NOT deep-audited (SKILL.md scope default): their hits go to the planner
// as banner candidates, and the user decides per SKILL.md Phase 3.
const historicalHits = historicalDocs
  .filter((d) => hitsByPath.has(d.path))
  .map((d) => ({ path: d.path, sample: (hitsByPath.get(d.path) ?? []).slice(0, 5) }));

// Cost cap at the fan-out: one auditor plus up to MAX_CONFIRMATIONS_PER_DOC confirmers per
// doc. A flagged tree of dozens of files would otherwise spawn hundreds of subagent sessions
// with no ceiling. Docs past the cap are disclosed in the report, never silently dropped —
// the deprecated-term grep still covered every file, so what is lost is the deep read.
const allAuditPaths = [...audited].sort();
const auditPaths = allAuditPaths.slice(0, MAX_DEEP_AUDITS);
if (allAuditPaths.length > auditPaths.length) {
  const dropped = allAuditPaths.slice(MAX_DEEP_AUDITS);
  log(`cost cap: ${dropped.length} flagged doc(s) past ${MAX_DEEP_AUDITS} were not deep-audited this run`);
  executionNotes.push(`deep-audit capped at ${MAX_DEEP_AUDITS} docs; not deep-audited this run: ${dropped.join(", ")}`);
}
log(`auditing ${auditPaths.length} flagged docs, a fresh auditor per file, up to ${MAX_CONFIRMATIONS_PER_DOC} confirmations each`);

// One shared, calibrated triage: P0-P3 only means the same thing twice if it is judged on one
// scale across all files (SKILL.md Phase 2). It is a queue, not a barrier — each file's
// findings reach it the moment their confirmer lands.
const severityScale = agent("Severity triage", {
  system:
    `You grade documentation findings on the P0-P3 scale defined in Phase 2 of ${SKILL}/SKILL.md, ` +
    "consistently across every finding you see: P0 actively misleading, P1 operationally confusing, " +
    "P2 noticeably stale, P3 hygiene. A design-doc class recommendation that the build silently " +
    "purges is P0 — it actively misleads contributors into shipping invisible UI.",
});

const confirmedFindings: ConfirmedFinding[] = (
  await Promise.all(
    auditPaths.map(async (p): Promise<ConfirmedFinding[]> => {
      const record = docs.find((d) => d.path === p);
      const recordLine = record
        ? `${record.path} — last touched ${record.lastTouched ?? "never committed"} — "${record.lastSubject}"`
        : p;
      const hitLines = (hitsByPath.get(p) ?? []).map((h) => `${h.line}: ${h.text}`).join("\n");
      try {
        const audit = await agent(`Doc auditor: ${p}`, {
          system:
            `You audit one markdown document for staleness against the CODE, never against other docs. ` +
            `Read ${SKILL}/SKILL.md (the 5-phase methodology and the Pitfalls list) and ` +
            `${SKILL}/references/code-source-of-truth.md first — they define the claim-to-truth mapping ` +
            "(pricing lives in the payment client, gating lives in the middleware, counts live in the DB " +
            "or the drift scripts, class recommendations must be cross-checked against the Tailwind " +
            "config and actual grep counts in the app source). You may read and run commands, but you " +
            "must not edit any file. Cite path:line evidence for every finding and report only what you " +
            "actually verified. If a check you need cannot run here, do not fake it: leave the finding " +
            "out, or escalate the blocked question.",
        }).ask<AuditResult>(
          `Audit ${p} for documentation staleness.\nIts recency line: ${recordLine}\n` +
            `The script grep already found these deprecated-term / secret hits in it:\n${hitLines || "(none — audit by reading)"}\n` +
            `Red flags from the gap window (code that changed with no doc update): ${JSON.stringify(changeWindow.undocumentedChanges)}\n` +
            `Deprecated terms discovered for this repo: ${JSON.stringify(changeWindow.staleTerms)}\n\n` +
            "Read the whole doc. For each claim it makes that the code contradicts, produce a finding " +
            "naming where the truth lives. Also list what the doc fails to say but should (a missing " +
            "feature doc counts as a finding). Check whether the last touch was substantive or cosmetic " +
            "— SKILL.md pitfall: a typo fix masks months of stale content. Every finding you return " +
            "costs an independent confirmation downstream: report only the ones that would actually " +
            "mislead a reader, most severe first. If the doc turned out clean, " +
            "return findings: [].",
        );
        // Each finding goes to a fresh confirmer chained in this same callback: the auditor
        // that raised a finding does not get to confirm it.
        // Per-doc cost bound: only the first MAX_CONFIRMATIONS_PER_DOC findings are
        // independently confirmed; the rest still reach the plan, labelled auditor-only and
        // ungraded — never silently dropped.
        const toConfirm = audit.findings.slice(0, MAX_CONFIRMATIONS_PER_DOC);
        const overflow: ConfirmedFinding[] = audit.findings.slice(MAX_CONFIRMATIONS_PER_DOC).map(
          (finding): ConfirmedFinding => {
            const carried: ConfirmedFinding = {
              ...finding,
              status: "unconfirmed",
              confirmNote: `carried past the per-doc confirmation cap; reported by the auditor, never independently checked this run`,
              triageTier: "ungraded",
            };
            report({ path: carried.where, status: carried.status, tier: carried.triageTier }, "audit-progress");
            return carried;
          },
        );
        if (overflow.length > 0) {
          log(`${p}: ${overflow.length} finding(s) past the confirmation cap carried unconfirmed/ungraded`);
        }
        const checked: ConfirmedFinding[] = await Promise.all(
          toConfirm.map(async (finding, index): Promise<ConfirmedFinding> => {
            const check = await agent(`Finding confirmer: ${p} #${index + 1}`, {
              system:
                `You independently reproduce documentation-staleness findings from their evidence ` +
                `alone. Read ${SKILL}/references/code-source-of-truth.md so you check claims against ` +
                "code and config, not against other docs. Never edit any file. If you cannot reproduce " +
                "it, say so plainly — do not give the finding the benefit of the doubt.",
            }).ask<Confirmation>(
              `Reproduce or refute this finding about ${finding.where}:\n${JSON.stringify(finding)}\n` +
                "Open the doc and its truth location yourself; quote what each side says.",
            );
            const tier = await severityScale.ask<TierCall>(
              `Grade this finding on the P0-P3 scale you were given:\n${JSON.stringify(finding)}\n` +
                `Confirmer: ${check.reproduced ? "reproduced" : "could not reproduce"} — ${check.note}`,
            );
            const reported: ConfirmedFinding = {
              ...finding,
              status: check.reproduced ? "verified" : "unconfirmed",
              confirmNote: check.note,
              triageTier: tier.tier,
            };
            report({ path: reported.where, status: reported.status, tier: reported.triageTier }, "audit-progress");
            return reported;
          }),
        );
        return [...checked, ...overflow];
      } catch (error) {
        log(`the auditor for ${p} failed: ${String(error)}`);
        report({ path: p, status: "audit-failed", tier: "n/a" }, "audit-progress");
        return [];
      }
    }),
  )
).flat();

log(
  `${confirmedFindings.length} findings from the audit; ${confirmedFindings.filter((f) => f.status === "verified").length} independently reproduced`,
);

// ---------------------------------------------------------------------------
// Step 5: classify once, on one scale, into the five commit groups
// ---------------------------------------------------------------------------

phase("Grade the findings and lay out the commit plan");

if (confirmedFindings.length === 0) {
  const clean: WorkflowReport = {
    conclusion: `The audit found no material staleness: ${auditPaths.length} flagged docs were read against the code and produced nothing worth fixing, and the deprecated-term grep had no unjustified hits on current docs.`,
    findings: [],
    planTable: "| tier | files |\n|---|---|\n| none | 0 |",
    decisions: [],
    commits: [],
    verified: [
      `inventoried ${docPaths.length} markdown files with per-file git log`,
      `grepped ${patterns.length} deprecated / secret patterns over the docs tree and root docs`,
      `deep-audited ${auditPaths.length} flagged docs against code, each by a fresh auditor with an independent confirmer per finding`,
    ],
    notCovered: [
      ...grepGaps,
      "historical docs (recaps/plans/archives) were not deep-audited, per the SKILL.md scope default",
      "live-DB entity counts — the audited environment's credentials were not held by this run",
    ],
  };
  await artifact.markdown(
    "report",
    [`# Documentation staleness audit`, "", clean.conclusion, "", "## What was checked", ...clean.verified.map((v) => `- ${v}`), "", "## Not covered", ...clean.notCovered.map((n) => `- ${n}`)].join("\n"),
    {
      title: "Documentation staleness audit report",
      description: "The audit ran clean: inventory, greps, and per-doc audits, with what they covered.",
      primary: true,
    },
  );
  return clean;
}

const classifier = agent("Severity classifier and planner", {
  system:
    `You turn confirmed doc-staleness findings into the severity audit table and the five-commit plan ` +
    `from ${SKILL}/SKILL.md (Phase 2 tier table, Phase 4 commit-group table). Read both, plus the ` +
    "Pitfalls section. Deduplicate ruthlessly: one deprecated claim restated across sibling feature " +
    "docs is one problem with several locations — the SKILL.md pitfall says a single user-reported " +
    "discrepancy routinely has 7+ copies, so grep the docs tree yourself to name every sibling. " +
    "Every finding lands in exactly one of the five groups. Mark needsDecision only for the SKILL.md " +
    "Phase 3 categories: decommissioned environments, secret handling preference, historical-doc " +
    "rewrite-vs-banner, and scope boundaries. You never edit files.",
});

let plan = await classifier.ask<AuditPlan>(
  `Findings, each already independently confirmed or labelled:\n${JSON.stringify(confirmedFindings)}\n` +
    `Historical docs carrying deprecated-term hits (scope default: untouched; banner candidate list): ${JSON.stringify(historicalHits)}\n\n` +
    "Produce the AuditPlan: every finding with its final tier (P0-P3), commit group (1-5 per the " +
    "SKILL.md Phase 4 table), confirmation status, and a one-line fix; planTable as a markdown table " +
    "of tier x file counts (SKILL.md: sketch the plan before editing so the user can scope the work); " +
    "openDecisions worded for the user; notCovered for anything you could not verify.",
);

let planCritique = "none";
for (let round = 1; round <= 3; round++) {
  phase("Review the audit plan with fresh eyes");
  // Fresh eyes every round: the name carries the round number (no two subagents in a run may
  // share a name), and a critic that has seen no earlier round is the point of the mechanism.
  const critique = await agent(`Independent plan critic (round ${round})`, {
    system:
      "You have never seen this plan before. Judge it by reading the repository — the docs it cites " +
      "and the code that is the source of truth per references/code-source-of-truth.md. Write " +
      "objections: approval costs you nothing, an overlooked P0 costs the user. You never edit files.",
  }).ask<Critique>(
    `A documentation-refresh plan produced by the ${SKILL.split("/").pop()} audit:\n${JSON.stringify(plan)}\n` +
      `Objections from the previous round, since addressed: ${planCritique}\n\n` +
      "What is mis-tiered, mis-grouped, missing a sibling copy of a shared claim, dropped, or " +
      "contradicted by the code? Would a contributor following this plan still ship something wrong?",
  );
  if (critique.sound) break;
  planCritique = critique.objections.join(" | ");
  log(`the plan critic raised ${critique.objections.length} objections in round ${round}`);
  phase("Revise the plan against the critique");
  plan = await classifier.ask<AuditPlan>(
    `A reviewer who has never seen your work raised these objections:\n${planCritique}\n` +
      "Address every objection — verify against the code, not the other docs — and re-issue the full AuditPlan.",
  );
}

// ---------------------------------------------------------------------------
// Step 6: the clarification the skill reserves for the user
// ---------------------------------------------------------------------------

phase("Get the user's call on the decisions this audit cannot make");

const decisions: Decision[] = [];
if (plan.openDecisions.length > 0) {
  // Publish every open decision to the dashboard BEFORE any escalation: an escalation blocks
  // the run until the owner answers or cancels it, and a cancelled run is salvaged from what
  // was reported. The open questions then survive the cancellation.
  for (const q of plan.openDecisions) report({ path: `decision: ${q}`, status: "awaiting-owner", tier: "n/a" }, "audit-progress");
  const broker = await agent("Decision broker", {
    system:
      `You run Phase 3 of ${SKILL}/SKILL.md: some findings need the owner's decision — decommissioned ` +
      "environments, secret handling, rewrite-vs-banner for historical docs, scope boundaries. Two ways " +
      "to resolve a question: (1) SKILL.md already carries a documented default for it (the scope " +
      'default: recaps, plans, and archives are NOT touched), then use it and mark its source "skill ' +
      'default"; (2) genuinely owner-only — no default applies — then use your escalation tool, the only ' +
      "channel to the person who owns this run. Escalation WAITS for an answer; that is its purpose, not " +
      "a failure — but it blocks, so escalate ONCE with all owner-only questions batched into a single " +
      "call, each answerable in a sentence, and never re-escalate something already asked. Only if the " +
      "escalation tool itself reports your allowance is spent (not merely because an answer is slow) " +
      "fall back to the documented default and mark it as such. Never present an assumption as an answer.",
  }).ask<DecisionSet>(
    `Open decision points from the audit plan:\n${JSON.stringify(plan.openDecisions)}\n` +
      "For each: resolve it on SKILL.md's documented default where one applies; where none does, " +
      "escalate those as one batched question. Return every decision with its question, the answer " +
      "in force, and its source.",
  );
  decisions.push(...broker.decisions);
  log(
    `${decisions.length} decisions in force: ${decisions.filter((d) => d.source === "user").length} from the user, ${decisions.filter((d) => d.source !== "user").length} from skill defaults`,
  );

  phase("Fold the decisions into the plan");
  plan = await classifier.ask<AuditPlan>(
    `The decisions below are now in force. Apply them: re-tier and re-group as needed, and where ` +
      `banners were approved add banner findings for the listed historical docs into group 5, using ` +
      `${SKILL}/templates/historical-banner.md as the exact template — never delete or rewrite a ` +
      "historical doc to be current.\n" +
      `Decisions: ${JSON.stringify(decisions)}`,
  );
} else {
  log("no open decision points; execution proceeds on the plan as graded");
}

// ---------------------------------------------------------------------------
// Step 7: phase-per-commit execution — strictly sequential, the skill's own rule
// ("Don't run Phase N+1 before Phase N is committed and verified")
// ---------------------------------------------------------------------------

const executed: { group: number; summary: string; hash: string }[] = [];
let halted = false;

phase("Execute the doc fixes one commit group at a time");
for (let g = 0; g < COMMIT_GROUPS.length; g++) {
  const group = COMMIT_GROUPS[g];
  const work = plan.findings.filter((f) => f.group === group.id);
  if (work.length === 0) continue;
  if (halted) {
    executionNotes.push(`commit group ${group.id} (${group.scope}) did not run: an earlier group failed review`);
    continue;
  }

  const editor = agent(`Doc editor for commit group ${group.id}`, {
    system:
      `You execute exactly one commit group of the documentation refresh from ${SKILL}/SKILL.md ` +
      "(Phase 4 and the pattern sections). Read SKILL.md fully, plus references/audit-checklist.md " +
      "sections 5, 6, and 8. Hard rules from the skill: one atomic commit per group, message " +
      "'docs: <what changed>' with the phase description in the body; never mix secrets-hygiene edits " +
      "into other groups; replace raw hostnames/secrets with descriptive env-var placeholders and put " +
      "real values only in CLAUDE.local.md (gitignored), with the wildcard note; banner historical " +
      "docs with the exact template in templates/historical-banner.md — never delete them or rewrite " +
      "them to be current; before marking any plan status complete, run checklist section 8's " +
      "cross-check against git log and the live data — a verbal or written claim is not evidence; " +
      "verify every fixed claim against CODE (references/code-source-of-truth.md), then grep the whole " +
      "docs tree for the same stale term and fix EVERY sibling copy inside this same commit, and " +
      "re-grep after editing to prove no unjustified hits remain. Return the real full commit hash " +
      "from git, never an invented one. Never echo secret values into your result text. If something " +
      "cannot be done honestly, defer it and say so, or escalate the blocked question — do not fake a " +
      "commit or an edit.",
  });
  const groupReviewer = agent(`Commit reviewer for group ${group.id}`, {
    system:
      `You independently review one finished commit group of the ${SKILL.split("/").pop()} run. Run git ` +
      'yourself: confirm the commit exists, its message follows "docs: <what changed>", and it touches ' +
      "only this group's files. Re-read the edited docs and verify each fixed claim against the code " +
      "truth (references/code-source-of-truth.md). Re-grep each fixed stale term and confirm no " +
      "unjustified hit remains outside historical docs. You never edit files, and an approval without " +
      "evidence is a failure.",
  });

  let review: GroupReview = { passed: false, problems: ["not reviewed yet"] };
  let fix: GroupFix | undefined;
  for (let round = 1; round <= 3; round++) {
    phase("Apply one group's doc fixes and commit them");
    if (round === 1) {
      fix = await editor.ask<GroupFix>(
        `Commit group ${group.id} of ${COMMIT_GROUPS.length}: ${group.scope}.\nFindings to fix (each carries where, what, ` +
          `evidence, truth location, and confirmation status):\n${JSON.stringify(work)}\n` +
          `Decisions in force for this run: ${JSON.stringify(decisions)}\n` +
          "Edit the docs, re-grep to prove the stale terms are gone from current docs, make exactly " +
          "one commit for this group, and report its full hash.",
      );
    } else {
      fix = await editor.ask<GroupFix>(
        `The reviewer rejected commit group ${group.id}. Problems:\n${review.problems.join("\n")}\n` +
          "Fix exactly these, amend or add one commit for this group only, and report the current full hash.",
      );
    }
    phase("Review that group's commit before the next group starts");
    const filesLine = fix ? fix.filesChanged.join(", ") : "none reported";
    const hashLine = fix ? fix.commitHash : "";
    review = await groupReviewer.ask<GroupReview>(
      `Review commit group ${group.id} (${group.scope}). The editor reports commit ${hashLine || "(none)"} touching: ${filesLine}. Deferred: ${fix ? fix.deferred.join("; ") : "n/a"}`,
    );
    if (review.passed) break;
    log(`group ${group.id} rejected by its reviewer, round ${round}`);
  }

  // The editor's hash is a claim; the script checks git for the fact. SKILL.md: atomic phase
  // commits catch regressions at each step.
  const claimed = fix ? fix.commitHash : "";
  let hashLanded = false;
  if (claimed.length >= 7) {
    const tip = await git.log(15);
    hashLanded = tip.some((c) => c.hash.startsWith(claimed) || claimed.startsWith(c.hash));
  }
  if (fix) {
    executionNotes.push(...fix.notCovered.map((n) => `group ${group.id}: ${n}`));
    executionNotes.push(...fix.deferred.map((d) => `group ${group.id} deferred: ${d}`));
  }
  if (!review.passed || !hashLanded) {
    halted = true;
    executionNotes.push(
      `commit group ${group.id} (${group.scope}) ended unresolved — reviewer passed: ${review.passed}, commit visible in git: ${hashLanded}; problems: ${review.problems.join(" | ")}`,
    );
    log(`group ${group.id} unresolved; later groups will not run (SKILL.md: never run Phase N+1 before N is committed and verified)`);
  } else {
    executed.push({ group: group.id, summary: fix ? fix.summary : "", hash: claimed });
    report({ path: `commit group ${group.id}`, status: "fixed", tier: work.map((f) => f.tier).join("/") }, "audit-progress");
  }
}

// ---------------------------------------------------------------------------
// Step 8: verification — re-grep, bounded leftover loop, the repo's drift checks
// ---------------------------------------------------------------------------

phase("Confirm nothing stale is left behind");

// The SKILL.md Phase 5 close-out: run the stale-term grep again and confirm every remaining
// hit is one of the three accepted kinds. The grep is deterministic script-side work; the
// judgement of each hit is a fresh verifier per file; a leftover goes to one bounded fix
// round and a re-grep. Two rounds, then the report says what is still open. Verdicts are
// keyed by path with the latest round winning, so a file judged leftover then fixed in a
// later round cannot keep a stale verdict alive in the counts.
let currentHits = await grepAll(patterns, grepGaps);
const historicalSet = new Set(historicalDocs.map((d) => d.path));
const judgments = new Map<string, DocJudgement>();
let pendingPaths = [...currentHits.keys()].filter((p) => !historicalSet.has(p)).sort();
log(`post-fix grep: ${pendingPaths.length} current doc(s) still show deprecated or secret-shaped hits`);

for (let round = 1; round <= 2; round++) {
  if (pendingPaths.length === 0) break;
  phase("Judge each remaining stale hit against the acceptance list");
  const batch: DocJudgement[] = await Promise.all(
    pendingPaths.map((p) =>
      agent(`Doc verifier: ${p} (round ${round})`, {
        system:
          `You run the acceptance list of Phase 5 of ${SKILL}/SKILL.md. For every remaining hit in your ` +
          "file, decide: acceptable (a historical doc left untouched by the scope decision, a " +
          "decommissioned reference whose banner is present, or a legitimate wildcard/pattern rather " +
          "than a real secret) or leftover (still presented as current — a real problem). Judge against " +
          "the code and the run's decisions; read and run git yourself; never edit. A hit in a file " +
          "the editors already touched is a leftover unless the banner or placeholder is actually there.",
      }).ask<DocJudgement>(
        `Remaining grep hits in ${p}:\n${(currentHits.get(p) ?? []).map((h) => `${h.line}: ${h.text}`).join("\n")}\n` +
          `Decisions in force: ${JSON.stringify(decisions)}\nClassify each hit: acceptable or leftover.`,
      ),
    ),
  );
  for (const j of batch) judgments.set(j.path, j);
  const dirty = batch.filter((j) => j.status === "leftover");
  if (dirty.length === 0) {
    pendingPaths = [];
    break;
  }

  phase("Fix what verification still finds presented as current");
  const lateFixer = agent(`Late-fix doc editor (round ${round})`, {
    system:
      `You fix the small number of stale claims verification caught after the commit groups ran, ` +
      `following ${SKILL}/SKILL.md exactly (verify against code, env-var indirection for secrets, ` +
      "banners for historical). One commit per file-group with a 'docs: ...' message. Never invent a " +
      "hash; defer honestly what you cannot verify.",
  });
  await lateFixer.ask<GroupFix>(
    `Verification still finds these as presented-current:\n${JSON.stringify(dirty)}\n` +
      "Fix them against the code. SKILL.md pitfall: one discrepancy routinely has 7+ copies across " +
      "the doc tree — for each stale term you fix, grep the whole docs tree and fix every sibling " +
      "copy in the same commit. Then re-grep to confirm and commit.",
  );
  // Re-grep after the fixes. Back for another verdict: any current doc the grep hits whose
  // latest verdict is not "acceptable" — files still judged leftover, plus sibling copies the
  // fix itself exposed or created that no verifier has ever judged. Accepted hits are not
  // re-litigated.
  currentHits = await grepAll(patterns, grepGaps);
  pendingPaths = [...currentHits.keys()]
    .filter((p) => !historicalSet.has(p) && judgments.get(p)?.status !== "acceptable")
    .sort();
}

if (pendingPaths.length > 0) {
  executionNotes.push(`verification hit its bounded-round cap with these docs still awaiting a verdict: ${pendingPaths.join(", ")}`);
}
const stillOpen = [...judgments.values()]
  .filter((j) => j.status === "leftover" && currentHits.has(j.path))
  .map((j) => j.path)
  .sort();
if (stillOpen.length > 0) {
  executionNotes.push(`verification still finds unaccepted hits after the bounded fix loop in: ${stillOpen.join(", ")}`);
}

// The skill's Phase 5 also re-runs the repo's warmup drift checks. These belong to the audited
// repository, not the skill — each runs only when that repo actually ships it, and a nonzero
// exit is read as a value, triaged for whether it is environmental (missing credentials) or a
// real regression the report must own.
const drift: DriftResult[] = [];
for (const check of [
  { script: "scripts/detect-data-drift.sh", cmd: "bash" as const },
  { script: "scripts/detect-branch-drift.sh", cmd: "bash" as const },
  { script: "scripts/detect-schema-drift.py", cmd: "python3" as const },
]) {
  const present = await files.glob(check.script);
  if (present.length === 0) {
    executionNotes.push(`drift check skipped: this repo has no ${check.script}`);
    continue;
  }
  let res: DriftResult;
  try {
    const run =
      check.cmd === "python3"
        ? await world.run("python3", [check.script, "--cron"], { timeoutMs: 600_000 })
        : await world.run("bash", [check.script], { timeoutMs: 600_000 });
    res = { check: check.script, exitCode: run.exitCode, evidence: tail(run.stdout + "\n" + run.stderr, 6), environmental: false };
  } catch (error) {
    res = { check: check.script, exitCode: -1, evidence: `could not run: ${String(error)}`, environmental: true };
  }
  drift.push(res);
}
const failedDrift = drift.filter((d) => d.exitCode !== 0);
if (failedDrift.length > 0) {
  const triage = await agent("Drift triager", {
    system:
      `You interpret failed post-audit drift checks from ${SKILL}/SKILL.md Phase 5. Tell apart an ` +
      "environmental failure (missing credentials, no network, the check needs a live DB this run " +
      "cannot reach) from a real regression the doc refresh caused or exposed. Read the output; run " +
      "the checks again yourself if one is ambiguous. Never edit files.",
  }).ask<DriftTriage>(
    `These drift checks exited nonzero after the documentation refresh:\n${JSON.stringify(failedDrift)}\n` +
      "For each: environmental or real, and one line of why.",
  );
  for (const item of triage.items) {
    const target = drift.find((d) => d.check === item.check);
    if (target) {
      target.environmental = item.environmental;
      target.evidence += ` | triage: ${item.note}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Close out: publish the deliverable, then hand back the report
// ---------------------------------------------------------------------------

// Verdicts are already keyed by path with the latest round winning. The open/clean counts
// intersect with the post-loop grep, so a file judged leftover in round 1 that the late fix
// then cleared from the patterns cannot keep a stale verdict alive: the conclusion and the
// verification section carry the same numbers.
const finalJudgments = [...judgments.values()];
const cleanJudgments = finalJudgments.filter((j) => j.status === "acceptable" && currentHits.has(j.path));
const openJudgments = finalJudgments.filter((j) => j.status === "leftover" && currentHits.has(j.path));
const clearedJudgments = finalJudgments.filter((j) => j.status === "leftover" && !currentHits.has(j.path));
const commitLines = executed.map((e) => `commit group ${e.group}: ${e.hash} — ${e.summary}`);
const decisionLines = decisions.map((d) => `${d.question} → ${d.answer} [${d.source}]`);
const verifiedLines = [
  `inventoried ${docPaths.length} markdown files with a per-file git log -1 (run as code, not claimed)${docPathsAll.length > docPaths.length ? ` — ${docPathsAll.length} matched the globs and ${docPathsAll.length - docPaths.length} past the ${INVENTORY_CAP}-file cap got no recency check, listed in Not covered` : ""}`,
  `grepped ${patterns.length} deprecated / secret patterns over the docs tree and root docs, before the fixes and again after`,
  `${auditPaths.length} flagged docs deep-audited against code, each by a fresh auditor; findings up to ${MAX_CONFIRMATIONS_PER_DOC} per doc re-checked by an independent confirmer${allAuditPaths.length > auditPaths.length ? `; ${allAuditPaths.length - auditPaths.length} flagged doc(s) past the cost cap were not deep-audited` : ""}`,
  "the severity plan was put in front of a critic who had never seen it before any edit was made",
  ...commitLines.map((line) => `visible in git log: ${line}`),
  ...drift.map((d) => `${d.check} exited ${d.exitCode}${d.environmental ? " (environmental)" : ""} — ${d.evidence.slice(0, 200)}`),
];
const conclusion = halted
  ? `The audit graded ${plan.findings.length} findings and applied ${executed.length} of the commit groups before one failed independent review, so execution stopped there per the skill's atomic-commit rule; verification re-grep and the drift checks report what still stands.`
  : `${plan.findings.length} findings graded and fixed across ${executed.length} atomic commit groups; the post-fix grep leaves ${openJudgments.length} contested ${openJudgments.length === 1 ? "hit" : "hits"} and ${cleanJudgments.length} intentionally-kept ${cleanJudgments.length === 1 ? "one" : "ones"}.`;

await artifact.markdown(
  "report",
  [
    `# Documentation staleness audit — ${plan.findings.length} findings`,
    "",
    conclusion,
    "",
    "## Severity plan (the table the work was scoped against)",
    plan.planTable,
    "",
    "## Findings",
    ...plan.findings.map((f) => `- **${f.tier}** ${f.where} — ${f.what} [${f.status}] fix: ${f.fix}${f.siblingOf ? ` (sibling of ${f.siblingOf})` : ""}${f.needsDecision ? ` — needed a decision: ${f.needsDecision}` : ""}`),
    "",
    "## Decisions in force",
    ...(decisionLines.length > 0 ? decisionLines.map((line) => `- ${line}`) : ["- none: the plan carried no user decisions"]),
    "",
    "## Commits",
    ...(commitLines.length > 0 ? commitLines.map((line) => `- ${line}`) : ["- none landed"]),
    "",
    "## Verification",
    `- post-fix grep: ${openJudgments.length} file(s) still show unaccepted hits${clearedJudgments.length > 0 ? ` (${clearedJudgments.length} earlier leftover verdict(s) since cleared by the late fix: ${clearedJudgments.map((j) => j.path).join(", ")})` : ""}`,
    ...drift.map((d) => `- ${d.check}: exit ${d.exitCode}${d.environmental ? " — environmental" : ""}`),
    ...(cleanJudgments.length > 0 ? [`- intentionally kept: ${cleanJudgments.map((j) => j.path).join(", ")}`] : []),
    "",
    "## Not covered",
    ...[...grepGaps, ...executionNotes].map((n) => `- ${n}`),
  ].join("\n"),
  {
    title: "Documentation staleness audit report",
    description: "The severity plan, every finding with its confirmation status, the decisions, the commits, and the re-ran checks.",
    primary: true,
  },
);

const result: WorkflowReport = {
  conclusion,
  findings: plan.findings,
  planTable: plan.planTable,
  decisions: decisionLines,
  commits: commitLines,
  verified: verifiedLines,
  notCovered: [...grepGaps, ...executionNotes, "historical docs were deep-audited only for banner candidacy, not rewritten, per the SKILL.md scope default"],
};
return result;
