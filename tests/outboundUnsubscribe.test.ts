import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const ROOT = "unsubscribe-fixture-only";
const PATH = "/outbound/unsubscribe";
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const signed = (tuple: unknown, raw = JSON.stringify(tuple)) => {
  const key = createHmac("sha256", ROOT).update("canoncrm:outbound-unsubscribe.v1:v1").digest("hex");
  return `${Buffer.from(raw).toString("base64url")}.${createHmac("sha256", key).update(raw).digest("hex")}`;
};
const terms = () => ["canon.outbound.unsubscribe.v1", 1, "org", "person@example.test", NOW, NOW + DAY];

function world() {
  let now = NOW;
  let beforeConsume = () => {};
  const config = { env: { TOKEN_ENCRYPTION_KEY: ROOT } as Record<string, string> };
  const human = { _id: "human", orgId: "org", role: "admin", isActive: true, name: "Admin", email: "admin@example.test" };
  const loaded = loadConvex(["lib/outbound/unsubscribe.ts", "lib/outbound/unsubscribeRoute.ts", "outboundUnsubscribe.ts", "suppressions.ts", "lib/suppressions/store.ts"], {
    "lib.ts": (real) => ({ ...real, requireUser: async () => human, getCurrentUser: async () => human }),
  }, { process: config, Date: class extends Date { static now() { return now; } }, URLSearchParams });
  const tokenSource = loaded["lib/outbound/unsubscribe.ts"] as unknown as typeof import("../convex/lib/outbound/unsubscribe.ts");
  const store = loaded["lib/suppressions/store.ts"] as unknown as typeof import("../convex/lib/suppressions/store.ts");
  const routes: Array<{ path: string; method: string; handler: (ctx: unknown, request: Request) => Promise<Response> }> = [];
  const routeSource = loaded["lib/outbound/unsubscribeRoute.ts"] as unknown as typeof import("../convex/lib/outbound/unsubscribeRoute.ts");
  routeSource.registerUnsubscribeRoute({ route: (route: typeof routes[number]) => routes.push(route) } as never);
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [human] });
  const mutationCtx = { db };
  const consume = (token: string) => loaded["outboundUnsubscribe.ts"].consume.handler(mutationCtx, { token });
  const actionCtx = { runMutation: async (ref: unknown, args: { token: string }) => {
    assert.equal(String(ref), "internal.outboundUnsubscribe.consume");
    beforeConsume();
    return consume(args.token);
  } };
  const request = (method: string, query = "", body?: BodyInit, type = "application/x-www-form-urlencoded") => {
    const route = routes.find((route) => route.path === PATH && route.method === method);
    assert.ok(route);
    return route.handler(actionCtx, new Request(`https://canon.test${PATH}${query}`, { method, ...(body === undefined ? {} : { body, headers: { "Content-Type": type } }) }));
  };
  const post = (token: string) => request("POST", `?token=${encodeURIComponent(token)}`, "List-Unsubscribe=One-Click");
  const mint = (over: Record<string, unknown> = {}) => tokenSource.mintUnsubscribeToken({ orgId: "org", address: "person@example.test", expiresAt: now + DAY, ...over } as never);
  const token = async (over: Record<string, unknown> = {}) => {
    const result = await mint(over);
    if (!result.ok) throw new Error("Expected fixture mint to succeed");
    return result.token;
  };
  const humanCall = (name: string, args: Record<string, unknown>) => loaded["suppressions.ts"][name].handler(mutationCtx, args);
  return { db, store, mutationCtx, mint, token, post, request, consume, humanCall, verify: tokenSource.verifyUnsubscribeToken,
    time: (value: number) => { now = value; }, rootOff: () => { delete config.env.TOKEN_ENCRYPTION_KEY; },
    before: (callback: () => void) => { beforeConsume = callback; } };
}
const response = async (res: Response) => ({ status: res.status, body: await res.text(), headers: [...res.headers] });

test("trusted mint uses the existing purpose-derived bytes and canonical bounded terms", async () => {
  const h = world();
  const token = await h.token();
  assert.equal(token, signed(terms()));
  const verified = await h.verify(token);
  assert.ok(verified);
  assert.deepEqual(plain(verified.terms), { version: 1, orgId: "org", address: "person@example.test", issuedAt: NOW, expiresAt: NOW + DAY });
  assert.deepEqual(plain(verified.proof), { kind: "rfc8058", tokenDigest: createHash("sha256").update(token).digest("hex"), issuedAt: NOW, expiresAt: NOW + DAY });
  assert.equal((await h.mint({ expiresAt: NOW + 90 * DAY })).ok, true);
  for (const over of [{ expiresAt: NOW }, { expiresAt: NOW + 90 * DAY + 1 }, { expiresAt: NaN }, { expiresAt: null },
    { address: " Person@Example.test " }, { address: "invalid" }, { orgId: null }, { extra: true }]) {
    assert.deepEqual(plain(await h.mint(over)), { ok: false, code: "invalid_terms" });
  }
  h.rootOff();
  assert.deepEqual(plain(await h.mint()), { ok: false, code: "unavailable" });
  assert.equal(await h.verify(token), null);
});

