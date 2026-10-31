import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { postToSlack, shouldNotify, slackMessage, webhookUrlProblem } from "../convex/lib/agents/slack.ts";

test("which turns notify, and what the message says and leaves out", () => {
  const done = { status: "done", hasRoute: true };
  assert.equal(shouldNotify("all", { status: "queued", hasRoute: false }), false);
  assert.equal(shouldNotify("all", done), true);
  // Qualified: routed (or qualified without a contact); a routed turn not yet routed waits.
  assert.equal(shouldNotify("qualified", { ...done, routing: { status: "added" } }), true);
  assert.equal(shouldNotify("qualified", { ...done, routing: { status: "not_qualified" } }), false);
  assert.equal(shouldNotify("qualified", done), false);
  assert.equal(shouldNotify("qualified", { status: "done", hasRoute: false }), true);
  assert.equal(shouldNotify("qualified", { status: "failed", hasRoute: false }), false);
  assert.equal(shouldNotify("failures", { status: "skipped", hasRoute: true }), true);
  assert.equal(shouldNotify("failures", { ...done, routing: { status: "added" } }), false);

  const text = slackMessage({
    agentLabel: "Demo <!channel> research", trigger: "crm_event", status: "done", account: { name: "Acme & Co", domain: "acme.com" },
    outputs: [{ status: "answered" }, { status: "unchanged" }, { status: "unknown" }], routing: { status: "added" }, audienceName: "Hot leads",
    link: "https://app.example/dashboard/agents#turn-abc",
  });
  assert.match(text, /Demo &lt;!channel&gt; research/);
  assert.match(text, /Trigger: deal stage change/);
  assert.match(text, /Acme &amp; Co \(acme\.com\)/);
  assert.match(text, /2 of 3 fields answered/);
  assert.match(text, /Routed to audience: Hot leads/);
  assert.match(text, /<https:\/\/app\.example\/dashboard\/agents#turn-abc\|Open the turn in Canon>/);
});

test("delivery: only Slack webhooks, no redirects, and a failure records the status but never the URL", async () => {
  assert.equal(webhookUrlProblem("https://hooks.slack.com/services/T1/B2/xyz", false), null);
  assert.ok(webhookUrlProblem("https://evil.example/services/T1/B2/xyz", false));
  assert.ok(webhookUrlProblem("http://127.0.0.1:9/hook", false));
  assert.equal(webhookUrlProblem("http://127.0.0.1:9/hook", true), null);

  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push(body);
      if (req.url === "/ok") res.end("ok");
      else if (req.url === "/gone") { res.statusCode = 404; res.end("no_service"); }
      else { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1:1/elsewhere"); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await postToSlack(`${base}/ok`, "hi"), { ok: true, httpStatus: 200 });
    assert.deepEqual(JSON.parse(seen[0]), { text: "hi" });
    assert.deepEqual(await postToSlack(`${base}/gone`, "hi"), { ok: false, httpStatus: 404, error: "no_service" });
    assert.equal((await postToSlack(`${base}/redirect`, "hi")).httpStatus, 302);
  } finally {
    server.close();
  }
  const dead = await postToSlack("http://127.0.0.1:1/secret-token", "hi");
  assert.equal(dead.ok, false);
  assert.ok(!JSON.stringify(dead).includes("secret-token"));
});
