import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apply, describeLayout, type Layout, type LayoutOp, type SectionRef } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import type { PageObject } from "../recipes/kernel.ts";
import { sectionDrop } from "../src/app/dashboard/customization/layout-drops.ts";

const read = (dir: string) => readFileSync(new URL(`../recipes/${dir}/recipe.md`, import.meta.url), "utf8");
const RECIPES = { enterprise: read("fsgtm-enterprise-deal"), velocity: read("fsgtm-velocity-deal"), base: read("canon-base") };
const layoutOf = (md: string, object: PageObject) => {
  const l = describeLayout(md, object);
  assert.ok(!("error" in l), "error" in l ? l.error : "");
  return l as Layout;
};
const edited = (md: string, op: LayoutOp) => {
  const r = apply(md, op);
  assert.ok("markdown" in r, `${JSON.stringify(op)}: ${"error" in r ? r.error : ""}`);
  return r.markdown;
};

/** The lines that differ between two texts, as the window between their common first and last lines. */
function window(a: string, b: string) {
  const x = a.split("\n"), y = b.split("\n");
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return { was: x.slice(p, x.length - s), now: y.slice(p, y.length - s) };
}

const withoutFields = (md: string) => md.replace(/```fields\n[\s\S]*?\n```/g, "```fields```");

/** A section as the oracle tracks it: what the page draws, by identity, so the expected page is plain array edits. */
type Row = { component: string; title: string; collapsed: boolean; when: unknown; fields?: readonly string[]; actions: Array<{ id: string; label: string; panel?: string; shows?: string; enabled?: string }> };
const rows = (l: Layout): Row[] => l.sections.map((s) => ({
  component: s.component, title: s.title, collapsed: s.collapsed, when: s.when, ...(s.fields ? { fields: s.fields } : {}),
  actions: [...s.actions].sort((a, b) => (a.panel ?? "").localeCompare(b.panel ?? "")).map((a) => ({ id: a.id, label: a.label, ...(a.panel ? { panel: a.panel } : {}), ...(a.shows ? { shows: a.shows } : {}), ...(a.enabled ? { enabled: a.enabled } : {}) })),
}));
const refIn = (page: readonly Row[], row: Row): SectionRef => ({ component: row.component as SectionRef["component"], nth: page.slice(0, page.indexOf(row)).filter((r) => r.component === row.component).length });
const moved = <T>(list: readonly T[], item: T, before: T | null) => { const rest = list.filter((x) => x !== item); const at = before === null ? rest.length : rest.indexOf(before); return [...rest.slice(0, at), item, ...rest.slice(at)]; };

/** mulberry32: a fixed seed picks the same targets on every run. */
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

/** `exact: false` for an inverse that re-adds a removed line: it lands where recipes write that key, which matches the original bytes only when its block kept that order. */
type Case = { op: LayoutOp; expect: Row[]; inverse: ((after: Layout) => LayoutOp) | null; exact?: boolean; span: (w: ReturnType<typeof window>, was: string, now: string) => boolean; branch: string };

