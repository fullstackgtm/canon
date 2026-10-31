'use agent';
import { defineTool, useInitialData, useModel, useTool } from "@flue/runtime";
import { extend, getCloudflareContext } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import { ACCOUNT_MS, researchCompany, type FetchedPage } from "../../../../convex/lib/research/agentLoop.ts";
import type { PiFinding, PiLanding, PiNext } from "../../../../convex/lib/research/piProtocol.ts";
import { callCanon, type Env } from "../canon.ts";

const researchStep = (runId: string) => defineTool({
  name: "research_step",
  description: "Research the Canon-served record at this index and land its finding through Canon.",
  input: v.object({ index: v.number() }),
  durable: true,
  timeoutMs: ACCOUNT_MS + 5_000,
  async run({ data, step, signal }) {
    const env = getCloudflareContext().env as Env;
    const canon = (operation: string, args: Record<string, unknown>) => callCanon(env, runId, operation, args);
    const next = await step.do(`next:${data.index}`, () => canon("next", { index: data.index }) as Promise<PiNext>);
    if (next.kind === "advance") return { output: JSON.stringify({ finished: next.finished, completed: next.completed }) };
    const { stepId } = next.record;
    let sequence = 0;
    const effect = <T>(operation: "read" | "model" | "search", request: object): Promise<T> => {
      const key = `${operation}:${sequence++}`;
      return step.do(`effect:${stepId}:${key}`, async () => JSON.parse(await canon("effect", { stepId, key, operation, request: JSON.stringify(request) }) as string)) as Promise<T>;
    };
    const start = Date.now();
    let finding: PiFinding;
    try {
      const found = (await researchCompany(next.record.spec, next.record.subject, {
        legacyFactualLlm: true,
        fetchPage: (url) => effect<FetchedPage | null>("read", { url }),
        call: (prompt, tool, schema) => effect("model", { prompt, tool, schemaJson: JSON.stringify(schema) }),
        search: (query) => effect("search", { query }),
        signal,
      })).finding;
      finding = found.status === "answered"
        ? typeof found.value === "string"
          ? { status: "answered", value: found.value, quote: found.quote, sourceUrl: found.sourceUrl, confidence: found.confidence }
          : { status: "no_evidence", reason: "This Pi migration only accepts text answers." }
        : found;
    } catch {
      finding = { status: "error", reason: "Canon refused or could not complete record research" };
    }
    const landing = await step.do(`finish:${stepId}`, () => canon("finish", { stepId, finding, ms: Date.now() - start }) as Promise<PiLanding>);
    return { output: JSON.stringify(landing) };
  },
});

export function Research() {
  useModel("canon-faux/research");
  useTool(researchStep(useInitialData<{ runId: string }>().runId));
  return "Call research_step with index 0, then with the next index after each result, until a result reports finished. Then reply done.";
}
Research.initialData = v.object({ runId: v.string() });
Research.durability = { maxAttempts: 7, timeoutMs: 15 * 60_000 };

type Wake = { label: string; firedAt: number };
export const cloudflare = extend({
  base: (Base) => class extends Base {
    async armWakes(labels: string[], delaySeconds: number) {
      for (const [i, label] of labels.entries()) await this.schedule(delaySeconds + i, "wake", { label });
      return (await this.getSchedules()).length;
    }
    async wake(payload: { label: string }) {
      const sql = (this as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS canon_wakes (label TEXT PRIMARY KEY, fired_at INTEGER NOT NULL, fires INTEGER NOT NULL)");
      sql.exec("INSERT INTO canon_wakes VALUES (?, ?, 1) ON CONFLICT(label) DO UPDATE SET fires = fires + 1", payload.label, Date.now());
    }
    async wakes(): Promise<{ fired: Array<Wake & { fires: number }>; pending: number }> {
      const sql = (this as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS canon_wakes (label TEXT PRIMARY KEY, fired_at INTEGER NOT NULL, fires INTEGER NOT NULL)");
      const fired = sql.exec<{ label: string; fired_at: number; fires: number }>("SELECT * FROM canon_wakes ORDER BY label").toArray().map((r) => ({ label: r.label, firedAt: r.fired_at, fires: r.fires }));
      return { fired, pending: (await this.getSchedules()).length };
    }
  },
});
