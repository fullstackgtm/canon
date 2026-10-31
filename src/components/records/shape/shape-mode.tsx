"use client";

/**
 * The deal page's side of customize mode (prototype; the pencil and the overlay are components/customize/customize-mode.tsx).
 *
 * The page draws from a draft recipe.md held here, which starts as the recipe in force. Each comment is a job in a
 * queue: `pageCustomize.edit` turns it into layout ops (Jev when it's sure, Luna on the person's ChatGPT plan otherwise),
 * and they are applied to the draft with the recipe editor's own `apply`, so the page redraws as each one lands.
 * No confirmation: a job that worked is kept, and Undo steps back. The draft lasts for this session only.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { DEAL_STAGES, type DealStage } from "../../../../convex/lib/plays/model";
import type { PageSection, PageSpec } from "../../../../recipes";
import type { SectionRef } from "../../../../recipes/md/edit";
import { parseRecipe } from "../../../../recipes/md/parse";
import { useCustomizeAdapter, useCustomizeMode, type CustomizeAdapter, type CustomizeJob, type CustomizeTarget } from "@/components/customize/customize-mode";
import { cn, getErrorMessage } from "@/lib/utils";
import { lensFor, readLens } from "./lens";

const STAGE_NAMES: Record<DealStage, string> = { in: "Get in", case: "Build the case", close: "Close" };
type Shape = { indexOf: (s: PageSection) => number; changed: (s: PageSection) => boolean; fresh: (s: PageSection) => boolean; stage: DealStage | null };
const ShapeContext = createContext<Shape | null>(null);
export const useShape = () => useContext(ShapeContext);

/** A recipe name in everyday words: brief.whyNow → why now. */
function human(name: string) {
  const words = name.replace(/\.(prompt|planPrompt|briefPrompt)$/, (_m, p: string) => (p === "prompt" ? "" : `.${p.replace(/Prompt$/, "")}`)).split(".").filter(Boolean);
  const last = words.length > 1 && /^(center|capability|prompt)$/.test(words.at(-1)!) ? words.slice(-2).join(" ") : words.at(-1) ?? name;
  const spaced = last.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return ({ items: "evidence", steps: "plan steps", answers: "answers to prep questions", suggested: "suggested people", notes: "notes on people", plan: "research plan", brief: "brief prompt" } as Record<string, string>)[spaced] ?? spaced;
}
const cleanLabel = (l: string) => l.replace(/<n>/g, "N").replace(/\{[^|}]*\|([^}]*)\}/g, "$1");
const refOf = (page: PageSpec, i: number): SectionRef => ({ component: page[i].component, nth: page.slice(0, i).filter((s) => s.component === page[i].component).length });

function whenText(s: PageSection) {
  if (s.when?.stage) return `shows in ${s.when.stage.map((x) => STAGE_NAMES[x]).join(", ")}`;
  if (s.when?.notStage) return `hidden in ${s.when.notStage.map((x) => STAGE_NAMES[x]).join(", ")}`;
  return "shows in every stage";
}

type Job = CustomizeJob & { target: { component: string; title: string; nth: number } | null; pointed: string };

