/**
 * zcode-router-kit CLI.
 *
 *   kit status                     what is installed, and where
 *   kit init [--template]          write a roster (from a live machine, or the defaults)
 *   kit export [--out f]           print/save the roster this machine would ship
 *   kit env set K=V …              manage the runtime .env (keys only, chmod 600)
 *   kit env list | unset K
 *   kit apply [--dry-run] [--only router|provider|workflows|service]
 *   kit doctor [--live]            verify the whole chain, change nothing
 *   kit workflows list|sync
 *   kit route "task…"              ask the running router for its verdict
 */
import fs from "node:fs";
import path from "node:path";
import {
  KIT_DIR,
  KIT_VERSION,
  KIT_WORKFLOWS_DIR,
  ROUTER_DIR,
  ROUTER_LOG,
  PROVIDER_CONFIG_PATH,
  WORKFLOWS_DIR,
  ENV_FILE,
  ROSTER_PATH,
  platform,
} from "./paths.mjs";
import { loadRoster, resolveRoster } from "./roster.mjs";
import { readLibrary, buildRegistry, syncLibrary } from "./workflowlib.mjs";
import { renderRouterConfig, renderEnvHeader } from "./render.mjs";
import { readEnvFile, writeEnvFile } from "./envstore.mjs";
import { readProviderConfig, backupProviderConfig, mergeProviderConfig, writeProviderConfig } from "./provider-merge.mjs";
import { installService, serviceStatus, servicePaths } from "./service.mjs";
import { exportRoster } from "./export-live.mjs";

