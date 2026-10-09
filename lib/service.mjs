/**
 * Keep the router running: launchd (macOS) or a systemd --user unit (Linux).
 * The service runs the runtime copy at ~/.zcode/router/server.js, so the
 * kit repo can be updated with `git pull` without moving the service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SERVICE_LABEL, ROUTER_DIR, platform } from "./paths.mjs";

/** Run launchctl/systemctl, never swallowing why it failed. */
function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim(), status: e.status };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function servicePaths() {
  if (platform() === "macos") {
    return { kind: "launchd", unit: path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`), domain: `gui/${os.userInfo().uid}` };
  }
  if (platform() === "linux") {
    return { kind: "systemd", unit: path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_LABEL}.service`), domain: null };
  }
  return { kind: "unsupported", unit: null, domain: null };
}

export function launchdPlist({ node, scriptDir, label = SERVICE_LABEL }) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${esc(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(node)}</string>
        <string>${esc(path.join(scriptDir, "server.js"))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(scriptDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(path.join(scriptDir, "logs", "launchd-stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${esc(path.join(scriptDir, "logs", "launchd-stderr.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${esc(path.join(os.homedir(), ".local", "bin"))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
`;
}

export function systemdUnit({ scriptDir }) {
  return `[Unit]
Description=ZCode local model router
After=network.target

[Service]
Type=simple
WorkingDirectory=${scriptDir}
ExecStart=${process.execPath} ${path.join(scriptDir, "server.js")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Which node runs the service. A fragile choice here silently kills the
 * router later (e.g. inside another tool's bundled node), so the order is:
 * explicit flag > ZCODE_NODE > the user's stable ~/.local/bin/node > whatever
 * node is running this process. Always printed so the operator can see it.
 */
export function resolveNodeBin(flag) {
  if (flag) return { bin: flag, source: "flag" };
  if (process.env.ZCODE_NODE) return { bin: process.env.ZCODE_NODE, source: "ZCODE_NODE" };
  const preferred = path.join(os.homedir(), ".local", "bin", "node");
  try {
    if (fs.existsSync(preferred)) return { bin: preferred, source: "~/.local/bin/node" };
  } catch {}
  return { bin: process.execPath, source: "process.execPath" };
}

/**
 * launchctl truth-telling helpers. Every subcommand that takes a service
 * target wants "domain/label" as ONE argument — two arguments exit 0 while
 * doing nothing, or fail with launchd's opaque errno 5. A label is matched as
 * a whole whitespace-separated token, never by column index: the shape of a
 * `launchctl list` row is launchd's business, and a label that is a prefix of
 * another must not match it.
 */
function rowNamesLabel(row, label) {
  return row.split(/\s+/).includes(label);
}

function isLoadedLabel(domain, label) {
  const r = run("launchctl", ["list"]);
  if (!r.ok) return false;
  return r.out.split("\n").some((l) => rowNamesLabel(l, label));
}

function labelRunning(domain, label) {
  const r = run("launchctl", ["print", `${domain}/${label}`]);
  return r.ok && /\bstate\s*=\s*running\b/.test(r.out);
}

/** `launchctl list` rows split into their PID and label, idle PIDs included. */
function launchctlRows(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    rows.push({ pid: cols[0], label: cols.slice(2).join(" ") });
  }
  return rows;
}

/** `launchctl list` rows: a running service carries a numeric PID, an idle one a dash. */
export function parseLaunchctlList(out) {
  const byPid = new Map();
  for (const row of launchctlRows(out)) {
    const pid = Number(row.pid);
    if (Number.isInteger(pid) && pid > 0) byPid.set(pid, row.label);
  }
  return byPid;
}

/** Every label launchd has loaded, running or idle, in list order. */
export function parseLaunchctlLabels(out) {
  return launchctlRows(out).map((r) => r.label);
}

/**
 * Which launchd label is running the process whose command names `serverPath`.
 * `ps` output is `PID<space>command`, so the match is on the command's own
 * text — the router's server.js path is distinctive enough that a shared node
 * binary or a wrapper script cannot produce a false positive.
 */
export function parseRunningOwner(psOut, serverPath) {
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes(serverPath)) return Number(m[1]);
  }
  return null;
}

/** Does this plist's ProgramArguments run exactly `serverPath`? */
export function plistRunsServer(plistText, serverPath) {
  const args = [...plistText.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return args.some((a) => a === serverPath);
}

/**
 * Every loaded label whose own plist runs this router's server.js — the
 * services competing for the router's port. On a machine where more than one
 * tool installed the service they all carry KeepAlive, so booting out the one
 * the kit reloaded hands the port to whichever of them launchd spawns next,
 * and the reload looks like a failure while the router comes up on the old
 * plane. The set comes from each label's definition rather than from its name,
 * so a squatter installed under any label is still found.
 */
export function competingLabels(listOut, plistsDir, serverPath) {
  return parseLaunchctlLabels(listOut).filter((label) => {
    let text;
    try {
      text = fs.readFileSync(path.join(plistsDir, `${label}.plist`), "utf8");
    } catch {
      return false; // no plist on disk: nothing to compare, so not a competitor
    }
    return plistRunsServer(text, serverPath);
  });
}

/**
 * Each plist key with the string values that follow it. Reading key/value pairs
 * rather than loose strings is what keeps one difference from being reported
 * twice: a missing key takes its value with it, and an owner whose file lacks
 * WorkingDirectory has one difference, not two.
 */
function plistEntries(text) {
  const entries = new Map();
  let current = null;
  const re = /<key>([^<]+)<\/key>|<string>([^<]*)<\/string>/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      current = m[1];
      if (!entries.has(current)) entries.set(current, []);
    } else if (current !== null) {
      entries.get(current).push(m[2]);
    }
  }
  return entries;
}

/**
 * How an owner's plist differs from what the kit would write, named as keys
 * and values rather than as a vague "drift". The report is the operator's only
 * signal that they are running their own definition, so it must say what that
 * definition actually does differently — "PATH, node, or scriptDir" is a guess,
 * and on this machine it is the wrong one.
 */
export function plistDiffs(ownerText, desiredText) {
  const a = plistEntries(ownerText);
  const b = plistEntries(desiredText);
  const diff = [];
  const kMissing = [...b.keys()].filter((k) => !a.has(k));
  const kExtra = [...a.keys()].filter((k) => !b.has(k));
  if (kMissing.length) diff.push(`keys missing from the owner's file: ${kMissing.join(", ")}`);
  if (kExtra.length) diff.push(`keys only in the owner's file: ${kExtra.join(", ")}`);
  for (const [k, va] of a) {
    if (!b.has(k)) continue;
    const vb = b.get(k);
    if (va.length !== vb.length || va.some((v, i) => v !== vb[i])) {
      diff.push(`${k}: the owner writes ${va.join(" ")} — the kit writes ${vb.join(" ")}`);
    }
  }
  return diff;
}

/**
 * The label launchd is running the router with, found by the process rather
 * than by the kit's own label. A service another tool installed can own the
 * running router — the ZCode app does on this machine — and reloading the
 * kit's label then leaves the live router on the old plane while the kit
 * reports success. Discovery is exhaustive over launchd's own list, so it does
 * not depend on what any label happens to be named.
 */
export function findRunningRouterLabel({ listOut, psOut, serverPath }) {
  const pid = parseRunningOwner(psOut, serverPath);
  if (pid === null) return { label: null, pid: null };
  return { label: parseLaunchctlList(listOut).get(pid) ?? null, pid };
}

function runningRouterLabel(domain, scriptDir) {
  const list = run("launchctl", ["list"]);
  const ps = run("ps", ["-ax", "-o", "pid=,command="]);
  const found = findRunningRouterLabel({
    listOut: list.ok ? list.out : "",
    psOut: ps.ok ? ps.out : "",
    serverPath: path.join(scriptDir, "server.js"),
  });
  // A failed lookup must not read as "no service found" — that would reload
  // the kit's own label on a machine where something else owns the router.
  const trouble = !list.ok ? `launchctl list failed: ${list.out}` : !ps.ok ? `ps failed: ${ps.out}` : null;
  return { ...found, trouble, listOut: list.ok ? list.out : "" };
}

async function waitUntil(predicate, { ms = 10000, every = 300 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

export function serviceStatus() {
  const p = servicePaths();
  if (p.kind === "launchd") {
    const found = runningRouterLabel(p.domain, ROUTER_DIR);
    const label = found.label ?? SERVICE_LABEL;
    const loaded = isLoadedLabel(p.domain, label);
    return {
      kind: "launchd",
      loaded,
      unit: path.join(path.dirname(p.unit), `${label}.plist`),
      domain: p.domain,
      running: loaded && labelRunning(p.domain, label),
      label,
      foreign: label !== SERVICE_LABEL,
      trouble: found.trouble ?? null,
    };
  }
  if (p.kind === "systemd") {
    const r = run("systemctl", ["--user", "is-active", SERVICE_LABEL]);
    return { kind: "systemd", loaded: r.out === "active", unit: p.unit, running: r.out === "active", active: r.out };
  }
  return { kind: "unsupported", loaded: false, unit: null, running: false, trouble: `not automated for ${process.platform}` };
}

/** Write the unit and (re)start it. Returns steps taken for the report. */
export async function installService({ node = null, scriptDir = ROUTER_DIR } = {}) {
  const p = servicePaths();
  const steps = [];
  if (p.kind === "unsupported") return { ok: false, steps, error: `unsupported platform: ${process.platform}` };
  const nodeBin = resolveNodeBin(node);
  steps.push(`node: ${nodeBin.bin} (${nodeBin.source})`);
  if (p.kind === "launchd") {
    // Whose service is actually running the router? The kit's own label is
    // only a default. On a machine where another tool installed the service,
    // the kit's label is a competing service fighting for the same port, and
    // reloading it leaves the live router on the old plane.
    const found = runningRouterLabel(p.domain, scriptDir);
    if (found.trouble) steps.push(`warn: ${found.trouble} — falling back to the kit's own ${SERVICE_LABEL}`);
    const label = found.label ?? SERVICE_LABEL;
    const foreign = label !== SERVICE_LABEL;
    const unit = path.join(path.dirname(p.unit), `${label}.plist`);
    const desired = launchdPlist({ node: nodeBin.bin, scriptDir, label });
    const plistsDir = path.dirname(p.unit);
    const serverPath = path.join(scriptDir, "server.js");

    // Every other loaded label running this server.js is a competing service.
    // Retiring them before the reload is what makes it stick: each carries
    // KeepAlive, so the port is free for exactly the moment between the bootout
    // and the new process binding it, and launchd hands it to whichever of them
    // asks first. Leaving them loaded is how a reload reports failure while the
    // router quietly comes back on someone else's definition.
    const competitors = competingLabels(found.listOut, plistsDir, serverPath).filter((l) => l !== label);
    for (const c of competitors) {
      const retire = run("launchctl", ["bootout", `${p.domain}/${c}`]);
      steps.push(
        retire.ok
          ? `retired ${c}${c === SERVICE_LABEL ? " (the kit's own)" : ""} — it was competing for the router's port`
          : `could not retire ${c}: ${retire.out || "no output"}`
      );
    }

    if (foreign) {
      steps.push(`the running service is ${label}, owned elsewhere — reloading it, not the kit's ${SERVICE_LABEL}`);
      if (fs.existsSync(unit)) {
        // The kit never rewrites another owner's definition: it reloads
        // whatever is on disk, so an edit the owner made takes effect, and
        // names the drift instead of silently overwriting it.
        const diffs = plistDiffs(fs.readFileSync(unit, "utf8"), desired);
        if (diffs.length) {
          steps.push(`${label}'s own plist differs from the kit's — ${diffs.join("; ")} — the owner's file is left untouched`);
        }
      } else {
        steps.push(`warn: ${unit} is missing while ${label} runs — the reload may fail`);
      }
    } else {
      fs.mkdirSync(plistsDir, { recursive: true });
      fs.writeFileSync(unit, desired);
      steps.push(`wrote ${unit}`);
    }

    // The reload is a bootout plus a bootstrap, never a `kickstart -k` on its
    // own: kickstart restarts with the definition launchd already loaded, so
    // an edited plist silently does not take effect and the operator sees a
    // fresh PID still running the old plane. There is no fast path for "the
    // plist is unchanged" for the same reason — unchanged on disk says nothing
    // about what launchd loaded.
    const bo = run("launchctl", ["bootout", `${p.domain}/${label}`]);
    steps.push(bo.ok ? `bootout ${label}` : `bootout ${label}: ${bo.out || "failed"} (continuing — an unloaded label bootstraps cleanly)`);
    const gone = await waitUntil(() => !isLoadedLabel(p.domain, label), { ms: 15000, every: 250 });
    if (!gone) steps.push(`warn: ${label} still registered 15s after bootout — reload may race`);
    // A previously failed bootstrap can leave the label in launchd's disabled
    // list, after which every bootstrap fails with the opaque errno 5.
    run("launchctl", ["enable", `${p.domain}/${label}`]);
    let boot = run("launchctl", ["bootstrap", p.domain, unit]);
    for (let attempt = 0; !boot.ok && attempt < 3; attempt++) {
      steps.push(`bootstrap attempt ${attempt + 1}: ${boot.out || "failed"}`);
      await sleep(1000);
      boot = run("launchctl", ["bootstrap", p.domain, unit]);
    }
    steps.push(boot.ok ? "bootstrap ok" : `bootstrap: ${boot.out || "failed"}`);
    if (!boot.ok) {
      const legacy = run("launchctl", ["load", "-w", unit]);
      steps.push(legacy.ok ? "launchctl load -w ok" : `launchctl load -w: ${legacy.out || "failed"}`);
    }
    // RunAtLoad normally starts it; this covers a bootstrap that registered
    // the job without spawning it.
    run("launchctl", ["kickstart", "-k", `${p.domain}/${label}`]);
    // The truth is the running service, not any intermediate exit code.
    let up = await waitUntil(() => labelRunning(p.domain, label), { ms: 10000 });
    let error = null;
    if (!up) {
      // A label that will not start and a squatter that took the port are
      // different problems with different fixes, and the report has to say
      // which one it is rather than leaving the operator to guess. Neither is
      // a success: the router being up is not the reload having happened.
      const now = runningRouterLabel(p.domain, scriptDir);
      if (now.pid !== null && now.label && now.label !== label) {
        steps.push(`but ${now.label} is running the router (pid ${now.pid}) — it took the port during the reload`);
        error = `${label} did not come back: ${now.label} took the port — boot it out and reload again`;
      } else {
        error = `${label} did not come back — start it by hand: node ${serverPath}`;
      }
    }
    steps.push(up ? `verified: ${label} is running` : `verified: ${label} is NOT running`);
    return { ok: up, steps, unit, label, error };
  }
  fs.mkdirSync(path.dirname(p.unit), { recursive: true });
  fs.writeFileSync(p.unit, systemdUnit({ scriptDir }));
  const r1 = run("systemctl", ["--user", "daemon-reload"]);
  const r2 = run("systemctl", ["--user", "enable", "--now", SERVICE_LABEL]);
  steps.push(`wrote ${p.unit}`, `daemon-reload ${r1.ok ? "ok" : r1.out}`, `enable --now ${r2.ok ? "ok" : r2.out}`);
  return { ok: r2.ok, steps, unit: p.unit, error: r2.ok ? null : r2.out };
}
