# Pull social fixtures

All fixtures in `fixtures.ts` are hand-written, fictional provider responses.
No tool was called to record them. Public catalog search and
`GET https://treg.to/catalog/endpoints/<id>` were read on 2026-10-25.

- Reddit: `tikhub.x.reddit-app-fetch-dynamic-search`, GET `query`,
  `search_type=post`, `sort=RELEVANCE`. The catalog example truncates
  `data.search.dynamic.components.main`. The nested post fixture is a faithful
  synthetic reconstruction; its inner post shape still needs a Ryan-triggered
  dev check. The parser traverses bounded nested objects rather than relying
  on a single result-container path.
- X: `treg.x.search.posts`, POST `{q}`. The route documents provider-native
  rows in `output.posts`, and has no example. The AnyAPI child public example
  documents `id`, `text`, `url`, `authorName`, `authorUsername`, `createdUtc`.
  Other routed providers' native field shapes need dev verification.
- LinkedIn posts: `anyapi.linkedin.search.posts`, POST `{query}`. Example
  `output.data.posts` documents the fixture's fields, including `createdUtc`.
- LinkedIn jobs: `anyapi.linkedin.search.jobs.full`, POST `{query, limit}`.
  Example `output.data.items` documents descriptionText and company identity.
  The provider ignores limit and returns one page of up to 25 at a flat price.
- HN: synthetic Algolia `hits` with `objectID`, `author`, `created_at`,
  `story_text`. Search uses the guarded public HTTP client.
- Company jobs: synthetic Greenhouse `jobs` response through the existing
  `discoverBoard` adapter. Lever and Ashby remain supported by that adapter.

Only explicit test-model mode selects these fixtures, before any fetch.
Live errors never select fixtures. The per-call ceiling equals the catalog's
listed price; a routed provider above that ceiling refuses rather than spending
more. `jobs` accepts a company domain or name; `linkedin_jobs` is a separate,
explicitly paid source. Company names resolve through the free CompanyEnrich autocomplete with an exact
name match. An unresolved name refuses and asks for the company domain.
