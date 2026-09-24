/**
 * zcode-router-kit — an installable, config-controlled layer around ZCode's
 * personal model routing.
 *
 * One repo owns three things:
 *   1. the local model router (an OpenAI-compatible proxy that routes each
 *      task to the right upstream model by workload),
 *   2. the provider roster — which plans exist on this machine, their keys
 *      (by env-var reference only), their models, and the workload tier
 *      table mapping router profiles onto them,
 *   3. the delegation library — the saved dynamic workflows, with the
 *      router's workflow-assignment registry generated from the library's
 *      own metadata so the two can never drift.
 *
 * `kit apply` renders everything ZCode needs from the roster:
 *   ~/.zcode/router/config.json        (the router's tier/delegation table)
 *   ~/.zcode/v2/provider_config.json   (the providers ZCode's picker shows)
 *   ~/.zcode/workflows/*.dwf.ts        (the delegation library)
 *   ~/Library/LaunchAgents/…plist      (or systemd user unit) to keep it up
 *
 * See README.md for the new-machine quickstart.
 */
export const KIT_VERSION = "1.0.0";
export const ROSTER_VERSION = 1;

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

/** The kit repo itself (…/zcode-router-kit). */
export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** ZCode's home. Override with ZCODE_HOME for testing. */
export const ZCODE_HOME = process.env.ZCODE_HOME ?? path.join(HOME, ".zcode");

/** Where the router runtime lives and runs from. */
export const ROUTER_DIR = process.env.ZCODE_ROUTER_DIR ?? path.join(ZCODE_HOME, "router");

/** ZCode's personal provider config — the app's single source of truth. */
export const PROVIDER_CONFIG_PATH =
  process.env.ZCODE_PROVIDER_CONFIG ?? path.join(ZCODE_HOME, "v2", "provider_config.json");

/** Where saved dynamic workflows are discovered. */
export const WORKFLOWS_DIR = process.env.ZCODE_WORKFLOWS_DIR ?? path.join(ZCODE_HOME, "workflows");

export const KIT_WORKFLOWS_DIR = path.join(KIT_DIR, "workflows");
export const KIT_ROUTER_DIR = path.join(KIT_DIR, "router");
export const KIT_TEMPLATES_DIR = path.join(KIT_DIR, "templates");

/** One roster per machine; never contains raw keys (env-var refs only). */
export const ROSTER_PATH = process.env.ZCODE_ROUTER_KIT_ROSTER ?? path.join(KIT_DIR, "roster.json");

export const ENV_FILE = path.join(ROUTER_DIR, ".env");
export const ROUTER_LOG = path.join(ROUTER_DIR, "logs", "router.log");

export const SERVICE_LABEL = "com.zcode.model-router";

/** Render a path the way server.js's own `expand()` understands it. */
export function tilde(p) {
  return p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p;
}

export function platform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}
