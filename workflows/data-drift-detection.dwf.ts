/* zcode-workflow
description: "Detects data drift: runs the drift checks, measures the drift with
  independent confirmation, proposes redacted fixes behind an owner approval
  gate, and publishes the drift report. Embodies the data-drift-detection skill.
  Never writes without explicit owner approval."
whenToUse: When data may have drifted from its source of truth and needs
  measurement, confirmation, and gated fixes.
*/
/* eslint-disable max-lines -- a saved workflow is one self-contained script by contract and cannot be split into modules to satisfy the repo line limit; see the workflows library README */
// data-drift-detection.ts
// Dynamic workflow DRAFT: staging ↔ production data-drift detection, triage and fix routing.
// Embodying /Users/alejandrodelvillar/.agents/skills/data-drift-detection/SKILL.md (288 lines).
// Pattern: hybrid — structure in this script; every ask references the skill's SKILL.md by
// absolute path (the skill has NO references/ directory — verified this session) and the
// subagents read the cited sections themselves.
//
// STRUCTURE DISCLOSURE: the parent materials describe this skill as a "6-step" workflow, but
// the skill itself contains no 6-step procedure list — verified against its section map (read
// in full this session). Its only numbered lists are 3 items each: the active-backfill workflow
// (SKILL.md:87-89) and the intentional-drift reasons (SKILL.md:160-162). The stages below are
// therefore built from the skill's substance
// sections: The Script (:24-36), threshold interpretation (:37-49), the active-backfill vs
// real-lag triage matrix and campaign-log checks (:50-121), the row-count≠entity-count caveat
// (:122-139), the deprecation-filter ACTIVE-rows caveat (:140-155), intentional-drift
// annotation (:156-173), Tables Checked (:174-202), Connection Requirements (:203-215), and
// Resolving Drift (:231-288, with the status-drift UPDATE-only procedure :235-266 and the
// sync-to-production-v3.ts dry-run path :267-278).
//
// AVAILABILITY (verified this session): the skill ships no scripts/ directory (only
// SKILL.md), and this workspace's scripts/ contains neither detect-data-drift.sh nor
// sync-to-production-v3.ts. No world.run-skill-script clause applies. The first phase
// therefore deterministically checks availability with world.run and — when the script or
// the connection facts are missing — ESCALATES to the run owner or abstains rather than
// faking numbers. If a future workspace does carry the script, the same check flips the run
// onto the script route.
//
// CREDENTIAL RULES: the staging DATABASE_URL is read at run time by the subagents themselves
// from CLAUDE.local.md:72/:76/:107/:114 (verified line anchors) — it is never written into
// this script, any ask, any result, or any artifact, and every result is scrubbed through a
// redact() pass before it is reused or published. Production credentials are deliberately not
// pre-pinned (CLAUDE.local.md:52): prod access is granted only through the run-owner
// escalation in the first phase, and the owner's provisioning note — never a secret — is what
// travels.
//
// WRITE RULES: this workflow runs no write against any database unless the run owner approved
// that exact fix through the escalation gate. Permitted writes are status-drift UPDATEs only
// (SKILL.md:235-266), transaction-wrapped, IDs loaded via \copy from a pre-built local file.
// TRUNCATE, DELETE and DROP are prohibited outright and stringently guarded in this script.
// A sync is never executed by this workflow: row drift yields a dry-run plan (SKILL.md:267-278)
// that only the human owner may take further.
//
// world.run SCOPE: the deterministic gates here are the credential-free availability checks
// and the campaign-log presence check. The SQL comparisons themselves cannot be world.run
// gates — a world.run argument list would put connection credentials into the run journal —
// so the trust problem is bought down instead by an independent re-measurer per table group
// that re-runs the comparison queries itself before any number reaches the user.

// ─── Result interfaces (all named; every ask<T> uses one) ────────────────────

interface Finding {
  /** Stage and subject the finding is about, e.g. "corridor-core measurement". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the re-measure outcome, the world.run result, or the lines read. */
  evidence: string;
  /** "verified" only when an independent re-measurer reproduced it or a world.run decided it; otherwise "unconfirmed". */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for wrong data, data loss, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what this run found. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the world.run checks, the re-measures. */
  verified: string[];
  /** What the run did not measure and why: missing script, unprovisioned prod, absent tables. */
  notCovered: string[];
}

interface AvailabilityDecision {
  /** "script" when the drift script exists and is the chosen tool; "direct-sql" for per-table queries; "abstain" to measure nothing. */
  route: "script" | "direct-sql" | "abstain";
  /** "both" when the owner provisioned production read access; "staging-only" when not; "none" when abstaining. */
  prodAccess: "both" | "staging-only" | "none";
  /** The owner's provisioning route in the owner's own words — a route description, never a secret. */
  ownerNote: string;
  /** One paragraph: what was decided and on what evidence. */
  summary: string;
}

interface TableClaim {
  /** Raw PG table name exactly as measured (SKILL.md:226: raw names, not Prisma models). */
  table: string;
  /** The row filter the measurement applied, or "none" (SKILL.md:140-155 discipline). */
  rowFilter: string;
  /** Exact staging count from a query run now, or "absent: <reason>", or "not-measured: <reason>". */
  stagingCount: string;
  /** Exact production count from a query run now, or "absent: <reason>", or "not-measured: <reason>". */
  prodCount: string;
  /** The gap verdict in words per the threshold table (SKILL.md:37-49), or "not-computable" when a side is missing. */
  driftVerdict: string;
  /** Orphan-bloat cross-check outcome when the table is multi-row (SKILL.md:122-139), else "n/a". */
  orphanCheck: string;
  /** Most-recent computation timestamp per env when the table has one (SKILL.md:54-64), else "n/a". */
  latestTimestamp: string;
}

