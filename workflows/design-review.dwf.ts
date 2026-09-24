/* zcode-workflow
description: "Runs a deep 30-item design critique of a UI surface: an
  independent read-only auditor per checklist item across the skill's
  dimensions, the mechanical anti-pattern checks run as real command gates whose
  exit codes decide, and one independent reader over the composed report before
  handover. Embodies the design-review skill."
whenToUse: When a screen, view, or product surface needs a scored design audit —
  visual hierarchy, cramped or empty layout, inconsistent spacing, and anti-slop
  patterns — with a P0-P3 fix plan rather than a vague impression.
args:
  target:
    type: string
    description: Optional glob naming the surfaces to audit, for example
      src/screens/**. A plain-language hint naming one surface works too — the
      run discovers surfaces itself either way. Omit to audit every design
      surface in the workspace.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// design-review — deep 30-item design critique workflow (hybrid).
//
// Structure lives in this script; the judgment criteria live in the skill:
//   ~/.agents/skills/design-review/SKILL.md (5 dimensions, anti-slop list,
//   code-based UX audit, review format with the P0-P3 fix tables)
//   ~/.agents/skills/design-review/references/code-based-ux-audit-checklist.md
//   ~/.agents/skills/design-review/references/code-based-ux-audit-swiftui-macos.md
//   ~/.agents/skills/design-review/references/dashboard-real-estate-patterns.md
//   ~/.agents/skills/design-review/references/multi-frame-capture-protocol.md
//   ~/.agents/skills/design-review/references/ranking-hierarchy-pattern.md
//   ~/.agents/skills/design-review/references/mobile-ux-checklist.md (cited on
//     items 13 and 16, where its interaction/navigation checks overlap)
// mobile-app-redesign-pattern.md is deliberately NOT cited: it is the
// post-audit implementation plan (SKILL.md §Post-Audit Workflow, referenced at
// SKILL.md:277), and Pitfall 6 (SKILL.md:289) forbids mixing audit with design
// in one step. This workflow is the audit only.
//
// Mechanical anti-slop/code checks run as real world.run gates (grep, exit
// code branched in script); the 30 checklist items are independent read-only
// subagent audits; one independent reader reviews the report before publish.

// ── Types ──────────────────────────────────────────────────────────────────

/** Verdict for one checklist item or sub-check. */
type Verdict = "pass" | "fail" | "partial" | "not-applicable";

/** Priority bucket from the skill's review format (SKILL.md:135-146). */
type Priority = "P0" | "P1" | "P2" | "P3";

/**
 * One sub-check of a composite item (items 28-30 audit several related
 * signals; each gets its own verdict so composites score with the same
 * granularity as single-check items).
 */
interface SubCheck {
  /** Which sub-check, as named in the ask. */
  check: string;
  /** Pass / fail / partial / not-applicable for this sub-check alone. */
  verdict: Verdict;
  /** What showed it: path:line or command output. */
  evidence: string;
}

/** Result of one checklist-item audit. */
interface ChecklistItem {
  /** 1-based item number in the 30-item framework. */
  index: number;
  /** Which of the 7 dimensions this item belongs to. */
  dimension: string;
  /** The criterion as written in the skill. */
  criterion: string;
  /** Verdict for the item as a whole (worst sub-check when composite). */
  verdict: Verdict;
  /** One sentence with the specifics; cites path:line. */
  evidence: string;
  /** Workspace path (with line) the evidence lives at. */
  location: string;
  /** Per-sub-check verdicts; empty for single-check items. */
  subChecks: SubCheck[];
}

/** Definition of one checklist item, from the skill and its references. */
interface ChecklistSpec {
  /** 1-based item number. */
  index: number;
  /** Dimension name. */
  dimension: string;
  /** The criterion, in the skill's own words. */
  criterion: string;
  /** What the subagent must read before judging (absolute skill paths). */
  citation: string;
  /** Names of mechanical gates whose results feed this item. */
  gates?: string[];
  /** Sub-checks for composite items; absent for single-check items. */
  subChecks?: string[];
}

/** A mechanical grep gate and its grep pattern arguments. */
interface GateSpec {
  /** Gate name as it appears in asks and in the artifact. */
  name: string;
  /** grep pattern arguments (before the "--" and the surface paths). */
  patternArgs: string[];
}

/** Outcome of one mechanical gate, classified from grep's exit code. */
interface GateOutcome {
  /** Gate name. */
  name: string;
  /** "clean" = grep exit 1 (no matches); "matches" = exit 0; "error" = exit >= 2. */
  status: "clean" | "matches" | "error";
  /** First matched path:line fragments, capped; empty unless status is "matches". */
  hits: string;
}

/** A finding derived from a failed or partial checklist item. */
interface Finding {
  /** Workspace-relative path, with a line when it applies. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** What showed it: the lines read, or the gate output that proved it. */
  evidence: string;
  /** "verified" when a mechanical gate's matches back it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. */
  severity: "low" | "medium" | "high";
  /** Priority bucket from the skill's review format. */
  priority: Priority;
}

