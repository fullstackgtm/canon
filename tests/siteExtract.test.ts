import assert from "node:assert/strict";
import test from "node:test";
import { companyRootDomain, extractCompanyWebsite, rdapRegistrationYear } from "../convex/lib/tam/siteExtract.ts";

const now = Date.UTC(2026, 9, 29);
const page = (html: string) => `<html><body>${html}<p>${"We build equipment for local businesses and support our customers. ".repeat(10)}</p></body></html>`;
const fixture = (pages: Record<string, string>) => {
  const calls: string[] = [];
  return {
    calls, now,
    fetchPage: async (url: string) => {
      calls.push(url);
      return url in pages ? { text: pages[url], finalUrl: url } : null;
    },
  };
};

test("discovers nav/footer before common paths, then sitemap; keeps first real page", async () => {
  const deps = fixture({
    "https://acme.com/": page('<nav><a href="/people">Our team</a><a href="/missing">Careers</a></nav><footer><a href="/offices">Locations</a></footer><a href="/ignored">Contact</a>'),
    "https://acme.com/people": page("Meet our team"),
    "https://acme.com/careers": page("Our careers"),
    "https://acme.com/offices": page("We operate 12 locations."),
    "https://acme.com/contact": "<title>404 Not Found</title>",
    "https://acme.com/sitemap.xml": '<urlset><url><loc>https://acme.com/reach/contact</loc></url></urlset>',
    "https://acme.com/reach/contact": page("Contact our office"),
  });
  const facts = await extractCompanyWebsite("acme.com", deps);
  assert.deepEqual(facts.pages, [
    { kind: "home", url: "https://acme.com/" }, { kind: "team", url: "https://acme.com/people" },
    { kind: "careers", url: "https://acme.com/careers" }, { kind: "locations", url: "https://acme.com/offices" },
    { kind: "contact", url: "https://acme.com/reach/contact" },
  ]);
  assert.equal(deps.calls.includes("https://acme.com/team"), false);
  assert.equal(deps.calls.includes("https://acme.com/ignored"), false);
  assert.ok(deps.calls.indexOf("https://acme.com/missing") < deps.calls.indexOf("https://acme.com/careers"));
  assert.ok(deps.calls.indexOf("https://acme.com/contact-us") < deps.calls.indexOf("https://acme.com/sitemap.xml"));
  assert.equal(deps.calls.filter((u) => u.endsWith("sitemap.xml")).length, 1);
  assert.deepEqual(facts.locationCount, { count: 12, url: "https://acme.com/offices" });
});

test("canonicalizes LinkedIn, deduplicates addresses, and keeps only own-domain role emails", async () => {
  const facts = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page(`<a href="https://uk.linkedin.com/company/ACME/?trk=footer">LinkedIn</a>
      <a href="https://linkedin.com/in/customer">Customer</a><a href="https://x.com/acme">X</a>
      <script type="application/ld+json">{"@type":"Organization","address":{"@type":"PostalAddress","streetAddress":"123 Main St","addressLocality":"Boston","addressRegion":"MA","postalCode":"02110"},"foundingDate":"1987-02-01"}</script>
      <address>123 Main St, Boston, MA 02110</address><address>123 Main St, Boston, MA 02110</address>
      <p>HELLO@acme.com jane.doe@acme.com vendor@other.com wrong@notacme.com hidden@sub.acme.com</p>
      <a href="mailto:hello@acme.com">Email</a><a href="mailto:sales@acme.com?subject=Hello">Sales</a>`),
  }));
  assert.equal(facts.linkedinUrl, "https://www.linkedin.com/company/acme");
  assert.deepEqual(facts.socials, ["https://x.com/acme"]);
  assert.deepEqual(facts.addresses, [{ text: "123 Main St, Boston, MA, 02110", url: "https://acme.com/" }]);
  assert.deepEqual(facts.emails, [{ address: "hello@acme.com", url: "https://acme.com/" }, { address: "sales@acme.com", url: "https://acme.com/" }]);
  assert.deepEqual(facts.founded, { year: 1987, source: "site", url: "https://acme.com/", quote: "1987-02-01" });
  assert.equal(companyRootDomain("https://shop.acme.co.uk/about"), "acme.co.uk");
  assert.equal(companyRootDomain("https://acme.github.io/"), "acme.github.io");
});

