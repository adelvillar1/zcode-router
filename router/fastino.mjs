/**
 * Fastino GLiNER2.5 judge backend — a local-cost alternative to the TypeSafe
 * judge for the four routing questions.
 *
 * Fastino serves the GLiNER2.5 encoder family behind an OpenAI-compatible
 * chat endpoint with a schema extension: schema.classifications maps question
 * names to option arrays, and include_confidence asks for per-answer
 * confidence. An encoder does one forward pass for all questions, so this is
 * the fast path; TypeSafe stays as the escalation for low confidence (cascade
 * mode) and as the mixture's best-answer judge, where comparing three long
 * answers is reasoning work an encoder should not do.
 *
 * Two operational quirks discovered by probing (2026-09-26):
 *  - Models cold-start: before the first (or first-after-idle) call the API
 *    answers HTTP 425 "model_warming" for up to minutes. Treat 425 as its own
 *    fast failure (never wait it out inline) and let the server's keepalive
 *    warmer absorb it.
 *  - Content is a JSON string whose exact shape has varied; the parser below
 *    accepts every shape observed or plausible and fails open otherwise.
 */
const EXECUTIONS = ["single", "mixture", "swarm"];

/** Read the router .env (same file the TypeSafe key lives in). */
function envFile(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pull a {value, confidence} pair out of whatever a classification answer
 * looks like. Tolerates: plain string, {answer|value|choice|label},
 * {answer, confidence}, {value, score}, and wrapping objects one level deep.
 */
function readAnswer(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return { value: String(v), confidence: null };
  }
  if (typeof v !== "object") return null;
  const value = v.answer ?? v.value ?? v.choice ?? v.label ?? v.decision ?? null;
  if (value == null) {
    for (const inner of Object.values(v)) {
      const nested = readAnswer(inner);
      if (nested?.value != null) return nested;
    }
    return null;
  }
  const confidence = [v.confidence, v.score, v.probability, v.prob]
    .find((n) => Number.isFinite(n)) ?? null;
  return { value: String(value), confidence };
}

/**
 * Parse the completion content into the same shape judgeWorkload returns:
 * { workload, execution, workflow, followUp, conf, execConf, wfConf, reason }.
 * Returns null (never throws) when nothing usable is found.
 */
export function parseFastinoVerdict(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try { parsed = JSON.parse(content.slice(first, last + 1)); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const roots = [parsed, parsed.classifications, parsed.answers, parsed.results].filter(
    (r) => r && typeof r === "object"
  );
  const pick = (name) => {
    for (const root of roots) {
      const a = readAnswer(root[name]);
      if (a?.value != null) return a;
    }
    return null;
  };

  const workload = pick("workload");
  const execution = pick("execution");
  const workflow = pick("workflow");
  const followUp = pick("followUp");
  if (!workload && !workflow) return null;

  const overall = readAnswer(parsed.confidence);
  const conf = workload?.confidence
    ?? (Number.isFinite(parsed.confidence) ? parsed.confidence : null)
    ?? (overall?.confidence != null ? overall.confidence : null);
  const execConf = execution?.confidence ?? conf ?? null;
  const wfConf = workflow?.confidence ?? conf ?? null;

  const clean = (v) => (v == null ? null : String(v).trim());
  return {
    workload: clean(workload?.value),
    execution: clean(execution?.value),
    workflow: workflow?.value == null ? null : clean(workflow.value),
    followUp: followUp?.value == null ? null : clean(followUp.value),
    conf: Number.isFinite(conf) ? conf : null,
    execConf: Number.isFinite(execConf) ? execConf : null,
    wfConf: Number.isFinite(wfConf) ? wfConf : null,
    reason: "judge:fastino",
  };
}

/** Apply the same gates the TypeSafe judge applies, for identical behavior. */
export function gateFastinoVerdict(verdict, R) {
  if (!verdict) return null;
  const out = { ...verdict, workload: null, execution: null, workflow: null, followUp: null };
  const workloadOk = verdict.workload && verdict.workload in (R.workloads ?? {}) && (verdict.conf ?? 0) >= (R.minConfidence ?? 0.6);
  if (workloadOk) out.workload = verdict.workload;
  if (verdict.execution && EXECUTIONS.includes(verdict.execution) && (verdict.execConf ?? verdict.conf ?? 0) >= (R.minConfidence ?? 0.6)) {
    out.execution = verdict.execution;
  }
  const wfNames = new Set((R.workflows ?? []).map((w) => w.name));
  if (verdict.workflow && wfNames.has(verdict.workflow) && (verdict.wfConf ?? 0) >= (R.workflowMinConfidence ?? 0.4)) {
    out.workflow = verdict.workflow;
  }
  if (verdict.followUp && verdict.followUp !== out.workflow && wfNames.has(verdict.followUp)) {
    out.followUp = verdict.followUp;
  }
  out.reason = (out.workload || out.workflow) ? "judge:fastino" : "judge:fastino:low-confidence";
  return out;
}

/**
 * Judge via Fastino. Same return contract as judgeWorkload, plus raw for
 * debug logs. Throws on HTTP/transport failure so the caller's fail-open
 * path handles it — except 425 (model cold), which returns a soft
 * low-confidence verdict so cascade mode escalates to TypeSafe immediately.
 */
export async function judgeViaFastino({ signals, cfg, envMap, R }) {
  const judgeCfg = cfg.judge?.fastino ?? {};
  const apiKey = envMap[judgeCfg.apiKeyEnv ?? "FASTINO_API_KEY"] ?? null;
  const model = judgeCfg.model ?? "fastino/gliner2.5-multi-v1";
  const baseUrl = (judgeCfg.baseUrl ?? "https://api.fastino.ai/v1").replace(/\/+$/, "");
  if (!apiKey) {
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:fastino:no-key" };
  }

  const content =
    `${signals.lastUser}\n\n` +
    `[context] messages=${signals.messages.length}, ~${Math.round(signals.chars / 4)} input tokens, ` +
    `${signals.images} image(s), ${signals.toolDefs} tool definitions`;

  const wfNames = (R.workflows ?? []).map((w) => w.name);
  const schema = {
    classifications: {
      workload: Object.keys(R.workloads ?? {}),
      execution: EXECUTIONS,
      workflow: [...wfNames, "none"],
      followUp: [...wfNames, "none"],
    },
  };

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        schema,
        include_confidence: true,
      }),
      signal: AbortSignal.timeout(judgeCfg.timeoutMs ?? 2500),
    });
  } catch (err) {
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:fastino:error:" + String(err?.message ?? err).slice(0, 80), raw: null, ms: Date.now() - t0 };
  }

  if (res.status === 425) {
    // Model cold: never wait it out inline. The caller escalates and the
    // keepalive warmer handles bringing the model back.
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, cold: true, reason: "judge:fastino:cold", raw: null, ms: Date.now() - t0 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: `judge:fastino:error:http-${res.status}`, raw: detail.slice(0, 200), ms: Date.now() - t0 };
  }

  let content2 = null;
  try {
    const d = await res.json();
    content2 = d?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:fastino:error:unparseable-response", raw: null, ms: Date.now() - t0 };
  }
  const verdict = parseFastinoVerdict(content2);
  if (!verdict) {
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:fastino:error:unparseable-content", raw: String(content2 ?? "").slice(0, 200), ms: Date.now() - t0 };
  }
  const gated = gateFastinoVerdict(verdict, R);
  return { ...gated, raw: String(content2).slice(0, 300), ms: Date.now() - t0 };
}
