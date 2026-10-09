#!/usr/bin/env node
/**
 * The media lane's three loops, executed in THIS edition (C7).
 *
 * The kit inherits the plane through `node_modules/workflow-plane` — the
 * symlink to the engine checkout — so `world.media`, its `--json` machine
 * contract, its allowlist, its advisory-exit and stdout-refusal handling and
 * the grant-checked write are the engine's own code, and `npm run check:port`
 * is the drift guard. What this edition ships is the kit-local shell: the three
 * loops re-flavored to `.dwf.ts`, the doctor row, the producer, and this probe.
 *
 * So the probe's job is the loops and the shell, not the surface: it drives the
 * REAL `.dwf.ts` bodies — the plane's own `annotateAskSites` transform, the
 * surface bound as globals by this probe — over the plane's
 * own `media()` bridge pointed at stub CLIs that answer in the lane's pinned
 * machine rows, with the plane's own `worldRun` writing into a real temp
 * workspace so the seam files are read back off disk rather than trusted. Each
 * stub drops its argv, so the composition proves what actually rode the wire
 * rather than what the workflow intended.
 *
 *   1. the port's own claim: the four `.dwf.ts` files are the engine's loops
 *      with line 1 rewritten, and the bridge resolves through the symlink;
 *   2. asr-calibrate: planted per-leg rows → the floor comparison → one
 *      escalation naming the cleared leg and the owner's call; the caller's
 *      numbers un-clearing a leg that cleared at the default; fail-open by
 *      name on the absent CLI and on a stdout refusal row carrying exit 3;
 *   3. media-budget-watch: the ingest-then-forecast order and the argv that
 *      rode, one escalation for `over` and none for `degraded`, the scope
 *      filtering the view and never the math, fail-open by name;
 *   4. narrate: verify mode's pass and gaps paths (gaps escalates once and
 *      blocks nothing), render mode assembling the seam meta from the speak
 *      rows themselves, dryRun gating without rendering, and a path-escape
 *      refusal standing verbatim;
 *   5. the three files carry the lane's markers in this edition too.
 *
 *   node tools/probe-media-loops.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// By specifier — the same resolution a real run makes, which is what makes
// this probe a statement about this edition rather than about the engine's
// checkout.
const { media, MEDIA_COMMANDS } = await import("workflow-plane/services.mjs");
const { annotateAskSites } = await import("workflow-plane/schema.mjs");
const { worldRun, resolveGrants } = await import("workflow-plane/tools.mjs");

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "kit-media-loops-"));
const workspace = path.join(yard, "ws");
fs.mkdirSync(path.join(workspace, "assets", "voice"), { recursive: true });
const ABSENT = path.join(yard, "no-such-cli");

async function withBin(bin, body) {
  const real = process.env.DEV_DECISIONS_BIN;
  process.env.DEV_DECISIONS_BIN = bin;
  try {
    return await body();
  } finally {
    if (real === undefined) delete process.env.DEV_DECISIONS_BIN;
    else process.env.DEV_DECISIONS_BIN = real;
  }
}

// ── the stub CLIs: the lane's pinned rows, one scenario per file ─────────────
// Every stub records its argv, so the composition proves what rode the wire
// (the verb first, then the injected --json, then only the flags the caller
// named) rather than trusting the workflow's intent.
function stub(name, rows, { exit = 0 } = {}) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  fs.writeFileSync(
    p,
    [
      `#!/usr/bin/env node`,
      `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      ...rows.map((r) => `process.stdout.write(${JSON.stringify(JSON.stringify(r))} + "\\n");`),
      `process.exit(${exit});`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return p;
}
// narrate's stub: answers media-speak per --out basename (so a per-line answer
// is a real per-line answer) and media-gate, exactly as the engine's own probe
// does.
function narrateStub(name, { speak = {}, gate }) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  const body = [
    `#!/usr/bin/env node`,
    `require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `const argv = process.argv.slice(2);`,
    `const flag = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? null : argv[i + 1]; };`,
    `const cmd = argv[0];`,
    `if (cmd === "media-speak") {`,
    `  const out = flag("out");`,
    `  const rows = ${JSON.stringify(speak)};`,
    `  const key = Object.keys(rows).find((k) => out.endsWith("/" + k + ".mp3") || out.endsWith("/" + k + ".wav"));`,
    `  const r = key ? rows[key] : null;`,
    `  if (!r) { process.exit(2); }`,
    `  process.stdout.write(JSON.stringify(Object.assign({ op: "media-speak", ok: true, target: out, task: "media_speak" }, r)) + "\\n");`,
    `  process.exit(0);`,
    `}`,
    `if (cmd === "media-gate") {`,
    `  const target = flag("request") || flag("script") || "seam";`,
    `  const seam = flag("request") !== null;`,
    `  const rows = ${JSON.stringify(gate.rows)};`,
    `  for (const r of rows) { process.stdout.write(JSON.stringify(Object.assign({ target, mode: seam ? "seam" : "single" }, r)) + "\\n"); }`,
    `  process.exit(${gate.exit ?? 0});`,
    `}`,
    `process.exit(2);`,
  ];
  fs.writeFileSync(p, body.join("\n"), { mode: 0o755 });
  return p;
}
// media-budget-watch's stub: answers the verb named in argv, so one file
// carries both the ingest and the forecast rows.
function twoStep(name, rows) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  fs.writeFileSync(
    p,
    [
      `#!/usr/bin/env node`,
      `require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `const rows = ${JSON.stringify(rows)};`,
      `const mine = rows.filter((r) => r.op === process.argv[2]);`,
      `for (const r of mine) process.stdout.write(JSON.stringify(r) + "\\n");`,
      `process.exit(mine.length ? 0 : 3);`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return p;
}

// ── the loops, driven through the plane's own transform ─────────────────────
function loadLoop(file, moduleName) {
  const source = fs.readFileSync(path.join(kitDir, "workflows", file), "utf8");
  const moduleText = `export default async function __wfRun() {\n${annotateAskSites(source).source}\n}`;
  const modulePath = path.join(yard, moduleName);
  fs.writeFileSync(modulePath, moduleText);
  return import(new URL(`file://${modulePath}`).href);
}

/** Bind the run surface as globals — the plane's own line — and call the loop. */
function makeDrive(mod) {
  return async function drive(runArgs) {
    // Every drive starts with a clean wire record: the stubs append, so a
    // leftover line would be another drive's call counted as this one's.
    for (const f of fs.readdirSync(yard)) {
      if (f.endsWith(".argv")) fs.rmSync(path.join(yard, f));
    }
    const collected = { logs: [], phases: [], reports: [], artifacts: [], escalations: [] };
    const grants = resolveGrants({});
    const api = {
      args: runArgs,
      log: (m) => collected.logs.push(String(m)),
      phase: (n) => collected.phases.push(String(n)),
      report: (item) => collected.reports.push(item),
      escalate: async (question, context, tag) => {
        collected.escalations.push({ question: String(question), context: String(context), tag: String(tag) });
        return "the owner's answer, recorded never applied";
      },
      artifact: {
        markdown: async (id, content, opts) => {
          collected.artifacts.push({ id, content: String(content), title: opts?.title ?? id, primary: opts?.primary ?? false });
          return { id, version: 1 };
        },
        file: async (id) => {
          throw new Error(`no media loop publishes a file artifact (${id})`);
        },
      },
      files: {
        // The real workspace read, so a planted request is really read.
        read: (rel) => fs.readFileSync(path.join(workspace, String(rel)), "utf8"),
        glob: () => [],
        grep: () => [],
      },
      world: {
        // The plane's own bridge, so the advisory-exit and stdout-refusal
        // handling under test here is the one a real run exercises. The
        // engine's binding, cwd included: the lane's paths are
        // workspace-relative, so the CLI runs in the run's workspace.
        media: (command, callArgs, callOpts) => media(command, callArgs, { ...callOpts, cwd: workspace }),
        // The plane's own worldRun into the temp workspace, so the seam files
        // are written for real and read back off disk.
        run: (command, args) => worldRun(command, args, workspace, grants, () => {}),
      },
    };
    const keys = Object.keys(api);
    for (const k of keys) globalThis[k] = api[k];
    try {
      const result = await mod.default();
      return { ...collected, result };
    } finally {
      for (const k of keys) delete globalThis[k];
    }
  };
}

