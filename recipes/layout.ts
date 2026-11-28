import { z } from "zod";
import { PAGE_COMPONENTS } from "./blocks.ts";
import { PAGE_ICONS } from "./pages.ts";
import { isPageAccent } from "./theme.ts";

export const PAGE_STYLE = z.strictObject({
  density: z.enum(["compact", "comfortable"]).optional(),
  surface: z.enum(["bordered", "raised", "flat"]).optional(),
  headerBand: z.enum(["none", "tinted", "brand"]).optional(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/).refine(isPageAccent, "accent needs 3:1 contrast on supported workspace surfaces").optional(),
});
export type PageStyle = z.infer<typeof PAGE_STYLE>;

export const CONTAINERS = {
  stack: z.object({}),
  columns: z.object({ widths: z.array(z.number().int().min(1).max(12)).min(2).max(3).optional(), gap: z.enum(["tight", "normal"]).optional() }),
  tabs: z.object({ labels: z.array(z.string().min(1).max(80)).min(1), variant: z.enum(["underline", "pills"]).optional() }),
  card: z.object({ title: z.string().min(1).max(80), icon: z.enum(PAGE_ICONS).optional(), tone: z.enum(["default", "muted", "accent"]).optional(), collapsible: z.boolean().optional() }),
} as const;
const ROOT_PROPS = z.strictObject({ style: PAGE_STYLE.optional() });
const containerSchema = (kind: ContainerKind, depth: number) => kind === "stack" && depth === 0 ? ROOT_PROPS : CONTAINERS[kind].strict();
export type ContainerKind = keyof typeof CONTAINERS;
export type ContainerProps = Partial<z.infer<typeof CONTAINERS.columns> & z.infer<typeof CONTAINERS.tabs> & z.infer<typeof CONTAINERS.card>>;
export type ContainerPropsPatch = { [K in keyof ContainerProps]: ContainerProps[K] | (K extends "gap" | "variant" | "icon" | "tone" ? null : never) };
export const CONTAINER_PATCHES = {
  stack: CONTAINERS.stack.strict(),
  columns: CONTAINERS.columns.partial().extend({ gap: CONTAINERS.columns.shape.gap.nullable() }).strict(),
  tabs: CONTAINERS.tabs.partial().extend({ variant: CONTAINERS.tabs.shape.variant.nullable() }).strict(),
  card: CONTAINERS.card.partial().extend({
    icon: CONTAINERS.card.shape.icon.nullable(),
    tone: CONTAINERS.card.shape.tone.nullable(),
  }).strict(),
};
export type LayoutNode = { section: string } | ({ kind: ContainerKind; id: string; children: LayoutNode[]; style?: PageStyle } & ContainerProps);
export type LayoutTree = Extract<LayoutNode, { kind: ContainerKind }>;
export const sectionKey = (ref: { component: string; nth?: number }) => `${ref.component}#${ref.nth ?? 0}`;

export function validateTree(tree: LayoutTree, keys: readonly string[]): void {
  const seen = new Set<string>(), ids = new Set<string>();
  let count = 0;
  const visit = (node: LayoutNode, depth: number) => {
    if (++count > 200 || depth > 12) throw new Error("layout is too large or too deep");
    if ("section" in node) {
      if (!keys.includes(node.section) || seen.has(node.section)) throw new Error(`layout section ${node.section} is missing or repeated`);
      seen.add(node.section);
      return;
    }
    if (!/^[a-zA-Z][\w-]*$/.test(node.id) || ids.has(node.id)) throw new Error("layout container ids must be unique names");
    ids.add(node.id);
    const props = Object.fromEntries(Object.entries(node).filter(([k]) => !["kind", "id", "children"].includes(k)));
    containerSchema(node.kind, depth).parse(props);
    if (!node.children.length && !(depth === 0 && node.style)) throw new Error("a container needs children");
    if (node.kind === "columns" && (node.children.length < 2 || node.children.length > 3 || (node.widths && node.widths.length !== node.children.length))) throw new Error("columns needs 2–3 children and one width per child");
    if (node.kind === "tabs" && node.labels?.length !== node.children.length) throw new Error("tabs needs one label per child");
    node.children.forEach((child) => visit(child, depth + 1));
  };
  if (tree.kind !== "stack") throw new Error("layout root must be stack");
  visit(tree, 0);
}