/** Every edit of each kind to `object`'s page, each with the page it should give, its inverse and the branch it takes. */
function cases(md: string, object: PageObject): Case[] {
  const view = layoutOf(md, object);
  const page = rows(view);
  const ref = (r: Row) => refIn(page, r);
  const out: Case[] = [];
  const oneLine = (w: ReturnType<typeof window>) => w.was.length === 1 && w.now.length === 1;
  const reorder = (w: ReturnType<typeof window>) => w.was.length === w.now.length && [...w.was].sort().join("\n") === [...w.now].sort().join("\n");
  const with_ = (r: Row, patch: Partial<Row>) => page.map((x) => (x === r ? { ...x, ...patch } : x));
  const byArea = (list: Row["actions"]) => [...list].sort((x, y) => (x.panel ?? "").localeCompare(y.panel ?? ""));
  for (const s of page) {
    const next = page[page.indexOf(s) + 1] ?? null;
    for (const before of [null, ...page.filter((r) => r !== s)]) {
      const after = moved(page, s, before);
      out.push({
        op: { op: "moveSection", object, section: ref(s), before: before && ref(before) }, expect: after, span: reorder, branch: `moveSection:${before ? "before" : "last"}`,
        inverse: () => ({ op: "moveSection", object, section: refIn(after, s), before: next && refIn(after, next) }),
      });
    }
    out.push({ op: { op: "setCollapsed", object, section: ref(s), collapsed: !s.collapsed }, expect: with_(s, { collapsed: !s.collapsed }), span: oneLine, branch: `setCollapsed:${!s.collapsed}`, inverse: () => ({ op: "setCollapsed", object, section: ref(s), collapsed: s.collapsed }) });
    if (object === "deal") for (const when of [null, { stage: ["case"] }, { notStage: ["in", "close"] }] as const) {
      out.push({ op: { op: "setWhen", object, section: ref(s), when }, expect: with_(s, { when }), span: oneLine, branch: `setWhen:${s.when ? "had" : "none"}:${when ? "set" : "clear"}`, inverse: () => ({ op: "setWhen", object, section: ref(s), when: s.when as never }) });
    }
    out.push({ op: { op: "renameSection", object, section: ref(s), title: "Renamed" }, expect: with_(s, { title: "Renamed" }), span: oneLine, branch: "renameSection", inverse: () => ({ op: "renameSection", object, section: ref(s), title: s.title }) });
    out.push({ op: { op: "removeSection", object, section: ref(s) }, expect: page.filter((r) => r !== s), span: (w) => !w.now.length, branch: "removeSection", inverse: null });
    for (const a of s.actions) {
      const area = s.actions.filter((x) => x.panel === a.panel);
      const after = area[area.indexOf(a) + 1] ?? null;
      for (const target of [null, ...area.filter((x) => x !== a)]) {
        out.push({
          op: { op: "moveAction", object, section: ref(s), action: a.id, before: target && target.id }, expect: with_(s, { actions: byArea([...s.actions.filter((x) => x.panel !== a.panel), ...moved(area, a, target)]) }), span: reorder,
          branch: `moveAction:${target ? "before" : "last"}${a.panel ? ":panel" : ""}`, inverse: () => ({ op: "moveAction", object, section: ref(s), action: a.id, before: after && after.id }),
        });
      }
      const changed = (patch: Partial<Row["actions"][number]> | null) => with_(s, { actions: s.actions.flatMap((x) => (x !== a ? [x] : patch ? [patch as typeof x] : [])) });
      out.push({ op: { op: "setActionLabel", object, section: ref(s), action: a.id, label: "Relabelled" }, expect: changed({ ...a, label: "Relabelled" }), span: oneLine, branch: "setActionLabel", inverse: () => ({ op: "setActionLabel", object, section: ref(s), action: a.id, label: a.label }) });
      out.push({ op: { op: "removeAction", object, section: ref(s), action: a.id }, expect: changed(null), span: (w) => !w.now.length && w.was.filter((l) => l.startsWith("```")).length === 2, branch: "removeAction", inverse: null });
      for (const shows of [null, "canEdit"]) for (const enabled of [undefined, null, "canEdit"]) {
        const kept = enabled === undefined ? a.enabled : enabled;
        const expected = Object.fromEntries(Object.entries({ ...a, shows, enabled: kept }).filter(([, v]) => v != null)) as typeof a;
        out.push({
          op: { op: "setActionCondition", object, section: ref(s), action: a.id, shows, enabled }, expect: changed(expected),
          span: (w) => w.was.length <= 2 && w.now.length <= 2 && [...w.was, ...w.now].every((l) => /^(shows|enabled): /.test(l)),
          branch: `setActionCondition:${a.shows ? "had" : "none"}:${shows ? "set" : "clear"}`, exact: !((!shows && a.shows) || (enabled === null && a.enabled)),
          inverse: () => ({ op: "setActionCondition", object, section: ref(s), action: a.id, shows: a.shows ?? null, ...(enabled === undefined ? {} : { enabled: a.enabled ?? null }) }),
        });
      }
    }
    for (const add of view.sections[page.indexOf(s)].addable) {
      const base = add.runs.slice(add.runs.indexOf(".") + 1);
      const id = page.some((x) => x.actions.some((y) => y.id === base)) ? `${base}2` : base;
      const first = !s.actions.some((x) => x.panel === add.panel);
      out.push({
        op: { op: "addAction", object, section: ref(s), runs: add.runs, ...(add.panel ? { panel: add.panel } : {}), label: "Added" }, span: (w) => !w.was.length,
        // The first action of a panel the text has no heading for brings the heading, which its removal leaves.
        exact: !(first && add.panel),
        expect: with_(s, { actions: byArea([...s.actions, { id, label: "Added", ...(add.panel ? { panel: add.panel } : {}) }]) }),
        branch: `addAction:${first ? "first" : "beside"}${add.panel ? ":panel" : ""}`, inverse: () => ({ op: "removeAction", object, section: ref(s), action: id }),
      });
    }
    for (const field of s.fields ?? []) {
      const after = s.fields![s.fields!.indexOf(field) + 1] ?? null;
      for (const to of page.filter((r) => r.fields)) for (const target of [null, ...to.fields!.filter((f) => f !== field)]) {
        out.push({
          op: { op: "moveField", object, field, to: ref(to), before: target }, span: (_, a, b) => withoutFields(a) === withoutFields(b),
          expect: page.map((x) => (x.fields ? { ...x, fields: x === to ? moved(x.fields, field, target) : x.fields.filter((f) => f !== field) } : x)),
          branch: `moveField:${s === to ? "within" : "across"}`, inverse: () => ({ op: "moveField", object, field, to: ref(s), before: after }),
        });
      }
    }
  }
  for (const component of view.addable.filter((c) => c !== "fields")) for (const before of [null, page[0]]) {
    const added: Row = { component, title: "New", collapsed: false, when: null, actions: [] };
    const expect = moved([...page, added], added, before);
    out.push({ op: { op: "addSection", object, component, title: "New", before: before && ref(before) }, expect, span: (w) => !w.was.length, branch: "addSection", inverse: () => ({ op: "removeSection", object, section: refIn(expect, added) }) });
  }
  return out;
}

