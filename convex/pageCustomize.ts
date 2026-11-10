"use node";

/**
 * Customize mode's instruction step (prototype; src/components/customize/customize-mode.tsx). One instruction about one part of the
 * deal page becomes layout edits (`LayoutOp`, recipes/md/edit.ts), which the browser applies to its draft recipe.md
 * with the same pure `apply` the recipe editor uses. Nothing is stored.
 *
 * Two models, fastest first:
 * - Jev (TypeSafe System One) routes. For a comment pinned to a section, it picks what kind of edit the instruction is
 *   and its arguments from choices Canon lists (stages, sections, buttons). A confident pick becomes an op directly.
 * - Luna, on the person's own ChatGPT plan, writes the ops when Jev isn't sure or the edit needs words of its own. It
 *   answers with a few ops, not a whole recipe.md, so it takes seconds rather than a minute.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { DEAL_STAGES, type DealStage } from "./lib/plays/model";
import { KERNEL_ACTIONS, type ActionId } from "../recipes/actions.ts";
import { COMPONENTS, PARTS, type PageComponent } from "../recipes/kernel.ts";
import { RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { apply, describeLayout, type Layout, type LayoutOp, type SectionRef } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { DRAWN, drawnText, refuseSectionRename } from "../recipes/md/pointed.ts";
import { isWorkspaceId, lineDiff } from "../recipes/workspace.ts";
import { jevSystemOne, type SystemOneQuestion } from "./lib/segments/jev";
import { resolveLlm } from "./lib/llmResolver";
import type { ActionCaller } from "./records";

const STAGE_NAMES: Record<DealStage, string> = { in: "Get in (first stage, finding the way in)", case: "Build the case (middle stage)", close: "Close (final stage)" };
const JEV_CONFIDENCE = 0.7;

type Result = { markdown: string; summary: string; by: string; ms: number; route: string; diff: string; kind: "layout" | "behavior"; refusedBy?: string };

const refKey = (r: SectionRef) => `${r.component}#${r.nth ?? 0}`;
const sameRef = (a: SectionRef, b: SectionRef) => a.component === b.component && (a.nth ?? 0) === (b.nth ?? 0);

/** Ops that apply cleanly, one after another, to `markdown`. */
function check(markdown: string, ops: LayoutOp[]): { ok: LayoutOp[]; errors: string[]; text: string } {
  const ok: LayoutOp[] = [], errors: string[] = [];
  let text = markdown;
  for (const op of ops) {
    const r = apply(text, op);
    if ("error" in r) errors.push(`${op.op}: ${r.error}`);
    else { ok.push(op); text = r.markdown; }
  }
  return { ok, errors, text };
}

type TextEdit = { find: string; replace: string };

/**
 * Text edits for what layout ops can't reach: settings defaults, tables, stage exits, check rules, prompts. Each
 * `find` must be in the text exactly once. The result must still parse, and in a recipe whose plays run from its own
 * TypeScript bundle the prompts and logic must stay as they were (recipes/workspace.ts, workspaceProblems).
 */
function patch(markdown: string, edits: TextEdit[], kept: boolean): { text: string; errors: string[] } {
  let text = markdown;
  const errors: string[] = [];
  for (const e of edits) {
    if (!e.find) { errors.push("an edit has an empty find"); continue; }
    const at = text.indexOf(e.find);
    if (at < 0) { errors.push(`not found in the customization: ${JSON.stringify(e.find.slice(0, 80))}`); continue; }
    if (text.indexOf(e.find, at + 1) >= 0) { errors.push(`found more than once, so it's ambiguous: ${JSON.stringify(e.find.slice(0, 80))}`); continue; }
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  if (errors.length || text === markdown) return { text, errors };
  const before = parseRecipe(markdown).recipe, after = parseRecipe(text);
  const broken = after.problems.filter((p) => p.level === "error");
  if (broken.length) errors.push(`the edit would break the customization: ${broken.slice(0, 3).map((p) => `line ${p.line}: ${p.message}`).join("; ")}`);
  if (after.recipe.code.length > before.code.length) errors.push("```ts blocks can't be added here");
  if (kept) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const strip = (r: typeof before) => ({ prompts: r.prompts, logic: Object.fromEntries(Object.entries(r.logic).map(([k, ls]) => [k, (ls ?? []).map(({ line: _, ...rest }) => rest)])) });
    const a = strip(before), b = strip(after.recipe);
    for (const id of new Set([...Object.keys(a.prompts), ...Object.keys(b.prompts)])) if (!same(a.prompts[id], b.prompts[id])) errors.push(`the ${id} prompt runs from this customization's TypeScript bundle and can't change here; change a setting instead`);
    for (const k of new Set([...Object.keys(a.logic), ...Object.keys(b.logic)])) if (!same(a.logic[k], b.logic[k])) errors.push(`the ${k} logic runs from this customization's TypeScript bundle and can't change here`);
  }
  return { text, errors };
}

