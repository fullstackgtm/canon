import { builtInDataView } from "../../recipes/md/dataView.ts";
import { apply, type LayoutOp } from "../../recipes/md/edit.ts";
/**
 * The recipe agent's stand-in model on a local stack (docs/recipes.md, "Editing with an agent"). A local stack's dev
 * user may carry a real ChatGPT session, and a local check must never spend it, so on a loopback deployment with the
 * demo-user bypass on, `proposeEdit` asks this instead of a model unless RECIPE_AGENT_REAL_MODEL=true. It answers the
 * way a model would, with a whole recipe.md and a summary, and Canon's parser, retries and evals then run for real.
 * It is inert on the hosted development site and production, which have no bypass.
 */
import { isDevAuthBypassEnabled } from "../lib";

export const STAND_IN_MODEL = "local:stand-in";

export function standInImageNote(count: number): string {
  return count ? ` (${count} ${count === 1 ? "image" : "images"} attached; the local stand-in ignores images.)` : "";
}

export function recipeAgentStandIn(): boolean {
  let host = "";
  try {
    host = new URL(process.env.CONVEX_SITE_URL ?? "").hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]"].includes(host) && isDevAuthBypassEnabled() && process.env.RECIPE_AGENT_REAL_MODEL !== "true";
}

const SECTION = /^(#+) (.+?) \{[^}]*\bsection=/;

/**
 * A fixed answer: "move <A> above <B>" moves the section headed A above the one headed B; anything else folds the
 * first section that isn't folded.
 */
export function standInAnswer(markdown: string, request: string): { markdown: string; summary: string } {
  if (/make me a page of open deals/i.test(request)) {
    const result = apply(markdown, { op: "addPage", slug: "open-deals", title: "Open deals", icon: "chart" });
    if ("error" in result) return { markdown, summary: result.error };
    const table = apply(result.markdown, openDealsTable());
    return "error" in table ? { markdown, summary: table.error } : { markdown: table.markdown, summary: "Added the Open deals page." };
  }
  const lines = markdown.split("\n");
  const sections = lines.flatMap((l, i) => {
    const m = SECTION.exec(l);
    return m ? [{ i, level: m[1].length, title: m[2].trim() }] : [];
  });
  const find = (name: string) => sections.find((s) => s.title.toLowerCase() === name.trim().toLowerCase());
  const move = /move (.+?) (?:above|before) (.+?)\.?$/i.exec(request.trim());
  const from = move && find(move[1]), to = move && find(move[2]);
  if (from && to && from.i !== to.i) {
    const end = lines.findIndex((l, i) => i > from.i && new RegExp(`^#{1,${from.level}} `).test(l));
    const stop = end < 0 ? lines.length : end;
    const block = lines.slice(from.i, stop);
    const rest = [...lines.slice(0, from.i), ...lines.slice(stop)];
    const at = rest.indexOf(lines[to.i]);
    return { markdown: [...rest.slice(0, at), ...block, ...rest.slice(at)].join("\n"), summary: `Moved ${from.title} above ${to.title}. (Local stand-in model.)` };
  }
  const open = sections.find((s) => !/collapsed=true/.test(lines[s.i]));
  if (!open) return { markdown, summary: "Every section is already folded, so nothing changed. (Local stand-in model.)" };
  lines[open.i] = lines[open.i].replace(/\}\s*$/, " collapsed=true}");
  return { markdown: lines.join("\n"), summary: `Folded ${open.title}. (Local stand-in model: it only moves sections or folds one.)` };
}

export function standInColumns(layout: import("../../recipes/md/edit.ts").Layout, target: import("../../recipes/md/edit.ts").SectionRef | undefined, request: string): import("../../recipes/md/edit.ts").LayoutOp[] {
  const view = builtInDataView(layout, target, request);
  if (view) return view.ops;
  if (/make me a page of open deals/i.test(request)) return [{ op: "addPage", slug: "open-deals", title: "Open deals", icon: "chart" }, openDealsTable()];
  if (/add a metric/i.test(request)) return [{ op: "addSection", object: layout.object, component: "metric", title: "Open deals count", before: null, query: { object: "deal", filter: [{ field: "isClosed", op: "eq", value: false }], aggregate: { fn: "count" }, limit: 10 } }];
  if (layout.object === "account" && /add a form to create a deal (?:here|from this account)/i.test(request)) return [{
    op: "addSection", object: "account", component: "form", title: "New deal", before: null,
    query: { object: "deal", filter: [], limit: 10, fields: ["name", "closeDate", "amount", "stage"], defaults: { companyId: { record: "id" }, currency: "USD" } },
  }];
  if (layout.object === "account" && /^show (?:this account.s )?open deals here[.!]?$/i.test(request.trim())) return [{
    op: "addSection", object: "account", component: "table", title: "Open deals", before: null,
    query: { object: "deal", from: "companyDeals", filter: [{ field: "isClosed", op: "eq", value: false }], columns: ["recordTitle", "amount"], limit: 10 },
  }];
  const match = /^put (?:this|it) next to (.+?)[.!]?$/i.exec(request.trim());
  const other = match && layout.sections.find((s) => s.title.toLowerCase() === match[1].trim().toLowerCase());
  if (!target || !other) return [];
  const ids = new Set<string>();
  const visit = (n: import("../../recipes/layout.ts").LayoutNode) => { if (!("section" in n)) { ids.add(n.id); n.children.forEach(visit); } };
  visit(layout.tree);
  let id = "columns", i = 1;
  while (ids.has(id)) id = `columns${i++}`;
  return [{ op: "wrapSections", object: layout.object, sections: [target, other.ref], kind: "columns", id }];
}

function openDealsTable(): LayoutOp {
  return { op: "addSection", object: "open-deals", component: "table", title: "Open deals", before: null, query: { object: "deal", filter: [{ field: "isClosed", op: "eq", value: false }], columns: ["recordTitle", "amount"], limit: 10 } };
}

export { standInWorkflow } from "./workflowStandIn.ts";
