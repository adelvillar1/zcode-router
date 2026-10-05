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
 *   kit workflows list|sync        the .dwf delegation library
 *   kit workflows run|watch|graph  the kit runtime: run a workflow, replay its journal, export the session graph
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
import { normalizeEvent, isTerminal } from "workflow-plane/events.mjs";
import { fmtTokens } from "workflow-plane/engine.mjs";
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
  // Every code + doc file in the kit's router dir ships — an explicit list
  // went stale twice (quota.mjs, fastino.mjs) and crash-looped the deployed
  // router on a missing module. config.json is absent from the kit dir (it is
  // generated), so the glob cannot clobber live state.
  const files = fs.readdirSync(path.join(KIT_DIR, "router")).filter((f) =>
    f.endsWith(".js") || f.endsWith(".mjs") || f === "dashboard.html" || f === "package.json" || f === "README.md"
  );
  for (const f of files) {
    const src = path.join(KIT_DIR, "router", f);
    const dest = path.join(routerDir, f);
    fs.mkdirSync(routerDir, { recursive: true });
    const same = fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");
    if (!same) {
      if (!dry) fs.copyFileSync(src, dest);
      steps.push(`${dry ? "would copy" : "copied"} ${f}`);
    }
  }
  // The plane ships as a package: the kit resolves it as a file: dependency on
  // the engine checkout, and installs it beside the router where the CLI, the
  // watcher and the shipped server all read the same modules. What ships is
  // derived from the package's own exports rather than a written list, and the
  // node_modules link beside it is what makes the server's specifier imports
  // resolve inside the install instead of reaching back to the checkout.
  const wfSrc = planePackageDir();
  if (wfSrc) {
    const wfDest = path.join(routerDir, "..", "lib", "workflow");
    const manifest = JSON.parse(fs.readFileSync(path.join(wfSrc, "package.json"), "utf8"));
    for (const entry of Object.values(manifest.exports ?? {})) {
      const f = String(entry).replace(/^\.\//, "");
      const src = path.join(wfSrc, f);
      const dest = path.join(wfDest, f);
      if (!fs.existsSync(src)) throw new Error(`lib/workflow/package.json declares ${f} but it is not on disk`);
      const same = fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");
      if (!same) {
        if (!dry) fs.copyFileSync(src, dest);
        steps.push(`${dry ? "would copy" : "copied"} lib/workflow/${f}`);
      }
    }
    const link = path.join(routerDir, "node_modules", "workflow-plane");
    const want = path.relative(path.dirname(link), wfDest);
    let inPlace = false;
    try {
      inPlace = fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(wfDest);
    } catch {
      inPlace = false;
    }
    if (!inPlace) {
      if (!dry) {
        fs.mkdirSync(wfDest, { recursive: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { force: true });
        fs.symlinkSync(want, link, "dir");
      }
      steps.push(`${dry ? "would link" : "linked"} node_modules/workflow-plane -> ${want}`);
    }
  }
  return steps;
}

/** The installed plane package, or null when the kit has no install yet. */
function planePackageDir() {
  for (const c of [path.join(KIT_DIR, "node_modules", "workflow-plane"), path.resolve(KIT_DIR, "..", "node_modules", "workflow-plane")]) {
    if (fs.existsSync(path.join(c, "package.json"))) return fs.realpathSync(c);
  }
  return null;
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
    const { registry, library: libraryView } = buildRegistry(library, roster);
    const cfg = renderRouterConfig(roster, resolved, registry, { port, library: libraryView });
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

const fmtDur = (ms) => !Number.isFinite(ms) ? "—"
  : ms < 1000 ? `${Math.round(ms)}ms`
  : ms < 90_000 ? `${(ms / 1000).toFixed(1)}s`
  : ms < 5_400_000 ? `${(ms / 60_000).toFixed(1)}m`
  : `${(ms / 3_600_000).toFixed(2)}h`;

const fmtBytes = (n) => !Number.isFinite(n) ? "0B"
  : n < 1024 ? `${n}B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}k`
  : `${(n / 1024 / 1024).toFixed(1)}M`;
const previewText = (s, cap) => (s.length > cap ? `${s.slice(0, cap)}…` : s);

function watchLine(e) {
  const at = Number.isFinite(e.t) ? `+${fmtDur(e.t)}`.padEnd(9) : " ".repeat(9);
  const who = String(e.actor ?? "").replace(/^Builder for /, "").split(" · ")[0].slice(0, 52);
  switch (e.kind) {
    case "run-start": return `${at} ▶ run · ${e.model ?? ""} ${e.workdir ?? ""}`;
    case "phase": return `${at} ── ${e.phase}`;
    case "agent": return `${at} ● ${who} asked${e.ms != null ? ` (${fmtDur(e.ms)}${e.tools ? ", tools" : ""})` : ""}`;
    case "tool": {
      // Two lines describe a recall, because two lines describe any tool call:
      // the agent loop's action line (with the agent's name, `facts` absent) and
      // the recall impl's own audit line (with what the agent was shown). Both
      // belong to the recall, so both read as one.
      if (e.tool === "recall" || e.actor === "recall" || Number.isFinite(e.facts)) {
        if (e.refused) return `${at}   · recall [refused: ${e.refused.split(" — ")[0]}]`;
        if (Number.isFinite(e.facts)) return `${at}   · recall → ${e.facts} fact(s), ${fmtBytes(e.bytes ?? 0)}`;
        return `${at}   · ${who} → recall`;
      }
      const tool = e.tool || e.actor || "tool";
      const tail = e.refused ? ` [refused: ${e.refused.split(" — ")[0]}]` : e.grant ? ` [${e.grant}]` : "";
      return who && who !== tool ? `${at}   · ${who} → ${tool}${tail}` : `${at}   · ${tool}${tail}`;
    }
    case "service": {
      const what = e.event === "start" ? `started ${e.command} (${e.lifetimeMs}ms)` : e.event === "stop" ? "stopped" : e.event;
      const end = e.exitCode != null ? ` — exit ${e.exitCode}` : e.signal ? ` — killed by ${e.signal}` : "";
      return `${at}   · ${e.service} ${what}${end}`;
    }
    case "report": return `${at} ≡ ${e.item ?? ""}`;
    case "escalation": return `${at} ⚠ ${who}: ${e.question ?? ""}`;
    case "delegate":
      if (e.op === "spawn") return `${at} ⇢ delegate → ${e.child} · ${String(e.task ?? "").slice(0, 70)}`;
      if (e.op === "failed") return `${at} ⇢ delegate failed — ${e.reason}`;
      return `${at} ⇢ delegate ← ${e.asks} asks, ${e.toolCalls} tools, ${fmtDur(e.ms ?? 0)}`;
    case "checkpoint":
      if (e.op === "refused") return `${at} ✗ checkpoint refused — ${e.part}: ${String(e.reason ?? "").split(" — ")[0]}`;
      return `${at} ⤓ checkpoint ${e.part} — ${e.paths} path(s), ${fmtBytes(e.bytes ?? 0)}${e.oversized ? " (oversized: existence only)" : ""}`;
    case "rollback":
      return `${at} ↩ rollback ${e.part} — ${e.restored} restored, ${e.removed} removed${e.left ? `, ${e.left} left` : ""}${e.uncaptured ? `, ${e.uncaptured} uncaptured` : ""}`;
    case "account":
      return (
        `${at} ↳ account ${who} — ask ${e.ask ?? "?"}, ${e.rounds ?? 0} round(s), ` +
        `${fmtTokens(e.promptTokens ?? 0)} in / ${fmtTokens(e.completionTokens ?? 0)} out` +
        `${e.compacted ? `, compacted ×${e.compacted}` : ""}` +
        `${e.shape && e.shape !== "build" ? ` [${e.shape}: ${e.budget?.rounds ?? "?"} rounds / ${fmtTokens(e.budget?.tokens ?? 0)}]` : ""}`
      );
    case "budget":
      return `${at} ⛔ budget ${who} — ${e.shape ?? "build"} ask hit the cap: ${e.reason ?? "?"} spent (${e.rounds ?? 0} round(s), ${fmtTokens(e.spent ?? 0)})`;
    case "compact": {
      const how = e.mode === "truncate" ? "truncated (no summary)" : "summarized";
      return (
        `${at} ↯ compact ${who} — ${fmtTokens(e.before ?? 0)} → ${fmtTokens(e.after ?? 0)} (line ${fmtTokens(e.limit ?? 0)}), ` +
        `${how}: ${e.summarized ?? 0} message(s) → ${e.kept ?? 0} kept` +
        `${e.dropped ? `, ${e.dropped} too old to summarize` : ""}`
      );
    }
    case "artifact": return `${at} ◆ artifact ${e.artifactId}${e.version != null ? ` v${e.version}` : ""} → ${e.path ?? ""}`;
    case "command":
      if (e.refused) return `${at} $ ${e.command} [refused: ${e.refused.split(" — ")[0]}]`;
      return `${at} $ ${e.command}${e.grant ? ` [${e.grant}]` : ""}`;
    case "log": return `${at}   ${e.message ?? ""}`;
    case "fact": {
      // A line the plane wrote about its own run, not an agent action: the
      // arrival of one is the fact becoming part of the run's record.
      const what = e.factKind ? e.factKind : "fact";
      const where = e.part ? ` ${e.part}` : "";
      return `${at}   ✎ ${what}${where} — ${previewText(e.text ?? "", 48)}`;
    }
    case "warn": return `${at} ! ${e.message ?? ""}`;
    case "run-done": return `${at} ✓ done in ${fmtDur(e.ms)} — ${e.result ?? ""}`;
    case "run-failed": return `${at} ✗ ${e.error ?? ""}`;
    default: return `${at} ${e.kind}`;
  }
}

// One normalized line per journal event — a finished replay must line up with
// the journal 1:1 (that is the C7 diff). The journal is only ever read.
function watchRun(runDir, follow) {
  const runId = path.basename(runDir);
  const jp = path.join(runDir, "run.jsonl");
  let offset = 0;
  let partial = "";
  let terminal = false;
  const emit = (text) => {
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = normalizeEvent(line, { runId });
      if (!ev) continue;
      if (isTerminal(ev.kind)) terminal = true;
      console.log(watchLine(ev));
    }
  };
  try {
    const buf = fs.readFileSync(jp);
    offset = buf.length;
    emit(buf.toString("utf8"));
  } catch {}
  if (!follow) {
    if (!terminal) console.log(c.dim("(run still going — `--follow` tails it; the router is never involved either way)"));
    return 0;
  }
  console.log(c.dim("(following — Ctrl-C stops)"));
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(jp).size; } catch { return; }
      if (size !== offset) {
        if (size < offset) { offset = 0; console.log(c.dim("(journal truncated — replaying)")); }
        try {
          const fd = fs.openSync(jp, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          emit(buf.toString("utf8"));
        } catch {}
      }
      if (terminal && fs.existsSync(path.join(runDir, "summary.json"))) {
        clearInterval(tick);
        console.log(c.dim("(run settled)"));
        resolve(0);
      }
    }, 1000);
  });
}