// ── tiny output helpers ────────────────────────────────────────────────────
const c = {
  ok: (s) => `✓ ${s}`,
  warn: (s) => `! ${s}`,
  fail: (s) => `✗ ${s}`,
  dim: (s) => `  ${s}`,
  head: (s) => `\n${s}`,
};
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[camel(k)] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[camel(k)] = argv[++i];
      else flags[camel(k)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function loadAndResolve(rosterPath = ROSTER_PATH) {
  const roster = loadRoster(rosterPath);
  if (!roster) {
    return { roster: null, resolved: null, error: `no roster at ${rosterPath} — run \`kit init\` (or \`kit export\`) first` };
  }
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  return { roster, resolved, error: null };
}

// Atomic: the dashboard re-runs apply while the router is serving, and the
// router re-reads config.json on mtime — a half-written file must never be
// observable, so land the rename only once the bytes are complete on disk.
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-kit`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function copyRuntime(routerDir, { dry }) {
  const steps = [];
  for (const f of ["server.js", "usage.mjs", "dashboard.html", "package.json", "README.md"]) {
    const src = path.join(KIT_DIR, "router", f);
    const dest = path.join(routerDir, f);
    fs.mkdirSync(routerDir, { recursive: true });
    const same = fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");
    if (!same) {
      if (!dry) fs.copyFileSync(src, dest);
      steps.push(`${dry ? "would copy" : "copied"} ${f}`);
    }
  }
  return steps;
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

// ── commands ───────────────────────────────────────────────────────────────
export async function cmdStatus() {
  const sp = servicePaths();
  console.log(`zcode-router-kit ${KIT_VERSION} — ${platform()}`);
  console.log(`  kit repo:     ${KIT_DIR}`);
  console.log(`  roster:       ${fs.existsSync(ROSTER_PATH) ? ROSTER_PATH : `(none — run \`kit init\`)`}`);
  console.log(`  router dir:   ${ROUTER_DIR}`);
  console.log(`  router cfg:   ${fs.existsSync(path.join(ROUTER_DIR, "config.json")) ? "present" : "missing"}`);
  console.log(`  env file:     ${fs.existsSync(ENV_FILE) ? (fs.statSync(ENV_FILE).mode & 0o777) === 0o600 ? "present (600)" : "present — WRONG PERMS" : "missing"}`);
  console.log(`  providers:    ${fs.existsSync(PROVIDER_CONFIG_PATH) ? PROVIDER_CONFIG_PATH : "(no provider_config.json yet)"}`);
  console.log(`  workflows:    ${fs.existsSync(WORKFLOWS_DIR) ? `${fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".dwf.ts")).length} installed` : "none"}`);
  console.log(`  service:      ${sp.kind} ${sp.unit ?? ""} ${serviceStatus().loaded ? "(loaded)" : "(not loaded)"}`);
  const { roster, error } = loadAndResolve();
  if (error) {
    console.log(c.warn(error));
    return 1;
  }
  const resolved = resolveRoster(roster, { envFile: readEnvFile(ENV_FILE) });
  const port = roster.router?.port ?? 8300;
  const h = await health(port);
  console.log(`  health:       ${h ? `up on 127.0.0.1:${port}` : `DOWN on 127.0.0.1:${port}`}`);
  console.log(c.head("tiers"));
  for (const [name, t] of Object.entries(roster.tiers)) {
    const w = resolved.workloads[name];
    const remap = w && `${w.providerId}/${w.model}` !== t.target ? ` (remapped from ${t.target})` : "";
    console.log(`  ${w ? c.ok(name.padEnd(14)) : c.fail(name.padEnd(14))} ${w ? `${w.providerId}/${w.model}${remap}` : "unusable — no target resolved"}`);
  }
  if (resolved.remaps.length) {
    console.log(c.head("remaps"));
    for (const r of resolved.remaps) {
      if (r.to) console.log(c.warn(`${r.name}: ${r.from} → ${r.to}`));
      else console.log(c.dim(`${r.name}: dropped ${r.from} (${r.skippedReason})`));
    }
  }
  return 0;
}

export async function cmdExport(flags) {
  const roster = exportRoster({
    providerConfigPath: PROVIDER_CONFIG_PATH,
    routerConfigPath: path.join(ROUTER_DIR, "config.json"),
    workflowsDir: WORKFLOWS_DIR,
  });
  const out = flags.out ? path.resolve(flags.out) : null;
  if (out) {
    writeJson(out, roster);
    console.log(c.ok(`roster written to ${out}`));
  } else {
    console.log(JSON.stringify(roster, null, 2));
  }
  return 0;
}

export function cmdInit(flags) {
  if (fs.existsSync(ROSTER_PATH) && !flags.force) {
    console.log(c.warn(`${ROSTER_PATH} already exists — pass --force to overwrite`));
    return 1;
  }
  if (flags.template) {
    const tpl = path.join(KIT_DIR, "templates", "roster.defaults.json");
    if (!fs.existsSync(tpl)) {
      console.log(c.fail(`no template at ${tpl}`));
      return 1;
    }
    writeJson(ROSTER_PATH, JSON.parse(fs.readFileSync(tpl, "utf8")));
    console.log(c.ok(`template roster written to ${ROSTER_PATH} — edit it, then \`kit env set …\` and \`kit apply\``));
    return 0;
  }
  const hasLive = fs.existsSync(PROVIDER_CONFIG_PATH) || fs.existsSync(path.join(ROUTER_DIR, "config.json"));
  if (!hasLive) {
    console.log(c.fail("nothing to copy from this machine — use `kit init --template` and edit the roster"));
    return 1;
  }
  const roster = exportRoster({});
  writeJson(ROSTER_PATH, roster);
  const n = Object.keys(roster.providers).length;
  console.log(c.ok(`roster exported from this machine (${n} providers) → ${ROSTER_PATH}`));
  // This machine's keys already live in ZCode's provider config; move them
  // behind env-var references so the roster stays key-free everywhere.
  let imported = 0;
  if (flags.importKeys !== false) {
    const pc = readProviderConfig();
    const env = readEnvFile(ENV_FILE);
    for (const rule of pc.exists ? (pc.cfg.config?.providerConfigRules?.providerRules ?? []) : []) {
      const p = roster.providers[rule.providerId];
      if (p && !p.routerOnly && rule.config?.access?.apiKey && !env[p.apiKeyEnv]) {
        env[p.apiKeyEnv] = rule.config.access.apiKey;
        imported++;
      }
    }
    writeEnvFile(ENV_FILE, env, { header: renderEnvHeader(roster, { envMissing: [] }) });
    console.log(c.ok(`${imported} key(s) imported from the live provider config into ${ENV_FILE} (600)`));
  }
  const setcmds = Object.values(roster.providers)
    .map((p) => p.apiKeyEnv)
    .filter((v, i, a) => a.indexOf(v) === i && !readEnvFile(ENV_FILE)[v])
    .map((v) => `kit env set ${v}=…`);
  if (setcmds.length) {
    console.log(c.dim("keys still missing (set them, or they fall back where the roster allows):"));
    for (const s of setcmds) console.log(c.dim(`  ${s}`));
  }
  console.log(c.dim(`next: kit apply --dry-run   ·   kit doctor`));
  return 0;
}