test("reads explicit founding patterns, never a copyright year; labels CDX as first seen", async () => {
  for (const phrase of ["Founded in 1987", "Since 1987", "Est. 1987"]) {
    const facts = await extractCompanyWebsite("acme.com", fixture({ "https://acme.com/": page(`${phrase}<footer>Copyright © 2026</footer>`) }));
    assert.deepEqual(facts.founded, { year: 1987, source: "site", url: "https://acme.com/", quote: phrase });
  }
  const facts = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page("<footer>Copyright © 1987–2026 Acme</footer>"),
    "https://web.archive.org/cdx/search/cdx?url=acme.com&limit=1&output=json": '[["urlkey","timestamp","original"],["com,acme)/","20010304050607","http://acme.com/"]]',
  }));
  assert.deepEqual(facts.founded, { year: 2001, source: "wayback", url: "https://web.archive.org/cdx/search/cdx?url=acme.com&limit=1&output=json" });
  const noArchive = await extractCompanyWebsite("acme.com", fixture({ "https://acme.com/": page("Copyright since 1987") }));
  assert.equal(noArchive.founded, undefined);
});

test("uses the shared ATS reader for listed roles on all three public boards", async () => {
  for (const [board, endpoint, payload] of [
    ["https://boards.greenhouse.io/acme", "https://boards-api.greenhouse.io/v1/boards/acme/jobs", '{"jobs":[{"title":"Engineer"},{"title":"Sales"}]}'],
    ["https://jobs.lever.co/acme", "https://api.lever.co/v0/postings/acme?mode=json", '[{"text":"Engineer"},{"text":"Sales"}]'],
    ["https://jobs.ashbyhq.com/acme", "https://api.ashbyhq.com/posting-api/job-board/acme", '{"jobs":[{"title":"Engineer"},{"title":"Sales"},{"title":"Private","isListed":false}]}'],
  ]) {
    const facts = await extractCompanyWebsite("acme.com", fixture({
      "https://acme.com/": page('<nav><a href="/careers">Careers</a></nav>'),
      "https://acme.com/careers": page(`<a href="${board}">Open roles</a>`), [endpoint]: payload,
    }));
    assert.deepEqual(facts.openRoles, { count: 2, url: board });
  }
});

test("blocked, thin and unrelated redirect homepages are unreadable without paid fallbacks", async () => {
  const deps = fixture({ "https://acme.com/": "<body>Enable JavaScript</body>" });
  assert.equal((await extractCompanyWebsite("acme.com", deps)).status, "unreadable");
  assert.deepEqual(deps.calls, ["https://acme.com/"]);
  const redirected = await extractCompanyWebsite("acme.com", { now, fetchPage: async () => ({ text: page("Domain for sale"), finalUrl: "https://other.com/" }) });
  assert.equal(redirected.status, "unreadable");
});

test("keeps JSON-LD staff only with visible evidence on the selected team page", async () => {
  const facts = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page('<nav><a href="/team">Team</a></nav><p>Home Person is our founder.</p><script type="application/ld+json">{"@type":"Person","name":"Home Person"}</script>'),
    "https://acme.com/team": page(`<h1>Our team</h1><p>Jane Doe is our Chief Engineer.</p>
      <script type="application/ld+json">{"@graph":[{"@type":"Person","name":"Jane Doe","jobTitle":"Chief Engineer"},{"@type":"Person","name":"Invisible Person"}]}</script>
      <section class="testimonials"><div><p>Customer Person recommends us.</p></div>
      <script type="application/ld+json">{"@type":"Person","name":"Customer Person"}</script></section>`),
  }));
  assert.deepEqual(facts.staff, [{ fullName: "Jane Doe", title: "Chief Engineer", url: "https://acme.com/team", quote: "Jane Doe is our Chief Engineer." }]);
  assert.equal(facts.staffModelStatus, "skipped-no-key");
});

