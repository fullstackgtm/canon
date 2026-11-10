/**
 * The module import rule (docs/modules.md, "Build a module from your own repository"): a module imports only its own
 * files, the module kit and npm packages. One scanner for both sides of it: the kit's `check` runs it over an author's
 * module, and Canon's boundary check (scripts/boundary-check.mjs) over every module in its repository.
 *
 * Node-only tooling: Convex and module bundles never import this directory.
 */
import { posix } from "node:path";

export type Token = { type: "word" | "punct" | "string" | "template" | "regex" | "number"; value: string; line: number };
export type FoundImport = { specifier: string; line: number; typeOnly: boolean; kind: "dynamic" | "side-effect" | "import" | "export" };

/** The source files the rule reads. */
export const SOURCE = /\.(?:ts|tsx|mjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".d.ts"];

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/** Splits source into identifier, punctuation and string tokens, dropping comments, regex literals and template text. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const braces: Array<"block" | "template"> = [];
  let i = 0;
  let line = 1;
  const push = (type: Token["type"], value: string, at: number) => tokens.push({ type, value, line: at });
  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.type === "punct") return !")]}".includes(prev.value);
    return prev.type === "word" && KEYWORDS_BEFORE_REGEX.has(prev.value);
  };
  const skipTemplate = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") { if (text[i + 1] === "\n") line++; i += 2; continue; }
      if (c === "\n") line++;
      if (c === "`") { i++; return; }
      if (c === "$" && text[i + 1] === "{") { i += 2; braces.push("template"); return; }
      i++;
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let j = i; j < stop; j++) if (text[j] === "\n") line++;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\") { value += text[j + 1] ?? ""; j += 2; } else value += text[j++];
      }
      push("string", value, line);
      i = text[j] === c ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      const start = line;
      const close = text.indexOf("`", i + 1);
      const literal = close < 0 ? "" : text.slice(i + 1, close);
      if (close >= 0 && !literal.includes("${") && !literal.includes("\\")) {
        push("string", literal, start);
        for (const ch of literal) if (ch === "\n") line++;
        i = close + 1;
      } else {
        push("template", "`", start);
        i++;
        skipTemplate();
      }
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      if (text[j] === "/") {
        j++;
        while (/[a-z]/i.test(text[j] ?? "")) j++;
        push("regex", "", line);
        i = j;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      push("word", text.slice(i, j), line);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[\w.]/.test(text[j])) j++;
      push("number", text.slice(i, j), line);
      i = j;
      continue;
    }
    if (c === "{") braces.push("block");
    if (c === "}" && braces.at(-1) === "template") {
      braces.pop();
      i++;
      skipTemplate();
      continue;
    }
    if (c === "}") braces.pop();
    push("punct", c, line);
    i++;
  }
  return tokens;
}

/** Every static import, re-export and literal dynamic import in `text`, with whether it carries only types. */
export function findImports(text: string): FoundImport[] {
  const tokens = tokenize(text);
  const found: FoundImport[] = [];
  const is = (k: number, type: Token["type"], value?: string) => tokens[k]?.type === type && (value === undefined || tokens[k].value === value);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== "word" || (token.value !== "import" && token.value !== "export")) continue;
    if (is(k - 1, "punct", ".")) continue;
    if (token.value === "import" && is(k + 1, "punct", "(")) {
      if (!is(k + 2, "string") || !is(k + 3, "punct", ")")) continue;
      const typeOnly = is(k - 1, "word", "typeof") || (is(k + 4, "punct", ".") && is(k + 5, "word") && !["then", "catch", "finally"].includes(tokens[k + 5].value));
      found.push({ specifier: tokens[k + 2].value, line: token.line, typeOnly, kind: "dynamic" });
      continue;
    }
    if (token.value === "import" && is(k + 1, "string")) {
      found.push({ specifier: tokens[k + 1].value, line: token.line, typeOnly: false, kind: "side-effect" });
      continue;
    }
    let j = k + 1;
    let typeOnly = false;
    if (is(j, "word", "type") && !is(j + 1, "word", "from") && !is(j + 1, "punct", ",") && !is(j + 1, "punct", "=")) {
      typeOnly = true;
      j++;
    }
    if (token.value === "export" && !is(j, "punct", "{") && !is(j, "punct", "*")) continue;
    let named = 0;
    let typedNamed = 0;
    let defaultOrNamespace = false;
    let depth = 0;
    let closed = false;
    let complete = false;
    for (let outer = 0; j < tokens.length && outer < 6; j++) {
      const t = tokens[j];
      if (t.type === "punct" && t.value === "{") { if (closed) break; depth++; continue; }
      if (t.type === "punct" && t.value === "}") { if (--depth === 0) closed = true; continue; }
      if (depth > 0) {
        if (t.type === "word" && (is(j - 1, "punct", "{") || is(j - 1, "punct", ","))) {
          named++;
          if (t.value === "type" && is(j + 1, "word")) typedNamed++;
        }
        continue;
      }
      outer++;
      if (t.type === "word" && t.value === "from" && is(j + 1, "string")) { complete = true; break; }
      if (closed && !(t.type === "punct" && t.value === ",")) break;
      if (t.type === "punct" && t.value === "*") defaultOrNamespace = true;
      else if (t.type === "word" && t.value !== "as") defaultOrNamespace = true;
      else if (!(t.type === "punct" && t.value === ",") && t.type !== "word") break;
    }
    if (!complete) continue;
    if (!defaultOrNamespace && named > 0 && typedNamed === named) typeOnly = true;
    found.push({ specifier: tokens[j + 1].value, line: token.line, typeOnly, kind: token.value as "import" | "export" });
    k = j + 1;
  }
  return found;
}

/** Repo-relative target of a specifier, or null for a package. The extension is guessed against `files` when it is missing. */
export function resolveSpecifier(from: string, specifier: string, files: ReadonlySet<string>, aliases: Record<string, string> = {}): string | null {
  let base: string | null = null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(from), specifier));
  else {
    for (const [prefix, target] of Object.entries(aliases)) {
      if (specifier.startsWith(prefix)) { base = posix.normalize(target + specifier.slice(prefix.length)); break; }
    }
  }
  if (base === null) return null;
  if (files.has(base)) return base;
  const stem = base.replace(/\.(?:m?js|jsx)$/, "");
  for (const candidate of [...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)]) {
    if (files.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Whether `to`, a path an import in module directory `dir` resolves to, leaves the module: it is outside `dir` and
 * every `allowed` prefix. Paths are posix, and `dir` and each prefix end in "/".
 */
export const leavesModule = (dir: string, to: string, allowed: readonly string[] = []) => ![dir, ...allowed].some((prefix) => to.startsWith(prefix));