interface DriftClaim {
  /** The group id this claim belongs to. */
  groupId: string;
  /** "both" | "staging-only" | "none" — or "pipeline-failed" when the group's asks threw outright. What was actually measured, not what was hoped for. */
  measured: string;
  claims: TableClaim[];
  /** The queries and commands actually run, briefly — the basis of every number above. */
  basis: string;
  summary: string;
}

interface Remeasure {
  /** The group id that was re-measured. */
  groupId: string;
  /** True ONLY when this subagent re-ran the comparisons itself and every table agreed with the claim. */
  reproduced: boolean;
  /** Per table: "agree", or what differed, or "not-reproducible: <reason>". */
  perTable: { table: string; outcome: string }[];
  note: string;
}

interface TriageRow {
  groupId: string;
  /** One diagnosis per group, from the decision matrix (SKILL.md:66-74) and the posture rules (SKILL.md:106-120, :156-173). */
  diagnosis: "active-backfill" | "real-lag" | "two-writers" | "both-stale" | "prod-higher" | "intentional" | "no-drift" | "not-measured";
  /** The action the matrix prescribes for that diagnosis, in words. */
  action: string;
  /** The session-context annotation to record when drift is intentional (SKILL.md:164-172), empty when not applicable. */
  annotation: string;
}

interface TriageVerdict {
  rows: TriageRow[];
  /** What the campaign-log check found and whether it could be read here. */
  campaignLogNote: string;
  summary: string;
}

interface FixProposal {
  /** Stable short id for this fix, like "fix-1". */
  fixId: string;
  groupId: string;
  /** Status drift (same totals, divergent status split), row drift (different ID sets), or annotation-only. */
  driftType: "status-drift" | "row-drift" | "intentional-only" | "none";
  /** "update-only" for SKILL.md:235-266 fixes; "sync-dry-run" for the SKILL.md:267-278 path; "no-write" otherwise. */
  writeClass: "update-only" | "sync-dry-run" | "no-write";
  /** The exact commands/SQL for the run owner — transaction-wrapped for update-only, dry-run-only for sync. */
  plan: string;
  /** What blocks execution here (provisioning, canonicity confirmation, campaign state), empty when nothing does. */
  blockedBy: string;
}

interface FixRouting {
  fixes: FixProposal[];
  summary: string;
}

interface OwnerDecision {
  fixId: string;
  approved: boolean;
  /** How the owner provisioned access for this fix, in the owner's words — empty when denied. */
  provisioning: string;
}

interface OwnerGateResult {
  decisions: OwnerDecision[];
  note: string;
}

interface ExecutionOutcome {
  fixId: string;
  /** True only when the UPDATE actually ran in a transaction and the post-fix comparison confirms it. */
  done: boolean;
  /** The command evidence, before/after comparison, or exactly why nothing was done. */
  evidence: string;
}

interface ExecutionResult {
  outcomes: ExecutionOutcome[];
  note: string;
}

interface PostfixCheck {
  fixId: string;
  /** True only when this verifier re-ran the comparison itself and it confirms the claim. */
  holds: boolean;
  note: string;
}

interface ReportDraft {
  /** The full markdown drift report. */
  markdown: string;
}

// ─── Script constants (fixed facts from the skill; thresholds stay OUT of ask text) ───

const SKILL = "/Users/alejandrodelvillar/.agents/skills/data-drift-detection/SKILL.md";

/** Grouping spec for one measurement fan-out unit. NOT the facade's TableSpec (SKILL.md §16.2): a local interface with that name would collide with the artifact.table spec type. */
interface MeasuredTable {
  table: string;
  /** Row filter the measurement must apply; empty string means no filter. */
  filter: string;
  /** Parent entity table for the orphan-bloat cross-check (SKILL.md:122-139); empty means n/a. */
  orphanParent: string;
}

interface GroupSpec {
  id: string;
  label: string;
  postureNote: string;
  tables: MeasuredTable[];
}