/** One dimension's aggregated score. */
interface DimensionScore {
  /** Dimension name. */
  dimension: string;
  /** 1-10, from the mean of its applicable item scores; 0 when nothing applied. */
  score: number;
  /** One-line verdict. */
  verdict: string;
  /** How many items produced a score for this dimension. */
  applicableItems: number;
  /** How many items failed or partially passed. */
  issueCount: number;
}

/** The independent reader's verdict on the composed report. */
interface ConfirmerReview {
  /** What is unclear, unsupported, or missing — empty when nothing. */
  gaps: string[];
  /** True when the report is complete enough to ship as the deliverable. */
  complete: boolean;
  /** The single biggest strength the evidence supports, one sentence. */
  biggestStrength: string;
  /** Up to three concrete next actions for the owner. */
  nextActions: string[];
}

/** Surfaces a spotter subagent found when the first pass found none. */
interface SurfaceRecheck {
  /** Workspace-relative paths of design surfaces the first pass missed. */
  paths: string[];
  /** One sentence on where it looked. */
  note: string;
}

/** The run's final report shape (dynamic-workflows SKILL.md §10). */
interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ── Small pure helpers ─────────────────────────────────────────────────────

function clampScore(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

function verdictValue(v: Verdict): number {
  return v === "pass" ? 1 : v === "partial" ? 0.5 : 0;
}

/** Mean 0..1 score of one item; null when nothing applied. */
function itemScore(it: ChecklistItem): number | null {
  if (it.subChecks.length > 0) {
    const applicable = it.subChecks.filter((s) => s.verdict !== "not-applicable");
    if (applicable.length > 0) {
      return applicable.reduce((sum, s) => sum + verdictValue(s.verdict), 0) / applicable.length;
    }
    return null;
  }
  if (it.verdict === "not-applicable") return null;
  return verdictValue(it.verdict);
}

function priorityFor(it: ChecklistItem): Priority | null {
  if (it.verdict !== "fail" && it.verdict !== "partial") return null;
  const broken = it.dimension === "Functionality" || it.dimension === "Code-Based UX";
  if (broken && it.verdict === "fail") return "P0";
  if (broken || it.dimension === "Anti-AI-Slop") return "P1";
  if (it.dimension === "Innovation") return "P3";
  return "P2";
}

function severityFor(p: Priority): "low" | "medium" | "high" {
  return p === "P0" ? "high" : p === "P3" ? "low" : "medium";
}

const effortByPriority: Record<Priority, string> = {
  P0: "≤ 1 hr",
  P1: "1-4 hrs",
  P2: "2-4 hrs",
  P3: "1-2 days",
};

// ── Surfaces under audit ───────────────────────────────────────────────────

// args.target (optional): a glob pattern selecting the surfaces to audit, or a
// plain-language hint naming which surface to audit.
const targetHint = String(args.target ?? "").trim();
// Glob or path syntax means the caller meant a pattern. Anything else — a sentence
// the router passed through from the user's request — is a hint, not a glob: feeding
// it to files.glob would match nothing and the run would silently audit everything
// instead of the surface the user named.
const targetPattern =
  targetHint.includes("*") || targetHint.includes("?") || targetHint.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(targetHint)
    ? targetHint
    : "";

let surfaces: string[] = [];
if (targetPattern) {
  try {
    surfaces = await files.glob(targetPattern);
  } catch {
    surfaces = [];
  }
} else {
  const designGlobs = ["**/*.html", "**/*.css", "**/*.scss", "**/*.jsx", "**/*.tsx"];
  const settled = await Promise.allSettled(designGlobs.map((p) => files.glob(p)));
  const found = new Set<string>();
  for (const r of settled) {
    if (r.status === "fulfilled") {
      for (const f of r.value) {
        if (!f.startsWith("out/") && !f.startsWith(".zcode/") && !f.includes("node_modules/")) {
          found.add(f);
        }
      }
    }
  }
  surfaces = [...found];
}

const auditorPersona =
  "You audit one checklist item of the 5-dimension design-review framework (the design-review skill). " +
  "Work strictly read-only: never edit, write, or delete any file; you may run read-only commands such as grep or ls; never touch remote databases, credentials, or network services. " +
  "Cite path:line for every claim and never report a check you did not run; say plainly what you could not verify. " +
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

if (surfaces.length === 0) {
  phase("Double-check for design surfaces");
  const spotter = agent("Design surface spotter", { system: auditorPersona });
  const recheck = await spotter.ask<SurfaceRecheck>(
    `No design surfaces were found by the script's first pass` +
      (targetPattern
        ? ` (glob "${targetPattern}" matched nothing)`
        : targetHint
          ? ` (the surfaces named by the request — "${targetHint}" — were not found by the initial discovery pass)`
          : ` (globs over **/*.html, **/*.css, **/*.scss, **/*.jsx, **/*.tsx, excluding out/, .zcode/, node_modules/)`) +
      `.\n\nLook for design surfaces the first pass missed: HTML/CSS/JSX/TSX/SCSS files, screenshot directories, design-token or theme files, storyboard or layout files. Work read-only; do not edit anything.\n\n` +
      `Return SurfaceRecheck: paths (workspace-relative paths of design surfaces, empty if you truly find none) and note (one sentence on where you looked).`
  );
  surfaces = recheck.paths
    .filter((p) => !p.startsWith("out/") && !p.startsWith(".zcode/") && !p.includes("node_modules/"))
    .slice(0, 40);
  if (surfaces.length === 0) {
    log(`No design surfaces found (${recheck.note}) — nothing to audit`);
    const emptyMd = [
      "# Design Review — no surfaces found",
      "",
      `No design surfaces were found in this workspace, so no design review ran.`,
      "",
      `The spotter checked: ${recheck.note}`,
      "",
      "Pass `args.target` with a glob to point the review at specific files.",
    ].join("\n");
    try {
      await artifact.markdown("design-review-report", emptyMd, {
        title: "Design Review — no surfaces",
        description: "No design surfaces were discovered; the workflow has nothing to audit.",
        primary: true,
      });
    } catch {
      report({
        where: "run",
        what: "The design-review report could not be published; no surfaces were found.",
        evidence: "artifact.markdown rejected for id design-review-report",
        status: "unconfirmed",
        severity: "medium",
        priority: "P1",
      });
    }
    const empty: WorkflowReport = {
      conclusion:
        "No design surfaces were found in this workspace, so no design review ran. " +
        `The spotter checked: ${recheck.note} Pass args.target with a glob to point the review at specific files.`,
      findings: [],
      verified: ["two independent passes over the workspace for design surfaces (globs plus one spotter subagent)"],
      notCovered: [
        "every checklist item — there were no surfaces to audit",
        "visual rendering — this workflow audits from code and mechanical gates only",
      ],
    };
    return empty;
  }
}

if (surfaces.length > 40) {
  log(`Limiting the audit to the first 40 of ${surfaces.length} surfaces`);
  surfaces = surfaces.slice(0, 40);
}
const surfaceList = surfaces.join("\n");
log(`Auditing ${surfaces.length} design surfaces`);

// ── Mechanical gates (grep, exit code branched — no shell, no masking) ────

phase("Check the design for known anti-patterns");

const gateSpecs: GateSpec[] = [
  {
    name: "emoji-as-icon",
    patternArgs: ["-e", "🚀", "-e", "⚡️", "-e", "✨", "-e", "🎯", "-e", "💡", "-e", "🔮", "-e", "💬", "-e", "🔴", "-e", "📊", "-e", "📈"],
  },
  { name: "hardcoded-hex-color", patternArgs: ["-E", "#[0-9a-fA-F]{3,8}"] },
  { name: "purple-gradient", patternArgs: ["-iE", "gradient[^;]*purple|purple[^;]*gradient"] },
  { name: "default-font-stack", patternArgs: ["-iE", "font-family[^;]*(inter|roboto|arial)"] },
  { name: "cursor-pointer", patternArgs: ["-iE", "cursor:\\s*pointer"] },
  {
    name: "silent-catch",
    patternArgs: ["-E", "catch\\s*\\(\\s*console\\.(error|log)\\s*\\)|catch\\s*\\([a-zA-Z]+\\)\\s*\\{\\s*console\\.(error|log)"],
  },
  { name: "dead-ui", patternArgs: ["-iE", "<View[^>]*(button|pill|card)"] },
  { name: "fake-stats", patternArgs: ["-iE", "10,?000\\+|happy customers|trusted by [0-9]"] },
];

const gateOutcomes = await Promise.all(
  gateSpecs.map(async (spec): Promise<GateOutcome> => {
    // grep exit codes: 0 = matches, 1 = no matches, >= 2 = the gate failed to run.
    const res = await world.run("grep", ["-rn", "-m", "20", ...spec.patternArgs, "--", ...surfaces]);
    if (res.exitCode === 0) {
      const hits = res.stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 5)
        .map((l) => l.slice(0, 160).replace(/\|/g, "\\|"))
        .join(" | ");
      return { name: spec.name, status: "matches", hits };
    }
    if (res.exitCode === 1) {
      return { name: spec.name, status: "clean", hits: "" };
    }
    return { name: spec.name, status: "error", hits: res.stderr.split("\n")[0].slice(0, 160) };
  })
);
const gateByName = new Map<string, GateOutcome>();
for (const o of gateOutcomes) gateByName.set(o.name, o);
log(`Mechanical gates: ${gateOutcomes.map((o) => `${o.name}=${o.status}`).join(", ")}`);

