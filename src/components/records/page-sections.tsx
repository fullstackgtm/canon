import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Fragment, useContext, type CSSProperties, type ReactNode } from "react";
import { MODULE_ICONS } from "@/components/shell/nav";
import { pageAccentVars } from "../../../recipes/theme";
import { completeTree, pageKeys, type LayoutNode, BESIDE, HOLDS, shows, type ComponentOf, type PageComponent, type PageObject, type PageSection, type PageSpec } from "../../../recipes";
import type { DealStage } from "../../../convex/lib/plays/model";
import { LayoutTreeContext, ShapeSection, useShape } from "./shape/shape-mode";

export type SectionOf<K extends PageComponent> = Extract<PageSection, { component: K }>;
/**
 * How each kernel component of a page draws its section. `held` is the section it holds, already drawn, to place
 * inside it (HOLDS); `within` is the component holding this one, when one does; `stage` is the stage the page shows.
 */
export type Inner = { held?: ReactNode; within?: PageComponent; stage?: DealStage | null };
export type Renderers<C extends PageComponent = ComponentOf<"deal">> = { [K in C]: (section: SectionOf<K>, inner: Inner) => ReactNode };

type Entry = { section: PageSection; held: PageSection | null };
type Row = Entry | { left: Entry[]; right: Entry[] };

/** Each section with the one it holds, when the next section is one it holds. */
function entriesOf(sections: readonly PageSection[]): Entry[] {
  const out: Entry[] = [];
  for (const section of sections) {
    const last = out.at(-1);
    if (last && !last.held && HOLDS[last.section.component]?.includes(section.component)) last.held = section;
    else out.push({ section, held: null });
  }
  return out;
}

/** A run of field sections, then the sections that read beside them, shares two columns, so the record reads beside its log. */
function rowsOf(entries: readonly Entry[], beside: readonly PageComponent[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    const last = rows.at(-1);
    const { component } = entry.section;
    const column = component === "fields" ? "left" : beside.includes(component) ? "right" : null;
    if (column && last && "left" in last && (column === "right" || !last.right.length)) last[column].push(entry);
    else if (column === "left") rows.push({ left: [entry], right: [] });
    else rows.push(entry);
  }
  return rows;
}

/** The page's sections that show at `stage`, in the recipe's order, each drawn by its component's renderer. */
export function PageSections<O extends import("../../../recipes/blocks").PageKind>({ object, page, stage, renderers }: { object: O; page: PageSpec; stage: DealStage | null; renderers: Renderers<ComponentOf<O>> }) {
  const render = renderers as unknown as Record<PageComponent, (s: PageSection, inner: Inner) => ReactNode>;
  const shape = useShape();
  const tree = useContext(LayoutTreeContext);
  const style = tree?.style;
  const appearance = {
    "data-density": style?.density,
    "data-surface": style?.surface,
    "data-header-band": style?.headerBand,
    style: pageAccentVars(style?.accent) as CSSProperties | undefined,
  };
  const shownAt = shape?.stage ?? stage;
  // The types make every page supply each of its components; a caller drawing part of a page (a test, a preview) may not.
  const drawn = ({ section, held }: Entry) => render[section.component]?.(section, { held: held ? render[held.component]?.(held, { within: section.component, stage: shownAt }) : undefined, stage: shownAt }) ?? null;
  // Shape mode (prototype) says what each section does above it; otherwise a section draws as it is.
  const draw = (entry: Entry) => (shape ? <ShapeSection section={entry.section}>{drawn(entry)}</ShapeSection> : drawn(entry));
  if (tree?.children.length) {
    const keys = pageKeys(page);
    const relatedIn = (node: LayoutNode): string[] => {
      if (!("section" in node)) return node.children.flatMap(relatedIn);
      const section = page[keys.indexOf(node.section)];
      return section?.component === "relatedList" && shows(section, shownAt) ? [section.props.relationship] : [];
    };
    const drawNode = (node: LayoutNode): ReactNode => {
      if ("section" in node) {
        const section = page[keys.indexOf(node.section)];
        return section && shows(section, shownAt) ? draw({ section, held: null }) : null;
      }
      const children = node.children.map((child, i) => <div className="min-w-0" key={i}>{drawNode(child)}</div>);
      if (node.kind === "columns") return <div data-layout="columns" data-gap={node.gap} className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[var(--layout-columns)]" style={{ "--layout-columns": (node.widths ?? node.children.map(() => 1)).map((w) => `minmax(0,${w}fr)`).join(" ") } as CSSProperties}>{children}</div>;
      if (node.kind === "tabs") return <Tabs data-layout="tabs" data-tab-style={node.variant} defaultValue="0" className="min-w-0"><TabsList variant={node.variant === "underline" ? "line" : "default"} className="h-auto max-w-full flex-wrap">{node.labels!.map((label, i) => <TabsTrigger key={i} value={String(i)} data-related-tab={relatedIn(node.children[i]).join(" ") || undefined}>{label}</TabsTrigger>)}</TabsList>{children.map((child, i) => <TabsContent key={i} value={String(i)} className="min-w-0">{child}</TabsContent>)}</Tabs>;
      if (node.kind === "card") {
        const Icon = node.icon && MODULE_ICONS[node.icon];
        const title = <>{Icon && <Icon aria-hidden className="mr-2 inline size-4 align-text-bottom text-primary" />}{node.title}</>;
        const body = <div className="space-y-4 px-6">{children}</div>;
        const className = "min-w-0 bg-card text-card-foreground rounded-xl border py-6 shadow-sm";
        return node.collapsible
          ? <details open data-layout="card" data-tone={node.tone} className={className}><summary className="cursor-pointer px-6 font-semibold leading-none">{title}</summary><div className="mt-6">{body}</div></details>
          : <section data-layout="card" data-tone={node.tone} className={`${className} flex flex-col gap-6`}><h2 className="px-6 font-semibold leading-none">{title}</h2>{body}</section>;
      }
      return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">{children}</div>;
    };
    return <div data-record-sections data-shape-page={shape ? "" : undefined} {...appearance} className="min-w-0">{drawNode(completeTree(tree, keys))}</div>;
  }
  const rows = rowsOf(entriesOf(page.filter((s) => shows(s, shownAt))), (BESIDE[object as PageObject] ?? [])).flatMap((row) => ("left" in row && !row.right.length ? row.left : [row]));
  return (
    <div data-record-sections data-shape-page={shape ? "" : undefined} {...appearance} className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {rows.map((row, i) => "section" in row ? <Fragment key={i}>{draw(row)}</Fragment> : (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">{row.left.map((s, j) => <Fragment key={j}>{draw(s)}</Fragment>)}</div>
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">{row.right.map((s, j) => <Fragment key={j}>{draw(s)}</Fragment>)}</div>
        </div>
      ))}
    </div>
  );
}
