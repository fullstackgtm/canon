# Phase 0: Data sourcing terms checklist

Before we show licensed data to customers, we need to confirm, per source,
what we may display, keep and must attribute. **Every term below is
[unverified]** unless a primary-source URL and date are written next to it.
This is a checklist of questions, not a statement of anyone's terms. Nothing
here was confirmed from a primary source while this draft was written.

Status key: `[unverified]` means an assumption or not yet checked;
`[confirmed: <url>, <date>]` means it was read in the vendor's own terms or
a signed agreement.

## Questions for every source
1. **Display to customer**: may we show records, raw or derived, to our
   customers inside our product?
2. **Retention after termination**: what happens to records already in
   customer workspaces when our contract ends, or when the customer's does?
3. **Attribution**: is attribution required, and where and in what form?
4. **Anonymous display**: may we show samples without a login (for the
   pre-signup preview)?
5. **Withdrawal and deletion**: obligations when a record is withdrawn
   (opt-out, GDPR/CCPA request), and how we are notified.
6. **Shared index and derived data**: may we store it in an index shared
   across customers? May we keep derived scores?
7. **Sourcing and indemnity**: how the data was collected, and who
   indemnifies whom.
8. **Pricing model**: per record, per credit or bulk licence; minimums.

## Per source

### Clay
- Role: contact samples and enrichment in onboarding (WS3). No API key yet.
- Display to customer: [unverified]
- Retention after termination: [unverified]
- Attribution: [unverified]
- Anonymous display: [unverified]. The current product decision shows
  contacts only after signup (cap about 25 samples per workspace).
- Clay aggregates many upstream providers, so terms may differ by upstream
  source [unverified].

### pipe0 / Crustdata
- Role: removed from the app on 2026-10-06 (treg/Leadsforge replaced the
  contact sweep and email lookup). Still a source in the engine CLI
  (`enrich acquire --source pipe0`).
- Display to customer: [unverified]
- Retention after termination: [unverified]
- Attribution: [unverified]
- Anonymous display: [unverified]
- Whether Crustdata's terms pass through pipe0's: [unverified]

### QuickEnrich
- Role: a step in the contact reveal waterfall. No API key yet.
- Display to customer: [unverified]
- Retention after termination: [unverified]
- Attribution: [unverified]
- Anonymous display: [unverified]

### PDL free company dataset
- Role: the shared company index and the anonymous company preview.
- Licence: recorded as CC BY 4.0 in the user's decision log **[unverified:
  confirm from the licence file shipped with the downloaded dataset and
  from PDL's dataset page]**.
- Display to customer: permitted with attribution if the licence is CC BY
  4.0 [unverified until the licence is confirmed].
- Retention after termination: the free dataset has no contract to
  terminate if it is CC BY 4.0 [unverified].
- Attribution: CC BY 4.0 requires attribution [unverified: confirm the
  exact wording PDL asks for]. Action: once confirmed, add an attribution
  line to the preview and TAM pages.
- Anonymous display: [unverified]. The product decision uses this dataset
  for the company-only preview before signup.
- Paid PDL person and company bulk data has separate, quote-only terms
  [unverified].

### Explorium
- Role: enrichment and signals (key available locally).
- Display to customer: [unverified]
- Retention after termination: [unverified]
- Attribution: [unverified]
- Anonymous display: [unverified]

### TheirStack
- Role: hiring and tech-stack signals (key available locally).
- Display to customer: [unverified]
- Retention after termination: [unverified]
- Attribution: [unverified]
- Anonymous display: [unverified]

### treg.to (Hunter and other upstreams)
- Role: pay-per-call tool registry, and since 2026-10-06 the app's only data
  provider. Free Leadsforge people search populates the pre-signup TAM preview
  and, after claim, the workspace's accounts and contacts. The paid
  `hunter.people.email.find` serves on-demand email lookups. One CanonCRM team
  and balance; each call is tagged `customer=<orgId>`.