test("GET only renders confirmation and never writes or reflects unchecked HTML", async () => {
  const h = world();
  const token = await h.token();
  const before = h.db.checkpoint();
  const get = await h.request("GET", `?token=${token}`);
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /method="post"/);
  assert.ok(html.includes(`value="${token}"`));
  assert.equal(html.includes("person@example.test"), false);
  const attack = await h.request("GET", "?token=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal((await attack.text()).includes("<script>"), false);
  assert.equal(attack.headers.get("referrer-policy"), "no-referrer");
  assert.equal(attack.headers.get("cache-control"), "no-store");
  assert.deepEqual(h.db.checkpoint(), before);
});

test("valid one-click and confirmation POST activate one recipient cause with truthful idempotent provenance", async () => {
  const h = world();
  const token = await h.token();
  const first = await response(await h.post(token));
  assert.equal(first.status, 200);
  const row = h.db.rows("suppressions")[0];
  assert.deepEqual([row.orgId, row.kind, row.value, row.source, row.state, row.addedBy, row.addedAt], ["org", "email", "person@example.test", "unsubscribe", "active", undefined, NOW]);
  const proof = { kind: "rfc8058", tokenDigest: createHash("sha256").update(token).digest("hex"), issuedAt: NOW, expiresAt: NOW + DAY };
  assert.deepEqual(plain(row.recipientProof), proof);
  const event = h.db.rows("suppressionEvents")[0];
  assert.deepEqual([event.actor, event.state, event.at], [undefined, "active", NOW]);
  assert.deepEqual(plain(event.recipientProof), proof);
  assert.equal(JSON.stringify(h.db.rows("suppressionEvents")).includes(token), false);
  const checkpoint = h.db.checkpoint();
  assert.deepEqual(await response(await h.post(token)), first);
  assert.deepEqual(await response(await h.request("POST", "", new URLSearchParams({ token, confirm: "unsubscribe" }).toString())), first);
  assert.deepEqual(h.db.checkpoint(), checkpoint);
  const confirmationToken = await h.token({ address: "confirmed@example.test" });
  assert.deepEqual(await response(await h.request("POST", "", new URLSearchParams({ token: confirmationToken, confirm: "unsubscribe" }).toString())), first);
  assert.equal(h.db.rows("suppressions").find((row) => row.value === "confirmed@example.test")?.state, "active");
  const multipartToken = await h.token({ address: "multipart@example.test" });
  const multipart = new FormData();
  multipart.set("List-Unsubscribe", "One-Click");
  const encoded = new Request("https://canon.test", { method: "POST", body: multipart });
  assert.deepEqual(await response(await h.request("POST", `?token=${multipartToken}`, await encoded.text(), encoded.headers.get("content-type")!)), first);
  assert.equal(h.db.rows("suppressions").find((row) => row.value === "multipart@example.test")?.state, "active");
});

test("malformed, expired, unknown-tenant and unavailable-root POST return uniformly without writes", async () => {
  const h = world();
  const token = await h.token();
  const valid = await response(await h.post(token));
  const checkpoint = h.db.checkpoint();
  const mutations: Array<[number, unknown]> = [[1, 2], [2, null], [3, " Person@example.test "], [3, "bad"], [4, NOW + 1], [4, null], [5, NOW], [5, NOW + 90 * DAY + 1], [5, null]];
  const tokens = ["", "malformed", token.replace(/.$/, token.endsWith("0") ? "1" : "0"), signed([...terms(), "unknown"]), signed({ ...terms(), unknown: true }), signed(terms(), ` ${JSON.stringify(terms())}`),
    ...mutations.map(([index, value]) => { const tuple: unknown[] = terms(); tuple[index] = value; return signed(tuple); })];
  for (const candidate of tokens) {
    assert.equal(await h.verify(candidate), null);
    assert.deepEqual(await response(await h.post(candidate)), valid);
    await h.consume(candidate);
    assert.deepEqual(h.db.checkpoint(), checkpoint);
  }
  assert.deepEqual(await response(await h.post(await h.token({ orgId: "missing-org" }))), valid);
  h.time(NOW + DAY);
  assert.deepEqual(await response(await h.post(token)), valid);
  h.time(NOW);
  h.rootOff();
  assert.deepEqual(await response(await h.post(token)), valid);
  assert.deepEqual(h.db.checkpoint(), checkpoint);
});