// Groups built from Tables Checked (SKILL.md:174-202) and the backfill-posture table
// (SKILL.md:106-120). Ids are script-defined literals and structurally unique — they key
// the fan-out subagent names.
const GROUPS: GroupSpec[] = [
  {
    id: "reference-entities",
    label: "Reference entities (cruise lines, ships, ports)",
    postureNote:
      "Scraper-derived reference data — per SKILL.md:117-118 any drift here is a real problem, never an active backfill.",
    tables: [
      { table: "cruise_lines", filter: "WHERE status = 'active'", orphanParent: "" },
      { table: "ships", filter: "WHERE status = 'active'", orphanParent: "" },
      { table: "cruisemapper_ports", filter: "", orphanParent: "" },
    ],
  },
  {
    id: "itineraries",
    label: "Active itineraries",
    postureNote:
      "Per SKILL.md:48 a modest production surplus is normal under the status filter — flag only what the threshold table calls out. A same-total status-split divergence has its own resolution path at SKILL.md:235-266.",
    tables: [{ table: "ship_itineraries", filter: "WHERE status = 'active'", orphanParent: "" }],
  },
  {
    id: "corridor-core",
    label: "Corridor core (route_corridors, corridor_profiles)",
    postureNote:
      "route_corridors is deterministic from port data (SKILL.md:116) — treat drift as real lag. corridor_profiles counts rows, not living corridors: apply the orphan cross-check of SKILL.md:122-139 and report corridors, not rows.",
    tables: [
      { table: "route_corridors", filter: "", orphanParent: "" },
      { table: "corridor_profiles", filter: "", orphanParent: "route_corridors" },
    ],
  },
  {
    id: "insight-derived",
    label: "Insight and derived tables (family/T4, upgrade/T2, line/T7, ship-corridor/T6, seasonal, persona-fit, dep hashes)",
    postureNote:
      "LLM-derived tables — expect active-backfill drift (SKILL.md:106-120, covering the T2/T4/T5/T6/T7 families plus corridor_profiles and corridor_dep_hashes). ship_corridor_insights MUST be measured on active rows only (SKILL.md:148-152). Gather the latest computation timestamp per table on both envs where such a column exists (diagnostic form at SKILL.md:54-64); say so when a table has none. T4's name conflicts inside the skill — Tables Checked (:184) says family_insights, the posture table (:111) says corridor_family_insights: try both spellings and record the one that does not exist as 'absent: no such table (other spelling also tried)'.",
    tables: [
      { table: "corridor_dep_hashes", filter: "", orphanParent: "route_corridors" },
      { table: "family_insights", filter: "", orphanParent: "" },
      { table: "corridor_family_insights", filter: "", orphanParent: "" },
      { table: "corridor_upgrade_insights", filter: "", orphanParent: "" },
      { table: "cruise_line_insights", filter: "", orphanParent: "" },
      { table: "ship_corridor_insights", filter: "WHERE deprecated_at IS NULL", orphanParent: "" },
      { table: "corridor_seasonal_profiles", filter: "", orphanParent: "route_corridors" },
      { table: "corridor_persona_fit", filter: "", orphanParent: "route_corridors" },
      { table: "corridor_line_presence", filter: "", orphanParent: "route_corridors" },
      { table: "family_topology", filter: "", orphanParent: "" },
    ],
  },
  {
    id: "content-cache",
    label: "Content and embedding caches",
    postureNote:
      "Caches and embeddings — apply the filters from SKILL.md:186 and :200; a total-row comparison says nothing for the filtered one.",
    tables: [
      { table: "ai_chat_response_cache", filter: "WHERE hasEmbedding = true", orphanParent: "" },
      { table: "content_embeddings", filter: "", orphanParent: "" },
      { table: "content_similarity", filter: "", orphanParent: "" },
      { table: "blog_posts", filter: "", orphanParent: "" },
    ],
  },
  {
    id: "port-geo-media",
    label: "Port, geo and media tables",
    postureNote:
      "Plain row comparisons. Note sea_distances appears twice in the skill's table list (SKILL.md:194 and :201) — measure it once.",
    tables: [
      { table: "port_land_summaries", filter: "", orphanParent: "" },
      { table: "route_map_svgs", filter: "", orphanParent: "" },
      { table: "port_building_geojson", filter: "", orphanParent: "" },
      { table: "port_hero_images", filter: "", orphanParent: "" },
      { table: "port_map_overrides", filter: "", orphanParent: "" },
      { table: "port_connectivity", filter: "", orphanParent: "" },
      { table: "sea_distances", filter: "", orphanParent: "" },
    ],
  },
];

// ─── Dashboard, salvage helper, redaction ────────────────────────────────────

artifact.board("drift-groups", {
  title: "Table groups: drift measured and re-verified",
  key: "groupId",
  status: "stage",
  columns: ["measuring", "re-verified", "unverified", "blocked"],
  cardTitle: "label",
  detail: [{ field: "note" }],
});

const allFindings: Finding[] = [];
function emitFinding(finding: Finding): void {
  allFindings.push(finding);
  report(finding);
}

function card(groupId: string, label: string, stage: string, note: string): { groupId: string; label: string; stage: string; note: string } {
  return { groupId, label, stage, note };
}

