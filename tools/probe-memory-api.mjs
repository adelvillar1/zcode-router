#!/usr/bin/env node
/**
 * The memory HTTP wire's probe, ZCode edition: spawns a scratch router (its
 * own ZCODE_ROUTER_DIR, rendered by the kit's own `kit apply --only router`,
 * zero model calls) and asserts the memory routes' token/ceiling law, plus
 * the law that makes this edition's port correct:
 *
 *   C2  /api/memory is operator-only (the security fix — an app token is 403
 *       there, always); /v1/memory needs `memory` in the app's grantCeiling
 *       — refused by name without it, allowed with it; bad token 401
 *   C3  app memory writes are attributed in the router log; the store lands
 *       on the pinned MEMORY_FILE_PATH, NOT this edition's kit home — the
 *       one-store law that keeps the two editions off divergent graphs
 *
 * Kit differences from the engine's probe: apply renders to ZCODE_ROUTER_DIR
 * and reads ZCODE_ROUTER_KIT_ROSTER; @typesafe-ai/sdk is carried into the
 * scratch runtime (server.js imports it statically); there is no /api/setup
 * in this edition, so the store-pin check takes that slot.
 *
 * Usage: node tools/probe-memory-api.mjs
 * On failure the scratch home is left behind and printed for diagnosis.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8392;
const OP_TOKEN = "mem-probe-op";
const APP_NO = "app-no-memory";
const APP_NO_TOKEN = "mem-probe-app-no";
const APP_OK = "app-with-memory";
const APP_OK_TOKEN = "mem-probe-app-ok";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── scratch instance ───────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-memory-api-probe-"));
const scratchRouter = path.join(home, "router");
// The store this probe's server writes: pinned by the spawn env exactly as
// the engine's store is pinned in production — and deliberately NOT under
// this edition's kit home, which is the divergence the pin exists to stop.
const probeStore = path.join(home, "probe-pinned-store", "memory.jsonl");

// A port that already answers means a stale server is squatting it — every
// request would then test the wrong process. Refuse instead.
try {
  const alive = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  if (alive.ok) throw new Error(`something already answers on 127.0.0.1:${PORT} — kill the stale server first`);
} catch (e) {
  if (e instanceof Error && /already answers/.test(e.message)) throw e;
}

const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template);
roster.router = {
  port: PORT,
  localToken: OP_TOKEN,
  apps: [
    { name: APP_NO, token: APP_NO_TOKEN, grantCeiling: ["workspace-io"] },
    { name: APP_OK, token: APP_OK_TOKEN, grantCeiling: ["workspace-io", "memory"] },
  ],
};
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

const envNames = new Set([roster.typesafe?.apiKeyEnv].filter(Boolean));
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv) envNames.add(p.apiKeyEnv);
const judgeEnv = roster.judge?.fastino?.apiKeyEnv;
if (judgeEnv) envNames.add(judgeEnv);
fs.mkdirSync(scratchRouter, { recursive: true });
fs.writeFileSync(
  path.join(scratchRouter, ".env"),
  ["SCRATCH PROBE KEYS — dummies, never real, zero model calls in this probe.", ...[...envNames].map((n) => `${n}=dummy`)].join("\n") + "\n",
);

console.log(`scratch home: ${home}`);
// --only router: render + copy the runtime, never the service — the live
// service's launchd label (com.zcode.model-router on 8300) must never see a
// scratch home. The rendered runtime files are the success criterion.
console.log("kit apply --only router (scratch roster, kit's own pipeline)…");
const applied = spawnSync(process.execPath, [path.join(KIT_DIR, "bin", "zcode-router-kit.mjs"), "apply", "--only", "router"], {
  env: {
    ...process.env,
    ZCODE_ROUTER_DIR: scratchRouter,
    ZCODE_ROUTER_KIT_ROSTER: rosterPath,
  },
  encoding: "utf8",
});
const runtimeOk = fs.existsSync(path.join(scratchRouter, "config.json")) && fs.existsSync(path.join(scratchRouter, "server.js"));
if (!runtimeOk) {
  console.error(applied.stdout ?? "");
  console.error(applied.stderr ?? "");
  throw new Error("kit apply --only router did not render a runtime (config.json + server.js missing)");
}

// server.js imports @typesafe-ai/sdk statically; the kit's copyRuntime
// installs the plane beside the router but not this vendored dep, so carry
// it over from the first copy found.
const sdkDest = path.join(scratchRouter, "node_modules", "@typesafe-ai");
if (!fs.existsSync(sdkDest)) {
  const candidates = [
    path.join(KIT_DIR, "router", "node_modules", "@typesafe-ai"),
    path.join(KIT_DIR, "..", "agnostic-router-kit", "router", "node_modules", "@typesafe-ai"),
    path.join(os.homedir(), ".zcode", "router", "node_modules", "@typesafe-ai"),
  ];
  const src = candidates.find((p) => fs.existsSync(path.join(p, "sdk")));
  if (!src) throw new Error("no @typesafe-ai/sdk found to provision the scratch runtime — install it in the kit's router dir (npm install --omit=dev)");
  fs.mkdirSync(path.dirname(sdkDest), { recursive: true });
  fs.cpSync(src, sdkDest, { recursive: true });
  console.log(`provisioned @typesafe-ai/sdk from ${src}`);
}

const server = spawn(process.execPath, [path.join(scratchRouter, "server.js")], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home, MEMORY_FILE_PATH: probeStore },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => {
  serverErr += String(d);
});

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 500)}` : ""}`);

  console.log("\nA — the ceiling law on /v1/memory");
  const noWrite = await call("POST", "/v1/memory", { token: APP_NO_TOKEN, body: { entity: "should not land", observation: "x" } });
  ok("app without the memory capability refused by name", noWrite.status === 403 && new RegExp(`memory is not in ${APP_NO}'s ceiling`).test(noWrite.json?.error ?? ""), noWrite.json?.error);
  const noRead = await call("GET", "/v1/memory?q=anything", { token: APP_NO_TOKEN });
  ok("read is gated by the same capability", noRead.status === 403);

  const okWrite = await call("POST", "/v1/memory", { token: APP_OK_TOKEN, body: { entity: "memory probe fact", observation: "written by the app with the memory capability" } });
  ok("app with the capability writes", okWrite.status === 200 && okWrite.json?.ok === true, okWrite.json?.error);
  const okRead = await call("GET", "/v1/memory?q=MEMORY PROBE", { token: APP_OK_TOKEN });
  ok("app reads back by case-insensitive search", (okRead.json?.entities ?? []).length === 1, JSON.stringify(okRead.json).slice(0, 120));
  ok("write attributed to the app", okRead.json?.entities?.[0]?.entityType === `app:${APP_OK}`, okRead.json?.entities?.[0]?.entityType);

  console.log("\nB — the operator scope on /api/memory");
  const opSearch = await call("GET", "/api/memory?q=memory%20probe", { token: OP_TOKEN });
  ok("operator searches the same store", (opSearch.json?.entities ?? []).length === 1);
  const opStats = await call("GET", "/api/memory", { token: OP_TOKEN });
  ok("operator stats", opStats.json?.stats?.entities === 1);
  const opWrite = await call("POST", "/api/memory", { token: OP_TOKEN, body: { entities: [{ name: "operator fact", entityType: "memory", observations: ["via /api"] }] } });
  ok("operator write", opWrite.status === 200 && opWrite.json?.ok === true);
  const appOnApi = await call("GET", "/api/memory", { token: APP_OK_TOKEN });
  ok("app token gets 403 on the operator surface", appOnApi.status === 403, String(appOnApi.status));
  const appOnState = await call("GET", "/api/state", { token: APP_OK_TOKEN });
  ok("app token gets 403 on the whole /api block (the fix)", appOnState.status === 403, String(appOnState.status));
  const unauth = await call("GET", "/v1/memory", { token: "wrong" });
  ok("bad token 401", unauth.status === 401);

  console.log("\nC — the store pin, attribution, and this edition's one-store law");
  ok("store landed on the pinned path", fs.existsSync(probeStore), probeStore);
  const kitHomeStore = path.join(home, "memory", "memory.jsonl");
  ok("NOT on this edition's kit home (the divergence the pin stops)", !fs.existsSync(kitHomeStore), kitHomeStore);
  const logPath = path.join(scratchRouter, "logs", "router.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  ok("router log attributes the app write", log.includes("memory-write") && log.includes(APP_OK));
  ok("router log records the refusal", log.includes("memory-refused") && log.includes(APP_NO));

  // The pin defaults to the engine edition's store when nothing overrides it
  // — proven by the CLI probe (tools/probe-memory.mjs, section J) and here
  // by the server honoring an override: with MEMORY_FILE_PATH set to nothing
  // the same server would write the canonical store, so the probe pins one.

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  if (!failures.length && !process.env.KEEP_SCRATCH) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log("scratch home cleaned up");
  } else {
    console.log(`scratch home: ${home}`);
  }
  process.exit(failures.length || process.exitCode ? 1 : 0);
}
