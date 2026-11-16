import { TODAY, todayOffset } from "../../../../modules/kernel/automation.ts";

export type DateValueKind = "today" | "future" | "past" | "date";

export function dateValueControl(value: string): { kind: DateValueKind; days: number } {
  const offset = todayOffset(value);
  return { kind: offset === null ? "date" : offset === 0 ? "today" : offset > 0 ? "future" : "past", days: Math.abs(offset ?? 0) || 1 };
}

export function dateControlValue(kind: DateValueKind, days: string): string | null {
  if (kind === "today") return TODAY;
  if (kind === "date") return "";
  if (!/^\d+$/.test(days)) return null;
  const count = Number(days);
  return count >= 1 && count <= 3650 ? `{today${kind === "future" ? "+" : "-"}${count}}` : null;
}