test("gates model staff by verbatim full names and excludes customer sections", async () => {
  const prompts: string[] = [];
  const deps = fixture({
    "https://acme.com/": page('<script type="application/ld+json">{"@type":"Organization","name":"Acme Equipment"}</script>'),
    "https://acme.com/team": page(`<h1>Our team</h1><div><p>José Martin leads engineering.</p><p>Chief Engineer</p></div>
      <p>Prince is our designer. Acme Equipment builds equipment.</p>
      <section id="reviews"><div><p>Review Person loves our work.</p></div></section>
      <h2>Customer testimonials</h2><p>Quote Person recommends us.</p>
      <h2>Leadership</h2><p>Alex Rivers is our founder.</p>`),
  });
  const facts = await extractCompanyWebsite("acme.com", { ...deps, staffModel: async (prompt) => {
    prompts.push(prompt);
    return { staff: [
      { fullName: "José Martin", title: "Chief Engineer" }, { fullName: "Jose Martin" },
      { fullName: "Prince" }, { fullName: "Invented Person" }, { fullName: "Review Person" },
      { fullName: "Quote Person" }, { fullName: "Acme Equipment" }, { fullName: "Alex Rivers", title: "CEO" },
    ] };
  } });
  assert.deepEqual(facts.staff, [
    { fullName: "José Martin", title: "Chief Engineer", url: "https://acme.com/team", quote: "José Martin leads engineering." },
    { fullName: "Alex Rivers", url: "https://acme.com/team", quote: "Alex Rivers is our founder." },
  ]);
  assert.equal(facts.staffModelStatus, "complete");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].includes("Review Person"), false);
  assert.equal(prompts[0].includes("Quote Person"), false);
});

test("falls back to homepage staff, bounds names, and preserves JSON-LD when the model fails", async () => {
  const deps = fixture({ "https://acme.com/": page(`<h1>Team</h1>${Array.from({ length: 27 }, (_, i) => `<p>Staff Member${i} works here.</p><script type="application/ld+json">{"@type":"Person","name":"Staff Member${i}"}</script>`).join("")}`) });
  const facts = await extractCompanyWebsite("acme.com", { ...deps, staffModel: async () => { throw new Error("offline"); } });
  assert.equal(facts.staff?.length, 25);
  assert.deepEqual(facts.staff?.[0], { fullName: "Staff Member0", url: "https://acme.com/", quote: "Staff Member0 works here." });
  assert.equal(facts.staffModelStatus, "failed");
});

test("erases a normalized person and prevents in-flight and later writes from restoring them", async () => {
  const { loadConvex, memoryDb } = await import("./convexHandlers.ts");
  const handlers = loadConvex(["companyWebFacts.ts"])["companyWebFacts.ts"];
  const db = memoryDb({ companyWebFactReads: [{ _id: "read", domain: "acme.com", startedAt: 1 }] });
  const facts = { domain: "acme.com", status: "ok", fetchedAt: now, pages: [], socials: [], addresses: [], emails: [], staff: [
    { fullName: "José O'Neil", url: "https://acme.com/team", quote: "José O'Neil works here." },
    { fullName: "Jane Doe", url: "https://acme.com/team", quote: "Jane Doe works here." },
  ] };
  await handlers.erasePerson.handler({ db }, { domain: "https://www.acme.com/team", fullName: "  JOSE O NEIL ", reason: "Deletion request" });
  await handlers.finish.handler({ db }, { facts, startedAt: 1 });
  const stored = () => JSON.parse(JSON.stringify(db.rows("companyWebFacts")[0].staff));
  assert.deepEqual(stored(), [{ fullName: "Jane Doe", url: "https://acme.com/team", quote: "Jane Doe works here." }]);
  await db.insert("companyWebFactReads", { domain: "acme.com", startedAt: 2 });
  await handlers.finish.handler({ db }, { facts, startedAt: 2 });
  assert.deepEqual(stored(), [{ fullName: "Jane Doe", url: "https://acme.com/team", quote: "Jane Doe works here." }]);
  const erased = await handlers.erasePerson.handler({ db }, { domain: "acme.com", fullName: "Jane Doe", reason: "Deletion request" });
  assert.equal(erased.removed, 1);
  assert.deepEqual(stored(), []);
  await handlers.erasePerson.handler({ db }, { domain: "acme.com", fullName: "Jane Doe", reason: "Retry" });
  assert.deepEqual(db.rows("webPeopleSuppressions").map((row) => ({ domain: row.domain, nameKey: row.nameKey })), [
    { domain: "acme.com", nameKey: "joseoneil" }, { domain: "acme.com", nameKey: "janedoe" },
  ]);
});