test("the internal mutation rechecks expiry and signer availability at write time", async () => {
  const h = world();
  const token = await h.token();
  h.before(() => h.time(NOW + DAY));
  assert.equal((await h.post(token)).status, 200);
  assert.equal(h.db.rows("suppressions").length, 0);
  h.time(NOW);
  await h.consume(token);
  assert.equal(h.db.rows("suppressions")[0].value, "person@example.test");
  h.rootOff();
  const checkpoint = h.db.checkpoint();
  await h.consume(token);
  assert.deepEqual(h.db.checkpoint(), checkpoint);
  const unavailable = world();
  const pending = await unavailable.token();
  unavailable.before(unavailable.rootOff);
  assert.equal((await unavailable.post(pending)).status, 200);
  assert.equal(unavailable.db.rows("suppressions").length, 0);
});

test("bounded forms reject duplicates, unknown fields, bad intent, body types and oversized streams", async () => {
  const h = world();
  const token = await h.token();
  const cases = [
    [`?token=${token}&token=${token}`, "List-Unsubscribe=One-Click"], [`?token=${token}`, "List-Unsubscribe=One-Click&extra=1"],
    [`?token=${token}`, "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click"], [`?token=${token}`, "List-Unsubscribe=Other"],
    ["", `token=${token}&confirm=unsubscribe&address=override@example.test`], ["", `token=${token}&confirm=no`],
    [`?token=${token}`, "x".repeat(8193)], [`?token=${"x".repeat(8193)}`, "List-Unsubscribe=One-Click"],
  ];
  const before = h.db.checkpoint();
  for (const [query, body] of cases) assert.equal((await h.request("POST", query, body)).status, 200);
  assert.equal((await h.request("POST", `?token=${token}`, "List-Unsubscribe=One-Click", "application/json")).status, 200);
  assert.deepEqual(h.db.checkpoint(), before);
  await h.post(token);
  assert.equal(h.db.rows("suppressions")[0].state, "active");
});

test("human provenance, legacy DNC and independent causes survive recipient activation and reactivation", async () => {
  const h = world();
  for (const source of ["manual", "bounce", "unsubscribe"]) await h.humanCall("add", { kind: "email", value: "person@example.test", source });
  const unsubscribe = h.db.rows("suppressions").find((row) => row.source === "unsubscribe")!;
  await h.humanCall("lift", { id: unsubscribe._id });
  for (const [id, number] of [["legacy-active", "+14155550123"], ["legacy-lifted", "+14155550124"]]) {
    await h.db.insert("dialerDoNotCall", { _id: id, orgId: "org", number, addedBy: "human", addedAt: 7, contactId: "con_legacy", reason: "Asked on call" });
  }
  const legacy = plain(h.db.rows("dialerDoNotCall"));
  await h.humanCall("migrateDncPage", { orgId: "org" });
  await h.humanCall("lift", { id: "legacy-lifted" });
  const independent = plain(h.db.rows("suppressions").filter((row) => row.source !== "unsubscribe"));
  await h.post(await h.token());
  const current = await h.db.get(unsubscribe._id);
  assert.deepEqual([current?.addedBy, current?.addedAt, current?.state], ["human", NOW, "active"]);
  const lastEvent = h.db.rows("suppressionEvents").at(-1)!;
  assert.equal(lastEvent.actor, undefined);
  assert.ok(lastEvent.recipientProof);
  assert.deepEqual(plain(h.db.rows("suppressions").filter((row) => row.source !== "unsubscribe")), independent);
  assert.deepEqual(plain(h.db.rows("dialerDoNotCall")), legacy);
  const dnc = h.db.rows("suppressions").find((row) => row.legacyId === "legacy-active")!;
  assert.deepEqual([dnc.addedBy, dnc.addedAt, dnc.contactId, dnc.reason, dnc.state], ["human", 7, "con_legacy", "Asked on call", "active"]);
  const result = await h.humanCall("checkIdentifiers", { orgId: "org", identifiers: [{ email: "person@example.test", phone: "+14155550123" }], purpose: "automated_outreach" });
  assert.deepEqual(plain(result[0].email.reasons.map((reason: { code: string }) => reason.code)).sort(), ["suppression.bounce", "suppression.manual", "suppression.unsubscribe"]);
  assert.equal(result[0].voice.code, "suppression.dnc");
});

test("recipient store actors cannot lift or activate other suppression causes", async () => {
  const h = world();
  const verified = await h.verify(await h.token());
  assert.ok(verified);
  const change = { orgId: "org", kind: "email", value: "person@example.test", source: "unsubscribe", state: "active", actor: { kind: "recipient", proof: verified.proof } };
  const before = h.db.checkpoint();
  for (const over of [{ state: "lifted" }, { source: "manual" }, { source: "dnc" }, { kind: "phone", value: "+14155550123" }, { reason: "Forged human note" }]) {
    await assert.rejects(h.store.setSuppression(h.mutationCtx as never, { ...change, ...over } as never));
  }
  assert.deepEqual(h.db.checkpoint(), before);
  await h.store.setSuppression(h.mutationCtx as never, change as never);
  assert.equal(h.db.rows("suppressions")[0].source, "unsubscribe");
});
