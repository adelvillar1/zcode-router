/* zcode-workflow
description: "Runs a deep, checklist-driven UI implementation review: the
  skill's grep recipes run as deterministic gates with absence never recorded as
  clean, per-domain auditors fan out over the checklist, every finding they
  return is independently confirmed up to a per-domain cap, live checks run
  where the skill demands them, and the findings are deduplicated, triaged, and
  ranked before the report is written. Embodies the ui-implementation-review
  skill."
whenToUse: When a frontend change needs a line-by-line implementation audit
  against a UI review checklist — error, empty, and loading states, destructured
  API shapes, dead styles, theme tokens — where findings must be confirmed
  before anyone acts on them.
args:
  target:
    type: string
    description: Optional path or glob naming the implementation to review. Omit to
      review the working tree at HEAD.
    required: false
  base:
    type: string
    description: Optional git ref to diff against. Omit for the whole working tree
      rather than a diff.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// ui-implementation-review.ts
// Dynamic workflow draft: deep, checklist-driven UI implementation review (Tier 3).
// Embodies /Users/alejandrodelvillar/.agents/skills/ui-implementation-review/SKILL.md
// (655 lines, 10,623 words — wc -l / wc -w this session) and all 11 files in its
// references/ directory.
//
// HYBRID PATTERN: phases, fan-outs, gates, publishing and the WorkflowReport live in this
// script; every subagent ask cites the skill's SKILL.md sections and the matching
// references/ files by absolute path and reads them in full before judging. The skill
// ships no scripts/ directory (its references/ holds 11 .md files and nothing executable,
// verified this session), so world.run gates carry credential-free probes and repo-health
// commands, files.grep/files.read carry the skill's grep-recipe audits (SKILL.md:156-166,
// :193-215, :222-231, :240-245), and anything needing credentials runs inside a
// subagent's own shell.
//
// CHECKLIST INVENTORY (from a full read of SKILL.md this session; line cites below were
// re-verified by grep this session):
//   - 19 workflow steps: "Choosing the right mode" (:34-38), 1 (:40-42), 2 (:44-52),
//     2b (:54-65), 3 (:67-74), 3b (:76-83), 4 (:85-87), 5 (:89-97), 6 (:99-101),
//     7 (:103-125), 7a (:127-150), 7b (:152-186), 7c (:188-215), 7d (:217-231),
//     7e (:233-245), 7f (:247-258), 7g (:260-262), 7h (:264-282), 8 (:284-286).
//   - 48 numbered pitfall entries in "Common Pitfalls" (:288-640): numbers 1-47 with
//     number 21 used TWICE (:422 nested-skeleton/innerHTML, :440 inline-CSS brace
//     balance), and numbered out of order (1, 37, 38, 2, ...; 31-36 sit under the
//     "Feature Audit Spreadsheet Pattern" heading at :564).
//   - 1 spreadsheet-pattern step (S1, :564-578).
//   - Step 2b expands to 8 named sub-checks (:54-65), tracked here as their own ids so
//     coverage accounting is per-check rather than per-heading.
//   Atomic ids in this draft: 75 (26 workflow ids including the 8 W2b sub-checks,
//   plus 48 pitfalls, plus S1). The brief's "62 checklist steps" matches neither the 68
//   top-level entries nor the 75 atomic ids — disclosed in the validation report. Every
//   one of the 75 ids is assigned to exactly one checklist domain in the DOMAINS table.
//
// REFERENCE FILES (all 11 read this session, each cited by at least one domain):
//   audit-to-plan-handoff.md, dashboard-polish-primitives.md,
//   design-token-compliance-audit.md, html-template-regression-recipe.md,
//   invisible-ui-element-diagnostic.md, operational-throughput-review.md,
//   radix-portal-dark-mode-leak.md, react-native-review-checks.md, review-checklist.md,
//   route-auth-matrix-audit.md, surface-checklist-library.md.
//   Sibling-skill pointers in SKILL.md, each checked with ls this session:
//   dogfood/references/authenticated-qa.md (:654) present;
//   client-csrf-token-store (:655) MISSING — gate G-CSRF-SKILL records that at run time;
//   nextjs-build-pitfalls (P38 :307) present;
//   wcag-accessibility/references/custom-slider-accessibility.md (P40 :521) present;
//   draft-feature-plan (W8 :284) present.
//
// COMPILER-ENFORCED LESSON REGISTER (batch defect list) — how this draft satisfies each:
//   (1) One primary artifact id ("ui-review-report"), and exactly ONE primary:true
//       literal in the script, on the single main publish. Fallback publishes use a
//       different id ("ui-review-report-fallback") and carry NO primary flag.
//       git-history-analytics.ts:1130-1176 (primary:true on three publishes of one id
//       plus the else-branch publish) is the defect pattern to avoid, not a template.
//   (2) No references to facade functions and no typeof/ReturnType of them: facade
//       functions are called directly, and the named GitStatus / GitCommit / GrepMatch
//       types annotate their results.
//   (3) Every ask<T> names a locally-declared interface; no inline object or array type
//       literals as type arguments; arrays of objects use named type aliases.
//   (4) Artifact ids are one kind each: "ui-review-report" = file only,
//       "ui-review-report-fallback" = markdown only, "fix-plan" = file only,
//       "fix-plan-compact" = markdown only.
//   (5) Every artifact.file / artifact.markdown publish sits in try/catch whose fallback
//       is script-composed and wrapped in its own try/catch, so it cannot throw.
//   (6) Tunable constants (round caps, observation caps, confirm-severity set, css-file
//       cap, command timeouts) live in control flow only and never enter ask text.
//   (7) Fan-out subagent names are computed and unique: ui-domain-<key>,
//       ui-confirm-<key>-<i>, ui-gaps-<key>-r<round>; singleton names are distinct from
//       every fan-out name.
//   (8) Every write and every approval reaches the human run owner by escalation: three
//       owner-relay personas (scope/permissions, live QA + SQL + repo checks, fix plan),
//       each escalating exactly ONE batched question and defaulting conservatively when
//       unreachable. Nothing is written without recorded owner approval.
//   (9) The data-safety block (read-only commands, SELECT/COUNT-only SQL, no credential
//       values in any output, escalate instead of faking) is restated VERBATIM inside
//       every ask text, because every subagent can run commands in its own shell.
//   (10) The report is published from the path the report writer actually returned
//        (existence-gated before publishing), never a hardcoded path; same for the plan.
//
// DESIGN NOTES:
//   - world.run runs only credential-free commands ("ls", "pnpm"). Pitfall 31's
//     [object Object] SELECT checks and pitfall 35's test-account provisioning live in
//     asks (subagent shells read connection strings at run time); P35's write is
//     proposal-only and stays a proposal unless the owner approves it.
//   - Two review mechanisms in proportion to cost (dynamic-workflows sections 3 and 10):
//     per-finding confirmers (facts: is this defect real?) and one report writer bound to
//     SKILL.md:103-125. No reader-proxy is stacked on top — every finding is confirmed or
//     explicitly labelled unconfirmed.
//   - Live QA (7a) runs whenever the owner approves it and is mandatory on auth/CORS
//     changes (SKILL.md:127-150): live-qa-verify carries the no-auth request recipe of
//     route-auth-matrix-audit.md and returns screenshot paths that land in the report as
//     MEDIA:<path> lines.

// ─── Result interfaces (every ask<T> names one of these) ─────────────────────

interface RawFinding {
  /** Checklist ids this finding closes or advances (like "P11", "W3", "W2b-nplus1"). */
  checklistIds: string[];
  /** Short one-line title. */
  title: string;
  /** "bug" | "ux" | "architecture" per SKILL.md:89-97. Broken rendering is always "bug" (P11). */
  tier: string;
  /** "low" | "medium" | "high". "high" = broken feature, security hole, data loss, deadlock. */
  severity: string;
  /** file:line, route, or surface the finding is about. */
  where: string;
  /** What is wrong, in one or two sentences. */
  what: string;
  /** What shows it: the read/grep/request and its outcome. Never credential values. */
  evidence: string;
  /** Root cause, one sentence. */
  rootCause: string;
  /** The concrete fix. */
  fix: string;
  /** "S" | "M" | "L" per SKILL.md:99-101. */
  effort: string;
  /** "high" | "medium" | "low" impact per SKILL.md:99-101. */
  impact: string;
  /** How to reproduce or observe it; empty when not applicable. */
  reproduce: string;
}

type RawFindingList = RawFinding[];

interface NotCoveredItem {
  /** Checklist id not covered. */
  id: string;
  /** Why it was not covered (file absent, platform not present, check blocked). */
  reason: string;
}

type NotCoveredList = NotCoveredItem[];

interface DomainAudit {
  /** Echo of the domain key this audit was dispatched for. */
  domain: string;
  /** Checklist ids this audit actually covered with evidence. */
  itemsCovered: string[];
  /** Checklist ids it did not cover, each with a reason — never silently dropped. */
  itemsNotCovered: NotCoveredList;
  /** Workspace-relative paths read in full (pitfall 1 forbids sampling). */
  filesReadInFull: string[];
  /** Findings; empty list when the domain is clean. */
  findings: RawFindingList;
  /** What is working well here, for SKILL.md:108-109 ("What's Working Well"). */
  positives: string[];
  /** Anything that blocked the audit (missing files, rejected greps). */
  blockers: string[];
}

interface GapSweep {
  /** Echo of the domain key. */
  domain: string;
  /** Gap ids this sweep covered. */
  itemsCovered: string[];
  /** Gap ids still not covered, with reasons. */
  itemsNotCovered: NotCoveredList;
  /** Findings from the sweep. */
  findings: RawFindingList;
  /** What the sweep did. */
  note: string;
}

interface Confirmation {
  /** Echo of the finding title being checked. */
  title: string;
  /** "confirmed" | "refuted" | "unverifiable". */
  verdict: string;
  /** What you re-read and saw that decides the verdict (path:line or command + outcome). */
  evidence: string;
  /** Corrected tier ("bug" | "ux" | "architecture") when you disagree; empty when unchanged. */
  correctedTier: string;
  /** Corrected severity when you disagree; empty when unchanged. */
  correctedSeverity: string;
}

interface ReviewScope {
  /** "feature-audit" | "full-app" per SKILL.md:34-38. */
  mode: string;
  /** One-line name of what is being reviewed. */
  label: string;
  /** Plan documents found (docs/plans/, docs/feature-*.md). */
  planPaths: string[];
  /** Other contract docs: specs, API-layer docs, product docs. */
  contractDocPaths: string[];
  /** Design-system / token definition files (DESIGN.md, tokens.css, theme files). */
  designSystemPaths: string[];
  /** Screen/view files in scope, workspace-relative. */
  screenPaths: string[];
  /** API route/handler files in scope. */
  apiRoutePaths: string[];
  /** API client files in scope. */
  apiClientPaths: string[];
  /** Shared component files in scope. */
  sharedComponentPaths: string[];
  /** Stylesheets and styled-component files in scope. */
  stylePaths: string[];
  /** Base URL for live checks (dev or deployed); empty when unknown. */
  baseUrl: string;
  /** The repo's actual typecheck command as argv words (runner first: pnpm/npm/yarn/npx), from package.json scripts, Makefile or CI config; empty when none exists. */
  repoTypecheckCommand: string[];
  /** The repo's actual test command as argv words (runner first), same sources; empty when none exists. */
  repoTestCommand: string[];
  /** True for Next.js (app or pages router) targets. */
  isNextJs: boolean;
  /** True for React Native / Expo targets. */
  isReactNative: boolean;
  /** True when the API side is Python (FastAPI/Flask). */
  isPythonApi: boolean;
  /** True when the product is a live-operations / throughput tool (pitfall 43). */
  operationalTool: boolean;
  /** Why this scope answers the request; names the files read to decide. */
  rationale: string;
  /** Surfaces the request touches that could not be located. */
  gaps: string[];
}

interface OwnerScopeApproval {
  /** The run owner's words, verbatim. */
  ownerWords: string;
  /** "approved" | "corrected" | "unreachable" — how the answer was obtained. */
  obtainedBy: string;
  /** May the run write exactly one report file (plan file needs its own later approval). */
  mayWriteReport: boolean;
  /** May live request/browser checks run (dev server, real requests, screenshots). */
  mayRunLiveChecks: boolean;
  /** May read-only SELECT/COUNT SQL run for the [object Object] checks (pitfall 31). */
  mayRunReadOnlySql: boolean;
  /** May repo-health commands run (typecheck, unit suite). */
  mayRunRepoChecks: boolean;
  /** Owner's correction to the scope label or file lists; empty when the scope is fine. */
  correctedScope: string;
}