/** Two spaces per level. Container props are one JSON object, so labels can contain punctuation. */
export function parseLayout(text: string, keys: readonly string[]): LayoutTree {
  const parents: LayoutTree[] = [];
  let root: LayoutTree | undefined;
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const m = /^( *)(\S+)(?: (\S+))?(?: (\{.*\}))?$/.exec(line);
    if (!m || m[1].length % 2) throw new Error("layout uses two-space indentation");
    const depth = m[1].length / 2;
    let node: LayoutNode;
    if (m[2] === "section" && m[3] && !m[4]) node = { section: m[3] };
    else if (Object.hasOwn(CONTAINERS, m[2]) && m[3]) {
      const kind = m[2] as ContainerKind;
      const props = containerSchema(kind, depth).parse(m[4] ? JSON.parse(m[4]) : {});
      node = { ...props, kind, id: m[3], children: [] };
    }
    else throw new Error("layout lines are section component#nth or container id {props}");
    if (depth === 0) {
      if (root || "section" in node) throw new Error("layout needs one stack root");
      root = node;
    } else {
      if (!parents[depth - 1]) throw new Error("layout indentation skips a level");
      parents[depth - 1].children.push(node);
    }
    parents.length = depth;
    if (!("section" in node)) parents[depth] = node;
  }
  if (!root) throw new Error("layout needs a stack root");
  validateTree(root, keys);
  return root;
}
export function printLayout(tree: LayoutNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  if ("section" in tree) return `${pad}section ${tree.section}`;
  const { kind, id, children, ...props } = tree;
  const line = `${pad}${kind} ${id}${Object.keys(props).length ? ` ${JSON.stringify(props)}` : ""}`;
  return [line, ...children.map((c) => printLayout(c, depth + 1))].join("\n");
}
export function pageKeys(page: readonly { component: string }[]): string[] {
  return page.map((s, i) => sectionKey({ component: s.component, nth: page.slice(0, i).filter((x) => x.component === s.component).length }));
}
export function completeTree(tree: LayoutTree | undefined, keys: readonly string[]): LayoutTree {
  const used = new Set<string>();
  const visit = (n: LayoutNode) => { if ("section" in n) used.add(n.section); else n.children.forEach(visit); };
  if (tree) visit(tree);
  return { ...(tree ?? { kind: "stack", id: "root" }), children: [...(tree?.children ?? []), ...keys.filter((k) => !used.has(k)).map((section) => ({ section }))] };
}
export const LAYOUT_GRAMMAR = {
  containers: Object.fromEntries(Object.entries(CONTAINERS).map(([kind, schema]) => [kind, z.toJSONSchema(schema.strict())])),
  root: z.toJSONSchema(ROOT_PROPS),
  section: `${PAGE_COMPONENTS.join("|")}#nth`, indentation: 2,
};

export const PAGE_STYLE_GUIDE = [
  'setPageStyle {object,style} replaces the page overrides (omit a key to inherit, or use {} to reset). Use density compact|comfortable, surface bordered|raised|flat, headerBand none|tinted|brand, and optional lowercase #rrggbb accent with at least 3:1 contrast on supported workspace surfaces (e.g. #0176d3).',
  `setContainerProps {object,container,props} patches container props. Cards take icon (${PAGE_ICONS.join(", ")}), tone default|muted|accent and collapsible (boolean). Columns take gap tight|normal. Tabs take variant underline|pills. Use null to clear an icon, tone, gap or variant.`,
].join(" ");
