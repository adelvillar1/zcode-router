/* zcode-workflow
description: "Generates a plan backlog: scans scope for gaps in parallel, writes
  numbered plan files with dependency waves, settles sequencing with the run
  owner by escalation, commits the batch behind an explicit owner yes, and
  appends the post-recap section. Embodies the plan-backlog-generation skill."
whenToUse: When a scope of work needs a structured plan backlog with sequenced,
  committed plan files.
args:
  scope:
    type: string
    description: Scope to build the backlog from.
    required: false
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// Dynamic-workflow script: plan-backlog-generation
// Embodies "The 4-phase workflow" from ~/.agents/skills/plan-backlog-generation/SKILL.md:34-107
// (the skill is 181 lines by wc -l; the ask's cited 379-453 do not exist — the real sections
// are used, and every line citation below was spot-checked against the file).
//
// Hybrid pattern: structure (phases, the sequential scan context, the batched fan-out,
// bounded repair loops, escalation gates, WorkflowReport) lives in this script; every
// subagent ask references the skill's SKILL.md by absolute path for the procedure detail.
// The skill ships no scripts/ and no references/ (both ENOENT on disk), so the Phase-4
// gates run the shell commands the SKILL.md itself names: grep for frontmatter and
// cross-references (:96-98), coverage counting (:99-100), numbering vs. slugs (:101),
// and drift checks on CLAUDE.md / gitignore / branch state (:102).
//
// Register compliance carried from batch 1: deliverable publish is primary:true inside a
// try/catch with a compact fallback; tunable constants (the batch cap) live only in script
// control flow, never in ask text; fan-out subagent names are unique and computed from the
// plan identity; every ask is typed with a named interface; the two human decisions the
// skill makes binding (sequencing, SKILL.md:63-65 and :174-175; and the one-batch commit)
// reach the run owner through subagent escalation, not through a second model's opinion.
// The skill's 3-concurrent cap (:79) is expressed in this script's batching loop — the
// facade reserves max_concurrency for when the user asks, so it is not set here.
//
// Known deviation from the skill's letter: SKILL.md:82 and the pitfall at :129-131 say plan
// 00 is written "BY HAND", because a fresh-context subagent cannot see the other plans'
// Out-of-scope wording. The ask's ground truth restates the requirement as "authored LAST
// with cross-plan visibility", which is what this script does: the 00 drafter runs after the
// join and receives every other plan's verbatim Out-of-scope bullets plus full disk read —
// the compensating data that neutralizes the skill's stated rationale. The run owner should
// know the meta-plan is subagent-written with that data, not literally hand-written.

// ---------------------------------------------------------------------------
// Result types (every ask<T> below uses one of these named interfaces)
// ---------------------------------------------------------------------------

interface SurfaceMap {
  /** REST routes, op types, schema tables, and UI components that exist in code, each with a path:line pointer. */
  implemented: string[];
  /** Which files the surface was read from and what each contributed. */
  evidence: string;
}

type GapItems = GapItem[];

interface GapItem {
  /** The feature or capability the docs describe. */
  feature: string;
  /** Workspace-relative doc paths that mention it (PRD, architecture proposal, roadmap phase). */
  mentionedIn: string[];
  /** What the code actually has today for this feature, with path:line evidence. */
  codeState: string;
}

interface InfraGaps {
  /** Cross-cutting infra gaps: auth, deploys, tests, and similar items every plan leans on. */
  gaps: string[];
}

interface PlanRow {
  /** Short name of the prospective plan. */
  plan: string;
  /** Prospective plans that must land before this one. */
  dependsOn: string[];
  /** Prospective plans this one unblocks. */
  unblocks: string[];
  /** The roadmap phase this plan belongs to (MVP / v1 / v2 / v3 or the doc's own phase name). */
  roadmapPhase: string;
}

interface InventoryAndBottleneck {
  /** The dependency-ordered table, one row per prospective plan (SKILL.md:50-53). */
  rows: PlanRow[];
  /** The single dependency that, when done, unblocks the most other plans (SKILL.md:55-62). */
  bottleneck: string;
  /** How many prospective plans the bottleneck unblocks. */
  bottleneckUnblocks: number;
  /** Why this dependency is the bottleneck, naming the plans it blocks. */
  rationale: string;
  /** The realistic alternative orderings the owner could pick instead, each with its retrofit cost. */
  alternatives: string[];
}

interface SequencingDecision {
  /** The run owner's answer, verbatim as they gave it. Empty only if they answered with no text. */
  answer: string;
  /** The chosen ordering in one phrase (e.g. "bottleneck-first", "visible-wins-first"). */
  chosenOption: string;
  /** True when the owner's ordering defers the bottleneck, which is what calls for the 00 meta-retrofit plan (SKILL.md:64-65). */
  retrofitPlanRequired: boolean;
  /** The date the directive was given, as YYYY-MM-DD, for the index's sequencing rationale. */
  directiveDate: string;
}

interface PlanSlot {
  /** Sequence number assigned in the index; unique across the set. 0 is reserved for the retrofit meta-plan. */
  seq: number;
  /** Slug for the plan file after the date prefix; the retrofitter's starts with "00-". */
  slug: string;
  /** The slot's exact dated file name as recorded in the index, e.g. "2026-09-23-foo.md" — the one string every drafter and gate keys on, so a midnight rollover cannot split the set. */
  fileName: string;
  /** Plan file names (or slugs) this plan depends on, exactly as the index records them. */
  dependsOn: string[];
  /** Wave number from the dependency graph — which implementation round this plan lands in. */
  wave: number;
  /** Workspace-relative doc paths (PRD, architecture, roadmap) this plan satisfies. */
  docs: string[];
  /** Pre-assigned schema migration number for this plan, or an empty string when it adds none (SKILL.md:138-141). */
  migrationNumber: string;
  /** The exact op-type strings this plan may add, so the union never collides (SKILL.md:143-147). */
  opKinds: string[];
  /** True for the 00 meta-retrofit slot, which is drafted last, after every other plan. */
  isRetrofit: boolean;
}

interface IndexWrite {
  /** Workspace-relative path of the index file that was written. */
  path: string;
  /** The sequencing rationale as recorded in the index, quoting the owner's directive and its date (SKILL.md:174-175). */
  sequencingRationale: string;
  /** True when the plan set includes the 00 meta-retrofit plan. */
  hasRetrofitPlan: boolean;
  /** Every plan slot to draft, in sequence order, the retrofit slot included and marked. */
  plans: PlanSlot[];
}

interface PlanDraft {
  /** The slot sequence number this draft fulfils. */
  seq: number;
  /** Workspace-relative path of the plan file that was written. */
  path: string;
  /** The plan's Out-of-scope bullets verbatim, so the retrofit meta-plan can match the exact wording (SKILL.md:87-91). */
  outOfScope: string[];
  /** The dependency plan file names this plan references, as written. */
  dependsOn: string[];
  /** One sentence: what this plan delivers. */
  summary: string;
}

interface RepairOutcome {
  /** True when every flagged plan file was fixed on disk. */
  fixed: boolean;
  /** What was changed, per file, including files that could not be fixed and why. */
  changes: string;
}