function toDot(graph) {
  const q = (s) => `"${String(s ?? "").replace(/[\\"]/g, " ").replace(/\n/g, " ").slice(0, 80)}"`;
  const color = { plan: "#4f8cc9", criterion: "#3fb950", phase: "#8b949e", run: "#d29922", agent: "#a371f7", part: "#bc8cff", artifact: "#db61a2", gate: "#f85149", commit: "#7a828e", recap: "#39c5cf" };
  const out = [
    "digraph session {",
    "  rankdir=LR;",
    '  node [shape=box style="filled,rounded" fontname="Helvetica" fontsize=10 fontcolor="white"];',
    '  edge [color="#9aa4ae" arrowsize=0.6 fontname="Helvetica" fontsize=8];',
  ];
  // Agents and artifacts cluster under their run; plans, criteria, commits,
  // recaps and the run nodes themselves stay top-level so clusters don't nest.
  const clusters = new Map();
  const loose = [];
  for (const n of graph.nodes) {
    if (n.kind !== "run" && n.run) (clusters.get(`run:${n.run}`) ?? clusters.set(`run:${n.run}`, []).get(`run:${n.run}`)).push(n);
    else loose.push(n);
  }
  for (const n of loose) out.push(`  ${q(n.id)} [label=${q(n.kind === "run" ? (n.workflow ?? n.label) : n.label)} fillcolor="${color[n.kind] ?? "#999"}"];`);
  let i = 0;
  for (const [runId, members] of clusters) {
    out.push(`  subgraph cluster_${i++} {`, `    label=${q(runId)}; style=rounded; color="#9aa4ae";`);
    for (const n of members) out.push(`    ${q(n.id)} [label=${q(n.label)} fillcolor="${color[n.kind] ?? "#999"}"];`);
    out.push("  }");
  }
  for (const e of graph.edges) out.push(`  ${q(e.from)} -> ${q(e.to)} [label=${q(e.kind)}];`);
  out.push("}");
  return out.join("\n");
}