/** Whether the recipe's plays run from its own TypeScript bundle, which freezes its prompts and logic. */
async function keptBundle(ctx: ActionCtx, recipeId: string) {
  if (!isWorkspaceId(recipeId)) return Boolean((RECIPE_BUNDLES as Record<string, unknown>)[recipeId]);
  return (await ctx.runQuery(internal.workspaceRecipes.editBase, { recipeId })).bundle === "kept";
}

const short = (d: string) => (d.length > 2_500 ? `${d.slice(0, 2_500)}\n…` : d);

/** Jev's route: the edit's kind and arguments as choices, or null when it isn't sure. */
async function jevRoute(key: string, layout: Layout, target: SectionRef, request: string, pointed: string): Promise<{ ops: LayoutOp[]; summary: string; refused?: boolean } | null> {
  const section = layout.sections.find((s) => sameRef(s.ref, target));
  if (!section) return null;
  const others = layout.sections.filter((s) => !sameRef(s.ref, target));
  const questions: Record<string, SystemOneQuestion> = {
    kind: {
      type: "choice",
      instructions: `A person customizing a CRM deal page pointed at the "${section.title}" section and wrote an instruction about it. Which single edit does the instruction ask for?`,
      criteria: {
        move: "Move this section above or below another section.",
        fold: "Make this section start folded (collapsed).",
        unfold: "Make this section start open (expanded).",
        only_stages: "Show this section only in some deal stages.",
        hide_stages: "Hide this section in some deal stages.",
        every_stage: "Show this section in every stage.",
        remove_section: "Remove this whole section from the page.",
        remove_button: "Remove one button or action from this section.",
        add_button: "Add a button or action to this section.",
        drawn: "Rename, restyle, hide or remove the very thing pointed at, when pointedAt calls it a control or text the section's component draws (a search box, filter, count, label): not a button, the section's title or a part.",
        behavior: "Change how something works rather than where it sits: a number, a limit, a rule, a check, a prompt, a question, a stage's exit, when something runs.",
        other: "Anything else: renaming the section or a button, more than one change, or unclear.",
      },
    },
    ...Object.fromEntries(DEAL_STAGES.map((s) => [`stage_${s}`, { type: "noul", instructions: `Does the instruction name the stage ${STAGE_NAMES[s]}?` } as SystemOneQuestion])),
  };
  if (others.length) {
    // The pointed-at section is the one that moves unless the instruction names another.
    const all = layout.sections.map((s) => [refKey(s.ref), sameRef(s.ref, target) ? `${s.title} (the section pointed at, "this")` : s.title]);
    questions.mover = { type: "choice", instructions: "If the instruction moves a section, which section moves?", criteria: Object.fromEntries(all) };
    questions.anchor = { type: "choice", instructions: "If the instruction moves a section relative to another section, which section is it placed relative to?", criteria: Object.fromEntries([...all, ["none", "No other section is named."]]) };
    questions.side = { type: "choice", instructions: "Does it go above or below that section?", criteria: { above: "above, before, over", below: "below, after, under" } };
  }
  if (section.actions.length) questions.button = { type: "choice", instructions: "Which of this section's buttons does the instruction name?", criteria: Object.fromEntries(section.actions.map((a) => [a.id, a.label.replace(/<n>/g, "N")])) };
  if (section.addable.length) questions.addable = { type: "choice", instructions: "Which action should be added?", criteria: Object.fromEntries(section.addable.map((a) => [a.runs, `${a.runs.split(".")[1]}: ${KERNEL_ACTIONS[a.runs as ActionId].gate}`])) };

  const out = await jevSystemOne(key, { section: section.title, pointedAt: pointed, buttons: section.actions.map((a) => a.label), instruction: request }, questions, { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) }) });
  const kind = out.answers.kind;
  // A control the component draws itself (the browser says so) has nothing in the recipe to change: say so, and don't
  // let a model change the section in its place.
  if (kind?.type === "choice" && kind.choice === "drawn" && kind.confidence >= JEV_CONFIDENCE && pointed.startsWith(DRAWN)) {
    const what = drawnText(pointed);
    return { ops: [], refused: true, summary: `Canon draws ${what ? `"${what}"` : "that"} itself, so it can't change here yet. A section's title, its buttons and its parts can.` };
  }
  if (kind?.type !== "choice" || kind.confidence < JEV_CONFIDENCE || kind.choice === "other" || kind.choice === "behavior" || kind.choice === "drawn") return null;
  const choice = (k: string) => { const a = out.answers[k]; return a?.type === "choice" && a.confidence >= 0.5 ? a.choice : null; };
  const stages = DEAL_STAGES.filter((s) => { const a = out.answers[`stage_${s}`]; return a?.type === "noul" && a.noul >= 0.6; });
  const name = section.title;
  switch (kind.choice) {
    case "fold": case "unfold":
      return { ops: [{ op: "setCollapsed", object: "deal", section: target, collapsed: kind.choice === "fold" }], summary: `${name} starts ${kind.choice === "fold" ? "folded" : "open"}.` };
    case "every_stage":
      return { ops: [{ op: "setWhen", object: "deal", section: target, when: null }], summary: `${name} shows in every stage.` };
    case "only_stages": case "hide_stages":
      if (!stages.length) return null;
      return { ops: [{ op: "setWhen", object: "deal", section: target, when: kind.choice === "only_stages" ? { stage: stages } : { notStage: stages } }], summary: `${name} ${kind.choice === "only_stages" ? "shows only" : "is hidden"} in ${stages.join(", ")}.` };
    case "remove_section":
      return { ops: [{ op: "removeSection", object: "deal", section: target }], summary: `Removed ${name}.` };
    case "move": {
      const anchor = choice("anchor"), side = choice("side"), mover = choice("mover");
      const moving = layout.sections.find((s) => refKey(s.ref) === mover) ?? section;
      const to = anchor && anchor !== "none" ? layout.sections.findIndex((s) => refKey(s.ref) === anchor) : -1;
      if (to < 0 || !side || sameRef(layout.sections[to].ref, moving.ref)) return null;
      const before = side === "above" ? layout.sections[to].ref : layout.sections[to + 1]?.ref ?? null;
      return { ops: [{ op: "moveSection", object: "deal", section: moving.ref, before: before && sameRef(before, moving.ref) ? layout.sections[to + 2]?.ref ?? null : before }], summary: `Moved ${moving.title} ${side} ${layout.sections[to].title}.` };
    }
    case "remove_button": {
      const id = choice("button");
      return id ? { ops: [{ op: "removeAction", object: "deal", section: target, action: id }], summary: `${name} no longer offers ${section.actions.find((a) => a.id === id)?.label}.` } : null;
    }
    case "add_button": {
      const runs = choice("addable");
      const panel = section.addable.find((a) => a.runs === runs)?.panel;
      return runs ? { ops: [{ op: "addAction", object: "deal", section: target, runs: runs as ActionId, ...(panel ? { panel } : {}) }], summary: `${name} offers ${runs.split(".")[1]}.` } : null;
    }
  }
  return null;
}

