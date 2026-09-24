/**
 * export: derive a roster from a live machine (provider_config.json +
 * router config.json + the workflows library). This is the "clone this
 * machine" path — run it once, commit the key-free roster, and the next
 * machine reproduces the same routing with `kit apply`.
 *
 * API keys are never exported: providers come back as apiKeyEnv references
 * and `kit env set` supplies the values per machine.
 */
import fs from "node:fs";
import path from "node:path";
import { ROSTER_VERSION, PROVIDER_CONFIG_PATH, ROUTER_DIR, WORKFLOWS_DIR } from "./paths.mjs";
import { readProviderConfig } from "./provider-merge.mjs";

function guessBilling(id, baseUrl) {
  if (/(deepseek|openai\.com|anthropic)/i.test(id + baseUrl)) return "payg";
  return "plan";
}

export function exportRoster({
  providerConfigPath = PROVIDER_CONFIG_PATH,
  routerConfigPath = path.join(ROUTER_DIR, "config.json"),
  workflowsDir = WORKFLOWS_DIR,
} = {}) {
  const pc = readProviderConfig(providerConfigPath);
  const providers = {};
  if (pc.exists) {
    for (const rule of pc.cfg.config?.providerConfigRules?.providerRules ?? []) {
      const c = rule.config ?? {};
      if (rule.providerId === "auto-router") continue; // generated, not source
      const baseUrl = c.api?.baseUrl ?? null;
      providers[rule.providerId] = {
        ...(rule.providerName ? { providerName: rule.providerName } : {}),
        ...(rule.templateId ? { templateId: rule.templateId } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        apiKeyEnv: `${rule.providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        billing: guessBilling(rule.providerId, baseUrl ?? ""),
        models: c.modelOrder ?? c.personalModelIds ?? [],
        ...(Array.isArray(c.personalModelIds) ? { featured: c.personalModelIds } : {}),
      };
    }
  }
  // Extra router-only upstreams (credentials from the router .env).
  let rc = null;
  if (fs.existsSync(routerConfigPath)) rc = JSON.parse(fs.readFileSync(routerConfigPath, "utf8"));
  for (const [id, u] of Object.entries(rc?.extraUpstreams ?? {})) {
    providers[id] = {
      providerName: id.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
      baseUrl: u.baseUrl,
      apiKeyEnv: u.apiKeyEnv,
      billing: "plan",
      routerOnly: true,
      models: [],
    };
  }
  const R = rc?.routing ?? {};
  const tiers = {};
  for (const [name, w] of Object.entries(R.workloads ?? {})) {
    tiers[name] = { target: `${w.providerId}/${w.model}`, fallbacks: [] };
  }
  const mixture = {
    proposers: (R.mixture?.proposers ?? []).map((p) => `${p.providerId}/${p.model}`),
    aggregator: R.mixture?.aggregator ? `${R.mixture.aggregator.providerId}/${R.mixture.aggregator.model}` : "",
    proposerTimeoutMs: R.mixture?.proposerTimeoutMs ?? 240000,
  };
  const manualModelRules = (pc.cfg?.config?.modelConfigRules?.manualProviderModelRules ?? []).filter((r) =>
    Object.keys(providers).includes(r.providerId)
  );
  return {
    version: ROSTER_VERSION,
    exportedFrom: { providerConfigPath, routerConfigPath, workflowsDir, at: new Date().toISOString() },
    router: { port: rc?.port ?? 8300, localToken: rc?.localToken ?? "local-auto-router" },
    typesafe: { apiKeyEnv: "TYPESAFE_API_KEY", model: rc?.typesafeModel ?? "jev-1.13.0", ttlHours: rc?.ttlHours ?? 6 },
    allowPayg: false,
    providers,
    omniModel: `${R.omniModel.providerId}/${R.omniModel.model}`,
    wideModel: `${R.wideModel.providerId}/${R.wideModel.model}`,
    tiers,
    profiles: R.profiles ?? {},
    mixture,
    routing: {
      wideChars: R.wideChars ?? 1000000,
      minConfidence: R.minConfidence ?? 0.6,
      workflowMinConfidence: R.workflowMinConfidence ?? 0.4,
      defaultWorkload: R.defaultWorkload,
    },
    workflows: {
      shapes: {},
      registry: Object.fromEntries(
        (R.workflows ?? []).map((w) => [
          w.name,
          { taskArg: w.taskArg, shape: w.shape, ...(w.defaults ? { defaults: w.defaults } : {}) },
        ])
      ),
    },
    manualModelRules,
  };
}