function toArchify(graph, opts = {}) {
  // A publication diagram is one run's story plus the plan spine — the full
  // session dump (380+ nodes) is for the dashboard's DAG, not archify's gated
  // renderer, whose layout solver assumes diagram-sized inputs. --archify-run
  // scopes the candidate to the matching run; without it the full graph goes
  // out and validate is the caller's experiment.
  let nodesSrc = graph.nodes;
  let edgesSrc = graph.edges;
  if (opts.run) {
    const f = String(opts.run).toLowerCase();
    const runNode = graph.nodes.filter((n) => n.kind === "run" && ((n.workflow ?? "").toLowerCase() === f || n.id.toLowerCase().includes(f))).at(-1);
    if (!runNode) throw new Error(`no run matches "${opts.run}" — \`kit workflows graph\` lists what the session holds`);
    // A workflow diagram tells one run's story: plans (with criteria/phases
    // collapsed to one summary node each — a 12-way checkbox fan-out is
    // dashboard/DOT material, not a publication diagram), the run, its agents
    // and artifacts, and the recaps that recorded them.
    const plans = graph.nodes.filter((n) => n.kind === "plan");
    const synth = [];
    const home = new Map(); // collapsed node id -> summary node id
    for (const p of plans) {
      const crits = graph.nodes.filter((n) => n.kind === "criterion" && n.plan === p.label);
      const phases = graph.nodes.filter((n) => n.kind === "phase" && n.plan === p.label);
      if (crits.length) {
        synth.push({ id: `critsum:${p.label}`, kind: "criterion", label: `${p.label} criteria ${crits.filter((c) => c.done).length}/${crits.length} done` });
        for (const c of crits) home.set(c.id, `critsum:${p.label}`);
      }
      if (phases.length) {
        synth.push({ id: `phasesum:${p.label}`, kind: "phase", label: `${p.label} · ${phases.length} phases` });
        for (const ph of phases) home.set(ph.id, `phasesum:${p.label}`);
      }
    }
    const arts = graph.nodes.filter((n) => n.kind === "artifact" && n.run === runNode.label);
    const agents = graph.nodes.filter((n) => n.kind === "agent" && n.run === runNode.label);
    // readable-v2's endpoint stubs cap any node's fan-out well below a real
    // run's agent count — the candidate carries the builders as one counted
    // summary node; per-agent detail stays in the dashboard and the DOT.
    const agentSummaryId = agents.length ? `agents:${runNode.label}` : null;
    const agentSummary = agentSummaryId
      ? [{
          id: agentSummaryId,
          kind: "agent",
          label: `${agents.length} agents · ${agents.reduce((s, a) => s + (a.asks ?? 0), 0)} asks · ${agents.reduce((s, a) => s + (a.toolCalls ?? 0), 0)} tool calls`,
        }]
      : [];
    const recaps = graph.nodes.filter((n) => n.kind === "recap");
    nodesSrc = [...plans, ...synth, runNode, ...agentSummary, ...arts, ...recaps];
    const keep = new Set(nodesSrc.map((n) => n.id));
    const seen = new Set();
    edgesSrc = [];
    for (const e of graph.edges) {
      let from = home.get(e.from) ?? e.from;
      let to = home.get(e.to) ?? e.to;
      if (agentSummaryId && e.kind === "spawns" && String(e.to).startsWith(`agent:${runNode.label}:`)) to = agentSummaryId;
      if (agentSummaryId && e.kind === "produces" && from === runNode.id) from = agentSummaryId;
      if (!keep.has(from) || !keep.has(to) || from === to) continue;
      const key = `${from}|${to}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgesSrc.push({ ...e, from, to });
    }
  }
  const LANES = [
    { kinds: ["plan", "criterion", "phase"], lane: { id: "plans", label: "Plans & criteria" } },
    { kinds: ["run"], lane: { id: "runs", label: "Workflow runs" } },
    { kinds: ["agent", "part"], lane: { id: "agents", label: "Agents & parts" } },
    { kinds: ["artifact", "gate"], lane: { id: "deliveries", label: "Artifacts & gates" } },
    { kinds: ["commit", "recap"], lane: { id: "record", label: "Commits & recaps" } },
  ];
  const laneOf = Object.fromEntries(LANES.flatMap((l) => l.kinds.map((k) => [k, l.lane.id])));
  const TYPE = { plan: "cloud", criterion: "security", phase: "messagebus", run: "backend", agent: "frontend", part: "frontend", artifact: "database", gate: "security", commit: "database", recap: "external" };

  // archify ids are [a-zA-Z][a-zA-Z0-9_-]* — graph ids carry colons; sanitize
  // and de-collide. Columns come from a longest-path layering capped at 5.
  const used = new Map();
  const aid = (raw) => {
    let s = String(raw).replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 60) || "node";
    if (!/^[a-zA-Z]/.test(s)) s = `n${s}`;
    const n = used.get(s) ?? 0;
    used.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  };
  const indeg = new Map(nodesSrc.map((n) => [n.id, 0]));
  const outs = new Map(nodesSrc.map((n) => [n.id, []]));
  for (const e of edgesSrc) {
    if (outs.has(e.from) && indeg.has(e.to)) { outs.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  }
  const col = new Map();
  let frontier = nodesSrc.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of frontier) col.set(id, 0);
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const to of outs.get(id)) {
        col.set(to, Math.min(5, Math.max(col.get(to) ?? 0, (col.get(id) ?? 0) + 1)));
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0) next.push(to);
      }
    }
    frontier = next;
  }
  const idMap = new Map();
  const nodes = nodesSrc.map((n) => {
    const id = aid(n.id);
    idMap.set(n.id, id);
    return {
      id,
      lane: laneOf[n.kind] ?? "record",
      col: col.get(n.id) ?? 0,
      type: TYPE[n.kind] ?? "backend",
      label: String(n.label ?? n.id).slice(0, 40) || String(n.id),
      sublabel: n.kind,
    };
  });
  // archify stacks by lane+column; without an explicit yOffset co-located
  // nodes overlap and the layout gate rejects the candidate. Width follows
  // the label (archify measures ~7px per character at its default font).
  const stack = new Map();
  for (const nd of nodes) {
    const k = `${nd.lane}|${nd.col}`;
    const i = stack.get(k) ?? 0;
    stack.set(k, i + 1);
    nd.yOffset = i * 90;
    nd.width = Math.min(360, Math.max(96, nd.label.length * 7.5 + 30));
    stack.set(nd.id, i); // per-node stack row, for edge-corridor ordering
  }
  // The showcase gate rejects same-source edges that cross: give each source's
  // fan-out monotonic corridors ordered by its targets' visual rows.
  const bySource = new Map();
  for (const [i, e] of edgesSrc.entries()) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to || from === to) continue;
    (bySource.get(from) ?? bySource.set(from, []).get(from)).push({ i, to, row: stack.get(to) ?? 0, col: col.get(e.to) ?? 0 });
  }
  const biasOf = new Map();
  for (const group of bySource.values()) {
    group.sort((a, b) => (a.col - b.col) || (a.row - b.row));
    group.forEach((g, rank) => biasOf.set(g.i, group.length > 1 ? 0.15 + (0.7 * rank) / (group.length - 1) : 0.5));
  }
  const edges = [];
  for (const [i, e] of edgesSrc.entries()) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to || from === to) continue;
    const edge = { id: `e${i}`, from, to, label: String(e.kind ?? "") };
    if (biasOf.has(i)) edge.bias = Math.round(biasOf.get(i) * 100) / 100;
    edges.push(edge);
  }
  return {
    schema_version: 2,
    diagram_type: "workflow",
    meta: { title: "Workflow session graph", output: "out/workflow-session.html", quality_profile: "showcase" },
    lanes: LANES.map((l) => l.lane),
    nodes,
    edges,
  };
}

export async function cmdWorkflows(flags, positional) {
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

  function summarize(item) {
    if (item === null || item === undefined) return String(item);
    if (typeof item === "string") return item.slice(0, 120);
    const parts = [];
    for (const k of ["what", "where", "problem", "winner", "hypothesis", "cause"]) {
      if (item[k]) parts.push(String(item[k]).slice(0, 100));
    }
    return (parts.length ? parts.join(" — ") : JSON.stringify(item)).slice(0, 140);
  }

  if (sub === "run") {
    process.env.AGNOSTIC_ROUTER_KIT_HOME ??= ROUTER_DIR; // the verbatim engine journals under the router runtime dir
    const name = positional[1];
    const file = name ? (fs.existsSync(name) ? name : path.join(KIT_WORKFLOWS_DIR, `${name}.ts`)) : null;
    if (!file || !fs.existsSync(file)) {
      console.log(c.fail(`no runtime workflow "${name ?? ""}" — workflows/<name>.ts beside the .dwf library, or a direct path`));
      return 1;
    }
    let args = {};
    if (flags.args) {
      try {
        args = JSON.parse(String(flags.args));
      } catch (e) {
        console.log(c.fail(`--args is not valid JSON: ${e.message}`));
        return 1;
      }
    }
    // The escalation answer table: a structured topic on the plane's side matches
    // a key here deterministically, so an operator can answer a run's question
    // before it happens. Malformed JSON is a usage error, not a run that dies on
    // a missing answer.
    let answers = {};
    if (flags.answers) {
      try {
        answers = JSON.parse(String(flags.answers));
      } catch (e) {
        console.log(c.fail(`--answers is not valid JSON: ${e.message}`));
        return 1;
      }
    }
    const port = roster?.router?.port ?? 8300;
    const token = roster?.router?.localToken ?? "local-auto-router";
    const workdir = flags.workdir ? path.resolve(String(flags.workdir)) : process.cwd();
    const t0 = Date.now();
    console.log(c.dim(`${name} — ${workdir}`));
    try {
      const { runWorkflow } = await import("workflow-plane/engine.mjs");
      const { summary, result } = await runWorkflow(file, {
        args,
        workdir,
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        model: flags.model ? String(flags.model) : undefined,
        allowCommands: flags.allowCmd ? [String(flags.allowCmd)] : [],
        // Capabilities the ported plane grants per run: no capability is ambient,
        // so a workflow that fetches or installs is refused without its flag —
        // and the refusal is journalled against the grant it would have needed.
        grants: flags.grant ? String(flags.grant) : "",
        netDomains: flags.allowDomain
          ? String(flags.allowDomain).split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        answers,
        agentMaxRounds: flags.maxRounds ? Number(flags.maxRounds) : undefined,
        // The prompt size at which the plane compacts an agent's history: a
        // provider with a small window needs a tighter line than the default.
        compactTokens: flags.compactTokens ? Number(flags.compactTokens) : undefined,
        onEvent: (e) => {
          if (e.kind === "phase") console.log(c.dim(`── ${e.phase}`));
          else if (e.kind === "log") console.log(c.dim(`   ${e.message}`));
          else if (e.kind === "report") console.log(c.dim(`   · ${summarize(e.item)}`));
          else if (e.kind === "warn") console.log(c.warn(e.message));
          else if (e.kind === "escalation") console.log(c.warn(`escalated: ${e.question}`));
          else if (e.kind === "budget") console.log(c.warn(`budget: ${e.actor} — ${e.shape ?? "build"} ask hit the cap (${e.reason ?? "?"})`));
        },
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const tk = summary.tokens ?? { promptTokens: 0, completionTokens: 0 };
      console.log(
        c.ok(
          `${name} finished in ${secs}s — ${summary.agentCalls} agent calls, ${summary.phases.length} phases` +
            ` — ${fmtTokens(tk.promptTokens)} in / ${fmtTokens(tk.completionTokens)} out`
        )
      );
      if (result?.conclusion) console.log(`  ${result.conclusion}`);
      for (const a of summary.artifacts) {
        const v = a.versions.length;
        console.log(`  artifact: ${a.id} (v${v}) → ${path.join(summary.runDir, "artifacts", a.id, `v${v}`)}`);
      }
      console.log(c.dim(`journal: ${summary.journal}`));
      return 0;
    } catch (e) {
      console.log(c.fail(`${name} failed: ${e.message}`));
      const dir = e?.runDir ?? path.join(process.env.AGNOSTIC_ROUTER_KIT_HOME ?? ROUTER_DIR, "workflow-runs", name);
      console.log(c.dim(`journal: ${path.join(dir, "run.jsonl")}`));
      return 1;
    }
  }

  if (sub === "watch") {
    process.env.AGNOSTIC_ROUTER_KIT_HOME ??= ROUTER_DIR;
    const { KIT_WORKFLOW_RUNS } = await import("workflow-plane/engine.mjs");
    const dir = KIT_WORKFLOW_RUNS();
    const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "run.jsonl"))).sort() : [];
    let runId = positional[1];
    if (!runId) {
      if (!runs.length) {
        console.log(c.warn("no workflow runs to watch yet"));
        return 0;
      }
      runId = runs.at(-1);
      console.log(c.dim(`no run given — watching the latest: ${runId}`));
    } else if (!runs.includes(runId)) {
      console.log(c.fail(`no journal for "${runId}" under ${dir}`));
      return 1;
    }
    return watchRun(path.join(dir, runId), Boolean(flags.follow));
  }

  if (sub === "graph") {
    process.env.AGNOSTIC_ROUTER_KIT_HOME ??= ROUTER_DIR;
    const { buildGraph } = await import("workflow-plane/graph.mjs");
    const graph = buildGraph({
      kitHome: process.env.AGNOSTIC_ROUTER_KIT_HOME,
      repoRoot: process.env.AGNOSTIC_ROUTER_KIT_REPO_ROOT ?? KIT_DIR,
    });
    if (flags.dot) {
      console.log(toDot(graph));
      return 0;
    }
    if (flags.archify) {
      const out = path.resolve(String(flags.archify));
      const candidate = toArchify(graph, { run: flags.archifyRun });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(candidate, null, 2) + "\n");
      console.log(c.ok(`archify workflow candidate → ${out} (${candidate.nodes.length} nodes, ${candidate.edges.length} edges)${flags.archifyRun ? ` · run: ${flags.archifyRun}` : " · full session"}`));
      console.log(c.dim(`gate it: archify validate workflow ${out} --json`));
      return 0;
    }
    console.log(`session graph — ${graph.counts.nodes} nodes, ${graph.counts.edges} edges`);
    console.log(c.dim(`kit  ${graph.kitHome}`));
    console.log(c.dim(`repo ${graph.repoRoot}`));
    for (const [kind, n] of Object.entries(graph.counts.byKind)) console.log(c.dim(`${kind.padEnd(10)} ${n}`));
    console.log(c.dim("export: --dot (stdout) · --archify <file.json> (archify workflow candidate)"));
    return 0;
  }

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