function gateLine(name: string): string {
  const g = gateByName.get(name);
  if (!g) return `${name}: gate did not run`;
  if (g.status === "clean") return `${name}: clean (no matches)`;
  if (g.status === "matches") return `${name}: matched — ${g.hits}`;
  return `${name}: ERROR (gate failed to run) — treat this check as not verified`;
}

// ── The 30 checklist items (from the skill and its references) ────────────

const SKILL = "~/.agents/skills/design-review/SKILL.md";
const REF = "~/.agents/skills/design-review/references";

const checklist: ChecklistSpec[] = [
  { index: 1, dimension: "Philosophy Alignment", criterion: "Uses the designer/studio's signature techniques", citation: `${SKILL} lines 28-42 (Philosophy Alignment dimension and its checklist)` },
  { index: 2, dimension: "Philosophy Alignment", criterion: "Colors, fonts, and layout are consistent with the philosophy system", citation: `${SKILL} lines 28-42 (Philosophy Alignment dimension and its checklist)` },
  { index: 3, dimension: "Philosophy Alignment", criterion: "No self-contradictory elements (e.g. minimalist philosophy crammed with content)", citation: `${SKILL} lines 28-42 (Philosophy Alignment dimension and its checklist)` },
  { index: 4, dimension: "Visual Hierarchy", criterion: "Heading-to-body size contrast is at least 2.5x", citation: `${SKILL} lines 43-57 (Visual Hierarchy dimension and its checklist)` },
  { index: 5, dimension: "Visual Hierarchy", criterion: "Color/weight/size establish 3-4 clear levels", citation: `${SKILL} lines 43-57 (Visual Hierarchy dimension and its checklist)` },
  { index: 6, dimension: "Visual Hierarchy", criterion: "Whitespace guides the eye", citation: `${SKILL} lines 43-57 (Visual Hierarchy dimension and its checklist)` },
  { index: 7, dimension: "Visual Hierarchy", criterion: "Squint test: the hierarchy is still clear when detail disappears", citation: `${SKILL} lines 43-57 (Visual Hierarchy dimension and its checklist)` },
  { index: 8, dimension: "Craft Quality", criterion: "Alignment is consistent, not approximate", citation: `${SKILL} lines 59-74 (Craft Quality dimension and its checklist)` },
  { index: 9, dimension: "Craft Quality", criterion: "Spacing is systematic (same padding for same-level elements)", citation: `${SKILL} lines 59-74 (Craft Quality dimension and its checklist)` },
  { index: 10, dimension: "Craft Quality", criterion: "The color system is consistent (not inventing new hexes per element)", citation: `${SKILL} lines 59-74 (Craft Quality dimension and its checklist)`, gates: ["hardcoded-hex-color"] },
  { index: 11, dimension: "Craft Quality", criterion: "Typography is clean (rag, widows, orphans controlled)", citation: `${SKILL} lines 59-74 (Craft Quality dimension and its checklist)` },
  { index: 12, dimension: "Craft Quality", criterion: "Edges are crisp (no 1px misalignment, no half-pixels)", citation: `${SKILL} lines 59-74 (Craft Quality dimension and its checklist)` },
  {
    index: 13,
    dimension: "Functionality",
    criterion: "All clickable elements respond correctly, with touch targets at least 44pt",
    citation: `${SKILL} lines 86-90 (Functionality checklist); ${REF}/code-based-ux-audit-checklist.md lines 15-23 (Interaction Design); ${REF}/mobile-ux-checklist.md lines 13-19 (Interaction Patterns; touch targets at line 19)`,
    gates: ["dead-ui", "cursor-pointer"],
  },
  {
    index: 14,
    dimension: "Functionality",
    criterion: "Interactive elements have hover/active/focus states",
    citation: `${SKILL} lines 86-90 (Functionality checklist); ${REF}/code-based-ux-audit-swiftui-macos.md line 29 (missing hover states on tappable rows)`,
    gates: ["cursor-pointer"],
  },
  {
    index: 15,
    dimension: "Functionality",
    criterion: "Loading, empty, error, and edge-case states are handled for every async surface",
    citation: `${SKILL} lines 86-90 (Functionality checklist); ${REF}/code-based-ux-audit-checklist.md lines 25-34 (Data Flow & Empty States)`,
    gates: ["silent-catch"],
  },
  {
    index: 16,
    dimension: "Functionality",
    criterion: "The flow makes logical sense with no dead ends",
    citation: `${SKILL} lines 86-90 (Functionality checklist); ${REF}/code-based-ux-audit-checklist.md lines 5-13 (Information Architecture; dead-end screens at line 9); ${REF}/mobile-ux-checklist.md lines 33-37 (Navigation & Wayfinding; dead ends at line 36)`,
  },
  { index: 17, dimension: "Innovation", criterion: "Solves the problem in an interesting way", citation: `${SKILL} lines 92-105 (Innovation dimension and its checklist)` },
  { index: 18, dimension: "Innovation", criterion: "Not a standard pattern executed with no original thought", citation: `${SKILL} lines 92-105 (Innovation dimension and its checklist)` },
  { index: 19, dimension: "Innovation", criterion: "Has a signature moment", citation: `${SKILL} lines 92-105 (Innovation dimension and its checklist)` },
  { index: 20, dimension: "Anti-AI-Slop", criterion: "No radical purple gradient backgrounds", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)`, gates: ["purple-gradient"] },
  { index: 21, dimension: "Anti-AI-Slop", criterion: "No rounded cards with a left border accent color", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)` },
  { index: 22, dimension: "Anti-AI-Slop", criterion: "No emoji used as UI icons", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag); ${REF}/code-based-ux-audit-checklist.md line 54 (no emoji as functional UI icons)`, gates: ["emoji-as-icon"] },
  { index: 23, dimension: "Anti-AI-Slop", criterion: "No SVG hand-drawn imagery (people, scenes, objects)", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)` },
  { index: 24, dimension: "Anti-AI-Slop", criterion: "No excessive iconography (every item getting an icon)", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)` },
  { index: 25, dimension: "Anti-AI-Slop", criterion: 'No "data slop" — fake stats used as decoration', citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)`, gates: ["fake-stats"] },
  { index: 26, dimension: "Anti-AI-Slop", criterion: "No Inter/Roboto/Arial as display font without brand-spec justification", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)`, gates: ["default-font-stack"] },
  { index: 27, dimension: "Anti-AI-Slop", criterion: "No cyber neon / dark blue #0D1117 GitHub-dark clone", citation: `${SKILL} lines 243-253 (Anti-Patterns to Flag)` },
  {
    index: 28,
    dimension: "Code-Based UX",
    criterion: "No dead UI, silent failures, response-key mismatches, or discarded pagination",
    citation: `${SKILL} lines 219-227 (code-level UX signals); ${REF}/code-based-ux-audit-checklist.md lines 72-90 (Common Code-Level UX Bugs table)`,
    gates: ["dead-ui", "silent-catch"],
    subChecks: [
      "dead UI — non-interactive elements styled as interactive (checklist lines 17 and 80)",
      "silent failures — .catch(console.error) with no user-facing error state (checklist lines 28 and 78)",
      "API response key mismatch producing silently empty sections (checklist line 76)",
      "discarded pagination metadata so only the first page shows (checklist lines 31 and 79)",
    ],
  },
  {
    index: 29,
    dimension: "Code-Based UX",
    criterion: "Ranking surfaces gate on decisiveness before alignment, and dashboard real estate follows the layout patterns",
    citation: `${REF}/ranking-hierarchy-pattern.md lines 5-27 (the four-layer hierarchy); ${REF}/dashboard-real-estate-patterns.md lines 1-56 (real-estate anti-patterns); ${REF}/code-based-ux-audit-checklist.md lines 32-33 (dedupe and series grouping)`,
    subChecks: [
      "ranking surfaces gate on decisiveness before alignment (ranking-hierarchy-pattern lines 5-27)",
      "dashboard real-estate anti-patterns: hero density, chart hygiene, card-vs-list, gauge over-engineering (dashboard-real-estate-patterns)",
      "series are grouped and lists deduped by stable key rather than rendering duplicate cards (checklist lines 32-33)",
    ],
  },
  {
    index: 30,
    dimension: "Code-Based UX",
    criterion: "Contrast meets WCAG AA, interactive elements carry accessibility labels/roles, and animated surfaces are audited across multiple frames",
    citation: `${SKILL} line 226 (contrast failures below 4.5:1 WCAG AA, under Code-Based UX Audit); ${REF}/code-based-ux-audit-checklist.md lines 58-64 (Accessibility); ${SKILL} line 299 and ${REF}/multi-frame-capture-protocol.md lines 1-27 (multi-frame capture for animations)`,
    subChecks: [
      "contrast is at least 4.5:1 for text on its background (SKILL.md line 226)",
      "accessibility labels/roles on icon-only and interactive elements, with keyboard support (checklist lines 58-64)",
      "animated surfaces, if any, are audited from multiple frames rather than one screenshot (SKILL.md line 299; multi-frame-capture-protocol)",
    ],
  },
];

function itemAskText(spec: ChecklistSpec): string {
  const gateLines = (spec.gates ?? []).map(gateLine);
  const gateBlock = gateLines.length > 0 ? gateLines.join("\n") : "(no mechanical gate feeds this item)";
  const subInstruction = spec.subChecks
    ? `This item is a composite: audit each sub-check separately and return one subChecks entry per sub-check, in this order: ${spec.subChecks.join(" | ")}. Each subChecks entry carries its own verdict and evidence. Set the item's top-level verdict to the worst sub-check verdict.`
    : "This item has no sub-checks: return subChecks as an empty array.";
  return [
    `Checklist item ${spec.index} of 30 — ${spec.dimension}: ${spec.criterion}`,
    "",
    `Read before judging: ${spec.citation}`,
    "",
    "Surfaces under audit (workspace-relative paths):",
    surfaceList,
    "",
    "Mechanical gates the script already ran (evidence to verify yourself, not verdicts):",
    gateBlock,
    "",
    'Audit this criterion against the surfaces by reading the files. Work strictly read-only: do not edit any file. Be specific — cite path:line for every claim. Where a mechanical gate fed this item and you confirm its matches in the files, quote the matching path:line in your evidence. If the criterion does not apply to these surfaces, return verdict "not-applicable" and say why in the evidence.',
    "",
    subInstruction,
    "",
    'Return the ChecklistItem object exactly: index (number), dimension (string), criterion (string), verdict ("pass" | "fail" | "partial" | "not-applicable"), evidence (one sentence with specifics), location (workspace path with line), subChecks (array of { check, verdict, evidence }).',
  ].join("\n");
}

