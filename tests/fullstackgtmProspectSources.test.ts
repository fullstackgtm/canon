import assert from "node:assert/strict";
import test from "node:test";
import {
  hostFromUrl,
  fetchExploriumProspects,
  fetchPipe0CrustdataProspectPage,
  fetchPipe0CrustdataProspects,
  pipe0ResolveCompanyDomains,
  pipe0ResolveProfileContacts,
  pipe0ResolveWorkEmails,
  type Prospect,
} from "../engine/src/connectors/prospectSources.ts";

test("pipe0/Crustdata page forwards and returns opaque pagination cursors", async () => {
  let requestBody: { searches: Array<{ config: { cursor?: string; limit: number } }> } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return new Response(JSON.stringify({
      results: [{
        name: { value: "Ada Lovelace" },
        job_title: { value: "VP Revenue Operations" },
        company_website_url: { value: "https://example.com/about" },
        profile_url: { value: "linkedin.com/in/ada" },
      }],
      next_cursor: "opaque-page-3",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const page = await fetchPipe0CrustdataProspectPage({
    apiKey: "k",
    filters: { locations: ["United States"] },
    limit: 80,
    cursor: "opaque-page-2",
    fetchImpl,
  });

  assert.equal(requestBody?.searches[0].config.cursor, "opaque-page-2");
  assert.equal(requestBody?.searches[0].config.limit, 80);
  assert.equal(page.nextCursor, "opaque-page-3");
  assert.equal(page.prospects[0].fullName, "Ada Lovelace");
  assert.equal(page.prospects[0].companyDomain, "example.com");
});

test("pipe0/Crustdata keeps the legacy array API and normalizes missing cursors", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    results: [{ name: { value: "Grace Hopper" } }],
    search_statuses: [{}],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const page = await fetchPipe0CrustdataProspectPage({ apiKey: "k", filters: {}, fetchImpl });
  assert.equal(page.nextCursor, null);
  const prospects = await fetchPipe0CrustdataProspects({ apiKey: "k", filters: {}, fetchImpl });
  assert.deepEqual(prospects.map((prospect) => prospect.fullName), ["Grace Hopper"]);
});

test("prospect-source HTTP errors never expose response bodies", async () => {
  const canary = "reflected-api-key prospect@example.com";
  const fetchImpl = (async () => new Response(canary, { status: 429 })) as typeof fetch;
  await assert.rejects(
    fetchExploriumProspects({ apiKey: "k", filters: {}, fetchImpl }),
    (error: unknown) => {
      assert.match(String(error), /Explorium prospect search failed: HTTP 429/);
      assert.doesNotMatch(String(error), /reflected-api-key|prospect@example\.com/);
      return true;
    },
  );
});

test("hostFromUrl: bare registrable host from URLs and domains", () => {
  assert.equal(hostFromUrl("https://www.momence.com/about"), "momence.com");
  assert.equal(hostFromUrl("http://ripple.com"), "ripple.com");
  assert.equal(hostFromUrl("stratamedia.co"), "stratamedia.co");
  assert.equal(hostFromUrl(""), undefined);
  assert.equal(hostFromUrl(undefined), undefined);
  assert.equal(hostFromUrl("not a url"), undefined);
});

test("pipe0ResolveCompanyDomains: fills companyDomain from company:identity, leaves resolved ones alone", async () => {
  const calls: Array<{ pipe: string; input: unknown }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ pipe: body.pipes?.[0]?.pipe_id, input: body.input });
    // Echo a company:identity-shaped response: one record per input company.
    const order: string[] = [];
    const records: Record<string, unknown> = {};
    const sites: Record<string, string> = { Momence: "https://momence.com", Ripple: "https://www.ripple.com" };
    (body.input as Array<{ company_name: string }>).forEach((row, i) => {
      const id = `r${i}`;
      order.push(id);
      records[id] = {
        fields: {
          company_name: { value: row.company_name, status: "completed" },
          company_website_url: sites[row.company_name]
            ? { value: sites[row.company_name], status: "completed" }
            : { value: null, status: "failed" },
        },
      };
    });
    return new Response(JSON.stringify({ order, records }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const prospects: Prospect[] = [
    { fullName: "Michael Fontanella", companyName: "Momence" },
    { fullName: "Erica Sene", companyName: "Ripple" },
    { fullName: "Dana Pre", companyName: "Already Inc", companyDomain: "already.com" }, // skipped — has a domain
    { fullName: "Unknowable Person", companyName: "No Website Co" }, // not resolved → left as-is
  ];
  const out = await pipe0ResolveCompanyDomains({ apiKey: "k", prospects, fetchImpl: fakeFetch });

  assert.equal(out[0].companyDomain, "momence.com");
  assert.equal(out[1].companyDomain, "ripple.com");
  assert.equal(out[2].companyDomain, "already.com"); // untouched
  assert.equal(out[3].companyDomain, undefined); // unresolved, not guessed
  // Only companies missing a domain are looked up (3 of 4), deduped by name.
  const looked = calls.flatMap((c) => (c.input as Array<{ company_name: string }>).map((r) => r.company_name));
  assert.deepEqual(new Set(looked), new Set(["Momence", "Ripple", "No Website Co"]));
  assert.ok(calls.every((c) => c.pipe === "company:identity@1"));
});

test("pipe0ResolveProfileContacts enriches LinkedIn prospects with email and mobile", async () => {
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body.pipes.map((pipe: { pipe_id: string }) => pipe.pipe_id), [
      "person:workemail:profileurl:waterfall@1",
      "person:mobile:profileurl:waterfall@1",
    ]);
    return new Response(JSON.stringify({
      order: ["r1"],
      records: { r1: { fields: {
        profile_url: { value: body.input[0].profile_url, status: "completed" },
        work_email: { value: "ada@example.com", status: "completed" },
        mobile: { value: "+15551234567", status: "completed" },
      } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const out = await pipe0ResolveProfileContacts({
    apiKey: "k",
    prospects: [{ fullName: "Ada Lovelace", linkedin: "https://linkedin.com/in/ada" }, { fullName: "No Profile" }],
    fields: ["work_email", "mobile"],
    fetchImpl: fakeFetch,
  });
  assert.equal(out[0].email, "ada@example.com");
  assert.equal(out[0].mobile, "+15551234567");
  assert.equal(out[1].email, undefined);
});

test("pipe0ResolveWorkEmails: resolves across many concurrent chunks and recovers a transient failure", async (t) => {
  // The retry backoff sleeps on setTimeout; mocked timers skip the real wait.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let failedOnce = false;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const inputs = body.input as Array<{ name: string; company_domain?: string }>;
    // Fail the very first call once (transient) — the retry must recover it.
    if (!failedOnce) {
      failedOnce = true;
      return new Response("rate limited", { status: 429 });
    }
    const order: string[] = [];
    const records: Record<string, unknown> = {};
    inputs.forEach((row, i) => {
      const id = `${calls}_${i}`;
      order.push(id);
      records[id] = {
        fields: {
          name: { value: row.name, status: "completed" },
          company_domain: { value: row.company_domain, status: "completed" },
          work_email: { value: `hit@${row.company_domain}`, status: "completed" },
        },
      };
    });
    return new Response(JSON.stringify({ order, records }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const prospects: Prospect[] = Array.from({ length: 7 }, (_, i) => ({
    fullName: `Person ${i}`,
    companyName: `Co${i}`,
    companyDomain: `co${i}.com`,
  }));
  // chunkSize 1 → 7 chunks, run with concurrency; the first chunk 429s then retries OK.
  let settled = false;
  const pending = pipe0ResolveWorkEmails({ apiKey: "k", prospects, fetchImpl: fakeFetch, chunkSize: 1, concurrency: 4 }).finally(() => {
    settled = true;
  });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  const out = await pending;
  const withEmail = out.filter((p) => p.email);
  assert.equal(withEmail.length, 7, "every prospect resolves despite one transient failure");
  assert.ok(out.every((p) => p.email === `hit@${p.companyDomain}`));
});
