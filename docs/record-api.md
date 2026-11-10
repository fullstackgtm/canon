# Record API

`/api/v1/records/<object>` reads and writes any record object over HTTP and
JSON (CP16a). Objects and fields come from the
registry (`objects.describe`), so a new field or object needs no API work.
An admin's own objects (Recipes, Data model, CP7d) are served the same way under their id, `custom_<slug>`: `/api/v1/records/custom_project`. An archived object answers `unknown_object`.
`<object>` is an apiName: `account`, `contact`, `deal`, `lead`, `task`, `note`,
`call`, `meeting`, `product`, `lineItem`. Field names in `values` are field
apiNames; custom fields are `custom.<slug>`. Ask `canon_describe_object` (MCP)
or any record's `values` for the list.

Admins add custom fields in Recipes, Data model (CP7a). A field's apiName
never changes, even when it is renamed, so callers and saved views keep
working. An archived field leaves `describe`, lists and writes; its values stay
in the record's history. Emails, phones and links fields take a list of text,
the first item the primary (`["ann@acme.com", "ann@home.example"]`); a
multi-select takes a list of option values. Companies and people take these
lists and checkboxes too. A currency field's value is in the currency's minor
unit (cents) in both directions: `2400050` is 24,000.50. A date and time is
epoch milliseconds.

An admin can make a custom text, number, emails, phones or links field unique
(Data model, Make unique). Canon first checks every record, archived ones
included, and refuses while two of them share a value, listing the values. A
write that gives a second record a unique value answers `422`
`validation_failed` naming the field; a list field's items each count, and
case and surrounding spaces do not make a value different. `GET
/api/v1/objects` says which fields are `unique`, and the workspace's document
marks them `x-canon-unique`. Companies and people nobody has worked yet are
checked when the field is made unique, but each is held to it only from its
next edit.

## Auth

`Authorization: Bearer <token>`, where the token is one of:

- a paired CLI token (`fsgtm_...`, from `fullstackgtm login` / `canon login`),
  which acts as the user who approved the pairing;
- a Clerk session JWT.

Every call runs as that user in that user's workspace: other workspaces'
records do not exist for the caller (404), and role checks are the dashboard's
(for example only admins and managers write deals). Self-registered agent
tokens (`fsgtm_agent_...`) get 403. On a local dev stack a request with no token
is the demo user; in production it is 401.

## Writes and proposals

Writes call the same Convex functions as the MCP `canon_*` record tools.
A write is applied as the user. To land it as a proposal for review, as an
agent would, send `"source": "agent_run"` (or `enrichment`, `call`,
`pipeline`) with `evidence` and optionally `confidence`: the response is `202`
with `"status": "proposed"` and nothing changes until a reviewer approves it.
`expectedVersion` makes an update fail with 409 instead of overwriting a
concurrent change. Companies and people (`account`, `contact`) are register
rows: they have no version check (an update, archive or restore sent
`expectedVersion` answers 405), `source` does not apply, and create is
fill-only (dedupe by domain or person, like `canon_upsert_accounts`).

A user field, such as `ownerId` or a deal's `primaryRepId`, takes the id of an
active member of the workspace. A lookup takes the id of a record of its object
in the workspace that you can see: a company's or person's register id, or
another record's id. Anything else answers `422` `validation_failed` naming the
field. A record you cannot see is refused exactly as one that does not exist.
CRM syncs and imports are not held to this: they name CRM owners and records
that may not have arrived yet.

## Errors

`{"error": {"code": "...", "message": "..."}}`, plus `errors` (422) or
`currentVersion` and `expectedVersion` (409). Each entry in `errors` names a
`field` and says what it takes. Errors raised by a backend call carry its
`requestId`; quote it when reporting an `internal` error. Unknown paths under
`/api/v1` answer `not_found` in this envelope, not an HTML page. The MCP tools
and the `canon` CLI return the same messages as text
(`src/lib/convexErrorText.ts`).

