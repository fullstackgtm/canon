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
lists and checkboxes too.

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
rows: they have no version check or recycle bin, `source` does not apply, and
create is fill-only (dedupe by domain or person, like `canon_upsert_accounts`).

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
| `forbidden` | 403 | agent token, or the user's role cannot do this |
| `unknown_object`, `not_found` | 404 | no such object or record |
| `invalid_request` | 400 | malformed body, query or filter |
| `validation_failed` | 422 | values rejected by the object's fields |
| `version_conflict` | 409 | `expectedVersion` is stale |
| `unsupported` | 405 | the object has no such verb (for example delete of companies) |
| `not_configured`, `internal` | 503, 500 | server side |

## Verbs

Records come back as `{id, object, version, status, title, values, createdAt, updatedAt, deletedAt}`.

**List.** `filter` repeats, as `field:op:value` with the list view's ops (`eq neq in contains startsWith gt gte lt lte hasAny hasAll empty notEmpty`; list values comma-separated; `empty` and `notEmpty` take no value). `sort=field:asc|desc`, `limit` (1 to 200), `cursor` from `nextCursor`, `deleted=true` for archived records. Returns `{data, nextCursor, total}`.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/records/lead?filter=company:contains:acme&sort=updatedAt:desc&limit=50"
```

**Get.** `{data}`. Companies and people use their register id (`acc_...`); others their record id.

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID"
```

**Create.** `201` with `{status, id, version, data}`. `Idempotency-Key` makes a company or person create safe to retry.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"lastName":"Rivera","company":"Acme"}}' "$BASE/api/v1/records/lead"
```

**Update.** `PATCH`, only the fields sent change; `null` clears one.

```sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"company":"Acme Inc"},"expectedVersion":3}' "$BASE/api/v1/records/lead/$ID"
```

**Delete** archives the record: it leaves lists, search, reports and agents until restored, and nothing is erased. Deals archive too (`?expectedVersion=n` optional).

```sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID"
```

**Restore.**

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/records/lead/$ID/restore"
```

Deal create takes the deal's own fields (`name`, `closeDate`, `stage`, ...) in
`values`, as `canon_create_deal` does.

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