const argvOf = (name) => JSON.parse(fs.readFileSync(path.join(yard, `${name}.argv`), "utf8"));
const argvAll = (name) => {
  try {
    return fs
      .readFileSync(path.join(yard, `${name}.argv`), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readWs = (rel) => JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));

// ── 1. the port's own claim ─────────────────────────────────────────────────

await check("the four .dwf.ts files are the engine's loops with line 1 rewritten", async () => {
  const engineDir = path.resolve(kitDir, "..", "agnostic-router-kit");
  const pairs = [
    ["asr-calibrate.dwf.ts", "asr-calibrate.ts"],
    ["media-budget-watch.dwf.ts", "media-budget-watch.ts"],
    ["narrate.dwf.ts", "narrate.ts"],
    ["content-production.dwf.ts", "content-production.ts"],
  ];
  if (!fs.existsSync(path.join(engineDir, "workflows", "narrate.ts"))) {
    console.log("       (the engine checkout is not beside this one — byte-identity is the port's claim; execution is proven by the cases below)");
    return;
  }
  for (const [kitFile, engineFile] of pairs) {
    const kit = fs.readFileSync(path.join(kitDir, "workflows", kitFile), "utf8").split("\n");
    const engine = fs.readFileSync(path.join(engineDir, "workflows", engineFile), "utf8").split("\n");
    assert.equal(kit[0], "/* zcode-workflow", `${kitFile} line 1 is the kit's header`);
    assert.equal(engine[0], "/* workflow", `${engineFile} line 1 is the engine's header`);
    assert.deepEqual(kit.slice(1), engine.slice(1), `${kitFile} is byte-identical to ${engineFile} apart from line 1`);
  }
});

await check("the bridge resolves through the symlink, and the lane's seven verbs ship", async () => {
  assert.deepEqual([...MEDIA_COMMANDS].sort(), [
    "media-budget",
    "media-gate",
    "media-imagine",
    "media-speak",
    "media-transcribe",
    "record-asr",
    "record-media-runs",
  ]);
  // The specifier resolves to the engine's own code, reached through the
  // kit's symlink: this edition ships no copy of the surface, so the bridge
  // under test here is the one a real kit run exercises.
  const link = path.join(kitDir, "node_modules", "workflow-plane");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "workflow-plane is the symlink, not a vendored copy");
  const enginePlane = path.resolve(kitDir, "..", "agnostic-router-kit", "lib", "workflow");
  assert.equal(fs.realpathSync(link), fs.realpathSync(enginePlane));
  const resolved = String(import.meta.resolve("workflow-plane/services.mjs"));
  assert.ok(resolved.startsWith(`file://${fs.realpathSync(enginePlane)}/`), `resolved into the engine checkout: ${resolved}`);
});

