import assert from "node:assert/strict";
import { test } from "node:test";
import { readWebsite, type WebGet } from "../convex/lib/signals/website.ts";
import { growthKinds } from "../convex/lib/signals/growth.ts";
import { planSignalObservations, WEBSITE_BUCKETS, type LoggedObservation } from "../convex/lib/signals/observations.ts";
import { defaultModel } from "../recipes/index.ts";

const HEAT = defaultModel("signals.heat");

const NOW = Date.UTC(2026, 9, 9);
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW - n * DAY);

const HOME = `<html><head>
<link rel="alternate" type="application/rss+xml" title="Acme blog" href="/blog/rss.xml">
<link rel="alternate" type="application/rss+xml" href="/comments/feed">
</head><body>
<a href="https://twitter.com/intent/tweet?url=x">Share</a>
<a href="https://www.linkedin.com/in/jane-doe">Jane</a>
<a href="https://www.instagram.com/acmeco/">Instagram</a>
<a href="https://www.instagram.com/p/abc123/">A post</a>
<a href="https://www.linkedin.com/company/acme">LinkedIn</a>
<a href="https://www.tiktok.com/@acme">TikTok</a>
</body></html>`;

const SITEMAP = `<?xml version="1.0"?><sitemapindex>
<sitemap><loc>https://acme.com/sitemap-pages.xml</loc><lastmod>${day(40).toISOString()}</lastmod></sitemap>
<sitemap><loc>https://acme.com/sitemap-blog.xml</loc><lastmod>${day(3).toISOString().slice(0, 10)}</lastmod></sitemap>
<sitemap><loc>https://acme.com/sitemap-future.xml</loc><lastmod>2030-01-01</lastmod></sitemap>
</sitemapindex>`;

const FEED = `<?xml version="1.0"?><rss><channel><title>Acme</title>
<item><title><![CDATA[Series B & what's next]]></title><link>https://acme.com/blog/series-b</link><pubDate>${day(2).toUTCString()}</pubDate></item>
<item><title>Hiring our first AE &amp; SE</title><link>/blog/first-ae</link><pubDate>${day(20).toUTCString()}</pubDate></item>
<item><title>Hiring our first AE &amp; SE</title><link>https://acme.com/blog/dup</link><pubDate>${day(25).toUTCString()}</pubDate></item>
<item><title>Ancient history</title><link>https://acme.com/blog/old</link><pubDate>${day(400).toUTCString()}</pubDate></item>
</channel></rss>`;

const site = (pages: Record<string, string | number | null>): WebGet => async (url) => {
  const page = pages[url];
  if (page === null) return null;
  if (page === undefined) return { status: 404, text: "", finalUrl: url };
  return typeof page === "number" ? { status: page, text: "", finalUrl: url } : { status: 200, text: page, finalUrl: url };
};

test("a website read finds the site change, recent posts and social profiles, each quoting its source", async () => {
  const read = await readWebsite("acme.com", site({
    "https://acme.com/": HOME, "https://acme.com/sitemap.xml": SITEMAP, "https://acme.com/blog/rss.xml": FEED,
  }), NOW);
  assert.deepEqual(read.buckets, ["site", "blog", "social"]);
  assert.deepEqual(read.signals.map((s) => [s.signal.trigger, s.signal.url]), [
    [`site updated: ${day(3).toISOString().slice(0, 10)}`, "https://acme.com/sitemap.xml"],
    ["blog: Series B & what's next", "https://acme.com/blog/series-b"],
    ["blog: Hiring our first AE & SE", "https://acme.com/blog/first-ae"],
    ["social: instagram", "https://www.instagram.com/acmeco/"],
    ["social: linkedin", "https://www.linkedin.com/company/acme"],
    ["social: tiktok", "https://www.tiktok.com/@acme"],
  ]);
  for (const { signal } of read.signals) {
    const source = signal.bucket === "site" ? SITEMAP : signal.bucket === "blog" ? FEED : HOME;
    assert.ok(source.includes(signal.quote), `quote is verbatim: ${signal.quote}`);
  }
});

test("a bucket is vouched for only when its source answered", async () => {
  // Homepage down and the sitemap request failed: nothing can be closed.
  const down = await readWebsite("acme.com", site({ "https://acme.com/": null, "https://acme.com/sitemap.xml": null }), NOW);
  assert.deepEqual(down, { signals: [], buckets: [] });
  // Homepage up, no feed anywhere, no sitemap: the site has none of these, so open ones close.
  const bare = await readWebsite("acme.com", site({ "https://acme.com/": "<html></html>" }), NOW);
  assert.deepEqual(bare, { signals: [], buckets: ["site", "blog", "social"] });
  // A feed guess that errored says nothing about the blog.
  const flaky = await readWebsite("acme.com", site({ "https://acme.com/": "<html></html>", "https://acme.com/feed": 503 }), NOW);
  assert.deepEqual(flaky.buckets, ["site", "social"]);
});

test("a website read closes only website signals, never the job board's", () => {
  const log: LoggedObservation[] = [
    { seq: 1, observedAt: NOW - DAY, body: { type: "signal_seen", key: "job:greenhouse:hiring: ae", signal: { bucket: "job", trigger: "hiring: ae", quote: "AE", url: "https://x", board: "greenhouse" } } },
    { seq: 2, observedAt: NOW - DAY, body: { type: "signal_seen", key: "social:social: x", signal: { bucket: "social", trigger: "social: x", quote: "https://x.com/acme", url: "https://x.com/acme" } } },
  ];
  assert.deepEqual(planSignalObservations(log, [], [], NOW, WEBSITE_BUCKETS).map((p) => [p.body.type, p.body.key]), [["signal_gone", "social:social: x"]]);
});

test("growth counts kinds: a fresh role, a fresh site change, two recent posts, two social networks", () => {
  const row = (bucket: "job" | "site" | "blog" | "social", ageDays: number) => ({ bucket, observedAt: NOW - ageDays * DAY });
  assert.deepEqual(growthKinds([row("job", 5), row("site", 40), row("blog", 3), row("social", 90)], NOW, HEAT), ["hiring"]);
  assert.deepEqual(growthKinds([row("site", 1), row("blog", 3), row("blog", 29), row("social", 90), row("social", 1)], NOW, HEAT), ["site", "blog", "social"]);
});