export function cmdEnv(flags, positional) {
  const sub = positional[0];
  const cur = readEnvFile(ENV_FILE);
  if (sub === "set") {
    const pairs = positional.slice(1);
    if (!pairs.length) {
      console.log(c.fail("usage: kit env set NAME=value …"));
      return 1;
    }
    const next = { ...cur };
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) {
        console.log(c.fail(`"${p}" is not NAME=value`));
        return 1;
      }
      next[p.slice(0, i)] = p.slice(i + 1);
    }
    const { roster } = loadAndResolve();
    const header = roster ? renderEnvHeader(roster, { envMissing: [] }) : ["Router runtime secrets — chmod 600."];
    writeEnvFile(ENV_FILE, next, { header });
    console.log(c.ok(`wrote ${Object.keys(next).length} keys to ${ENV_FILE} (600)`));
    return 0;
  }
  if (sub === "unset") {
    const names = positional.slice(1);
    const next = { ...cur };
    for (const n of names) delete next[n];
    writeEnvFile(ENV_FILE, next, { header: ["Router runtime secrets — chmod 600."] });
    console.log(c.ok(`removed ${names.join(", ") || "(nothing)"}`));
    return 0;
  }
  if (sub === "list" || !sub) {
    const { roster } = loadAndResolve();
    const wanted = new Set();
    if (roster) {
      for (const p of Object.values(roster.providers)) if (p.apiKeyEnv) wanted.add(p.apiKeyEnv);
      if (roster.typesafe?.apiKeyEnv) wanted.add(roster.typesafe.apiKeyEnv);
    }
    const keys = new Set([...Object.keys(cur), ...wanted]);
    if (!keys.size) console.log(c.dim("(no keys set, nothing expected)"));
    for (const k of [...keys].sort()) {
      const have = Boolean(cur[k]);
      const need = wanted.has(k);
      console.log(`  ${have ? "✓" : need ? "✗" : "·"} ${k}${have ? "" : need ? "  (required by roster)" : "  (set, unused)"}`);
    }
    return 0;
  }
  console.log(c.fail(`unknown env subcommand "${sub}" (set|unset|list)`));
  return 1;
}

