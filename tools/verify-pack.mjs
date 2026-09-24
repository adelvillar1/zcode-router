// Byte-exact round-trip + schema conformance for the whole pack.
//
// Round trip: parse each file exactly as parseSavedWorkflow does, then re-emit through
// serializeSavedWorkflow's rules. Any difference means the file is not what a
// SaveWorkflow pass would produce, and the next save would rewrite it.
//
// The kit ships no dependencies on purpose, so the one package that matters here —
// `yaml`, which serializeSavedWorkflow uses and whose output this must match byte for
// byte — is resolved from a ZCode checkout rather than installed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function findYamlInClone(cloneDir) {
  // pnpm hoists differently between checkouts, so do not hardcode one path: walk the
  // clone (skipping .git) and take the first node_modules/yaml we reach.
  let hit = null;
  const stack = [cloneDir];
  while (stack.length && !hit) {
    const dir = stack.pop();
    const direct = path.join(dir, "node_modules/yaml/package.json");
    if (fs.existsSync(direct)) {
      hit = path.join(dir, "node_modules/yaml");
      break;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git") continue;
      stack.push(path.join(dir, e.name));
    }
  }
  return hit;
}

// yaml@2 declares an entry per condition ("node" is the CJS/ESM build the app runs).
function yamlEntry(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const dot = pkg.exports && pkg.exports["."];
  const entry =
    (typeof dot === "string" && dot) || (dot && (dot.node || dot.default)) || pkg.main || "index.js";
  return path.resolve(pkgDir, entry);
}

let yamlPkg = null;
try {
  await import("yaml");
  yamlPkg = "yaml";
} catch {
  const roots = [process.env.ZCODE_REF_CLONE, process.cwd()].filter(Boolean);
  let hit = null;
  for (const root of roots) {
    hit = findYamlInClone(root);
    if (hit) break;
  }
  if (!hit) {
    // Walk up from the script's own location: a checkout that has run pnpm install
    // anywhere above the kit is enough.
    let dir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "node_modules/yaml/package.json"))) {
        hit = path.join(dir, "node_modules/yaml");
        break;
      }
      dir = path.dirname(dir);
    }
  }
  if (!hit) {
    console.error(
      "verify-pack needs the `yaml` package — the one serializeSavedWorkflow uses, whose\n" +
        "output this must match byte for byte, so it cannot be substituted.\n\n" +
        "Point it at a ZCode checkout that has run `pnpm install`:\n" +
        "  ZCODE_REF_CLONE=/path/to/ZCode node tools/verify-pack.mjs workflows"
    );
    process.exit(2);
  }
  yamlPkg = pathToFileURL(yamlEntry(hit)).href;
}
const { parse: parseYaml, stringify: stringifyYaml } = await import(yamlPkg);

const SENTINEL = "/* zcode-workflow";
const TERMINATOR = "*/";
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const ARG_TYPES = new Set(["string", "number", "boolean", "json"]);

function isValidName(name) {
  if (name.length === 0 || name.length > 64) return false;
  if (!NAME_PATTERN.test(name)) return false;
  return name.replaceAll(".", "").length > 0;
}

// parseSavedWorkflow, verbatim in behaviour.
function parse(source) {
  const lines = source.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start >= lines.length || lines[start].trim() !== SENTINEL)
    return { ok: false, reason: "missing_frontmatter" };
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== TERMINATOR) end += 1;
  if (end >= lines.length) return { ok: false, reason: "unterminated_frontmatter" };
  const bodyText = lines.slice(start + 1, end).join("\n");
  const script = lines.slice(end + 1).join("\n");
  let body;
  try {
    body = parseYaml(bodyText);
  } catch (e) {
    return { ok: false, reason: "invalid_yaml", detail: String(e.message || e) };
  }
  return { ok: true, body, script, bodyLineOffset: end + 1 };
}

// serializeSavedWorkflow, verbatim in behaviour.
function serialize(meta, script) {
  const body = { description: meta.description };
  if (meta.whenToUse !== undefined) body.whenToUse = meta.whenToUse;
  if (meta.args !== undefined) body.args = meta.args;
  return `${SENTINEL}\n${stringifyYaml(body)}${TERMINATOR}\n${script}`;
}