/** The page the deal draws, customize mode's adapter for it, and the provider its sections read. */
export function useShapeMode({ base, markdown, recipeId, revision, recipeTitle }: { base: PageSpec; markdown: string | null; recipeId: string | null; revision: number | null; recipeTitle?: string }) {
  const customize = useCustomizeMode();
  const [drafts, setDrafts] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stage, setStage] = useState<DealStage | null>(null);
  const run = useAction(api.pageCustomize.edit);
  const saveDraft = useAction(api.pageCustomize.save);
  const [saved, setSaved] = useState<CustomizeAdapter["saved"]>(null);
  // The revision the draft was made from, so a teammate's save in between is refused rather than overwritten.
  const draftBase = useRef<number | null>(null);
  // The workspace copy a blocked save already made, so Save anyway saves into it instead of making another.
  const [into, setInto] = useState<string | null>(null);
  const draft = drafts.at(-1) ?? markdown;
  const parsed = useMemo(() => {
    if (!draft || !drafts.length) return null;
    const page = parseRecipe(draft).recipe.dealPage;
    return { page, lens: lensFor(page, readLens(draft)) };
  }, [draft, drafts.length]);
  const baseLens = useMemo(() => lensFor(base, markdown ? readLens(markdown) : []), [base, markdown]);
  const page = parsed?.page ?? base;
  const lens = parsed?.lens ?? baseLens;
  const active = Boolean(markdown && recipeId);

  async function save(acceptFailingEvals = false) {
    if (!draft || !recipeId || !drafts.length) return;
    setSaved({ state: "saving" });
    try {
      const r = await saveDraft({
        recipeId, markdown: draft, acceptFailingEvals, ...(draftBase.current !== null ? { baseRevision: draftBase.current } : {}), ...(into ? { into } : {}),
        note: jobs.filter((j) => j.status === "done").map((j) => `${j.where}: ${j.request}`).join("; ").slice(0, 400),
      });
      if (r.blocked) {
        if (r.copied) setInto(r.recipeId);
        setSaved({ state: "blocked", message: `Evals failing: ${r.failing.join(", ")}.` });
        return;
      }
      // The recipe in force now is the saved one, so the page draws from it and the draft is spent. No job ran while
      // saving (the queue waits), so nothing unsaved is dropped here.
      setDrafts([]);
      setInto(null);
      draftBase.current = null;
      setSaved({ state: "saved", message: `Saved as revision ${r.revision}${r.copied ? ` of a workspace copy (${r.recipeId}), now the deal page for everyone` : ""}${r.evalsNotRun ? `. Evals not run: ${r.evalsNotRun}` : ""}.` });
    } catch (e) {
      setSaved({ state: "failed", message: getErrorMessage(e) });
    }
  }
  const lastFresh = useRef<Set<string>>(new Set());

  // One job at a time, each on the draft as the jobs before it left it.
  const working = jobs.some((j) => j.status === "working");
  const next = jobs.find((j) => j.status === "queued");
  useEffect(() => {
    if (working || !next || !draft || saved?.state === "saving") return;
    const started = Date.now();
    setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "working" } : j)));
    // The section may have moved since the comment: find it again by its title.
    const i = next.target ? page.findIndex((s, k) => s.component === next.target!.component && (s.title ?? lens[k]?.title ?? s.component) === next.target!.title) : -1;
    const target = i >= 0 ? refOf(page, i) : next.target ? { component: next.target.component as SectionRef["component"], nth: next.target.nth } : undefined;
    void run({ recipeId: recipeId!, markdown: draft, request: next.request, pointed: next.pointed, ...(target ? { target } : {}) }).then((r) => {
      if (r.markdown !== draft) {
        const before = new Set(parseRecipe(draft).recipe.dealPage.map((s) => JSON.stringify(s)));
        lastFresh.current = new Set(parseRecipe(r.markdown).recipe.dealPage.map((s) => JSON.stringify(s)).filter((k) => !before.has(k)));
        if (!drafts.length) draftBase.current = revision;
        setDrafts((d) => [...d, r.markdown]);
        setSaved(null);
      }
      setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: r.markdown !== draft ? "done" : "failed", summary: r.summary, by: r.by, ms: Date.now() - started, route: r.route, diff: r.diff, kind: r.kind } : j)));
    }).catch((e: unknown) => {
      setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "failed", summary: getErrorMessage(e), ms: Date.now() - started } : j)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, next?.id, draft, saved?.state]);

  const sectionOf = (el: HTMLElement | null) => {
    const i = Number(el?.closest<HTMLElement>("[data-shape-section]")?.dataset.shapeSection ?? NaN);
    return Number.isNaN(i) ? null : i;
  };
  const adapter: CustomizeAdapter | null = active ? {
    label: "Deal page",
    detail: recipeTitle,
    describe: (el) => {
      const i = sectionOf(el);
      if (i === null || !page[i]) return null;
      const s = page[i], l = lens[i];
      const t: CustomizeTarget = {
        title: s.title ?? l?.title ?? s.component, purpose: l?.purpose, when: `${whenText(s)}${s.collapsed ? ", starts folded" : ""}`,
        reads: [...new Set([...(l?.settings ?? []).filter((x) => !x.includes(".")), ...(l?.actions.flatMap((a) => a.prompts) ?? [])].map(human))].slice(0, 5),
        does: (s.actions ?? []).map((a) => cleanLabel(a.label)),
        writes: [...new Set(l?.actions.flatMap((a) => a.writes).map(human) ?? [])].slice(0, 6),
      };
      return t;
    },
    submit: (text, el, pointed) => {
      const i = sectionOf(el);
      const s = i === null ? null : page[i];
      const target = s ? { component: s.component, title: s.title ?? lens[i!]?.title ?? s.component, nth: refOf(page, i!).nth ?? 0 } : null;
      const where = target?.title ?? (/"([^"]+)"/.exec(pointed.split("in the area headed")[1] ?? pointed)?.[1] ?? "Page");
      setJobs((js) => [...js, { id: `${Date.now()}-${js.length}`, request: text, where, pointed, status: "queued", target }]);
    },
    jobs,
    undo: () => setDrafts((d) => d.slice(0, -1)),
    reset: () => { setDrafts([]); setJobs([]); },
    kept: drafts.length,
    pending: jobs.some((j) => j.status === "queued" || j.status === "working"),
    saved,
    save: (accept) => void save(accept),
    stages: { options: [{ value: null, label: "this deal's stage" }, ...DEAL_STAGES.map((s) => ({ value: s, label: STAGE_NAMES[s] }))], value: stage, set: (v) => setStage(v as DealStage | null) },
  } : null;
  useCustomizeAdapter(adapter, [active, jobs, drafts, stage, markdown, base, recipeTitle, saved]);

  // Compare like with like: the recipe in force as the browser parses it, not as the server sent it.
  const baseKeys = useMemo(() => new Set((markdown ? parseRecipe(markdown).recipe.dealPage : base).map((s) => JSON.stringify(s))), [markdown, base]);
  const shape: Shape | null = active && customize ? {
    indexOf: (s) => page.indexOf(s),
    changed: (s) => drafts.length > 0 && !baseKeys.has(JSON.stringify(s)),
    fresh: (s) => lastFresh.current.has(JSON.stringify(s)),
    stage: customize.customizing ? stage : null,
  } : null;
  const provider = (children: ReactNode) => <ShapeContext.Provider value={shape}>{children}</ShapeContext.Provider>;
  return { page: active ? page : base, provider };
}

/** A section of the deal page: findable by customize mode's selector, outlined once this session's edits changed it. */
export function ShapeSection({ section, children }: { section: PageSection; children: ReactNode }) {
  const shape = useShape()!;
  // A section the page draws that its recipe doesn't list (an older recipe's header, products, splits and apps) can't change here.
  if (shape.indexOf(section) < 0) return <>{children}</>;
  const changed = shape.changed(section);
  return (
    <div data-shape-section={shape.indexOf(section)}
      className={cn("relative", changed && "rounded-sm outline outline-2 outline-offset-4 outline-violet-500/70", shape.fresh(section) && "animate-[pulse_1s_ease-out_2]")}>
      {changed && <span data-customize-chrome className="absolute -top-3 right-2 z-10 rounded-full bg-violet-600 px-2 py-px text-[10px] font-medium uppercase text-white shadow">customized</span>}
      {children}
    </div>
  );
}
