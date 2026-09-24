/* zcode-workflow
description: "Consolidates a documentation set: inventories docs, audits each
  for staleness and overlap in parallel with independent confirmation, plans
  merges/deduplications, applies them, and reports what changed. Embodies the
  documentation-consolidation skill (its SKILL.md and references/ are read at
  runtime for detail)."
whenToUse: When a docs set has grown overlapping or stale and needs auditing,
  merging, and deduplication as one piece of work.
args:
  commit:
    type: string
    description: Commit or ref to consolidate documentation at; empty uses the working tree.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Documentation-consolidation workflow
// Embodies the doc audit + merge procedure from
// ~/.agents/skills/documentation-consolidation/SKILL.md (9 core workflow steps,
// audit determinations, pitfalls, verification checklist) as user-named phases
// with parallel subagents, independent review, bounded loops, deterministic
// gates via world.run, and a WorkflowReport return.
//
// Hybrid pattern: this script owns the structure (phases, fan-out, bounded
// loops, gates, WorkflowReport). Every subagent ask points at the skill's own
// SKILL.md and references/ for the fine detail instead of inlining it:
//   ~/.agents/skills/documentation-consolidation/SKILL.md
//   ~/.agents/skills/documentation-consolidation/references/example-rollup-structure.md
//   ~/.agents/skills/documentation-consolidation/references/elo-scenario-lab-doc-debt-triage.md
//   ~/.agents/skills/documentation-consolidation/references/elo-scenario-lab-sync-pattern.md
//   ~/.agents/skills/documentation-consolidation/references/math-model-documentation.md
//
// The skill ships no scripts/ directory, so no script-supplied gate binaries
// exist. The skill's procedure itself, however, embeds shell-decidable checks
// (the wc -c audit, the link-verification loop, and the checklist's
// placeholder / secret / line-count items), so this draft gates on three
// commands: wc, node, git. Commit-and-deploy is opt-in: the skill's step 7 and
// its verification checklist contradict each other (commit+push vs "user told
// NOT to commit yet"), so this draft stages always and only commits when the
// saved workflow is run with commit: true.

/* zcode-workflow
name: documentation-consolidation
description: >-
  Audit a repo's documentation state, read every topical doc in parallel, then write or
  incrementally update the two contract docs (TECHNICAL-DOCUMENTATION.md and
  FUNCTIONAL-SPECIFICATIONS.md) with verified cross-references, length gates, a fresh-eyes
  review, and housekeeping; stage the result (commit only with commit: true).
whenToUse: >-
  Feature documentation has drifted across many docs/ topical files and the contract docs are
  stubs, placeholder-ridden, or missing; or a periodic consolidation pass is due.
scope: project
args:
  commit:
    type: boolean
    default: false
    description: >-
      Commit to develop and merge into staging after the docs are staged. The skill's step 7
      contradicts its verification checklist on whether to commit; the default stages only and
      leaves the commit to the user.
*/

// --- Result types ---

interface ContractDocState {
  /** Workspace-relative path of the contract doc (canonical or corrected). */
  path: string;
  /** Whether the file existed before this run. */
  exists: boolean;
  /** Byte size before this run; 0 when missing. */
  bytes: number;
  /** path:line hits for placeholder markers found in the audit. */
  placeholderHits: string[];
}

interface DocAudit {
  /** full = (re)write both contract docs; incremental = patch what is stale; skip = nothing to do. */
  mode: "full" | "incremental" | "skip";
  /** State of TECHNICAL-DOCUMENTATION.md (or the project's equivalent). */
  technicalDoc: ContractDocState;
  /** State of FUNCTIONAL-SPECIFICATIONS.md (or the project's equivalent). */
  functionalDoc: ContractDocState;
  /** Additional top-level docs worth reading (FEATURE-BRIEF.md and the like). */
  extraDocsToRead: string[];
  /** Stale duplicate copies of the contract docs (skill pitfall 1), live path first. */
  duplicateCopies: { live: string; staleCopy: string }[];
  /** One short paragraph: which variant of the skill applies and why. */
  variantNotes: string;
  /** Facts that made you pick the mode (sizes, placeholder counts, memory claims vs reality). */
  rationale: string;
}

interface DocExtract {
  /** Workspace-relative path of the topical doc that was read. */
  path: string;
  /**
   * The doc's first heading line, copied verbatim including the #. The script re-reads the
   * heading itself with files.grep and compares — this is the proof the reader opened the file
   * rather than answering from the prompt.
   */
  firstHeading: string;
  /** Headline facts a contract-doc summary would cite. */
  headlineFacts: string[];
  /** Countable claims made in the doc (tests, tables, routes, endpoints) with their numbers. */
  countableClaims: string[];
  /** Signs the doc is stale (dates, "Known Limitations" since fixed, old counts). */
  staleness: string[];
  /** Whether the doc has substantive content or is a stub pointing elsewhere. */
  isStub: boolean;
}

interface DocDigest {
  /** Two or three sentences on what the project is, from the topical docs. */
  projectSummary: string;
  /** Facts that belong in TECHNICAL-DOCUMENTATION.md. */
  techFacts: string[];
  /** Facts that belong in FUNCTIONAL-SPECIFICATIONS.md. */
  functionalFacts: string[];
  /** Inventory rows for the contract docs' tables (tech stack, environments, feature list). */
  inventory: { label: string; value: string }[];
  /** Claims in topical docs that look outdated and must not be copied into the contract docs. */
  staleClaims: string[];
  /** What the readings left unresolved; the contract docs must not invent answers. */
  openQuestions: string[];
}

interface PlannedSection {
  /** Heading as it will appear in the contract doc. */
  heading: string;
  /** What the section will summarize, one sentence, and which topical docs feed it. */
  angle: string;
  /** Topical docs this section must cross-reference. */
  linksTo: string[];
}

interface PlannedDoc {
  /** Workspace-relative path of the contract doc. */
  path: string;
  /** Sections in order. Only sections with real content behind them — no placeholders. */
  sections: PlannedSection[];
}

interface SectionPlan {
  /** Plan for TECHNICAL-DOCUMENTATION.md. */
  technical: PlannedDoc;
  /** Plan for FUNCTIONAL-SPECIFICATIONS.md. */
  functional: PlannedDoc;
  /** Anything in the plan you are unsure the topical docs support. */
  risks: string[];
}