On deals, `splitAllocations` is a list of `{userId, percentage, kind}` rows. `kind` is `revenue` or `overlay`.
Revenue percentages total 100, with at most two decimal places per row. Overlay credit is additional. Members must
be active in the caller's workspace. Updating or clearing this field requires `expectedVersion`; `null` clears it.
The deal's credit editor, record API and MCP update tool use the same ledger writer. Split changes preserve history
and update the deal projection without changing its amount.

| code | status | meaning |
|---|---|---|
| `unauthorized` | 401 | no, unknown or unverifiable token |
| `forbidden` | 403 | agent token, or the user's role cannot do this (for example a rep archiving a company, or creating a deal) |
| `unknown_object`, `not_found` | 404 | no such object or record |
| `invalid_request` | 400 | malformed body, query or filter |
| `validation_failed` | 422 | values rejected by the object's fields |
| `version_conflict` | 409 | `expectedVersion` is stale |
| `idempotency_key_reused` | 422 | an `Idempotency-Key` sent again with a different request |
| `unsupported` | 405 | the route or object has no such verb (the answer's `Allow` header lists the route's methods), or companies and people were sent `expectedVersion` |
| `rate_limited` | 429 | over a token's or workspace's budget; retry after `Retry-After` seconds |
| `not_configured`, `internal` | 503, 500 | server side |

## Rate limits

Each token has a budget of requests a minute, and so does each workspace, so
several tokens in one workspace cannot multiply it. Reads (`GET`) and writes
(every other method) are counted separately.

| budget | reads a minute | writes a minute | variable |
|---|---|---|---|
| per token | 600 | 300 | `CANON_API_TOKEN_READS_PER_MINUTE`, `CANON_API_TOKEN_WRITES_PER_MINUTE` |
| per workspace | 1,200 | 600 | `CANON_API_WORKSPACE_READS_PER_MINUTE`, `CANON_API_WORKSPACE_WRITES_PER_MINUTE` |

A paired CLI token (`fsgtm_...`) has its own budget, which it shares between
`/api/v1` and the `/mcp` tools. A session JWT is reissued every minute, so its
budget is its user's. An MCP connection signed in through OAuth counts as its
user, and its second ceiling is that user's, since an OAuth token names no
workspace. A tool that writes counts as a write.

Every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` (seconds). They describe the tightest budget that applies.
Past it, the answer is `429` with `Retry-After` (seconds) and
`{"error": {"code": "rate_limited", ...}}`. A request refused this way did
nothing and is not counted. Retrying it after `Retry-After` is safe, a create
included. A create that timed out is safe to retry only with an
`Idempotency-Key` (see Create).

The windows are fixed one-minute windows, counted in the app process. Hosted
Canon runs one app container, and a self-hosted install runs one. An install
with more app replicas allows up to that many times each budget. A deployment
sets its own limits with the variables above: a whole number, or `0` for no
limit. Workspace export and import (`/api/v1/workspace/...`) are not limited.
They take an admin's one-hour key, and a large workspace's export runs to
thousands of pages.

**How the defaults were chosen.** These were measured on a local stack with
10,003 companies, p50 of 15 calls each:

| request | p50 | backend work |
|---|---|---|
| list 50 companies | 71 ms | one record-service query |
| list 200, filtered | 74 ms | one record-service query |
| group by a field | 57 ms | one record-service aggregate |
| get one company | 60 ms | one record-service query |
| create a lead | 169 ms | 3 Convex calls, 5 document writes |
| update a company | 342 ms | about 4 record-service calls and a wait for the projector |

Every request also costs one Convex query to identify the caller. A CLI token
adds one Convex action. A nightly sync of 50,000 updates at 300 a minute takes
under three hours. One client updating companies one at a time makes about 175
a minute. An agent that reads and then writes each record of a list stays
under both budgets. A loop with no pause reads about 1,000 times a minute on one
connection, and ten times that with ten in parallel. It is refused after 600.

## Verbs

Records come back as `{id, object, version, status, title, values, createdAt, updatedAt, deletedAt}`.

**List.** `filter` repeats, as `field:op:value` with the list view's ops (`eq neq in contains startsWith gt gte lt lte hasAny hasAll empty notEmpty`; list values comma-separated; `empty` and `notEmpty` take no value). A value is typed as its field is: a number for numbers and money (cents), epoch milliseconds or an ISO date and time with a timezone for dates and times (`createdAt`, `updatedAt` included), `YYYY-MM-DD` for dates, `true` or `false` for checkboxes, and text otherwise. A formula or rollup field filters as the type it gives. `sort=field:asc|desc`, `limit` (1 to 200, 50 by default), `cursor` from `nextCursor`, `deleted=true` for archived records. Returns `{data, nextCursor, total}`.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/records/lead?filter=company:contains:acme&sort=updatedAt:desc&limit=50"
```