/** Belt-and-braces scrub: no connection string may travel into a reused ask, a result, or an artifact. */
function redact(text: string): string {
  return text.replace(/postgresql:\/\/[^\s"'<>]+/g, "postgresql://[redacted]");
}

// ─── Phase 1: deterministic availability gate ────────────────────────────────
// Escalates or abstains when the tooling or the connection facts are missing —
// it never lets the run invent numbers.

phase("Check what this run can measure");

const skillCheck = await world.run("test", ["-f", SKILL]);
const skillPresent = skillCheck.exitCode === 0;
const driftScriptCheck = await world.run("ls", ["scripts/detect-data-drift.sh"]);
const scriptPresent = driftScriptCheck.exitCode === 0;
const syncScriptCheck = await world.run("ls", ["scripts/sync-to-production-v3.ts"]);
const syncScriptPresent = syncScriptCheck.exitCode === 0;
const stagingUrlCheck = await world.run("grep", ["-c", "DATABASE_URL", "CLAUDE.local.md"]);
const stagingUrlPresent = stagingUrlCheck.exitCode === 0 && Number(stagingUrlCheck.stdout.trim()) > 0;
const psqlCheck = await world.run("which", ["psql"]);
const psqlPresent = psqlCheck.exitCode === 0;
const npxCheck = await world.run("which", ["npx"]);
const npxPresent = npxCheck.exitCode === 0;

const gateEvidence = {
  skillFilePresent: skillPresent,
  driftScriptPresent: scriptPresent,
  syncScriptPresent: syncScriptPresent,
  stagingDatabaseUrlLinesInClaudeLocalMd: stagingUrlPresent,
  psqlAvailable: psqlPresent,
  npxAvailable: npxPresent,
};
log(
  `Availability: skill=${skillPresent} driftScript=${scriptPresent} stagingUrl=${stagingUrlPresent} psql=${psqlPresent} npx=${npxPresent}`
);

const arbiter = agent("availability-arbiter", {
  system:
    "You decide whether a data-drift measurement run can proceed, on deterministic evidence only. " +
    "The skill has no 6-step procedure list; its procedure lives in the sections of " + SKILL +
    " cited in the ask — read them. If the evidence shows the run cannot measure honestly, or a fact " +
    "only the run owner can supply is missing, escalate and ask plainly rather than working around it. " +
    "If your escalation allowance is spent without an answer, return route 'abstain' rather than " +
    "inventing a route. Never copy any credential into your result.",
});

const decision = await arbiter.ask<AvailabilityDecision>(
  "This run measures staging-vs-production data drift per the skill at " + SKILL +
    " (The Script :24-36, Connection Requirements :203-215). Deterministic checks just ran; their " +
    "results:\n" +
    JSON.stringify(gateEvidence, null, 2) +
    "\n\nStructure note: the skill has no 6-step procedure list (its only numbered lists are the " +
    "3-item backfill workflow at :87-89 and the 3 intentional-drift reasons at :160-162) — its " +
    "procedure lives in the sections cited here and in the later asks; this run's stages follow " +
    "those sections.\n\n" +
    "Decide the route:\n" +
    "- If the skill file itself is missing, return route 'abstain' — the run cannot embody a skill it cannot read.\n" +
    "- Route 'script' is valid ONLY when driftScriptPresent is true; the measurers would run " +
    "bash scripts/detect-data-drift.sh for orientation and still re-derive every per-table number themselves.\n" +
    "- Route 'direct-sql' is the per-table measurement path when the script is absent but the connection " +
    "facts and a query tool are present. The staging DATABASE_URL is read at run time by the measurers " +
    "from CLAUDE.local.md:72/:76/:107/:114 — never by this script.\n" +
    "- Production credentials are deliberately not pre-pinned (CLAUDE.local.md:52). For prodAccess 'both' " +
    "you must escalate to the run owner NOW, present this evidence, and ask them to provision production " +
    "read access and state the provisioning route in their own words. If they decline or cannot, use " +
    "prodAccess 'staging-only' and say what that leaves unmeasured. If they prefer the run to stop, use " +
    "route 'abstain'.\n" +
    "In ownerNote, record the provisioning ROUTE the owner stated (for example: which file or channel the " +
    "measurers may use) — never any secret itself. Return an AvailabilityDecision.",
);

// Deterministic facts override the arbiter: a 'script' route without a script is a contradiction.
let route = decision.route;
if (route === "script" && !scriptPresent) {
  emitFinding({
    where: "availability gate",
    what: "Arbiter returned the script route but scripts/detect-data-drift.sh does not exist — coerced to direct-SQL on the deterministic evidence",
    evidence: "world.run('ls', ['scripts/detect-data-drift.sh']) exited nonzero",
    status: "verified",
    severity: "medium",
  });
  route = "direct-sql";
}
log(`Route: ${route}, prod access: ${decision.prodAccess}`);

if (route === "abstain" || !skillPresent || decision.prodAccess === "none") {
  const abstainMd = [
    "# Data drift check — abstained",
    "",
    "This run measured nothing, on purpose. The availability gate could not establish an honest",
    "measurement path, and the skill's own rule is to escalate or abstain rather than fake numbers.",
    "",
    "## Deterministic evidence",
    JSON.stringify(gateEvidence, null, 2),
    "",
    "## Decision",
    redact(decision.summary),
    "",
    "## What would unblock a re-run",
    "- The drift script, or approval of the direct-SQL route (SKILL.md:24-36, :54-64).",
    "- Staging DATABASE_URL reachable in CLAUDE.local.md:72/:76/:107/:114.",
    "- Production access provisioned by the run owner (CLAUDE.local.md:52 — not pre-pinned by design).",
  ].join("\n");
  try {
    await artifact.markdown("drift-report", abstainMd, {
      title: "Data drift check — abstained",
      description: "No numbers were produced: the availability gate could not establish an honest measurement path.",
      primary: true,
    });
  } catch {
    try {
      await artifact.markdown(
        "drift-report",
        "# Data drift check — abstained\n\nNo numbers were produced. Evidence: " +
          redact(JSON.stringify(gateEvidence)) +
          "\n\nDecision: " +
          redact(decision.summary),
        { title: "Data drift check — abstained", primary: true },
      );
    } catch {
      log("Both artifact publishes failed — the abstention is recorded in the run result only.");
    }
  }
  const abstained: WorkflowReport = {
    conclusion:
      "Abstained before measuring: " + redact(decision.summary) +
      " No drift numbers exist from this run — none were invented.",
    findings: allFindings,
    verified: [
      "Availability was decided by deterministic world.run checks (test -f, ls, grep -c, which), not by subagent claims.",
    ],
    notCovered: [
      "Every table group — nothing was measured; see the decision summary for what was missing.",
      "The production comparison in particular (prod credentials are not pre-pinned, CLAUDE.local.md:52).",
    ],
  };
  return abstained;
}

// ─── Phase 2: per-group measurement with independent re-measurement ──────────

phase("Measure each table group and re-verify every number");

log(`Measuring ${GROUPS.length} table groups in parallel, each with an independent re-measurer`);

interface GroupResult {
  group: GroupSpec;
  claim: DriftClaim;
  check: Remeasure;
}

const measured: GroupResult[] = await Promise.all(
  GROUPS.map(async (group): Promise<GroupResult> => {
    // §7: one bad group must not reject the whole join — a failed group is recorded as
    // blocked here so the other groups' salvage survives; the post-join loop skips it.
    try {
    const measurer = agent(`measurer-${group.id}`, {
      system:
        "You measure database drift between staging and production for one group of tables. Read the " +
        "cited sections of " + SKILL + " before measuring, and cite them in your basis. Every number in " +
        "your result must come from a query you ran just now — never from a workspace document or a prior " +
        "number. Never copy any credential into your result. If a check is impossible to pass, or your " +
        "instructions contradict each other, escalate and say so plainly rather than working around it.",
    });

    const claim = await measurer.ask<DriftClaim>(
      "Measure one group of tables for staging-vs-production drift.\n\n" +
        "Reference: " + SKILL + " — read these sections first: The Script (:24-36), threshold " +
        "interpretation (:37-49), the active-backfill triage and campaign-log checks (:50-121), the " +
        "row-count caveat (:122-139), the active-rows filter rule (:140-155), Tables Checked (:174-202), " +
        "Connection Requirements (:203-215).\n\n" +
        "Group: " + group.label + " (" + group.id + ")\n" +
        "Posture: " + group.postureNote + "\n" +
        "Tables, with the row filter each measurement MUST apply:\n" +
        JSON.stringify(group.tables, null, 2) + "\n\n" +
        "Connection facts:\n" +
        "- Staging DATABASE_URL: read it yourself at run time from CLAUDE.local.md lines 72, 76, 107 or 114 " +
        "(they repeat the same staging URL). Report numbers and table names only — never the URL.\n" +
        (decision.prodAccess === "both"
          ? "- Production: the run owner provisioned production read access. Provisioning route (owner's words): " +
            redact(decision.ownerNote) + "\n"
          : "- Production: NOT provisioned for this run. Measure staging-side facts only (including the orphan " +
            "cross-checks and latest timestamps, which work staging-side) and record every prodCount as " +
            "'not-measured: prod access not provisioned'.\n") +
        "- Tooling: psql is " + (psqlPresent ? "available" : "NOT on PATH — use the npx tsx + Prisma form of " +
          "SKILL.md:54-64 (npx itself is " + (npxPresent ? "available" : "NOT on PATH either — escalate") + ")" ) + ".\n" +
        "- If a table does not exist in these databases, record its count as 'absent: no such table' — never a guess.\n\n" +
        "Measurement discipline:\n" +
        "- Apply each table's filter exactly; a wrong filter makes the number meaningless (SKILL.md:140-155).\n" +
        "- For tables with orphanParent set, run the parent comparison of SKILL.md:128-136 and put the outcome " +
        "in orphanCheck.\n" +
        (route === "script"
          ? "- The drift script IS present: you may run bash scripts/detect-data-drift.sh --json first for " +
            "orientation (SKILL.md:24-35), but you still re-derive every per-table number with your own query.\n"
          : "- The drift script is not in this workspace; direct queries are the only path (the route chosen " +
            "in the availability check).\n") +
        "- Measurement only: run no UPDATE, no DELETE, no TRUNCATE, no DROP, and no sync of any kind.\n\n" +
        "Return a DriftClaim: measured, one claim per table (exact numbers or the stated literals), the " +
        "basis (the queries you actually ran), and a summary.",
    );

    report(card(group.id, group.label, "measuring", "measured — re-verification next"), "drift-groups");

    const remeasurer = agent(`remeasurer-${group.id}`, {
      system:
        "You independently re-verify someone else's drift measurements by re-running the comparisons " +
        "yourself. You never trust the numbers you are handed: recompute them. Read the cited sections of " +
        SKILL + " first. Never copy any credential into your result. If you cannot reproduce a number " +
        "because access or schema changed, say exactly that instead of guessing.",
    });

    const check = await remeasurer.ask<Remeasure>(
      "A measurer claims the following for table group '" + group.id + "' (" + group.label + "):\n" +
        redact(JSON.stringify(claim, null, 2)) + "\n\n" +
        "Re-run the comparison queries YOURSELF — same rules: each table's filter from the group definition " +
        "(staging DATABASE_URL from CLAUDE.local.md:72/:76/:107/:114 read by you; production per this " +
        "provisioning route: " +
        (decision.prodAccess === "both" ? redact(decision.ownerNote) : "NOT provisioned — verify only that the " +
          "claim honestly records prod as not-measured, and check the staging-side numbers and cross-checks") +
        "). Then judge table by table: agree, or what differs, or not-reproducible and why.\n\n" +
        "Return a Remeasure: reproduced is true ONLY if you re-ran the queries and every table agreed.",
    );

    return { group, claim, check };
    } catch (groupError) {
      const note = "the group's measurement pipeline failed outright: " + String(groupError);
      emitFinding({
        where: `group ${group.id} measurement`,
        what: "Measurement ask failed — group recorded as blocked, no number fabricated",
        evidence: note,
        status: "unconfirmed",
        severity: "high",
      });
      log("group " + group.id + " pipeline-failed — its single board card is emitted by the post-join loop");
      return {
        group,
        claim: { groupId: group.id, measured: "pipeline-failed", claims: [], basis: "no query completed", summary: note },
        check: { groupId: group.id, reproduced: false, perTable: [], note },
      };
    }
  }),
);

for (const result of measured) {
  const reproduced = result.check.reproduced;
  const blocked = result.claim.measured === "pipeline-failed";
  if (!blocked) {
    emitFinding({
      where: `group ${result.group.id} measurement`,
      what: reproduced
        ? `Numbers for ${result.group.label} were independently re-measured and confirmed`
        : `Numbers for ${result.group.label} could not be independently confirmed by the re-measurer`,
      evidence: reproduced
        ? `re-measurer re-ran the comparisons: ${result.check.note}`
        : `re-measurer outcome: ${result.check.note}`,
      status: reproduced ? "verified" : "unconfirmed",
      severity: reproduced ? "low" : "high",
    });
  }
  report(
    card(
      result.group.id,
      result.group.label,
      reproduced ? "re-verified" : blocked ? "blocked" : "unverified",
      result.check.note,
    ),
    "drift-groups",
  );
}

// ─── Phase 3: triage — active backfill or real lag? ──────────────────────────

phase("Triage the drift: backfill in progress or real lag");

const campaignLogs = await world.run("ls", ["-t", "scripts/insights/runs"]);
const campaignNote =
  campaignLogs.exitCode === 0
    ? "scripts/insights/runs exists in this workspace — read the newest logs per SKILL.md:91-102 yourself."
    : "scripts/insights/runs does not exist in this workspace (world.run ls exited nonzero) — the " +
      "campaign-log checks of SKILL.md:91-102 have nothing to read here; base the triage on the measured " +
      "timestamps alone and say so.";

const triageAgent = agent("drift-triage", {
  system:
    "You are the one triage context that sees every group's results together, so your diagnoses are " +
    "consistent across groups. Apply the decision matrix at SKILL.md:66-74 and the posture rules at " +
    "SKILL.md:106-120, using the skill at " + SKILL + ". A gap whose numbers failed re-verification supports " +
    "no diagnosis: mark that group 'not-measured'. You never edit files and never run writes. If your " +
    "instructions contradict each other, escalate and say so plainly.",
});

const triage = await triageAgent.ask<TriageVerdict>(
  "Triage the measured drift. Evidence (claims with their independent re-verification):\n" +
    redact(
      JSON.stringify(
        measured.map((m) => ({
          groupId: m.group.id,
          posture: m.group.postureNote,
          claim: m.claim,
          remeasure: m.check,
        })),
        null,
        2,
      ),
    ) +
    "\n\nCampaign-log check result: " +
    campaignNote +
    "\n\nPer group, return one TriageRow: the diagnosis from the decision matrix (SKILL.md:66-74), the " +
    "action the matrix prescribes, and — when the diagnosis is intentional drift — the session-context " +
    "annotation in the form of SKILL.md:164-172. Deterministic tables (SKILL.md:116-118) get no " +
    "active-backfill benefit of the doubt. Prod higher than staging is its own matrix row. Groups whose " +
    "numbers did not reproduce are 'not-measured'. Return a TriageVerdict.",
);

for (const row of triage.rows) {
  if (row.diagnosis !== "no-drift" && row.diagnosis !== "not-measured") {
    const underlying = measured.find((m) => m.group.id === row.groupId);
    const numbersReproduced = underlying !== undefined && underlying.check.reproduced;
    emitFinding({
      where: `group ${row.groupId} triage`,
      what: `Diagnosis: ${row.diagnosis} — ${row.action}`,
      evidence:
        (numbersReproduced ? "built on re-verified numbers; " : "built on numbers that did NOT reproduce; ") +
        redact(row.annotation || triage.summary),
      status: "unconfirmed",
      severity: row.diagnosis === "real-lag" ? "high" : "medium",
    });
  }
}

// ─── Phase 4: route each drift to its resolution path ────────────────────────

phase("Route each drift to its resolution path");

const fixRouter = agent("fix-router", {
  system:
    "You classify measured drift into resolution paths per Resolving Drift in " + SKILL +
    " (:231-288). You never execute anything: you produce plans. TRUNCATE, DELETE and DROP are prohibited " +
    "in every plan you write; a status fix is an UPDATE-only, transaction-wrapped procedure with IDs loaded " +
    "via \\copy from a pre-built local file (:235-266, :265); a row drift is a dry-run plan only (:267-278) — " +
    "the sync itself is out of this workflow's reach; intentional drift gets an annotation, not a write " +
    "(:156-173). If your instructions contradict each other, escalate and say so plainly.",
});

const routing = await fixRouter.ask<FixRouting>(
  "Route each triaged drift to its resolution path. Inputs — triage verdict (with the re-verification " +
    "status of the numbers underneath):\n" +
    redact(JSON.stringify({ triage, groups: measured.map((m) => ({ id: m.group.id, label: m.group.label })) }, null, 2)) +
    "\n\nReference: " + SKILL + " — Resolving Drift (:231-288): status drift (:235-266, UPDATE-only, the " +
    "export-compare-UPDATE workflow, the \\copy pitfall at :265), row drift (:267-278, dry-run first), " +
    "intentional drift (:156-173, annotation only).\n\n" +
    "Rules for every FixProposal:\n" +
    "- driftType 'status-drift' → writeClass 'update-only': the plan exports both status splits, diffs the " +
    "IDs, and UPDATEs one side to match the canonical side inside one transaction — no deleted rows, no " +
    "recreated tables.\n" +
    "- driftType 'row-drift' → writeClass 'sync-dry-run': the plan is the dry-run commands ONLY " +
    "(SKILL.md:267-278). The live sync is never part of this workflow's reach; note in blockedBy what the " +
    "owner must confirm (staging canonical per SKILL.md:72's row) before any dry-run.\n" +
    "- driftType 'intentional-only' → writeClass 'no-write': the plan is the annotation text.\n" +
    "- Every plan states which side is canonical and why (SKILL.md:72: staging is the source of truth unless " +
    "the owner says otherwise).\n" +
    "- A group diagnosed 'no-drift' or 'not-measured' gets no fix.\n" +
    "Return a FixRouting.",
);

// Deterministic guard: no prohibited statement may survive in any plan, and fix ids are
// renumbered in script so the owner gate's decisions map onto fixes deterministically
// (router-emitted ids are not guaranteed unique).
const prohibited = /^\s*(TRUNCATE|DELETE|DROP)\b/im;
const cleanFixes: FixProposal[] = routing.fixes.map((fix, position): FixProposal => {
  const numbered: FixProposal = { ...fix, fixId: "fix-" + (position + 1) };
  if (!prohibited.test(numbered.plan)) return numbered;
  emitFinding({
    where: `fix ${numbered.fixId} (${numbered.groupId})`,
    what: "Fix plan withheld: it contained a prohibited statement (TRUNCATE, DELETE or DROP) — replaced with a no-write plan",
    evidence: "script-side regex guard over the router's plan text",
    status: "verified",
    severity: "high",
  });
  return {
    ...numbered,
    writeClass: "no-write",
    plan: "[withheld by script guard: prohibited statement]",
    blockedBy: "plan must be rewritten as UPDATE-only or annotation-only",
  };
});
const actionable = cleanFixes.filter((f) => f.writeClass !== "no-write");
log(`${cleanFixes.length} fixes routed, ${actionable.length} with a write plan`);

// ─── Phase 5: the escalation gate — every fix goes to the run owner ──────────

let gate: OwnerGateResult = { decisions: [], note: "no fixes required any owner decision" };

if (cleanFixes.length > 0) {
  const ownerGate = agent("run-owner-gate", {
    system:
      "You are the escalation gate between a drift-analysis run and its human owner. Every proposed fix " +
      "must reach the run owner through your escalate tool, in one question that lists each fixId with its " +
      "plan and its write class, and asks approve/deny per fix plus how access is provisioned for any " +
      "approved one. You never decide on the owner's behalf and never mark a fix approved yourself: if you " +
      "cannot reach the owner, every decision comes back approved=false with that reason.",
  });

  phase("Put the proposed fixes before the run owner");
  gate = await ownerGate.ask<OwnerGateResult>(
    "Reference: " + SKILL + " — Resolving Drift (:231-288) defines the write classes below.\n\n" +
      "Put every proposed fix before the run owner now, by escalating with this exact list:\n" +
      redact(JSON.stringify(cleanFixes, null, 2)) +
      "\n\nFor each fixId record an OwnerDecision: approved true/false, and for any approved update-only fix " +
      "the provisioning route in the owner's words (which credentials file or channel the executor may use " +
      "— never a secret itself). Sync plans are NEVER approved for execution by this run: the most the " +
      "owner can grant there is 'prepare the dry-run', and the note must say the owner runs the sync " +
      "themselves. Return an OwnerGateResult.",
  );
  for (const d of gate.decisions) {
    emitFinding({
      where: `fix ${d.fixId}`,
      what: d.approved ? "Run owner approved this fix" : "Run owner did not approve this fix",
      evidence: redact(d.provisioning || gate.note),
      status: "verified",
      severity: "low",
    });
  }
  if (gate.decisions.length < cleanFixes.length) {
    emitFinding({
      where: "owner gate",
      what: `The gate returned ${gate.decisions.length} decisions for ${cleanFixes.length} proposed fixes — the difference is unresolved, not denied`,
      evidence: "script-side count comparison of decisions returned against fixes sent",
      status: "verified",
      severity: "medium",
    });
  }
}

// ─── Phase 6: apply the approved status fixes (update-only, provisioned) ─────

const approvedUpdates = cleanFixes.filter(
  (f) =>
    f.writeClass === "update-only" &&
    gate.decisions.some((d) => d.fixId === f.fixId && d.approved && d.provisioning.trim().length > 0),
);

if (approvedUpdates.length > 0) {
  phase("Apply the status fixes the owner approved");

  const executor = agent("status-fix-executor", {
    system:
      "You execute exactly the status-drift UPDATEs the run owner approved — nothing else. Rules: UPDATE " +
      "statements only; TRUNCATE, DELETE and DROP are prohibited outright; every fix runs inside one " +
      "transaction (BEGIN; ... COMMIT;) with mismatch IDs loaded via \\copy from a pre-built local file " +
      "(SKILL.md:255-265). If the provisioning the owner gave does not actually work from this machine, do " +
      "nothing for that fix and report done=false with what you found — never fake an execution. If your " +
      "instructions contradict each other, escalate and say so plainly.",
  });

  const execution = await executor.ask<ExecutionResult>(
    "Apply each approved status fix exactly as planned. Approved fixes and their provisioning:\n" +
      redact(
        JSON.stringify(
          approvedUpdates.map((f) => ({
            fix: f,
            provisioning: gate.decisions.find((d) => d.fixId === f.fixId)?.provisioning ?? "",
          })),
          null,
          2,
        ),
      ) +
      "\n\nReference: " + SKILL + " — the status-drift procedure (:243-266): export both status splits, " +
      "diff, build the mismatch ID file, then one transaction per fix with the \\copy load and the UPDATE. " +
      "After each applied fix, re-run the comparison that justified it and record before/after in evidence. " +
      "A fix you could not actually apply is done=false with the reason — never a claim. " +
      "Return an ExecutionResult.",
  );

  // The executor attests its own writes, which is not confirmation — each applied fix is
  // re-verified by an independent subagent that re-runs the comparison itself (the phase-2
  // pattern). Only a reproduced post-fix state is reported "verified".
  for (const fix of approvedUpdates) {
    const outcome = execution.outcomes.find((o) => o.fixId === fix.fixId);
    if (outcome === undefined || !outcome.done) {
      emitFinding({
        where: `fix ${fix.fixId} execution`,
        what: outcome === undefined ? "The executor returned no outcome for this approved fix" : "Approved status fix was NOT applied",
        evidence: redact(outcome?.evidence ?? gate.decisions.find((d) => d.fixId === fix.fixId)?.provisioning ?? ""),
        status: "unconfirmed",
        severity: "high",
      });
      continue;
    }
    const verifier = agent(`post-fix verifier ${fix.fixId}`, {
      system:
        "You independently verify a claimed database fix by re-running the comparison that justified it. " +
        "You never trust the claim: re-run the status-split comparison yourself (staging DATABASE_URL from " +
        "CLAUDE.local.md:72/:76/:107/:114; production per the provisioning below). Never copy any credential " +
        "into your result. If you cannot re-run it, say exactly that instead of agreeing.",
    });
    const check = await verifier.ask<PostfixCheck>(
      "An executor claims this fix was applied and the divergence resolved:\n" +
        redact(JSON.stringify(outcome, null, 2)) + "\n\n" +
        "The plan it followed:\n" + redact(fix.plan) + "\n\n" +
        "Re-run the export-and-compare of SKILL.md:243-250 yourself and judge whether the claimed post-fix " +
        "state holds now. Return a PostfixCheck: holds is true ONLY if you re-ran the comparison and it " +
        "confirms the claim.",
    );
    emitFinding({
      where: `fix ${fix.fixId} execution`,
      what: check.holds
        ? "Approved status fix applied and independently re-verified"
        : "Applied fix could NOT be independently re-verified",
      evidence: "executor: " + redact(outcome.evidence) + " — verifier: " + redact(check.note),
      status: check.holds ? "verified" : "unconfirmed",
      severity: check.holds ? "low" : "high",
    });
  }
} else {
  log("No provisioned update-only fixes — nothing was written to any database.");
}

// ─── Phase 7: write and publish the drift report ─────────────────────────────

phase("Write the drift report and hand it over");

const reportWriter = agent("report-writer", {
  system:
    "You write structured drift reports. Never invent numbers or outputs not present in the input; carry " +
    "every number with its verification status (re-verified or not). No credential may appear anywhere in " +
    "the report. Flag plainly what was not measured and why. The skill at " + SKILL +
    " has no 6-step procedure list — the report's structure follows its sections, and the report says so.",
});

const draft = await reportWriter.ask<ReportDraft>(
  "Write the markdown drift report for this run. Structure it per the skill at " + SKILL +
    ": per-group numbers with filters applied (:140-155) and orphan cross-checks (:122-139); the triage " +
    "diagnoses (:66-74, :106-120) with the intentional-drift annotations (:156-173); the resolution routing " +
    "(:231-288); what the owner approved, denied, or was never asked; what was executed and what awaits the " +
    "owner's own hand (sync dry-runs :267-278). Open with a status line saying what was measured, what was " +
    "re-verified, and what was not. Include one disclosure sentence: the skill has no 6-step procedure " +
    "list (its only numbered lists are the 3-item backfill workflow at :87-89 and the 3 intentional-drift " +
    "reasons at :160-162); this run's stages follow its substance sections. Include the campaign-log " +
    "finding verbatim. " +
    "Never include a connection string.\n\nRun results:\n" +
    redact(
      JSON.stringify(
        {
          gate: { evidence: gateEvidence, decision: { route, prodAccess: decision.prodAccess, summary: decision.summary } },
          groups: measured.map((m) => ({ id: m.group.id, label: m.group.label, claim: m.claim, remeasure: m.check })),
          triage: triage,
          routing: { fixes: cleanFixes },
          ownerGate: gate,
        },
        null,
        2,
      ),
    ) +
    "\n\nReturn a ReportDraft with the full markdown.",
);

const compactReport = [
  "# Data drift check — compact fallback report",
  "",
  "The full report failed to publish; this compact version is composed from the same run results.",
  "",
  `- Route: ${route}, production access: ${decision.prodAccess}`,
  ...measured.map((m) => `- ${m.group.label}: ${m.claim.summary} — re-verified: ${m.check.reproduced ? "yes" : "NO"}`),
  ...triage.rows.map((r) => `- Triage ${r.groupId}: ${r.diagnosis}`),
  ...cleanFixes.map((f) => `- Fix ${f.fixId} (${f.driftType}, ${f.writeClass}): ${f.blockedBy || "plan ready"}`),
  `- Owner decisions recorded: ${gate.decisions.length}`,
].join("\n");

let reportPublished = false;
try {
  await artifact.markdown("drift-report", redact(draft.markdown), {
    title: "Data drift report",
    description: "Staging-vs-production drift, independently re-measured, triaged and routed.",
    primary: true,
  });
  reportPublished = true;
} catch {
  log("Full report publish failed — publishing the compact fallback.");
  try {
    await artifact.markdown("drift-report", redact(compactReport), {
      title: "Data drift report (compact)",
      description: "Compact fallback: the same facts the full report carried.",
      primary: true,
    });
    reportPublished = true;
  } catch {
    log("Both report publishes failed — the results below are the only record.");
  }
}

// ─── Final WorkflowReport ────────────────────────────────────────────────────

const reproducedCount = measured.filter((m) => m.check.reproduced).length;

const result: WorkflowReport = {
  conclusion:
    `Measured ${measured.length} table groups for staging-vs-production drift; ${reproducedCount} of them ` +
    `were independently re-measured and confirmed. Triage classified the gaps ` +
    `(${triage.rows.filter((r) => r.diagnosis === "active-backfill").length} active backfill, ` +
    `${triage.rows.filter((r) => r.diagnosis === "real-lag").length} real lag, ` +
    `${triage.rows.filter((r) => r.diagnosis === "intentional").length} intentional); ` +
    `${cleanFixes.length} fixes were routed and ${gate.decisions.length} decisions were put to the run ` +
    `owner. ${reportPublished ? "The full report is published." : "Publishing failed — see the findings."}`,
  findings: allFindings,
  verified: [
    "Availability was decided by deterministic world.run checks: test -f on the skill path, ls on both scripts, grep -c on CLAUDE.local.md, which for the query tools.",
    `${reproducedCount} of ${measured.length} group measurements were re-run from scratch by an independent re-measurer before any number was reported.`,
    "The campaign-log presence check ran as a world.run (ls scripts/insights/runs).",
    cleanFixes.length === 0
      ? "No fix required an owner decision."
      : `All ${cleanFixes.length} proposed fixes were put to the run owner through the escalation gate; ${gate.decisions.length} decisions came back` +
        (gate.decisions.length < cleanFixes.length ? " — the gate under-answered, so the unresolved fixes are treated as undecided" : "") + ".",
    "No write ran without owner approval; the script-side guard withheld any plan containing TRUNCATE, DELETE or DROP.",
  ],
  notCovered: [
    ...(scriptPresent ? [] : ["bash scripts/detect-data-drift.sh — not in this workspace; measurement used direct queries only (SKILL.md:24-36 unavailable here)."]),
    ...(syncScriptPresent ? [] : ["scripts/sync-to-production-v3.ts — not in this workspace; row-drift plans reference the skill's dry-run path (:267-278) but no dry-run could run here."]),
    ...(decision.prodAccess === "both" ? [] : ["Every production count — prod access was not provisioned this run (CLAUDE.local.md:52); staging-side facts only."]),
    "Tables absent from the databases the measurers reached were recorded as absent, not measured — this workspace's Prisma schema models none of the skill's tables (grep over prisma/schema.prisma: no matches), so a first run here is expected to report absence, not drift.",
    "T4 naming: the skill itself conflicts — Tables Checked (:184) says family_insights, the posture table (:111) says corridor_family_insights. Both spellings are measured and the missing one recorded as absent-with-note; treat any T4 number as provisional until the canonical name is confirmed.",
    ...(campaignLogs.exitCode === 0 ? [] : ["The SKILL.md:91-102 campaign-log checks — scripts/insights/runs does not exist in this workspace."]),
    "Triage diagnoses are judgment over re-verified numbers, not independently reproduced commands; they are labelled unconfirmed in the findings.",
    "The live sync itself — out of this workflow's reach by design (dry-run plans only, :267-278).",
  ],
};
return result;