interface Review {
  /** False when the reviewer found a gap that would break the plan set. */
  approved: boolean;
  /** What would break the plan set, or what is missing from it. */
  gaps: string[];
  /** The plan set restated in the reviewer's own words, plus the overall assessment. */
  assessment: string;
}

interface CommitDecision {
  /** True only on the run owner's explicit yes. */
  approved: boolean;
  /** The owner's reply, quoted. */
  feedback: string;
}

interface RecapOutcome {
  /** Path of the recap the Post-recap section was appended to, when one exists. */
  path?: string;
  /** True when the section was appended to today's existing recap (never a new followup file, SKILL.md:154-156). */
  appended: boolean;
  /** What happened, including why nothing was appended. */
  note: string;
  /** Path of the state snapshot refreshed with the new plan count, when the file exists (SKILL.md:117). */
  snapshotPath?: string;
}

interface GateResult {
  /** Which of the five checks ran: frontmatter, cross-reference, retrofit-coverage, numbering, or drift. */
  check: string;
  /** True when the check found nothing wrong. */
  passed: boolean;
  /** What decided it: the command's output or the file comparison, quoted. */
  evidence: string;
}

interface Finding {
  /** Workspace-relative path, with a line when it applies: "docs/plans/PLAN-INDEX.md:12". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and the output that proved it. */
  evidence: string;
  /** "verified" when a deterministic gate or an independent source confirmed it; "unconfirmed" when only one reviewer's read stands behind it. */
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
// Dashboard: one card per plan, so the person watching the drafting batches
// can see where the backlog stands while it is still going.
// ---------------------------------------------------------------------------

artifact.board("plan-progress", {
  title: "Plan backlog progress",
  key: "plan",
  status: "status",
  columns: ["drafting", "drafted", "flagged", "repaired", "committed"],
  detail: [{ field: "detail" }],
});

const scopeHint =
  typeof args.scope === "string" && args.scope.trim() !== ""
    ? args.scope.trim()
    : "every feature the roadmap and spec docs describe that is not yet implemented";

const SKILL = "~/.agents/skills/plan-backlog-generation/SKILL.md";

// ---------------------------------------------------------------------------
// Phase 1 of the skill (SKILL.md:36-46) — codebase scan. ONE subagent created
// once and asked sequentially: information flows in many directions, and a
// fresh-context subagent would have to re-derive the scan on every ask. This
// is deliberately NOT a fan-out; asks on one agent queue FIFO, which is the
// serialization the skill wants.
// ---------------------------------------------------------------------------

phase("Map the codebase against the docs");
const scanner = agent("codebase-scanner", {
  system:
    "You map a codebase's implemented surface against its roadmap and spec docs. " +
    `Read ${SKILL} Phase 1 (lines 36-46) for the method: ` +
    "use search, file reads, and terminal grep/rg. Return only what the ask asks for, with path:line evidence. " +
    "Do not edit any file in this phase.",
});

const surface = await scanner.ask<SurfaceMap>(
  `Build the implemented-surface map: REST routes, op types, schema tables, and UI components ` +
    `that exist in code today. Scope: ${scopeHint}. ` +
    `Start from the route/table/component definitions and grep outward. ` +
    `Return the implemented items each with a path:line pointer.`,
);

const gaps = await scanner.ask<GapItems>(
  `Now the inverse: what the docs reference but the code is missing. ` +
    `Walk the docs under docs/ (roadmap phases, specs, feature notes), and for each described ` +
    `feature record whether code implements it, citing what you checked. ` +
    `Return one GapItem per missing or partially-implemented feature, with the doc paths that mention it.`,
);

log(`Scan complete: ${surface.implemented.length} implemented surface items, ${gaps.length} doc-vs-code gaps.`);

phase("Build the inventory and find the bottleneck");
const infra = await scanner.ask<InfraGaps>(
  `Last scan pass: the cross-cutting infra gaps — auth, deploys, tests, and anything every ` +
    `plan would lean on (SKILL.md:42). Return the gap list.`,
);

const inventory = await scanner.ask<InventoryAndBottleneck>(
  `Consolidate everything you have mapped into the skill's Phase-2 inventory ` +
    `(${SKILL} lines 48-65): a dependency-ordered table with Plan / Depends on / Unblocks / ` +
    `Roadmap phase, one row per prospective plan. Then identify the bottleneck — the single ` +
    `dependency that unblocks the most other plans — and name the realistic alternative ` +
    `orderings with their retrofit costs. Do not decide the ordering yourself; that decision ` +
    `belongs to the run owner and comes next.`,
);

report({ plan: "inventory", status: "drafted", detail: `${inventory.rows.length} prospective plans; bottleneck: ${inventory.bottleneck}` }, "plan-progress");

if (inventory.rows.length === 0) {
  const emptyReport: WorkflowReport = {
    conclusion:
      "Nothing to plan: the scan found every doc-described feature already implemented, so no plan backlog was generated.",
    findings: [],
    verified: [
      `codebase-scanner reported ${surface.implemented.length} implemented surface items and 0 doc-vs-code gaps`,
    ],
    notCovered: [
      "no plan files, index, verification gates, commit, or recap were produced — the inventory is empty",
    ],
  };
  try {
    await artifact.markdown(
      "empty-backlog-report",
      [
        `# Plan backlog generation`,
        "",
        `## Conclusion`,
        emptyReport.conclusion,
        "",
        `## Verified`,
        ...emptyReport.verified.map((v) => `- ${v}`),
        "",
        `## Not covered`,
        ...emptyReport.notCovered.map((n) => `- ${n}`),
      ].join("\n"),
      {
        title: "Plan backlog — nothing to plan",
        description: "The scan found no unimplemented doc-described features.",
      },
    );
  } catch {
    // Same register rule as the main publish: a rejected publish still has to leave
    // the user with the deliverable, so republish the conclusion alone. The fallback
    // publish is itself guarded — a total publish failure logs and falls through to
    // the return rather than erroring the run with nothing delivered.
    log("The empty-backlog report could not be published — republishing its conclusion alone.");
    try {
      await artifact.markdown("empty-backlog-report", `# Plan backlog — nothing to plan\n\n${emptyReport.conclusion}\n`, {
        title: "Plan backlog — nothing to plan",
        description: "Compact fallback: the full report publish was rejected.",
      });
    } catch {
      log("The compact fallback could not be published either — the run's return value still carries the full result.");
    }
  }
  return emptyReport;
}

// ---------------------------------------------------------------------------
// Skill Phase 2's gate (SKILL.md:63-65, template :158-175): the bottleneck
// sequencing decision is surfaced to the run owner BEFORE any plan is drafted,
// and the answer is binding. A second model agreeing with the scanner is not a
// decision, so this ask's whole job is to put the trade-off in front of the
// human run owner via escalation and carry the verbatim answer back.
// ---------------------------------------------------------------------------

phase("Settle the sequencing with the run owner");
const sequencer = agent("bottleneck-sequencer", {
  system:
    "You are the gate between an inventory analysis and the human who owns the roadmap. " +
    `Read ${SKILL} "Sequencing decision template" (lines 158-175) and Phase 2 (lines 63-65). ` +
    "You never decide the ordering yourself and you never guess an answer. " +
    "Escalate — using your escalate tool — to the run owner with the trade-off written in the " +
    "template's shape: what the bottleneck is, what it unblocks, the option that does it first, " +
    "the option that ships visible wins and defers it, and the parallel-safe option, each with " +
    "its retrofit cost. Then wait for the owner's answer. The answer is binding. " +
    "Record only what the owner actually said. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const sequencing = await sequencer.ask<SequencingDecision>(
  `Put this sequencing decision to the run owner and return their binding answer. ` +
    `Bottleneck: ${inventory.bottleneck} (unblocks ${inventory.bottleneckUnblocks} plans). ` +
    `Rationale: ${inventory.rationale}. ` +
    `Alternative orderings: ${JSON.stringify(inventory.alternatives)}. ` +
    `Inventory rows: ${JSON.stringify(inventory.rows)}. ` +
    `Fill the skill's template with these facts, escalate, and wait. ` +
    `Return the owner's answer verbatim, the chosen option in one phrase, today's date as YYYY-MM-DD ` +
    `(run "date +%F" for it), and whether their choice defers the bottleneck — a deferral is what ` +
    `makes the 00 meta-retrofit plan required per ${SKILL} lines 64-65.`,
);

log(`Sequencing settled by the run owner: ${sequencing.chosenOption}${sequencing.retrofitPlanRequired ? " — the 00 retrofit plan is required" : ""}`);
report({ plan: "sequencing", status: "drafted", detail: `owner chose: ${sequencing.chosenOption}` }, "plan-progress");

// ---------------------------------------------------------------------------
// The index turns the binding answer into the shared context every drafter
// gets — without it, per the skill's first pitfall (SKILL.md:124-127), each
// subagent invents its own dependency graph and the plans never link up.
// ---------------------------------------------------------------------------

phase("Write the plan index from the binding answer");
const indexWriter = agent("index-writer", {
  system:
    "You write docs/plans/PLAN-INDEX.md — the dependency map and wave structure the whole plan set " +
    `hangs off (${SKILL} lines 17-18 and 109-120). Pre-assign every plan's migration number ` +
    "(lines 138-141) and its exact op-type strings (lines 143-147) so drafters cannot collide. " +
    `Record the sequencing rationale as "Sequencing rationale (user directive, <date>)" quoting the ` +
    `owner (lines 174-175). Mark the 00 meta-retrofit slot when the ordering requires one, with seq 0 ` +
    `and a slug starting "00-". Give every slot concrete doc pointers — the more concrete the index, ` +
    `the less the drafters diverge (lines 75-77). Run "date +%F" ONCE and record every slot's exact ` +
    "dated file name (<date>-<slug>.md) in its fileName field — the drafters and every verification " +
    "gate key on that exact string, so the index and the files on disk must agree character for character. " +
    "This is the one phase where you write a file.",
});
let index = await indexWriter.ask<IndexWrite>(
  `Write PLAN-INDEX.md from this inventory and this binding owner decision, then return every slot. ` +
    `Inventory rows: ${JSON.stringify(inventory.rows)}. ` +
    `Bottleneck: ${inventory.bottleneck} (unblocks ${inventory.bottleneckUnblocks}). ` +
    `Infra gaps every plan may lean on: ${JSON.stringify(infra.gaps)}. ` +
    `Owner directive (binding): ${sequencing.answer} — chosen option: ${sequencing.chosenOption}, decided ${sequencing.directiveDate}. ` +
    `Retrofit plan required: ${sequencing.retrofitPlanRequired}. ` +
    `Order the slots per the owner's directive, assign waves from the dependency graph, and fill every ` +
    `slot's fileName with its exact dated file name (one "date +%F" run, used for every slot).`,
);

// The index is LLM-emitted data that every later step keys on, so the script validates
// what it itself depends on before fanning out: distinct seq and slug (a duplicate
// computed subagent name fails the whole run and the compiler cannot see it — §2),
// distinct and well-formed fileName (two slots on one path means the second drafter
// silently overwrites the first, and the on-disk gates cannot see the loss), and the
// 00 slot the owner's binding answer may require. Defects go back to the same writer
// once; anything still broken is reported as a finding, not swallowed.
const DATED_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$/;
function indexDefects(plans: PlanSlot[]): string[] {
  const defects: string[] = [];
  const seenSeq = new Set<number>();
  const seenSlug = new Set<string>();
  const seenFile = new Set<string>();
  for (const s of plans) {
    if (seenSeq.has(s.seq)) defects.push(`duplicate slot seq ${s.seq} — PLAN numbering and subagent identities collide`);
    if (seenSlug.has(s.slug)) defects.push(`duplicate slot slug "${s.slug}"`);
    if (s.fileName !== "") {
      if (seenFile.has(s.fileName)) {
        defects.push(`duplicate slot fileName "${s.fileName}" — both drafters would write one file and the second overwrites the first`);
      }
      if (!DATED_NAME.test(s.fileName)) {
        defects.push(`slot fileName "${s.fileName}" is not the <date>-<slug>.md form every gate keys on`);
      }
    }
    seenSeq.add(s.seq);
    seenSlug.add(s.slug);
    if (s.fileName !== "") seenFile.add(s.fileName);
  }
  if (sequencing.retrofitPlanRequired && !plans.some((s) => s.isRetrofit)) {
    defects.push("the owner's binding answer requires the 00 meta-retrofit plan, but no slot is marked isRetrofit");
  }
  if (!sequencing.retrofitPlanRequired && plans.some((s) => s.isRetrofit)) {
    defects.push("a slot is marked isRetrofit, but the owner's binding answer did not require a 00 meta-retrofit plan");
  }
  return defects;
}

let indexDefectList = indexDefects(index.plans);
if (indexDefectList.length > 0) {
  phase("Repair the index before any plan is drafted");
  log(`The index has defects: ${indexDefectList.join("; ")}.`);
  index = await indexWriter.ask<IndexWrite>(
    `Your index has defects that would break the run: ${indexDefectList.join("; ")}. ` +
      `Rewrite ${index.path} with every defect fixed — keep each slot's fileName its exact dated file ` +
      `name, consistent with its slug — and return the full corrected slot list.`,
  );
  indexDefectList = indexDefects(index.plans);
}
const indexRepairFindings: Finding[] = indexDefectList.map((defect) => ({
  where: index.path,
  what: `${defect} — not repaired; the run continues on a defective index.`,
  evidence: `slots index-writer returned after the repair ask: ${JSON.stringify(
    index.plans.map((s) => ({ seq: s.seq, slug: s.slug, fileName: s.fileName, isRetrofit: s.isRetrofit })),
  )}`,
  status: "verified" as const,
  severity: defect.includes("00 meta-retrofit") ? ("high" as const) : ("medium" as const),
}));
if (indexRepairFindings.length > 0) {
  log("Index defects remain after repair — they are reported in the findings rather than failing the run.");
}

const retrofitSlot = index.plans.find((s) => s.isRetrofit);
const draftSlots = index.plans.filter((s) => !s.isRetrofit);
log(`Index written at ${index.path}: ${draftSlots.length} plans to draft${retrofitSlot !== undefined ? " plus the 00 retrofit meta-plan, which goes last" : ""}.`);

// ---------------------------------------------------------------------------
// Skill Phase 3 (SKILL.md:67-91) — one subagent per plan. The skill's cap of 3
// concurrent subagents (line 79) is this loop's batch size, in script control
// flow — the facade reserves max_concurrency for when the user asks, so it is
// never set as a tool setting. The loop is bounded by the slot list; plan 00 is
// excluded here and drafted LAST, after the join, because it needs the other
// plans' exact Out-of-scope wording (SKILL.md:82-91).
// ---------------------------------------------------------------------------

phase("Draft the plans in batches of three");
const BATCH_SIZE = 3; // the skill's cap (SKILL.md:79) — control flow only, never in ask text
const drafted: PlanDraft[] = [];
for (let start = 0; start < draftSlots.length; start += BATCH_SIZE) {
  const batch = draftSlots.slice(start, start + BATCH_SIZE);
  log(`Drafting plans ${start + 1} through ${start + batch.length} of ${draftSlots.length}.`);
  const batchDrafts = await Promise.all(
    batch.map((slot, batchIndex) =>
      // Name keyed on the slot's position in the validated list — unique by
      // construction even if the index-writer emitted colliding seq/slug (§2:
      // a duplicate computed name kills the run and the compiler cannot see it).
      agent(`plan-drafter-${start + batchIndex + 1}-${slot.slug}`, {
        system:
          "You draft exactly one plan file for a plan backlog, to the skill's standard plan template: " +
          "frontmatter (status, created, updated, slug) + Context + Approach + Acceptance Criteria + " +
          "Files + Out-of-Scope + Verification + Linked Artifacts + Risks + Dependencies + Notes " +
          `(${SKILL} lines 73-74). Read the skill's pitfalls (lines 122-156) before writing: use the ` +
          "index for shared context, write Out-of-scope bullets as complete greppable statements, use " +
          "checkbox acceptance criteria (- [ ]), and use only the migration number and op kinds the " +
          "index pre-assigned you. Do not touch any file other than your own plan file.",
      }).ask<PlanDraft>(
        `Draft plan PLAN-${String(slot.seq).padStart(2, "0")} (${slot.slug}). ` +
          `First read the index for the overall structure: ${index.path} — never invent your own dependency graph. ` +
          `Docs this plan satisfies (read them): ${slot.docs.join(", ")}. ` +
          `Wave ${slot.wave}, sequence ${slot.seq}, depends on: ${slot.dependsOn.join(", ") || "nothing"}. ` +
          `Pre-assigned migration number: ${slot.migrationNumber === "" ? "none — this plan adds no migration" : slot.migrationNumber}. ` +
          `Exact op kinds you may add: ${slot.opKinds.length > 0 ? slot.opKinds.join(", ") : "none — this plan adds no ops"}. ` +
          `Write the file as ` +
            (slot.fileName === ""
              ? `docs/plans/<today>-${slot.slug}.md — run "date +%F" for today's date, because the index did not record a fileName for you`
              : `docs/plans/${slot.fileName} — the index's exact file name; do not recompute the date`) +
            `. ` +
          `Return the exact path you wrote, your Out-of-scope bullets verbatim, the dependency plan file names you referenced, and a one-sentence summary.`,
      ),
    ),
  );
  drafted.push(...batchDrafts);
  for (const d of batchDrafts) {
    report({ plan: `PLAN-${String(d.seq).padStart(2, "0")}`, status: "drafted", detail: d.summary }, "plan-progress");
  }
}

// ---------------------------------------------------------------------------
// Plan 00 — the bottleneck/retrofit meta-plan — is drafted LAST and with full
// cross-plan visibility (SKILL.md:82-91): its retrofit checklist must match the
// other plans' exact Out-of-scope wording, which no fresh-context drafter could
// see. The drafter's verbatim bullets, collected above, are exactly that.
// ---------------------------------------------------------------------------

let retrofitDraft: PlanDraft | undefined;
if (sequencing.retrofitPlanRequired && retrofitSlot !== undefined) {
  phase("Draft the 00 retrofit meta-plan last");
  retrofitDraft = await agent("retrofit-plan-drafter-00", {
    system:
      "You write the one plan that references all the others: the 00 bottleneck/retrofit meta-plan. " +
      `Read ${SKILL} lines 82-91 for why this plan is written last with full visibility: its retrofit ` +
      "checklist must enumerate the exact touchpoints in the other plans' Out-of-scope sections, so " +
      "false-completion risk stays zero when the retrofit eventually runs. You may read every plan file " +
      "on disk. Write only your own plan file.",
  }).ask<PlanDraft>(
    `Every other plan has landed. Their Out-of-scope wording, verbatim: ${JSON.stringify(drafted.map((d) => ({ seq: d.seq, path: d.path, outOfScope: d.outOfScope })))}. ` +
      `Read the index (${index.path}) and the binding sequencing directive: ${sequencing.answer}. ` +
      `Enumerate the retrofit touchpoints across the deferred plans — name each plan file you draw a ` +
      `touchpoint from — and write the plan as ` +
      (retrofitSlot.fileName === ""
        ? `docs/plans/<today>-${retrofitSlot.slug}.md (run "date +%F" for today — the index recorded no fileName)`
        : `docs/plans/${retrofitSlot.fileName} (the index's exact fileName; do not recompute the date)`) +
      `. ` +
      `Use the same template and frontmatter rules as the other drafters (${SKILL} lines 73-74). ` +
      `Return the exact path, your Out-of-scope bullets verbatim, the dependency names you referenced, and a one-sentence summary.`,
  );
  report({ plan: "PLAN-00", status: "drafted", detail: retrofitDraft.summary }, "plan-progress");
}

const planPaths = retrofitDraft !== undefined ? [...drafted.map((d) => d.path), retrofitDraft.path] : drafted.map((d) => d.path);
const retrofitPath = retrofitDraft !== undefined ? retrofitDraft.path : null;

// A drafter that ignored its fileName and wrote onto another slot's path still
// leaves an existing file behind, so the on-disk gates alone would pass while
// two plans collapse into one file — the duplicate is surfaced here and carried
// into the findings rather than silently counted twice.
const duplicatePlanPaths = planPaths.filter((p, i) => planPaths.indexOf(p) !== i);
const duplicatePathFindings: Finding[] = Array.from(new Set(duplicatePlanPaths)).map((p) => ({
  where: p,
  what: "Two drafters reported writing this same plan file — one plan's content was overwritten and the set is short one plan.",
  evidence: `the drafters' reported paths contain ${p} more than once (full list: ${planPaths.join(", ")})`,
  status: "verified" as const,
  severity: "high" as const,
}));

// ---------------------------------------------------------------------------
// Skill Phase 4's five checks (SKILL.md:95-102), run as deterministic gates.
// The skill ships no scripts/, so these are the shell commands its own text
// names: grep for frontmatter fields (:96), grep for cross-reference patterns
// (:97-98), touchpoint counting for retrofit coverage (:99-100), index-vs-file
// numbering (:101), and the drift checks over CLAUDE.md, gitignore, and branch
// state (:102). Nonzero grep exits are values, not failures — every gate reads
// the output and decides in script code.
// ---------------------------------------------------------------------------

async function runPlanChecks(paths: string[], retrofitFile: string | null): Promise<GateResult[]> {
  const gates: GateResult[] = [];

  // grep with no file operands would read stdin until the call times out —
  // an empty drafted set is a check failure, not a command to run.
  if (paths.length === 0) {
    return [
      {
        check: "numbering",
        passed: false,
        evidence: "no plan files were reported by the drafters — there is nothing on disk to verify",
      },
    ];
  }

  // Check 1 — frontmatter (SKILL.md:96). grep -L lists files WITHOUT a match;
  // an empty listing (with grep's usual exit 1) is the pass case. Exit 2 means
  // grep hit trouble (a claimed path that does not exist) — that is a gate
  // failure, not a pass, and empty stdout alone must never decide the check.
  for (const field of ["status", "created", "updated", "slug"]) {
    const missing = await world.run("grep", ["-LE", `^${field}:`, ...paths]);
    const absent = missing.stdout.trim();
    const trouble = missing.exitCode > 1;
    gates.push({
      check: `frontmatter-${field}`,
      passed: !trouble && absent === "",
      evidence: trouble
        ? `grep exited ${missing.exitCode} (trouble, not "no match") — ${missing.stderr.trim() || "no stderr"}`
        : absent === ""
          ? `all ${paths.length} new plan files define ${field}:`
          : `grep -L '^${field}:' lists files missing the field: ${absent}`,
    });
  }

  // Check 2 — cross-references (SKILL.md:97-98): every dated plan file any new
  // plan (or the index's plan table) names must actually exist on disk.
  const onDisk = await files.glob("docs/plans/*.md");
  const onDiskSet = new Set(onDisk);
  const onDiskNames = new Set(onDisk.map((p) => p.replace("docs/plans/", "")));
  const refs = await world.run("grep", ["-hoE", "[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\\.md", ...paths, index.path]);
  const refsTrouble = refs.exitCode > 1;
  const referenced = Array.from(new Set(refs.stdout.trim().split("\n").filter((l) => l !== "")));
  const written = new Set(paths.map((p) => p.replace("docs/plans/", "")));
  const dangling = referenced.filter((r) => !written.has(r) && r !== "PLAN-INDEX.md");
  const trulyDangling = dangling.filter((r) => !onDiskNames.has(r));
  // A path a drafter claimed but never wrote makes grep exit 2 with an otherwise
  // useful stdout — surface the offenders explicitly rather than trusting stdout alone.
  const phantom = paths.filter((p) => !onDiskSet.has(p));
  gates.push({
    check: "cross-reference",
    passed: !refsTrouble && phantom.length === 0 && trulyDangling.length === 0,
    evidence: refsTrouble
      ? `grep exited ${refs.exitCode} (trouble) — ${refs.stderr.trim() || "no stderr"}`
      : phantom.length > 0
        ? `paths claimed by drafters but not on disk: ${phantom.join(", ")}`
        : trulyDangling.length === 0
          ? `${referenced.length} distinct plan-file references, all resolve on disk`
          : `references with no file behind them: ${trulyDangling.join(", ")}`,
  });

  // Check 3 — retrofit coverage (SKILL.md:99-100): if the 00 plan enumerates
  // touchpoints, each touched plan must reference 00 inside its Out-of-scope
  // section — not just anywhere in the file.
  if (retrofitFile !== null) {
    const touched = await world.run("grep", ["-ohE", "[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\\.md", retrofitFile]);
    const retrofitName = retrofitFile.replace("docs/plans/", "");
    if (touched.exitCode > 1) {
      // The 00 plan itself is unreadable by grep — coverage cannot be decided.
      gates.push({
        check: "retrofit-coverage",
        passed: false,
        evidence: `grep exited ${touched.exitCode} reading ${retrofitFile} — ${touched.stderr.trim() || "no stderr"}`,
      });
    } else {
      const touchedNames = Array.from(
        new Set(touched.stdout.trim().split("\n").filter((l) => l !== "" && l !== retrofitName)),
      ).filter((n) => onDiskNames.has(n));
      const backrefs = await files.grep(retrofitName.replace(/\./g, "\\."), "docs/plans/*.md");
      const fresh = new Set(paths);
      const byPath: Record<string, number[] | undefined> = {};
      for (const m of backrefs) {
        if (!fresh.has(m.path)) continue; // the index also references 00 — that is not a plan backref
        (byPath[m.path] ??= []).push(m.line);
      }
      const offenders: string[] = [];
      for (const p of touchedNames) {
        const fullPath = `docs/plans/${p}`;
        const lines = byPath[fullPath];
        if (lines === undefined) {
          offenders.push(`${fullPath} (no reference to ${retrofitName} at all)`);
          continue;
        }
        const allLines = (await files.read(fullPath)).split("\n");
        const headingAt = allLines.findIndex((l) => /^#{1,3}\s*Out-of-scope/i.test(l));
        // The section runs to the next heading of the same or a shallower level
        // (a deeper sub-heading stays inside it). A reference past that point —
        // in Verification, Risks, or Notes — must not count as coverage.
        const levelOf = (line: string): number => (line.match(/^(#{1,6})\s/) ?? [])[1]?.length ?? 0;
        const oosLevel = headingAt < 0 ? 0 : levelOf(allLines[headingAt]);
        const nextHeading =
          headingAt < 0
            ? -1
            : allLines.findIndex((l, i) => i > headingAt && levelOf(l) > 0 && levelOf(l) <= oosLevel);
        const sectionEnd = nextHeading < 0 ? allLines.length : nextHeading; // 0-based, exclusive
        const inSection = headingAt >= 0 && lines.some((ln) => ln > headingAt + 1 && ln <= sectionEnd);
        if (!inSection) {
          offenders.push(
            `${fullPath} (references ${retrofitName}${headingAt < 0 ? ", but has no Out-of-scope section" : ` at line(s) ${lines.join(", ")}, outside the section ending at line ${sectionEnd}`})`,
          );
        }
      }
      gates.push({
        check: "retrofit-coverage",
        passed: offenders.length === 0,
        evidence:
          offenders.length === 0
            ? `${retrofitName} enumerates ${touchedNames.length} touchpoints; each touched plan references it inside Out-of-scope`
            : `touchpoint plans missing an Out-of-scope reference to ${retrofitName}: ${offenders.join("; ")}`,
      });
    }
  }

  // Check 4 — numbering consistency (SKILL.md:101): the index's plan file
  // names, what the drafters claim they wrote, and the actual slugs on disk
  // must all agree for the plans THIS RUN wrote. The index text legitimately
  // also names the repo's pre-existing plans (the index-writer is pointed at
  // SKILL.md:109-120 and asks for concrete pointers), so an index-text scan
  // only fails a name that is neither among this run's writings nor anywhere
  // on disk — never a legitimate reference to a pre-existing plan. A name
  // claimed by a drafter but not on disk (phantom) also fails here rather
  // than silently passing. A mis-reported index path must fail this gate,
  // not error the run.
  let indexText: string;
  try {
    indexText = await files.read(index.path);
  } catch (err) {
    gates.push({
      check: "numbering",
      passed: false,
      evidence: `the index file the writer reported (${index.path}) could not be read: ${String(err)}`,
    });
    indexText = "";
  }
  const listed = Array.from(new Set(indexText.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md/g) ?? []));
  const newNames = paths.map((p) => p.replace("docs/plans/", ""));
  const unindexed = newNames.filter((n) => !listed.includes(n));
  const ghosted = listed.filter((l) => !newNames.includes(l) && !onDiskNames.has(l));
  const notOnDisk = newNames.filter((n) => !onDiskNames.has(n));
  gates.push({
    check: "numbering",
    passed: unindexed.length === 0 && ghosted.length === 0 && notOnDisk.length === 0,
    evidence:
      unindexed.length === 0 && ghosted.length === 0 && notOnDisk.length === 0
        ? `this run's ${newNames.length} plan file names are in the index and on disk (pre-existing index references excluded by design)`
        : `written but not in the index: ${unindexed.join(", ") || "none"}; in the index but on disk nowhere: ${ghosted.join(", ") || "none"}; claimed by a drafter but not on disk: ${notOnDisk.join(", ") || "none"}`,
  });

  // Check 5 — drift (SKILL.md:102): CLAUDE.md line count, gitignore state for
  // the plan directory, and the current branch. git check-ignore exits 0 when
  // the path IS ignored — which would be the drift problem here.
  const claudeLines = await world.run("wc", ["-l", "CLAUDE.md"]);
  const ignoreCheck = await world.run("git", ["check-ignore", "docs/plans"]);
  const branchState = await world.run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const plansIgnored = ignoreCheck.exitCode === 0;
  gates.push({
    check: "drift",
    passed: !plansIgnored,
    evidence: `CLAUDE.md: ${claudeLines.stdout.trim()}; branch: ${branchState.stdout.trim()}; docs/plans is ${
      plansIgnored ? "git-IGNORED — plans would never commit" : "not ignored (check-ignore exit " + ignoreCheck.exitCode + ")"
    }`,
  });

  return gates;
}

phase("Run the five verification checks");
log(`Verifying ${planPaths.length} new plan files under docs/plans/.`);
let gates = await runPlanChecks(planPaths, retrofitPath);
for (const g of gates) {
  report(g);
  log(`${g.check}: ${g.passed ? "pass" : "FAIL"} — ${g.evidence}`);
}

let gateFindings: Finding[] = gates
  .filter((g) => !g.passed)
  .map((g) => ({
    where: "docs/plans/",
    what: `Verification check ${g.check} failed and was not repaired.`,
    evidence: g.evidence,
    status: "verified" as const,
    severity: "medium" as const,
  }));

if (gateFindings.length > 0) {
  phase("Fix the flagged plans and re-run the checks");
  const fixer = agent("plan-set-fixer", {
    system:
      "You repair plan files that failed deterministic verification checks: missing frontmatter fields, " +
      "dangling cross-references, retrofit touchpoints outside Out-of-scope, index/numbering mismatches. " +
      "Edit only the plan files and PLAN-INDEX.md named in the evidence, and keep every other plan's " +
      "wording intact — especially Out-of-scope bullets, which the 00 plan cross-references. " +
      "When repairing the index, add or correct entries; never delete a reference to a plan file that " +
      "already exists on disk, since the index legitimately cites pre-existing plans. " +
      `The five checks are specified at ${SKILL} lines 95-102. ` +
      "If a flagged failure cannot actually be fixed (the evidence contradicts the files on disk), say so plainly instead of pretending.",
  });
  for (let round = 1; round <= 3; round++) {
    const failing = gates.filter((g) => !g.passed);
    log(`Repair round ${round}: ${failing.length} check(s) failing.`);
    const outcome = await fixer.ask<RepairOutcome>(
      `These verification checks failed. Fix the flagged plan files on disk.\n` +
        `${JSON.stringify(failing, null, 1)}\n` +
        `Round ${round} of a bounded loop — if a failure is not actually fixable, say so in your response rather than editing around it.`,
    );
    gates = await runPlanChecks(planPaths, retrofitPath);
    for (const g of gates) {
      if (!g.passed) log(`Still failing after round ${round}: ${g.check} — ${g.evidence}`);
    }
    if (gates.every((g) => g.passed)) {
      log(`All five checks pass after repair round ${round}.`);
      report({ plan: "verification", status: "repaired", detail: outcome.changes }, "plan-progress");
      break;
    }
  }
  gateFindings = gates
    .filter((g) => !g.passed)
    .map((g) => ({
      where: "docs/plans/",
      what: `Verification check ${g.check} still failing after the bounded repair loop.`,
      evidence: g.evidence,
      status: "verified" as const,
      severity: "medium" as const,
    }));
}

// ---------------------------------------------------------------------------
// Fresh eyes on the assembled set (authoring rules §3): a reviewer that has
// seen nothing else reads the index and the plans themselves, and is asked for
// what would break the set — not for approval. Its findings stay "unconfirmed"
// unless a gate independently backs them; the reviewer does not confirm its own
// reading.
// ---------------------------------------------------------------------------

phase("Have the plan set reviewed with fresh eyes");
const reviewer = agent("plan-set-reviewer", {
  system:
    "You are an independent reviewer who has seen nothing else in this run. " +
    `Read ${SKILL} Phase 2 and the pitfalls (lines 48-65, 122-156), then open ${index.path} and the ` +
    "plan files yourself — judge the set from the files, not from anyone's summary. Ask: what would " +
    "break this plan set when execution starts? Which dependency is missing or circular? Which two " +
    "plans collide on migrations or op kinds? Restate the wave structure in your own words. " +
    "Do not edit any file.",
});
const review = await reviewer.ask<Review>(
  `Review this plan set for execution-readiness. Index: ${index.path}. Plans: ${planPaths.join(", ")}. ` +
    `Sequencing directive the set was built around: ${sequencing.chosenOption}. ` +
    `What would break this set? What is missing? Restate the dependency structure in your own words so the gaps show.`,
);
report(review);
log(`Review: ${review.approved ? "no blocking gaps" : `${review.gaps.length} gap(s) flagged`} — ${review.assessment.slice(0, 200)}`);

// ---------------------------------------------------------------------------
// The one-batch commit (SKILL.md:104-105) is a write to the repository, so per
// the batch-1 register it is gated on the run owner's explicit yes, reached by
// escalation — the approver's own judgement never authorizes the commit.
// ---------------------------------------------------------------------------

phase("Get the run owner's yes before committing");
const approver = agent("commit-approver", {
  system:
    "You are the gate between a finished plan set and a git commit. You never edit files and never run commands. " +
    `The skill (${SKILL} lines 104-105) commits all plan files in ONE batch — but the commit happens only if ` +
    "the run owner explicitly says yes. Escalate — using your escalate tool — with the file list, the " +
    "verification results, the review verdict, and a yes/no request, and wait for the owner's answer. " +
    "Record only an explicit owner yes in approved; put every other outcome (no, unanswered, unreachable) " +
    "in feedback with the reason, and return approved=false. " +
    "If your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const commitApproval = await approver.ask<CommitDecision>(
  `Get the run owner's explicit yes/no to commit the plan set in one batch. ` +
    `Files to commit: ${planPaths.concat([index.path]).join(", ")}. ` +
    `Verification: ${JSON.stringify(gates)}. ` +
    `Review verdict: ${review.approved ? "no blocking gaps" : "gaps flagged"} — ${review.assessment.slice(0, 300)} ` +
    `Escalate with that summary and wait for the answer. Quote the owner's reply in feedback.`,
);

let commitNote: string;
if (commitApproval.approved) {
  phase("Commit the plan set in one batch");
  // Stage exactly the paths the approver put to the owner — the whole directory
  // would sweep in any stray untracked file under docs/plans that nobody approved.
  const commitTargets = planPaths.concat([index.path]);
  const staged = await world.run("git", ["add", "--", ...commitTargets]);
  if (staged.exitCode !== 0) {
    commitNote = `git add failed (exit ${staged.exitCode}): ${staged.stderr.trim()} — nothing was committed.`;
    log(commitNote);
  } else {
    const commit = await world.run("git", ["commit", "-m", `docs(plans): ${planPaths.length}-plan backlog, sequencing: ${sequencing.chosenOption}`]);
    commitNote =
      commit.exitCode === 0
        ? `Committed in one batch: ${commit.stdout.trim().split("\n")[0]}`
        : `git commit failed (exit ${commit.exitCode}): ${commit.stderr.trim()}`;
    log(commitNote);
  }
  report({ plan: "commit", status: commitNote.startsWith("Committed") ? "committed" : "flagged", detail: commitNote }, "plan-progress");
} else {
  commitNote = `Commit not approved by the run owner: ${commitApproval.feedback}`;
  log(commitNote);
  report({ plan: "commit", status: "flagged", detail: commitNote }, "plan-progress");
}

// ---------------------------------------------------------------------------
// Skill Phase 4's close-out (SKILL.md:105-107, pitfall :154-156): append a
// Post-recap section to TODAY'S existing recap — never create a followup file —
// and refresh the state snapshot with the new plan count. Then publish the
// deliverable. The publish, its repair-republish, and the compact fallback are
// mutually exclusive branches; exactly one of them runs.
// ---------------------------------------------------------------------------

phase("Append the post-recap section and hand over the index");
const recapAppender = agent("recap-appender", {
  system:
    "You close out a plan-backlog run by appending to the session record. " +
    `Read ${SKILL} lines 104-107 and the pitfall at lines 154-156: append a "## Post-recap" section to ` +
    "today's EXISTING recap; creating SESSION-RECAP-<date>-followup.md is the documented mistake. " +
    "In this workspace recaps live under docs/daily-recaps/ named YYYY-MM-DD.md — run \"date +%F\" for " +
    "today and look there (and nowhere else) before concluding no recap exists for today. " +
    `Also refresh the plan count in docs/STATE-SNAPSHOT.md (SKILL.md:117) if that file exists; if it ` +
    "does not, record that in your note instead of inventing the file. Edit nothing else.",
});
const recap = await recapAppender.ask<RecapOutcome>(
  `Append the Post-recap section for this run, and refresh the snapshot. ` +
    `What happened: ${planPaths.length} plan files plus ${index.path} were produced; sequencing: ${sequencing.chosenOption}; ` +
    `verification: ${gates.filter((g) => g.passed).length} of ${gates.length} checks pass; commit: ${commitNote}. ` +
    `New plan count for the snapshot: ${planPaths.length}. ` +
    `Return the recap path, whether the section was appended, your note, and the snapshot path if you refreshed one.`,
);
report(recap);

// The appender attesting its own write is not confirmation (authoring rules §10), so the
// append is decided from the files. Two rules keep the decision honest:
//  - a confirmation must be tied to a NAMED file — the appender's path, or today's recap
//    when it named none. A historical Post-recap heading in some other recap says nothing
//    about this run and must never flip the verdict.
//  - the not-appended case is decided by whether today's recap file exists at all (glob),
//    not by the heading count over the whole directory or the appender's story.
// The heading pattern tolerates levels 1-6 and the "PostRecap"/"Post recap" spellings.
// The recap is a close-out record: date it from the close-out moment, not from
// the sequencing directive — a run that crosses midnight between the owner's
// answer and the close-out would otherwise confirm the append against a stale
// path. The directive keeps its own date in the index rationale, where it belongs.
const closeOutDate = await world.run("date", ["+%F"]);
const recapDate =
  closeOutDate.exitCode === 0 && closeOutDate.stdout.trim() !== "" ? closeOutDate.stdout.trim() : sequencing.directiveDate;
const todayRecap = `docs/daily-recaps/${recapDate}.md`;
const postRecapMatches = await files.grep("^#{1,6}\\s*[Pp]ost[- ]?[Rr]ecap", "docs/daily-recaps/*.md");
const todayRecapFiles = await files.glob(todayRecap);
const confirmedFile = recap.path ?? todayRecap;
const recapConfirmed = postRecapMatches.some((m) => m.path === confirmedFile);
const recapFindings: Finding[] = [];
if (recap.appended && !recapConfirmed) {
  recapFindings.push({
    where: confirmedFile,
    what: "The Post-recap append the recap-appender reported cannot be seen in the file it names.",
    evidence: `files.grep '^#{1,6} Post[- ]?Recap' over docs/daily-recaps/*.md found no match in ${confirmedFile}${recap.path === undefined ? " (the appender named no path, so today's recap was checked)" : ""}; appender's note: ${recap.note}`,
    status: "verified" as const, // the deterministic grep over the named file is what decides this discrepancy
    severity: "low" as const,
  });
} else if (recap.appended && recap.path !== undefined && recap.path !== todayRecap) {
  // The heading was found, but not in today's recap — appending elsewhere means the
  // appender created a new file, the pitfall SKILL.md:154-156 calls the documented mistake.
  recapFindings.push({
    where: recap.path,
    what: `The Post-recap section was appended to ${recap.path} rather than today's recap (${todayRecap}) — creating a new file is the skill's documented mistake (SKILL.md:154-156).`,
    evidence: `the heading is confirmed on disk at ${recap.path}; the appender's claimed path does not equal today's dated recap name`,
    status: "verified" as const, // both sides of the comparison are deterministic
    severity: "low" as const,
  });
} else if (!recap.appended) {
  recapFindings.push({
    where: todayRecap,
    what:
      todayRecapFiles.length === 0
        ? "No Post-recap section was appended — no recap for today exists to append to."
        : `No Post-recap section was appended even though today's recap (${todayRecap}) exists on disk.`,
    evidence:
      todayRecapFiles.length === 0
        ? `files.glob("${todayRecap}") returned 0 files, so there was no target for the append; appender's note: ${recap.note}`
        : `files.glob("${todayRecap}") returned ${todayRecapFiles.length} file(s); the heading grep ${
            recapConfirmed
              ? `did find a Post-recap match in ${confirmedFile} — present already, not from this append`
              : `found no Post-recap match in ${confirmedFile}`
          }; appender's note: ${recap.note}`,
    status: "verified" as const, // the glob decides the no-target case; the named-file grep decides the other
    severity: "low" as const,
  });
}

try {
  await artifact.file("plan-index", index.path, {
    title: "Plan index",
    description: `Dependency map and wave structure for the ${planPaths.length}-plan backlog; sequencing set by the run owner (${sequencing.chosenOption}).`,
    primary: true,
  });
} catch {
  log("PLAN-INDEX.md could not be published — having it rewritten from the run's own data, then republishing.");
  try {
    await agent("index-repairer", {
      system:
        "The run's deliverable file is missing or unreadable at publish time. Rewrite the plan index from the " +
        "run's recorded data so it can be published: same path, same structure, dependency table and wave " +
        `order per ${SKILL} lines 50-53 and 109-120. Write only that one file.`,
    }).ask<RepairOutcome>(
      `Rewrite ${index.path} from this recorded data: slots ${JSON.stringify(index.plans)}, sequencing rationale "${index.sequencingRationale}". ` +
        `Return whether the file was rewritten and what you changed.`,
    );
  } catch {
    log("The index-repair pass itself failed — going straight to the compact fallback rendered from recorded data.");
  }
  try {
    await artifact.file("plan-index", index.path, {
      title: "Plan index",
      description: `Dependency map and wave structure for the ${planPaths.length}-plan backlog; sequencing set by the run owner (${sequencing.chosenOption}).`,
      primary: true,
    });
  } catch {
    log("Republish still rejected — falling back to a compact index rendered from the run's own data.");
    try {
      await artifact.markdown(
        "plan-index-compact",
        [
          `# Plan index (compact fallback)`,
          "",
          `Sequencing (owner directive, ${sequencing.directiveDate}): ${sequencing.chosenOption}`,
          `Rationale on record: ${index.sequencingRationale}`,
          "",
          `| Plan | Depends on | Wave |`,
          `|------|-----------|------|`,
          ...index.plans.map(
            (s) => `| PLAN-${String(s.seq).padStart(2, "0")} ${s.slug} | ${s.dependsOn.join(", ") || "—"} | ${s.wave} |`,
          ),
          "",
          `The full file was supposed to be at ${index.path}; publishing it kept failing.`,
        ].join("\n"),
        {
          title: "Plan index (compact)",
          description: "Machine-rendered fallback: the index file could not be published from disk.",
        },
      );
    } catch {
      log("The compact fallback could not be published either — the run's return value still carries the full result.");
    }
  }
}

const stillFailing = gates.filter((g) => !g.passed);
const result: WorkflowReport = {
  conclusion:
    `Generated a ${planPaths.length}-plan backlog${
      retrofitDraft !== undefined
        ? " including the 00 retrofit meta-plan"
        : sequencing.retrofitPlanRequired
          ? " WITHOUT the 00 retrofit meta-plan the owner's answer required (see findings)"
          : ""
    } ` +
    `in docs/plans/ with PLAN-INDEX.md; the run owner set the sequencing (${sequencing.chosenOption}). ` +
    `${gates.filter((g) => g.passed).length} of ${gates.length} verification checks pass` +
    `${stillFailing.length > 0 ? ` — ${stillFailing.map((g) => g.check).join(", ")} still failing` : ""}; ` +
    (commitNote.startsWith("Committed") ? "the set is committed in one batch." : "nothing was committed."),
  findings: [
    ...indexRepairFindings,
    ...duplicatePathFindings,
    ...gateFindings,
    ...review.gaps.map((gap) => ({
      where: "docs/plans/",
      what: gap,
      evidence: `raised by plan-set-reviewer (independent read): ${review.assessment.slice(0, 300)}`,
      status: "unconfirmed" as const,
      severity: "medium" as const,
    })),
    ...(commitApproval.approved
      ? []
      : [
          {
            where: "docs/plans/",
            what: "The one-batch commit did not happen: the run owner did not approve it.",
            evidence: commitApproval.feedback,
            status: "verified" as const,
            severity: "low" as const,
          },
        ]),
    ...recapFindings,
  ],
  verified: [
    `codebase-scanner mapped the surface and gaps sequentially in one context: ${surface.implemented.length} implemented items, ${gaps.length === 0 ? 0 : gaps.length} doc-vs-code gaps, ${infra.gaps.length} infra gaps`,
    `sequencing was decided by the run owner via escalation, recorded verbatim in ${index.path}: ${sequencing.chosenOption}`,
    `${planPaths.length} plans drafted one subagent per plan in batches of ${BATCH_SIZE}, each given the index per SKILL.md:124-127`,
    retrofitDraft !== undefined
      ? "the 00 retrofit meta-plan was drafted last with every other plan's verbatim Out-of-scope wording (SKILL.md:82-91)"
      : sequencing.retrofitPlanRequired
        ? "the owner's answer REQUIRED a 00 retrofit meta-plan, but no slot survived the index repair — it was never drafted; see the findings"
        : "no 00 retrofit plan was required by the owner's sequencing answer",
    `five deterministic gates ran over the new plans (grep frontmatter, grep cross-references, retrofit coverage, index-vs-disk numbering, wc/gitignore/branch drift) — ${gates.filter((g) => g.passed).length} of ${gates.length} pass`,
    `plan-set-reviewer read the index and plans fresh and reported ${review.gaps.length} gap(s)`,
    `commit approval was obtained from the run owner by escalation before any git write: ${commitApproval.approved ? "yes" : "no"}`,
    recapConfirmed
      ? `Post-recap section confirmed on disk by files.grep at ${confirmedFile}${
          recap.path !== undefined && recap.path !== todayRecap ? " — which is not today's recap; see the findings" : ""
        }`
      : `recap append not confirmed on disk at ${confirmedFile}: ${recap.note}`,
  ],
  notCovered: [
    "the plan files already under docs/plans/ were not re-verified — the five gates scope to the plans this run wrote",
    stillFailing.length === 0
      ? "no repository tests or builds were run — a plan set is prose; the skill's Phase-4 checks are the grep/wc/git gates above"
      : "the checks that still fail were not forced past the bounded repair loop",
    commitApproval.approved && commitNote.startsWith("Committed")
      ? "nothing was pushed — the skill's methodology commits in one batch and stops there"
      : "no commit or push — see the commit finding above",
    recap.snapshotPath === undefined
      ? "docs/STATE-SNAPSHOT.md does not exist in this workspace, so no plan-count refresh happened (SKILL.md:117 assumes a project-methodology file this repo does not have)"
      : `snapshot refreshed at ${recap.snapshotPath}`,
  ],
};

return result;
