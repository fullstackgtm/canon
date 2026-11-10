import assert from "node:assert/strict";
import test from "node:test";
import { findWorkEmailViaTreg, TREG_EMAIL_ENDPOINT } from "../convex/lib/emailFinder.ts";
import { findPhoneViaTreg, PHONE_LOOKUP_MAX_COST_USD } from "../convex/lib/phoneFinder.ts";
import { formatMeta, tregCall, TregRefusal } from "../convex/lib/treg.ts";

// These exercise the paid path against a mocked fetch: no call leaves the process.
process.env.TREG_PAID_CALLS = "on";

type Seen = { url: string; headers: Record<string, string> };

function stub(status: number, body: unknown, headers: Record<string, string> = {}, seen?: Seen[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen?.push({ url, headers: init.headers as Record<string, string> });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
}

test("meta tags follow treg's bag rules and fail before any request", () => {
  assert.equal(formatMeta({ customer: "org_1", feature: "find_email" }), "customer=org_1, feature=find_email");
  assert.throws(() => formatMeta({ Customer: "x" }), /must match/);
  assert.throws(() => formatMeta({ customer: "a@b.com" }), /without "@"/, "PII-shaped values are refused");
  assert.throws(() => formatMeta({ customer: "a,b" }), /without/, "a comma would split the bag");
  assert.throws(() => formatMeta({ a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" }), /at most 5/);
});

test("a call sends token, tags, idempotency key and cost ceiling, and reads cost and call id", async () => {
  const seen: Seen[] = [];
  const res = await tregCall({
    token: "t",
    endpoint: "hunter.people.email.find",
    query: { domain: "a.com", full_name: "Bo Two" },
    meta: { customer: "org_1" },
    idempotencyKey: "k1",
    maxCostUsd: 0.25,
    fetchImpl: stub(200, { data: {} }, { "X-Treg-Call-Id": "c_1", "X-Treg-Cost-Micro": "4500" }, seen),
  });
  assert.equal(seen[0].url, "https://treg.to/call/hunter.people.email.find?domain=a.com&full_name=Bo+Two");
  assert.deepEqual(seen[0].headers, {
    "X-Treg-Token": "t",
    "X-Treg-Meta": "customer=org_1",
    "Idempotency-Key": "k1",
    "X-Treg-Route-Max-Cost": "0.25",
  });
  assert.deepEqual({ callId: res.callId, costMicro: res.costMicro, replay: res.replay }, { callId: "c_1", costMicro: 4500, replay: false });
});

test("treg's own refusals become TregRefusal; a provider's 404 is relayed as an answer", async () => {
  const blocked = stub(403, { detail: { error: "tag_blocked", dim: "customer", val: "org_1", message: "customer org_1 is blocked" } }, { "X-Treg-Error": "1", "X-Treg-Call-Id": "c_2" });
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "org_1" }, fetchImpl: blocked }), (err: unknown) => {
    assert.ok(err instanceof TregRefusal);
    assert.equal(err.code, "tag_blocked");
    assert.equal(err.callId, "c_2");
    return true;
  });
  const broke = stub(402, { detail: { error: "insufficient_balance", message: "top up" } }, { "X-Treg-Error": "1" });
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, fetchImpl: broke }), TregRefusal);
  const providerMiss = await tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, fetchImpl: stub(404, { errors: [] }) });
  assert.equal(providerMiss.status, 404);
});

test("Hunter via treg: a verified hit is found, a miss or an invalid address is not", async () => {
  const opts = { token: "t", fullName: "Bo Two", domain: "a.com", meta: { customer: "org_1" } };
  const hitHeaders = { "X-Treg-Call-Id": "c_3", "X-Treg-Cost-Micro": "4500" };
  assert.deepEqual(
    await findWorkEmailViaTreg({ ...opts, fetchImpl: stub(200, { data: { email: "Bo@A.com", verification: { status: "valid" } } }, hitHeaders) }),
    { email: "bo@a.com", status: "found", provider: "treg:hunter", costMicro: 4500, callId: "c_3" },
  );
  assert.equal((await findWorkEmailViaTreg({ ...opts, fetchImpl: stub(200, { data: { email: null } }) })).status, "not_found");
  assert.equal((await findWorkEmailViaTreg({ ...opts, fetchImpl: stub(404, { errors: [{ id: "not_found" }] }) })).status, "not_found");
  assert.equal(
    (await findWorkEmailViaTreg({ ...opts, fetchImpl: stub(200, { data: { email: "x@a.com", verification: { status: "invalid" } } }) })).email,
    null,
  );
  await assert.rejects(findWorkEmailViaTreg({ ...opts, fetchImpl: stub(500, "upstream down") }), /HTTP 500/);
  assert.equal(TREG_EMAIL_ENDPOINT, "hunter.people.email.find");
});

test("a phone lookup posts what is known, caps the waterfall, and reads the routed answer", async () => {
  const seen: Seen[] = [];
  const opts = { token: "t", fullName: "Bo Two", domain: "a.com", meta: { customer: "org_1" } };
  const hit = await findPhoneViaTreg({
    ...opts, linkedinUrl: "https://linkedin.com/in/bo",
    fetchImpl: stub(200, { output: { phone: " +1 415 555 0123 " }, _treg: { served_by: "contactout" } }, { "X-Treg-Call-Id": "c_9", "X-Treg-Cost-Micro": "30000" }, seen),
  });
  assert.deepEqual(hit, { phone: "+1 415 555 0123", status: "found", provider: "treg:contactout", costMicro: 30000, callId: "c_9" });
  assert.match(seen[0].url, /\/call\/treg\.people\.phone\.find$/);
  assert.equal(seen[0].headers["X-Treg-Route-Max-Cost"], String(PHONE_LOOKUP_MAX_COST_USD));
  assert.equal((await findPhoneViaTreg({ ...opts, fetchImpl: stub(200, { output: { phone: null }, _treg: {} }) })).status, "not_found");
  assert.equal((await findPhoneViaTreg({ ...opts, fetchImpl: stub(200, { output: { phone: "n/a" } }) })).phone, null);
  await assert.rejects(findPhoneViaTreg({ ...opts, fetchImpl: stub(500, "upstream down") }), /HTTP 500/);
});

test("a rejected token is a plain ConvexError naming the credential", async () => {
  const rejected = stub(401, { detail: { error: "http_401", message: "invalid token" } }, { "X-Treg-Error": "1" });
  await assert.rejects(
    tregCall({ token: "t", endpoint: "x.y", meta: { customer: "org_1" }, free: true, fetchImpl: rejected }),
    (e: Error) => e.name === "ConvexError" && /TREG_TOKEN/.test(e.message),
  );
});
