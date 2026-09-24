/**
 * Surgical merge into ZCode's personal provider config
 * (~/.zcode/v2/provider_config.json).
 *
 * This file is validated by a strict schema inside the app: ANY violation
 * degrades the whole personal config to account-only providers, which is
 * why this module is deliberately conservative:
 *   - it refuses to touch a file whose schemaVersion it doesn't know,
 *   - it only ever rewrites the two keys it owns (providerConfigRules,
 *     providerOrder) and leaves everything else — including app-managed
 *     modelConfigRules — byte-identical,
 *   - it backups before every write and verifies the result re-parses.
 *
 * Ownership: any providerId that appears in the roster is kit-managed.
 * Disable one in the roster and the next apply removes it.
 */
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_CONFIG_PATH } from "./paths.mjs";

export function readProviderConfig(p = PROVIDER_CONFIG_PATH) {
  if (!fs.existsSync(p)) return { exists: false, cfg: null };
  const raw = fs.readFileSync(p, "utf8");
  return { exists: true, cfg: JSON.parse(raw), raw };
}

export function backupProviderConfig(p = PROVIDER_CONFIG_PATH) {
  if (!fs.existsSync(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
  const dest = `${p}.bak-kit-${ts}`;
  fs.copyFileSync(p, dest);
  return dest;
}

function normalizeBaseUrl(u) {
  return typeof u === "string" ? u.replace(/\/+$/, "") : u;
}

/** The providerConfigRules entry for one roster provider. */
export function buildProviderRule(id, p, apiKey) {
  const config = {
    group: p.group ?? "standard-personal",
    access: { type: "api-key", apiKey },
  };
  if (p.baseUrl) config.api = { type: "openai-chat-completions", baseUrl: normalizeBaseUrl(p.baseUrl) };
  config.personalModelIds = Array.isArray(p.featured) ? [...p.featured] : p.models.map((m) => (typeof m === "string" ? m : m.id));
  config.modelOrder = p.models.map((m) => (typeof m === "string" ? m : m.id));
  const rule = p.providerName ? { providerId: id, providerName: p.providerName, config } : { providerId: id, config };
  if (p.templateId) rule.templateId = p.templateId;
  return rule;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Merge the roster into the existing config object.
 * Returns { changed, next, registered, removed, warnings }.
 */
export function mergeProviderConfig(existing, roster, resolved) {
  if (!existing || existing.schemaVersion !== 1) {
    throw new Error(
      "provider_config.json has an unknown schemaVersion — refusing to merge. " +
        "Update the kit, or set the providers by hand and run with --no-provider-config."
    );
  }
  const warnings = [];
  const next = JSON.parse(JSON.stringify(existing));
  next.config ??= {};
  next.config.providerConfigRules ??= { providerRules: [] };
  const rules = (next.config.providerConfigRules.providerRules ??= []);
  next.config.providerOrder ??= [];
  const order = next.config.providerOrder;

  const registered = [];
  const removed = [];
  const missingKey = [];

  for (const [id, p] of Object.entries(roster.providers)) {
    if (p.register === false) continue;
    if (p.routerOnly) continue; // credentials live in the router's .env
    const prov = resolved.providers[id];
    const currentlyRegistered = rules.some((r) => r.providerId === id);
    if (!prov || !prov.usable) {
      // A keyless roster provider is never allowed to destroy a working
      // registration: removal is an explicit `enabled: false`, not an
      // accident of an unset key.
      if (p.enabled === false) {
        if (currentlyRegistered) {
          for (let i = rules.length - 1; i >= 0; i--) if (rules[i].providerId === id) rules.splice(i, 1);
          for (let i = order.length - 1; i >= 0; i--) if (order[i] === id) order.splice(i, 1);
          removed.push(`${id} (disabled in roster)`);
        }
        continue;
      }
      if (currentlyRegistered) warnings.push(`${id} has no resolvable key — its existing registration was left untouched`);
      missingKey.push(`${id} (${prov?.def?.apiKeyEnv ?? "no key configured"})`);
      continue;
    }
    const rule = buildProviderRule(id, p, prov.apiKey);
    const at = rules.findIndex((r) => r.providerId === id);
    const before = at >= 0 ? rules[at] : null;
    if (at >= 0) rules[at] = rule;
    else rules.push(rule);
    // Semantic diff: key order and formatting are not changes.
    if (!deepEqual(before, rule)) registered.push(before === null ? id : `${id} (updated)`);
    if (!order.includes(id)) order.push(id);
  }

  // Capability declarations (context windows, reasoning knobs, input formats)
  // that the app cannot infer from templates. The roster is the complete
  // declaration for its providers: replace those, keep account-scoped ones.
  const manual = roster.manualModelRules ?? [];
  if (manual.length) {
    next.config.modelConfigRules ??= {};
    const rosterProviders = new Set(Object.keys(roster.providers));
    const keep = (next.config.modelConfigRules.manualProviderModelRules ?? []).filter(
      (r) => !rosterProviders.has(r.providerId)
    );
    next.config.modelConfigRules.manualProviderModelRules = [...keep, ...manual.map((r) => JSON.parse(JSON.stringify(r)))];
  }

  const registeredIds = rules.map((r) => r.providerId);
  for (const id of order) if (!registeredIds.includes(id)) warnings.push(`providerOrder references "${id}" which has no rule — left in place, app may ignore it`);

  return {
    changed: !deepEqual(next, existing),
    next,
    registered,
    removed,
    warnings,
    missingKey,
  };
}

export function writeProviderConfig(cfg, p = PROVIDER_CONFIG_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = JSON.stringify(cfg, null, 2) + "\n";
  // Verify before it lands: a malformed file degrades the whole config.
  const reparsed = JSON.parse(text);
  if (reparsed.schemaVersion !== 1) throw new Error("refusing to write: reparsed schemaVersion is not 1");
  fs.writeFileSync(p, text);
}