interface OwnerLiveApproval {
  /** The run owner's words, verbatim. */
  ownerWords: string;
  /** "approved" | "corrected" | "unreachable". */
  obtainedBy: string;
  /** May a dev server be started for live QA; when false, live checks use baseUrl only. */
  mayStartDevServer: boolean;
  /** May unauthenticated and authenticated requests hit the app. */
  mayCurl: boolean;
  /** May read-only SELECT/COUNT SQL run. */
  mayRunReadOnlySql: boolean;
  /** May repo-health commands run (typecheck, unit suite). */
  mayRunRepoChecks: boolean;
  /** May screenshot files be written under out/ui-implementation-review/. */
  mayWriteScreenshots: boolean;
  /** Base URL to hit; empty when none is available. */
  baseUrl: string;
}

interface OwnerPlanApproval {
  /** The run owner's words, verbatim. */
  ownerWords: string;
  /** "approved" | "declined" | "unreachable". */
  obtainedBy: string;
  /** True only when the owner clearly asked for the fix plan (SKILL.md:284-286). */
  wantFixPlan: boolean;
  /** Path the owner wants the plan at; empty means the plan writer chooses under docs/plans/. */
  planPath: string;
}

interface LiveCheck {
  /** Check name (like "unauthenticated DELETE /saved-encounters/:id"). */
  name: string;
  /** Request/command shape run, never credential values. */
  command: string;
  /** What should happen. */
  expected: string;
  /** What happened. */
  observed: string;
  /** "pass" | "fail" | "skipped". */
  verdict: string;
}

type LiveCheckList = LiveCheck[];

interface LiveQaReport {
  /** Base URL actually hit; empty when nothing was reachable. */
  baseUrlTried: string;
  /** Checks run (SKILL.md:127-150 and route-auth-matrix-audit.md steps 4-5). */
  checks: LiveCheckList;
  /** Workspace-relative screenshot paths written (embedded as MEDIA:<path> in the report). */
  screenshotPaths: string[];
  /** Findings discovered live. */
  findings: RawFindingList;
  /** What could not be verified live and why. */
  blockers: string[];
}

interface DuplicateGroup {
  /** Id of the finding that survives (the earliest F-id in the group). */
  canonicalId: string;
  /** Ids of findings that duplicate it and should be merged away. */
  duplicateIds: string[];
  /** Why they are the same defect. */
  why: string;
}

type DuplicateGroupList = DuplicateGroup[];

interface TierCorrection {
  /** Finding id being corrected. */
  findingId: string;
  /** Corrected tier ("bug" | "ux" | "architecture"); empty when unchanged. */
  tier: string;
  /** Corrected severity; empty when unchanged. */
  severity: string;
  /** Why (e.g. SKILL.md:326 — broken rendering is a bug, not polish). */
  reason: string;
}

type TierCorrectionList = TierCorrection[];

interface DedupResult {
  /** Groups of duplicate findings. */
  groups: DuplicateGroupList;
  /** Tier/severity corrections (pitfalls 6, 11, 13 discipline). */
  corrections: TierCorrectionList;
  /** Anything else the triage pass wants on record. */
  note: string;
}

interface DetailedFinding {
  /** Script-assigned stable id ("F001"...). */
  id: string;
  /** Domain key that found it. */
  domain: string;
  /** Checklist ids it closes or advances. */
  checklistIds: string[];
  /** Short title. */
  title: string;
  /** "bug" | "ux" | "architecture". */
  tier: string;
  /** "low" | "medium" | "high". */
  severity: string;
  /** file:line / route / surface. */
  where: string;
  /** What is wrong. */
  what: string;
  /** Evidence. */
  evidence: string;
  /** Root cause. */
  rootCause: string;
  /** Fix. */
  fix: string;
  /** "S" | "M" | "L". */
  effort: string;
  /** "high" | "medium" | "low". */
  impact: string;
  /** Reproduce steps; empty when not applicable. */
  reproduce: string;
  /** "verified" | "unconfirmed". */
  status: string;
  /** Confirmer verdict, or "low-severity-not-confirmed" / "confirmed-by-gate". */
  verdict: string;
}

type DetailedFindingList = DetailedFinding[];

interface ReportFile {
  /** True when a markdown file was written to disk. */
  wroteFile: boolean;
  /** The exact path written — the script publishes from THIS path, never a guess. Empty when wroteFile is false. */
  path: string;
  /** Full report markdown, always returned (fallback publish and salvage). */
  markdown: string;
  /** Report title. */
  title: string;
  /** One-sentence headline for the artifact description. */
  headline: string;
  /** Section headings included, for the run record. */
  sectionsIncluded: string[];
  /** Anything the writer could not do. */
  note: string;
}

interface RepairOutcome {
  /** True when the report file was rewritten. */
  rewritten: boolean;
  /** Path rewritten — again the publish source. Empty when nothing was rewritten. */
  path: string;
  /** What changed or why nothing did. */
  note: string;
}

interface PlanFile {
  /** True when the plan file was written. */
  wroteFile: boolean;
  /** Exact path written; empty when nothing was written. */
  path: string;
  /** Phase names in the plan (few and clustered, per audit-to-plan-handoff.md). */
  phases: string[];
  /** Finding ids each phase closes. */
  findingIdsCovered: string[];
  /** Finding ids explicitly out of scope, with rationale. */
  outOfScope: string[];
  /** Note. */
  note: string;
}

interface Finding {
  /** Stage and subject the finding is about. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** What showed it. */
  evidence: string;
  /** "verified" only when a deterministic check or an independent confirmer established it. */
  status: "verified" | "unconfirmed";
  /** How much it matters. "high" = broken feature, security hole, data loss, deadlock. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the run was asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: gates run, files covered, confirmations made. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ─── Script-side data (not ask types) ────────────────────────────────────────

interface ChecklistDomain {
  /** Short ascii key used in computed subagent names. */
  key: string;
  /** Human title of the checklist domain. */
  title: string;
  /** Checklist ids this domain owns (75 ids total across the table). */
  items: string[];
  /** SKILL.md line ranges that define these items. */
  skillCites: string[];
  /** Absolute paths of the references files carrying the recipes for these items. */
  refs: string[];
  /** What the auditor must check — citations and rules, never tunable thresholds. */
  focus: string;
  /** True when this domain only applies to live-operations tools (pitfall 43). */
  operationalOnly: boolean;
}

type ChecklistDomainList = ChecklistDomain[];

interface GateEvidence {
  /** Gate id. */
  id: string;
  /** Command shape or grep pattern + glob; never credential values. */
  command: string;
  /** What came back (paths, counts, first hits), truncated. */
  observation: string;
  /** Match count or exit-code summary. */
  hits: string;
  /** "ran" | "probe-failed" | "skipped-owner-declined" | "skipped-precondition". */
  status: string;
  /** Which checklist ids this gate feeds. */
  decisiveFor: string;
}

type GateEvidenceList = GateEvidence[];

const SKILL_DIR = "/Users/alejandrodelvillar/.agents/skills/ui-implementation-review";
const SKILL_MD = `${SKILL_DIR}/SKILL.md`;
const REFS_DIR = `${SKILL_DIR}/references`;
const REF_CHECKLIST = `${REFS_DIR}/review-checklist.md`;
const REF_RN = `${REFS_DIR}/react-native-review-checks.md`;
const REF_HANDOFF = `${REFS_DIR}/audit-to-plan-handoff.md`;
const REF_TOKENS = `${REFS_DIR}/design-token-compliance-audit.md`;
const REF_RADIX = `${REFS_DIR}/radix-portal-dark-mode-leak.md`;
const REF_HTML = `${REFS_DIR}/html-template-regression-recipe.md`;
const REF_INVISIBLE = `${REFS_DIR}/invisible-ui-element-diagnostic.md`;
const REF_OPS = `${REFS_DIR}/operational-throughput-review.md`;
const REF_AUTH = `${REFS_DIR}/route-auth-matrix-audit.md`;
const REF_SURFACE = `${REFS_DIR}/surface-checklist-library.md`;
const REF_POLISH = `${REFS_DIR}/dashboard-polish-primitives.md`;
const SIBLING_AUTH_QA = "/Users/alejandrodelvillar/.agents/skills/dogfood/references/authenticated-qa.md";
const SIBLING_CSRF = "/Users/alejandrodelvillar/.agents/skills/client-csrf-token-store";
const SIBLING_SLIDER = "/Users/alejandrodelvillar/.agents/skills/wcag-accessibility/references/custom-slider-accessibility.md";
const SIBLING_NEXTJS = "/Users/alejandrodelvillar/.agents/skills/nextjs-build-pitfalls";

// Tunable constants — control flow only, never interpolated into ask text.
const MAX_GAP_ROUNDS = 2;
const MAX_CSS_FILES = 40;
const MAX_CONFIRMATIONS_PER_DOMAIN = 8;
const OBS_CAP = 600;
const MARKDOWN_CAP = 250000;
const REPO_CHECK_TIMEOUT_MS = 600000;
const REPAIR_CONTENT_CAP = 20000;
const CONFIRM_ONLY_SEVERITIES = ["high", "medium"];
const RECENT_COMMIT_COUNT = 15;
const WRITER_FIELD_CAP = 500;
const WRITER_JSON_CAP = 200000;

