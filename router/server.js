#!/usr/bin/env node
/**
 * zcode-model-router — a local OpenAI-compatible proxy that routes each task
 * to the right upstream model, registered in ZCode as the "auto-router"
 * provider so the model picker gains a single "auto" model.
 *
 * Routing (see README.md):
 *   1. Capability rules, evaluated per request — any image/video/audio part
 *      or a very large payload goes to the omnimodal 1M-context flagship.
 *   2. Everything else: `auto` runs one TypeSafe Jev judgment per task (keyed
 *      on system prompt + latest user instruction, cached for ttlHours) that
 *      picks a workload — quick / standard_code / hard / prose /
 *      deep_context — each mapped to a model. Named model ids (quick, code,
 *      hard, prose, long-context, vision) pin their workload with no
 *      judgment. Low confidence, missing key, or any judge error degrades to
 *      defaultWorkload — a TypeSafe outage never fails a request (same
 *      contract as the commissiontracker integration).
 *
 * Upstreams (baseUrl + key) are read live from ZCode's own
 * provider_config.json — that file stays the single source of truth for
 * provider credentials. All routed models are on prepaid plans.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const R = config.routing;

const LOG_DIR = path.join(__dirname, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "router.log");
function log(obj) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

// ── upstream registry: ZCode's provider_config.json is the single source ────
// for standard providers; config.extraUpstreams adds targets whose
// credentials live elsewhere (e.g. the Z.AI coding-plan API key in .env).
let upCache = null;
let upMtime = 0;
function upstream(providerId) {
  const extra = config.extraUpstreams?.[providerId];
  if (extra) {
    const apiKey = envFile()[extra.apiKeyEnv];
    return apiKey ? { baseUrl: extra.baseUrl.replace(/\/+$/, ""), apiKey } : null;
  }
  try {
    const pcPath = expand(config.providerConfigPath);
    const mtime = fs.statSync(pcPath).mtimeMs;
    if (!upCache || mtime !== upMtime) {
      const raw = JSON.parse(fs.readFileSync(pcPath, "utf8"));
      const map = {};
      for (const rule of raw.config?.providerConfigRules?.providerRules ?? []) {
        const c = rule.config ?? {};
        if (c.api?.baseUrl && c.access?.apiKey) {
          map[rule.providerId] = {
            baseUrl: c.api.baseUrl.replace(/\/+$/, ""),
            apiKey: c.access.apiKey,
          };
        }
      }
      upCache = map;
      upMtime = mtime;
    }
    return upCache[providerId] ?? null;
  } catch {
    return upCache?.[providerId] ?? null;
  }
}

// ── local .env reader (cached until the file changes) ────────────────────────
let envCache = null;
let envMtime = 0;
function envFile() {
  try {
    const p = expand(config.typesafeEnvFile);
    const mtime = fs.statSync(p).mtimeMs;
    if (!envCache || mtime !== envMtime) {
      envCache = {};
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) envCache[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      envMtime = mtime;
    }
    return envCache;
  } catch {
    return envCache ?? {};
  }
}

// ── TypeSafe judge ───────────────────────────────────────────────────────────
let tsClient = null;
function typesafeKey() {
  return envFile().TYPESAFE_API_KEY || null;
}

async function judgeWorkload(signals) {
  const key = typesafeKey();
  if (!key) return { workload: null, conf: null, reason: "judge:no-key" };
  try {
    tsClient ??= new TypeSafeClient({
      apiKey: key,
      timeout: 4000,
      retry: { maxRetries: 0 },
      logLevel: "warn",
    });
    const state = {
      latest_instruction: signals.lastUser,
      message_count: signals.messages.length,
      approx_input_tokens: Math.round(signals.chars / 4),
      images_attached: signals.images,
      tool_definitions: signals.toolDefs,
    };
    const questions = {
      workload: choice(
        "A coding-agent request is described in state; latest_instruction is the user's current request. Which workload best describes what completing this request well requires?",
        {
          quick: "Small self-contained work: quick answers, tiny edits, formatting, or simple extraction from short text",
          standard_code: "Routine software work: writing or modifying features, normal debugging, running tools",
          hard: "Hard engineering: architecture and design, intricate multi-step reasoning, large refactors, subtle bugs",
          prose: "Writing and synthesis: documentation, prose, summaries, explanations, reports",
          deep_context: "Broad analysis of large material: connecting many files or working through very long documents",
        }
      ),
      execution: choice(
        "State describes one coding-agent request (see latest_instruction). Which execution style best fits completing this request well?",
        {
          single: "One focused model call or one worker suffices — the request is one coherent piece of work",
          mixture: "One hard question where several independent answers compared by a judge would beat one answer — but it does not decompose into separate parts",
          swarm: "The request decomposes into multiple substantial independent parts and/or quality depends on critique rounds — parallel multi-agent workers with review would beat any single answer",
        }
      ),
      workflow: (() => {
        const options = {};
        for (const wf of R.workflows ?? []) options[wf.name] = wf.shape;
        options.none = "One focused call or worker is enough, or no listed workflow fits";
        return choice(
          "State describes one request (see latest_instruction). Some requests name stages in order (first find the cause, then review the fix). Which saved workflow should run FIRST on this request? Choose \"none\" when one focused call or worker is enough or nothing fits.",
          options
        );
      })(),
      followUp: (() => {
        const options = {};
        for (const wf of R.workflows ?? []) options[wf.name] = wf.shape;
        options.none = "The request is complete after one workflow, or needs no workflow at all";
        return choice(
          "State describes one request (see latest_instruction). Some requests complete only after TWO workflows run in order (first one runs, then the second). Which SECOND workflow must run after the first one to complete this request? Choose \"none\" when one workflow completes the request.",
          options
        );
      })(),
    };
    const result = await tsClient.systemOne(
      { state, questions, model: config.typesafeModel ?? "jev-1.13.0" },
      { timeout: 4000 }
    );
    const answer = result?.answers?.workload;
    const workload = answer?.choice;
    const conf = (workload && answer?.probabilities?.[workload]) ?? 0;
    const execAns = result?.answers?.execution;
    const execution = ["single", "mixture", "swarm"].includes(execAns?.choice) ? execAns.choice : null;
    const execConf = (execution && execAns?.probabilities?.[execution]) ?? 0;
    const wfAns = result?.answers?.workflow;
    const wfPick = wfAns?.choice;
    const wfConf = (wfPick && wfAns?.probabilities?.[wfPick]) ?? 0;
    const workflow =
      wfPick && wfPick !== "none" && (R.workflows ?? []).some((w) => w.name === wfPick) && wfConf >= (R.workflowMinConfidence ?? 0.4)
        ? wfPick
        : null;
    const fuAns = result?.answers?.followUp;
    const fuPick = fuAns?.choice;
    const fuConf = (fuPick && fuAns?.probabilities?.[fuPick]) ?? 0;
    const followUp =
      fuPick && fuPick !== "none" && fuPick !== wfPick && (R.workflows ?? []).some((w) => w.name === fuPick) && fuConf >= (R.workflowMinConfidence ?? 0.4)
        ? fuPick
        : null;
    // Each question is gated over its own option space: a 5-way workload
    // pick and a 12-way workflow pick have different chance baselines, and a
    // weak pick in one must not wipe a strong pick in the other.
    const workloadOk = workload && workload in R.workloads && conf >= R.minConfidence;
    return {
      workload: workloadOk ? workload : null,
      execution: execConf >= R.minConfidence ? execution : null,
      workflow,
      followUp,
      conf,
      execConf,
      wfConf,
      reason: workloadOk || workflow ? "judge" : "judge:low-confidence",
    };
  } catch (err) {
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:error:" + String(err?.message ?? err).slice(0, 80) };
  }
}

// ── routing decision ─────────────────────────────────────────────────────────
const workloadCache = new Map(); // sessionKey -> { workload, at, conf }
const TTL_MS = (config.ttlHours ?? 6) * 3600_000;

function analyze(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let chars = 0;
  let images = 0;
  let otherParts = 0;
  let toolDefs = Array.isArray(body.tools) ? body.tools.length : 0;
  let lastUser = "";
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role === "user") lastUser = m.content;
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "text") {
          if (m.role === "user") lastUser = part.text ?? "";
          chars += (part.text ?? "").length;
        } else if (part?.type === "image_url") {
          images++;
        } else if (part?.type) {
          otherParts++;
        }
      }
    }
  }
  const sys = messages.find((m) => m.role === "system");
  const sysHead = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  const sessionKey = crypto
    .createHash("sha256")
    .update(sysHead.slice(0, 1500))
    .update(" ")
    .update(lastUser.slice(0, 300))
    .digest("hex")
    .slice(0, 12);
  return {
    messages,
    chars,
    images,
    otherParts,
    toolDefs,
    hasToolMessages: messages.some((m) => m.role === "tool" || m.role === "function"),
    lastUser,
    sessionKey,
    stream: body.stream === true,
    requestedModel: typeof body.model === "string" ? body.model : "auto",
  };
}

function resolveProfile(profile) {
  if (profile?.use === "omniModel") return R.omniModel;
  if (profile?.use === "wideModel") return R.wideModel;
  return R.workloads?.[profile?.workload] ?? null;
}

// MoA needs a pure completion: parallel proposals can't be merged when the
// turn is choosing tool calls mid-loop. Tool-carrying requests fall back to
// the single strong model.
function mixtureTarget(signals, baseReason, execution = "mixture", workload = "mixture") {
  if (signals.toolDefs > 0 || signals.hasToolMessages) {
    return {
      ...R.workloads.hard,
      workload: "hard",
      execution: "single",
      conf: null,
      reason: `${baseReason}+mixture-skipped-tools`,
    };
  }
  return { kind: "mixture", workload, execution, conf: null, reason: baseReason };
}

async function decide(signals) {
  // Capability rules always win — a text-only target can't take an image, and
  // only the 1M-context models can swallow a wide payload. They also beat a
  // pinned profile for the same reason (the log shows the override).
  if (signals.images + signals.otherParts > 0) {
    return { ...R.omniModel, workload: "omni", conf: null, reason: "capability:multimodal" };
  }
  if (signals.chars > R.wideChars) {
    return { ...R.wideModel, workload: "wide", conf: null, reason: "capability:wide-context" };
  }
  // Explicit picker profile pins the workload — no judgment.
  const profile = R.profiles?.[signals.requestedModel];
  if (profile) {
    if (profile.use === "mixture") {
      return mixtureTarget(signals, "profile:mixture", "mixture");
    }
    const target = resolveProfile(profile);
    if (target) {
      return { ...target, workload: profile.workload ?? profile.use, execution: "single", conf: null, reason: `profile:${signals.requestedModel}` };
    }
  }
  // auto: one judgment per task (cached on system prompt + latest user message,
  // so an agentic tool loop keeps its model until the next user instruction).
  // The judge picks BOTH the workload and the execution style (single /
  // mixture / swarm) — topology is a routing decision.
  const hit = workloadCache.get(signals.sessionKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    const cachedWorkflow = hit.workflow ?? null;
    const cachedFollowUp = hit.followUp ?? null;
    if (hit.execution === "mixture" || hit.execution === "swarm") {
      return { ...mixtureTarget(signals, "cache", hit.execution, hit.workload), workflow: cachedWorkflow, followUp: cachedFollowUp, conf: hit.conf, wfConf: hit.wfConf ?? null };
    }
    return { ...R.workloads[hit.workload], workload: hit.workload, execution: "single", workflow: cachedWorkflow, followUp: cachedFollowUp, conf: hit.conf, wfConf: hit.wfConf ?? null, reason: "cache" };
  }
  const judged = await judgeWorkload(signals);
  const workload = judged.workload ?? R.defaultWorkload;
  workloadCache.set(signals.sessionKey, {
    workload,
    execution: judged.execution,
    workflow: judged.workflow,
    followUp: judged.followUp,
    at: Date.now(),
    conf: judged.conf,
    execConf: judged.execConf,
    wfConf: judged.wfConf,
  });
  if (workloadCache.size > 400) workloadCache.delete(workloadCache.keys().next().value);
  const judgedWorkflow = judged.workflow ?? null;
  const judgedFollowUp = judged.followUp ?? null;
  if (judged.execution === "mixture" || judged.execution === "swarm") {
    return { ...mixtureTarget(signals, judged.reason, judged.execution, workload), workflow: judgedWorkflow, followUp: judgedFollowUp, conf: judged.conf, wfConf: judged.wfConf ?? null };
  }
  return { ...R.workloads[workload], workload, execution: "single", workflow: judgedWorkflow, followUp: judgedFollowUp, conf: judged.conf, wfConf: judged.wfConf ?? null, reason: judged.reason };
}

// ── Mixture of Agents ────────────────────────────────────────────────────────
// Parallel proposers (different plan pools + model families), one TypeSafe
// judgment to pick the best answer AND decide whether merging adds value, and
// an aggregator only when the judge says integration is warranted.

async function chatNonStream(target, body, timeoutMs) {
  const up = upstream(target.providerId);
  if (!up) return null;
  try {
    // No invented limits: the client's max_tokens passes through verbatim, or
    // is left unset so the upstream model uses its own output default (these
    // models run 1M input contexts and 128K+ outputs).
    const u = await fetch(`${up.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
      body: rewriteBody({ ...body, stream: false }, target.model),
      signal: AbortSignal.timeout(timeoutMs ?? R.mixture?.proposerTimeoutMs ?? 120000),
    });
    if (!u.ok) {
      const detail = await u.text().catch(() => "");
      log({
        event: "mixture-proposer",
        provider: target.providerId,
        model: target.model,
        status: u.status,
        detail: detail.slice(0, 300),
      });
      return null;
    }
    const d = await u.json();
    const text = d.choices?.[0]?.message?.content;
    return typeof text === "string" && text.length > 0
      ? { text, usage: d.usage ?? null, model: target.model }
      : null;
  } catch (err) {
    log({
      event: "mixture-proposer",
      provider: target.providerId,
      model: target.model,
      error: String(err?.message ?? err).slice(0, 200),
    });
    return null;
  }
}

async function judgeProposals(labeled, signals) {
  const key = typesafeKey();
  if (!key || labeled.length < 2) {
    return { best: labeled[0]?.label ?? "1", conf: null, worthMerging: false, reason: "judge:skipped" };
  }
  try {
    tsClient ??= new TypeSafeClient({ apiKey: key, timeout: 6000, retry: { maxRetries: 0 }, logLevel: "warn" });
    const criteria = {};
    for (const l of labeled) criteria[l.label] = "candidate answer";
    const state = {
      request: signals.lastUser,
      answers: labeled.map((l) => ({ key: l.label, text: l.text })),
    };
    const questions = {
      best_answer: choice(
        "State contains a request plus several assistants' answers to it, keyed \"1\", \"2\", … matching the options below. Which answer is best overall — most correct, complete, and directly responsive to the request?",
        criteria
      ),
      worth_merging: noul(
        "State contains a request plus several assistants' answers to it. Do the answers contain distinct correct or valuable elements such that merging them would produce a better answer than the single best answer alone?",
        {
          true: "The answers are complementary — merging adds real value",
          false: "One answer is clearly best on its own — merging adds nothing",
        }
      ),
    };
    const result = await tsClient.systemOne(
      { state, questions, model: config.typesafeModel ?? "jev-1.13.0" },
      { timeout: 6000 }
    );
    const bestAns = result?.answers?.best_answer;
    const mergeAns = result?.answers?.worth_merging;
    const best = labeled.some((l) => l.label === bestAns?.choice) ? bestAns.choice : labeled[0].label;
    const conf = bestAns?.probabilities?.[best] ?? null;
    const worthMerging = mergeAns?.choice === true;
    return { best, conf, worthMerging, reason: "judge" };
  } catch {
    return { best: labeled[0].label, conf: null, worthMerging: false, reason: "judge:error" };
  }
}

async function aggregate(labeled, signals, body) {
  const agg = R.mixture?.aggregator;
  if (!agg) return null;
  const merged = await chatNonStream(agg, {
    model: agg.model,
    temperature: body.temperature,
    messages: [
      {
        role: "system",
        content:
          "You are an answer integrator. You receive a request and several answers to it. Produce ONE final answer that combines the strongest, most correct elements of the answers — resolving contradictions in favor of what is correct, dropping errors and filler. Return only the final answer in the style the request calls for.",
      },
      {
        role: "user",
        content:
          `REQUEST:\n${signals.lastUser}\n\n` +
          labeled.map((l) => `ANSWER ${l.label}:\n${l.text}`).join("\n\n"),
      },
    ],
  }, (R.mixture?.proposerTimeoutMs ?? 120000));
  return merged;
}

async function handleMixture(res, body, signals, execution = "mixture") {
  const t0 = Date.now();
  const mix = R.mixture ?? {};
  const results = await Promise.all(
    (mix.proposers ?? []).map((p) => chatNonStream(p, body, mix.proposerTimeoutMs))
  );
  const labeled = results.filter(Boolean).map((g, i) => ({ label: String(i + 1), ...g }));
  if (labeled.length === 0) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mixture: all proposers failed" } }));
    log({ event: "mixture", error: "all-proposers-failed", sessionKey: signals.sessionKey, requested: signals.requestedModel });
    return;
  }
  const verdict = await judgeProposals(labeled, signals);
  const winner = labeled.find((l) => l.label === verdict.best) ?? labeled[0];
  let finalText = winner.text;
  let finalModel = winner.model;
  let merged = false;
  if (verdict.worthMerging && labeled.length > 1) {
    const agg = await aggregate(labeled, signals, body);
    if (agg) {
      finalText = agg.text;
      finalModel = agg.model;
      merged = true;
    }
  }
  log({
    event: "mixture",
    sessionKey: signals.sessionKey,
    requested: signals.requestedModel,
    execution,
    proposers: labeled.map((l) => `${l.label}:${l.model}`),
    best: verdict.best,
    conf: verdict.conf,
    worthMerging: verdict.worthMerging,
    merged,
    finalModel,
    judgeReason: verdict.reason,
    status: 200,
    ms: Date.now() - t0,
  });

  const usage = {
    prompt_tokens: labeled.reduce((s, l) => s + (l.usage?.prompt_tokens ?? 0), 0),
    completion_tokens: labeled.reduce((s, l) => s + (l.usage?.completion_tokens ?? 0), 0),
    total_tokens: 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (signals.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-router-execution": execution,
      "x-router-workload": "mixture",
    });
    const id = "mixcmpl-" + crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: "chat.completion.chunk", created, model: "mixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    for (let i = 0; i < finalText.length; i += 120) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: finalText.slice(i, i + 120) }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-router-execution": execution,
      "x-router-workload": "mixture",
    });
    res.end(JSON.stringify({
      id: "mixcmpl-" + crypto.randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mixture",
      choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
      usage,
    }));
  }
}

// ── forwarding ───────────────────────────────────────────────────────────────
function rewriteBody(body, model) {
  const next = { ...body, model };
  // "auto" carries no reasoning spec in ZCode; drop reasoning params some
  // clients attach so conservative upstreams don't 400 on unknown fields.
  delete next.reasoning_effort;
  delete next.thinking;
  delete next.enable_thinking;
  return JSON.stringify(next);
}

async function forward(res, body, signals) {
  const t0 = Date.now();
  const target = await decide(signals);
  if (target.kind === "mixture") {
    await handleMixture(res, body, signals, target.execution ?? "mixture");
    return;
  }
  const up = upstream(target.providerId);
  const routerHeaders = {
    "x-router-execution": target.execution ?? "single",
    "x-router-workload": target.workload ?? "unknown",
    "x-router-workflow": target.workflow ?? "none",
  };
  if (!up) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `router: unknown upstream provider ${target.providerId}` } }));
    log({ event: "route", error: "unknown-upstream", provider: target.providerId, model: target.model, workload: target.workload });
    return;
  }
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const u = await fetch(`${up.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
      body: rewriteBody(body, target.model),
      signal: ac.signal,
    });
    log({
      event: "route",
      sessionKey: signals.sessionKey,
      requested: signals.requestedModel,
      workload: target.workload,
      provider: target.providerId,
      model: target.model,
      reason: target.reason,
      conf: target.conf,
      chars: signals.chars,
      images: signals.images,
      tools: signals.toolDefs,
      stream: signals.stream,
      status: u.status,
      ms: Date.now() - t0,
    });
    if (signals.stream) {
      res.writeHead(u.status, {
        "Content-Type": u.headers.get("content-type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...routerHeaders,
      });
      const stream = Readable.fromWeb(u.body);
      // Client disconnects mid-stream abort the upstream fetch; the reader
      // then errors. Swallow it — the response is already (half) sent.
      stream.on("error", () => {
        try { res.end(); } catch {}
      });
      stream.pipe(res);
    } else {
      const text = await u.text();
      res.writeHead(u.status, {
        "Content-Type": u.headers.get("content-type") ?? "application/json",
        ...routerHeaders,
      });
      res.end(text);
    }
  } catch (err) {
    if (ac.signal.aborted) return; // client went away; nothing to answer
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `router: upstream ${target.providerId} failed: ${String(err?.message ?? err)}` } }));
    log({ event: "route", error: "upstream-failed", provider: target.providerId, model: target.model, ms: Date.now() - t0 });
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (auth !== `Bearer ${config.localToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "router: bad local token" } }));
      return;
    }
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      const ids = ["auto", ...Object.keys(config.routing.profiles ?? {})];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: ids.map((id) => ({ id, object: "model", owned_by: "auto-router" })),
      }));
      return;
    }
    // Topology verdict for delegation: the SAME brain that routes chat
    // requests decides whether a task deserves normal delegation (single),
    // MoA (mixture), or a multi-agent swarm. Body: {task} or {messages}.
    if (req.method === "POST" && (req.url === "/route" || req.url === "/v1/route")) {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      const msgs = Array.isArray(body.messages) && body.messages.length > 0
        ? body.messages
        : [{ role: "user", content: String(body.task ?? "") }];
      const signals = analyze({ messages: msgs, model: body.model });
      const target = await decide(signals);
      const defs = config.routing.workflows ?? [];
      const plan = [target.workflow, target.followUp]
        .map((n) => defs.find((w) => w.name === n))
        .filter(Boolean)
        .map((w, i) => ({
          name: w.name,
          args: {
            [w.taskArg]:
              i === 0
                ? signals.lastUser
                : `This is the SECOND stage of a two-stage request. Focus only on your stage's job; ` +
                  `the \`${target.workflow}\` stage is done and its deliverable is your starting point. ` +
                  `The original request was: ${signals.lastUser}`,
            ...(w.defaults ?? {}),
          },
        }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        workload: target.workload,
        execution: target.kind === "mixture" ? (target.execution ?? "mixture") : (target.execution ?? "single"),
        target: target.kind === "mixture" ? null : { providerId: target.providerId, model: target.model },
        assignments: plan,
        assignment: plan[0] ?? null,
        conf: target.conf ?? null,
        wfConf: target.wfConf ?? null,
        reason: target.reason,
      }));
      log({
        event: "route-verdict",
        sessionKey: signals.sessionKey,
        workload: target.workload,
        execution: target.execution ?? "single",
        workflow: plan.map((x) => x.name).join(" -> ") || null,
        reason: target.reason,
      });
      return;
    }
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "router: invalid JSON body" } }));
        return;
      }
      const signals = analyze(body);
      try {
        await forward(res, body, signals);
      } catch (err) {
        log({ event: "route", error: "handler:" + String(err?.message ?? err).slice(0, 120) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "router: internal error" } }));
        } else {
          try { res.end(); } catch {}
        }
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "router: not found" } }));
  });
  req.on("error", () => {});
});

// A proxy should survive anything short of a disk fault; log and keep serving
// (launchd KeepAlive restarts the process if it ever does exit).
process.on("unhandledRejection", (err) => log({ event: "unhandledRejection", detail: String(err).slice(0, 200) }));
process.on("uncaughtException", (err) => log({ event: "uncaughtException", detail: String(err).slice(0, 200) }));

server.listen(config.port, "127.0.0.1", () => {
  log({ event: "start", port: config.port });
  console.log(`zcode-model-router listening on 127.0.0.1:${config.port}`);
});