test("every layout edit reparses to the page it names, rewrites only its span, and its inverse restores the original bytes", () => {
  const pick = rng(20261014);
  const branches = new Set<string>();
  let accepted = 0, refused = 0, inverses = 0;
  // Velocity without two of its buttons, so a button can be added beside others, in a section and in the draft panel.
  const plan = { component: "plan" } as const;
  const trimmed = edited(edited(RECIPES.velocity, { op: "removeAction", object: "deal", section: plan, action: "redraft" }), { op: "removeAction", object: "deal", section: plan, action: "stepDue" });
  // Enterprise with its action ids quoted, as the parser reads them too; canon-base with a plan, which has no draft panel heading.
  const quoted = RECIPES.enterprise.replace(/^```action\nid: (\w+)$/gm, '```action\nid: "$1"');
  const planned = edited(RECIPES.base, { op: "addSection", object: "deal", component: "plan", title: "Next action", before: null });
  const pages: Array<[string, string, PageObject]> = [
    ["enterprise, ids quoted", quoted, "deal"], ["base with a plan", planned, "deal"], ["velocity", RECIPES.velocity, "deal"], ["velocity trimmed", trimmed, "deal"], ["base", RECIPES.base, "deal"], ["base", RECIPES.base, "account"], ["base", RECIPES.base, "contact"],
  ];
  for (const [name, md, object] of pages) {
    const all = cases(md, object);
    const branchesHere = [...new Set(all.map((c) => c.branch))].filter((b) => !branches.has(b));
    // One edit a branch, on the first page that has it, picked by the seed: the smallest sweep that takes every branch.
    for (const c of branchesHere.map((b) => { const of = all.filter((x) => x.branch === b); return of[Math.floor(pick() * of.length)]; })) {
      const r = apply(md, c.op);
      const what = `${name} ${JSON.stringify(c.op)}`;
      if ("error" in r) { refused++; continue; }
      accepted++;
      branches.add(c.branch);
      assert.deepEqual(parseRecipe(r.markdown).problems, [], what);
      const after = layoutOf(r.markdown, object);
      assert.deepEqual(rows(after), c.expect, what);
      const w = window(md, r.markdown);
      if (r.markdown !== md) assert.ok(c.span(w, md, r.markdown), `${what} touched ${JSON.stringify(w).slice(0, 400)}`);
      if (c.inverse) {
        inverses++;
        const back = edited(r.markdown, c.inverse(after));
        if (c.exact === false) assert.deepEqual(rows(layoutOf(back, object)), rows(layoutOf(md, object)), `${what} then its inverse`);
        else assert.equal(back, md, `${what} then its inverse`);
      }
    }
  }
  assert.deepEqual([...branches].sort(), [
    "addAction:beside", "addAction:beside:panel", "addAction:first", "addAction:first:panel", "addSection", "moveAction:before", "moveAction:before:panel", "moveAction:last", "moveAction:last:panel",
    "moveField:across", "moveField:within", "moveSection:before", "moveSection:last", "removeAction", "removeSection", "renameSection", "setActionCondition:had:clear", "setActionCondition:had:set",
    "setActionCondition:none:clear", "setActionCondition:none:set", "setActionLabel", "setCollapsed:false", "setCollapsed:true", "setWhen:had:clear", "setWhen:had:set", "setWhen:none:clear", "setWhen:none:set",
  ]);
  assert.deepEqual({ accepted, refused, inverses }, { accepted: 27, refused: 0, inverses: 25 });
});

test("the layout requests in scripts/layout-skill-sufficiency.ts, made as edits, give the recipe its hand-written changes give", () => {
  const md = RECIPES.velocity;
  // The script's own edits: each swaps one exact string of Velocity's recipe.md.
  const swap = (text: string, from: string, to: string) => { assert.equal(text.split(from).length, 2, from); return text.replace(from, to); };
  const ACTIVITY = '### Activity {section=touches when="stage != in" collapsed=true}';
  const NEXT = '### Next action {section=plan when="stage != in"}';
  const activity = md.slice(md.indexOf(`${ACTIVITY}\n`), md.indexOf("\n### ", md.indexOf(ACTIVITY)) + 1);
  const requests: Array<[string, string, LayoutOp]> = [
    ["move Activity above Next action", swap(swap(md, activity, ""), `${NEXT}\n`, `${activity}${NEXT}\n`), { op: "moveSection", object: "deal", section: { component: "touches" }, before: { component: "plan" } }],
    ["hide the Redraft button", swap(md, '```action\nid: redraft\nlabel: Redraft\nruns: kernel.redraftStep\nprompt: drafts.prompt\nshows: draft.by == "keeper"\n```\n\n', ""), { op: "removeAction", object: "deal", section: { component: "plan" }, action: "redraft" }],
    ["rename Check now to Run the keeper", swap(md, "label: Check now\n", "label: Run the keeper\n"), { op: "setActionLabel", object: "deal", section: { component: "keeper" }, action: "checkNow", label: "Run the keeper" }],
  ];
  const compiled = (text: string) => JSON.stringify(parseRecipe(text).recipe, (k, v) => (k === "line" ? undefined : v));
  for (const [request, byHand, op] of requests) {
    const byEdit = edited(md, op);
    assert.equal(compiled(byEdit), compiled(byHand), request);
    assert.equal(byEdit, byHand, `${request}: the same bytes`);
  }
  // The visual mode's drag of Activity onto the top half of Next action asks for the same edit.
  const page = layoutOf(md, "deal");
  const at = (c: string) => page.sections.findIndex((s) => s.component === c);
  assert.equal(edited(md, sectionDrop(page, at("touches"), at("plan"))!), requests[0][1], "dragging Activity above Next action");
  assert.equal(sectionDrop(page, at("touches"), at("touches") + 1), null, "a drop where it already is changes nothing");
});

test("an edit that would break the recipe or leave its page is refused, and describeLayout lists what a page can add", () => {
  const plan = { component: "plan" } as const;
  const refusals: Array<[string, string, LayoutOp]> = [
    ["the fanOut section holds the recipe's fanOut logic", RECIPES.velocity, { op: "removeSection", object: "deal", section: { component: "fanOut" } }],
    ["a label names a value its action lacks", RECIPES.velocity, { op: "setActionLabel", object: "deal", section: { component: "keeper" }, action: "checkNow", label: "Check as <role>" }],
    ["a condition reads what the action can't", RECIPES.velocity, { op: "setActionCondition", object: "deal", section: plan, action: "sendEmail", enabled: "nope" }],
    ["an action sits only where the kernel places it", RECIPES.velocity, { op: "addAction", object: "deal", section: { component: "stageRail" }, runs: "kernel.checkNow" }],
    ["a panel action moves only among the panel's", RECIPES.velocity, { op: "moveAction", object: "deal", section: plan, action: "redraft", before: "markDone" }],
    ["every field still shows", RECIPES.base, { op: "removeSection", object: "deal", section: { component: "fields", nth: 3 } }],
    ["a fields section keeps a field", RECIPES.base, { op: "moveField", object: "deal", field: "description", to: { component: "fields" }, before: null }],
    ["a title is one line", RECIPES.base, { op: "renameSection", object: "contact", section: { component: "header" }, title: "Two\nlines" }],
  ];
  for (const [why, md, op] of refusals) assert.ok("error" in apply(md, op), why);
  const contact = layoutOf(RECIPES.base, "contact");
  assert.deepEqual(contact.sections.map((s) => [s.component, s.title, s.actions.map((a) => a.id).join(" "), s.addable.map((a) => a.runs).join(" ")]), [
    ["header", "Contact", "findEmail findPhone restore archive merge", ""],
    ["fields", "Details", "editField", ""],
    ["aiFields", "AI fields", "", "kernel.runAiField"],
    ["related", "Related", "addCompany makePrimary removeCompany", ""],
    ["callPanel", "Calls", "call hangup logCall", ""],
    ["composeEmail", "Email", "saveDraft send", ""],
    ["timeline", "Timeline", "logActivity", ""],
    ["history", "History", "", ""],
  ]);
  assert.deepEqual(contact.addable, ["fields"]);
  assert.deepEqual(layoutOf(RECIPES.velocity, "deal").sections.find((s) => s.component === "fanOut"), {
    ref: { component: "fanOut", nth: 0 }, component: "fanOut", title: "Get a reply", collapsed: false, when: { stage: ["in"] }, addable: [],
    actions: [
      { id: "researchPeople", runs: "kernel.researchPeople", label: "Research <n> {person|people}", shows: "canEdit", enabled: 'people.research.status != "running"' },
      { id: "draftFirstTouches", runs: "kernel.firstTouches", label: "Draft first touches for <n>", shows: "canEdit && picked.count > 0" },
      { id: "rowDraft", runs: "kernel.firstTouch", label: "Draft", shows: "canEdit" },
      { id: "addToCanon", runs: "kernel.addToCanon", label: "Add to Canon", shows: "canEdit" },
    ],
  });
});
