/**
 * What a customize-mode instruction is about when the person pointed at something a section's component draws itself
 * (a field label, a search box, a count). Pure, so the deterministic refusals in convex/pageCustomize.ts are tested
 * without a model (tests/pageEditEvals.test.ts).
 */

/** How the browser names a control a section's component draws itself (customize-mode.tsx, pointedAt). */
export const DRAWN = "a control or text the section's component draws";

/** The drawn control's own text, from the browser's description of what was pointed at. */
export const drawnText = (pointed: string | undefined) => (pointed?.startsWith(DRAWN) ? /reading "([^"]*)"/.exec(pointed)?.[1] ?? "" : null);

/**
 * Whether a model's rename of the pointed-at section should be refused because the person meant the drawn control.
 * The request says it's about the section when it names the section, its heading or title, or the section's current
 * title; "change title to Overview" means the section even when the click landed on a field row inside it. It says
 * it's about the control when it names the control's own text ("rename Opportunity name to Deal name"), or gives only
 * new words ("rename this to X", "call it X"), since "this" is what was pointed at.
 */
export function refuseSectionRename(request: string, pointed: string | undefined, sectionTitle: string): string | null {
  const what = drawnText(pointed);
  if (what === null) return null;
  const said = request.toLowerCase();
  // The control's own text usually starts with its label; a field row reads "Opportunity nameSpeedeon - …".
  const label = what.split(/(?<=[a-z])(?=[A-Z])/)[0]?.trim().toLowerCase() ?? "";
  // Only what's being renamed counts, not the new words: "change section title to Opportunity name" is the section.
  const subject = said.split(/\s(?:to|into|as)\s/)[0] ?? said;
  if (label.length >= 3 && subject.includes(label)) return what;
  if (/\b(section|heading|header|title)\b/.test(said)) return null;
  if (sectionTitle && said.includes(sectionTitle.toLowerCase())) return null;
  return what;
}
