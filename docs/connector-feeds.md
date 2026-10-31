# Connector feeds and actions

Status: **PF2 built** (2026-10-20). Shared gap P5 is owned by the Notetaker
track (`docs/module-plans/notetaker.md` section 10). PF1 adds the registry,
links, feed storage, signed webhook and Feeds page. PF2 lets installed modules
read feeds. PF3 adds connector actions.

A connector is Canon code that talks to one outside system with Canon's
secrets. It writes what it learns into **feeds**, and modules read the feeds.
A module never holds a key, a token or a URL Canon didn't hand it, because
module code runs with no network and no secrets (`docs/modules.md`, "Server
code").

## The registry

Each connector is one file in `convex/lib/connectors/`, listed in
`registry.ts`:

```ts
export const webhook = {
  id: "webhook", label: "Signed webhook", scope: "workspace", auth: "signedWebhook",
  env: [],
  feeds: { "webhook.events": { label: "Webhook events", maxItemBytes: 16_384, fields: {
    type: { type: "string", label: "Type" }, occurredAt: { type: "time", label: "Occurred at" },
    subject: { type: "object", label: "Who it is about" }, data: { type: "object", label: "Data" } } } },
} as const satisfies ConnectorDecl;
```

- `scope` is `member` (one link per member: their recorder, their LinkedIn
  sender, their phone line) or `workspace` (links an admin adds).
- `env` names the Canon env vars the connector needs. They live in Doppler.
  The Feeds page lists the missing ones by name, never a value.
- A feed's name starts with its connector's id. Its `fields` are all an item
  may carry; anything else is dropped before it is stored. Field types are
  `string`, `number`, `boolean`, `time` (ms), `object` and `list`. A field of
  the wrong type refuses the item.
- `maxItemBytes` caps one item as JSON. Large payloads (a transcript) live in
  Canon records, and the item carries their id.

## Writing a feed

Canon code writes a feed through one function, `putFeedItem(ctx, link, feed,
item)` in `convex/lib/connectors/feeds.ts`, inside its own mutation:

```ts
const link = await memberLink(ctx, orgId, "linkedin", userId);
await putFeedItem(ctx, link, "linkedin.senders", { id: accountId, version: updatedAt, data: { status, caps } });
```

- `feedItems` keeps each item's latest state, one row per feed and item id.
- `feedLog` appends `{ seq, itemId, before, after }` only when the item's
  stored fields change. `seq` counts from 1 per workspace and feed with no
  gaps, and it is the cursor modules read by. A replayed webhook or a repeated
  poll writes nothing.
- `version` (a number, such as the vendor's updated time) orders updates to
  one item. An item older than the stored one is dropped as `stale`, so a
  status that arrives late doesn't overwrite a newer one.
- `deleted: true` keeps the item's last fields and logs `after: null`.
- A refused item writes nothing and sets its link's `lastError`.
- `memberLink` makes a member's link the first time Canon writes for them. A
  connector that already keeps its own account rows (LinkedIn's
  `linkedinAccounts`, the dialer's profiles) adds one registry file and calls
  `putFeedItem` where its state changes. It needs no linking step of its own.

## The signed webhook

An admin or a manager with `integrations.manage` adds one in **Settings >
Feeds**. Canon shows its URL and signing secret once and stores the secret
encrypted. Rotate secret makes a new one and the old one stops at once.

```sh
body='{"id":"evt_1","type":"usage.daily","data":{"seats":14},"account":{"domain":"atlas.io"}}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.* //')
curl -X POST "$URL" -H "x-canon-timestamp: $ts" -H "x-canon-signature: v1=$sig" -d "$body"
```

- It is signed the way event agents' webhooks are (`lib/agents/webhook.ts`):
  HMAC-SHA256 of `<timestamp>.<body>`, at most 5 minutes old.
- The body is a JSON object with a `type`. `id` (or `event_id`) names the
  item within its webhook, else the body's hash does, so two webhooks never
  share an item. `version` orders updates to one id.
  `occurredAt` is ms or an ISO time. `data` is any object.
- `subject.domain` and `subject.email` explicitly name who the event is about.
  Legacy `account.domain` and the other event-agent forms remain accepted.
- `subject` is who the event is about: a company domain and an email, read
  as event agents read them.
- Answers: 202 with `seq` when written, 200 `unchanged` or `stale`, 401 for a
  bad signature or an unknown link (the same answer), 413 past 256 KB, and
  422 when the feed refuses the item.

Customer success 0.3.0 consumes `usage.daily` snapshots through this webhook.
See [Grow](module-plans/customer-success.md#grow) for the daily metrics contract,
matching rules and review list.

## The Feeds page

Settings > Feeds lists every link: its connector, its member or name, its
status, its last item and how many changes it sent in the last day (up to
1,000). An item refused since the last one it took makes the link an error
until the next one, with the reason shown. A signed webhook has Rotate secret
and Remove. A member's link is removed where they connected it.

## Modules reading feeds (PF2)

A module declares the feeds it reads in its manifest.

```json
"feeds": {
  "checkins": { "feed": "webhook.events", "call": "onCheckins",
    "fields": ["type", "occurredAt", "subject", "data"], "backfillDays": 30 }
},
"calls": {
  "onCheckins": { "label": "Import checkins", "roles": [], "system": true,
    "agent": "allowed", "reads": {}, "writes": ["visits"], "returns": "none" }
}
```

- A manifest declares at most 10 feeds, each with 1 to 20 field names.
  Install and upgrade refuse unknown feeds or fields and name their manifest path.
  The install screen lists the feed and field labels, with "per member" for
  member-scoped connectors.
- Each feed has its own system call. No job, watch, schedule or other feed
  shares that call. Its call's `writes` govern the collections it may write.
  A feed declaration has no `writes`.
- Canon passes `items` in `seq` order, at most 100 per call. Each item is
  `{ seq, id, link: { userId }, at, before, after }`. The member id is null
  for a workspace link. `before` and `after` contain only declared fields.
  `before` is null for a new item. `after` is null for a deletion.
- The call returns `intents`. `byKey` and `replaceSet` are refused.
  Canon applies the intents and moves the cursor in one transaction, only
  while the cursor and module version still match the batch it read.
  A failed call or apply holds the cursor and keeps its error.
- On first enable or an upgrade adding a feed, its cursor starts at the
  current log head. Canon first pages current items updated within
  `backfillDays`, from 0 to 365 days, default 30. Deleted items are skipped.
  Backfill items have `seq: null` and `before: null`. Progress survives
  interruptions. The log follows after backfill finishes.
- Calls must be idempotent. An item changed during backfill can arrive again
  through the log. Use a stable doc key derived from the item id. A one-time
  import uses `put` with `ifAbsent: true` to preserve an existing doc's edits.
- A module receives at most 600 items per workspace in each UTC minute,
  shared across its feeds and concurrent runs. Planning reserves capacity before
  the call, including failed attempts. Beyond that it lags and drops
  nothing. A write wakes feed delivery. The one-minute sweep resumes a
  pending backfill, a failed call or a feed behind its head.
- The Recipes card lists each feed's lag, pending backfill and cursor error.

Field visits 1.42.0 reads `visit.checkin` events into visits. The webhook's
`data.rep` names a workspace member. `data.place`, `data.accountName` or
`data.title` supplies the visit title. `data.date` supplies its date, falling
back to `occurredAt`, then the feed item's time. `data.address` is optional.
Each item creates the stable visit key `checkin:<item id>` only if absent.
Later checkin changes leave the rep's visit, its state and edits unchanged.

```json
{ "id": "visit-1", "type": "visit.checkin", "occurredAt": "2026-10-20T17:00:00Z",
  "data": { "rep": "<member id>", "place": "Atlas", "address": "10 Main St" } }
```

## Member feed read access (PF2b)

Enabled modules receive a member connector's items by default, as declared on
installation. Settings > Feeds shows each member only their own personal links,
the installed modules requesting them and the exact field labels. Workspace
feed health and webhook administration still require `integrations.manage`.

Only the signed-in human account owner can turn off or restore a module's read
access to their link. An admin cannot substitute for that owner. This preference
uses the module's stable id and survives disabling, upgrading or reinstalling it.
An inactive member, a removed link or a member outside the workspace contributes
no items. Both log delivery and backfill enforce the same check.

Revocation stops future delivery. Before committing a batch's writes and cursor,
Canon rechecks the current grants and their revisions, so work computed before a
revocation cannot apply afterward. Already imported records remain and follow the
module's visibility rules, which may include other team members.

Restore schedules a current-state backfill for only that link within the declared
window. The shared log first catches up to the restore's snapshot; its cursor and
unread changes, including other members' deletes, remain intact. The link's own
fill generation rejects batches from before a restart. Feed calls remain
idempotent because current state can also arrive through the log. Grant changes
are recorded in the operation audit log.

These are read permissions only. They authorize no sends, calls or recordings.
LinkedIn account-owner action consent belongs to PF3; an account link, a module
launch or a feed read grant never supplies that consent. Only `webhook.events`
is registered today; real member connectors register their own feed contracts.

## Connector actions (PF3)

A module asks a connector to act through an `action` intent, and never does
the work itself. The same outbox serves every connector:

| Connector | Actions | Floor checked at run time |
|---|---|---|
| `recorder` (Recall.ai, fake vendor locally) | `recorder.schedule`, `recorder.cancel`, `recorder.stop`, `recorder.delete` | recording policy, never-record list, the member attends, Zoom link for external Zoom |
| `linkedin` (Unipile) | `linkedin.invite`, `linkedin.message` | sender caps, ramp, health throttle, risk acceptance |
| `dialer` (Telnyx) | `dialer.call` | calling hours, do-not-call, abandon cap |
| `sequencer` (Instantly, EmailBison, Smartlead) | `sequencer.push` | the per-campaign sent ledger |

- A connector's registry file declares each action: its args, a per-minute
  and a daily cap, its `floor`, and the code that runs it.
- An `action` intent is written to `connectorActions` in the call's apply
  mutation, keyed by module, action and an idempotency key. Canon runs it
  after commit with Canon's secrets.
- The floor runs first. It can answer `blocked` with a reason, which comes
  back to the module through the connector's feed, as any result does.
- Every action is logged with its module, member and cause. This is P4's
  outbound-effect gate applied to connectors, so there is one outbox and one
  log.

A connector's safety rules stay in its floor. A module can't raise a cap or
skip a check, because no module code runs between the floor and the call.
