import { ConvexError } from "convex/values";

export function agentReadBudget() {
  let rows = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const take = async <T>(source: AsyncIterable<T>, max: number): Promise<T[]> => {
    const out: T[] = [];
    for await (const row of source) {
      rows += 1;
      bytes += encoder.encode(JSON.stringify(row)).byteLength;
      if (rows > 2000 || bytes > 4 * 1024 * 1024) throw new ConvexError("Agent history exceeds one display read's budget. Open a single agent or try again after its recent activity subsides.");
      out.push(row);
      if (out.length >= max) break;
    }
    return out;
  };
  return {
    take,
    async complete<T>(source: AsyncIterable<T>, max: number, overflow: string): Promise<T[]> {
      const rows = await take(source, max + 1);
      if (rows.length > max) throw new ConvexError(overflow);
      return rows;
    },
  };
}

export type AgentReadBudget = ReturnType<typeof agentReadBudget>;