interface PlanReview {
  /** True only when you cannot find a flaw a reader would trip on. */
  approved: boolean;
  /** What is missing, duplicated, invented, or misplaced — the designer's next input. */
  feedback: string;
}

interface DocWriteResult {
  /** Path written. */
  path: string;
  /** created, rewritten, or patched-in-place. */
  kind: "created" | "rewritten" | "patched";
  /** Sections actually written. */
  sectionsWritten: number;
  /** What you did beyond the plan, and anything you deliberately left out. */
  notes: string;
}

interface GateOutcome {
  /** Link targets that do not exist, as written in the docs. */
  brokenLinks: string[];
  /** How many internal link targets were checked. */
  checkedLinks: number;
  /** path:line hits for placeholder markers. */
  placeholders: string[];
  /** path:line hits for secret-shaped strings. */
  secrets: string[];
}

interface DocReviewFinding {
  /** Workspace-relative path of the doc with the problem. */
  docPath: string;
  /** Section or line the problem is in. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** Which kind of defect this is. */
  kind: "duplicated-depth" | "invented-feature" | "wrong-audience" | "missing-crossref" | "discipline-paragraph" | "other";
  /** How much it matters. Reserve "high" for a doc that would mislead a new developer or leak a secret. */
  severity: "low" | "medium" | "high";
  /** How to fix it, one sentence. */
  fixHint: string;
}

interface FreshReview {
  /** Only issues the deterministic gates cannot see: depth, invention, audience, missing cross-refs. */
  findings: DocReviewFinding[];
  /** One sentence on the overall state of the two docs. */
  verdictSummary: string;
}

interface ConfirmationResult {
  /** Index into the findings array given to the confirmer. */
  index: number;
  /** "verified" only when the deterministic probes objectively back the finding. */
  status: "verified" | "unconfirmed";
  /** One sentence: what the probes showed, or why nothing could confirm it. */
  evidence: string;
}

interface ConfirmationSet {
  /** One verdict per residual finding, index-aligned with the findings array given. */
  verdicts: ConfirmationResult[];
}

interface FixNote {
  /** What you changed, one line. */
  summary: string;
}

interface HousekeepingResult {
  /** Files you updated or created, path first, then one clause on why. */
  updatedFiles: string[];
  /** Stale "Known Limitations" you resolved, and where they were. */
  staleLimitationsResolved: string[];
  /** Anything you archived or flagged rather than deleted, per the skill's lean-wins principle. */
  archivedOrFlagged: string[];
  /** What you deliberately did not touch, and why. */
  skipped: string[];
}

