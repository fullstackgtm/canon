import assert from "node:assert/strict";
import { test } from "node:test";
import { piServiceHeaders, verifyPiService, signPiCallback, verifyPiCallback, signWatchTicket, verifyWatchTicket } from "../convex/lib/piRuntimeTokens.ts";
import { nextRecovery, type Recovery } from "../services/pi-runtime/src/recovery.ts";

test("a progressing run keeps its recovery budget while a stuck run exhausts it", () => {
  let progress: Recovery | undefined;
  for (let checkpointAt = 0; checkpointAt < 100; checkpointAt++) progress = nextRecovery(progress, checkpointAt);
  assert.deepEqual(progress, { checkpointAt: 99, attempts: 1 });
  for (let retry = 0; retry < 6; retry++) progress = nextRecovery(progress, 99);
  assert.deepEqual(progress, { checkpointAt: 99, attempts: 7 });
  assert.deepEqual(nextRecovery(progress, 100), { checkpointAt: 100, attempts: 1 });
});

test("a watch ticket binds a viewer to one run for one minute and rejects tampering", async () => {
  const now = 1_000_000;
  const token = await signWatchTicket("fixture-signing-key", "run-one", "viewer-one", now);
  assert.deepEqual(await verifyWatchTicket("fixture-signing-key", token, "run-one", now), { runId: "run-one", viewerId: "viewer-one", expiresAt: now + 60_000 });
  assert.equal(await verifyWatchTicket("fixture-signing-key", token, "run-two", now), null);
  assert.equal(await verifyWatchTicket("fixture-signing-key", token, "run-one", now + 60_000), null);
  assert.equal(await verifyWatchTicket("fixture-signing-key", token, "run-one", now - 60_001), null);
  assert.equal(await verifyWatchTicket("another-fixture-key", token, "run-one", now), null);
  assert.equal(await verifyWatchTicket("fixture-signing-key", `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`, "run-one", now), null);
});

test("admission signatures bind the method and full target without granting callback authority", async () => {
  const now = 1_800_000_000_000;
  const headers = new Headers(await piServiceHeaders("fixture-signing-key", "POST", "/runs/run-one", now));
  assert.equal(await verifyPiService("fixture-signing-key", "POST", "/runs/run-one", headers, now), true);
  assert.equal(await verifyPiService("fixture-signing-key", "GET", "/runs/run-one", headers, now), false);
  assert.equal(await verifyPiService("fixture-signing-key", "POST", "/runs/run-two", headers, now), false);
  assert.equal(await verifyPiService("fixture-signing-key", "POST", "/runs/run-one?probe=1", headers, now), false);
  assert.equal(await verifyPiService("fixture-signing-key", "POST", "/runs/run-one", headers, now + 60_001), false);
  assert.equal(await verifyPiCallback("fixture-signing-key", JSON.stringify({ runId: "run-one", operation: "fail", data: {} }), headers.get("X-Canon-Pi-Time"), headers.get("X-Canon-Pi-Signature"), now), false);
  assert.equal(headers.has("Authorization"), false);
});

test("Canon callback HMAC binds the full command and rejects stale or altered requests", async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now);
  const body = JSON.stringify({ runId: "run-one", operation: "finish", data: { stepId: "s1" } });
  const signature = await signPiCallback("fixture-signing-key", body, timestamp);
  assert.equal(await verifyPiCallback("fixture-signing-key", body, timestamp, signature, now), true);
  assert.equal(await verifyPiCallback("fixture-signing-key", body.replace("run-one", "run-two"), timestamp, signature, now), false);
  assert.equal(await verifyPiCallback("fixture-signing-key", body, timestamp, signature, now + 60_001), false);
  assert.equal(await verifyPiCallback("wrong-key", body, timestamp, signature, now), false);
  assert.equal(await verifyPiCallback("", body, timestamp, signature, now), false);
});
