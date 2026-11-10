import assert from "node:assert/strict";
import test from "node:test";
import { forcedToolCall, readChatgptFunctionArguments } from "../engine/src/llm.ts";
import {
  CHATGPT_CLIENT_ID,
  ChatgptReauthRequired,
  chatgptIdentity,
  exchangeDeviceCode,
  pollDeviceCode,
  refreshChatgptTokens,
  requestDeviceCode,
} from "../engine/src/chatgptAuth.ts";

const sse = (events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const jwt = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

test("chatgpt provider: streamed Responses call with account header, returns tool args", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return sse([
      { type: "response.created" },
      { type: "response.function_call_arguments.delta", delta: '{"ok":' },
      { type: "response.function_call_arguments.delta", delta: "true}" },
      { type: "response.output_item.done", item: { type: "function_call", name: "result", arguments: '{"ok":true}' } },
      { type: "response.completed" },
    ]);
  }) as typeof fetch;

  const out = await forcedToolCall("hi", "result", { type: "object" }, "gpt-test", {
    provider: "chatgpt",
    apiKey: "access-token",
    chatgptAccountId: "acct_1",
    fetchImpl,
  });

  assert.deepEqual(out, { ok: true });
  assert.equal(seen?.url, "https://chatgpt.com/backend-api/codex/responses");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers["chatgpt-account-id"], "acct_1");
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.model, "gpt-test");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tools[0].name, "result");
});

test("chatgpt provider: 401 points the user at reconnecting, never echoes the body", async () => {
  const fetchImpl = (async () => new Response("secret echo", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
  await assert.rejects(
    forcedToolCall("hi", "result", {}, "m", { provider: "chatgpt", apiKey: "t", chatgptAccountId: "a", fetchImpl }),
    (error: Error) => /reconnect ChatGPT/.test(error.message) && !error.message.includes("secret echo"),
  );
});

test("readChatgptFunctionArguments: falls back to deltas and surfaces response.failed", async () => {
  const deltasOnly = sse([{ type: "response.function_call_arguments.delta", delta: "{}" }]);
  assert.equal(await readChatgptFunctionArguments(deltasOnly.body!, "x"), "{}");
  const failed = sse([{ type: "response.failed", response: { error: { message: "model not supported" } } }]);
  await assert.rejects(readChatgptFunctionArguments(failed.body!, "x"), /model not supported/);
});

test("device flow: usercode → pending → approved → token exchange", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  let polls = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    if (url.endsWith("/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.endsWith("/deviceauth/token")) {
      polls += 1;
      return polls === 1
        ? new Response("", { status: 403 })
        : Response.json({ authorization_code: "code_1", code_verifier: "verifier_1" });
    }
    return Response.json({ access_token: "at", refresh_token: "rt", id_token: "it" });
  }) as typeof fetch;

  const code = await requestDeviceCode(fetchImpl);
  assert.equal(code.userCode, "ABCD-1234");
  assert.equal(code.intervalMs, 5000);
  assert.equal(code.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(code.expiresAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(JSON.parse(calls[0].body).client_id, CHATGPT_CLIENT_ID);

  assert.deepEqual(await pollDeviceCode(code.deviceAuthId, code.userCode, fetchImpl), { status: "pending" });
  const approved = await pollDeviceCode(code.deviceAuthId, code.userCode, fetchImpl);
  assert.deepEqual(approved, { status: "approved", authorizationCode: "code_1", codeVerifier: "verifier_1" });

  const tokens = await exchangeDeviceCode("code_1", "verifier_1", fetchImpl);
  assert.deepEqual(tokens, { accessToken: "at", refreshToken: "rt", idToken: "it" });
  const form = new URLSearchParams(calls.at(-1)!.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "verifier_1");
  assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
});

test("refresh keeps the old refresh token when none is rotated, and flags dead sessions", async () => {
  const ok = (async () => Response.json({ access_token: "at2" })) as unknown as typeof fetch;
  const refreshed = await refreshChatgptTokens({ accessToken: "at", refreshToken: "rt", idToken: "it" }, ok);
  assert.deepEqual(refreshed, { accessToken: "at2", refreshToken: "rt", idToken: "it" });

  const dead = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    refreshChatgptTokens({ accessToken: "at", refreshToken: "rt", idToken: "it" }, dead),
    ChatgptReauthRequired,
  );
});

test("chatgptIdentity reads account, email, plan and access-token expiry", () => {
  const identity = chatgptIdentity({
    idToken: jwt({
      email: "rep@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_9", chatgpt_plan_type: "plus" },
    }),
    accessToken: jwt({ exp: 2_000_000_000 }),
    refreshToken: "rt",
  });
  assert.deepEqual(identity, {
    accountId: "acct_9",
    email: "rep@example.com",
    planType: "plus",
    accessTokenExpiresAt: 2_000_000_000_000,
  });
  assert.throws(() => chatgptIdentity({ idToken: jwt({}), accessToken: "opaque", refreshToken: "rt" }), /no account id/);
});