export async function cmdApply(flags) {
  const dry = Boolean(flags.dryRun ?? flags.dry);
  const { roster, error } = loadAndResolve();
  if (error) return void console.log(c.fail(error)), 1;
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  const only = flags.only ? String(flags.only).split(",") : ["router", "provider", "workflows", "service"];
  const steps = [];
  const problems = [];

  const rawKeys = Object.values(resolved.providers).filter((p) => p.rawKeyWarning).map((p) => p.id);
  if (rawKeys.length) console.log(c.warn(`roster carries RAW apiKey values (${rawKeys.join(", ")}) — use apiKeyEnv + \`kit env set\`, or gitignore roster.json`));

  if (resolved.problems.length) {
    for (const p of resolved.problems) console.log(c.fail(p));
    console.log(c.fail("fix the roster (or set the missing keys) before applying — the router would route with holes"));
    return 1;
  }

  // 1. router runtime + generated config
  if (only.includes("router")) {
    const port = flags.port ? Number(flags.port) : undefined;
    steps.push(...copyRuntime(ROUTER_DIR, { dry }));
    const library = readLibrary(KIT_WORKFLOWS_DIR);
    const { registry } = buildRegistry(library, roster);
    const cfg = renderRouterConfig(roster, resolved, registry, { port });
    const dest = path.join(ROUTER_DIR, "config.json");
    const changed = !fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== JSON.stringify(cfg, null, 2) + "\n";
    if (changed) {
      if (!dry) {
        if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak-kit`);
        writeJson(dest, cfg);
      }
      steps.push(`${dry ? "would write" : "wrote"} config.json (${registry.length} workflows registered)`);
    } else steps.push("config.json already current");
    if (!fs.existsSync(ENV_FILE) && !dry) {
      writeEnvFile(ENV_FILE, {}, { header: renderEnvHeader(roster, resolved) });
      steps.push(`created ${ENV_FILE}`);
    }
    const depsDir = path.join(ROUTER_DIR, "node_modules", "@typesafe-ai");
    if (!fs.existsSync(depsDir)) problems.push(`router dependency @typesafe-ai/sdk missing in ${ROUTER_DIR} — run: (cd ${ROUTER_DIR} && npm install --omit=dev)`);
  }

  // 2. ZCode provider config
  if (only.includes("provider")) {
    const pc = readProviderConfig();
    if (!pc.exists) {
      problems.push(`no provider config at ${PROVIDER_CONFIG_PATH} — launch ZCode once to create it, then re-run`);
    } else {
      const backup = dry ? "(dry-run)" : backupProviderConfig();
      const merged = mergeProviderConfig(pc.cfg, roster, resolved);
      for (const w of merged.warnings) console.log(c.warn(w));
      if (merged.missingKey.length) console.log(c.warn(`no key resolved — not registered: ${merged.missingKey.join(", ")}`));
      if (merged.changed) {
        if (!dry) writeProviderConfig(merged.next);
        steps.push(`${dry ? "would update" : "updated"} provider_config.json${backup && !dry ? ` (backup: ${path.basename(backup)})` : ""}`);
        if (merged.registered.length) steps.push(c.dim(`registered/updated: ${merged.registered.join(", ")}`));
        if (merged.removed.length) steps.push(c.dim(`removed (unusable): ${merged.removed.join(", ")}`));
      } else steps.push("provider_config.json already current");
    }
  }

  // 3. workflow library
  if (only.includes("workflows")) {
    const r = syncLibrary(KIT_WORKFLOWS_DIR, WORKFLOWS_DIR);
    const total = readLibrary(WORKFLOWS_DIR).length;
    if (dry) {
      const pending = readLibrary(KIT_WORKFLOWS_DIR).length - r.unchanged;
      steps.push(`would sync ${pending} workflow file(s) into ${WORKFLOWS_DIR}`);
    } else {
      if (r.copied.length) steps.push(`installed ${r.copied.length} workflow(s): ${r.copied.join(", ")}`);
      if (r.updated.length) steps.push(`updated ${r.updated.length} workflow(s): ${r.updated.join(", ")}`);
      steps.push(`${total} workflow(s) present in ${WORKFLOWS_DIR}`);
    }
  }

  // 4. service
  if (only.includes("service")) {
    const st = serviceStatus();
    if (st.kind === "unsupported") problems.push(`service management is not automated for ${process.platform} — run the router by hand: node ${path.join(ROUTER_DIR, "server.js")}`);
    else if (dry) steps.push(`would install ${st.kind} service (${st.unit})`);
    else {
      const r = await installService({ scriptDir: ROUTER_DIR });
      steps.push(`service: ${r.steps.join("; ")}`);
      if (!r.ok) problems.push(`service did not start: ${r.error ?? "unknown"} — start it by hand: node ${path.join(ROUTER_DIR, "server.js")}`);
    }
  }

  for (const s of steps) console.log(c.ok(s));

  if (dry) {
    if (resolved.remaps.length) for (const r of resolved.remaps) console.log(c.warn(`remap: ${r.name}: ${r.from} → ${r.to ?? "dropped"}`));
    console.log(c.warn("dry run — nothing was written"));
    return 0;
  }

  // 5. verify health
  const port = flags.port ? Number(flags.port) : roster.router?.port ?? 8300;
  let h = null;
  for (let i = 0; i < 10 && !h; i++) {
    h = await health(port);
    if (!h) await new Promise((r) => setTimeout(r, 500));
  }
  if (h) console.log(c.ok(`router healthy on http://127.0.0.1:${port}`));
  else problems.push(`router did not answer /healthz on 127.0.0.1:${port} — start it by hand: node ${path.join(ROUTER_DIR, "server.js")}`);

  for (const p of problems) console.log(c.fail(p));
  console.log(c.head("next"));
  console.log(c.dim("in ZCode: run LogModels to confirm the roster appears, then pick auto-router/auto"));
  console.log(c.dim(`watch routing: tail -f ${ROUTER_LOG}`));
  return problems.length ? 1 : 0;
}

export async function cmdDoctor(flags) {
  const { roster, error } = loadAndResolve();
  const bad = [];
  const line = (ok, label, detail = "") => {
    console.log(`${ok ? c.ok("") : c.fail("")} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) bad.push(label);
  };
  console.log(c.head("doctor"));
  if (error) {
    console.log(c.fail(error));
    return 1;
  }
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  line(true, "roster", ROSTER_PATH);

  const cfgPath = path.join(ROUTER_DIR, "config.json");
  line(fs.existsSync(cfgPath), "router config present", cfgPath);
  line(fs.existsSync(path.join(ROUTER_DIR, "server.js")), "router runtime present");
  line(fs.existsSync(path.join(ROUTER_DIR, "node_modules", "@typesafe-ai")), "router dependency @typesafe-ai/sdk");

  const port = roster.router?.port ?? 8300;
  const h = await health(port);
  line(Boolean(h), "router health", h ? `127.0.0.1:${port}` : `no answer on 127.0.0.1:${port}`);

  if (fs.existsSync(ENV_FILE)) {
    const mode = fs.statSync(ENV_FILE).mode & 0o777;
    line(mode === 0o600, ".env permissions", mode === 0o600 ? "600" : `${mode.toString(8)} — chmod 600 ${ENV_FILE}`);
  } else line(false, ".env file", `${ENV_FILE} missing`);
  line(resolved.envMissing.length === 0, "roster keys resolve", resolved.envMissing.length ? `missing: ${resolved.envMissing.join(", ")}` : "all present");

  for (const [name, t] of Object.entries(roster.tiers)) {
    const w = resolved.workloads[name];
    line(Boolean(w), `tier ${name}`, w ? `${w.providerId}/${w.model}` : "unusable");
  }
  line(Boolean(resolved.aggregator), "mixture aggregator", resolved.aggregator ? `${resolved.aggregator.providerId}/${resolved.aggregator.model}` : "unusable");
  line(resolved.proposers.length >= 2, "mixture proposers", `${resolved.proposers.length} usable`);

  // Cross-check: every workload target must exist in ZCode's provider config
  // (or be a routerOnly extra upstream with a key) — the failure mode that
  // used to produce empty upstream errors.
  const pc = readProviderConfig();
  const rules = pc.exists ? (pc.cfg.config?.providerConfigRules?.providerRules ?? []) : [];
  const modelsByProvider = new Map(rules.map((r) => [r.providerId, r.config?.modelOrder ?? []]));
  for (const [name, w] of Object.entries(resolved.workloads)) {
    if (roster.providers[w.providerId]?.routerOnly) continue;
    const models = modelsByProvider.get(w.providerId);
    line(Boolean(models?.includes(w.model)), `tier ${name} resolvable in ZCode`, models ? (models.includes(w.model) ? `${w.providerId}/${w.model}` : `provider exists but model ${w.model} not in its modelOrder`) : `provider ${w.providerId} not registered`);
  }
  for (const id of Object.keys(roster.providers)) {
    if (roster.providers[id].register === false || roster.providers[id].routerOnly) continue;
    line(rules.some((r) => r.providerId === id), `provider ${id} registered`);
  }

  const lib = readLibrary(WORKFLOWS_DIR);
  line(lib.length > 0, "workflow library installed", `${lib.length} workflows in ${WORKFLOWS_DIR}`);
  const { registry, skipped } = buildRegistry(readLibrary(KIT_WORKFLOWS_DIR), roster);
  const byName = new Map(registry.map((r) => [r.name, r]));
  const unregistered = lib.filter((w) => !byName.has(w.name)).map((w) => w.name);
  // Structured-arg workflows (mailbox connectors, uploads, scopes) are
  // launched by hand, not assigned a task by the router — one line, not thirteen.
  if (unregistered.length) console.log(c.warn(`${unregistered.length} installed workflow(s) take structured args rather than a task and stay hand-launched: ${unregistered.slice(0, 6).join(", ")}${unregistered.length > 6 ? ", …" : ""} (set workflows.registry.<name>.taskArg in the roster to make one assignable)`));
  for (const s of skipped) {
    if (unregistered.includes(s.name) && s.reason.startsWith("no task argument")) continue;
    console.log(c.warn(`library workflow ${s.name} not registered: ${s.reason}`));
  }
  const noArg = registry.filter((r) => !r.taskArg);
  line(noArg.length === 0, "registry task args", `${registry.length} registered, ${skipped.length} hand-launched`);

  const st = serviceStatus();
  line(st.loaded || flags.noService, "service", st.kind === "unsupported" ? `not automated for ${process.platform}` : st.unit);

  if (flags.live) {
    console.log(c.head("live probe (each provider's /models)"));
    for (const [id, p] of Object.entries(roster.providers)) {
      if (p.routerOnly) {
        console.log(c.dim(`${id}: router-only upstream (extraUpstreams) — probed through the router instead`));
        continue;
      }
      const prov = resolved.providers[id];
      if (!prov.usable) {
        console.log(c.dim(`${id}: skipped (no key)`));
        continue;
      }
      const base = (p.baseUrl ?? "").replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${prov.apiKey}` }, signal: AbortSignal.timeout(5000) });
        line(r.ok, `live ${id}`, `HTTP ${r.status}`);
      } catch (e) {
        line(false, `live ${id}`, String(e.message ?? e));
      }
    }
  }

  console.log();
  if (!bad.length) {
    console.log(c.ok("doctor: everything checks out"));
    return 0;
  }
  console.log(c.fail(`doctor: ${bad.length} problem(s): ${bad.join("; ")}`));
  return 1;
}

