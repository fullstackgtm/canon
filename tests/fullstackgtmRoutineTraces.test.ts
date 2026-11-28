import assert from "node:assert/strict";
import test from "node:test";
import { findRoutines, parseChatExport, parseClaudeCodeJsonl, parseCodexJsonl, redact, routineRequest, toolName } from "../engine/src/routineTraces.ts";

const day = 86_400_000;
const t0 = Date.parse("2026-11-02T09:00:00Z");

function claudeSession(at: number, prompt: string) {
  return [
    { type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" } },
    { type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: prompt } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__claude_ai_HubSpot_1a2b3c4d__search_deals", input: {} }] } },
  ].map((r) => JSON.stringify(r)).join("\n");
}

test("each trace format reads into prompts and normalized tools, skipping harness text", () => {
  const cc = parseClaudeCodeJsonl(claudeSession(t0, "List my deals stuck in pipeline over 30 days"), "a.jsonl");
  assert.deepEqual(cc.prompts, ["List my deals stuck in pipeline over 30 days"]);
  assert.deepEqual(cc.tools, ["hubspot.search_deals"]);
  assert.equal(cc.startedAt, t0);

  const codex = parseCodexJsonl([
    { type: "session_meta", timestamp: new Date(t0).toISOString(), payload: {} },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_action>review</user_action>" }, { type: "input_text", text: "Draft follow-ups for yesterday's meetings" }] } },
    { type: "response_item", payload: { type: "function_call", name: "mcp__canon__canon_records" } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n{truncated", "r.jsonl");
  assert.deepEqual(codex.prompts, ["Draft follow-ups for yesterday's meetings"]);
  assert.deepEqual(codex.tools, ["canon.canon_records"]);

  const [gpt, claude] = parseChatExport([
    { id: "c1", title: "Pipeline review", create_time: t0 / 1000, mapping: { a: { message: { author: { role: "user" }, content: { parts: ["Which deals slipped?"] }, create_time: 1 } } } },
    { uuid: "c2", name: "Renewals", created_at: new Date(t0).toISOString(), chat_messages: [{ sender: "human", text: "Renewals due next month" }] },
  ]);
  assert.equal(gpt!.source, "chatgpt-export");
  assert.deepEqual(gpt!.prompts, ["Which deals slipped?"]);
  assert.equal(claude!.source, "claude-export");
  assert.equal(claude!.startedAt, t0);
});

test("credentials are redacted and MCP tool names lose their connector ids", () => {
  // Built at runtime so the public export's secret scan doesn't read the fixtures as tokens.
  const fakeOpenAi = ["sk", "abcdefghijklmnopqrstuv"].join("-");
  const fakeGithub = ["ghp", "0123456789abcdefghij"].join("_");
  assert.equal(redact(`use ${fakeOpenAi} and ${fakeGithub}`), "use [redacted] and [redacted]");
  assert.equal(redact("api_key=supersecretvalue1"), "[redacted]");
  assert.equal(redact("Authorization: Bearer demoOpaqueCredential123456"), "Authorization: [redacted]");
  assert.equal(redact('{"api_key":"demoOpaqueCredential123456"}'), "{[redacted]}");
  assert.equal(toolName("mcp__claude_ai_Gmail_51b11787__send_message"), "gmail.send_message");
  assert.equal(toolName("Bash"), "bash");
});

test("a GTM request repeated weekly becomes one candidate; one-offs, non-GTM and subagent briefs do not", () => {
  const traces = [0, 7, 14, 21].map((d, i) => parseClaudeCodeJsonl(claudeSession(t0 + d * day, `List my deals stuck in pipeline over 30 days ${i}`), `w${i}.jsonl`));
  traces.push(parseClaudeCodeJsonl(claudeSession(t0, "Find renewals at risk this quarter for churn review"), "once.jsonl"));
  traces.push(parseCodexJsonl(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky build" }] } }), "code.jsonl"));
  traces.push(parseClaudeCodeJsonl(claudeSession(t0, "You are an AI assistant helping set up deals in Canon"), "s1.jsonl"));
  traces.push(parseClaudeCodeJsonl(claudeSession(t0 + day, "You are an AI assistant helping set up deals in Canon"), "s2.jsonl"));

  const found = findRoutines(traces);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.occurrences, 4);
  assert.equal(found[0]!.cadence, "weekly");
  assert.deepEqual(found[0]!.tools, ["hubspot.search_deals"]);

  const request = routineRequest(found[0]!);
  assert.match(request, /4 times \(weekly\)/);
  assert.ok(request.length <= 2_000);
});
