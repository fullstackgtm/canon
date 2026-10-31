export const CANDIDATES_MAX = 500;
export type Candidate = { contactId: string; phone: string };

export async function pickCallable(
  candidates: readonly Candidate[],
  lines: number,
  called: ReadonlySet<string>,
  callable: (phone: string) => Promise<boolean>,
): Promise<{ lines: number; contactIds: string[]; held: number }> {
  const contactIds: string[] = [];
  let held = 0;
  const seen = new Set(called);
  for (const c of candidates.slice(0, CANDIDATES_MAX)) {
    if (seen.has(c.contactId)) continue;
    seen.add(c.contactId);
    if (await callable(c.phone)) contactIds.push(c.contactId);
    else held++;
    if (contactIds.length >= lines) break;
  }
  return { lines, contactIds, held };
}
