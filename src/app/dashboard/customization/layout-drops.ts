/**
 * What each gesture in the visual layout mode asks of recipes/md/edit.ts: a drag, an arrow button or a stage chip
 * turned into the one LayoutOp it means. Pure, so a test checks a drag against `apply` without a browser.
 */
import { DEAL_STAGES, type DealStage } from "../../../../convex/lib/plays/model.ts";
import type { Layout, LayoutOp, LayoutSection, When } from "../../../../recipes/md/edit.ts";
import type { PageObject } from "../../../../recipes/kernel.ts";

/** Where a dragged thing lands: before the item at this index, or last when it is the list's length. */
export type Slot = number;

/** The section at `from` dropped at `slot`, or null when that leaves it where it is. */
export function sectionDrop(layout: Layout, from: number, slot: Slot): LayoutOp | null {
  if (slot === from || slot === from + 1) return null;
  const before = slot >= layout.sections.length ? null : layout.sections[slot].ref;
  return { op: "moveSection", object: layout.object, section: layout.sections[from].ref, before };
}

type Action = LayoutSection["actions"][number];
/** A section's buttons in one area, its own or a panel's: a button moves only among its area's. */
export const areaOf = (section: LayoutSection, panel: Action["panel"]) => section.actions.filter((a) => a.panel === panel);

/** The button `id` dropped at `slot` among its area's buttons, or null when that leaves it where it is. */
export function actionDrop(object: PageObject, section: LayoutSection, id: string, slot: Slot): LayoutOp | null {
  const action = section.actions.find((a) => a.id === id);
  if (!action) return null;
  const area = areaOf(section, action.panel);
  const from = area.indexOf(action);
  if (slot === from || slot === from + 1) return null;
  return { op: "moveAction", object, section: section.ref, action: id, before: slot >= area.length ? null : area[slot].id };
}

/** `field` dropped into the fields section at `to`, at `slot` among its fields. */
export function fieldDrop(layout: Layout, field: string, to: number, slot: Slot): LayoutOp | null {
  const fields = layout.sections[to].fields ?? [];
  const from = fields.indexOf(field);
  if (from >= 0 && (slot === from || slot === from + 1)) return null;
  const rest = fields.filter((f) => f !== field);
  const at = from >= 0 && slot > from ? slot - 1 : slot;
  return { op: "moveField", object: layout.object, field, to: layout.sections[to].ref, before: at >= rest.length ? null : rest[at] };
}

/** The stages a section shows in. */
export const shownIn = (when: When | null): DealStage[] =>
  !when ? [...DEAL_STAGES] : "stage" in when ? DEAL_STAGES.filter((s) => when.stage.includes(s)) : DEAL_STAGES.filter((s) => !when.notStage.includes(s));

/**
 * The `when` that shows a section in `shown`, written the way it is already written (show in or hide in), so a chip
 * changes as little text as it can; a section with none takes the shorter list. Null for every stage.
 */
export function whenFor(was: When | null, shown: readonly DealStage[]): When | null {
  const stage = DEAL_STAGES.filter((s) => shown.includes(s));
  const notStage = DEAL_STAGES.filter((s) => !shown.includes(s));
  if (!notStage.length) return null;
  const hide = was ? "notStage" in was : notStage.length <= stage.length;
  return hide ? { notStage } : { stage };
}
