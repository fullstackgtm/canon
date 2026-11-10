export type DealLine = {
  id: string;
  version: number;
  name: string;
  productId: string;
  quantity: number;
  unitPrice: number | null;
  totalPrice: number;
  position: number;
};

export const MAX_DEAL_LINES = 100;

export function parseLineMoney(text: string, decimals: number): number {
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw new Error("Enter a nonnegative amount");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Amounts support ${decimals} decimal places`);
  const value = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount exceeds the supported value");
  return Number(value);
}

export function lineMoneyText(value: number, decimals: number): string {
  const raw = BigInt(value).toString().padStart(decimals + 1, "0");
  return decimals ? `${raw.slice(0, -decimals)}.${raw.slice(-decimals)}` : raw;
}

export function lineTotal(lines: readonly Pick<DealLine, "totalPrice">[]): number {
  const total = lines.reduce((sum, line) => {
    if (!Number.isSafeInteger(line.totalPrice) || line.totalPrice < 0) throw new Error("Line totals must be nonnegative integer minor units");
    return sum + BigInt(line.totalPrice);
  }, BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Line items total exceeds the supported amount");
  return Number(total);
}

export function lineProblem(line: { quantity: number; unitPrice?: number | null; totalPrice: number }): string | null {
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return "Quantity must be a positive integer";
  if (line.unitPrice != null && (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0)) return "Unit price must be nonnegative integer minor units";
  try { lineTotal([line]); } catch (cause) { return (cause as Error).message; }
  return null;
}

export function orderedProducts(lines: readonly Pick<DealLine, "name" | "position" | "id">[]): string[] {
  return [...new Set([...lines].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((line) => line.name))];
}
