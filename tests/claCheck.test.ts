import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, claDecision, runCheck } from "../scripts/cla-check.mjs";

const signature = (login: string) => `${AGREEMENT}\n\nName: Jane Example\nGitHub: ${login}\nDate: 2026-11-09\n`;
const outside: Parameters<typeof claDecision>[0] = { author: "jane-example", repository: "fullstackgtm/canon", headRepository: "jane-example/canon", headRef: "fix-typo", base: null, head: null };

test("the agreement check passes signed authors, maintainers and sync pull requests, and fails the rest", () => {
  const decide = (overrides: Partial<typeof outside>) => claDecision({ ...outside, ...overrides }).ok;
  assert.equal(decide({}), false);
  assert.equal(decide({ head: signature("someone-else") }), false);
  assert.equal(decide({ head: signature("Jane-Example").replace(AGREEMENT, "I agree.") }), false);
  assert.equal(decide({ head: signature("Jane-Example") }), true);
  assert.equal(decide({ base: signature("jane-example") }), true);
  assert.equal(decide({ author: "ryanfsgtm", headRepository: "fullstackgtm/canon", headRef: "canon-sync/0123456789ab" }), true);
  assert.equal(decide({ author: "ryanfsgtm", headRef: "docs" }), true);
});

test("a fork pull request is checked with GET requests for the author's file and only the default token", async () => {
  const requests: { url: string; method?: string; authorization: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return url.includes("jane-example/canon") ? new Response(signature("jane-example")) : new Response("", { status: 404 });
  };
  const event = {
    repository: { full_name: "fullstackgtm/canon" },
    pull_request: { user: { login: "jane-example" }, base: { ref: "main" }, head: { ref: "fix-typo", sha: "a".repeat(40), repo: { full_name: "jane-example/canon" } } },
  };
  assert.equal((await runCheck({ event, token: "default-token", fetch })).ok, true);
  assert.deepEqual(requests, [
    { url: "https://api.github.com/repos/fullstackgtm/canon/contents/contributors/jane-example.md?ref=main", method: undefined, authorization: "Bearer default-token" },
    { url: `https://api.github.com/repos/jane-example/canon/contents/contributors/jane-example.md?ref=${"a".repeat(40)}`, method: undefined, authorization: "Bearer default-token" },
  ]);
});
