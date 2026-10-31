import type { AgentLoopOptions, AgentLoopResult } from "./types.ts";

export type CompatEndpoint = { baseUrl: string; apiKey: string; maxTokensParam?: "max_tokens" | "max_completion_tokens" };

export async function runAnthropicAgent(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const mod: any = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  const client = new Anthropic({ maxRetries: 10 });
  const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as any }));
  const messages: any[] = [{ role: "user", content: opts.prompt }];
  let turns = 0, toolCalls = 0, toolErrors = 0, inputTokens = 0, outputTokens = 0, finalText = "";
  while (turns < opts.maxTurns) {
    turns += 1;
    const response = await client.messages.create({ model: opts.model, max_tokens: 8192, system: opts.system, tools, messages });
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (text) { finalText = text; opts.onEvent?.({ type: "assistant", turn: turns, text }); }
    const toolUses = response.content.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) break;
    messages.push({ role: "assistant", content: response.content });
    const results: any[] = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      opts.onEvent?.({ type: "tool_call", turn: turns, name: tu.name, input: tu.input });
      let result: string;
      let isError = false;
      try {
        result = await opts.execute(tu.name, tu.input);
        if (result.startsWith("HTTP 4") || result.startsWith("HTTP 5") || result.startsWith("exit code: 1")) toolErrors += 1;
      } catch (error) {
        result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
        toolErrors += 1;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result, is_error: isError });
      opts.onEvent?.({ type: "tool_result", turn: turns, name: tu.name, output: result.slice(0, 4000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { turns, toolCalls, toolErrors, inputTokens, outputTokens, finalText };
}

export async function runOpenAICompatAgent(endpoint: CompatEndpoint, opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages: any[] = [{ role: "system", content: opts.system }, { role: "user", content: opts.prompt }];
  let turns = 0, toolCalls = 0, toolErrors = 0, inputTokens = 0, outputTokens = 0, finalText = "";
  while (turns < opts.maxTurns) {
    turns += 1;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      res = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: opts.model, messages, tools, tool_choice: "auto", [endpoint.maxTokensParam ?? "max_tokens"]: 8192 }),
      });
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!res || !res.ok) throw new Error(`Chat completions error ${res?.status}: ${(res ? await res.text() : "no response").slice(0, 500)}`);
    const data: any = await res.json();
    inputTokens += data.usage?.prompt_tokens ?? 0;
    outputTokens += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    if (typeof msg.content === "string" && msg.content) { finalText = msg.content; opts.onEvent?.({ type: "assistant", turn: turns, text: msg.content }); }
    const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) break;
    messages.push(msg);
    for (const call of calls) {
      toolCalls += 1;
      let result: string;
      let args: any = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        opts.onEvent?.({ type: "tool_call", turn: turns, name: call.function?.name ?? "", input: args });
        result = await opts.execute(call.function?.name ?? "", args);
        if (result.startsWith("HTTP 4") || result.startsWith("HTTP 5") || result.startsWith("exit code: 1")) toolErrors += 1;
      } catch (error) {
        result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        toolErrors += 1;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      opts.onEvent?.({ type: "tool_result", turn: turns, name: call.function?.name ?? "", output: result.slice(0, 4000) });
    }
  }
  return { turns, toolCalls, toolErrors, inputTokens, outputTokens, finalText };
}

export function resolveProvider(modelSpec: string): { kind: "anthropic"; model: string } | { kind: "compat"; model: string; endpoint: CompatEndpoint } | { kind: "fixture"; mode: string } {
  const slash = modelSpec.indexOf("/");
  const prefix = slash === -1 ? "anthropic" : modelSpec.slice(0, slash);
  const model = slash === -1 ? modelSpec : modelSpec.slice(slash + 1);
  switch (prefix) {
    case "fixture": return { kind: "fixture", mode: model };
    case "anthropic": return { kind: "anthropic", model };
    case "openrouter": return { kind: "compat", model, endpoint: { baseUrl: "https://openrouter.ai/api/v1", apiKey: requireEnv("OPENROUTER_API_KEY") } };
    case "openai": return { kind: "compat", model, endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: requireEnv("OPENAI_API_KEY"), maxTokensParam: "max_completion_tokens" } };
    case "compat": return { kind: "compat", model, endpoint: { baseUrl: requireEnv("OPENAI_COMPAT_BASE_URL"), apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "none" } };
    default: throw new Error(`Unknown model provider prefix "${prefix}" in "${modelSpec}"`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