export function cmdWorkflows(flags, positional) {
  const sub = positional[0] ?? "list";
  const kitLib = readLibrary(KIT_WORKFLOWS_DIR);
  const installed = readLibrary(WORKFLOWS_DIR);
  if (sub === "sync") {
    const r = syncLibrary(KIT_WORKFLOWS_DIR, WORKFLOWS_DIR);
    if (r.copied.length) console.log(c.ok(`installed: ${r.copied.join(", ")}`));
    if (r.updated.length) console.log(c.ok(`updated: ${r.updated.join(", ")}`));
    console.log(c.ok(`${readLibrary(WORKFLOWS_DIR).length} workflows in ${WORKFLOWS_DIR} (${r.unchanged} unchanged)`));
    return 0;
  }
  const { roster } = loadAndResolve();
  const { registry } = roster ? buildRegistry(kitLib, roster) : { registry: [] };
  const reg = new Map(registry.map((r) => [r.name, r]));
  console.log(`${"workflow".padEnd(34)}${"installed".padEnd(10)}${"router arg".padEnd(14)}shape`);
  for (const w of kitLib) {
    const isIn = installed.some((i) => i.name === w.name);
    const r = reg.get(w.name);
    console.log(
      `${w.name.padEnd(34)}${(isIn ? "yes" : "NO").padEnd(10)}${(r?.taskArg ?? "—").padEnd(14)}${(r?.shape ?? "(not registered)").slice(0, 90)}`
    );
  }
  for (const w of installed) {
    if (!kitLib.some((k) => k.name === w.name)) console.log(c.dim(`${w.name}: installed locally, not in the kit library (kept)`));
  }
  return 0;
}

