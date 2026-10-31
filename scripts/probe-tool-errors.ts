/**
 * Calls every Canon MCP tool, and every action of the grouped ones, twice:
 * with no arguments and with the id "notanid" in each id argument. It prints
 * each reply an agent would read that an agent could not act on, and exits 1
 * if there is any. Run it against your own local stack only (the dev stack
 * bypasses auth as the demo user; writes land in its throwaway database):
 *   node --experimental-strip-types scripts/probe-tool-errors.ts http://127.0.0.1:<convex port> [--api http://localhost:<app port>] [--all]
 * --api also probes the record API (/api/v1); --all also prints the replies that pass.
 */
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod/v4";
import { getParseErrorMessage } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { explainConvexError } from "../src/lib/convexErrorText.ts";
import { canonTools, toolErrorMessage, toolResultText, type CanonTool } from "../src/app/mcp/_canonTools.ts";

const convex = new ConvexHttpClient(process.argv[2]);
const showAll = process.argv.includes("--all");

/** Actions that reach a paid or outside service, or kick off long work, even with junk arguments. */
const SIDE_EFFECTS = /^(start|challenge|plan|start_job|run|probe|check_now|push|send|claim|apply_plan|derive\w*|seed|export\w*|pdf|regenerate_state|run_evals|github\w*|transition|op|call)$/;

