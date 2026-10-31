import { Fragment, type ReactNode } from "react";
import { BESIDE, HOLDS, shows, type ComponentOf, type PageComponent, type PageObject, type PageSection, type PageSpec } from "../../../recipes";
import type { DealStage } from "../../../convex/lib/plays/model";
import { ShapeSection, useShape } from "./shape/shape-mode";

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
export function PageSections<O extends PageObject>({ object, page, stage, renderers }: { object: O; page: PageSpec; stage: DealStage | null; renderers: Renderers<ComponentOf<O>> }) {
  const render = renderers as unknown as Record<PageComponent, (s: PageSection, inner: Inner) => ReactNode>;
  const shape = useShape();
  const shownAt = shape?.stage ?? stage;
  // The types make every page supply each of its components; a caller drawing part of a page (a test, a preview) may not.
  const drawn = ({ section, held }: Entry) => render[section.component]?.(section, { held: held ? render[held.component]?.(held, { within: section.component, stage: shownAt }) : undefined, stage: shownAt }) ?? null;
  // Shape mode (prototype) says what each section does above it; otherwise a section draws as it is.
  const draw = (entry: Entry) => (shape ? <ShapeSection section={entry.section}>{drawn(entry)}</ShapeSection> : drawn(entry));
  const rows = rowsOf(entriesOf(page.filter((s) => shows(s, shownAt))), BESIDE[object]).flatMap((row) => ("left" in row && !row.right.length ? row.left : [row]));
  return (
    <div data-shape-page={shape ? "" : undefined} className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {rows.map((row, i) => "section" in row ? <Fragment key={i}>{draw(row)}</Fragment> : (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">{row.left.map((s, j) => <Fragment key={j}>{draw(s)}</Fragment>)}</div>
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">{row.right.map((s, j) => <Fragment key={j}>{draw(s)}</Fragment>)}</div>
        </div>
      ))}
    </div>
  );
}
