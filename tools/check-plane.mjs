#!/usr/bin/env node
/**
 * The kit no longer carries a copy of the plane. Half of that arrangement is
 * the file: dependency, which makes "the kit's plane differs from the engine's"
 * structurally impossible: npm resolves it as a symlink, so the kit reads the
 * engine's own files and there is nothing to compare. That is worth asserting
 * rather than assuming, and it is check 1 below.
 *
 * The drift that can still happen — and did, three times, before this refactor
 * — is the *installed* runtime `kit apply` ships beside the router, which is
 * what the live service actually executes. It went stale silently: a pre-plane
 * six-file set serving requests while the source moved on. That is check 2, and
 * it is the reason this script exists.
 *
 *   npm run check:port
 *
 * Check 1  the kit resolves the engine's plane, and cannot drift from it
 * Check 2  the runtime installed beside the router matches the engine's modules
 * Check 3  the installed server can resolve the plane by specifier
 */
import fs from "node:fs";
import path from "node:path";

const kitDir = path.resolve(import.meta.dirname, "..");
const engineDir = process.env.AGNOSTIC_ROUTER_KIT_DIR ?? path.resolve(kitDir, "..", "agnostic-router-kit");
const routerDir = process.env.ZCODE_ROUTER_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE, ".zcode", "router");

const problems = [];
const warn = (msg) => problems.push(msg);
const note = (msg) => console.log(`  ${msg}`);

// ── check 1: the kit cannot drift from the engine ──────────────────────────
const enginePlane = path.join(engineDir, "lib", "workflow");
if (!fs.existsSync(path.join(enginePlane, "package.json"))) {
  warn(`no engine checkout at ${enginePlane} — set AGNOSTIC_ROUTER_KIT_DIR to the engine edition's root`);
} else {
  const link = path.join(kitDir, "node_modules", "workflow-plane");
  if (!fs.existsSync(link)) {
    warn("workflow-plane is not installed in the kit — run npm install");
  } else {
    const real = fs.realpathSync(link);
    if (real !== fs.realpathSync(enginePlane)) {
      warn(`the kit resolves workflow-plane to ${real}, not the engine checkout ${enginePlane}`);
    } else {
      note(`workflow-plane resolves to the engine checkout — the kit cannot drift from it`);
    }
  }
  const kitCopy = path.join(kitDir, "lib", "workflow");
  if (fs.existsSync(kitCopy)) {
    warn(`the kit carries its own lib/workflow/ — delete it, the plane is a dependency`);
  }
  note("no competing lib/workflow/ in the kit");

  // A dirty engine working tree means the kit is resolving uncommitted code.
  // Mid-extraction that is expected and this is not fatal, but a green check
  // must not be mistaken for a released package.
  try {
    const { execFileSync } = await import("node:child_process");
    const dirty = execFileSync("git", ["-C", engineDir, "status", "--porcelain", "--", "lib/workflow"], {
      encoding: "utf8",
    }).trim();
    if (dirty) {
      console.error(
        "  ! the engine's lib/workflow has uncommitted changes:\n" +
          dirty.split("\n").map((l) => `      ${l}`).join("\n")
      );
    }
  } catch {
    /* git unavailable or not a repo — nothing to assert */
  }
}

// ── check 2: the installed runtime matches the engine ──────────────────────
const installed = path.join(path.dirname(routerDir), "lib", "workflow");
if (!fs.existsSync(installed)) {
  warn(`no installed runtime at ${installed} — run kit apply`);
} else {
  const manifest = JSON.parse(fs.readFileSync(path.join(enginePlane, "package.json"), "utf8"));
  const modules = Object.values(manifest.exports ?? {}).map((e) => String(e).replace(/^\.\//, ""));
  let stale = [];
  let identical = 0;
  for (const f of modules) {
    const a = path.join(enginePlane, f);
    const b = path.join(installed, f);
    if (!fs.existsSync(b)) {
      stale.push(`${f} (missing)`);
    } else if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")) {
      stale.push(`${f} (differs)`);
    } else {
      identical++;
    }
  }
  if (stale.length) {
    warn(
      `the runtime installed beside the router is ${modules.length - identical}/${modules.length} current — ${stale.length} stale: ${stale.join(", ")}\n` +
        `      the live service executes ${installed}; run \`kit apply\` to ship the engine's plane`
    );
  } else {
    note(`the installed runtime beside the router matches all ${modules.length} modules`);
  }

  // A stray link from a previous layout is harmless, but a runtime installed
  // where the specifier cannot see it is not: that is the crash the link exists
  // to prevent.
  const link = path.join(routerDir, "node_modules", "workflow-plane");
  if (!fs.existsSync(link)) {
    warn(`no node_modules/workflow-plane in ${routerDir} — the installed server cannot resolve the plane by specifier`);
  } else {
    note(`node_modules/workflow-plane -> ${fs.readlinkSync(link)}`);
  }
}

// ── check 3: the installed server can actually resolve it ──────────────────
// The claim the whole refactor rests on: a module sitting in the installed
// router directory, with router/package.json above it, resolves the plane.
const probe = path.join(routerDir, "__check_plane_probe.mjs");
try {
  if (fs.existsSync(path.join(routerDir, "package.json")) && fs.existsSync(linkExists())) {
    fs.writeFileSync(
      probe,
      `import { normalizeEvent } from "workflow-plane/events.mjs";\n` +
        `import { buildGraph } from "workflow-plane/graph.mjs";\n` +
        `console.log(["resolved", typeof normalizeEvent, typeof buildGraph].join(" "));\n`
    );
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim();
    fs.rmSync(probe, { force: true });
    if (out === "resolved function function") {
      note("a module in the installed router resolves workflow-plane/*.mjs");
    } else {
      warn(`the installed router resolved the plane but the exports are not what was expected: ${out}`);
    }
  } else {
    note("skipped the resolution probe — no installed router or no plane link");
  }
} catch (err) {
  fs.rmSync(probe, { force: true });
  warn(`a module in the installed router cannot resolve the plane: ${String(err.message).split("\n")[0]}`);
}
function linkExists() {
  return path.join(routerDir, "node_modules", "workflow-plane");
}

// ── verdict ────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\ncheck-plane: FAIL — ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("\ncheck-plane: the kit's plane is the engine's package, and the install ships it");
