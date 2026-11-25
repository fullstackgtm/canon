import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  PublicHttpSsrfError,
  ipIsLoopback,
  ipIsPrivate,
  publicHttpGet,
  publicHttpPost,
  resolvePublicAddresses,
  type PublicLookup,
  type PublicRequestHop,
} from "../engine/src/publicHttp.ts";

test("public HTTP rejects a hostname with mixed public and private DNS answers", async () => {
  const lookup: PublicLookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(resolvePublicAddresses("mixed.example", lookup), /private\/internal.*127\.0\.0\.1/);
});

test("public HTTP pins the validated DNS result into the socket request", async () => {
  let lookups = 0;
  const lookup: PublicLookup = async () => {
    lookups++;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const requestHop: PublicRequestHop = async (_url, addresses) => {
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    return { status: 200, headers: new Headers(), body: new Uint8Array() };
  };
  await publicHttpGet("https://rebind.example/", { lookup, requestHop });
  assert.equal(lookups, 1, "the transport must not perform an unvalidated second lookup");
});

test("public HTTP validates every redirect before issuing the next request", async () => {
  let requests = 0;
  const lookup: PublicLookup = async (host) => host === "public.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "169.254.169.254", family: 4 }];
  const requestHop: PublicRequestHop = async () => {
    requests++;
    return { status: 302, headers: new Headers({ location: "http://metadata.example/latest" }), body: new Uint8Array() };
  };
  for (const send of [publicHttpGet, publicHttpPost]) {
    requests = 0;
    await assert.rejects(send("https://public.example/", { lookup, requestHop, maxRedirects: 2 }), /private\/internal/);
    assert.equal(requests, 1, "no request may be sent to an unsafe redirect destination");
  }
});

test("public HTTP strips credentials on cross-origin redirects", async () => {
  const seen: Record<string, string>[] = [];
  const lookup: PublicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const requestHop: PublicRequestHop = async (url, _addresses, headers) => {
    seen.push(headers);
    if (url.hostname === "a.example") {
      return { status: 302, headers: new Headers({ location: "https://b.example/" }), body: new Uint8Array() };
    }
    return { status: 200, headers: new Headers(), body: new Uint8Array() };
  };
  await publicHttpGet("https://a.example/", {
    lookup, requestHop,
    headers: { Authorization: "Bearer secret", Cookie: "session=secret", "User-Agent": "test" },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { "User-Agent": "test" });
});

test("ipIsPrivate blocks IPv4-translated SIIT, deprecated site-local, NAT64, and expanded IPv6 private forms", () => {
  const blocked = [
    // IPv4-translated SIIT (::ffff:0:0:0/96)
    "::ffff:0:0:0",
    "::ffff:0:127.0.0.1",
    "::ffff:0:7f00:1",
    "::ffff:0:93.184.216.34",
    "0:0:0:0:ffff:0:5db8:d822",
    // Deprecated site-local (fec0::/10)
    "fec0::1",
    "fed0::1",
    "feff::ffff",
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::93.184.216.34",
    "0064:ff9b:0000:0000:0000:0000:0808:0808",
    "64:ff9b:1::1",
    "0064:ff9b:0001:abcd::1",
    // Expanded leading-zero loopback and IPv4-mapped private
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    // Malformed / zone ID fail closed
    "fe80::1%eth0",
    "010.0.0.1",
  ];
  for (const addr of blocked) {
    assert.equal(ipIsPrivate(addr), true, `${addr} must be blocked`);
  }
  for (const addr of ["93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b:2::1"]) {
    assert.equal(ipIsPrivate(addr), false, `${addr} must stay public`);
  }
  assert.equal(ipIsLoopback("127.0.0.1"), true);
  assert.equal(ipIsLoopback("::1"), true);
  assert.equal(ipIsLoopback("0:0:0:0:0:0:0:1"), true);
  assert.equal(ipIsLoopback("169.254.169.254"), false);
});

test("publicHttpPost pins DNS once (immune to 0-TTL rebinding), does not follow redirects, and enforces loopback opt-in", async () => {
  // Simulate a 0-TTL DNS rebinding domain: first lookup returns public IP, second would return IMDS.
  let lookups = 0;
  const rebindingLookup: PublicLookup = async () => {
    lookups++;
    return lookups === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }];
  };
  let seenMethod: string | undefined;
  let seenBody: string | Uint8Array | undefined;
  const requestHop: PublicRequestHop = async (_url, addresses, _headers, _timeoutMs, _maxBytes, req) => {
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    seenMethod = req?.method;
    seenBody = req?.body;
    return { status: 302, headers: new Headers({ location: "http://169.254.169.254/latest/meta-data" }), body: new Uint8Array() };
  };
  const res = await publicHttpPost("https://rebind.example/hook", {
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
    lookup: rebindingLookup,
    requestHop,
  });
  assert.equal(lookups, 1, "DNS must be resolved exactly once");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, '{"ok":true}');
  assert.equal(res.status, 302, "POST must not follow redirects by default");

  // Private/loopback target rejected without allowLoopback; non-loopback private target rejected even with allowLoopback.
  await assert.rejects(
    publicHttpPost("http://127.0.0.1:9999/hook", { allowLoopback: false }),
    (err) => err instanceof PublicHttpSsrfError,
  );
  await assert.rejects(
    publicHttpPost("https://imds.example/hook", {
      allowLoopback: true,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    (err) => err instanceof PublicHttpSsrfError,
  );
  await assert.rejects(
    publicHttpPost("http://localhost:9999/hook", {
      allowLoopback: true,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    (err) => err instanceof PublicHttpSsrfError,
  );

  // Real socket delivery over pinned loopback when explicitly opted in.
  const received: Array<{ method?: string; body: string; header?: string | string[] }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      received.push({ method: req.method, body, header: req.headers["x-test"] });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    let socketLookups = 0;
    const real = await publicHttpPost(`http://localhost:${port}/hook`, {
      lookup: async () => {
        socketLookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
      allowLoopback: true,
      headers: { "content-type": "application/json", "x-test": "pinned" },
      body: '{"event":"ping"}',
      maxBytes: 0,
    });
    assert.equal(real.status, 204);
    assert.equal(socketLookups, 1);
    assert.deepEqual(received, [{ method: "POST", body: '{"event":"ping"}', header: "pinned" }]);
  } finally {
    server.close();
  }
});