// ── 2. asr-calibrate ────────────────────────────────────────────────────────

const asr = await loadLoop("asr-calibrate.dwf.ts", "asr-calibrate.mts");
const driveAsr = makeDrive(asr);
const row = (o) => ({ op: "record-asr", ok: true, ...o });
// The planted legs: qwen clears the default floor (0.9 / 3 rows), stepfun is
// accurate enough on rows but short on both scores, kokoro is perfect on one
// row — a leg whose score means nothing yet.
const CLEARS = stub("asr-clears", [
  row({ provider: "gen1_raw/qwen", n: 4, accuracy: 1.0, mean_agreement: 0.97 }),
  row({ provider: "gen1_raw/stepfun", n: 5, accuracy: 0.75, mean_agreement: 0.71 }),
  row({ provider: "gen1_raw/kokoro", n: 1, accuracy: 1.0, mean_agreement: 1.0 }),
  row({ rows: 10, feedback_file: "/home/x/.local/share/dev-decisions/feedback.csv" }),
]);
const REFUSED = stub("asr-refused", [{ op: "record-asr", ok: false, error: "record-asr: no .mp3/.txt fixture pairs in /tmp/fixtures" }], { exit: 3 });
const NO_LEGS = stub("asr-no-legs", [row({ rows: 0, feedback_file: "/home/x/.local/share/dev-decisions/feedback.csv" })]);
const asrMd = (run) => run.artifacts.find((a) => a.id === "asr-calibrate")?.content ?? "";