export async function cmdRoute(flags, positional) {
  const task = positional.join(" ").trim();
  if (!task) {
    console.log(c.fail('usage: kit route "the task you want a verdict for"'));
    return 1;
  }
  const { roster, error } = loadAndResolve();
  if (error) return void console.log(c.fail(error)), 1;
  const port = roster.router?.port ?? 8300;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/route`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${roster.router?.localToken ?? "local-auto-router"}` },
      body: JSON.stringify({ task }),
      signal: AbortSignal.timeout(30000),
    });
    const v = await r.json();
    console.log(`workload:   ${v.workload}`);
    console.log(`execution:  ${v.execution}`);
    for (const a of v.assignments ?? []) console.log(`assignment: ${a.name} (arg ${JSON.stringify(Object.keys(a.args ?? {}))})`);
    for (const a of v.assignments ?? []) if (a.args) console.log(`  ${a.name}: ${JSON.stringify(a.args).slice(0, 120)}`);
    if (!(v.assignments ?? []).length) console.log("assignment: none");
    console.log(`conf:       wfConf ${v.wfConf ?? "—"} (workload conf ${v.conf ?? "—"})`);
    console.log(`reason:     ${v.reason ?? "—"}`);
    return 0;
  } catch (e) {
    console.log(c.fail(`router unreachable on 127.0.0.1:${port}: ${e.message}`));
    return 1;
  }
}

export async function cmdUpgrade() {
  const { execFileSync } = await import("node:child_process");
  console.log(c.dim("git pull…"));
  try {
    console.log(execFileSync("git", ["pull", "--ff-only"], { cwd: KIT_DIR, encoding: "utf8" }).trim());
  } catch (e) {
    console.log(c.fail(`git pull failed: ${e.stderr ?? e.message}`));
    return 1;
  }
  return cmdApply({});
}

const COMMANDS = {
  status: cmdStatus,
  export: cmdExport,
  init: cmdInit,
  env: cmdEnv,
  apply: cmdApply,
  doctor: cmdDoctor,
  workflows: cmdWorkflows,
  route: cmdRoute,
  upgrade: cmdUpgrade,
};

export async function main(argv) {
  const { flags, positional } = parseFlags(argv);
  const cmd = positional.shift() ?? "status";
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log(`zcode-router-kit ${KIT_VERSION}\n`);
    console.log("commands:");
    for (const [name] of Object.entries(COMMANDS)) console.log(`  kit ${name}`);
    console.log(`  kit help`);
    return 1;
  }
  return (await fn(flags, positional)) ?? 0;
}
