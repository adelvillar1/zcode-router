#!/usr/bin/env node
/**
 * The service reload's two halves, held without launchd.
 *
 * `kit apply` reloads the router's service. Two things had to be true for that
 * reload to mean anything, and neither was:
 *
 *   1. it must reload the service launchd is ACTUALLY running the router with.
 *      The kit assumed its own `SERVICE_LABEL`, so on a machine where another
 *      tool installed the service — the ZCode app does — it booted out and
 *      bootstrapped a label that was not running, left the live router on the
 *      old plane, and reported "service did not start" beside a healthy router.
 *   2. it must reload with a bootout + bootstrap. `kickstart -k` restarts with
 *      the definition launchd already loaded, so an edited plist silently does
 *      not take effect and the operator sees a fresh PID running the old plane.
 *
 * This suite pins the discovery, which is where the logic lives: the join of
 * `launchctl list` (PID → label) against `ps` (PID → command line) on the
 * router's own server.js path, plus the set of other loaded labels that run the
 * same server.js and must be retired before the reload can hold the port. The
 * reload itself is launchd's, and it is proven by running the real `kit apply`
 * on this machine.
 *
 * The parsing is exercised against real-shaped output, including the shapes
 * that break the naive version: an idle label carrying a dash for its PID, a
 * label that is a prefix of another, and a router process launchd does not own.
 *
 *   node tools/unit-service-reload.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseLaunchctlList,
  parseLaunchctlLabels,
  parseRunningOwner,
  findRunningRouterLabel,
  plistRunsServer,
  competingLabels,
  plistDiffs,
  launchdPlist,
} from "../lib/service.mjs";

const SERVER = "/Users/operator/.zcode/router/server.js";

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}\n       ${String(e?.message ?? e).split("\n").join("\n       ")}`);
  }
}

// The real shapes, taken from this machine: three labels all point at the same
// server.js, and only one of them is running.
const LIST = [
  "-\t0\tcom.zcode.model-router",
  "3356\t0\tcom.alejandrodelvillar.zcode-model-router",
  "-\t0\tcom.agnostic-router.model-router",
  "812\t0\tcom.apple.FollowUpUI",
].join("\n");

const PS = [
  "812 /System/Library/PrivateFrameworks/FollowUp.framework/FollowUpAgent",
  `3356 /Users/operator/.local/bin/node ${SERVER}`,
  "901 /usr/sbin/syslogd",
].join("\n");

await check("the join names the label launchd is running the router with", () => {
  const found = findRunningRouterLabel({ listOut: LIST, psOut: PS, serverPath: SERVER });
  assert.equal(found.label, "com.alejandrodelvillar.zcode-model-router");
  assert.equal(found.pid, 3356);
});

await check("an idle label's dash PID is not a process", () => {
  const byPid = parseLaunchctlList(LIST);
  assert.equal(byPid.has(0), false, "a dash became PID 0 — the idle labels would shadow the running one");
  assert.equal(byPid.get(3356), "com.alejandrodelvillar.zcode-model-router");
  assert.equal(byPid.get(812), "com.apple.FollowUpUI");
});

await check("a label that is a prefix of another does not match it", () => {
  // `com.zcode.model-router` is a prefix of nothing here, but
  // `com.zcode.model-router-extra` would contain it — a substring match would
  // reload the wrong job.
  const rows = "-\t0\tcom.zcode.model-router\n3356\t0\tcom.zcode.model-router-extra\n".split("\n");
  const byPid = new Map();
  for (const line of rows) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3) byPid.set(Number(cols[0]), cols.slice(2).join(" "));
  }
  assert.equal(byPid.get(0), undefined, "PID 0 must never be registered");
  assert.equal(byPid.get(3356), "com.zcode.model-router-extra");
});

await check("a router process launchd does not own yields no label", () => {
  // The operator ran the server by hand. There is no service to reload, and
  // the kit must fall back to its own label rather than claim a foreign one.
  const found = findRunningRouterLabel({
    listOut: "-\t0\tcom.zcode.model-router\n",
    psOut: `4242 /Users/operator/.local/bin/node ${SERVER}`,
    serverPath: SERVER,
  });
  assert.equal(found.label, null);
  assert.equal(found.pid, 4242, "the process was found; only its owner was not");
});

await check("no router process at all yields no label", () => {
  const found = findRunningRouterLabel({ listOut: LIST, psOut: "901 /usr/sbin/syslogd", serverPath: SERVER });
  assert.equal(found.pid, null);
  assert.equal(found.label, null);
});

await check("the owner is the PID's own command line, not a shared node binary", () => {
  // A different node process must not be mistaken for the router.
  const pid = parseRunningOwner(`4242 /Users/operator/.local/bin/node /some/other/server.js`, SERVER);
  assert.equal(pid, null);
});

await check("a PID whose command mentions the path only as an argument still counts", () => {
  // `tail -f <server.js>` is not the router, but a wrapper that execs it is —
  // the command text is the join, and this is the shape that must not be
  // filtered out by a "the command must equal node + path" rule.
  const pid = parseRunningOwner(`77 /usr/bin/env node ${SERVER} --port 8300`, SERVER);
  assert.equal(pid, 77);
});

// ── the competing services ─────────────────────────────────────────────────
// Three labels on this machine all run the same server.js and all carry
// KeepAlive. Reloading one while the others stay loaded hands the router's port
// to whichever of them launchd spawns next — which is how a reload reports
// failure beside a perfectly healthy router. The competitor set is read from
// each label's own plist, so a squatter cannot hide behind a name the kit would
// not think to guess.

const AGENTS = "/Users/operator/Library/LaunchAgents";

function plistFor(label, server) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/operator/.local/bin/node</string>
        <string>${server}</string>
    </array>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kit-agents-"));
function plant(labels) {
  const dir = fs.mkdtempSync(path.join(scratch, "a-"));
  for (const [label, server] of Object.entries(labels)) {
    fs.writeFileSync(path.join(dir, `${label}.plist`), plistFor(label, server));
  }
  return dir;
}

await check("every loaded label running this router's server.js is a competitor", () => {
  const dir = plant({
    "com.zcode.model-router": SERVER,
    "com.alejandrodelvillar.zcode-model-router": SERVER,
    "com.agnostic-router.model-router": SERVER,
  });
  assert.deepEqual(competingLabels(LIST, dir, SERVER), [
    "com.zcode.model-router",
    "com.alejandrodelvillar.zcode-model-router",
    "com.agnostic-router.model-router",
  ], "a squatter left out of the set is a port fight the reload cannot win");
});

await check("a label running a different server.js is not a competitor", () => {
  const dir = plant({
    "com.zcode.model-router": SERVER,
    "com.someone.other-router": "/Users/operator/.zcode/other/server.js",
  });
  assert.deepEqual(competingLabels(LIST, dir, SERVER), ["com.zcode.model-router"]);
});

await check("a label with no plist on disk is not a competitor", () => {
  // An uninstalled label cannot be running anything; reading a plist that is
  // not there must be a skip, never a throw.
  const dir = plant({ "com.zcode.model-router": SERVER });
  assert.deepEqual(competingLabels("-\t0\tcom.ghost.label\n3356\t0\tcom.zcode.model-router\n", dir, SERVER), [
    "com.zcode.model-router",
  ]);
});

await check("the plist match is the exact path, not a substring of one", () => {
  const dir = plant({
    "com.zcode.model-router": SERVER,
    "com.zcode.model-router-old": `${SERVER}.old`,
  });
  assert.deepEqual(competingLabels(LIST, dir, SERVER), ["com.zcode.model-router"]);
});

await check("plistRunsServer reads the arguments, not every string in the file", () => {
  // A path that appears only in a log path must not make an unrelated job look
  // like the router — that would retire a service running something else.
  const decoy = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.someone.else</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/node</string>
        <string>/opt/other/server.js</string>
    </array>
    <key>StandardErrorPath</key>
    <string>${SERVER}.err</string>
</dict>
</plist>
`;
  assert.equal(plistRunsServer(decoy, SERVER), false);
  assert.equal(plistRunsServer(plistFor("com.zcode.model-router", SERVER), SERVER), true);
});

const NODE = "/Users/operator/.local/bin/node";
const ROUTER = "/Users/operator/.zcode/router";

await check("plistDiffs names the keys that actually differ", () => {
  // This machine's real case: the app's plist is the kit's definition minus the
  // WorkingDirectory key. Reporting "PATH, node, or scriptDir" for that is a
  // guess dressed as a finding, and it sends the operator looking in the wrong
  // place for the difference the report just claimed to have seen.
  const desired = launchdPlist({ node: NODE, scriptDir: ROUTER, label: "com.alejandrodelvillar.zcode-model-router" });
  const owner = desired.replace(/    <key>WorkingDirectory<\/key>\n    <string>[^<]*<\/string>\n/, "");
  assert.notEqual(owner, desired, "the fixture must actually differ");
  const diff = plistDiffs(owner, desired);
  assert.equal(diff.length, 1, `expected exactly one named difference, got: ${diff.join(" | ")}`);
  assert.match(diff[0], /WorkingDirectory/);
});

await check("an identical definition reports no drift", () => {
  const desired = launchdPlist({ node: NODE, scriptDir: ROUTER });
  assert.deepEqual(plistDiffs(desired, desired), []);
});

await check("a differing node is named as the value that differs", () => {
  const owner = launchdPlist({ node: "/usr/bin/node", scriptDir: ROUTER });
  const desired = launchdPlist({ node: NODE, scriptDir: ROUTER });
  const diff = plistDiffs(owner, desired);
  assert.ok(diff.some((d) => d.includes("/usr/bin/node")), `the owner's node must be named: ${diff.join(" | ")}`);
  assert.ok(diff.some((d) => d.includes(NODE)), `and so must the kit's: ${diff.join(" | ")}`);
});

await check("parseLaunchctlLabels lists every label, running or idle", () => {
  assert.deepEqual(parseLaunchctlLabels(LIST), [
    "com.zcode.model-router",
    "com.alejandrodelvillar.zcode-model-router",
    "com.agnostic-router.model-router",
    "com.apple.FollowUpUI",
  ]);
  assert.deepEqual(parseLaunchctlLabels(""), []);
});

await check("discovery is by process, never by what the label is named", () => {
  // A label-name filter is the tempting shortcut and the one that breaks: a
  // service installed under any other name would be invisible to it, and the
  // kit would reload its own competing label instead. Nothing here says
  // "router" — the join is the PID's command line.
  const found = findRunningRouterLabel({
    listOut: "-\t0\tcom.zcode.model-router\n4242\t0\tcom.acme.some-daemon\n",
    psOut: `4242 /Users/operator/.local/bin/node ${SERVER}`,
    serverPath: SERVER,
  });
  assert.equal(found.label, "com.acme.some-daemon");
  assert.equal(found.pid, 4242);
});

await check("the plist renders the label it is handed", () => {
  // The foreign case reloads the owner's own file, so the comparison against
  // the kit's desired definition must render THAT label, not the kit's.
  const foreign = launchdPlist({ node: "/n", scriptDir: "/r", label: "com.alejandrodelvillar.zcode-model-router" });
  assert.match(foreign, /<string>com\.alejandrodelvillar\.zcode-model-router<\/string>/);
  assert.equal(foreign.includes("com.zcode.model-router<"), false, "the kit's own label leaked into a foreign plist");
  const own = launchdPlist({ node: "/n", scriptDir: "/r" });
  assert.match(own, /<string>com\.zcode\.model-router<\/string>/);
});

await check("the plist's PATH leads with the user's own bin", () => {
  // Without this, a spawned run cannot resolve `dev-decisions` and every media
  // call is refused with the absence sentence.
  const own = launchdPlist({ node: "/n", scriptDir: "/r" });
  assert.match(own, new RegExp(`<string>${path.join(process.env.HOME, ".local", "bin")}:/opt/homebrew/bin`));
});

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\nunit-service-reload: ${pass} cases pass, ${failures.length} fail`);
process.exit(failures.length ? 1 : 0);