/** Why a reply would leave an agent stuck, or null when it is fine. */
function badReply(text: string, documented: Set<string>): string | null {
  if (text.startsWith("REDACTED IN PRODUCTION")) return "plain Error: production shows Server Error";
  if (!text.trim() || /^(undefined|null)$/.test(text.trim())) return "empty or bare null";
  if (/\[object Object\]/.test(text)) return "[object Object]";
  if (/\bv\.(string|float64|int64|number|boolean|id|union|literal|object|array|record|optional)\(/.test(text)) return "Convex validator text";
  if (/Server Error|\[Request ID|Uncaught|\n\s+at \w|ArgumentValidationError/.test(text)) return "transport noise";
  if (/\(got -?\d+\.0\)/.test(text)) return "Convex float formatting";
  if (/^TIMEOUT$/.test(text)) return "no reply in 20 s";
  const field = text.match(/(?:^|: )(?:args\.)?([A-Za-z_]+)(?:\.[A-Za-z_.]+)? (?:is required|must be|is not a recognized)/)?.[1];
  if (field && documented.size && !documented.has(field)) return `names ${field}, which the tool does not document`;
  return null;
}

type Case = { label: string; args: Record<string, unknown>; documented: Set<string> };

function cases(tool: CanonTool): Case[] {
  const shape = tool.inputSchema as Record<string, z.ZodType>;
  const top = Object.keys(shape);
  const withIds = (keys: string[]) => Object.fromEntries(keys.filter((k) => /Id$|^id$/.test(k)).map((k) => [k, "notanid"]));
  if (!shape.action || !("args" in shape)) {
    const documented = new Set(top);
    const out: Case[] = [{ label: `${tool.name} {}`, args: {}, documented }];
    if (Object.keys(withIds(top)).length) out.push({ label: `${tool.name} bad ids`, args: withIds(top), documented });
    return out;
  }
  const actions: string[] = (shape.action as unknown as { options?: string[] }).options ?? [];
  const unknown: Case = { label: `${tool.name} unknown action`, args: { action: "no_such_action", args: {} }, documented: new Set() };
  return [unknown, ...actions.filter((a) => !SIDE_EFFECTS.test(a)).flatMap((action) => {
    const line = tool.description.match(new RegExp(`^- ${action}: \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    const names = [...line.matchAll(/\b([a-z][A-Za-z]*)\??:?/g)].map((m) => m[1]);
    const documented = new Set(names);
    const ids = withIds(names);
    const wrongTypes = Object.fromEntries(names.map((k) => [k, 12345]));
    return [
      { label: `${tool.name} ${action} {}`, args: { action, args: {} }, documented },
      ...(names.length ? [{ label: `${tool.name} ${action} wrong types`, args: { action, args: wrongTypes }, documented }] : []),
      ...(Object.keys(ids).length ? [{ label: `${tool.name} ${action} bad ids`, args: { action, args: ids }, documented }] : []),
    ];
  })];
}

/** Top-level tools that reach a paid or outside service. */
const PAID_TOOLS = new Set(["canon_find_contact_info"]);

let bad = 0, total = 0;
for (const tool of canonTools.filter((t) => !PAID_TOOLS.has(t.name))) {
  for (const c of cases(tool)) {
    total++;
    let text: string;
    // The MCP server validates the input schema before run, and answers like this.
    const parsed = z.object(tool.inputSchema).safeParse(c.args);
    if (!parsed.success) text = `MCP error -32602: Input validation error: Invalid arguments for tool ${tool.name}: ${getParseErrorMessage(parsed.error)}`;
    else try {
      const result = await Promise.race([tool.run(convex, c.args), new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 20_000))]);
      text = toolResultText(tool, c.args, result);
    } catch (error) {
      text = toolErrorMessage(tool, c.args, error);
      // A plain Error thrown inside a Convex function reads fine here; production replaces its text with "Server Error".
      if (/Uncaught Error: /.test(error instanceof Error ? error.message : "") && explainConvexError(error).kind === "internal") text = `REDACTED IN PRODUCTION: ${text}`;
    }
    const why = badReply(text, c.documented);
    if (why) bad++;
    if (why || showAll) console.log(`${why ? `BAD (${why})` : "ok"}  ${c.label}\n    ${text.replace(/\s+/g, " ").slice(0, 260)}`);
  }
}
const api = process.argv[process.argv.indexOf("--api") + 1];
if (process.argv.includes("--api")) {
  const probes: Array<[string, string, string?]> = [
    ["GET", "/api/v1/nope"], ["DELETE", "/api/v1/records/deal"], ["PUT", "/api/v1/records/deal/notanid"],
    ["GET", "/api/v1/records/widget"], ["GET", "/api/v1/records/deal/notanid"], ["PATCH", "/api/v1/records/deal/notanid", '{"values":{"amount":1}}'],
    ["POST", "/api/v1/records/deal", "nope"], ["POST", "/api/v1/records/deal", "{}"], ["POST", "/api/v1/records/deal", '{"values":{"amount":"lots"}}'],
    ["POST", "/api/v1/records/deal", '{"values":{"name":"x","closeDate":"2026-12-01","stage":"s","bogus":1}}'], ["POST", "/api/v1/records/task", '{"values":{}}'],
    ["GET", "/api/v1/records/deal?limit=abc"], ["GET", "/api/v1/records/deal?filter=xx"], ["GET", "/api/v1/records/deal?sort=nofield"],
    ["GET", "/api/v1/records/deal/notanid/activities"], ["POST", "/api/v1/records/deal/notanid/restore"], ["GET", "/api/v1/records/widget/duplicates"],
    ["POST", "/api/v1/records/account/merge", "{}"], ["POST", "/api/v1/records/account/merge/preview", "{}"], ["POST", "/api/v1/merges/notanid/undo"],
    ["GET", "/api/v1/deals/notanid/roles"], ["POST", "/api/v1/deals/notanid/roles", "{}"], ["DELETE", "/api/v1/deals/notanid/roles/notanid"],
    ["GET", "/api/v1/associations"], ["POST", "/api/v1/associations", "{}"], ["POST", "/api/v1/activities", "{}"], ["POST", "/api/v1/salesforce/spot-check", "{}"],
  ];
  for (const [method, path, body] of probes) {
    total++;
    const res = await fetch(api + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body } : {}) });
    const text = await res.text();
    const json = (() => { try { return JSON.parse(text) as { error?: { message?: string } }; } catch { return null; } })();
    const why = res.ok
      ? (path.includes("notanid") ? `HTTP ${res.status} for an id that does not exist` : null)
      : !json?.error?.message ? `HTTP ${res.status} without the JSON error envelope`
      : res.status !== 404 && /not found/i.test(json.error.message) ? `"not found" answered with HTTP ${res.status}, not 404`
      : badReply(json.error.message, new Set());
    if (why) bad++;
    if (why || showAll) console.log(`${why ? `BAD (${why})` : "ok"}  ${method} ${path} ${body ?? ""}\n    ${res.status} ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  }
}
console.log(`\n${bad} of ${total} replies an agent could not act on`);
process.exit(bad ? 1 : 0);
