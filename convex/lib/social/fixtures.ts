// Synthetic provider responses. Catalog provenance and the Reddit truncation are recorded in README.md.
export const FIXTURE_PROJECT = "I need to reconcile commissions before Friday.";
export const FIXTURE_TEXT = `${FIXTURE_PROJECT} Payroll cannot wait. We tried spreadsheets. They cannot handle split deals. Fixture only: no person, provider or AI was contacted.`;
export const socialFixtures = {
  reddit: { data: { search: { dynamic: { components: { main: { components: [{ posts: [{ id: "t3_fixture", permalink: "/r/revops/comments/fixture/", authorInfo: { name: "fixture-revops" }, title: FIXTURE_PROJECT, selftext: FIXTURE_TEXT, createdAt: "2026-10-25T00:00:00Z" }] }] } } } } } },
  x: { output: { posts: [{ id: "fixture-x", text: FIXTURE_TEXT, url: "https://x.com/fixture/status/1", authorName: "Fixture RevOps", authorUsername: "fixture", createdUtc: 1792886400 }] } },
  linkedin_posts: { output: { data: { posts: [{ id: "fixture-li", text: FIXTURE_TEXT, url: "https://www.linkedin.com/posts/fixture-1", authorName: "Fixture RevOps", authorUrl: "https://www.linkedin.com/in/fixture", createdUtc: 1792886400 }] } } },
  linkedin_jobs: { output: { data: { items: [{ id: "fixture-job", title: "Commission analyst", descriptionText: "Own commission reconciliation. Fixture only, no hiring company exists.", url: "https://www.linkedin.com/jobs/view/1", company: { name: "Fixture company", linkedinUrl: "https://www.linkedin.com/company/fixture" }, createdUtc: 1792886400 }] } } },
  hn: { hits: [{ objectID: "fixture-hn", author: "fixture", created_at: "2026-10-25T00:00:00Z", story_text: FIXTURE_TEXT, title: "Ask HN: commission reconciliation" }] },
  jobs: { jobs: [{ id: 1, title: "Commission analyst", content: "Fixture company needs commission reconciliation. acme.test", absolute_url: "https://acme.test/jobs/1", first_published: "2026-10-25T00:00:00Z" }] },
};