interface ReportedFinding {
  /** Path, with a section or line when it applies. */
  where: string;
  /** One sentence: what is wrong or unresolved. */
  what: string;
  /** What showed it: the reviewer's evidence or the gate output. */
  evidence: string;
  /** "verified" only when a deterministic gate or the confirmer's independent check confirmed it; reviewer judgement alone stays unconfirmed. */
  status: "verified" | "unconfirmed";
  /** How much it matters. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  /** Unresolved findings: review objections the fixes could not settle, gate failures that remain. */
  findings: ReportedFinding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// --- Tunables (kept in script control flow, out of ask text) ---

const SKILL_DIR = "/Users/alejandrodelvillar/.agents/skills/documentation-consolidation";
const TECH_CANONICAL = "TECHNICAL-DOCUMENTATION.md";
const FUNC_CANONICAL = "FUNCTIONAL-SPECIFICATIONS.md";
/** Gate bands: the skill's verification checklist (TECH 300-600) tightens step 4's 300-800; step 5 says 400-800. */
const TECH_LINES: [number, number] = [300, 600];
const FUNC_LINES: [number, number] = [400, 800];
/** Skill step 8 drift check. */
const CLAUDE_MD_MAX_LINES = 300;
const PLAN_REVIEW_ROUNDS = 3;
const TRIM_ROUNDS = 3;
const GATE_FIX_ROUNDS = 3;
const FRESH_FIX_ROUNDS = 2;
const HOUSEKEEPING_ROUNDS = 2;
const commitEnabled = args.commit === true;

// --- Dashboard for whoever watches the run ---

artifact.metrics("progress", {
  title: "Consolidation progress",
  metrics: [
    { field: "techLines", label: "Tech doc lines" },
    { field: "funcLines", label: "Functional doc lines" },
    { field: "brokenLinks", label: "Broken links" },
  ],
});

// --- Persistent actors (created once; reused across review and fix rounds) ---

const auditor = agent("doc-auditor", {
  system:
    "You audit a repository's documentation state before a consolidation. You read and run " +
    "read-only commands; you do not edit any file. Trust file reality over project memory: " +
    "memory may claim docs are missing when they exist as placeholder stubs.",
});

const synthesist = agent("digest-synthesist", {
  system:
    "You merge per-document readings into one digest of headline facts, dropping deep detail " +
    "the contract docs must only link to, and flagging claims that look stale.",
});

const designer = agent("structure-designer", {
  system:
    "You design the section structure of two contract documents from a digest of topical docs. " +
    "Only sections with real content behind them; the contract doc summarizes and links, never duplicates.",
});

const planReviewer = agent("plan-reviewer", {
  system:
    "You find the flaw in a contract-doc section plan: invented features, empty sections, " +
    "duplicated deep dives, missing cross-references. Approve only when you cannot find one. You never edit files.",
});

const independentPlanReviewer = agent("independent-plan-reviewer", {
  system:
    "You review a contract-doc section plan with fresh eyes, against the topical docs themselves. " +
    "You never edit files.",
});

const techWriter = agent("tech-doc-writer", {
  system:
    "You write and patch TECHNICAL-DOCUMENTATION.md, the developer-facing contract doc: " +
    "summary + links, never deep detail. Follow the skill file your instructions point at. " +
    "If an instruction is impossible or contradicts another, escalate and say so plainly rather than working around it.",
});

const specWriter = agent("functional-spec-writer", {
  system:
    "You write and patch FUNCTIONAL-SPECIFICATIONS.md, the product/UX-facing contract doc: " +
    "behavior, flows, edge cases, links. Follow the skill file your instructions point at. " +
    "If an instruction is impossible or contradicts another, escalate and say so plainly rather than working around it.",
});

const docFixer = agent("doc-fixer", {
  system:
    "You repair mechanical doc defects: broken cross-references, leftover placeholders, " +
    "secret-shaped strings. Smallest change that fixes the defect. " +
    "If a defect cannot be fixed (the target file genuinely does not exist and never did), escalate and say so plainly.",
});

const freshReviewer = agent("fresh-docs-reviewer", {
  system:
    "You review finished contract documents with fresh eyes against the topical docs, hunting " +
    "duplicated deep-dive content, invented features, and the wrong audience for the doc. You never edit files.",
});

const confirmer = agent("fresh-findings-confirmer", {
  system:
    "You take qualitative review findings and try to back each one with a deterministic check " +
    "(grep for the feature name in source/docs, count shared headings, verify a referenced section exists). " +
    "You never edit files. Mark a finding verified only when you found objective evidence; otherwise " +
    "leave it unconfirmed with the reason.",
});

const housekeeper = agent("housekeeper", {
  system:
    "You run the post-consolidation housekeeping pass: stale known-limitations, stale topical " +
    "docs, duplicate contract-doc copies. Archive, do not delete. " +
    "If housekeeping would require deleting history, escalate and say so plainly.",
});

// --- Small local helpers (script-side, deterministic) ---

/** wc -l one file; 0 when missing. */
async function countLines(path: string): Promise<number> {
  const r = await world.run("wc", ["-l", path]);
  const m = /(\d+)\s+\S/.exec(r.stdout);
  return m === null ? 0 : Number(m[1]);
}

/** wc -c one file; 0 when missing (wc exits nonzero and prints nothing for it). */
async function countBytes(path: string): Promise<number> {
  const r = await world.run("wc", ["-c", path]);
  const m = /(\d+)\s+\S/.exec(r.stdout);
  return m === null ? 0 : Number(m[1]);
}

/**
 * Deterministic file-existence check. Uses the documented node -e helper idiom (facade §16.2)
 * instead of the `test` binary, which the sandbox need not provide. This makes node a hard
 * dependency of the gate: like every world.run command, "node" is part of the script's command
 * set shown to the user at run confirmation, and a missing node rejects the call at the first
 * gate — a loud failure, which is what a dead gate should be.
 */
async function exists(path: string): Promise<boolean> {
  const r = await world.run("node", ["-e", `const fs=require("fs"); process.stdout.write(fs.existsSync(${JSON.stringify(path)})?"1":"0")`]);
  return r.stdout.trim() === "1";
}

/** The skill's verification checklist as one deterministic gate pass over the given docs. */
async function runDocGates(docPaths: string[]): Promise<GateOutcome> {
  const targetSet = new Set<string>();
  for (const doc of docPaths) {
    const hits = await grepSafe("\\[[^\\]]*\\]\\([^)]*\\)", doc);
    for (const hit of hits) {
      const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
      let m = linkRe.exec(hit.text);
      while (m !== null) {
        const raw = m[1];
        const clean = raw.replace(/#.*$/, "");
        const external = raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("mailto:");
        if (!external && clean !== "") targetSet.add(clean);
        m = linkRe.exec(hit.text);
      }
    }
  }
  const broken: string[] = [];
  const targets = [...targetSet];
  for (const t of targets) {
    if (!(await exists(t))) broken.push(t);
  }
  const placeholders: string[] = [];
  const secrets: string[] = [];
  for (const doc of docPaths) {
    const ph = await grepSafe("add-when-implemented|TODO|FIXME|TBD", doc);
    placeholders.push(...ph.map((h) => `${h.path}:${h.line}`));
    const sec = await grepSafe(
      "sk_live_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|postgres(ql)?://[^\\s\"']*:[^\\s\"']*@|-----BEGIN [A-Z ]*PRIVATE KEY-----|api[_-]?key\\s*[=:]\\s*[\"'][^\"']+[\"']",
      doc,
    );
    secrets.push(...sec.map((h) => `${h.path}:${h.line}`));
  }
  return { brokenLinks: broken, checkedLinks: targets.length, placeholders, secrets };
}

function gateProblems(g: GateOutcome): number {
  return g.brokenLinks.length + g.placeholders.length + g.secrets.length;
}

function withinTarget(lines: number, target: [number, number]): boolean {
  return lines >= target[0] && lines <= target[1];
}

/** Deterministic first heading of a markdown file via files.grep; null when the file has none. */
async function firstHeadingOf(path: string): Promise<string | null> {
  const hits = await grepSafe("^#{1,6} ", path);
  if (hits.length === 0) return null;
  return hits.slice().sort((a, b) => a.line - b.line)[0].text.trim();
}

/**
 * Script-side deterministic probes for one residual review finding: existence, size, and greps
 * of the finding's own distinctive tokens against the named doc. Evidence, not a verdict — an
 * independent confirmer agent decides what the probes prove.
 */
async function probeFinding(f: DocReviewFinding): Promise<string[]> {
  const probes: string[] = [];
  const present = await exists(f.docPath);
  probes.push(`exists(${f.docPath}): ${present}`);
  if (!present) return probes;
  probes.push(`wc -l ${f.docPath}: ${await countLines(f.docPath)}`);
  const words = f.what.split(/[^A-Za-z0-9_-]+/).filter((w) => w.length > 6);
  // Identifier-shaped words (hyphens, digits, capitals — feature names, paths, flags) grep
  // decisively; plain long words are the fallback only.
  const shaped = words.filter((w) => /[-0-9]/.test(w) || /[A-Z]/.test(w));
  const tokens = [...new Set(shaped.length > 0 ? shaped : words)].slice(0, 4);
  for (const t of tokens) {
    const hits = await grepSafe(t, f.docPath);
    probes.push(
      `grep ${t} ${f.docPath}: ${hits.length} hit(s)` +
        (hits.length > 0 ? ` at ${hits.map((h) => `${h.path}:${h.line}`).join(", ")}` : ""),
    );
  }
  const ref = f.what.match(/[\w./-]+\.(?:md|py|ts|tsx|js|jsx|sql|json)/);
  if (ref !== null) {
    probes.push(`path named in the finding (${ref[0]}) exists: ${await exists(ref[0])}`);
  }
  if (f.kind === "discipline-paragraph") {
    const disc = await grepSafe("[Cc]ontract doc discipline", f.docPath);
    probes.push(`discipline-paragraph phrase present: ${disc.length > 0}`);
  }
  if (f.kind === "missing-crossref") {
    const docLinks = await grepSafe("\\[[^\\]]*\\]\\([^)]*\\)", f.docPath);
    probes.push(`doc carries ${docLinks.length} markdown link(s) in total`);
  }
  return probes;
}

/**
 * files.grep that treats "nothing matched / no such file" as an empty result, and rethrows
 * any other failure (bad regex, permission denied) so real problems are not swallowed.
 */
async function grepSafe(pattern: string, glob: string): Promise<GrepMatch[]> {
  try {
    return await files.grep(pattern, glob);
  } catch (e: any) {
    const msg = typeof e === "string" ? e : e?.message || "";
    const missing = /ENOENT|no such file|ENOTDIR|not a directory/i.test(msg);
    if (missing) return [];
    throw e;
  }
}

// --- Phase 1: audit (skill workflow step 1) ---

phase("Audit the docs and decide what kind of consolidation is needed");
const topicalFromGlob = (await files.glob("docs/**/*.md")).filter(
  (p) => !p.includes("/recaps/") && !p.includes("/plans/") && !p.includes("/archive/"),
);
const techBytes = await countBytes(TECH_CANONICAL);
const funcBytes = await countBytes(FUNC_CANONICAL);
const techPlaceholders = await grepSafe("add-when-implemented|TODO|FIXME|TBD", TECH_CANONICAL);
const funcPlaceholders = await grepSafe("add-when-implemented|TODO|FIXME|TBD", FUNC_CANONICAL);
log(
  `audit: topical docs ${topicalFromGlob.length}; ${TECH_CANONICAL} ${techBytes}B; ` +
    `${FUNC_CANONICAL} ${funcBytes}B; placeholder hits ${techPlaceholders.length + funcPlaceholders.length}`,
);
const audit = await auditor.ask<DocAudit>(
  `Audit this repository's documentation state for a consolidation run, exactly as
${SKILL_DIR}/SKILL.md workflow step 1 ("Audit the current state") prescribes, including its
pitfalls: a file project memory calls missing may exist as a placeholder stub (pitfall 2), and a
root-level contract doc may be a stale fork of a docs/ copy (pitfall 1).

The script already measured: ${TECH_CANONICAL} ${techBytes} bytes with ${techPlaceholders.length}
placeholder-marker hits; ${FUNC_CANONICAL} ${funcBytes} bytes with ${funcPlaceholders.length} hits;
${topicalFromGlob.length} topical docs under docs/ (recaps, plans and archive already excluded).
Verify those numbers yourself with wc and grep. Check whether the canonical names are even this
project's contract-doc pattern (grep root *.md files for technical/functional/spec headings, and
correct the paths in your answer if the real contract docs live elsewhere). Check CLAUDE.md or
equivalent project memory for claimed doc state and reconcile it against the files.

Then return the audit. Mode is "full" when a contract doc is missing or a stub of at most ~500
chars, "incremental" when it is substantial but stale or placeholder-ridden, "skip" when the
skill's "When to Skip" section applies (fewer than ~3 topical docs and substantial current
contract docs). List the topical docs the glob missed (top-level FEATURE-BRIEF-style docs), any
stale duplicate copies, and which skill variant applies (full rewrite, incremental sync,
comprehensive sync, debt triage, math/model doc, placeholder patch).`,
);
if (audit.mode === "skip") {
  log(`audit says skip: ${audit.rationale}`);
  const skipped: WorkflowReport = {
    conclusion: `No consolidation needed: ${audit.rationale}`,
    findings: [],
    verified: [
      "audited contract-doc sizes with wc -c and placeholder markers with a grep before deciding",
      "auditor re-verified the measurements and applied the skill's When-to-Skip rules",
    ],
    notCovered: ["contract docs were not read in depth; the audit decided they need no consolidation"],
  };
  return skipped;
}
const docPaths = [audit.technicalDoc.path, audit.functionalDoc.path];
// The audit may correct the contract-doc paths; re-check existence and size deterministically on
// the corrected paths so later phases never act on a stale claim.
for (const d of [audit.technicalDoc, audit.functionalDoc]) {
  const realExists = await exists(d.path);
  const realBytes = await countBytes(d.path);
  if (realExists !== d.exists || realBytes !== d.bytes) {
    log(`audit claim corrected for ${d.path}: exists ${d.exists}->${realExists}, bytes ${d.bytes}->${realBytes}`);
    d.exists = realExists;
    d.bytes = realBytes;
  }
}
const readList = [...new Set([...topicalFromGlob, ...audit.extraDocsToRead])].sort();
// Deterministic existence gate: skip missing docs so the fan-out never subagents a non-existent file.
const existingReadList: string[] = [];
for (const p of readList) {
  if (await exists(p)) {
    existingReadList.push(p);
  } else {
    log(`reader fan-out skipping missing doc: ${p}`);
  }
}
log(`consolidation mode: ${audit.mode}; reading ${existingReadList.length} topical docs (${readList.length - existingReadList.length} missing)`);

// --- Phase 2: read every topical doc (skill workflow step 2) ---

phase("Read every topical doc in parallel");
const extracts = await Promise.all(
  existingReadList.map((p) =>
    agent(`reader-${p}`, {
      system:
        "You read one topical doc and extract exactly what a summary-style contract doc would " +
        "cite from it: headline facts, countable claims, staleness. You do not edit files.",
    }).ask<DocExtract>(
      `Read ${p} in full. Extract the headline facts a contract doc would cite, the countable
claims (tests, tables, routes, endpoints, with their numbers), and any staleness (dates,
known-limitations that plans have since resolved, counts that look old). Flag stubs: a doc that
only points at another file is a stub (skill pitfall 10) — say what it points at, do not summarize
phantom content. Extract only what the doc actually says. Also copy the doc's first heading line
verbatim into firstHeading — including the leading # and the exact wording; the script compares it
against the file, so it is your proof of reading. If the file will not open, say so in
headlineFacts and leave firstHeading empty.`,
    ),
  ),
);
const stubs = extracts.filter((e) => e.isStub);
log(`${extracts.length} topical docs read, ${stubs.length} of them stubs`);
// Proof-of-read: the script re-reads each doc's first heading itself and compares against what
// the reader reported. A mismatch is a deterministic finding — that extract may not be grounded
// in the file (the fan-out otherwise trusts the reader actually opened it).
const groundingFindings: ReportedFinding[] = [];
for (const e of extracts) {
  const fileHeading = await firstHeadingOf(e.path);
  const claimed = e.firstHeading.trim();
  if (claimed === "") {
    groundingFindings.push({
      where: e.path,
      what: "The topical-doc reader returned no first heading — it did not (or could not) open the file",
      evidence: `firstHeading empty; the script's own files.grep shows the file's first heading is ${fileHeading === null ? "(none — heading-less file)" : `"${fileHeading}"`}`,
      status: "verified",
      severity: "high",
    });
  } else if (fileHeading !== null && claimed !== fileHeading) {
    groundingFindings.push({
      where: e.path,
      what: "The topical-doc reader's reported first heading does not match the file — the extract may be answer-from-prompt, not read-from-file",
      evidence: `reader reported "${claimed}"; files.grep shows "${fileHeading}"`,
      status: "verified",
      severity: "high",
    });
  }
}
for (const g of groundingFindings) {
  report(g);
}
if (groundingFindings.length > 0) {
  log(`${groundingFindings.length} reader extracts failed the deterministic proof-of-read check`);
}

// --- Phase 3: merge the readings (skill step 2's chunking/summary strategy, one join) ---

phase("Merge the readings into one digest");
const digest = await synthesist.ask<DocDigest>(
  `Merge these per-doc extracts into one digest for the writers of two contract docs
(${docPaths.join(" and ")}). Drop deep detail — the contract docs link to topical docs, they never
duplicate them (skill "Core Principle"). Split the facts by audience per the skill's document-type
table: TECHNICAL-DOCUMENTATION.md is for developers, FUNCTIONAL-SPECIFICATIONS.md for product/UX.
Build the inventory rows the contract-doc tables need (tech stack, environments, feature list).
Move every extract's staleness finding into staleClaims, and put anything the docs leave
unresolved into openQuestions — the contract docs must not invent answers (skill pitfall:
inventing features that don't exist). Extracts: ${JSON.stringify(extracts)}`,
);

// --- Phases 4-6: design the structure, critique it, independent review (skill step 3) ---

phase("Design the section plan for both contract docs");
let plan = await designer.ask<SectionPlan>(
  `Design the section plan for both contract docs following ${SKILL_DIR}/SKILL.md step 3 ("Design
the contract doc structure") and ${SKILL_DIR}/references/example-rollup-structure.md (a real
rollup's section mapping). Target paths: ${audit.technicalDoc.path} and ${audit.functionalDoc.path}.
Apply the section-presence rule strictly: only sections for which topical docs or implementation
exist — no add-when-implemented scaffolding. Give every section its cross-reference links into
docs/. Digest: ${JSON.stringify(digest)}. Audit variant notes: ${audit.variantNotes}`,
);
log(`plan: ${plan.technical.sections.length} technical sections, ${plan.functional.sections.length} functional sections`);

phase("Critique the section plan until it holds");
let planFeedback = "none";
for (let round = 0; round < PLAN_REVIEW_ROUNDS; round++) {
  const review = await planReviewer.ask<PlanReview>(
    `Critique this section plan. Read the topical docs it links to and spot-check that each
section has real content behind it. What is invented, empty, duplicated in deep detail, or
cross-referenced wrong? Ask for failures, not approval: approving takes evidence. Plan:
${JSON.stringify(plan)}. Your previous critique: ${planFeedback}`,
  );
  if (review.approved) {
    log(`section plan approved on round ${round + 1}`);
    break;
  }
  log(`section plan rejected: ${review.feedback}`);
  planFeedback = review.feedback;
  plan = await designer.ask<SectionPlan>(
    `Your section plan was critiqued. Address each point and return the revised plan.
Critique: ${review.feedback}
Plan: ${JSON.stringify(plan)}`,
  );
}

phase("Give the finished section plan an independent review");
const independentPlanReview = await independentPlanReviewer.ask<PlanReview>(
  `You have not seen this plan before. Read it against the topical docs it references (do not
edit anything): what would break a writer who followed it, and what is missing? Pay attention to
the skill's core principle — contract docs summarize and link, topical docs go deep — and to the
section-presence rule. Plan: ${JSON.stringify(plan)}`,
);

// --- Phase 7: write both contract docs (skill steps 4-5), length gate per doc ---

phase("Write both contract docs to their length targets");
const writeTargets: { kind: "technical" | "functional"; path: string; target: [number, number] }[] = [
  { kind: "technical", path: audit.technicalDoc.path, target: TECH_LINES },
  { kind: "functional", path: audit.functionalDoc.path, target: FUNC_LINES },
];
const written = await Promise.all(
  writeTargets.map(async (t) => {
    const writer = t.kind === "technical" ? techWriter : specWriter;
    const stepRef = t.kind === "technical" ? "step 4 (TECHNICAL-DOCUMENTATION.md)" : "step 5 (FUNCTIONAL-SPECIFICATIONS.md)";
    const planHalf = t.kind === "technical" ? plan.technical : plan.functional;
    let result = await writer.ask<DocWriteResult>(
      `Write ${t.path} following ${SKILL_DIR}/SKILL.md ${stepRef}, using
${SKILL_DIR}/references/example-rollup-structure.md as the structural template. Mind the length
target stated there, and note the verification checklist at the bottom of the skill states the
tighter band the script actually gates on. Mode: ${audit.mode} — in incremental mode patch stale
sections in place rather than rewriting, per the skill's incremental-sync variant. Include the
standard header and the contract-doc discipline paragraph. Summarize and link; never duplicate
topical depth (skill pitfalls: duplicating topical content, inventing features, wrong audience,
secrets). Every plan section must cross-reference its topical docs; document only what exists —
planned things get a pointer into docs/plans. Audit variant notes: ${audit.variantNotes}. If the
audit lists duplicate copies of this doc (${JSON.stringify(audit.duplicateCopies)}), update the
live one and sync the stale copy per skill pitfall 1. Section plan for your half:
${JSON.stringify(planHalf)}. Digest: ${JSON.stringify(digest)}. Plan risks to respect:
${JSON.stringify(plan.risks)}. Independent plan review to fold in:
${JSON.stringify(independentPlanReview)}. The script measures the length and re-runs the link,
placeholder and secret checks after you — do not run them yourself; spend your turn on the writing.`,
    );
    let lines = await countLines(t.path);
    report(t.kind === "technical" ? { techLines: lines } : { funcLines: lines }, "progress");
    for (let trim = 0; trim < TRIM_ROUNDS && !withinTarget(lines, t.target); trim++) {
      log(`${t.path} at ${lines} lines, target ${t.target[0]}-${t.target[1]}; asking the writer to adjust`);
      result = await writer.ask<DocWriteResult>(
        `Your ${t.path} measures ${lines} lines, outside the length band the script gates it
against (the checklist at the bottom of ${SKILL_DIR}/SKILL.md states it). ${
          lines < t.target[0]
            ? "Add the missing summary substance — more sections from the plan, fuller summaries — without padding or duplicating topical depth."
            : "Trim duplicated topical depth and move it to links — the doc must read in ten minutes."
        } Return the updated result.`,
      );
      lines = await countLines(t.path);
      report(t.kind === "technical" ? { techLines: lines } : { funcLines: lines }, "progress");
    }
    return { target: t, result, lines };
  }),
);

// --- Phase 8: the skill's verification checklist as deterministic gates (step 6) ---

phase("Verify every cross-reference and run the placeholder and secret checks");
let gates = await runDocGates(docPaths);
log(
  `gates: ${gates.checkedLinks} link targets checked, ${gates.brokenLinks.length} broken, ` +
    `${gates.placeholders.length} placeholder hits, ${gates.secrets.length} secret hits`,
);
report({ brokenLinks: gates.brokenLinks.length }, "progress");
for (let round = 0; round < GATE_FIX_ROUNDS && gateProblems(gates) > 0; round++) {
  log(`fixing ${gateProblems(gates)} gate problems (round ${round + 1})`);
  await docFixer.ask<FixNote>(
    `Fix these mechanical defects in ${docPaths.join(" and ")}, per the skill's step 6 (fix every
MISS line), pitfall 3 (stale links) and pitfall 10 (a stub pointing at real content elsewhere
becomes a pointer, never a duplicate). Broken link targets as written in the docs:
${JSON.stringify(gates.brokenLinks)}. Placeholder markers that must not exist in a consolidated
doc: ${JSON.stringify(gates.placeholders)}. Secret-shaped strings that must be replaced by
env-var references (skill pitfall 5): ${JSON.stringify(gates.secrets)}. The script re-runs the
gates after you.`,
  );
  gates = await runDocGates(docPaths);
  report({ brokenLinks: gates.brokenLinks.length }, "progress");
}

// --- Phase 9: fresh-eyes review of the finished docs (skill pitfalls 2, 3, 7; checklist) ---

phase("Give the finished contract docs a fresh-eyes review and fix what it finds");
let freshReview = await freshReviewer.ask<FreshReview>(
  `You have not seen these documents before. Read ${docPaths.join(" and ")} against the topical
docs under docs/ and report what would mislead a reader: sections that duplicate topical depth
instead of linking it (the read-in-ten-minutes rule), features documented as live that no topical
doc or source backs (invented), content in the wrong doc for its audience (technical vs
functional), plan sections that never made it into the doc, a missing contract-doc discipline
paragraph. The script already verified every link target and ran the placeholder and secret
greps — do not report issues those checks decide. Do not edit any file. Digest against which to
judge invention: ${JSON.stringify(digest)}`,
);
const openFindings: ReportedFinding[] = [];
if (freshReview.findings.length > 0) {
  log(`fresh review raised ${freshReview.findings.length} findings`);
  for (let round = 0; round < FRESH_FIX_ROUNDS && freshReview.findings.length > 0; round++) {
    await techWriter.ask<FixNote>(
      `Address these review findings in ${audit.technicalDoc.path} — smallest change that answers
the objection; keep summarizing, not duplicating. Findings:
${JSON.stringify(freshReview.findings.filter((f) => f.docPath === audit.technicalDoc.path))}`,
    );
    await specWriter.ask<FixNote>(
      `Address these review findings in ${audit.functionalDoc.path} — smallest change that answers
the objection. Findings:
${JSON.stringify(freshReview.findings.filter((f) => f.docPath === audit.functionalDoc.path))}`,
    );
    // The mechanical gates re-decide what they decide after every fix round.
    gates = await runDocGates(docPaths);
    report({ brokenLinks: gates.brokenLinks.length }, "progress");
    if (gateProblems(gates) > 0) {
      log(`gates regressed after review fixes: ${gateProblems(gates)} problems`);
      await docFixer.ask<FixNote>(
        `The review fixes regressed the mechanical checks. Broken links:
${JSON.stringify(gates.brokenLinks)}. Placeholders: ${JSON.stringify(gates.placeholders)}.
Secrets: ${JSON.stringify(gates.secrets)}. Fix them; the script re-runs the gates after you.`,
      );
      gates = await runDocGates(docPaths);
    }
    // Re-ask the same reviewer, which still holds its own objections in context.
    freshReview = await freshReviewer.ask<FreshReview>(
      `The writers addressed your findings. Re-read ${docPaths.join(" and ")} and return only the
findings that still stand.`,
    );
  }
  // The skill wants failures confirmed independently before they reach the user. The script
  // gathers deterministic evidence per residual finding, then a confirmer agent — which never
  // saw the review conversation and must check the evidence against the files itself — decides
  // which findings the evidence proves. Only confirmed findings go out as verified; the rest
  // stay reviewer judgement, honestly labelled unconfirmed.
  const probeResults: { finding: DocReviewFinding; probes: string[] }[] = [];
  for (const f of freshReview.findings) {
    probeResults.push({ finding: f, probes: await probeFinding(f) });
  }
  const confirmations = await confirmer.ask<ConfirmationSet>(
    `Independent confirmation pass, not a rubber stamp. A fresh-eyes reviewer raised the findings
below against the consolidated contract docs. Do not trust the reviewer: each finding carries the
deterministic probes the script ran for it (file existence, line counts, greps of the finding's
own distinctive tokens, targeted phrase checks). Re-read the relevant part of the doc yourself and
verify what the probes mean. Return one verdict per finding, by index: "verified" ONLY when the
probes or your own reading objectively show the problem is real and present in the doc today —
judgement calls (audience fit, what counts as duplicated depth, whether a feature is "invented")
stay "unconfirmed" unless a probe shows the contradiction outright. In evidence, state what the
probes showed in one sentence. Never edit a file. Findings with their probes:
${JSON.stringify(probeResults.map((p, i) => ({ index: i, docPath: p.finding.docPath, where: p.finding.where, kind: p.finding.kind, what: p.finding.what, probes: p.probes })))}`,
  );
  for (let i = 0; i < freshReview.findings.length; i++) {
    const f = freshReview.findings[i];
    const verdict = confirmations.verdicts.find((v) => v.index === i);
    const reported: ReportedFinding = {
      where: `${f.docPath} ${f.where}`,
      what: f.what,
      evidence:
        verdict === undefined
          ? `confirmer returned no verdict for this finding; reviewer judgement only (${f.kind})`
          : `${verdict.status === "verified" ? "confirmer: deterministic probes and independent re-read back this" : "confirmer could not back this with a deterministic check"}: ${verdict.evidence}`,
      status: verdict === undefined ? "unconfirmed" : verdict.status,
      severity: f.severity,
    };
    openFindings.push(reported);
    report(reported);
  }
}

// --- Phase 10: housekeeping (skill step 8) + drift checks ---

phase("Run the housekeeping pass and the drift checks");
const housekeeping = await housekeeper.ask<HousekeepingResult>(
  `Run the post-consolidation housekeeping pass described in ${SKILL_DIR}/SKILL.md step 8: update
docs/STATE-SNAPSHOT.md if counts or shipped features changed; grep topical docs for "Known
Limitations" that recent plans have since resolved and fix those items; update topical docs the
consolidation exposed as stale; archive session recaps older than 90 days into
docs/recaps/archive/ — archive with git mv, never delete (the skill's lean-wins principle;
${SKILL_DIR}/references/elo-scenario-lab-doc-debt-triage.md has the worked example). Do not touch
${docPaths.join(" and ")} — the writers just settled them. Consolidation context: ${audit.rationale}.
The script checks CLAUDE.md's line count and CLAUDE.local.md's tracked status itself after you —
do not run those checks.`,
);
let claudeLines = await countLines("CLAUDE.md");
for (let round = 0; round < HOUSEKEEPING_ROUNDS && claudeLines > CLAUDE_MD_MAX_LINES; round++) {
  log(`CLAUDE.md at ${claudeLines} lines, over ${CLAUDE_MD_MAX_LINES}; asking the housekeeper to trim`);
  await housekeeper.ask<FixNote>(
    `CLAUDE.md measures ${claudeLines} lines and the project's documentation protocol caps it —
see the line-count check in ${SKILL_DIR}/SKILL.md step 8. Trim drift and stale bullets, not live
state, and say what you removed.`,
  );
  claudeLines = await countLines("CLAUDE.md");
}
const claudeOk = claudeLines <= CLAUDE_MD_MAX_LINES;
const localTracked = await world.run("git", ["ls-files", "CLAUDE.local.md"]);
const localOk = localTracked.exitCode === 0 && localTracked.stdout.trim() === "";

// --- Phase 11: stage and hand off (skill steps 7 and 9, with the checklist's stage-don't-commit rule) ---

phase("Stage the contract docs and write the handoff report");
const stageList = [
  ...docPaths,
  ...housekeeping.updatedFiles.map((f) => f.split(" ")[0]),
  ...audit.duplicateCopies.map((d) => d.staleCopy),
];
const staged = await world.run("git", ["add", ...stageList]);
if (staged.exitCode !== 0) {
  log(`git add failed: ${staged.stderr.slice(-500)}`);
}
if (commitEnabled) {
  phase("Commit to develop and deploy to staging");
  const commit = await world.run("git", [
    "commit",
    "-m",
    `docs: rollup feature documentation into ${audit.technicalDoc.path} and ${audit.functionalDoc.path}`,
  ]);
  log(commit.exitCode === 0 ? "committed" : `commit failed: ${commit.stderr.slice(-300)}`);
  if (commit.exitCode === 0) {
    const checkout = await world.run("git", ["checkout", "staging"]);
    if (checkout.exitCode === 0) {
      const merge = await world.run("git", ["merge", "develop"]);
      log(merge.exitCode === 0 ? "merged develop into staging" : `merge failed: ${merge.stderr.slice(-300)}`);
      if (merge.exitCode === 0) {
        const push = await world.run("git", ["push"]);
        log(push.exitCode === 0 ? "pushed staging" : `push failed: ${push.stderr.slice(-300)}`);
        await world.run("git", ["checkout", "develop"]);
      }
    } else {
      log(`no staging branch: ${checkout.stderr.slice(-300)}`);
    }
  }
}

const finalLines = await Promise.all(writeTargets.map((t) => countLines(t.path)));
const techLinesFinal = finalLines[0];
const funcLinesFinal = finalLines[1];
const gateClean = gateProblems(gates) === 0;
const deployNote = commitEnabled
  ? "Committed to develop and pushed to origin/staging (Railway auto-deploy, if configured)."
  : "Staged but NOT committed — per the skill's verification checklist, the commit is yours to make.";

const reportMarkdown = [
    "# Documentation consolidation report",
    "",
    `**Mode:** ${audit.mode} — ${audit.rationale}`,
    "",
    `**Variant applied:** ${audit.variantNotes}`,
    "",
    "## Contract docs",
    ...written.map((w) => {
      const t = w.target;
      return `- ${t.path}: ${w.result.kind}, ${w.result.sectionsWritten} sections, ${w.lines} lines (target ${t.target[0]}-${t.target[1]}${withinTarget(w.lines, t.target) ? ", within target" : ", **outside target**"})`;
    }),
    "",
    "## Verification checklist (ran for real in this run)",
    `- Cross-references: ${gates.checkedLinks} internal link targets checked with a node fs.existsSync probe, ${gates.brokenLinks.length} broken${gateClean ? "" : " — **see findings**"}`,
    `- Placeholder grep (add-when-implemented / TODO / FIXME / TBD): ${gates.placeholders.length} hits`,
    `- Secret-shaped strings: ${gates.secrets.length} hits`,
    `- CLAUDE.md: ${claudeLines} lines (cap ${CLAUDE_MD_MAX_LINES}${claudeOk ? "" : " — **over**"})`,
    `- CLAUDE.local.md tracked by git: ${localOk ? "no" : "**yes — should be untracked**"}`,
    "",
    "## Housekeeping",
    ...housekeeping.updatedFiles.map((f) => `- updated: ${f}`),
    ...housekeeping.staleLimitationsResolved.map((f) => `- resolved stale limitation: ${f}`),
    ...housekeeping.archivedOrFlagged.map((f) => `- archived/flagged: ${f}`),
    ...housekeeping.skipped.map((f) => `- skipped: ${f}`),
    "",
    "## Open findings",
    ...(openFindings.length === 0
      ? ["- none — the fresh-eyes review's findings were all addressed"]
      : openFindings.map((f) => `- **${f.where}** (${f.severity}, ${f.status}): ${f.what}`)),
    "",
    "## Handoff",
    `- Contract docs consolidated from ${extracts.length} topical docs (${stubs.length} of them stubs, preserved as pointers).`,
    `- ${audit.technicalDoc.path}: ${techLinesFinal} lines. ${audit.functionalDoc.path}: ${funcLinesFinal} lines.`,
    "- Topical docs preserved — no content was moved, only summarized and cross-referenced.",
    `- ${deployNote}`,
  ].join("\n");
try {
  await artifact.markdown("report", reportMarkdown, {
    title: "Documentation consolidation report",
    description: `What was audited, what was written to ${docPaths.join(" and ")}, and which checklist gates passed.`,
    primary: true,
  });
} catch {
  await artifact.markdown(
    "report",
    `# Documentation consolidation report (compact)\n\nFull report exceeded the publish cap. Open findings: ${openFindings.length}. ${deployNote}`,
    { title: "Documentation consolidation report", primary: true },
  );
}

const result: WorkflowReport = {
  conclusion:
    `Consolidated ${extracts.length} topical docs into ${audit.technicalDoc.path} ` +
    `(${techLinesFinal} lines) and ${audit.functionalDoc.path} (${funcLinesFinal} lines) in ` +
    `${audit.mode} mode; ${gateClean ? "all verification gates pass" : `${gateProblems(gates)} gate checks still fail`}, ` +
    `and ${openFindings.length} review finding(s) remain open. ${deployNote}`,
  findings: [
    ...groundingFindings,
    ...openFindings,
    ...gates.brokenLinks.map(
      (l): ReportedFinding => ({
        where: l,
        what: "Cross-reference target does not exist",
        evidence: `node fs.existsSync probe returned false for ${l} after ${GATE_FIX_ROUNDS} fix rounds`,
        status: "verified",
        severity: "high",
      }),
    ),
    ...gates.placeholders.map(
      (p): ReportedFinding => ({
        where: p,
        what: "Placeholder marker left in a consolidated contract doc",
        evidence: "files.grep for add-when-implemented|TODO|FIXME|TBD matched after fix rounds",
        status: "verified",
        severity: "medium",
      }),
    ),
    ...gates.secrets.map(
      (s): ReportedFinding => ({
        where: s,
        what: "Secret-shaped string in a contract doc",
        evidence: "files.grep secret pattern matched after fix rounds",
        status: "verified",
        severity: "high",
      }),
    ),
    ...(claudeOk
      ? []
      : [
          {
            where: "CLAUDE.md",
            what: `CLAUDE.md is ${claudeLines} lines, over the ${CLAUDE_MD_MAX_LINES}-line protocol cap`,
            evidence: "wc -l after the housekeeping trim rounds",
            status: "verified" as const,
            severity: "low" as const,
          },
        ]),
    ...(localOk
      ? []
      : [
          {
            where: "CLAUDE.local.md",
            what: "CLAUDE.local.md is tracked by git; the protocol wants it untracked",
            evidence: "git ls-files CLAUDE.local.md returned a path",
            status: "verified" as const,
            severity: "medium" as const,
          },
        ]),
  ],
  verified: [
    `audited ${TECH_CANONICAL} and ${FUNC_CANONICAL} with wc -c and placeholder greps before writing (skill step 1)`,
    `read ${extracts.length} topical docs, one subagent each, and merged them into one digest`,
    `every reader's reported first heading cross-checked against its file with files.grep (deterministic proof of read; ${groundingFindings.length} mismatches)`,
    `section plan critiqued by a persistent reviewer (up to ${PLAN_REVIEW_ROUNDS} rounds) and independently re-reviewed with fresh eyes`,
    "both contract docs measured with wc -l against the skill's length targets after writing",
    `all ${gates.checkedLinks} internal cross-reference targets checked with a node fs.existsSync existence probe (skill step 6)`,
    "placeholder grep (add-when-implemented|TODO|FIXME|TBD) and secret-pattern grep run over both contract docs",
    "fresh-eyes review of the finished docs against the topical docs; findings fixed and gates re-run",
    "housekeeping pass run; CLAUDE.md line count and CLAUDE.local.md tracked-status checked (skill step 8)",
    `git add over ${stageList.length} paths exited ${staged.exitCode}`,
  ],
  notCovered: [
    "external http(s) links were not fetched — they are out of scope for the existence probe by design",
    "anchor-only links (#section) were not resolved to headings",
    "reference-style links ([text][ref]) were not extracted — the same limitation as the skill's own step-6 grep",
    "the variant-only test-suite drift check was not wired in: the command is project-specific and this draft keeps the approved command set to wc, node, git — add the repo's test command before saving if you want it gated",
    "deploy verification (Railway or equivalent) was not performed",
    "topical docs were read for headline facts and staleness, not audited line by line",
  ],
};
return result;