const OPS_TOOL = "page_edits";
const OPS_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      description: "Layout edits, applied in order. Use only ops, section refs, action ids and component names listed in the layout.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["moveSection", "setCollapsed", "setWhen", "renameSection", "removeSection", "addSection", "moveAction", "setActionLabel", "removeAction", "addAction", "setActionCondition"] },
          section: { type: "object", properties: { component: { type: "string" }, nth: { type: "number" } }, description: "The section the op is about, as its ref in the layout." },
          before: { description: "moveSection/addSection: the ref of the section it goes before, or null for the end. moveAction: the action id it goes before, or null." },
          collapsed: { type: "boolean" },
          when: { description: "setWhen: {stage:[...]} to show only in those stages, {notStage:[...]} to hide in them, or null for every stage. Stages: in, case, close." },
          title: { type: "string", description: "renameSection/addSection: the section's title." },
          component: { type: "string", description: "addSection: one of the layout's addable components." },
          action: { type: "string", description: "The action's id, for action ops." },
          label: { type: "string", description: "setActionLabel/addAction: the button's label." },
          runs: { type: "string", description: "addAction: one of the section's addable action ids." },
          shows: { type: ["string", "null"] },
          enabled: { type: ["string", "null"] },
        },
        required: ["op"],
      },
    },
    edits: {
      type: "array",
      description: "Text edits to customization.md for what layout ops can't do: a setting's Default in the Settings table, a table row, a stage's exit, a check's rule, a prompt's wording. `find` is exact text from the customization that occurs once (include enough of the line to be unique); `replace` is what it becomes.",
      items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
    },
    summary: { type: "string", description: "One short sentence for the person: what changed (name settings and their new values), or why nothing could." },
  },
  required: ["ops", "edits", "summary"],
};

