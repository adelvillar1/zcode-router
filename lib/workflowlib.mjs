/**
 * The delegation library: parse each saved workflow's own metadata block and
 * build the router's workflow-assignment registry from it.
 *
 * The registry and the library therefore cannot drift — adding a workflow to
 * workflows/ makes it router-assignable on the next `kit apply`, with its
 * task argument taken from the workflow's own `args:` declaration.
 */
import fs from "node:fs";
import path from "node:path";

const ARG_PREFERENCE = ["task", "topic", "symptom", "scope", "question", "brief", "incident", "target", "problem"];

export function workflowName(file) {
  return path.basename(file).replace(/\.dwf\.ts$/, "");
}

/**
 * Tolerant parser for the `/* zcode-workflow … *\/` header block. The block
 * is YAML written by hand (and by agents), so this reads keys by
 * indentation, lets values run across continuation lines, and never throws:
 * unparseable files fall back to roster-provided shapes.
 */
export function parseWorkflowMeta(text) {
  const m = text.match(/\/\*\s*zcode-workflow\b([\s\S]*?)\*\//);
  if (!m) return { ok: false, description: "", whenToUse: "", args: [] };
  const top = {};
  const args = [];
  let currentKey = null;
  let argCurrent = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      argCurrent = null;
      const i = t.indexOf(":");
      currentKey = i > 0 ? t.slice(0, i).trim() : null;
      if (currentKey) top[currentKey] = t.slice(i + 1).trim();
      continue;
    }
    if (currentKey === "args") {
      if (indent === 2) {
        const name = (t.endsWith(":") ? t.slice(0, -1) : t.slice(0, t.indexOf(":"))).trim();
        if (/^[A-Za-z_][\w-]*$/.test(name)) {
          argCurrent = { name, value: "" };
          args.push(argCurrent);
        }
        continue;
      }
      if (argCurrent && indent >= 4) argCurrent.value += (argCurrent.value ? " " : "") + t;
      continue;
    }
    if (currentKey) top[currentKey] = `${top[currentKey] ?? ""} ${t}`.trim();
  }
  const clean = (v) =>
    (v ?? "")
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const parsedArgs = args.map((a) => {
    const type = a.value.match(/\btype:\s*([A-Za-z]+)/)?.[1] ?? "";
    const required = /\brequired:\s*true\b/.test(a.value);
    const description = clean(
      a.value
        .replace(/\btype:\s*[A-Za-z]+\b/, "")
        .replace(/\brequired:\s*(true|false)\b/, "")
        .replace(/\bdescription:\s*/, "")
    );
    return { name: a.name, type, required, description };
  });
  return { ok: true, description: clean(top.description), whenToUse: clean(top.whenToUse), args: parsedArgs };
}

export function readLibrary(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dwf.ts"))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const meta = parseWorkflowMeta(text);
      const rank = (arg) => {
        const i = ARG_PREFERENCE.indexOf(arg.name);
        return i >= 0 ? i : ARG_PREFERENCE.length + (arg.required ? 0 : 1);
      };
      const preferred = meta.args.filter((a) => ARG_PREFERENCE.includes(a.name)).sort((a, b) => rank(a) - rank(b))[0];
      const required = meta.args.filter((a) => a.required).sort((a, b) => rank(a) - rank(b))[0];
      return {
        file,
        name: workflowName(file),
        path: path.join(dir, file),
        meta,
        autoArg: preferred?.name ?? required?.name ?? null,
      };
    });
}

/** First sentence, newline- and quote-safe, capped for the registry. */
export function firstSentence(text, cap = 200) {
  if (!text) return "";
  const cut = text.replace(/\s+/g, " ").trim();
  const i = cut.search(/[.!?](\s|$)/);
  const s = (i > 0 ? cut.slice(0, i + 1) : cut).replace(/^["']|["']$/g, "").trim();
  return s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s;
}

/**
 * Build routing.workflows entries. Roster wins over auto-derivation; a
 * workflow whose task argument cannot be determined is skipped with a
 * warning rather than registered with a broken arg name.
 */
export function buildRegistry(library, roster) {
  const shapes = roster.workflows?.shapes ?? {};
  const overrides = roster.workflows?.registry ?? {};
  const registry = [];
  const skipped = [];
  for (const wf of library) {
    const o = overrides[wf.name];
    if (o?.enabled === false) {
      skipped.push({ name: wf.name, reason: "disabled in the roster" });
      continue;
    }
    const taskArg = o?.taskArg ?? wf.autoArg;
    if (!taskArg) {
      skipped.push({ name: wf.name, reason: "no task argument could be derived and none is set in the roster" });
      continue;
    }
    const shape = o?.shape ?? shapes[wf.name] ?? firstSentence(wf.meta.whenToUse || wf.meta.description);
    if (!shape) {
      skipped.push({ name: wf.name, reason: "no shape text available (metadata unparsed; set workflows.shapes in the roster)" });
      continue;
    }
    const entry = { name: wf.name, taskArg, shape };
    if (o?.defaults && Object.keys(o.defaults).length) entry.defaults = o.defaults;
    registry.push(entry);
  }
  return { registry, skipped };
}

/** Copy library files into ZCode's workflows dir; never delete user files. */
export function syncLibrary(kitDir, targetDir) {
  const lib = readLibrary(kitDir);
  const createdTarget = !fs.existsSync(targetDir);
  if (!lib.length) return { copied: [], updated: [], unchanged: 0, createdTarget };
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  const updated = [];
  let unchanged = 0;
  for (const wf of lib) {
    const dest = path.join(targetDir, wf.file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(wf.path, dest);
      copied.push(wf.name);
    } else if (fs.readFileSync(dest, "utf8") !== fs.readFileSync(wf.path, "utf8")) {
      fs.copyFileSync(wf.path, dest);
      updated.push(wf.name);
    } else unchanged++;
  }
  return { copied, updated, unchanged, createdTarget };
}