// SavedWorkflowMetaSchema + SavedWorkflowArgDeclarationSchema, both .strict().
function schemaCheck(name, body) {
  const problems = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["frontmatter body is not a YAML mapping"];
  }
  for (const key of Object.keys(body)) {
    if (!["description", "whenToUse", "args"].includes(key)) problems.push(`unknown key "${key}"`);
  }
  if (typeof body.description !== "string" || body.description.length === 0)
    problems.push("description missing or empty");
  if (body.whenToUse !== undefined && (typeof body.whenToUse !== "string" || body.whenToUse.length === 0))
    problems.push("whenToUse present but empty");
  if (!isValidName(name)) problems.push(`name "${name}" is not a valid saved-workflow filename`);
  if (body.args !== undefined) {
    if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) {
      problems.push("args is not a mapping");
    } else {
      for (const [argName, decl] of Object.entries(body.args)) {
        if (decl === null || typeof decl !== "object" || Array.isArray(decl))
          problems.push(`args.${argName} is not a mapping`);
        else {
          for (const k of Object.keys(decl))
            if (!["type", "description", "required", "default"].includes(k))
              problems.push(`args.${argName} has unknown key "${k}"`);
          if (!ARG_TYPES.has(decl.type)) problems.push(`args.${argName}.type "${decl.type}" not in the type vocabulary`);
          if (decl.description !== undefined && typeof decl.description !== "string")
            problems.push(`args.${argName}.description is not a string`);
          if (decl.required !== undefined && typeof decl.required !== "boolean")
            problems.push(`args.${argName}.required is not a boolean`);
        }
      }
    }
  }
  return problems;
}

// Strip comments and string/template literals so an import check cannot be fooled by
// code that lives inside a child-process command string.
function stripLiterals(script) {
  let out = "";
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    const n = script[i + 1];
    if (c === "/" && n === "/") {
      while (i < script.length && script[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < script.length && !(script[i] === "*" && script[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < script.length) {
        if (script[i] === "\\") i += 2;
        else if (script[i] === quote) {
          i += 1;
          break;
        } else i += 1;
      }
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const dirs = process.argv.slice(2);
const files = dirs.flatMap((d) =>
  fs.readdirSync(d).filter((f) => f.endsWith(".dwf.ts")).sort().map((f) => path.join(d, f))
);

let conform = 0;
let roundtrip = 0;
let fails = 0;
const scriptBytes = new Map();

for (const file of files) {
  const name = path.basename(file).replace(/\.dwf\.ts$/, "");
  const text = fs.readFileSync(file, "utf8");
  const parsed = parse(text);
  if (!parsed.ok) {
    console.log(`FAIL ${name}: parse ${parsed.reason}${parsed.detail ? ` — ${parsed.detail}` : ""}`);
    fails += 1;
    continue;
  }
  const problems = schemaCheck(name, parsed.body);
  if (problems.length) {
    console.log(`FAIL ${name}: ${problems.join("; ")}`);
    fails += 1;
    continue;
  }
  conform += 1;

  const reEmitted = serialize(parsed.body, parsed.script);
  if (reEmitted === text) {
    roundtrip += 1;
  } else {
    console.log(`FAIL ${name}: re-serialization differs from the file on disk`);
    fails += 1;
  }

  if (text.length === 0 || parsed.script.trim().length === 0) {
    console.log(`FAIL ${name}: script body is empty`);
    fails += 1;
  }

  const sameBefore = scriptBytes.get(parsed.script);
  // Running over the pack and the installed library together is normal and expected —
  // that is the sync check. Two files with one name inside one directory is not.
  if (sameBefore && sameBefore !== name) {
    console.log(`WARN ${name} and ${sameBefore} have identical script bodies`);
  }
  scriptBytes.set(parsed.script, name);

  const bare = stripLiterals(parsed.script);
  if (/^\s*import\s+[\w{*]/m.test(bare) || /\brequire\s*\(/.test(bare) || /\bexport\s+(?:const|let|var|function|class|interface|type|default|\{)/m.test(bare)) {
    console.log(`FAIL ${name}: script imports from, or exports to, the module system`);
    fails += 1;
  }
}

console.log(`\nconform: ${conform}/${files.length}`);
console.log(`byte-exact round-trip: ${roundtrip}/${conform}`);
console.log(fails === 0 ? "PASS" : `FAILURES: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
