import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension, defineTask, defineDoc, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { ACCOUNT_MS, researchCompany, type FetchedPage } from "../../../convex/lib/research/agentLoop.ts";

import type { PiRecord, PiNext, PiLanding, PiFinding } from "../../../convex/lib/research/piProtocol.ts";

export const context = BACKGROUND_CONTEXT;
export type Callback = (operation: string, data: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type Input = { runId: string; mode: "research" | "probe"; delayMs: number };
type State = { phase: "step"; index: number; cursor: string | null };
export const Progress = defineDoc<{ completed: number; lastCommitAt: number; overheadMs: number[]; outputs: string[] }>({
  kind: "canon.progress", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ completed: 0, lastCommitAt: 0, overheadMs: [], outputs: [] }),
});

export async function openRuntime(storage: Storage, callback: Callback, publish: () => void) {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const bootId = crypto.randomUUID();
  const Probe = defineTask<Input, State, number>({
    name: "canon.research", version: 1,
    initial: () => ({ phase: "step", index: 0, cursor: null }),
    phases: {
      step: async (task, runtime, ctx) => {
        const { index, cursor } = task.state.checkpoint;
        let probeOutput = "";
        const memo = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
          const saved = await runtime.memo<string>(`${index}:${key}`, ctx);
          if (saved !== undefined) return JSON.parse(saved) as T;
          const value = await work();
          return JSON.parse(await runtime.memo(`${index}:${key}`, JSON.stringify(value), ctx)) as T;
        };
        if (task.input.mode === "probe") {
          if (index === 8) {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: index } }), ctx);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, task.input.delayMs));
          const answer = await memo("fake-model", async () => {
            faux.setResponses([fauxAssistantMessage(`checkpoint-${index}@${bootId}`)]);
            return models.completeSimple(faux.getModel(), { messages: [{ role: "user", content: `Step ${index}`, timestamp: 0 }] });
          });
          probeOutput = answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          if (answer.stopReason !== "stop" || !probeOutput.startsWith(`checkpoint-${index}@`)) throw new Error("Fake model did not produce the checkpoint output");
        }
        const before = performance.now();
        await runtime.commit(async (tx) => {
          const progress = await tx.doc(Progress, task.conversationId);
          progress.completed = index + 1;
          progress.lastCommitAt = Date.now();
          progress.outputs.push(probeOutput);
          return { status: "running", checkpoint: { phase: "step", index: index + 1, cursor } };
        }, ctx);
        const elapsed = performance.now() - before;
        await runtime.commit(async (tx) => {
          (await tx.doc(Progress, task.conversationId)).overheadMs.push(elapsed);
          return { status: "running", checkpoint: { phase: "step", index: index + 1, cursor } };
        }, ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const Record = defineTask<PiRecord, { phase: "work" }, PiLanding>({
    name: "canon.research.record", version: 1,
    initial: () => ({ phase: "work" }),
    phases: {
      work: async (task, runtime, ctx) => {
        const previous = await callback("status", { stepId: task.input.stepId }) as PiLanding | null;
        if (previous) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: previous } }), ctx);
          return;
        }
        let sequence = 0;
        const effect = async <T>(operation: "read" | "model" | "search", request: object): Promise<T> => {
          const key = `${operation}:${sequence++}`;
          const saved = await runtime.memo<string>(key, ctx);
          if (saved !== undefined) return JSON.parse(saved) as T;
          const response = await callback("effect", { stepId: task.input.stepId, key, operation, request: JSON.stringify(request) }, signal) as string;
          return JSON.parse(await runtime.memo(key, response, ctx)) as T;
        };
        const start = Date.now();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), ACCOUNT_MS);
        const signal = AbortSignal.any([runtime.signal, deadline.signal]);
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Record research stopped"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        let finding: PiFinding;
        try {
          const result = await Promise.race([researchCompany(task.input.spec, task.input.subject, {
            legacyFactualLlm: true,
            fetchPage: (url) => effect<FetchedPage | null>("read", { url }),
            call: (prompt, tool, schema) => effect("model", { prompt, tool, schemaJson: JSON.stringify(schema) }),
            search: (query) => effect("search", { query }),
            signal,
          }), aborted]);
          const found = result.finding;
          finding = found.status === "answered"
            ? typeof found.value === "string"
              ? { status: "answered", value: found.value, quote: found.quote, sourceUrl: found.sourceUrl, confidence: found.confidence }
              : { status: "no_evidence", reason: "This Pi migration only accepts text answers." }
            : found;
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          finding = { status: "error", reason: deadline.signal.aborted ? "Record research deadline exceeded" : "Canon refused or could not complete record research" };
        } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
        const result = await callback("finish", { stepId: task.input.stepId, finding, ms: Date.now() - start }) as PiLanding;
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  type RunState = { phase: "next"; index: number } | { phase: "record"; index: number; child: TaskId<PiLanding> };
  const Research = defineTask<Input, RunState, number>({
    name: "canon.research.run", version: 1,
    initial: () => ({ phase: "next", index: 0 }),
    phases: {
      next: async (task, runtime, ctx) => {
        const next = await callback("next", { index: task.state.checkpoint.index }) as PiNext;
        if (next.kind === "advance") {
          await runtime.commit(async (tx) => {
            const progress = await tx.doc(Progress, task.conversationId);
            progress.completed = next.completed;
            progress.lastCommitAt = Date.now();
            return next.finished
              ? { status: "terminal", outcome: { status: "completed", result: next.completed } }
              : { status: "running", checkpoint: { phase: "next", index: task.state.checkpoint.index + 1 } };
          }, ctx);
          return;
        }
        await runtime.commit(async (tx) => ({ status: "running", checkpoint: {
          phase: "record", index: task.state.checkpoint.index,
          child: await tx.createTask(Record, next.record, { ownership: { kind: "task", taskId: runtime.taskId } }),
        } }), ctx);
      },
      record: async (task, runtime, ctx) => {
        const child = await runtime.waitForTask(task.state.checkpoint.child, ctx);
        if (child.state.outcome.status !== "completed") throw new Error("Record task did not complete");
        const result = child.state.outcome.result;
        await runtime.commit(async (tx) => {
          const progress = await tx.doc(Progress, task.conversationId);
          progress.completed = result.completed;
          progress.lastCommitAt = Date.now();
          return result.finished
            ? { status: "terminal", outcome: { status: "completed", result: result.completed } }
            : { status: "running", checkpoint: { phase: "next", index: task.state.checkpoint.index + 1 } };
        }, ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "canon", tasks: [Probe, Record, Research] }));
  const harness = await Harness.open(storage, { registry, models, onReport: (e) => console.error(e) }, context);
  const root = await harness.root(context);
  await root.commit(async (tx) => { await tx.doc(Progress, root.id); }, context);
  const watch = await harness.watchDoc(Progress, root.id, context);
  watch!.start(async () => { publish(); });
  return {
    harness,
    async start(input: Input) {
      const id = await root.commit(async (tx) => {
        const prior = (await tx.scanTasks({ conversationId: root.id }, 1)).items[0];
        return prior?.id ?? (input.mode === "probe" ? tx.createTask(Probe, input, { ownership: { kind: "conversation" } }) : tx.createTask(Research, input, { ownership: { kind: "conversation" } }));
      }, context);
      harness.resume();
      return id;
    },
    async snapshot() {
      const task = await root.commit(async (tx) => (await tx.scanTasks({ conversationId: root.id }, 1)).items[0] ?? null, context);
      return {
        progress: await harness.snapshot(Progress, root.id, context),
        task: task ? { id: task.id, kind: task.kind, version: task.version, status: task.state.status,
          outcome: "outcome" in task.state ? task.state.outcome?.status : null } : null,
      };
    },
    async wait(id: TaskId) {
      const result = await harness.waitForTask(id, context);
      if (result.kind === Research.definition.name && result.state.outcome.status !== "completed") await callback("fail", {});
      return result;
    },
  };
}