**Groups.** `GET /api/v1/records/<object>/groups?field=<apiName>` counts the records in each value of one field, as a grouped list does: a picklist, owner, lookup or yes/no field, or a date with `bucket=day|week|month|quarter|year` (month by default; date-times bucket by UTC day). `filter` repeats as in List. Returns `{data: [{key, count, sum}], rows, sum, summed, truncated}`: `sum` is a deal's amount in cents, `key` null holds the records with none, and past 100 groups `truncated` is true. A group's records are a List with its key as a filter. A field the caller's role hides cannot be grouped on.

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/groups?field=status"
```

**Get.** `{data}`. Companies and people use their register id (`acc_...`); others their record id.

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID"
```

**Create.** `201` with `{status, id, version, data}`. A company, person or deal create answers `{status, id}` only. A create is never a proposal: a `source` other than `user` is refused, since agents propose values on records that exist.

Send an `Idempotency-Key` header (up to 200 characters; a new UUID per create) to make any create safe to retry, logging an activity included:

- A retry with the same key and body creates nothing and answers as the first request did: the same status, `id` and `version`. `data` is the record as it is now.
- Two requests with one key that arrive at once make one record. Both get the same answer.
- The same key with a different body, or for another object, is refused with `422` `idempotency_key_reused`.
- A ledger, deal or activity create that failed did not use its key: fix it and retry with the same key. A company or person create uses its key once sent, so retry a corrected one with a new key.
- A key is your user's in this workspace: another user's same key, or another workspace's, is a different key. It is kept for 24 hours.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"values":{"lastName":"Rivera","company":"Acme"}}' "$BASE/api/v1/records/lead"
```

The MCP create tools take the same key as an `idempotencyKey` argument: `canon_create_record`, `canon_create_deal`, `canon_upsert_accounts`, `canon_upsert_contacts` and `canon_activities` `log`.

**Update.** `PATCH`, only the fields sent change; `null` clears one. Answers as a create does, with `200`; a company or person update answers `{status, id, version}`.

```sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"company":"Acme Inc"},"expectedVersion":3}' "$BASE/api/v1/records/lead/$ID"
```

**Delete** archives the record: it leaves lists, search, reports and agents until restored, and nothing is erased. It answers as an update does, with the record as it now is (`status: "deleted"`); archiving an archived record answers `unchanged`. `?expectedVersion=n` is optional for ledger records and deals, required for a line item, and refused (405) for companies and people. Companies, people and deals are archived and restored only by admins and managers (403 otherwise). A company or person is archived through the function its own page uses, so the archive shows in its history as the caller's and its Undo is Restore. Get still reads an archived record, with `status: "deleted"`; List leaves it out unless `deleted=true`.

```sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID"
```

**Restore.**

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID/restore"
```