test("keeps RDAP registration, role families and facility sentences as sourced size clues", async () => {
  const facts = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page('<p>We operate a 40,000-square-foot manufacturing plant.</p><p>We build software for customers who operate a warehouse.</p>'),
    "https://acme.com/careers": page(`<script type="application/ld+json">{"@graph":[${["Field Technician", "Sales Manager", "Software Engineer", "Operations Lead", "Designer", "Welder"].map((title) => JSON.stringify({ "@type": "JobPosting", title })).join(",")}]}</script>`),
    "https://rdap.org/domain/acme.com": JSON.stringify({ events: [{ eventAction: "last changed", eventDate: "2025-01-01T00:00:00Z" }, { eventAction: "registration", eventDate: "1998-07-02T00:00:00Z" }] }),
  }));
  assert.deepEqual(facts.domainRegistered, { year: 1998, url: "https://rdap.org/domain/acme.com" });
  assert.equal(rdapRegistrationYear('{"events":[{"eventAction":"registration","eventDate":"bad-date"},{"eventAction":"registration","eventDate":"2099-01-01"}]}', now), undefined);
  assert.deepEqual(facts.roleFamilies, [
    { family: "field/technician", count: 2, url: "https://acme.com/careers" },
    { family: "sales", count: 1, url: "https://acme.com/careers" },
    { family: "engineering", count: 1, url: "https://acme.com/careers" },
    { family: "operations", count: 1, url: "https://acme.com/careers" },
    { family: "other", count: 1, url: "https://acme.com/careers" },
  ]);
  assert.deepEqual(facts.physicalOperations, [{ quote: "We operate a 40,000-square-foot manufacturing plant.", url: "https://acme.com/" }]);
  const absent = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page('<p>We do not operate a facility.</p><p>Warehouse software for growing businesses.</p><p>We manufacture equipment for your plant.</p>'),
    "https://rdap.org/domain/acme.com": '{"events":[{"eventAction":"last changed","eventDate":"2020-01-01"}]}',
  }));
  assert.equal(absent.domainRegistered, undefined);
  assert.equal(absent.roleFamilies, undefined);
  assert.deepEqual(absent.physicalOperations, []);
});

test("groups ATS job titles and direct career posting links without treating navigation as jobs", async () => {
  const direct = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page("Acme"),
    "https://acme.com/careers": page('<a href="/jobs/installer">Installer</a><a href="/jobs/installer">Installer</a><a href="/jobs/see-all">See all jobs</a><a href="/jobs/accessibility">Learn more about accommodations</a>'),
  }));
  assert.deepEqual(direct.roleFamilies, [{ family: "field/technician", count: 1, url: "https://acme.com/careers" }]);
  const ats = await extractCompanyWebsite("acme.com", fixture({
    "https://acme.com/": page('<a href="https://jobs.lever.co/acme">Careers</a>'),
    "https://api.lever.co/v0/postings/acme?mode=json": '[{"text":"Account Executive"},{"text":"Backend Engineer"}]',
  }));
  assert.deepEqual(ats.roleFamilies, [{ family: "sales", count: 1, url: "https://jobs.lever.co/acme" }, { family: "engineering", count: 1, url: "https://jobs.lever.co/acme" }]);
});