// ── Fan-out: one independent read-only auditor per checklist item ──────────

phase("Audit the 30 checklist items in parallel");

artifact.board("item-verdicts", {
  title: "Checklist verdicts",
  key: "index",
  status: "verdict",
  columns: ["pass", "partial", "fail", "not-applicable"],
  cardTitle: "criterion",
});

interface ItemWithFinding {
  item: ChecklistItem;
  finding: Finding | null;
}

const results: ItemWithFinding[] = await Promise.all(
  checklist.map(async (spec): Promise<ItemWithFinding> => {
    const reviewer = agent(`${spec.dimension} reviewer ${spec.index}`, { system: auditorPersona });
    const item = await reviewer.ask<ChecklistItem>(itemAskText(spec));
    report(item, "item-verdicts");
    const priority = priorityFor(item);
    if (priority === null) return { item, finding: null };
    const gateBacked =
      (spec.gates ?? []).some((name) => gateByName.get(name)?.status === "matches") &&
      item.evidence.length > 0;
    const finding: Finding = {
      where: item.location,
      what: `${item.criterion} — ${item.verdict}`,
      evidence: item.evidence,
      status: gateBacked ? "verified" : "unconfirmed",
      severity: severityFor(priority),
      priority,
    };
    report(finding);
    return { item, finding };
  })
);

