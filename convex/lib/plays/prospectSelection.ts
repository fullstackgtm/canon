import type { Prospect } from "./model";

export const FIRST_TOUCH_BATCH = 5;

export function visibleProspects(people: readonly Prospect[], search: string, buyersOnly = true): Prospect[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return people.filter((p) => (!buyersOnly || p.buyer) && words.every((word) => `${p.name} ${p.title ?? ""}`.toLowerCase().includes(word)));
}

export function selectProspects(picked: readonly string[], people: readonly Prospect[]): string[] {
  return [...new Set([...picked, ...people.flatMap((p) => p.contactId ? [p.contactId] : [])])];
}

/** Drafts every batch, then throws once with each distinct warning so one failed batch never strands the rest. */
export async function draftSelected(ids: readonly string[], draft: (ids: string[]) => Promise<{ error: string | null }>): Promise<void> {
  const unique = [...new Set(ids)];
  const errors = new Set<string>();
  for (let i = 0; i < unique.length; i += FIRST_TOUCH_BATCH) {
    const result = await draft(unique.slice(i, i + FIRST_TOUCH_BATCH));
    if (result.error) errors.add(result.error);
  }
  if (errors.size > 0) throw new Error([...errors].join(" "));
}

export function rankingInput(people: readonly Prospect[], product: string | null): string {
  return JSON.stringify({ product, people: people.filter((p) => p.buyer).map(({ key, name, title, why }) => ({ key, name, title, why })) });
}

/** Stable merge sort bounds paid pairwise comparisons to O(n log n). */
export async function rankBuyers(people: readonly Prospect[], preferLeft: (a: Prospect, b: Prospect) => Promise<boolean>): Promise<string[]> {
  async function sort(rows: Prospect[]): Promise<Prospect[]> {
    if (rows.length < 2) return rows;
    const mid = Math.floor(rows.length / 2);
    const left = await sort(rows.slice(0, mid));
    const right = await sort(rows.slice(mid));
    const merged: Prospect[] = [];
    let a = 0, b = 0;
    while (a < left.length && b < right.length) {
      if (await preferLeft(left[a], right[b])) merged.push(left[a++]);
      else merged.push(right[b++]);
    }
    return [...merged, ...left.slice(a), ...right.slice(b)];
  }
  return (await sort(people.filter((p) => p.buyer))).map((p) => p.key);
}