await check("asr-calibrate: planted legs → the floor comparison clears exactly one", async () => {
  const run = await withBin(CLEARS, () => driveAsr({}));
  assert.equal(run.result.failOpen, undefined, `fail-open fired: ${run.result.refused ?? run.result.reason ?? ""}`);
  const byProvider = Object.fromEntries(run.result.legs.map((l) => [l.provider, l]));
  assert.equal(byProvider["gen1_raw/qwen"].clears, true);
  assert.deepEqual(byProvider["gen1_raw/stepfun"].lacks, ["accuracy", "agreement"]);
  assert.deepEqual(byProvider["gen1_raw/kokoro"].lacks, ["rows (1 of 3)"]);
  assert.deepEqual(run.result.cleared, ["gen1_raw/qwen"]);
  assert.equal(run.result.task, "asr_roundtrip");
  assert.deepEqual(run.phases, [
    "Round-trip the pinned fixture through every live leg",
    "Grade each leg against the floor",
    "Name the promotion evidence; the owner decides",
  ]);
  // The engine's own default fixtures ride when the caller names none: the
  // verb first, then the injected --json, and no --fixtures at all.
  assert.deepEqual(argvOf("asr-clears"), ["record-asr", "--json"]);
});

await check("asr-calibrate: one escalation naming the cleared leg and the owner's call", async () => {
  const run = await withBin(CLEARS, () => driveAsr({}));
  assert.equal(run.escalations.length, 1, `escalations: ${run.escalations.length}`);
  const esc = run.escalations[0];
  assert.match(esc.question, /gen1_raw\/qwen/);
  assert.match(esc.question, /floor 0\.9, 3\+ rows/);
  assert.match(esc.question, /the owner decides whether the gen1_raw eval-only tag lifts/);
  assert.match(esc.question, /this loop writes nothing/);
  assert.equal(esc.tag, "asr-calibrate");
  assert.equal(run.result.escalated, true);
  assert.equal(run.result.ownerAnswer, "the owner's answer, recorded never applied");
  const body = asrMd(run);
  assert.match(body, /\| `gen1_raw\/qwen` \| 4 \| 1\.000 \| 0\.970 \| \*\*clears\*\* \|/);
  assert.match(body, /\*\*This loop does not lift the `gen1_raw` tag\.\*\*/);
  // Every row the verb printed rides raw — an unrecognized row would be shown.
  assert.match(body, /"rows":10/);
  assert.equal(run.artifacts[0].primary, true);
});

await check("asr-calibrate: the caller's floor and minRows are the comparison's numbers", async () => {
  const run = await withBin(CLEARS, () => driveAsr({ floor: 0.99, minRows: 10 }));
  assert.equal(run.result.floor, 0.99);
  assert.equal(run.result.minRows, 10);
  // The leg that cleared at 0.9/3 no longer clears at 0.99/10 — the numbers
  // came from the caller, not from a constant.
  assert.deepEqual(run.result.cleared, []);
  assert.deepEqual(run.result.legs.find((l) => l.provider === "gen1_raw/qwen").lacks, ["rows (4 of 10)", "agreement"]);
  assert.equal(run.escalations.length, 0, "nothing cleared, so nothing to promote and nothing to escalate");
  assert.match(asrMd(run), /No leg clears the floor yet/);
});

await check("asr-calibrate: fail-open by name on the absent CLI and on a stdout refusal", async () => {
  const absent = await withBin(ABSENT, () => driveAsr({}));
  assert.equal(absent.result.failOpen, true);
  assert.match(absent.result.refused, /dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1/);
  assert.match(absent.result.conclusion, /the gen1_raw tag stands unchanged/);
  assert.equal(absent.artifacts.length, 0, "a fail-open run publishes no artifact");
  assert.equal(absent.escalations.length, 0);
  const refused = await withBin(REFUSED, () => driveAsr({ fixtures: "/tmp/fixtures" }));
  assert.equal(refused.result.failOpen, true);
  // The refusal row rode stdout with exit 3 — the advisory exit — and the
  // loop reports the row's error, not a stderr tail.
  assert.equal(refused.result.refused, "record-asr: no .mp3/.txt fixture pairs in /tmp/fixtures");
  assert.deepEqual(argvOf("asr-refused"), ["record-asr", "--json", "--fixtures", "/tmp/fixtures"]);
  const noLegs = await withBin(NO_LEGS, () => driveAsr({}));
  assert.equal(noLegs.result.failOpen, true);
  assert.match(noLegs.result.conclusion, /no per-leg rows to grade/);
});

// ── 3. media-budget-watch ───────────────────────────────────────────────────