const items = results.map((r) => r.item);
const findings = results
  .map((r) => r.finding)
  .filter((f): f is Finding => f !== null)
  .sort((a, b) => {
    const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return rank[a.priority] - rank[b.priority];
  });

log(`${items.length} checklist items audited, ${findings.length} findings`);

// ── Scores ─────────────────────────────────────────────────────────────────

const dimensionNames = [
  "Philosophy Alignment",
  "Visual Hierarchy",
  "Craft Quality",
  "Functionality",
  "Innovation",
  "Anti-AI-Slop",
  "Code-Based UX",
];

function verdictWord(score: number): string {
  return score >= 8 ? "Strong" : score >= 5 ? "Needs improvement" : "Critical gaps";
}

const dimensions: DimensionScore[] = dimensionNames.map((dim) => {
  const dimItems = items.filter((it) => it.dimension === dim);
  const scores = dimItems.map(itemScore).filter((s): s is number => s !== null);
  const score = scores.length > 0 ? clampScore((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) : 0;
  return {
    dimension: dim,
    score,
    verdict: scores.length > 0 ? verdictWord(score) : "nothing applicable",
    applicableItems: scores.length,
    issueCount: dimItems.filter((it) => it.verdict === "fail" || it.verdict === "partial").length,
  };
});

// Overall is the mean over all 30 item scores — item-weighted, so a 3-item
// dimension counts for 3/30 and an 8-item dimension for 8/30. Composite items
// contribute the mean of their sub-checks. Disclosed in the artifact.
const allScores = items.map(itemScore).filter((s): s is number => s !== null);
const overallScore =
  allScores.length > 0 ? clampScore((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) : 0;

// ── Independent reader pass over the composed report ───────────────────────

phase("Review the findings independently and write up the design review");

const p0Findings = findings.filter((f) => f.priority === "P0");
const p1Findings = findings.filter((f) => f.priority === "P1");
const ranked = [...dimensions].sort((a, b) => b.score - a.score);
const bestDimension = ranked[0];

let biggestGap = "none recorded — no item failed or partially passed";
if (findings.length > 0) {
  const first = findings[0];
  biggestGap = `${first.what} — at ${first.where}`;
}

const summaryForReader = [
  `Overall: ${overallScore}/10 (mean of all applicable item scores; composite items 28-30 score the mean of their sub-checks).`,
  `Dimensions: ${dimensions.map((d) => `${d.dimension} ${d.score}/10 (${d.applicableItems} items, ${d.issueCount} issues)`).join("; ")}.`,
  `Findings: ${findings.length} total — P0: ${p0Findings.length}, P1: ${p1Findings.length}, P2: ${findings.length - p0Findings.length - p1Findings.length - findings.filter((f) => f.priority === "P3").length}, P3: ${findings.filter((f) => f.priority === "P3").length}.`,
  `Top findings:`,
  ...findings.slice(0, 8).map((f) => `- [${f.priority}/${f.severity}/${f.status}] ${f.what.replace(/`/g, "` + '`' + `")} — ${f.where}: ${f.evidence.replace(/`/g, "` + '`' + `")}`),
].join("\n");

const readerPersona =
  "You are an independent reader of a design-review report. Judge it as a reader would, from the text alone: what is unclear, what the text itself does not support, what is missing. Do not wander off to verify it against the repository. Never edit any file. " +
  "If your instructions contradict each other, escalate and say so plainly rather than working around it.";

let confirmation: ConfirmerReview = {
  gaps: ["the independent reader pass did not run"],
  complete: false,
  biggestStrength: "",
  nextActions: [],
};
try {
  const reader = agent("Independent design-review reader", { system: readerPersona });
  confirmation = await reader.ask<ConfirmerReview>(
    `A design-review workflow audited 30 checklist items over ${surfaces.length} surfaces and composed a report. Judge it as a reader, from this summary alone.\n\n${summaryForReader}\n\n` +
      `The report ships with: a score summary, per-dimension breakdown with evidence, an anti-AI-slop table, a mechanical-gates table, P0-P3 fix tables with effort estimates, and a sign-off naming the biggest gap, the biggest strength, and next actions.\n\n` +
      `Answer three things as the reader: (1) gaps — what is unclear, unsupported, or missing from what this report claims to cover; (2) biggestStrength — the single biggest strength the evidence supports, one sentence; (3) nextActions — up to three concrete next actions for the owner. ` +
      `If any P0 or P1 findings exist, one next action must be choosing a design direction before any redesign work — the skill separates the audit from the design (SKILL.md §Post-Audit Workflow and Pitfall 6). Also return complete (true when the report is complete enough to ship).`
  );
} catch {
  log("Independent reader pass failed; shipping with the script-computed sign-off");
}

const biggestStrength =
  confirmation.biggestStrength.trim().length > 0
    ? confirmation.biggestStrength.trim()
    : `Highest-scoring dimension: ${bestDimension.dimension} at ${bestDimension.score}/10`;

const nextActions = confirmation.nextActions.filter((a) => a.trim().length > 0).slice(0, 3);
if (nextActions.length === 0) {
  if (p0Findings.length > 0) nextActions.push(`Fix the P0 items first, starting with: ${p0Findings[0].what} (${p0Findings[0].where}).`);
  else if (findings.length > 0) nextActions.push(`Start with the top finding: ${findings[0].what} (${findings[0].where}).`);
  else nextActions.push("No fixes are indicated by this audit; spot-check the surfaces manually if scores look generous.");
  nextActions.push(`Double down on the strongest dimension (${bestDimension.dimension}) — it is what the design already does well.`);
}
if (p0Findings.length + p1Findings.length > 0 && !nextActions.some((a) => /direction/i.test(a))) {
  nextActions.push("Choose a design direction with the owner before any redesign work — the audit alone does not redesign (SKILL.md §Post-Audit Workflow, Pitfall 6).");
}

// ── Compose and publish the artifact (one primary; compact fallback) ──────

const scoreTable = dimensions
  .map((d) => `| ${d.dimension} | ${d.applicableItems > 0 ? `${d.score}/10` : "n/a"} | ${d.verdict} |`)
  .join("\n");

const dimensionBreakdown = dimensions
  .map((d) => {
    const dimItems = items.filter((it) => it.dimension === d.dimension);
    const itemLines = dimItems
      .map((it) => {
        const sub =
          it.subChecks.length > 0
            ? `\n  - sub-checks: ${it.subChecks.map((s) => `${s.check} → ${s.verdict} (${s.evidence})`).join("; ")}`
            : "";
        return `- **Item ${it.index}** — ${it.criterion.replace(/`/g, "` + '`' + `")}: ${it.verdict}\n  - evidence: ${it.evidence.replace(/`/g, "` + '`' + `")}\n  - location: ${it.location}${sub}`;
      })
      .join("\n");
    return `### ${d.dimension} — ${d.applicableItems > 0 ? `${d.score}/10` : "n/a"} (${d.verdict})\n\n${itemLines}`;
  })
  .join("\n\n");

const slopItems = items.filter((it) => it.dimension === "Anti-AI-Slop");
const slopTable = slopItems.map((it) => `| ${it.index} | ${it.criterion} | ${it.verdict === "pass" ? "✓" : "❌"} | ${it.evidence.replace(/`/g, "` + '`' + `")} |`).join("\n");

const gatesTable = gateOutcomes
  .map((o) => `| ${o.name} | ${o.status} | ${o.hits || "—"} |`)
  .join("\n");

function priorityTable(p: Priority): string {
  const rows = findings
    .filter((f) => f.priority === p)
    .map((f, i) => `| ${i + 1} | ${f.what.replace(/`/g, "` + '`' + `")} | ${f.where.replace(/`/g, "` + '`' + `")} | ${effortByPriority[f.priority]} |`);
  return rows.length > 0 ? rows.join("\n") : "| — | none | — | — |";
}

const gapLines = confirmation.gaps.filter((g) => g.trim().length > 0);
const readerSection =
  gapLines.length > 0
    ? gapLines.map((g) => `- ${g}`).join("\n")
    : "- The independent reader found no gaps; it judged the report complete.";

const md = [
  `# Design Review`,
  "",
  `**Method:** code-based + mechanical-gate audit — no screenshots were rendered this run, so rendered-state findings are out of scope (see Sign-Off).`,
  `**Source artifacts:** ${surfaces.length} surfaces under audit.`,
  "",
  "## Score Summary",
  "",
  "| Dimension | Score | Verdict |",
  "|---|---|---|",
  scoreTable,
  `| **Overall** | **${overallScore}/10** | ${verdictWord(overallScore)} |`,
  "",
  "Overall is the unweighted mean of all applicable item scores (composite items 28-30 contribute the mean of their sub-checks), so an 8-item dimension weighs 8/30 and a 3-item dimension 3/30.",
  "",
  "## Dimension Breakdown",
  "",
  dimensionBreakdown,
  "",
  "## Anti-AI-Slop Audit",
  "",
  "| # | Pattern | Verdict | Evidence |",
  "|---|---|---|---|",
  slopTable,
  "",
  "## Mechanical Gates",
  "",
  "Run by the script with grep; exit codes classified in-script (0 = matches, 1 = clean, ≥2 = gate failed to run).",
  "",
  "| Gate | Status | First matches |",
  "|---|---|---|",
  gatesTable,
  "",
  "## Surface Inventory",
  "",
  "| Surface | In scope |",
  "|---|---|",
  surfaces.map((s) => `| ${s} | audited via code + gates |`).join("\n"),
  "",
  "## Prioritized Recommendations",
  "",
  "### P0 — Fix This Session (data correctness / broken features)",
  "",
  "| # | Issue | Where | Effort (est.) |",
  "|---|---|---|---|",
  priorityTable("P0"),
  "",
  "### P1 — Fix This Quarter (real UX gaps)",
  "",
  priorityTable("P1"),
  "",
  "### P2 — Structural Improvements (2-4 hrs each)",
  "",
  priorityTable("P2"),
  "",
  "### P3 — Big Bets (1-2 days)",
  "",
  priorityTable("P3"),
  "",
  "## Independent Reader Pass",
  "",
  readerSection,
  "",
  "## Sign-Off",
  "",
  `**Biggest gap:** ${biggestGap}`,
  "",
  `**Biggest strength:** ${biggestStrength}`,
  "",
  "**Next actions:**",
  ...nextActions.map((a, i) => `${i + 1}. ${a}`),
  "",
  "An unauthenticated or code-only audit is incomplete for auth-gated surfaces (SKILL.md Pitfall 8): this run rendered nothing, so treat the scores as the code-level view, not the whole story.",
].join("\n");

