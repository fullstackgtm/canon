import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  pollSalesforceDeviceLogin,
  refreshSalesforceToken,
  storeCredential,
  startSalesforceDeviceLogin,
  validateSalesforceOrigin,
  validateSalesforceToken,
} from "../engine/src/index.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Drive a poll whose 1 s (minimum) sleeps run on mocked timers, so the test takes no wall time. */
async function withFastTimers<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const promise = run().finally(() => {
    settled = true;
  });
  promise.catch(() => {});
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  return promise;
}

test("salesforce device flow starts, polls through pending, and returns tokens", async (t) => {
  let polls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    assert.match(String(input), /login\.salesforce\.com\/services\/oauth2\/token/);
    if (body.includes("response_type=device_code")) {
      return jsonResponse({
        device_code: "dev-1",
        user_code: "HXRT-4821",
        verification_uri: "https://login.salesforce.com/setup/connect",
        interval: 0.01,
      });
    }
    assert.match(body, /grant_type=device/);
    assert.match(body, /code=dev-1/);
    polls += 1;
    if (polls < 2) return jsonResponse({ error: "authorization_pending" }, 400);
    return jsonResponse({
      access_token: "sf-access",
      refresh_token: "sf-refresh",
      instance_url: "https://org.my.salesforce.com",
    });
  }) as typeof fetch;

  const authorization = await startSalesforceDeviceLogin({ clientId: "consumer-key", fetchImpl });
  assert.equal(authorization.userCode, "HXRT-4821");

  const tokens = await withFastTimers(t, () =>
    pollSalesforceDeviceLogin({
      clientId: "consumer-key",
      deviceCode: authorization.deviceCode,
      intervalSeconds: authorization.intervalSeconds,
      fetchImpl,
    }),
  );
  assert.equal(tokens.accessToken, "sf-access");
  assert.equal(tokens.refreshToken, "sf-refresh");
  assert.equal(tokens.instanceUrl, "https://org.my.salesforce.com");
  assert.equal(polls, 2);
});

test("salesforce device flow surfaces denials instead of looping", async (t) => {
  const fetchImpl = (async () =>
    jsonResponse({ error: "access_denied", error_description: "User denied" }, 400)) as typeof fetch;

  await assert.rejects(
    withFastTimers(t, () =>
      pollSalesforceDeviceLogin({
        clientId: "consumer-key",
        deviceCode: "dev-1",
        intervalSeconds: 0.01,
        fetchImpl,
      }),
    ),
    /User denied/,
  );
});

test("salesforce refresh works without a client secret (device-flow public client)", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=sf-refresh/);
    assert.doesNotMatch(body, /client_secret/);
    return jsonResponse({
      access_token: "sf-access-2",
      instance_url: "https://org.my.salesforce.com",
    });
  }) as typeof fetch;

  const tokens = await refreshSalesforceToken({
    clientId: "consumer-key",
    refreshToken: "sf-refresh",
    fetchImpl,
  });
  assert.equal(tokens.accessToken, "sf-access-2");
  assert.equal(tokens.refreshToken, "sf-refresh");
});

test("validateSalesforceToken accepts 200s and surfaces rejections", async () => {
  const ok = await validateSalesforceToken(
    "good",
    "https://org.my.salesforce.com",
    (async () => jsonResponse({ user_id: "005A" })) as unknown as typeof fetch,
  );
  assert.equal(ok.ok, true);

  const bad = await validateSalesforceToken(
    "bad",
    "https://org.my.salesforce.com",
    (async () => new Response("Session expired", { status: 401 })) as unknown as typeof fetch,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);
});

test("Salesforce origin policy accepts canonical production, sandbox, and My Domain hosts", () => {
  assert.equal(validateSalesforceOrigin("https://login.salesforce.com"), "https://login.salesforce.com");
  assert.equal(validateSalesforceOrigin("https://test.salesforce.com/"), "https://test.salesforce.com");
  assert.equal(validateSalesforceOrigin("https://na123.salesforce.com:443"), "https://na123.salesforce.com");
  assert.equal(validateSalesforceOrigin("https://acme.my.salesforce.com"), "https://acme.my.salesforce.com");
  assert.equal(
    validateSalesforceOrigin("https://acme--staging.sandbox.my.salesforce.com"),
    "https://acme--staging.sandbox.my.salesforce.com",
  );
});

test("Salesforce origin policy rejects credential-exfiltration URL forms", () => {
  const rejected = [
    "http://login.salesforce.com",
    "https://user:pass@login.salesforce.com",
    "https://login.salesforce.com.evil.example",
    "https://salesforce.com.evil.example",
    "https://evil.example/login.salesforce.com",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://login.salesforce.com:8443",
    "https://login.salesforce.com/path",
    "https://login.salesforce.com?next=https://evil.example",
    "https://login.salesforce.com#@evil.example",
    "https://salesfοrce.com", // Greek omicron; URL parsing converts this to punycode.
  ];
  for (const value of rejected) {
    assert.throws(() => validateSalesforceOrigin(value), /Salesforce URL/);
  }
});

test("token endpoints reject unsafe origins before sending credentials", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as typeof fetch;
  await assert.rejects(
    refreshSalesforceToken({
      clientId: "consumer-key",
      refreshToken: "secret-refresh-token",
      loginUrl: "https://login.salesforce.com.evil.example",
      fetchImpl,
    }),
    /Salesforce login URL/,
  );
  assert.equal(calls, 0);
});

test("token responses reject an unsafe instance_url", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      access_token: "sf-access",
      instance_url: "https://org.my.salesforce.com.evil.example",
    })) as typeof fetch;
  await assert.rejects(
    refreshSalesforceToken({ clientId: "consumer-key", refreshToken: "sf-refresh", fetchImpl }),
    /Salesforce token instance_url/,
  );
});

test("Salesforce credential storage rejects unsafe legacy values before writing", () => {
  assert.throws(
    () =>
      storeCredential("salesforce", {
        kind: "private_app",
        accessToken: "must-not-be-stored",
        instanceUrl: "https://org.my.salesforce.com.attacker.example",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    /Salesforce credential instance URL/,
  );
});

test("bearer validation rejects unsafe origins without fetching and disables redirects", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://evil.example" } });
  }) as typeof fetch;
  await assert.rejects(
    validateSalesforceToken("secret", "https://org.my.salesforce.com.evil.example", fetchImpl),
    /Salesforce instance URL/,
  );
  assert.equal(calls, 0);
  const redirected = await validateSalesforceToken("secret", "https://org.my.salesforce.com", fetchImpl);
  assert.equal(calls, 1);
  assert.equal(redirected.ok, false);
  assert.match(redirected.detail, /302/);
});