Deal create takes the arguments of `canon_create_deal` in `values`: `name`,
`closeDate` and `stage`, and optionally `amount` (cents), `currency`,
`pipelineId`, `dealType`, `revenueType`, `primaryRepId`, `companyId` and the
deal's `custom.<slug>` fields. A company create takes `domain` and `name`, and
optionally `industry`, `employees`, `country` and `linkedinUrl`; a person
create takes `fullName`, and optionally `accountDomain` or `accountId`,
`title`, `email` and `linkedinUrl`. The OpenAPI document below names every
object's fields.

## Merges, links, deal roles and activities (CP16d)

The writes a record page makes, over the same Convex functions the dashboard
calls and as the token's user, so the dashboard's role checks apply: merging,
undoing a merge and dismissing duplicates need an admin or manager (403
otherwise). Each is also an MCP tool (`canon_duplicates`, `canon_associations`,
`canon_deal_roles`, `canon_activities`; `canon call <tool> --args ...`). All
answer `{data}`. Companies and people are named by register id; a deal by its
stream id (the `id` a deal record returns).

**Duplicates and merges** (`<object>` is `account` or `contact`). Preview shows
each record's values with their source and the default `picks`. `picks` maps a
field apiName to the id of the record whose value survives; an unnamed field
keeps the survivor's. Merge returns `{mergeId, survivorId}`; undo takes the
`mergeId`. Dismiss marks a group (2 to 8 ids) as not duplicates.

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/account/duplicates"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":["acc_1","acc_2"]}' "$BASE/api/v1/records/account/merge/preview"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"survivorId":"acc_1","loserIds":["acc_2"],"picks":{"industry":"acc_2"}}' "$BASE/api/v1/records/account/merge"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/merges/$MERGE_ID/undo"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":["acc_1","acc_3"]}' "$BASE/api/v1/records/account/duplicates/dismiss"
```

**Associations.** `POST /api/v1/associations` with `op` one of `link`
(`contactId`, `accountId`, optional `primary`), `unlink`, `make_primary`
(both ids) or `set_parent` (`accountId`, `parentId` or `null`). `GET
/api/v1/associations?object=account|contact&id=...` reads a record's links.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"op":"link","contactId":"con_1","accountId":"acc_1"}' "$BASE/api/v1/associations"
```

**Deal roles.** `role` is one of `executive`, `n1`, `champion`, `user`,
`procurement`, `security`, `signer`, `involved`. Setting a role adds the person
to the deal if needed.

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/deals/$STREAM/roles"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"contactId":"con_1","role":"champion","reason":"ran the pilot"}' "$BASE/api/v1/deals/$STREAM/roles"
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/deals/$STREAM/roles/con_1"
```

**Activities.** One note, task, call or meeting about several records; the
first company, person and deal fill its lookups and each target gets an edge,
so it shows on every timeline. `201`. `GET
/api/v1/records/<account|contact|deal>/<id>/activities` reads a timeline.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"object":"note","values":{"body":"Intro call"},"targets":[{"object":"account","id":"acc_1"},{"object":"contact","id":"con_1"}]}' "$BASE/api/v1/activities"
```

## OpenAPI

The API is described in an OpenAPI 3.1 document generated from the code the
routes validate with: each operation's query, body and answer shapes
(`src/app/api/v1/_contract.ts`) and each object's fields from the registry,
as `canon_describe_object` gives them. A test sends every described
operation through the real routes and fails when a request or an answer
leaves the document, so the document cannot drift from the API.

- [`docs/openapi.json`](openapi.json) describes the standard objects as an
  admin sees them. Regenerate it with
  `node --experimental-strip-types scripts/build-openapi.ts`; the script
  refuses a change that breaks a stable operation.
- `GET /api/v1/openapi.json` returns the calling workspace's own document:
  its custom objects and fields, without the objects and fields the caller's
  role cannot see, and only the verbs the role may use.