/** What Canon draws itself on a deal page, whatever the recipe says. */
const FIXED = "Every section of the deal page is the customization's, the header (section=header: the deal's name, Archive and Restore), Products, Credit splits and the apps panel included. Some components draw parts a section's heading picks with show=\"…\": the layout lists them as a section's `parts`, and `show` is what it draws now (absent means all). To hide or bring back a part, edit that heading's show= to list the parts to keep (add show= if the heading has none); never remove a part by removing the section. Inside a section, the controls a component draws itself (search boxes, filters, select/clear buttons, counts) aren't in the customization; only its actions and parts are.";

function lunaPrompt(layout: Layout, target: SectionRef | null, request: string, markdown: string, kept: boolean, pointed: string | null) {
  const page = parseRecipe(markdown).recipe.dealPage;
  return [
    "You change a CRM deal page by editing its customization.md, the file that defines what the page shows and how it works. Two kinds of change:",
    "1. Layout `ops`, for where things sit: sections (by ref {component, nth}), their titles, the stages they show in (`when`), whether they start folded, their buttons (by action id).",
    "2. Text `edits`, for what a section draws and how things work: a section heading's show= parts; else prefer changing a setting's Default in the `## Settings` table (respect its Limits); else a table row, a stage's exit in ```stages, a check's rule, or a button's `shows:`/`enabled:` condition." + (kept ? " This customization's prompts and ```logic lines run from its own TypeScript bundle, so never edit prompt prose or logic lines: express the change through settings and tables." : " You may also edit a prompt's prose."),
    "Return the fewest changes that do what the person asked. Never invent settings, components, actions or data the customization doesn't have. If the request can't be done in this customization, return nothing and say why in the summary.",
    FIXED,
    pointed ? `The person pointed at ${pointed}.` : "",
    target ? `That is inside the section with ref ${JSON.stringify(target)}. "this", "it" or an unnamed subject means what they pointed at: a button is that action; the section's title means the section, so a request that only gives new words ("change to X", "call it X") renames it; "title", "heading" or "section" in the request always means the section's title, even when they pointed at a field or control inside it, so "change title to X" renames the section; a part is that part of the section's show=. Pointing is only a hint at where: judge by what the request asks for. A request about how the section works (how many, how long, which, when) is a customization change wherever they pointed. Only when the request changes the wording, look or presence of "a control or text the section's component draws" itself, return nothing and say plainly that Canon draws it and it can't change here yet; never rename or change the section in its place.` : "What they pointed at is outside every customization section, so it's one of the parts the customization doesn't control unless the request names a section. Never apply the request to some other section as a guess: if it is about what they pointed at, return nothing and say plainly that Canon draws that part and it can't change here yet.",
    `Stages: in = Get in, case = Build the case, close = Close.`,
    `Instruction: ${request}`,
    `Layout: ${JSON.stringify({ sections: layout.sections.map((s, i) => ({ ref: s.ref, title: s.title, when: s.when, collapsed: s.collapsed, ...(PARTS[s.component] ? { parts: PARTS[s.component], show: page[i]?.show ?? PARTS[s.component] } : {}), actions: s.actions.map((a) => ({ id: a.id, label: a.label, ...(a.panel ? { panel: a.panel } : {}) })), addableActions: s.addable })), addableComponents: layout.addable })}`,
    `customization.md:\n<<<\n${markdown}\n>>>`,
  ].join("\n\n");
}

function asOps(raw: unknown): LayoutOp[] {
  const items = (raw as { ops?: unknown })?.ops;
  if (!Array.isArray(items)) return [];
  return items.flatMap((o) => (o && typeof o === "object" && typeof (o as { op?: unknown }).op === "string" ? [{ object: "deal", ...(o as object) } as LayoutOp] : []))
    .map((o) => ("component" in o && o.op === "addSection" && !(COMPONENTS.deal as readonly string[]).includes(o.component) ? { ...o, component: "fields" as PageComponent } : o));
}