const DOMAINS: ChecklistDomainList = [
  {
    key: "contracts",
    title: "Contract documents and plan truthfulness",
    items: ["W1", "W4", "P2", "P16"],
    skillCites: [
      "SKILL.md:40-42 (W1 load contract documents)",
      "SKILL.md:85-87 (W4 cross-reference against the plan)",
      "SKILL.md:317 (P2 never trust the plan's self-reported status)",
      "SKILL.md:374-375 (P16 deferred-item reviews rot; :376-384 is P17)",
    ],
    refs: [REF_CHECKLIST, REF_HANDOFF],
    focus:
      "Load every contract document the target touches (plan, feature docs, design system, API-layer docs) and cross-reference the implementation against them. The plan's self-reported criteria status is a claim, not evidence (P2): verify every criterion by reading code. Deferred/polish lists are a backlog, not a contract (P16): confirm each deferred item still exists in the current code before treating it as open.",
    operationalOnly: false,
  },
  {
    key: "screens",
    title: "Every screen in full: states, rendering truthfulness, optional-field reads",
    items: ["W2", "W2b-deadstyles", "P1", "P11", "P45"],
    skillCites: [
      "SKILL.md:44-52 (W2 read every screen file in full)",
      "SKILL.md:54-65 (W2b dead styles)",
      "SKILL.md:290-291 (P1 never skip screens; :292-305 and :307-316 are P37/P38)",
      "SKILL.md:326 (P11 broken rendering is a bug, never polish)",
      "SKILL.md:556-558 (P45 optional-field fallback on EVERY read site)",
    ],
    refs: [REF_CHECKLIST, REF_RN, REF_POLISH],
    focus:
      "Read every screen file in full — no sampling (P1). Check error/empty/loading states on every surface (icon + title + subtitle where the design system specifies), destructuring versus actual API shapes at every render site, dead styles, and theme token usage. Optional persisted fields normalize with a fallback at EVERY read site (P45) — one normalized sibling does not cover a raw one. Anything that renders undefined, [object Object], a case-mismatched key, or an empty section is a BUG (P11): report it under tier 'bug', never as polish or UX.",
    operationalOnly: false,
  },
  {
    key: "api",
    title: "API routes and client contract, response shapes, CRUD coverage",
    items: ["W3", "W3b", "W2b-fieldnames", "W2b-nplus1", "W7c", "P3", "P9", "P12", "P15", "P17", "P29"],
    skillCites: [
      "SKILL.md:67-74 (W3 read every API route and the API client)",
      "SKILL.md:76-83 (W3b full-app API client audit)",
      "SKILL.md:54-65 (W2b field-name consistency, N+1 calls)",
      "SKILL.md:188-215 (W7c server-route to UI-feature matrix)",
      "SKILL.md:318 (P3 response shapes vs destructuring)",
      "SKILL.md:324 (P9 N+1 in list items)",
      "SKILL.md:327-337 (P12 stringly-typed display paths)",
      "SKILL.md:361-373 (P15 cached endpoint + new response format)",
      "SKILL.md:376-384 (P17 enumerate every view, not call sites)",
      "SKILL.md:507-516 (P29 ID vs slug mismatch)",
    ],
    refs: [REF_CHECKLIST, REF_HANDOFF],
    focus:
      "Read every API route and the API client in full. Cross-check response shapes versus frontend destructuring (P3), field naming between server and client (W2b), filter/query params and active-records filtering (W3), endpoint coverage, error handling, auth wiring and response unwrapping (W3b). Build the server-route to UI-feature matrix (W7c): every mutating route needs its create/update/delete affordance actually wired in the UI. Audit N+1 patterns in list items (P9), stringly-typed display paths that skip normalization (P12) — and when one display path is broken, enumerate EVERY view that renders the entity, not the call sites you happened to see (P17). Cached endpoints plus a new response format silently poison the cache (P15). List links that store ids while detail routes use slugs break navigation (P29).",
    operationalOnly: false,
  },
  {
    key: "nav",
    title: "Navigation registration, route names, links, public-to-gated routes",
    items: ["W2b-navnames", "P5", "P7", "P26", "P30"],
    skillCites: [
      "SKILL.md:54-65 (W2b navigation route names)",
      "SKILL.md:320 (P5 stack completeness)",
      "SKILL.md:322 (P7 route-name mismatches crash)",
      "SKILL.md:481-482 (P26 a-href instead of Link)",
      "SKILL.md:517-518 (P30 public nav to auth-gated routes)",
    ],
    refs: [REF_CHECKLIST, REF_RN],
    focus:
      "Verify every screen is registered in the right stack navigator and reachable (P5), and every navigate()/Link target name matches a registered route (P7, W2b) — a mismatch is an immediate crash. In Next.js targets, grep for `<a href=\"/` in files that also import Link (P26): each hit should be `<Link href=...>`. Public navigation must not point at auth-gated routes (P30): every public nav target must resolve for an unauthenticated visitor.",
    operationalOnly: false,
  },
  {
    key: "components",
    title: "Shared components, duplicated utilities, redundancy versus density",
    items: ["W2b-utils", "P10", "P19", "P24"],
    skillCites: [
      "SKILL.md:54-65 (W2b duplicated utils)",
      "SKILL.md:325 (P10 duplicated utility functions)",
      "SKILL.md:404-407 (P19 redundancy across adjacent sections, blind component reuse)",
      "SKILL.md:468-478 (P24 density means removing redundancy)",
    ],
    refs: [REF_CHECKLIST, REF_RN, REF_POLISH],
    focus:
      "Audit the shared components the checklist names (FavoriteButton, PillFilter, Card/SectionHeader, LoadingState in review-checklist.md section 6) for prop contracts, states and consistency. Flag utility functions duplicated across screens (P10, W2b) — architecture debt that compounds. Audit adjacent sections for duplicated information and blind component reuse (P19): when density is requested, the fix is removing redundant containers and spacing, never adding widgets (P24).",
    operationalOnly: false,
  },
  {
    key: "theme",
    title: "Design tokens, hardcoded literals, purge risk, dark-mode portals, label consistency",
    items: ["P4", "P13", "P38", "P39", "P42"],
    skillCites: [
      "SKILL.md:319 (P4 design inconsistencies are not minor)",
      "SKILL.md:338-341 (P13 inconsistency is a class of bug)",
      "SKILL.md:307-316 (P38 Tailwind arbitrary-value var() classes are purged)",
      "SKILL.md:519-520 (P39 hardcoded literals drift from the source of truth)",
      "SKILL.md:527-541 (P42 Radix portal dark-mode leak)",
    ],
    refs: [REF_TOKENS, REF_RADIX, REF_POLISH],
    focus:
      "Read the design system / token definitions FIRST (design-token-compliance-audit.md order), then audit added UI: no hardcoded hex/rgb/hsl literals (P39) except color-mix() over var(--token) inputs; every surface referenced through tokens; typography role split; button, card and surface modes; motion honoring prefers-reduced-motion. Tailwind arbitrary-value classes like bg-[var(--x)] can be silently purged from production bundles (P38) — the only verification is the built CSS. Radix portals land outside scoped .dark containers and leak light tokens (P42). The same concept showing two names or two casings is a bug class (P4, P13), not polish.",
    operationalOnly: false,
  },
  {
    key: "interaction",
    title: "Data fetching, effects and closures, list mechanics, error state machines",
    items: ["W2b-session", "W2b-closures", "W2b-flatlist", "P8", "P22", "P27", "P28", "P33", "P46", "P47"],
    skillCites: [
      "SKILL.md:54-65 (W2b session lifecycle, stale closures, FlatList index bugs)",
      "SKILL.md:323 (P8 stale closure patterns)",
      "SKILL.md:460-465 (P22 browser module cache hides fixes)",
      "SKILL.md:483-495 (P27 missing debounce floods the API)",
      "SKILL.md:496-506 (P28 try/finally without catch swallows errors)",
      "SKILL.md:591-605 (P33 Promise.all placeholder slots misalign)",
      "SKILL.md:560-561 (P46 pick-exactly-N set deadlock)",
      "SKILL.md:562-563 (P47 transient error note persists)",
    ],
    refs: [REF_RN, REF_POLISH],
    focus:
      "Audit data fetching and interaction mechanics (react-native-review-checks.md sections on Data Fetching, State & Closures and FlatList/ScrollView apply to web equivalents too): session lifecycle cleanup, strict-mode double mounts, race conditions, stale closures and meaningless isMounted refs (P8, W2b), list key/index/layout bugs (W2b). Search inputs that fetch per keystroke need debounce (P27). try/finally without catch swallows errors into a fake-empty success (P28). Promise.all arrays with placeholder slots silently shift destructured variables (P33). A pick-exactly-N selector implemented as a set deadlocks when a legal combination repeats a kind (P46) — report as a bug. A transient error note that only clears on the next success persists as a false failure (P47). Browser module caches can hide view-module fixes during live QA (P22) — record that as a verification caveat when relevant.",
    operationalOnly: false,
  },
  {
    key: "copy",
    title: "User-facing copy, chrome density, touch access, per-surface UX checklists",
    items: ["W7d", "W7f", "W7h", "P18", "P25", "P40"],
    skillCites: [
      "SKILL.md:217-231 (W7d topbar/chrome button density)",
      "SKILL.md:247-258 (W7f dev jargon in user-facing UI)",
      "SKILL.md:264-282 (W7h per-surface UX checklist audit)",
      "SKILL.md:386-403 (P18 inline comparison text wrap-trap)",
      "SKILL.md:479-480 (P25 hover-only buttons invisible on touch)",
      "SKILL.md:521-522 (P40 custom div sliders need ARIA)",
    ],
    refs: [REF_SURFACE, REF_POLISH, SIBLING_SLIDER],
    focus:
      "Audit user-facing copy and per-surface UX: apply the topbar/chrome button-density rule from SKILL.md:217-231 (W7d), hunt dev jargon (undefined, [object Object], NaN, raw enum keys, stack traces) leaking into user-facing UI (W7f), and run the per-surface checklist audit (W7h) against surface-checklist-library.md for every surface the feature touches (paywall, onboarding, empty state, pricing, login and the rest), including cross-platform variants and Related checklists. Inline two-value comparison text in narrow stat cards is a wrap-trap (P18). Buttons hidden behind hover are unreachable on touch (P25) and icon-only buttons need aria-label. Custom div-built sliders need the full ARIA and keyboard wiring from wcag-accessibility/references/custom-slider-accessibility.md (P40).",
    operationalOnly: false,
  },
  {
    key: "auth",
    title: "Route-by-route auth matrix, live unauthenticated verification, client session wiring",
    items: ["W7a", "W7b", "W7e", "P14", "P32", "P35"],
    skillCites: [
      "SKILL.md:127-150 (W7a live curl/browser QA, mandatory for auth and CORS changes)",
      "SKILL.md:152-186 (W7b route-by-route auth matrix)",
      "SKILL.md:233-245 (W7e auth shipped but client never wired it)",
      "SKILL.md:342-360 (P14 TestClient multi-source auth false positives)",
      "SKILL.md:589-590 (P32 JWT caches role — re-login to test)",
      "SKILL.md:618-628 (P35 test accounts via DB password hash — a WRITE)",
    ],
    refs: [REF_AUTH, SIBLING_AUTH_QA, REF_CHECKLIST],
    focus:
      "Run the route-by-route auth matrix (W7b) exactly as route-auth-matrix-audit.md: inventory every route registration, inventory every auth middleware call (requireSession/requireAuth/requirePlatformAdmin/isDmOfCampaign/isOwner or the project's equivalents), diff mutating routes minus authed routes, then verify each gap with an unauthenticated request — 401/403 expected, and DELETE must never return 204/200. Known failure case to remember: DELETE /saved-encounters/:id answered 204 unauthenticated. Avoid the false positives the recipe names (public read endpoints, internal-token-gated, import-key-gated). Live curl/browser QA is mandatory when auth or CORS changed (W7a). Check the client actually calls the session-restore endpoint the docs claim (W7e). Remember TestClient multi-source auth false positives (P14) when reading test evidence: a passing suite does not prove the header-only path works. JWT-cached roles need sign-out/sign-in to observe (P32). Provisioning test accounts by writing password hashes (P35) is a DATABASE WRITE: propose it as a numbered item for the owner gate and never run it yourself.",
    operationalOnly: false,
  },
  {
    key: "integrity",
    title: "Template/patch regressions, CSS integrity, data integrity in text columns",
    items: ["P20", "P21a", "P21b", "P23", "P31", "P34", "P36"],
    skillCites: [
      "SKILL.md:408-421 (P20 escaped angle brackets in JS-built HTML)",
      "SKILL.md:422-439 (P21 innerHTML wrapper nesting)",
      "SKILL.md:440-459 (P21 inline CSS brace balance)",
      "SKILL.md:466-467 (P23 literal ...[truncated] written back)",
      "SKILL.md:580-588 (P31 [object Object] in DB text columns)",
      "SKILL.md:606-617 (P34 raw SQL referencing dropped tables)",
      "SKILL.md:629-640 (P36 Python CSV writer None keys)",
    ],
    refs: [REF_HTML, REF_INVISIBLE],
    focus:
      "Audit template and patch regressions per html-template-regression-recipe.md: escaped angle-bracket entities inside JS template literals render as raw tags (P20); swapping a skeleton wrapper via wrapper.innerHTML= nests containers and breaks selectors/anchors (P21a — the fix is a contextual fragment plus replaceWith); inline CSS patch insertions break brace balance and silently kill every rule below (P21b — the script runs a brace count, you judge the surrounding patch). Never trust truncated file reads: literal truncation-marker text written back into a source file is a real defect class (P23). Data integrity: [object Object] literal strings in database text columns render in the UI (P31) — check with SELECT/COUNT-only SQL when the owner approved it, and propose (never run) any cleanup. Raw SQL referencing dropped tables breaks at runtime (P34). Python CSV writers pass None keys into headers/rows (P36).",
    operationalOnly: false,
  },
  {
    key: "wrongpath",
    title: "Which component the user is actually viewing (dual-path / flag-gated UI)",
    items: ["P37"],
    skillCites: ["SKILL.md:292-305 (P37 adding UI to the wrong component — dual-path flags)"],
    refs: [REF_INVISIBLE],
    focus:
      "Before any claim about a missing UI element, establish which component the user is actually viewing (P37): feature-flagged dual UIs (Harbor vs legacy style) serve the same feature from completely different files. Trace the flag, the rendered path and the target component. Follow invisible-ui-element-diagnostic.md in order — component path first, then deployed CSS (purge), then DOM presence, then computed visibility, then positioning — and report which rung the element fails at. Adding a control to the unrendered path is a bug even when the code compiles.",
    operationalOnly: false,
  },
  {
    key: "ops",
    title: "Operational/throughput model first (live-operations tools only)",
    items: ["P43"],
    skillCites: ["SKILL.md:542-553 (P43 extract the domain workflow model BEFORE flagging friction)"],
    refs: [REF_OPS],
    focus:
      "For live-operations tools only (dismissal queues, dispatch boards, checkout lines, event intake): extract the domain workflow model BEFORE flagging anything as friction (P43) — throughput target, who does what, what persists, failure policy — and present that model first. Then audit silent-loss paths (payload contract mismatches swallowed as 422s, ignored statuses never read, flag fields that never render, inconsistent gates) and measure the critical path before recommending fixes. Follow operational-throughput-review.md end to end.",
    operationalOnly: true,
  },
  {
    key: "report",
    title: "Triage, evidence hygiene, report shape, fix-plan offer",
    items: ["W-mode", "W5", "W6", "W7", "W7g", "W8", "P6", "P41", "P44", "S1"],
    skillCites: [
      "SKILL.md:34-38 (mode selection)",
      "SKILL.md:89-97 (W5 categorize findings)",
      "SKILL.md:99-101 (W6 effort and impact)",
      "SKILL.md:103-125 (W7 report format)",
      "SKILL.md:260-262 (W7g cite live verification in every red finding)",
      "SKILL.md:284-286 (W8 offer a fix plan)",
      "SKILL.md:321 (P6 never present findings unprioritized)",
      "SKILL.md:523-525 (P41 empty grep does not mean clean)",
      "SKILL.md:554-555 (P44 wrapper-mangled grep false zeros)",
      "SKILL.md:564-578 (S1 feature audit spreadsheet pattern)",
    ],
    refs: [REF_CHECKLIST, REF_HANDOFF],
    focus:
      "Own the run's epistemics: confirm the mode selection (feature-audit versus full-app, SKILL.md:34-38) was applied consistently, and that every finding is categorized (red bugs, yellow UX, white missing features, architecture) (W5) and prioritized with effort and impact (W6, P6). Audit the evidence the other domains cite: an empty grep does not prove absence (P41) and wrapper-mangled grep output can return false zero matches (P44) — every negative claim must name how it was re-verified by reading the file. Every red finding cites its live verification when one exists (W7g). Prepare report-shape guidance exactly in the SKILL.md:103-125 section order (W7) plus the S1 spreadsheet columns where a feature audit applies, and shape the fix-plan offer (W8) per audit-to-plan-handoff.md: findings inventory, two to four clustered phases, per-phase acceptance criteria that close findings by id.",
    operationalOnly: false,
  },
];