const budget = await loadLoop("media-budget-watch.dwf.ts", "media-budget-watch.mts");
const driveBudget = makeDrive(budget);
const INGEST_OK = {
  op: "record-media-runs",
  ok: true,
  target: "/telemetry.jsonl",
  provider: "gen1_raw/qwen+gen1_raw/stepfun",
  task: "media_runs",
  lines_total: 4,
  rows_new: 3,
  rows_duplicate: 0,
  rows_skipped: 1,
  verdict: "ok",
};
const OVER = {
  op: "media-budget",
  ok: true,
  target: "/tables/media_runs.csv",
  task: "media_budget_forecast",
  bands: { "gen1_raw/qwen": { median: 40, lo: 30, hi: 50 } },
  estimate_total_s: 33.25,
  budget_s: 5,
  degraded: [],
  verdict: "over",
};
const budgetMd = (run) => run.artifacts.find((a) => a.id === "media-budget-watch")?.content ?? "";

await check("media-budget-watch: ingest first, then forecast — the argv that actually rode", async () => {
  const bin = twoStep("budget-both", [INGEST_OK, OVER]);
  const run = await withBin(bin, () => driveBudget({ telemetry: "telemetry.jsonl", budgetSeconds: 5 }));
  assert.equal(run.result.failOpen, undefined, run.result.refused ?? "");
  const calls = argvAll("budget-both");
  assert.equal(calls.length, 2, `two calls, in order: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls[0], ["record-media-runs", "--json", "--telemetry", "telemetry.jsonl"]);
  assert.deepEqual(calls[1], ["media-budget", "--json", "--budget-seconds", "5"]);
  assert.deepEqual(run.phases, [
    "Ingest gen1's telemetry sink",
    "Forecast the next day's media seconds",
    "Report the bands, the estimate, and the crossing",
  ]);
  assert.deepEqual(run.result.ingested, { rowsNew: 3, rowsDuplicate: 0, rowsSkipped: 1 });
  assert.ok(run.logs.some((l) => /4 line\(s\) parsed — 3 new, 0 duplicate\(s\), 1 skipped/.test(l)), run.logs.join("\n"));
});

await check("media-budget-watch: over escalates exactly once, with the estimate against the budget", async () => {
  const bin = twoStep("budget-over", [INGEST_OK, OVER]);
  const run = await withBin(bin, () => driveBudget({ telemetry: "telemetry.jsonl", budgetSeconds: 5 }));
  assert.equal(run.result.over, true);
  assert.equal(run.result.escalated, true);
  assert.equal(run.result.estimateTotalS, 33.25);
  assert.match(run.result.conclusion, /33\.3s vs budget 5\.0s → OVER/);
  assert.match(run.result.conclusion, /escalated once, the trim is the owner's/);
  assert.equal(run.escalations.length, 1, `escalations: ${run.escalations.length}`);
  assert.match(run.escalations[0].question, /the owner decides what to trim; this loop only reports/);
  assert.equal(run.escalations[0].tag, "media-budget-watch");
  assert.match(budgetMd(run), /\*\*5\.0s\*\* — next-day estimate \*\*33\.3s\*\* → \*\*OVER\*\*/);
  assert.match(budgetMd(run), /does not throttle, queue, or refuse a render/);
});

await check("media-budget-watch: degraded is information — it never escalates, and its reason is the engine's", async () => {
  const bin = twoStep("budget-thin", [
    { ...INGEST_OK, provider: "gen1_raw/qwen", lines_total: 2, rows_new: 2, rows_skipped: 0 },
    {
      op: "media-budget",
      ok: true,
      target: "/tables/media_runs.csv",
      task: "media_budget_forecast",
      bands: {},
      estimate_total_s: 12.5,
      budget_s: 900,
      degraded: ["gen1_raw/qwen: only 1 recorded day(s) — forecast needs 4"],
      verdict: "pass",
    },
  ]);
  const run = await withBin(bin, () => driveBudget({ telemetry: "telemetry.jsonl", budgetSeconds: 900 }));
  assert.equal(run.result.over, false);
  assert.equal(run.result.escalated, false);
  assert.equal(run.escalations.length, 0, "a named reason is information, not a crossing");
  assert.deepEqual(run.result.degraded, [{ provider: "gen1_raw/qwen", reason: "only 1 recorded day(s) — forecast needs 4" }]);
  assert.match(run.result.conclusion, /no crossing to escalate/);
  assert.match(budgetMd(run), /Degraded is information, not a crossing/);
});

await check("media-budget-watch: no budget named is report only, and the scope filters the view not the math", async () => {
  const bin = twoStep("budget-scope", [
    INGEST_OK,
    { ...OVER, budget_s: null, degraded: ["gen1_raw/stepfun: only 1 recorded day(s) — forecast needs 4"], verdict: "pass" },
  ]);
  const run = await withBin(bin, () => driveBudget({ telemetry: "telemetry.jsonl", scope: "gen1_raw/qwen" }));
  assert.equal(run.result.budget, null);
  assert.match(run.result.conclusion, /report only/);
  // The estimate is the engine's whole-provider number, never the scoped
  // view's: the row carries no per-provider values, and the loop prints none.
  assert.equal(run.result.estimateTotalS, 33.25);
  assert.deepEqual(run.result.outOfScope, ["gen1_raw/stepfun"]);
  assert.equal(run.escalations.length, 0);
  // No budget named rides no --budget-seconds: absent means report only.
  assert.deepEqual(argvAll("budget-scope")[1], ["media-budget", "--json"]);
});

await check("media-budget-watch: fail-open by name on the absent CLI and on a refusing sink", async () => {
  const absent = await withBin(ABSENT, () => driveBudget({ telemetry: "telemetry.jsonl" }));
  assert.equal(absent.result.failOpen, true);
  assert.match(absent.result.refused, /dev-decisions not installed/);
  const refused = await withBin(
    stub("budget-sink", [{ op: "record-media-runs", ok: false, error: "record-media-runs: no telemetry at /x — run a speak/transcribe first" }], { exit: 3 }),
    () => driveBudget({ telemetry: "telemetry.jsonl" }),
  );
  assert.equal(refused.result.failOpen, true);
  assert.equal(refused.result.refused, "record-media-runs: no telemetry at /x — run a speak/transcribe first");
  assert.equal(refused.artifacts.length, 0);
  assert.equal(refused.escalations.length, 0);
});

// ── 4. narrate ──────────────────────────────────────────────────────────────

const narrate = await loadLoop("narrate.dwf.ts", "narrate.mts");
const driveNarrate = makeDrive(narrate);
const narrateMd = (run) => run.artifacts.find((a) => a.id === "narrate")?.content ?? "";
const gateRow = (over) => ({ op: "media-gate", ok: true, provider: "gen1_raw/stepfun", task: "media_gate", ...over });

fs.writeFileSync(path.join(workspace, "script.txt"), "The router decides.\n");
fs.writeFileSync(
  path.join(workspace, "request.json"),
  JSON.stringify({ lines: [{ id: "a", text: "first line" }, { id: "b", text: "second line" }] }),
);

const PASS_STUB = narrateStub("narrate-pass", {
  gate: {
    rows: [
      gateRow({
        lines: [{ id: "line_1", agreement: 0.98, ref_tokens: 12, got_tokens: 12, missing: 0, extra: 0 }],
        refused: [],
        verdict: "pass",
      }),
    ],
  },
});
const GAPS_STUB = narrateStub("narrate-gaps", {
  gate: {
    rows: [
      gateRow({
        lines: [
          { id: "line_1", agreement: 0.61, ref_tokens: 12, got_tokens: 10, missing: 2, extra: 0 },
          { id: "line_2", agreement: 0.99, ref_tokens: 8, got_tokens: 8, missing: 0, extra: 0 },
        ],
        refused: [],
        verdict: "gaps",
      }),
    ],
    exit: 1, // the lane's advisory WARN exit — the bridge treats rows as payload
  },
});
const ESCAPE_STUB = narrateStub("narrate-escape", {
  gate: { rows: [{ ok: false, error: "media-gate: meta path /etc/passwd escapes the project root" }], exit: 3 },
});

await check("narrate: verify mode gates a planted pair — pass, no escalation, nothing blocked", async () => {
  const run = await withBin(PASS_STUB, () => driveNarrate({ script: "script.txt", audio: "voice.mp3" }));
  assert.equal(run.result.failOpen, undefined, run.result.refused ?? "");
  assert.equal(run.result.verdict, "pass");
  assert.equal(run.result.mode, "verify-single");
  assert.equal(run.result.blocked, false, "a pass verdict must still declare it blocks nothing");
  assert.equal(run.escalations.length, 0);
  assert.deepEqual(argvOf("narrate-pass"), ["media-gate", "--json", "--script", "script.txt", "--audio", "voice.mp3"]);
  assert.match(run.result.conclusion, /^narrate: verdict pass \(verify-single mode\) — 1 line\(s\) verified, 0 with gaps, 0 refused/);
  assert.match(narrateMd(run), /\| line_1 \| 0\.980 \| 12 \| 12 \| match \|/);
});

await check("narrate: the gaps path reports, escalates once, and blocks nothing", async () => {
  const run = await withBin(GAPS_STUB, () => driveNarrate({ script: "script.txt", audio: "voice.mp3" }));
  assert.equal(run.result.verdict, "gaps");
  assert.equal(run.result.blocked, false, "the WARN-never-block law: a gaps verdict is a normal result");
  assert.equal(run.escalations.length, 1, `escalations: ${run.escalations.length}`);
  assert.match(run.escalations[0].question, /narration gaps: 1 of 2 line\(s\) differ from the script \(worst agreement 0\.610\) — advisory, never blocks/);
  assert.equal(run.escalations[0].tag, "narration-gaps");
  assert.equal(run.result.ownerAnswer, "the owner's answer, recorded never applied");
  // The report and the artifact are still produced — there is no branch that
  // stops at the warning.
  assert.equal(run.artifacts.length, 1, "the artifact is still published on the gaps path");
  assert.match(narrateMd(run), /This loop has no blocking branch/);
  assert.match(narrateMd(run), /## Named anomalies\n\nNone\./);
  assert.match(run.result.conclusion, /advisory, escalated once, nothing blocked/);
  assert.ok(run.result.verified.some((v) => /never blocks/.test(v)), "the never-block law rides the result");
});

await check("narrate: render mode assembles the seam meta from the speak rows themselves", async () => {
  const RENDER_STUB = narrateStub("narrate-render", {
    speak: {
      a: { provider: "gen1_raw/qwen", duration_seconds: 3.5, format: "mp3", sample_rate: 24000, request_id: "rq-a", verdict: "ok" },
      // A leg that serves wav into a .mp3 filename: the row's format is the
      // container truth, and the loop names the disagreement.
      b: { provider: "gen1_raw/stepfun", duration_seconds: 4.25, format: "wav", sample_rate: 44100, request_id: "rq-b", verdict: "ok" },
    },
    gate: { rows: [gateRow({ lines: [], refused: [], verdict: "pass" })] },
  });
  const run = await withBin(RENDER_STUB, () => driveNarrate({ request: "request.json", outDir: "assets/voice", format: "mp3" }));
  assert.equal(run.result.failOpen, undefined, run.result.refused ?? "");
  assert.equal(run.result.mode, "render");
  assert.equal(run.result.verdict, "pass");
  assert.equal(run.result.rendered.length, 2, "both lines rendered");
  assert.ok(run.result.anomalies.some((a) => /served wav into a \.mp3 filename/.test(a)), JSON.stringify(run.result.anomalies));
  // The seam files are read back off disk, not trusted from the loop's return.
  const staged = readWs("assets/voice/audio_request.json");
  assert.deepEqual(staged, { lines: [{ id: "a", text: "first line" }, { id: "b", text: "second line" }] });
  const meta = readWs("assets/voice/audio_meta.json");
  assert.equal(meta.tts_provider, "gen1");
  assert.equal(meta.total_duration_s, 7.75);
  assert.deepEqual(meta.voices, [
    { id: "a", path: "assets/voice/a.mp3", duration_s: 3.5, words: [], provider: "gen1_raw/qwen", format: "mp3", voice: null, request_id: "rq-a" },
    // The row's format is the container truth: a wav served into a .mp3
    // filename is named in the anomalies, never relabelled as the filename.
    { id: "b", path: "assets/voice/b.mp3", duration_s: 4.25, words: [], provider: "gen1_raw/stepfun", format: "wav", voice: null, request_id: "rq-b" },
  ]);
  // The path is the row's own target — the loop never invents one; and the
  // seam's pinned empty words: gen1 measures duration, it does not align.
  assert.equal(meta.voices[0].path, "assets/voice/a.mp3");
  assert.deepEqual(meta.voices[0].words, []);
  const calls = argvAll("narrate-render");
  const speaks = calls.filter((c) => c[0] === "media-speak");
  const gates = calls.filter((c) => c[0] === "media-gate");
  assert.equal(speaks.length, 2, `two speak legs: ${calls.length} call(s)`);
  assert.deepEqual(speaks[0], ["media-speak", "--json", "--text", "first line", "--out", "assets/voice/a.mp3", "--format", "mp3"]);
  assert.equal(gates.length, 1, "one gate, after the renders");
  assert.deepEqual(gates[0], [
    "media-gate",
    "--json",
    "--request",
    "assets/voice/audio_request.json",
    "--meta",
    "assets/voice/audio_meta.json",
    "--project",
    ".",
  ]);
  assert.deepEqual(run.phases, [
    "Read the request",
    "Stage the request in the seam's dialect",
    "Render 2 line(s) into assets/voice",
    "Assemble the seam meta from the engine's own rows",
    "Gate the narration against the script",
  ]);
});

await check("narrate: dryRun gates without rendering — no speak leg rode", async () => {
  const DRYRUN_STUB = narrateStub("narrate-dry", {
    gate: {
      rows: [
        gateRow({
          lines: [],
          refused: [{ id: "?", error: "unreadable seam: [Errno 2] No such file or directory: 'assets/voice/audio_meta.json'" }],
          verdict: "error",
        }),
      ],
      exit: 3,
    },
  });
  const metaFile = path.join(workspace, "assets", "voice", "audio_meta.json");
  const before = fs.existsSync(metaFile);
  const run = await withBin(DRYRUN_STUB, () => driveNarrate({ request: "request.json", outDir: "assets/voice", dryRun: true }));
  const calls = argvAll("narrate-dry");
  assert.equal(calls.length, 1, `only the gate call rode the wire: ${JSON.stringify(calls)}`);
  assert.equal(calls[0][0], "media-gate");
  assert.equal(fs.existsSync(metaFile), before, "dryRun writes no meta");
  assert.equal(run.result.dryRun, true);
  assert.equal(run.result.rendered.length, 0, "nothing rendered");
  assert.match(run.result.conclusion, /dry run/);
});

await check("narrate: a path-escape refusal is the engine's sentence, verbatim", async () => {
  const run = await withBin(ESCAPE_STUB, () => driveNarrate({ request: "request.json", meta: "meta.json", project: "." }));
  assert.equal(run.result.failOpen, true);
  assert.equal(run.result.where, "media-gate refused");
  // The refusal row rode stdout with exit 3, and the loop resolves nothing
  // itself: the engine's sentence rides through untouched.
  assert.equal(run.result.refused, "media-gate: meta path /etc/passwd escapes the project root");
  assert.match(run.result.conclusion, /^narration unavailable — nothing was rendered or verified — media-gate refused: /);
  assert.equal(run.artifacts.length, 0, "a refusal publishes no artifact");
  assert.equal(run.escalations.length, 0);
});

await check("narrate: the args naming half a pair fail open by name", async () => {
  const run = await withBin(PASS_STUB, () => driveNarrate({ script: "script.txt" }));
  assert.equal(run.result.failOpen, true);
  assert.equal(run.result.where, "the args name half of a pair");
  assert.match(run.result.refused, /got --script without its pair/);
  assert.equal(argvAll("narrate-pass").length, 0, "nothing rode the wire");
});

// ── 5. the marker laws, over the kit's own files ────────────────────────────

await check("the three loops carry the lane's markers in this edition too", () => {
  const asrSrc = fs.readFileSync(path.join(kitDir, "workflows", "asr-calibrate.dwf.ts"), "utf8");
  assert.ok(asrSrc.includes("// media-loops: this workflow has no gen1_raw write path"), "the marker must live as its own line");
  const budgetSrc = fs.readFileSync(path.join(kitDir, "workflows", "media-budget-watch.dwf.ts"), "utf8");
  assert.ok(budgetSrc.includes("// media-loops: this workflow writes nothing of its own — the ingest verb owns its table"));
  const narrateSrc = fs.readFileSync(path.join(kitDir, "workflows", "narrate.dwf.ts"), "utf8");
  assert.ok(narrateSrc.includes("// media-loops: this loop never blocks — the engine's gate is advisory, and so is this"));
  for (const f of ["asr-calibrate.dwf.ts", "media-budget-watch.dwf.ts", "narrate.dwf.ts"]) {
    const src = fs.readFileSync(path.join(kitDir, "workflows", f), "utf8");
    assert.ok(!src.includes("child_process"), `${f} spawns no process of its own — the bridge owns the spawn`);
    assert.ok(!/\bagent\s*\(/.test(src), `${f} spawns no agent`);
    assert.ok(!src.includes("blocked: true"), `${f} has no blocking branch`);
  }
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) console.log(`  failed: ${failures.join(" | ")}`);
console.log(`probe-media-loops: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