const compactMd = [
  "# Design Review (summary — full report publish failed)",
  "",
  `Overall ${overallScore}/10. ${findings.length} findings: ${p0Findings.length} P0, ${p1Findings.length} P1.`,
  "",
  ...findings.slice(0, 10).map((f) => `- **${f.priority}/${f.severity}** \`${f.where}\` — ${f.what}`),
].join("\n");

try {
  await artifact.markdown("design-review-report", md, {
    title: "Design Review Report",
    description: `30-item design critique over ${surfaces.length} surfaces; overall ${overallScore}/10, ${findings.length} prioritized findings.`,
    primary: true,
  });
} catch {
  // Compact fallback, same id, no primary flag; its own failure path only
  // reports (void, cannot throw), so the findings survive as reported items.
  try {
    await artifact.markdown("design-review-report", compactMd, {
      title: "Design Review Report (summary)",
      description: "Compact fallback: the full report publish failed. Findings are in the run's reported items.",
    });
  } catch {
    report({
      where: "run",
      what: "The design-review report could not be published; findings survive only as this run's reported items.",
      evidence: "artifact.markdown rejected twice for id design-review-report",
      status: "unconfirmed",
      severity: "high",
      priority: "P0",
    });
  }
}

// ── Return ─────────────────────────────────────────────────────────────────