export const edit = action({
  args: {
    recipeId: v.string(),
    markdown: v.string(),
    request: v.string(),
    target: v.optional(v.object({ component: v.string(), nth: v.optional(v.number()) })),
    pointed: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Result> => {
    const started = Date.now();
    const caller: ActionCaller | null = await ctx.runQuery(internal.records.callerContext, {});
    if (!caller) throw new ConvexError("Not authenticated");
    const request = args.request.trim().slice(0, 1_000);
    const trace = { route: "", by: "" };
    const log = (outcome: "changed" | "unchanged" | "refused" | "error", summary: string, refusedBy?: string) =>
      ctx.runMutation(internal.pageEditAttempts.record, {
        orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, recipeId: args.recipeId, request,
        ...(args.pointed ? { pointed: args.pointed } : {}), ...(args.target ? { target: args.target } : {}),
        outcome, ...(refusedBy ? { refusedBy } : {}), by: trace.by, route: trace.route, summary, ms: Date.now() - started,
      }).catch((e) => console.error("pageEditAttempts.record failed", e));
    try {
      const r = await runEdit(ctx, caller, args, request, started, trace);
      await log(r.refusedBy ? "refused" : r.markdown === args.markdown ? "unchanged" : "changed", r.summary, r.refusedBy);
      if (r.refusedBy) console.warn(`pageCustomize.edit refused (${r.refusedBy}): ${JSON.stringify(request)} | ${trace.route}`);
      return r;
    } catch (e) {
      const message = e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : String(e);
      console.error(`pageCustomize.edit failed: ${JSON.stringify(request)} | ${trace.route} | ${message}`);
      await log("error", message.slice(0, 1_000));
      throw e;
    }
  },
});

async function runEdit(
  ctx: ActionCtx, caller: ActionCaller,
  args: { recipeId: string; markdown: string; target?: { component: string; nth?: number }; pointed?: string },
  request: string, started: number, trace: { route: string; by: string },
): Promise<Result> {
  const layout = describeLayout(args.markdown, "deal");
  if ("error" in layout) throw new ConvexError(layout.error);
  const target = args.target as SectionRef | undefined;
  const done = (text: string, summary: string, by: string, kind: Result["kind"]): Result => { trace.by = by; return { markdown: text, summary, by, ms: Date.now() - started, route: trace.route, diff: short(lineDiff(args.markdown, text).text), kind }; };
  const refuse = (summary: string, by: string, refusedBy: string): Result => ({ ...done(args.markdown, `Couldn't make that change: ${summary}`, by, "layout"), refusedBy });

  const key = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
  if (key && target) {
    const t = Date.now();
    const routed = await jevRoute(key, layout, target, request, args.pointed ?? "").catch((e) => { trace.route += `jev failed (${e instanceof Error ? e.message.slice(0, 80) : e}); `; return null; });
    trace.route += `jev ${Date.now() - t}ms${routed ? "" : " → luna"}; `;
    if (routed?.refused) return refuse(routed.summary, "Jev", "jev:drawn");
    if (routed) {
      const { ok, errors, text } = check(args.markdown, routed.ops);
      if (ok.length && !errors.length) return done(text, routed.summary, "Jev", "layout");
      trace.route += `jev ops refused (${errors.join("; ")}); `;
    }
  }

  const llm = await resolveLlm(ctx, caller.userId as Id<"users">);
  if (!llm) throw new ConvexError("Connect ChatGPT in Integrations: changes that need words run on your own ChatGPT plan.");
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];
  const kept = await keptBundle(ctx, args.recipeId);
  let prompt = lunaPrompt(layout, target ?? null, request, args.markdown, kept, args.pointed?.slice(0, 300) ?? null);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = Date.now();
    const raw = await forcedToolCall(prompt, OPS_TOOL, OPS_SCHEMA, model, llm);
    trace.route += `${model} ${Date.now() - t}ms; `;
    const summary = String((raw as { summary?: unknown })?.summary ?? "");
    const laid = check(args.markdown, asOps(raw));
    const edits = Array.isArray((raw as { edits?: unknown })?.edits) ? ((raw as { edits: TextEdit[] }).edits).filter((e) => typeof e?.find === "string" && typeof e?.replace === "string") : [];
    const patched = patch(laid.text, edits, kept);
    const errors = [...laid.errors, ...patched.errors];
    // Pointed at a control the component draws and asked to rename "this": that's the control, not the section. A
    // request that says title, heading or section, or names the section, still renames the section.
    if (target && laid.ok.some((o) => o.op === "renameSection" && sameRef(o.section, target))) {
      const titled = layout.sections.find((s) => sameRef(s.ref, target))?.title ?? "";
      const what = refuseSectionRename(request, args.pointed, titled);
      if (what !== null) {
        trace.route += `renamed the section, but they pointed at ${JSON.stringify(what.slice(0, 60))}; `;
        return refuse(`Canon draws ${what ? `"${what}"` : "that"} itself, so it can't change here yet. To rename the section, point at its title or say "section".`, model, "guard:drawnRename");
      }
    }
    last = `${summary ? `${summary} ` : ""}${errors.length ? `Refused: ${errors.join("; ")}` : ""}`.trim();
    if (!errors.length) {
      if (patched.text === args.markdown) return refuse(summary || "Nothing to change.", model, "model");
      return done(patched.text, summary || "Done.", model, edits.length ? "behavior" : "layout");
    }
    trace.route += `refused (${errors.join("; ").slice(0, 200)}); `;
    prompt += `\n\nYour last answer was refused: ${errors.join("; ")}. Answer again.`;
  }
  return refuse(last.slice(0, 400), model, "ops");
}

