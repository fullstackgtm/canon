import { dispatch, setProvider } from "@flue/runtime";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { verifyPiService } from "../../../convex/lib/piRuntimeTokens.ts";
import { Research } from "./agents/research.ts";
import type { Env } from "./canon.ts";

let bootId = "";
const boot = () => bootId ||= crypto.randomUUID();
const modelCalls: Array<{ bootId: string; index: number | "done" }> = [];
const faux = fauxProvider({ provider: "canon-faux", models: [{ id: "research" }], tokensPerSecond: Infinity });
const script = () => faux.appendResponses(Array.from({ length: 64 }, () => (context) => {
  const results = context.messages.filter((message) => message.role === "toolResult");
  const last = results.at(-1);
  const text = last && "content" in last ? last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") : "";
  const finished = text.startsWith("{") && (JSON.parse(text) as { finished?: boolean }).finished === true;
  modelCalls.push({ bootId: boot(), index: finished ? "done" : results.length });
  return finished ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("research_step", { index: results.length }), { stopReason: "toolUse" });
}));
script();
setProvider(faux.provider);

const app = new Hono<{ Bindings: Env }>();

app.use("/orgs/:org/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (c.req.param("org") !== c.env.CANON_ORG) return c.text("Wrong org worker", 404);
  if (!await verifyPiService(c.env.CANON_PI_SECRET, c.req.method, url.pathname + url.search, c.req.raw.headers)) return c.text("Unauthorized", 401);
  await next();
});

app.post("/orgs/:org/runs/:id", async (c) => {
  const runId = c.req.param("id");
  const receipt = await dispatch(Research, {
    id: runId, initialData: { runId }, idempotencyKey: `admit:${runId}`,
    message: { kind: "signal", type: "canon.research", body: `Research run ${runId}.` },
  });
  return c.json(receipt, 202);
});

type WakeAgent = { armWakes(labels: string[], delaySeconds: number): Promise<number>; wakes(): Promise<unknown> };
const wakeAgent = (env: Env, id: string) => getAgentByName(env.FLUE_RESEARCH_AGENT as never, id) as unknown as Promise<WakeAgent>;
app.post("/orgs/:org/wakes/:id", async (c) => c.json({ pending: await (await wakeAgent(c.env, c.req.param("id"))).armWakes(["a", "b", "c"], 4) }));
app.get("/orgs/:org/wakes/:id", async (c) => c.json(await (await wakeAgent(c.env, c.req.param("id"))).wakes()));
app.get("/orgs/:org/model-calls", (c) => {
  if (faux.getPendingResponseCount() < 8) script();
  return c.json({ bootId: boot(), modelCalls });
});

export default app;