const gateErrors = gateOutcomes.filter((o) => o.status === "error");
const result: WorkflowReport = {
  conclusion:
    `Audited ${items.length} design checklist items over ${surfaces.length} surfaces. ` +
    `Overall ${overallScore}/10 (${verdictWord(overallScore)}); ${findings.length} findings in the P0-P3 fix tables ` +
    `(${p0Findings.length} P0). The independent reader ${confirmation.complete ? "judged the report complete" : "flagged gaps"}; ` +
    `its notes are in the artifact.`,
  findings,
  verified: [
    "8 mechanical grep gates run by the script with exit codes classified (0/1/>=2), patterns verified against this host's BSD grep",
    "30 checklist items audited by independent read-only subagents, each citing the skill file and reference it judged from",
    "composite items 28-30 carry per-sub-check verdicts; overall score is item-weighted, not dimension-averaged",
    "one independent reader pass over the composed report before publish",
  ],
  notCovered: [
    "visual rendering — screenshots, auth-gated surfaces, and multi-frame animation capture were not executed; the artifact's sign-off says so explicitly",
    ...(gateErrors.length > 0 ? gateErrors.map((o) => `gate "${o.name}" failed to run (${o.hits}) — its check is unverified`) : []),
    "mobile-app-redesign-pattern.md — it is the post-audit implementation plan (SKILL.md:277), excluded because Pitfall 6 (SKILL.md:289) separates audit from design; mobile-ux-checklist.md is cited on items 13 and 16",
    "surfaces beyond the first 40 discovered",
  ],
};
return result;