- `GET /api/v1/objects` returns the same objects and fields as plain JSON:
  each field's apiName, type, options, whether it is required and whether
  the caller may write it.

Each operation carries `x-stability`. `stable` marks what this page
documents; `preview` marks what may still change (the Salesforce spot check,
workspace export and import, and the two documents themselves).
`x-canon-undescribed` lists what is not described yet. The relationship
routes' `data` is the Convex function's answer and has no declared shape
yet. Workspace export and import speak the `canon` CLI's own protocol.

`info.version` is the API's own version, `1.x` while the paths stay under
`/api/v1`. It changes when the owner revises the contract. The data epoch and
the record service's contract version describe stored data and an internal
service, not this API.

To generate a typed client, run a generator against either document:

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/openapi.json" > canon.json
npx openapi-typescript canon.json -o canon.d.ts
```

Use the API from your own code: a sync job, a form, an integration that
reads and writes records on a schedule. Use `/mcp` for an agent. Its tools
cover these operations and more (research, plays, reports), describe
themselves, and return errors an agent can act on.

## Webhooks

An admin adds an endpoint in Settings, Webhooks (CP16b): a URL, the objects it
wants (none checked is all) and the events `record.created`, `record.updated`,
`record.deleted` and `record.restored`. The signing secret (`whsec_...`) is
shown once, when the endpoint is added. An endpoint can be disabled (turning it
back on starts it at now; what happened while it was off is not sent) or
deleted, and its last 25 deliveries show their status, HTTP code and tries.
A workspace can have 10 endpoints, and an endpoint only ever receives its own
workspace's events.

**Body.** `POST` with `Content-Type: application/json`:

```json
{
  "event": "record.updated",
  "object": "lead",
  "id": "k57...",
  "changedFields": ["company"],
  "values": { "company": "Acme Inc" },
  "version": 3,
  "at": "2026-10-10T18:04:11.000Z",
  "seq": 41,
  "shard": 3,
  "eventId": "3.41"
}
```

`id` is the id the verbs above take (a company's or person's register id, else
the record id). `values` holds the new value of each changed field, by apiName;
a create carries every value it set, a delete or restore carries none. `at` is
when the change was observed. `eventId` is `<shard>.<seq>`, unique in the
workspace: dedupe on it. Order a record's events by `version`, not by arrival.
Only accepted changes are events: an agent proposal waiting for review is not,
and becomes `record.updated` when a reviewer accepts it.

**Headers.** `X-Canon-Timestamp` (unix seconds), `X-Canon-Signature`
(`v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, the scheme agent
webhooks use), `X-Canon-Event` and `X-Canon-Delivery` (the `eventId`). Verify
the signature over the raw body and refuse a timestamp more than 5 minutes from
your clock; every attempt is signed afresh, so a retry passes and a captured
request replayed later does not.

**Delivery.** At least once. Any 2xx is success; anything else, a timeout (10 s)
or a redirect is a failure and is retried after 30 s, 2 min, 10 min, 30 min,
1 h, 3 h and 6 h (8 attempts in all), then marked failed. Events for one record
can arrive out of order across retries.

**Where events come from.** The ledger (`ledgerEntries`).
Each endpoint keeps a cursor per ledger shard. A fan-out step reads the entries
past the cursors, writes one delivery row per matching entry and moves the
cursors in one transaction, so a crash cannot lose or duplicate an entry. It
runs after every ledger write and again every minute. Companies and people that
no one has worked yet (unworked TAM rows in the record service) are not on the
ledger and produce no events. A record's first ledger entry is its
`record.created`, so a TAM row that is promoted or first edited reports a
create at that point, then its update.

**Destinations.** https only; no credentials in the URL; no IP addresses
(private, loopback and link-local ones in particular), `localhost`, `.local` or
`.internal` names. A name is also resolved at delivery and refused if it points
to a private address. A local dev stack alone may use `http://127.0.0.1` or
`localhost`.
