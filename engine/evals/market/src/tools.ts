import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractReadableText, type CaptureEntry } from "../../../src/market.ts";
import type { Arm, MarketEvalScenario, ToolDef, ToolExecutor } from "./types.ts";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/bin.js");
const MAX_OUTPUT_CHARS = 20_000;

function safePath(root: string, requested: string): string {
  const resolved = path.resolve(root, requested || ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Path escapes working directory: ${requested}`);
  return resolved;
}

export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (current || has) out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (current || has) out.push(current);
  return out;
}

export const FETCH_URL_TOOL: ToolDef = {
  name: "fetch_url",
  description:
    "Read one of the frozen vendor source URLs for this eval scenario. Returns extracted readable text. Live web browsing is not available; only URLs listed in the task work.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Exact source URL from the task." } },
    required: ["url"],
  },
};

export const WRITE_FILE_TOOL: ToolDef = {
  name: "write_file",
  description: "Write a UTF-8 file in the eval working directory. Use this for market.config.json, observations.json, and market-report.md.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
};

export const READ_FILE_TOOL: ToolDef = {
  name: "read_file",
  description: "Read a UTF-8 file from the eval working directory.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Relative file path." } },
    required: ["path"],
  },
};

export const LIST_FILES_TOOL: ToolDef = {
  name: "list_files",
  description: "List files in the eval working directory.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Relative directory path; default '.'" } },
  },
};

export const FSGTM_TOOL: ToolDef = {
  name: "fullstackgtm",
  description:
    "Run the real fullstackgtm CLI in the eval working directory. This arm is the assisted condition. Useful market commands: " +
    "'market schema' prints exact valid MarketConfig and ObservationSet shapes; call this before writing artifacts if unsure. " +
    "'market worksheet --vendor <id> --out <file>' reads the frozen captured pages for one configured vendor and includes the intensity rubric + deterministic claimHints; " +
    "'market hints --json' prints candidate support snippets for every vendor x claim (retrieval hints, not labels); " +
    "'market observe --from observations.json' validates full coverage and verbatim evidence against captures, then appends the run; " +
    "'market fronts --json', 'market axes --json', and 'market report --format md --out market-report.md' derive deterministic market-map outputs. " +
    "Do not use external network or nested LLM classification; you are the analyst filling the taxonomy/observations from the worksheets.",
  input_schema: {
    type: "object",
    properties: { args: { type: "string", description: "CLI argument string after 'fullstackgtm', e.g. 'market worksheet --vendor clay --out clay.json'." } },
    required: ["args"],
  },
};

export function toolsForArm(arm: Arm): ToolDef[] {
  const base = [FETCH_URL_TOOL, WRITE_FILE_TOOL, READ_FILE_TOOL, LIST_FILES_TOOL];
  return arm === "fsgtm" ? [...base, FSGTM_TOOL] : base;
}

export async function preloadCaptures(scenario: MarketEvalScenario, home: string): Promise<void> {
  const captureDir = path.join(home, "market", scenario.category, "captures");
  await mkdir(captureDir, { recursive: true });
  const entries: CaptureEntry[] = [];
  for (const vendor of scenario.vendors) {
    const urls: Array<{ kind: CaptureEntry["kind"]; url: string }> = [{ kind: "home", url: vendor.urls.home }];
    if (vendor.urls.pricing) urls.push({ kind: "pricing", url: vendor.urls.pricing });
    for (const url of vendor.urls.product ?? []) urls.push({ kind: "product", url });
    for (const target of urls) {
      const html = scenario.pages[target.url] ?? "";
      const text = html ? extractReadableText(html) : "";
      let captureHash: string | null = null;
      if (text) {
        captureHash = createHash("sha256").update(text).digest("hex");
        await writeFile(path.join(captureDir, `${captureHash}.txt`), text);
      }
      entries.push({
        runLabel: "run-1",
        vendorId: vendor.id,
        kind: target.kind,
        url: target.url,
        fetchedAt: `${new Date(0).toISOString()}`,
        httpStatus: text ? 200 : 200,
        captureHash,
        textChars: text.length,
      });
    }
  }
  await writeFile(path.join(captureDir, "manifest.json"), `${JSON.stringify(entries, null, 2)}\n`);
}

export function createExecutor(scenario: MarketEvalScenario, opts: { workdir: string; home: string }): ToolExecutor {
  return async (name: string, input: any): Promise<string> => {
    if (name === FETCH_URL_TOOL.name) {
      const url = String(input?.url ?? "");
      if (!(url in scenario.pages)) return `HTTP 404: ${url} is not part of this frozen scenario.`;
      const text = extractReadableText(scenario.pages[url] ?? "");
      return text || "HTTP 200: page was empty/unreadable.";
    }
    if (name === WRITE_FILE_TOOL.name) {
      const p = safePath(opts.workdir, String(input?.path ?? ""));
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, String(input?.content ?? ""));
      return `wrote ${path.relative(opts.workdir, p)}`;
    }
    if (name === READ_FILE_TOOL.name) {
      const p = safePath(opts.workdir, String(input?.path ?? ""));
      return await readFile(p, "utf8");
    }
    if (name === LIST_FILES_TOOL.name) {
      const p = safePath(opts.workdir, String(input?.path ?? "."));
      if (!existsSync(p)) return "[]";
      return JSON.stringify(await readdir(p), null, 2);
    }
    if (name === FSGTM_TOOL.name) return runFsgtm(String(input?.args ?? ""), opts);
    throw new Error(`Unknown tool: ${name}`);
  };
}

function runFsgtm(argString: string, opts: { workdir: string; home: string }): Promise<string> {
  return new Promise((resolve) => {
    const argv = splitArgs(argString);
    if (argv[0] === "fullstackgtm") argv.shift();
    if (argv[0] !== "market") {
      resolve("exit code: 1\nOnly fullstackgtm market commands are available in this eval arm.");
      return;
    }
    execFile(
      process.execPath,
      [BIN, ...argv],
      {
        cwd: opts.workdir,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          HOME: opts.home,
          FSGTM_HOME: opts.home,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n" : "") + `[stderr] ${stderr}`;
        if (error && !stdout && !stderr) out = String(error.message ?? error);
        out = `exit code: ${code}\n${out}`.trim();
        resolve(out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : out);
      },
    );
  });
}