/**
 * Save the draft as the workspace's deal page. A workspace recipe saves a new revision on the revision the draft was
 * made from (`baseRevision`), so a teammate's save in between is refused, never overwritten. A first-party recipe
 * can't be edited in place: it is customized into a workspace copy (or the copy a blocked save already made, `into`),
 * the draft goes into the copy with the copy's id, title and author, and the copy is switched on for the deal page
 * only once its save went through. Saving runs the recipe's evals.
 */
export const save = action({
  args: {
    recipeId: v.string(), markdown: v.string(), baseRevision: v.optional(v.number()), into: v.optional(v.string()),
    note: v.optional(v.string()), acceptFailingEvals: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ recipeId: string; revision: number; copied: boolean; blocked: boolean; failing: string[]; evalsNotRun: string | null }> => {
    const note = args.note ?? "Customized on the deal page";
    if (isWorkspaceId(args.recipeId)) {
      if (args.baseRevision === undefined) throw new ConvexError("Saving a workspace customization needs the revision the draft was made from.");
      const out = await ctx.runAction(api.workspaceRecipes.save, { recipeId: args.recipeId, markdown: args.markdown, baseRevision: args.baseRevision, note, acceptFailingEvals: args.acceptFailingEvals });
      return { recipeId: args.recipeId, revision: out.revision, copied: false, blocked: out.blocked, failing: out.evals.filter((e) => !e.ok).map((e) => e.name), evalsNotRun: out.evalsNotRun };
    }
    if (args.into !== undefined && !isWorkspaceId(args.into)) throw new ConvexError(`${args.into} isn't a workspace copy.`);
    const recipeId = args.into ?? (await ctx.runAction(api.workspaceRecipes.customize, { recipeId: args.recipeId })).recipeId;
    const copy = await ctx.runQuery(api.workspaceRecipes.markdown, { recipeId });
    if (!copy) throw new ConvexError("Not authenticated");
    // The draft keeps everything but who it is: the copy's id, title and author.
    const head = (t: string) => Object.fromEntries(t.split("\n").slice(0, 40).flatMap((l) => { const m = /^(id|title|author):/.exec(l); return m ? [[m[1], l]] : []; }));
    const theirs = head(copy.markdown);
    const markdown = args.markdown.split("\n").map((l, i) => { const m = i < 40 ? /^(id|title|author):/.exec(l) : null; return m && theirs[m[1]] ? theirs[m[1]] : l; }).join("\n");
    const base = await ctx.runQuery(internal.workspaceRecipes.editBase, { recipeId });
    const out = await ctx.runAction(api.workspaceRecipes.save, { recipeId, markdown, baseRevision: base.revision, note, acceptFailingEvals: args.acceptFailingEvals });
    if (!out.blocked) await ctx.runMutation(api.recipes.enableContribution, { point: "deal.page", recipeId, key: "page" });
    return { recipeId, revision: out.revision, copied: true, blocked: out.blocked, failing: out.evals.filter((e) => !e.ok).map((e) => e.name), evalsNotRun: out.evalsNotRun };
  },
});