- Using the hosted API inside our product and billing our users from its
  `usage/by-tag` ledger: [confirmed: https://treg.to/terms, 2026-10-06]
  ("platform customer of the hosted service — no special agreement is
  needed").
- Self-hosting or embedding treg's code to serve our customers: not allowed
  without written permission. [confirmed:
  https://github.com/superdesigndev/treg/blob/main/LICENSE, 2026-10-06]. The
  site says AGPL; the LICENSE file (Apache 2.0 plus a hosted-service
  restriction) is what applies.
- Upstream terms: treg's terms say calls stay subject to each provider's
  terms and treg is not a party to them. [confirmed: https://treg.to/terms,
  2026-10-06]
- Display to customer and storing results in the CRM (per upstream, Hunter
  first): [unverified]. Treg itself declines to keep bodies for some
  providers, so storage rights differ by upstream.
- Retention after termination: [unverified]
- Attribution: [unverified]
- Liability: as is, capped at the greater of fees paid or US$100.
  [confirmed: https://treg.to/terms, 2026-10-06]

### Leadsforge (through treg.to)
- Role: `leadsforge.people.search`, served free on treg's Leadsforge account.
  It returns names, titles and locations plus company domain, headcount,
  industry and revenue range, but no email or phone. We store these as CRM
  accounts and contacts.
- Volume: at most 1,000 results per search; we split narrower searches past
  it. [observed 2026-10-06]. Treg's free allowance ran out after about 436
  searches in about 5 minutes; treg then refused at our $0 ceiling rather than
  serve through its paid relay (about $0.005 per call). Whether that allowance
  is per team or shared across treg, and when it resets: [unverified].
- Storing search results (no contact channel revealed) in a customer's CRM,
  and keeping them after termination: [unverified]
- Attribution: [unverified]

### QuickEnrich (through treg.to)
- Role: `quickenrich.people.search`, free discovery. 100 people a page in
  about 0.7 s. Cursor paging went past the plan's nominal 5 pages. Each person
  has company domain and name, LinkedIn URL and firmographic ranges, but no
  email or phone. [observed 2026-10-06]
- Limits: treg's account reports `X-RateLimit-Remaining` from 6,000, down one
  per call; the window is [unverified]. Population pauses QuickEnrich below
  500 remaining.
- Storing results, retention, attribution: [unverified]

### Crustdata (through treg.to)
- Role: `crustdata.companies.identify`, free. Up to 25 domains a call, 30
  calls a minute (we pace at 25). Gives real company names and LinkedIn pages
  for accounts whose name was guessed from the domain. [observed 2026-10-06]
- Storing results, attribution: [unverified]

### Other free treg endpoints evaluated (2026-10-06, not wired)
- `dropleads.people.search`: free, real totals (39,812 US VPs of Sales), 50
  a page in about 10 s, LinkedIn URLs, no company domain (it would need
  domain resolution). 2,000 calls a minute, 2M a day on treg's account.
- `leadsforge.companies.lookalike.preview`: free, 25 companies a call with
  domain, name, industry and description; 60 calls a minute.
- `getleadsio.people.decision_makers`: returns decision makers with VALID
  work emails and treg charged $0, but the response reports
  `query_credits_used` equal to the rows, so treg's own getleadsio credits
  pay for it. Not used without a decision: likely a pricing gap on treg's side.

## Email and quote request checklist

Send to each vendor's sales or legal contact. Record the reply and link the
signed document here.

- [ ] Clay: sent ___ / reply ___ / doc ___
- [ ] pipe0 (and confirm Crustdata pass-through): sent ___ / reply ___ / doc ___
- [ ] QuickEnrich: sent ___ / reply ___ / doc ___
- [ ] PDL (free dataset licence confirmation; bulk person/company quote):
      sent ___ / reply ___ / doc ___
- [ ] Explorium: sent ___ / reply ___ / doc ___
- [ ] TheirStack: sent ___ / reply ___ / doc ___
- [ ] Coresignal (bulk quote):
      sent ___ / reply ___ / doc ___
- [ ] Prospeo, Icypeas, Leadsforge, Crustdata, CompanyEnrich (shared index):
      sent ___ / reply ___ / doc ___
- [ ] BlitzAPI (reseller / embedded terms): sent ___ / reply ___ / doc ___
- [ ] Pubrio (display and shared index on free/Growth plans):
      sent ___ / reply ___ / doc ___

Each request should ask, in writing:
- [ ] May we display your records to our paying customers in our UI? Raw
      fields, or only derived fields?
- [ ] May we show a limited sample to anonymous (not logged in) visitors?
- [ ] May customers keep records already delivered after either contract
      ends? Is there a purge obligation, and on what timeline?
- [ ] What attribution text is required, and where?
- [ ] May we store your data in a shared, cross-customer index?
- [ ] How are opt-outs and deletion requests passed to us, and what is our
      deadline?
- [ ] How is the data sourced, and what indemnity is offered?
- [ ] Pricing: per record, per credit or bulk; annual minimum; overage.
- [ ] Rate limits and refresh cadence (needed for Phase 2 job-change
      diffing).

## Exit (Phase 0)
- A signed term sheet for at least one person-data source, **or** a written
  decision to launch with company records only (the PDL free dataset).
- Every `[unverified]` above that gates a shipped feature is replaced by
  `[confirmed: <url or signed doc>, <date>]`.

### Pull social research through treg (2026-10-25)

- Rechecked [treg's hosted-service terms](https://treg.to/terms). Product calls
  tagged by customer are allowed as platform use. Upstream provider terms
  still apply; treg does not grant independent social-platform storage rights.
- PL1 uses TikHub Reddit search, routed X search, AnyAPI LinkedIn posts and
  LinkedIn jobs. Only their public catalog and documented examples were read.
  No paid calls were made. Fixtures are fictional.
- Display, storage, retention, deletion and attribution rights for these
  upstreams remain **unverified**. The public catalog's `platform_eligible`
  flag is not evidence of those rights. Ryan must settle them before enabling
  live dogfooding. This implementation remains installable and off by default.
- Retained full post text stays on a bounded sweep; anecdote docs hold identity,
  source links and verified quotes. No shared cross-customer index is created.

### Canon public-web extraction

- Collected from a company's public pages. Company facts, own-domain role
  mailboxes, and staff names with titles when stated. Named personal email
  addresses are not collected by this flow.
- Lawful basis recorded for this product decision. Legitimate interest for
  business contact data. This is Canon's extraction policy, not a confirmation
  of permission under every site's terms. Each site's own terms still apply.
- Staff come only from the team page, or the homepage when no team page is
  found. Testimonials, reviews, case studies and customer quotes are excluded.
  Each name must appear verbatim in the page text. Its source URL and sentence
  or line are kept with it and displayed to the user.
- These findings are shared across workspaces on the domain's
  `companyWebFacts` document. Staff are bounded to 25 and refreshed with the
  facts after 90 days.
- Every facts write that can store names consults `webPeopleSuppressions` in
  `companyWebFacts.finish`. A deletion removes the name and records its
  normalized key in the global suppression list in the same transaction.
  The key is lowercase with accents, punctuation and whitespace removed.
  Refreshes, including an already running extraction, cannot restore it.

To honor a deletion request, Canon ops runs this internal mutation against the
intended deployment with an authorized CLI session. Replace the example domain,
full name and reason with the request's values.

```sh
npx convex run companyWebFacts:erasePerson '{"domain":"example.com","fullName":"Jane Doe","reason":"Deletion request"}'
```

This slice has no public deletion endpoint. Confirm the target deployment before
running the command. Agents must use their own local backend with the sandbox
HOME form in `AGENTS.md`; this example does not authorize a cloud write.