// ─── Deterministic gate helpers (facade functions called directly) ───────────

function clipObservation(text: string): string {
  return text.length > OBS_CAP ? `${text.slice(0, OBS_CAP)}...` : text;
}

async function lsGate(id: string, path: string, decisiveFor: string): Promise<GateEvidence> {
  try {
    const res = await world.run("ls", [path]);
    return {
      id,
      command: `ls ${path}`,
      observation: clipObservation(res.stdout !== "" ? res.stdout : res.stderr),
      hits: `exitCode=${String(res.exitCode)}`,
      status: res.exitCode === 0 ? "ran" : "probe-failed",
      decisiveFor,
    };
  } catch {
    return {
      id,
      command: `ls ${path}`,
      observation: "the ls call itself failed",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

async function pnpmGate(id: string, argv: string[], decisiveFor: string): Promise<GateEvidence> {
  try {
    const res = await world.run("pnpm", argv, { timeoutMs: REPO_CHECK_TIMEOUT_MS });
    return {
      id,
      command: `pnpm ${argv.join(" ")}`,
      observation: clipObservation(`${res.stdout}\n${res.stderr}`),
      hits: `exitCode=${String(res.exitCode)}`,
      status: res.exitCode === 0 ? "ran" : "probe-failed",
      decisiveFor,
    };
  } catch {
    return {
      id,
      command: `pnpm ${argv.join(" ")}`,
      observation: "the pnpm call itself failed or exceeded its output cap",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

async function npmGate(id: string, argv: string[], decisiveFor: string): Promise<GateEvidence> {
  try {
    const res = await world.run("npm", argv, { timeoutMs: REPO_CHECK_TIMEOUT_MS });
    return {
      id,
      command: `npm ${argv.join(" ")}`,
      observation: clipObservation(`${res.stdout}\n${res.stderr}`),
      hits: `exitCode=${String(res.exitCode)}`,
      status: res.exitCode === 0 ? "ran" : "probe-failed",
      decisiveFor,
    };
  } catch {
    return {
      id,
      command: `npm ${argv.join(" ")}`,
      observation: "the npm call itself failed or exceeded its output cap",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

async function yarnGate(id: string, argv: string[], decisiveFor: string): Promise<GateEvidence> {
  try {
    const res = await world.run("yarn", argv, { timeoutMs: REPO_CHECK_TIMEOUT_MS });
    return {
      id,
      command: `yarn ${argv.join(" ")}`,
      observation: clipObservation(`${res.stdout}\n${res.stderr}`),
      hits: `exitCode=${String(res.exitCode)}`,
      status: res.exitCode === 0 ? "ran" : "probe-failed",
      decisiveFor,
    };
  } catch {
    return {
      id,
      command: `yarn ${argv.join(" ")}`,
      observation: "the yarn call itself failed or exceeded its output cap",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

async function npxGate(id: string, argv: string[], decisiveFor: string): Promise<GateEvidence> {
  try {
    const res = await world.run("npx", argv, { timeoutMs: REPO_CHECK_TIMEOUT_MS });
    return {
      id,
      command: `npx ${argv.join(" ")}`,
      observation: clipObservation(`${res.stdout}\n${res.stderr}`),
      hits: `exitCode=${String(res.exitCode)}`,
      status: res.exitCode === 0 ? "ran" : "probe-failed",
      decisiveFor,
    };
  } catch {
    return {
      id,
      command: `npx ${argv.join(" ")}`,
      observation: "the npx call itself failed or exceeded its output cap",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

// Bounds text placed into ask text so a large finding set cannot blow the ask past
// what a subagent can read (the constant lives in control flow; its value never
// enters ask text).
function sliceText(text: string): string {
  return text.length > WRITER_FIELD_CAP ? `${text.slice(0, WRITER_FIELD_CAP)}...` : text;
}

async function grepGate(id: string, pattern: string, glob: string, decisiveFor: string): Promise<GateEvidence> {
  try {
    const matches: GrepMatch[] = await files.grep(pattern, glob);
    const sample = matches.slice(0, 6).map((m) => `${m.path}:${String(m.line)}`).join(", ");
    return {
      id,
      command: `grep /${pattern}/ ${glob}`,
      observation: clipObservation(sample === "" ? "no matches" : sample),
      hits: `matches=${String(matches.length)}`,
      status: "ran",
      decisiveFor,
    };
  } catch {
    // files.grep REJECTS over its match/size cap instead of truncating. Record that as
    // unavailable — never as "no matches" (pitfall 41).
    return {
      id,
      command: `grep /${pattern}/ ${glob}`,
      observation: "grep rejected (over its match/size cap or unreadable); absence is NOT established",
      hits: "unavailable",
      status: "probe-failed",
      decisiveFor,
    };
  }
}

async function globPaths(pattern: string): Promise<string[]> {
  try {
    return await files.glob(pattern);
  } catch {
    return [];
  }
}

// ─── Personas (created once at top level; names unique run-wide) ─────────────

const scoperPersona =
  "You scope a deep, checklist-driven UI implementation review run per " +
  `${SKILL_MD}. You read the repository layout, the git-changed files handed to you and ` +
  "the skill's mode-selection section, then decide feature-audit mode versus full-app " +
  "mode and enumerate exactly which files each checklist family will audit. You never " +
  "edit files. Cite path:line (or path plus the listing) for every scope decision. If the " +
  "request cannot be scoped from what is on disk, say so in the gaps list rather than guessing.";

function domainPersona(d: ChecklistDomain): string {
  return (
    "You are a domain auditor in a deep, checklist-driven UI implementation review following " +
    `${SKILL_MD}. Your checklist domain: ${d.title}. You read files in full before judging ` +
    "(pitfall 1 forbids sampling) and cite path:line for every claim. You never edit source " +
    "files. Broken rendering (undefined, [object Object], case mismatch, empty sections) is a " +
    "BUG, never polish (pitfall 11)."
  );
}

const confirmPersona =
  "You are an independent confirmer in a deep UI implementation review. You have seen one " +
  "finding and nothing else. You re-read the cited code yourself and decide confirmed / " +
  "refuted / unverifiable. You never soften a real defect and never confirm one you cannot " +
  "see. Cite path:line for the deciding evidence.";

const gapPersona =
  "You are a coverage sweeper in a deep UI implementation review. Your only job is the " +
  "checklist items handed to you that earlier auditors left uncovered: cover them with " +
  "evidence, or state plainly why they cannot be covered here.";

const livePersona =
  "You run live verification for a deep UI implementation review per " +
  `${SKILL_MD} steps 7a/7b/7e and ${REF_AUTH}. You run the unauthenticated-request recipe ` +
  "yourself and record exact outcomes. Screenshots go to files you create and you return " +
  "their exact paths. You never invent an outcome you did not observe.";

const dedupePersona =
  "You are the triage pass of a deep UI implementation review. You merge duplicate findings " +
  "and enforce the categorization discipline of " +
  `${SKILL_MD} steps 5-6 and pitfalls 6, 11 and 13: broken rendering and inconsistent labels ` +
  "are bug-class findings, never 'polish'.";

const writerPersona =
  "You write the final report of a deep UI implementation review, in the exact section shape " +
  `of ${SKILL_MD} lines 103-125, with live-verification citations on every red finding ` +
  "(step 7g). You invent nothing: every statement comes from the findings, gates and " +
  "evidence handed to you, cited as path:line. Unverified claims are labelled unconfirmed.";

const repairPersona =
  "The run's report file is missing or unreadable at publish time. Rewrite it from the run's " +
  "recorded data handed to you, same sections, at the path you choose, and return the exact " +
  "path you wrote. Write only that one file.";

const planWriterPersona =
  "You convert a completed UI review into a fix plan per " +
  `${REF_HANDOFF}: a findings inventory, two to four clustered phases (red first, security ` +
  "before features, refactors last), per-phase acceptance criteria that close findings by id " +
  "and name a verification target, and every finding mapped to exactly one phase or to " +
  "Out-of-Scope with a rationale. You write exactly one plan file when the run owner approved one.";

const scopeRelayPersona =
  "You are the run owner's decision relay for scope and write permissions. Your only job: " +
  "escalate ONE batched question to the human run owner with the escalate tool — the scope " +
  "summary plus the complete numbered list of proposed permissions and writes — and return " +
  "their answer as the fields you were asked for. Never decide on your own authority; never " +
  "split the list across several escalations (one ask gets three escalations at most). If " +
  "the escalation cannot reach the owner, return obtainedBy 'unreachable' and set every " +
  "permission to its conservative default: no writes, no live checks, no SQL, no repo checks.";

const liveRelayPersona =
  "You are the run owner's decision relay for live verification. Your only job: escalate ONE " +
  "batched question to the human run owner with the escalate tool — the planned live checks " +
  "as a complete numbered list (dev server, unauthenticated and authenticated requests, " +
  "read-only SQL, repo typecheck and unit suite) — and return their answer as the fields you " +
  "were asked for. Never decide on your own authority. If the escalation cannot reach the " +
  "owner, return obtainedBy 'unreachable' and decline everything.";

const planRelayPersona =
  "You are the run owner's decision relay for the fix-plan offer. Your only job: escalate ONE " +
  "question to the human run owner with the escalate tool — offering to create a fix plan " +
  "from the review findings, with the proposed plan path — and return their answer. Never " +
  "decide on your own authority. If the escalation cannot reach the owner, return obtainedBy " +
  "'unreachable' and wantFixPlan false.";

const scopePlanner = agent("scope-planner", { system: scoperPersona });
const scopeRelay = agent("owner-relay-scope", { system: scopeRelayPersona });
const liveRelay = agent("owner-relay-live", { system: liveRelayPersona });
const planRelay = agent("owner-relay-plan", { system: planRelayPersona });
const liveAuditor = agent("live-qa-verify", { system: livePersona });
const deduper = agent("finding-deduper", { system: dedupePersona });
const reportWriter = agent("report-writer", { system: writerPersona });

// ─── Ask-text builders (citations and scope data only; no tunable constants) ─

const DATA_SAFETY =
  "Data safety (applies to you now): run read-only commands only — greps, file reads, ls, " +
  "test -f, and SELECT/COUNT/explain-level SQL if a database is in play. Never run TRUNCATE, " +
  "DELETE, UPDATE, INSERT, ALTER, DROP, CREATE or any migration. Never edit, create or " +
  "delete any file in the target repository unless this ask explicitly records the run " +
  "owner's approval for that exact write. Never start, stop or restart a service unless " +
  "this ask records the run owner's approval for it. Never write a connection string, " +
  "password, API key, session token or any credential value into a returned result, a " +
  "generated file, a screenshot path or any text you produce — name the command shape and " +
  "env var NAMES, not values. If a check is impossible to pass, or your instructions " +
  "contradict each other, escalate and say so plainly rather than working around it or " +
  "inventing findings.";

function scopeAsk(changedPaths: string[], commitSubjects: string[], targetLabel: string): string {
  return [
    "Scope this deep UI implementation review run.",
    `Target: ${targetLabel}. Recent commit subjects: ${commitSubjects.join(" | ")}.`,
    `Changed files vs the requested base: ${changedPaths.join(", ")}`,
    `Mode selection is ${SKILL_MD}:34-38: feature-audit mode when a plan plus feature docs define the target (then W1 loads contract documents per :40-42), full-app mode otherwise (then W2b and W3b additional checks apply per :54-65 and :76-83).`,
    "Enumerate the paths each checklist family will read: plans and contract docs, design-system/token files, screen files, API route files, API client files, shared components, stylesheets. Also record the target platform (Next.js / React Native / Python API) and whether this is a live-operations tool (dismissal queues, dispatch boards, checkout lines, event intake — pitfall 43 territory at SKILL.md:542-553).",
    "Give the base URL for live checks when one is discoverable from package.json scripts, README or docs; empty when unknown.",
    "Also read package.json scripts (and a Makefile or CI config when package.json has none) and return the repo's ACTUAL typecheck and test commands as argv word arrays with the runner first — one of pnpm, npm, yarn, npx — in repoTypecheckCommand and repoTestCommand (for example [\"pnpm\", \"exec\", \"tsc\", \"--noEmit\"]). Empty arrays when the repo defines none; do not invent a runner the repo does not use.",
    "Cite path:line or listing evidence for every scope decision. Return the ReviewScope shape exactly: mode, label, the path lists, baseUrl, repoTypecheckCommand, repoTestCommand, the four platform/tool booleans, rationale, gaps.",
    DATA_SAFETY,
  ].join("\n");
}

function scopeCorrectionAsk(previous: ReviewScope, approval: OwnerScopeApproval): string {
  return [
    "The run owner corrected the scope you proposed for this deep UI implementation review. Re-plan the scope once, applying the correction exactly.",
    `Your previous scope: ${JSON.stringify(previous)}`,
    `The owner's words, verbatim: ${approval.ownerWords}`,
    `The owner's correction: ${approval.correctedScope}`,
    "Apply the correction to the affected lists/labels/flags and return the corrected ReviewScope shape (same fields as before, including repoTypecheckCommand and repoTestCommand). If the correction cannot be applied from what is on disk, keep the affected previous value and say so in gaps.",
    DATA_SAFETY,
  ].join("\n");
}

function domainAsk(d: ChecklistDomain, scope: ReviewScope, gates: GateEvidenceList): string {
  return [
    `Deep UI implementation review — checklist domain: ${d.title}.`,
    `Target: ${scope.label} (mode "${scope.mode}"; Next.js=${String(scope.isNextJs)}, React Native=${String(scope.isReactNative)}, Python API=${String(scope.isPythonApi)}, operational tool=${String(scope.operationalTool)}).`,
    `Checklist items you own and must account for by id: ${d.items.join(", ")}.`,
    `Read first, in full: ${SKILL_MD} (whole file; your items are defined at ${d.skillCites.join("; ")}).`,
    `Also read, in full: ${d.refs.join(" ; ")}.`,
    `What to check in this domain: ${d.focus}`,
    `Files in scope (from the scoper — read every one of yours in full, no sampling): screens=${scope.screenPaths.join(", ")} | api routes=${scope.apiRoutePaths.join(", ")} | api client=${scope.apiClientPaths.join(", ")} | shared components=${scope.sharedComponentPaths.join(", ")} | styles=${scope.stylePaths.join(", ")} | contracts=${scope.planPaths.concat(scope.contractDocPaths).join(", ")} | design system=${scope.designSystemPaths.join(", ")}.`,
    `Deterministic gate results to build on (treat probe-failed as "absence NOT established", per pitfall 41 at SKILL.md:523-525): ${JSON.stringify(gates)}`,
    "Return the DomainAudit shape exactly: domain key, itemsCovered (ids you actually covered with evidence), itemsNotCovered (ids with a reason each — never silently dropped), filesReadInFull, findings (RawFindingList; empty when clean), positives (for SKILL.md:108-109), blockers.",
    "Finding discipline: tier is 'bug' | 'ux' | 'architecture' per SKILL.md:89-97; broken rendering (undefined, [object Object], case mismatch, empty section) is ALWAYS tier 'bug' at severity 'high' or 'medium' (SKILL.md:326); label inconsistency across screens is a bug class (SKILL.md:319, :338-341). Every finding cites path:line in where/evidence and names the checklist ids it closes. Report what is working well too.",
    DATA_SAFETY,
  ].join("\n");
}

function confirmAsk(raw: RawFinding, domainKey: string): string {
  return [
    `Independently verify one finding from checklist domain "${domainKey}" of a deep UI implementation review.`,
    `Finding: ${JSON.stringify(raw)}`,
    "Re-read the cited files yourself (in full where a full read is needed to judge) and decide: 'confirmed' (the defect is real), 'refuted' (it is not), or 'unverifiable' (the evidence cannot decide here).",
    "Return the Confirmation shape exactly: title echo, verdict, evidence (the path:line or command outcome that decides), correctedTier (empty when unchanged; remember SKILL.md:326 makes broken rendering a bug), correctedSeverity (empty when unchanged).",
    DATA_SAFETY,
  ].join("\n");
}

function gapAsk(d: ChecklistDomain, gapItems: string[], scope: ReviewScope, round: number): string {
  return [
    `Coverage sweep round ${String(round)} for checklist domain "${d.title}" of a deep UI implementation review.`,
    `Uncovered checklist items to cover now: ${gapItems.join(", ")}.`,
    `Their definitions: ${d.skillCites.join("; ")} in ${SKILL_MD}; recipes in ${d.refs.join(" ; ")}.`,
    `What to check: ${d.focus}`,
    `Files in scope: screens=${scope.screenPaths.join(", ")} | api routes=${scope.apiRoutePaths.join(", ")} | api client=${scope.apiClientPaths.join(", ")} | shared components=${scope.sharedComponentPaths.join(", ")} | styles=${scope.stylePaths.join(", ")}.`,
    "Return the GapSweep shape exactly: domain key, itemsCovered, itemsNotCovered with reasons, findings (RawFindingList), note.",
    DATA_SAFETY,
  ].join("\n");
}

function liveAsk(scope: ReviewScope, liveApproval: OwnerLiveApproval, authFindings: DetailedFindingList): string {
  return [
    "Do the live verification this UI implementation review requires (SKILL.md:127-150 step 7a, :152-186 step 7b live-verify, :233-245 step 7e).",
    `Target: ${scope.label}; base URL to hit: ${liveApproval.baseUrl === "" ? scope.baseUrl : liveApproval.baseUrl}.`,
    `Run owner's recorded approvals for this step — start dev server: ${String(liveApproval.mayStartDevServer)}; send requests: ${String(liveApproval.mayCurl)}; read-only SQL: ${String(liveApproval.mayRunReadOnlySql)}; repo checks: ${String(liveApproval.mayRunRepoChecks)}; write screenshot files under out/ui-implementation-review/screenshots/: ${String(liveApproval.mayWriteScreenshots)}. Owner words: ${liveApproval.ownerWords}`,
    "Recipe (route-auth-matrix-audit.md step 4): for every mutating route that the static matrix could not clear, send the request with NO auth headers and no cookies and record the status — 401/403 is the passing outcome; any 2xx/3xx on PATCH/PUT/POST/DELETE is a security finding; DELETE must never answer 204/200 unauthenticated. Then the same route with a real authenticated session must still work (multi-source auth pitfall P14 at SKILL.md:342-360 says a passing test suite does not prove the header-only path).",
    "Also verify the client session-restore endpoint is actually called on load (SKILL.md:233-245) and that unauthenticated public-nav targets do not redirect to login (SKILL.md:517-518). When the screenshot-write approval above is true, screenshot the key surfaces you loaded, writing ONLY screenshot files under out/ui-implementation-review/screenshots/, and return their exact paths (embedded in the report as MEDIA:<path> lines). When it is false, write no files and leave screenshotPaths empty, saying so in blockers.",
    `Static-phase findings needing live confirmation: ${JSON.stringify(authFindings)}`,
    "Return the LiveQaReport shape exactly: baseUrlTried, checks (LiveCheckList with command shapes and exact statuses), screenshotPaths, findings (RawFindingList discovered live), blockers.",
    DATA_SAFETY,
  ].join("\n");
}

function dedupeAsk(findings: DetailedFindingList): string {
  return [
    "Triage the findings of a deep UI implementation review: merge duplicates and enforce the categorization discipline.",
    `Findings (id, domain, checklistIds, title, tier, severity, where, what, evidence — long fields truncated): ${JSON.stringify(findings.map((f) => ({ id: f.id, domain: f.domain, checklistIds: f.checklistIds, title: f.title, tier: f.tier, severity: f.severity, where: f.where, what: sliceText(f.what), evidence: sliceText(f.evidence) })))}`,
    "Group findings that are the same defect seen from two domains (keep the earliest id as canonicalId). Correct any tier/severity that violates SKILL.md:89-97, :321, :326 or :338-341 — broken rendering and label inconsistency are bug-class, never polish.",
    "Return the DedupResult shape exactly: groups, corrections, note. Do not drop anything outside the groups you name.",
    DATA_SAFETY,
  ].join("\n");
}

function writerAsk(scope: ReviewScope, findings: DetailedFindingList, positives: string[], gates: GateEvidenceList, live: LiveQaReport | null, mayWriteReport: boolean, mode: string, ownerWords: string): string {
  const liveBlock =
    live === null
      ? "No live verification ran this run (see blockers) — every red finding must say its live status honestly instead of implying one."
      : `Live verification results: ${JSON.stringify(live)}. Embed screenshots as MEDIA:<path> lines using these exact paths: ${live.screenshotPaths.join(", ")}.`;
  // Bounded findings payload: long fields are truncated and, once the running JSON
  // size passes WRITER_JSON_CAP, the tail ships as compact one-line entries so a
  // large review cannot push this ask past what a subagent can read. Nothing is
  // dropped — compact entries keep id/tier/severity/where/title/status.
  const projected: string[] = [];
  let size = 0;
  let overflow = false;
  for (const f of findings) {
    if (overflow) {
      projected.push(JSON.stringify({ id: f.id, tier: f.tier, severity: f.severity, where: f.where, title: f.title, status: f.status, compact: true }));
      continue;
    }
    const entry = JSON.stringify({
      id: f.id,
      domain: f.domain,
      checklistIds: f.checklistIds,
      title: f.title,
      tier: f.tier,
      severity: f.severity,
      where: f.where,
      what: sliceText(f.what),
      evidence: sliceText(f.evidence),
      rootCause: sliceText(f.rootCause),
      fix: sliceText(f.fix),
      effort: f.effort,
      impact: f.impact,
      reproduce: sliceText(f.reproduce),
      status: f.status,
      verdict: sliceText(f.verdict),
    });
    size += entry.length;
    if (size > WRITER_JSON_CAP) overflow = true;
    projected.push(overflow ? JSON.stringify({ id: f.id, tier: f.tier, severity: f.severity, where: f.where, title: f.title, status: f.status, compact: true }) : entry);
  }
  return [
    "Write the final report of this deep UI implementation review.",
    `Target: ${scope.label} (mode "${mode}"). The run owner's scope words on record: ${ownerWords}`,
    `Section shape is exactly ${SKILL_MD}:103-125: What's Working Well; Bugs and Defects (red) — numbered, file:line, root cause, fix; UX Issues (yellow); Missing Features / Gaps; Architecture Issues; Priority Recommendations (a table with effort and impact per :99-101). Every red finding cites its live verification when one exists (SKILL.md:260-262). In feature-audit mode also produce the S1 spreadsheet columns of SKILL.md:564-578 (ID, Section, Feature, Route, User Story, Expected Behavior, Status, Errors Found, Notes).`,
    `Findings to report (already deduplicated, prioritized; status shows verified vs unconfirmed). Entries marked compact:true are the same findings in one-line form — list them in a compact table with their id, tier, severity, where and title; do not expand them and do not omit them: [${projected.join(",\n")}]`,
    `What is working well: ${JSON.stringify(positives)}`,
    `Deterministic gate evidence to cite where relevant (probe-failed means absence is not established): ${JSON.stringify(gates)}`,
    liveBlock,
    `Write permission from the run owner: ${String(mayWriteReport)}. When true, write EXACTLY ONE markdown file under out/ui-implementation-review/ (create that directory if needed) and return its exact path. When false, write nothing and return the full markdown in the markdown field with wroteFile false and an empty path.`,
    "Return the ReportFile shape exactly: wroteFile, path (the exact path you wrote — the run publishes from it), markdown (the full report content either way), title, headline, sectionsIncluded, note.",
    DATA_SAFETY,
  ].join("\n");
}

function repairAsk(markdown: string, title: string, ownerWords: string): string {
  return [
    "The run's report file is missing or unreadable at publish time. Rewrite it from this recorded report content so it can be published:",
    `Title: ${title}`,
    `Content: ${markdown.slice(0, REPAIR_CONTENT_CAP)}`,
    `Recorded run-owner approval this write stands on: the owner approved writing exactly one review report markdown file under out/ui-implementation-review/ (nothing else). Owner words: ${ownerWords} This ask authorizes rewriting exactly that one file; write nothing else.`,
    "Write exactly one markdown file under out/ui-implementation-review/ and return the RepairOutcome shape exactly: rewritten, path (the exact path you wrote), note.",
    DATA_SAFETY,
  ].join("\n");
}

function planAsk(findings: DetailedFindingList, approval: OwnerPlanApproval, mode: string): string {
  return [
    "Create the fix plan this UI implementation review offers (SKILL.md:284-286 step 8), shaped per audit-to-plan-handoff.md.",
    `Mode: ${mode}. The run owner's answer to the offer: ${JSON.stringify(approval)}`,
    `Findings (id, tier, severity, title, where, fix, effort, impact): ${JSON.stringify(findings.map((f) => ({ id: f.id, tier: f.tier, severity: f.severity, title: f.title, where: f.where, fix: f.fix, effort: f.effort, impact: f.impact })))}`,
    "Follow audit-to-plan-handoff.md end to end: findings inventory table (ID | Tier | Title | Files | Effort | Impact), cluster into two to four phases (red first, security before features, refactors last; never one-finding-per-phase), per-phase acceptance criteria that are independently verifiable, close at least one finding by id, and name a grep/verification target; map EVERY finding to exactly one phase or to Out-of-Scope with a rationale. Include the 'Suggested split for subagent dispatch' section the reference describes.",
    "The run owner approved writing exactly one plan file. Write it at the owner's path when one was given, otherwise under docs/plans/. Return the PlanFile shape exactly: wroteFile, path (the exact path you wrote — the run publishes from it), phases, findingIdsCovered, outOfScope, note.",
    DATA_SAFETY,
  ].join("\n");
}

function scopeRelayAsk(scope: ReviewScope): string {
  return [
    "Escalate ONE question to the human run owner and return their answer. The proposed scope for this deep UI implementation review:",
    JSON.stringify(scope),
    "Proposed permissions and writes, to approve or deny as a numbered list in ONE escalation:",
    "1. Write exactly one review report markdown file under out/ui-implementation-review/ (nothing else in the repository is written).",
    "2. Run live checks: start a dev server if needed, send unauthenticated and authenticated HTTP requests to the app, take screenshots.",
    "3. Run read-only SELECT/COUNT SQL against the app database for the [object Object]-in-text-columns checks (SKILL.md:580-588).",
    "4. Run repo-health commands (typecheck, unit suite) as read-only checks.",
    "Return the OwnerScopeApproval shape exactly, with ownerWords quoting the owner and obtainedBy 'approved' | 'corrected' | 'unreachable'.",
    DATA_SAFETY,
  ].join("\n");
}

function liveRelayAsk(scope: ReviewScope, gaps: string[]): string {
  return [
    "Escalate ONE question to the human run owner and return their answer. This UI implementation review wants to run its live verification step (SKILL.md:127-150), and its static pass flagged these gaps that only live checks can clear:",
    gaps.join(" | "),
    `Base URL proposed: ${scope.baseUrl === "" ? "(none discovered — the owner may supply one)" : scope.baseUrl}`,
    "Proposed live operations, to approve or deny as a numbered list in ONE escalation:",
    "1. Start the app's dev server locally for the duration of the live checks.",
    "2. Send unauthenticated and authenticated HTTP requests to the app's routes (including DELETE probes that must be refused).",
    "3. Run read-only SELECT/COUNT SQL against the app database where a data-integrity check needs it.",
    "4. Run repo-health commands (typecheck, unit suite) to confirm the baseline before trusting UI claims.",
    "5. Write screenshot files (and nothing else) under out/ui-implementation-review/screenshots/ for the report's MEDIA:<path> evidence.",
    "Return the OwnerLiveApproval shape exactly, with ownerWords quoting the owner and obtainedBy 'approved' | 'corrected' | 'unreachable'.",
    DATA_SAFETY,
  ].join("\n");
}

function planRelayAsk(findingCount: number, headline: string): string {
  return [
    "Escalate ONE question to the human run owner and return their answer.",
    `Offer, exactly as ${SKILL_MD}:284-286 step 8 requires: the review found ${String(findingCount)} finding(s). ${headline}`,
    "Ask the owner whether to create a fix plan now (phased, per audit-to-plan-handoff.md), and at which path (default docs/plans/).",
    "Return the OwnerPlanApproval shape exactly: ownerWords, obtainedBy ('approved' | 'declined' | 'unreachable'), wantFixPlan, planPath.",
    DATA_SAFETY,
  ].join("\n");
}

// ─── Small pure helpers ─────────────────────────────────────────────────────

function toSeverity(value: string): "low" | "medium" | "high" {
  return value === "high" ? "high" : value === "low" ? "low" : "medium";
}

function toStatus(value: string): "verified" | "unconfirmed" {
  return value === "verified" ? "verified" : "unconfirmed";
}

function toFinding(f: DetailedFinding): Finding {
  return {
    where: `${f.where} [${f.id}]`,
    what: `${f.title} — ${f.what}`,
    evidence: `${f.evidence} (verdict: ${f.verdict})`,
    status: toStatus(f.status),
    severity: toSeverity(f.severity),
  };
}

const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
const tierRank: Record<string, number> = { bug: 0, ux: 1, architecture: 2 };

function compactReportMarkdown(findings: DetailedFindingList, verifiedLines: string[], notCoveredLines: string[]): string {
  const rows = findings.map((f) => `| ${f.id} | ${f.tier} | ${f.severity} | ${f.where} | ${f.title} | ${f.status} |`);
  return [
    "# UI implementation review (compact)",
    "",
    "| ID | Tier | Severity | Where | Title | Status |",
    "|----|------|----------|-------|-------|--------|",
    ...rows,
    "",
    "## Checked",
    ...verifiedLines.map((v) => `- ${v}`),
    "",
    "## Not covered",
    ...notCoveredLines.map((n) => `- ${n}`),
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — Establish what is being reviewed (mode, scope, permissions).
// Deterministic existence probes first; the scoper reads the repo; every write and
// every live/SQL/repo-check permission is granted by the run owner via escalation.
// ═══════════════════════════════════════════════════════════════════════════

phase("Establish what is being reviewed");

const targetLabel = typeof args.target === "string" && args.target !== "" ? args.target : "working tree at HEAD";
const baseArg = typeof args.base === "string" ? args.base : "";

const skillDirGate = await lsGate("G-SKILL-DIR", SKILL_DIR, "all domains");
const skillMdGate = await lsGate("G-SKILL-MD", SKILL_MD, "all domains");
const refsGate = await lsGate("G-REFS", REFS_DIR, "all domains");
const csrfGate = await lsGate("G-CSRF-SKILL", SIBLING_CSRF, "W7e (SKILL.md:655 pointer)");
const sliderGate = await lsGate("G-SLIDER-REF", SIBLING_SLIDER, "P40");
const nextjsGate = await lsGate("G-NEXTJS-SKILL", SIBLING_NEXTJS, "P38");
const authQaGate = await lsGate("G-AUTH-QA-REF", SIBLING_AUTH_QA, "W7a");
const pkgGate = await lsGate("G-PACKAGE", "package.json", "G-TSC, G-TEST");
const tsconfigGate = await lsGate("G-TSCONFIG", "tsconfig.json", "G-TSC");
const docsGate = await lsGate("G-DOCS", "docs", "W1, W4");

let gitBranch = "unknown";
let gitClean = false;
let changedPaths: string[] = [];
let commitSubjects: string[] = [];
try {
  const gitState: GitStatus = await git.status();
  gitBranch = gitState.branch ?? "unknown";
  gitClean = gitState.clean;
} catch {
  gitBranch = "unavailable";
}
try {
  changedPaths = await git.changedFiles(baseArg === "" ? undefined : baseArg);
} catch {
  changedPaths = [];
}
try {
  const commits: GitCommit[] = await git.log(RECENT_COMMIT_COUNT);
  commitSubjects = commits.map((c) => c.subject);
} catch {
  commitSubjects = [];
}
log(`git: branch=${gitBranch} clean=${String(gitClean)} changed=${String(changedPaths.length)} commits=${String(commitSubjects.length)}`);

// Risk control: if the pinned skill contract files are unreadable on this machine,
// ABSTAIN — auditing from memory would be hallucination-prone. Publish the blocked
// fallback (no primary flag on fallbacks) and return an honest blocked report.
if (skillMdGate.status !== "ran" || refsGate.status !== "ran") {
  log(`SKILL.md or references/ unreadable at ${SKILL_DIR} — abstaining instead of auditing from memory`);
  const blockedLines = [
    "# UI implementation review (blocked)",
    "",
    `The skill contract files could not be read at the pinned path (${SKILL_MD}). Every domain ask instructs its auditor to read those files in full first; running without them would invite invented findings, so the run abstains.`,
    "",
    "## Gate evidence",
    ...[skillDirGate, skillMdGate, refsGate, csrfGate, sliderGate, nextjsGate, authQaGate].map((g) => `- ${g.id}: ${g.status} (${g.observation})`),
  ].join("\n");
  try {
    await artifact.markdown("ui-review-report-fallback", blockedLines, {
      title: "UI implementation review (blocked)",
      description: "Abstained: the pinned ui-implementation-review SKILL.md/references are unreadable on this machine; nothing was audited.",
    });
  } catch {
    log("the blocked-run fallback publish was rejected; the return value carries the gate evidence");
  }
  const blocked: WorkflowReport = {
    conclusion: `The run abstained before auditing: ${SKILL_MD} or its references/ directory is unreadable on this machine (gates ${skillMdGate.id}=${skillMdGate.status}, ${refsGate.id}=${refsGate.status}). No checklist domain was audited and no finding is claimed.`,
    findings: [],
    verified: [`existence gates ran via world.run("ls"): ${[skillDirGate, skillMdGate, refsGate].map((g) => `${g.id}=${g.status}`).join(", ")}`],
    notCovered: [
      "the entire checklist audit — the cited contract files are unreadable at the pinned path",
      "move or install the skill at the pinned path (or amend this workflow with the correct path) and re-run",
    ],
  };
  return blocked;
}

const scope = await scopePlanner.ask<ReviewScope>(scopeAsk(changedPaths, commitSubjects, targetLabel));
const scopeApproval = await scopeRelay.ask<OwnerScopeApproval>(scopeRelayAsk(scope));

// Owner corrections are EFFECTIVE: when the owner corrected the scope (and was
// reachable), the scoper re-plans once with the correction applied. If that re-plan
// fails, the scoper's scope stands with the correction recorded in its rationale —
// never silently dropped.
let effectiveScope: ReviewScope = scope;
if (scopeApproval.correctedScope !== "" && scopeApproval.obtainedBy !== "unreachable") {
  try {
    effectiveScope = await scopePlanner.ask<ReviewScope>(scopeCorrectionAsk(scope, scopeApproval));
  } catch {
    effectiveScope = {
      ...scope,
      rationale: `${scope.rationale} Owner correction (re-plan unavailable, recorded only): ${scopeApproval.correctedScope}`,
    };
  }
}

const modeCovered = effectiveScope.mode === "feature-audit" || effectiveScope.mode === "full-app";
if (!modeCovered) {
  log(`mode "${effectiveScope.mode}" is neither feature-audit nor full-app — W-mode goes to notCovered`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Deterministic checklist gates. These are the skill's own grep
// recipes and probe shapes (SKILL.md:156-166, :193-215, :222-231, :240-245,
// :479-482, :517-518, :523-525) run as files.grep / files.read / world.run.
// A rejected or failed gate is "absence NOT established" — never "clean".
// ═══════════════════════════════════════════════════════════════════════════

phase("Run the deterministic checklist checks");

// Direct credential-free probe of the workspace shape (also keeps this phase's own
// world.run / files.grep calls in phase scope).
let workspaceShape = "unavailable";
try {
  const shapeRes = await world.run("ls", ["src"]);
  workspaceShape = clipObservation(shapeRes.stdout !== "" ? shapeRes.stdout : shapeRes.stderr);
} catch {
  workspaceShape = "the ls call itself failed";
}
log(`workspace shape (ls src): ${workspaceShape}`);

const routeJsGate = await grepGate("G-ROUTES-JS", "\\b(get|post|put|patch|delete)\\s*\\(", "src/**/*.ts", "W7b, W7c");
const routeTsxGate = await grepGate("G-ROUTES-TSX", "app\\.(get|post|put|patch|delete)|router\\.(get|post|put|patch|delete)", "src/**/*.tsx", "W7b, W7c");
const routePyGate = await grepGate("G-ROUTES-PY", "@(app|router)\\.(get|post|put|patch|delete)", "app/**/*.py", "W7b, W7c");
const authMwGate = await grepGate("G-AUTH-MW", "requireSession|requireAuth|requirePlatformAdmin|isDmOfCampaign|isOwner|getServerSession|withAuth|verifySession", "src/**/*.ts", "W7b, W7e, P14");
const aHrefGate = await grepGate("G-AHREF", "<a\\s+href=\"/", "src/**/*.tsx", "P26");
const linkImportGate = await grepGate("G-LINK-IMPORT", "next/link", "src/**/*.tsx", "P26");
const escapedEntitiesGate = await grepGate("G-ESCAPED-ENTITIES", "&lt;|&gt;", "src/**/*.js", "P20");
const truncMarkerGate = await grepGate("G-TRUNC-MARKER", "\\.\\.\\.\\[truncated\\]", "src/**/*", "P23");
const hexGate = await grepGate("G-HEX-LITERALS", "#[0-9a-fA-F]{6}\\b", "src/**/*.tsx", "P39");
const tokenVarGate = await grepGate("G-TOKEN-VAR", "var\\(--", "src/**/*.css", "P38, P39, P42");
const hoverGate = await grepGate("G-HOVER-ONLY", "opacity-0", "src/**/*.tsx", "P25");
const portalGate = await grepGate("G-RADIX-PORTAL", "Portal", "src/**/*.tsx", "P42");
const jargonGate = await grepGate("G-DEV-JARGON", "\\bundefined\\b|\\[object Object\\]|\\bNaN\\b", "src/**/*.tsx", "W7f, P11");
const placeholderGate = await grepGate("G-PLACEHOLDER-SLOTS", "Promise\\.resolve\\(0\\)", "src/**/*.ts", "P33");
const emptyCatchGate = await grepGate("G-EMPTY-CATCH", "catch\\s*\\{\\s*\\}", "src/**/*.ts", "P28");

// CSS brace balance (pitfall 21 at SKILL.md:440-459): counted here from the file
// bytes so the check needs no external runtime and can never throw.
let cssFilesChecked = 0;
const cssImbalanced: string[] = [];
const cssCandidates = (await globPaths("src/**/*.css")).concat(await globPaths("app/**/*.css")).concat(await globPaths("styles/**/*.css"));
const cssSeen: Record<string, boolean> = {};
for (const p of cssCandidates) {
  if (cssSeen[p] === true) continue;
  cssSeen[p] = true;
  if (cssFilesChecked >= MAX_CSS_FILES) break;
  try {
    const text = await files.read(p);
    let depth = 0;
    for (const ch of text) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    cssFilesChecked += 1;
    if (depth !== 0) cssImbalanced.push(`${p} (balance ${String(depth)})`);
  } catch {
    cssImbalanced.push(`${p} (unreadable)`);
  }
}
const cssBraceGate: GateEvidence = {
  id: "G-CSS-BRACE",
  command: "files.read brace count over stylesheets (SKILL.md:440-459 recipe)",
  observation: cssImbalanced.length === 0 ? `balanced across ${String(cssFilesChecked)} file(s)` : cssImbalanced.join(", "),
  hits: `checked=${String(cssFilesChecked)} imbalanced=${String(cssImbalanced.length)}`,
  status: "ran",
  decisiveFor: "P21b",
};

// Repo-health gates. EXECUTION IS OWNER-GATED: when the owner declined (or the
// precondition is missing) the command is NOT run and the gate records why — a
// refusal never relabels an already-executed run. The runner comes from the
// scoper's package.json/Makefile/CI discovery; the script branches among LITERAL
// runner commands because world.run's command name must be a compile-time literal.
function skipGate(id: string, command: string, reason: string, status: string): GateEvidence {
  return { id, command, observation: reason, hits: "0", status, decisiveFor: "baseline health" };
}

function runnerGate(id: string, argv: string[], decisiveFor: string): Promise<GateEvidence> {
  const runner = argv.length > 0 ? argv[0] : "";
  const rest = argv.slice(1);
  if (runner === "pnpm") return pnpmGate(id, rest, decisiveFor);
  if (runner === "npm") return npmGate(id, rest, decisiveFor);
  if (runner === "yarn") return yarnGate(id, rest, decisiveFor);
  if (runner === "npx") return npxGate(id, rest, decisiveFor);
  return Promise.resolve(
    skipGate(
      id,
      argv.join(" "),
      `scoper returned a runner this script has no literal gate for (${runner === "" ? "none" : runner}); the gate did NOT execute and absence is not established`,
      "skipped-precondition",
    ),
  );
}

const repoChecksApproved = scopeApproval.mayRunRepoChecks && pkgGate.status === "ran";
let tscGate: GateEvidence;
let testGate: GateEvidence;
if (!repoChecksApproved) {
  const reason = scopeApproval.mayRunRepoChecks ? "no package.json found" : "run owner DECLINED repo-health commands — nothing was executed";
  const status = scopeApproval.mayRunRepoChecks ? "skipped-precondition" : "skipped-owner-declined";
  tscGate = skipGate("G-TSC", effectiveScope.repoTypecheckCommand.join(" ") === "" ? "(scoper found no typecheck command)" : effectiveScope.repoTypecheckCommand.join(" "), reason, status);
  testGate = skipGate("G-TEST", effectiveScope.repoTestCommand.join(" ") === "" ? "(scoper found no test command)" : effectiveScope.repoTestCommand.join(" "), reason, status);
  log("repo-health commands were NOT executed — the gate evidence records the reason");
} else {
  tscGate =
    effectiveScope.repoTypecheckCommand.length > 0
      ? await runnerGate("G-TSC", effectiveScope.repoTypecheckCommand, "baseline health")
      : skipGate("G-TSC", "(none)", "owner approved repo checks but the scoper found no typecheck command in package.json/Makefile/CI", "skipped-precondition");
  testGate =
    effectiveScope.repoTestCommand.length > 0
      ? await runnerGate("G-TEST", effectiveScope.repoTestCommand, "baseline health")
      : skipGate("G-TEST", "(none)", "owner approved repo checks but the scoper found no test command in package.json/Makefile/CI", "skipped-precondition");
}

const gates: GateEvidenceList = [
  skillDirGate,
  skillMdGate,
  refsGate,
  csrfGate,
  sliderGate,
  nextjsGate,
  authQaGate,
  pkgGate,
  tsconfigGate,
  docsGate,
  routeJsGate,
  routeTsxGate,
  routePyGate,
  authMwGate,
  aHrefGate,
  linkImportGate,
  escapedEntitiesGate,
  truncMarkerGate,
  hexGate,
  tokenVarGate,
  hoverGate,
  portalGate,
  jargonGate,
  placeholderGate,
  emptyCatchGate,
  cssBraceGate,
  tscGate,
  testGate,
];

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Audit every checklist domain (concurrent fan-out), confirm every
// non-low finding with an independent confirmer, then bounded coverage sweeps
// for any checklist id no auditor accounted for.
// ═══════════════════════════════════════════════════════════════════════════

phase("Audit every checklist domain");

const activeDomains: ChecklistDomainList = DOMAINS.filter((d) => !d.operationalOnly || effectiveScope.operationalTool);
const skippedDomains: ChecklistDomainList = DOMAINS.filter((d) => d.operationalOnly && !effectiveScope.operationalTool);

interface ConfirmedAudit {
  domain: string;
  itemsCovered: string[];
  itemsNotCovered: NotCoveredList;
  filesReadInFull: string[];
  findings: DetailedFindingList;
  positives: string[];
  blockers: string[];
}

type ConfirmedAuditList = ConfirmedAudit[];

let findingSeq = 0;

const audits: ConfirmedAuditList = await Promise.all(
  activeDomains.map(async (d) => {
    // One malformed domain response must not crash the join and lose the other
    // audits: on failure the domain is recorded as uncovered with a reason, and
    // its owned ids flow into the gap-sweep rounds.
    let audit: DomainAudit;
    try {
      audit = await agent(`ui-domain-${d.key}`, { system: domainPersona(d) }).ask<DomainAudit>(domainAsk(d, effectiveScope, gates));
    } catch {
      log(`the ui-domain-${d.key} auditor session failed — its ${String(d.items.length)} items go to the gap sweeps`);
      return {
        domain: d.key,
        itemsCovered: [] as string[],
        itemsNotCovered: d.items.map((id) => ({ id, reason: "the domain auditor session failed before returning" })),
        filesReadInFull: [] as string[],
        findings: [] as DetailedFindingList,
        positives: [] as string[],
        blockers: [`the ui-domain-${d.key} auditor session failed`],
      } satisfies ConfirmedAudit;
    }
    const accepted: DetailedFindingList = [];
    // Confirmations are capped per domain (control-flow constant): past the cap,
    // remaining high/medium findings ship as unconfirmed by rule, so a large
    // repo cannot fan out an unbounded number of confirmer subagents.
    let confirmationsUsed = 0;
    for (let fi = 0; fi < audit.findings.length; fi++) {
      const raw = audit.findings[fi];
      findingSeq += 1;
      const id = `F${String(findingSeq).padStart(3, "0")}`;
      let status = "unconfirmed";
      let verdict = "low-severity-not-confirmed";
      let tier = raw.tier;
      let severity = raw.severity;
      let evidence = raw.evidence;
      if (CONFIRM_ONLY_SEVERITIES.indexOf(raw.severity) >= 0 && confirmationsUsed < MAX_CONFIRMATIONS_PER_DOMAIN) {
        confirmationsUsed += 1;
        try {
          const verdictResult = await agent(`ui-confirm-${d.key}-${String(fi)}`, { system: confirmPersona }).ask<Confirmation>(confirmAsk(raw, d.key));
          verdict = verdictResult.verdict;
          evidence = `${raw.evidence} || confirmer: ${verdictResult.evidence}`;
          if (verdictResult.correctedTier !== "") tier = verdictResult.correctedTier;
          if (verdictResult.correctedSeverity !== "") severity = verdictResult.correctedSeverity;
          if (verdict === "confirmed") status = "verified";
          if (verdict === "refuted") {
            // Refuted findings are kept as evidence of the check, explicitly labelled.
            status = "unconfirmed";
          }
        } catch {
          verdict = "confirmer-unavailable";
          status = "unconfirmed";
        }
      } else if (CONFIRM_ONLY_SEVERITIES.indexOf(raw.severity) >= 0) {
        verdict = "confirm-cap-reached";
        status = "unconfirmed";
      }
      const landed: DetailedFinding = {
        id,
        domain: d.key,
        checklistIds: raw.checklistIds,
        title: raw.title,
        tier,
        severity,
        where: raw.where,
        what: raw.what,
        evidence,
        rootCause: raw.rootCause,
        fix: raw.fix,
        effort: raw.effort,
        impact: raw.impact,
        reproduce: raw.reproduce,
        status,
        verdict,
      };
      accepted.push(landed);
      report(toFinding(landed));
    }
    return {
      domain: d.key,
      itemsCovered: audit.itemsCovered,
      itemsNotCovered: audit.itemsNotCovered,
      filesReadInFull: audit.filesReadInFull,
      findings: accepted,
      positives: audit.positives,
      blockers: audit.blockers,
    };
  }),
);

// Coverage accounting over all 75 checklist ids.
const coveredIds: string[] = [];
const acknowledgedIds: string[] = [];
const positivesAll: string[] = [];
const blockersAll: string[] = [];
const filesReadAll: string[] = [];
const detailed: DetailedFindingList = [];
for (const a of audits) {
  for (const id of a.itemsCovered) coveredIds.push(id);
  for (const nc of a.itemsNotCovered) acknowledgedIds.push(nc.id);
  for (const p of a.positives) positivesAll.push(p);
  for (const b of a.blockers) blockersAll.push(b);
  for (const f of a.filesReadInFull) filesReadAll.push(f);
  for (const f of a.findings) detailed.push(f);
}
if (modeCovered) coveredIds.push("W-mode");
for (const sd of skippedDomains) {
  for (const id of sd.items) acknowledgedIds.push(id);
}

// Skipped-domain ids are acknowledged as not-applicable, never silently dropped.
const ownerDeclinedNotes: string[] = [];
for (const sd of skippedDomains) {
  ownerDeclinedNotes.push(`${sd.items.join(", ")} (${sd.title}): not applicable — the target is not a live-operations tool (pitfall 43 scope condition)`);
}

// Bounded gap sweeps for ids nobody covered or acknowledged.
for (let round = 1; round <= MAX_GAP_ROUNDS; round++) {
  const allIds: string[] = [];
  for (const d of DOMAINS) {
    for (const it of d.items) allIds.push(it);
  }
  const missingByDomain: Record<string, string[]> = {};
  for (const it of allIds) {
    if (coveredIds.indexOf(it) >= 0) continue;
    if (acknowledgedIds.indexOf(it) >= 0) continue;
    for (const d of activeDomains) {
      if (d.items.indexOf(it) >= 0) {
        const bucket = missingByDomain[d.key];
        if (bucket === undefined) missingByDomain[d.key] = [it];
        else bucket.push(it);
      }
    }
  }
  const keys = Object.keys(missingByDomain);
  if (keys.length === 0) break;
  log(`coverage gap round ${String(round)}: ${keys.map((k) => `${k}=${(missingByDomain[k] ?? []).join("+")}`).join(", ")}`);
  const sweepResults = await Promise.all(
    keys.map(async (k) => {
      const d = activeDomains.find((x) => x.key === k);
      const gapItems = missingByDomain[k] ?? [];
      if (d === undefined) return null;
      try {
        return await agent(`ui-gaps-${d.key}-r${String(round)}`, { system: gapPersona }).ask<GapSweep>(gapAsk(d, gapItems, effectiveScope, round));
      } catch {
        return null;
      }
    }),
  );
  for (const sr of sweepResults) {
    if (sr === null) continue;
    for (const id of sr.itemsCovered) coveredIds.push(id);
    for (const nc of sr.itemsNotCovered) acknowledgedIds.push(nc.id);
    for (const raw of sr.findings) {
      findingSeq += 1;
      const landed: DetailedFinding = {
        id: `F${String(findingSeq).padStart(3, "0")}`,
        domain: sr.domain,
        checklistIds: raw.checklistIds,
        title: raw.title,
        tier: raw.tier,
        severity: raw.severity,
        where: raw.where,
        what: raw.what,
        evidence: raw.evidence,
        rootCause: raw.rootCause,
        fix: raw.fix,
        effort: raw.effort,
        impact: raw.impact,
        reproduce: raw.reproduce,
        status: "unconfirmed",
        verdict: "gap-sweep-not-confirmed",
      };
      detailed.push(landed);
      report(toFinding(landed));
    }
  }
}

const allIdsFinal: string[] = [];
for (const d of DOMAINS) {
  for (const it of d.items) allIdsFinal.push(it);
}
const stillMissing: string[] = [];
for (const it of allIdsFinal) {
  if (coveredIds.indexOf(it) < 0 && acknowledgedIds.indexOf(it) < 0) stillMissing.push(it);
}
if (stillMissing.length > 0) {
  log(`ids still unaccounted after gap sweeps: ${stillMissing.join(", ")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Live verification (SKILL.md:127-150). Mandatory on auth/CORS work;
// always proposed to the owner, who grants it by escalation. Runs only what the
// owner approved.
// ═══════════════════════════════════════════════════════════════════════════

phase("Verify live where the skill demands it");

const liveGaps = detailed
  .filter((f) => f.domain === "auth" || f.domain === "nav")
  .map((f) => `${f.id} ${f.title} @ ${f.where}`);
const liveApproval = await liveRelay.ask<OwnerLiveApproval>(liveRelayAsk(effectiveScope, liveGaps.length > 0 ? liveGaps : ["static pass found no auth/nav findings; the matrix's live-verify step still applies to mutating routes"]));

let live: LiveQaReport | null = null;
if (liveApproval.mayCurl && liveApproval.obtainedBy !== "unreachable") {
  const authFindings = detailed.filter((f) => f.domain === "auth");
  try {
    live = await liveAuditor.ask<LiveQaReport>(liveAsk(effectiveScope, liveApproval, authFindings));
    for (const raw of live.findings) {
      findingSeq += 1;
      const landed: DetailedFinding = {
        id: `F${String(findingSeq).padStart(3, "0")}`,
        domain: "auth",
        checklistIds: raw.checklistIds,
        title: raw.title,
        tier: raw.tier,
        severity: raw.severity,
        where: raw.where,
        what: raw.what,
        evidence: raw.evidence,
        rootCause: raw.rootCause,
        fix: raw.fix,
        effort: raw.effort,
        impact: raw.impact,
        reproduce: raw.reproduce,
        status: "verified",
        verdict: "confirmed-by-live-check",
      };
      detailed.push(landed);
      report(toFinding(landed));
    }
  } catch {
    live = null;
    blockersAll.push("live verification could not run (the live-qa-verify session failed)");
  }
} else {
  blockersAll.push(
    liveApproval.obtainedBy === "unreachable"
      ? "live verification did not run — the run owner could not be reached to approve it"
      : "live verification did not run — the run owner declined it",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Deduplicate, correct categorization, prioritize (SKILL.md:89-101,
// :321; pitfalls 6, 11, 13).
// ═══════════════════════════════════════════════════════════════════════════

phase("Deduplicate, triage, and rank the findings");

let triageNote = "no triage pass ran";
const deduped: DetailedFindingList = [];
{
  let dedupResult: DedupResult | null = null;
  if (detailed.length > 0) {
    try {
      dedupResult = await deduper.ask<DedupResult>(dedupeAsk(detailed));
      triageNote = dedupResult.note;
    } catch {
      dedupResult = null;
      triageNote = "triage pass unavailable — findings shipped unmerged, ranked by severity then tier";
    }
  }
  const droppedIds: string[] = [];
  const correctionById: Record<string, TierCorrection> = {};
  if (dedupResult !== null) {
    for (const g of dedupResult.groups) {
      for (const dup of g.duplicateIds) {
        if (dup !== g.canonicalId) droppedIds.push(dup);
      }
    }
    for (const c of dedupResult.corrections) correctionById[c.findingId] = c;
  }
  for (const f of detailed) {
    if (droppedIds.indexOf(f.id) >= 0) continue;
    const c = correctionById[f.id];
    if (c === undefined) {
      deduped.push(f);
    } else {
      deduped.push({
        ...f,
        tier: c.tier === "" ? f.tier : c.tier,
        severity: c.severity === "" ? f.severity : c.severity,
        evidence: `${f.evidence} || triage: ${c.reason}`,
      });
    }
  }
}

deduped.sort((a, b) => {
  const s = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
  if (s !== 0) return s;
  const t = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
});

// Findings were reported at landing (domain callback, gap sweeps, live pass);
// the triage corrections here flow into the return value and the report artifact.
log(`findings after triage: ${String(deduped.length)} (from ${String(detailed.length)} raw); ${triageNote}`);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — Write and publish the review report (SKILL.md:103-125). One
// primary artifact id, published from the path the writer returned, with a
// compact fallback that carries no primary flag.
// ═══════════════════════════════════════════════════════════════════════════

phase("Write the review report");

const notCoveredLines: string[] = [];
for (const note of ownerDeclinedNotes) {
  notCoveredLines.push(note);
}
for (const a of audits) {
  for (const nc of a.itemsNotCovered) notCoveredLines.push(`${nc.id}: ${nc.reason}`);
}
for (const it of stillMissing) {
  notCoveredLines.push(`${it}: no auditor accounted for it within the coverage sweep rounds`);
}
for (const b of blockersAll) notCoveredLines.push(`blocked: ${b}`);
if (csrfGate.status !== "ran") {
  notCoveredLines.push("W7e client-csrf-token-store reference (SKILL.md:655): the referenced skill directory is missing on this machine, so its checklist could not be applied");
}
if (live === null) {
  notCoveredLines.push("W7a/7b live-verify outcomes: no live checks ran this run");
}

const verifiedLines: string[] = [
  `skill and references presence probed with world.run("ls"): ${[skillDirGate, skillMdGate, refsGate, csrfGate, sliderGate, nextjsGate, authQaGate].map((g) => `${g.id}=${g.status}`).join(", ")}`,
  `deterministic gates ran as files.grep / files.read / world.run: ${gates.filter((g) => g.status === "ran").length} of ${gates.length} ran; a probe-failed gate never established absence (pitfall 41)`,
  `checklist coverage: ${coveredIds.length} of ${allIdsFinal.length} ids covered with evidence, ${acknowledgedIds.length} acknowledged not-covered, ${stillMissing.length} unaccounted`,
  `domain fan-out ran ${activeDomains.length} auditors (ui-domain-<key>) plus ${detailed.length > 0 ? `per-finding confirmers on the first ${MAX_CONFIRMATIONS_PER_DOMAIN} high/medium findings per domain (ui-confirm-<key>-<i>); a domain's further high/medium findings ship as confirm-cap-reached/unconfirmed` : "no confirmers (no findings)"}; low-severity findings ship as unconfirmed`,
  `live verification: ${live === null ? "not run" : `${live.checks.length} check(s) against ${live.baseUrlTried}, ${live.screenshotPaths.length} screenshot(s) written`}`,
  `triage: ${triageNote}`,
  `owner gates reached by escalation: scope and write permissions (${scopeApproval.obtainedBy}), live/SQL/repo-check permissions (${liveApproval.obtainedBy})`,
];

const reportResult = await reportWriter.ask<ReportFile>(
  writerAsk(effectiveScope, deduped, positivesAll, gates, live, scopeApproval.mayWriteReport, effectiveScope.mode, scopeApproval.ownerWords),
);

let publishPath = reportResult.path;
if (reportResult.wroteFile && publishPath !== "") {
  const reportPathGate = await lsGate("G-REPORT-PATH", publishPath, "publish step (lesson: publish from the writer-returned path)");
  if (reportPathGate.status !== "ran") {
    log(`the writer-returned report path ${publishPath} is not readable — asking for a rewrite before publishing`);
    try {
      const repair = await agent("report-repairer", { system: repairPersona }).ask<RepairOutcome>(repairAsk(reportResult.markdown, reportResult.title, scopeApproval.ownerWords));
      if (repair.rewritten && repair.path !== "") {
        publishPath = repair.path;
      } else {
        publishPath = "";
      }
    } catch {
      publishPath = "";
    }
  }
}

const compactMarkdown = compactReportMarkdown(deduped, verifiedLines, notCoveredLines);
let publishedPrimary = false;
if (reportResult.wroteFile && publishPath !== "") {
  try {
    await artifact.file("ui-review-report", publishPath, {
      title: reportResult.title === "" ? "UI implementation review" : reportResult.title,
      description: reportResult.headline,
      primary: true,
    });
    publishedPrimary = true;
  } catch {
    log("the report file publish was rejected — the fallback markdown publish takes over");
  }
}
if (!publishedPrimary) {
  const fullContent =
    reportResult.markdown.length > MARKDOWN_CAP
      ? compactMarkdown
      : reportResult.markdown !== ""
        ? reportResult.markdown
        : compactMarkdown;
  try {
    await artifact.markdown("ui-review-report-fallback", fullContent, {
      title: reportResult.title === "" ? "UI implementation review" : `${reportResult.title} (fallback publish)`,
      description:
        reportResult.wroteFile && publishPath === ""
          ? "The report file could not be published from disk; this is the full report content."
          : "The run owner declined file writes; the full report content ships here.",
    });
  } catch {
    try {
      await artifact.markdown("ui-review-report-fallback", compactMarkdown.slice(0, MARKDOWN_CAP), {
        title: "UI implementation review (compact)",
        description: "The full report rejected publication; this is the compact findings table of the same run.",
      });
    } catch {
      log("both report publishes were rejected — findings for salvage:");
      log(compactMarkdown.slice(0, 4000));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — Offer the fix plan (SKILL.md:284-286), gated on the run owner's
// answer. Writing the plan is a write and needs its own recorded approval.
// ═══════════════════════════════════════════════════════════════════════════

phase("Offer the fix plan the skill asks for");

const headlineForOffer =
  deduped.length > 0
    ? `Top finding: ${deduped[0].title} at ${deduped[0].where} (tier ${deduped[0].tier}, severity ${deduped[0].severity}).`
    : "No findings were confirmed; a plan would document the verified-clean areas.";
const planApproval = await planRelay.ask<OwnerPlanApproval>(planRelayAsk(deduped.length, headlineForOffer));

let planWritten = false;
let planPathUsed = "";
if (planApproval.wantFixPlan && planApproval.obtainedBy !== "unreachable") {
  try {
    const plan = await agent("fix-plan-writer", { system: planWriterPersona }).ask<PlanFile>(planAsk(deduped, planApproval, effectiveScope.mode));
    planWritten = plan.wroteFile;
    planPathUsed = plan.path;
    const planCompact = [
      "# Fix plan (compact)",
      "",
      `Phases: ${plan.phases.join(" | ")}`,
      "",
      "## Finding coverage",
      ...plan.findingIdsCovered.map((x) => `- ${x}`),
      "",
      "## Out of scope",
      ...plan.outOfScope.map((x) => `- ${x}`),
    ].join("\n");
    if (plan.wroteFile && plan.path !== "") {
      try {
        await artifact.file("fix-plan", plan.path, {
          title: "Fix plan",
          description: `Phased remediation plan from the UI implementation review (${plan.phases.length} phases).`,
        });
      } catch {
        try {
          await artifact.markdown("fix-plan-compact", planCompact.slice(0, MARKDOWN_CAP), {
            title: "Fix plan (compact)",
            description: "The plan file could not be published; this is the phase and coverage summary.",
          });
        } catch {
          log("fix-plan publishes were rejected — plan path on record: " + planPathUsed);
        }
      }
    } else {
      try {
        await artifact.markdown("fix-plan-compact", planCompact.slice(0, MARKDOWN_CAP), {
          title: "Fix plan (compact)",
          description: "No plan file was written; this is the phase and coverage summary the planner returned.",
        });
      } catch {
        log("fix-plan-compact publish was rejected");
      }
    }
  } catch {
    log("the fix-plan writer session failed — no plan was created");
    verifiedLines.push("fix plan: the writer session failed, so no plan file exists");
  }
} else {
  log(
    planApproval.obtainedBy === "unreachable"
      ? "fix-plan offer unanswered (owner unreachable) — no plan written"
      : "fix-plan offer declined — no plan written",
  );
}

// ─── Return (model-facing; the report artifact is the user-facing deliverable) ─

const conclusionParts: string[] = [];
conclusionParts.push(
  `Deep UI implementation review of ${effectiveScope.label} in ${effectiveScope.mode} mode: ` +
    `${coveredIds.length} of ${allIdsFinal.length} checklist items covered with evidence across ${activeDomains.length} domains.`,
);
if (deduped.length > 0) {
  const bugCount = deduped.filter((f) => f.tier === "bug").length;
  const highCount = deduped.filter((f) => f.severity === "high").length;
  conclusionParts.push(
    `${deduped.length} finding(s) after triage (${bugCount} bug-class, ${highCount} high severity); top: ${deduped[0].title} at ${deduped[0].where}.`,
  );
} else {
  conclusionParts.push("No findings survived triage in the covered scope.");
}
conclusionParts.push(
  publishedPrimary
    ? `The full report was published from ${publishPath}.`
    : "The full report shipped as the fallback markdown artifact.",
);
conclusionParts.push(
  planWritten
    ? `Fix plan written at ${planPathUsed}.`
    : planApproval.wantFixPlan
      ? "The owner asked for a fix plan but none could be written."
      : "No fix plan was requested.",
);

const result: WorkflowReport = {
  conclusion: conclusionParts.join(" "),
  findings: deduped.map((f) => toFinding(f)),
  verified: verifiedLines,
  notCovered: notCoveredLines,
};
return result;
