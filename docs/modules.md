# Modules: installable data and pages

A recipe changes how Canon works on its own records (`docs/recipes.md`). A
module adds something Canon doesn't have: its own collections of documents and
the pages that show and edit them, reached from one entry in the left nav. A
module ships no React and no Convex code. Its pages are data that Canon draws
with its own components, so a module looks like the rest of Canon and every read
and write goes through checks Canon owns.

This page is the module contract. Its first section builds a module in your own
repository and installs it. The reference starts at "The package". "History", at
the end, lists what each milestone added.

## Build a module from your own repository

A module is a directory in your own repository. It needs the module kit,
`@fullstackgtm/canon-module-kit`, and nothing else from Canon. The kit holds the
contract's types and a command that checks and builds a module. It is licensed
Apache-2.0, so your module can use any license. Use Node.js
22.6 or newer.

### Install the kit

The kit isn't on npm yet, so build its package from a Canon clone and install
that file. npm can't install a package from a subdirectory of a Git repository.
It installs the whole repository, unbuilt. From the directory that will hold
`hello/`:

```sh
mkdir hello && cd hello && npm init -y && cd ..
git clone https://github.com/fullstackgtm/canon
cd canon/modules/kernel
npm install --no-package-lock
npm pack --pack-destination ../../..
cd ../../../hello
npm install --save-dev ../fullstackgtm-canon-module-kit-1.0.0.tgz typescript
```

`npm pack` builds the kit and writes `fullstackgtm-canon-module-kit-1.0.0.tgz`
next to `hello/`. Its version is the one in `canon/modules/kernel/package.json`.
When the kit is on npm, `npm install --save-dev @fullstackgtm/canon-module-kit typescript`
in `hello/` replaces these steps.

pnpm installs a subdirectory of a Git repository and builds it, once you let the
kit and esbuild run their build scripts. In `hello/`:

```sh
printf 'onlyBuiltDependencies:\n  - "@fullstackgtm/canon-module-kit"\n  - esbuild\n' > pnpm-workspace.yaml
pnpm add -D "github:fullstackgtm/canon#path:/modules/kernel" typescript
```

Then run the commands below with `pnpm exec` in place of `npx`.

### Write the smallest module

A module holds a `module.json`. A module with calls also holds a `server.ts`
and the bundle built from it. This one keeps notes and counts them.

`hello/module.json`:

```json
{
  "kind": "module",
  "id": "@you/hello",
  "version": "0.1.0",
  "title": "Hello",
  "description": "Keeps notes and counts them.",
  "author": { "org": "you" },
  "engines": { "moduleApi": "1" },
  "nav": { "label": "Hello", "icon": "box", "section": "Work", "landing": "notes" },
  "collections": {
    "notes": {
      "label": "Note",
      "schema": { "type": "object", "value": {
        "text": { "fieldType": { "type": "string", "maxLength": 500 }, "optional": false, "label": "Note" }
      } },
      "key": "auto",
      "indexes": {},
      "access": { "manager": "all", "rep": "all" }
    }
  },
  "views": { "notes.all": { "kind": "list", "collection": "notes", "limit": 100 } },
  "ops": {
    "notes.create": { "label": "Add a note", "kind": "create", "collection": "notes", "fields": ["text"],
      "roles": ["admin", "manager", "rep"], "agent": "allowed" }
  },
  "server": "dist/module.js",
  "calls": {
    "count": {
      "label": "Count notes", "roles": ["admin", "manager", "rep"], "agent": "allowed",
      "reads": { "notes": { "view": "notes.all", "limit": 100 } },
      "writes": [], "returns": "value",
      "result": { "kind": "kpis", "items": [{ "label": "Notes", "value": "{$result.count}" }] }
    }
  },
  "pages": [
    { "path": "notes", "title": "Notes",
      "bind": { "notes": { "view": "notes.all" }, "count": { "call": "count", "refreshOn": ["notes"] } },
      "body": [
        { "c": "header", "title": "Notes", "actions": [{ "op": "notes.create", "label": "Add a note" }] },
        { "c": "callResult", "from": "count", "label": "Notes" },
        { "c": "table", "from": "notes", "empty": "No notes yet.", "columns": [{ "label": "Note", "value": "{$row.text}" }] }
      ] }
  ]
}
```

`hello/server.ts`:

```ts
import type { CallFunctions, ReadDoc } from "@fullstackgtm/canon-module-kit/calls";

export const calls: CallFunctions = {
  count(_ctx, reads) {
    const notes = reads.notes as ReadDoc[];
    return { value: { count: notes.length } };
  },
};
```

`hello/tsconfig.json` lets TypeScript check `server.ts` against the kit's types:

```json
{
  "compilerOptions": { "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext", "resolveJsonModule": true, "strict": true, "noEmit": true },
  "include": ["server.ts"]
}
```

### Check and build it

From `hello/`:

```sh
npx tsc
npx canon-module-kit check
npx canon-module-kit build
```

`tsc` checks the types. `check` reads `module.json` whole, then every source
file in the directory. It fails on an import that leaves the module. A module
imports only its own files, the kit and npm packages. `build` checks
`module.json`, bundles `server.ts` into the file `server` names, and checks
that the bundle exports a function for every call `module.json` declares. It
prints the bundle's path, size and hash:

```
wrote dist/module.js (142 bytes, 44fa25e8ac4c08380bb134783bfee556)
```

A failed check prints every problem with its path in `module.json`, for example
`pages[0].body[1].from names count, whose call count declares no result to draw`.
Commit `dist/module.js` beside the source. Install reads the committed bundle.

Server code can read its own manifest: `import manifest from "./module.json" with { type: "json" }` bundles it, so a
list such as the attributes `facts.<object>.propose` declares lives in one place. `examples/modules/stale-facts/`
does this. The bundle then holds the manifest's text, and changes when it does.

Import the kit's types with `import type`. The build drops a type-only import,
so the bundle holds none of the kit's code. A value import, such as `migration`
from `@fullstackgtm/canon-module-kit/calls`, is copied into the bundle. Each
file of Canon's `modules/kernel/` is a subpath of the kit: `CallFunctions`,
`CallContext`, `ReadDoc` and `Intent` are in `calls`, fact rows in `facts` and
proposal outcomes in `proposals`.

### Install it from GitHub

Push the directory to a GitHub repository. On Canon's Customization page, an
admin or manager chooses **Browse**, then **From GitHub**, and gives the source
`github:<owner>/<repo>/<path>@<ref>`. `<ref>` is a tag or a branch.
Installed modules start off. Turn the module on from the same page. "Install and
enable" has the details.

### Change it and install again

1. Edit `module.json` or `server.ts`, then run `npx canon-module-kit build` again. The kit needs no Canon backend.
2. Test each call with the kit's `runCall`. It hands a call the context and the reads you give it, after checking the
   reads against your `module.json`: the call declares each read and no other, each Canon record holds only `id`,
   `createdAt` and the fields `reads` grants, each module doc only its collection's fields, fact rows only the
   attributes `facts` declares, and no list is longer than its read's limit. A test that feeds the call data Canon
   wouldn't read for it fails, naming the read.

   ```ts
   import { readFileSync } from "node:fs";
   import { parseModuleManifest } from "@fullstackgtm/canon-module-kit/manifest";
   import { runCall } from "@fullstackgtm/canon-module-kit/testing";
   import { calls } from "./server.ts";

   const parsed = parseModuleManifest(JSON.parse(readFileSync("module.json", "utf8")));
   if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
   const out = await runCall(parsed.manifest, calls, "count", { reads: { notes: [] } });
   ```

   `runCall` does not run Canon's read plan. Which records the caller sees, the fields a role hides, the order and
   pages of a read, and the shape of reports, aggregates, trees and other modules' interfaces are Canon's.
   `tests/staleFactsExample.test.ts` tests Stale facts this way, and checks that the committed bundle matches a fresh
   build.
3. Try it on a self-hosted Canon (`docs/self-hosting.md`) without pushing it. On Customization, under **From GitHub**,
   **A module you're building** takes `module.json` and the bundle from your computer. The install screen is the same
   as for GitHub: what the module reads, proposes and runs, for an admin or a manager to approve. The module shows as a
   **Development install**, never as a release, and its source reads `development install (not a release)`. After
   the next build, choose the new files: the same module upgrades in place and keeps its data, as a new commit does.
   The same files again are refused as already installed, and an older version as going back. A hosted Canon refuses
   development installs; only a self-hosted one (`CANON_AUTH=local`) or a local development stack takes them. An
   agent can't make one. A module with server code also needs the recipe runtime, which a self-hosted Canon doesn't
   start: `docs/self-hosting.md` says how to give it one (`RECIPE_RUNTIME_URL`, `RECIPE_RUNTIME_SECRET`).
4. To release it, commit, push and install the same directory from GitHub. A development install and a GitHub install
   of one module are different sources: uninstall the development one first. "Upgrades" says what an upgrade checks.

### Find the reference and the examples

"The package" lists every key of `module.json`, and each section after it
covers one part of the contract. These examples ship with this repository:

- `examples/modules/stale-facts/` reads the fact ledger and proposes corrections
  for review (see "Facts" and "Writes to Canon records"). It imports the kit by
  its package name, as a module in its own repository does. Inside Canon, a
  `paths` entry in `tsconfig.json` points that name at `modules/kernel/`. Its
  README has its build and install steps.
- `modules/examples/<slug>/` holds Canon's open modules, which "Modules Canon
  ships" describes. Inside Canon, `npm run module:build -- <dir>` runs the kit's
  `build` on one of them.

## The package

A module is a directory in a GitHub repo holding `module.json`, at most
2 MB as fetched and 900 KB (in UTF-8 bytes) without its spacing, which is how Canon
stores it: the package row holds the serving manifest in one Convex document of at
most 1 MiB, and an upgrade's next manifest waits in a document of its own
(`moduleManifests`), so the two never share one. 900 KB leaves the rest of the row
over 100 KB; the largest module Canon ships stores 391 KB. Canon reads it without running anything. It is checked whole by
`parseModuleManifest` (`modules/kernel/manifest.ts`), and every error names its
path, as `pages[2].body[1].rowLink`.

| Key | What it is |
|---|---|
| `kind` | `"module"` |
| `id` | `@scope/name`, as a recipe package's. Data is keyed by it. The name is the module's address, `/dashboard/m/<name>/`, so a workspace holds one module per name. |
| `version` | Plain semver, `1.2.0`. |
| `title`, `description`, `author.org` | What the Customization page and the install screen show. |
| `engines.moduleApi` | `"1"`. |
| `nav` | `{ label, icon, section, landing }`: the one nav entry. `icon` is one of `box`, `clipboard`, `coins`, `receipt`, `scale`, `target`, `briefcase`, `chart`, `map`, `sparkles`. `section` is `CRM`, `Work`, `Activity` or `Admin`. `landing` is the path of a page without parameters, or one per role: `{ "default": "visits", "rep": "mine" }` (each a page that role sees; the nav entry then opens the module's root, which lands each role on its own page). |
| `collections` | The module's data. |
| `views` | Named reads of a collection. |
| `ops` | Named writes. |
| `machines` | Optional. State machines over a collection's status field. |
| `reads` | Optional. The Canon records the module's calls read, and which fields: `{ "deals": ["amount", "closeDate", "ownerId"], "users": ["name"] }`. The install screen lists them. |
| `facts` | Optional. The fact ledger attributes its calls read, by object: `{ "companies": { "read": ["industry", "custom.tier"] } }`. The install screen lists them. See "Facts". |
| `provides`, `uses` | Optional. Interfaces other modules may read, and the ones it reads. See "Reading another module". |
| `proposes` | Optional. The writes to Canon's records its calls may propose, each held for a person. See "Writes to Canon records". |
| `server`, `calls` | Optional. The server bundle's path (`dist/module.js`) and the calls it runs. See "Server code". |
| `jobs`, `watches`, `feeds`, `schedules` | Optional. Background work Canon runs as the module's system principal. See "Jobs, watches and schedules". |
| `exports` | Optional. CSV or Excel a page downloads and an agent reads. See "Records, exports and print". |
| `csvImports` | Optional. CSV a person imports through Canon's import flow into one of the module's calls. See "CSV imports". (`imports` is Canon's one-time data imports, "Imports from Canon".) |
| `migrations` | Optional. What upgrading from an older version does to each stored doc. See "Upgrades and migrations". |
| `collections.<name>.report` | Optional. The fields reports group, filter and measure by. See "Reports and charts". |
| `upgrade` | Optional. `{ job, key? }`: a job dirtied once when this version starts serving over an earlier one. See "Upgrades". |
| `pages` | The pages, each a list of components. |

## Collections

A top-level collection may declare `max`, an integer up to `MAX_VIEW_LIMIT`.
Canon enforces it in the document-write transaction, including trusted imports
and call intent batches, and when an installed or migrated version publishes.
An upgrade refuses existing data above the new limit. `max` on a set is rejected,
since staged and retired generations are not live rows. Calls may attach
`expectCount: [{ collection, count }]` to an intent for a capped top-level
collection. Canon checks these snapshot counts with every `expect` before any
write, so concurrent first/default or tree edits cannot act on an incomplete
snapshot.


A collection is a set of documents of one shape.

```json
"visits": {
  "schema": { "type": "object", "value": {
    "title": { "fieldType": { "type": "string" }, "optional": false },
    "rep": { "fieldType": { "type": "ref", "to": "users" }, "optional": false },
    "status": { "fieldType": { "type": "union", "value": [{ "type": "literal", "value": "planned" }, { "type": "literal", "value": "done" }] }, "optional": false }
  } },
  "key": "auto",
  "owner": "rep",
  "indexes": { "byRep": ["rep", "status"] },
  "access": { "manager": "team", "rep": "own" }
}
```

- **`activity`** includes the collection's readable docs on related record timelines and in
  `activities.forCompanies` and `activities.forDeals`. For example:
  ```json
  "activity": {
    "kind": "visit", "subject": "title", "at": "visitOn", "owner": "rep",
    "status": "status", "targets": { "companies": "company", "people": "contacts", "deals": "deal" },
    "path": "visits/:key"
  }
  ```
  `subject` and optional `status` name text or text-choice fields. Optional `at` names a date or a
  timestamp with widget `time`, and falls back to creation time when empty. Optional `dueDate` names
  a date field. Optional `owner` names a user ref. Target fields hold scalar or array refs of the
  named type. At least one target field is required. `path` names a declared detail page that binds
  this collection by its route `key`. Canon encodes the key in the link.

  The activity has `kind: "module"`, its declared `activityKind`, and a `source` with `moduleId`,
  `collection`, `key`, and `href`. Reads require explicit activity grants for `activityKind`, `source`,
  and `href`, as for other fields. The optional `date` grant preserves a calendar-valued `at` without a timezone shift. Collection scopes, parent visibility, and live set generations
  apply. Off, uninstalled, and cutting-over modules contribute nothing. Hidden related records
  contribute neither IDs nor labels. Deal refs use projected IDs in docs and module reads, and
  verified opportunity stream IDs on timelines.

  A request scans at most 1,000 docs across activity collections, including hidden and retired
  rows. It accepts at most 1,000 targets and 100 enabled module entries. Overflow refuses exact module reads. A timeline preserves ledger activities and shows a module-activity warning when the scan bound is exceeded.
  Module reads also refuse when combined ledger and module rows exceed their declared limit.
  Timelines retain their 150-item display limit. `since` filters doc creation time, as it does for ledger activities. Activities reports, command-palette search,
  activity watches, and lead targets do not yet include these docs.
- **`schema`** is Convex's ValidatorJSON, what `v.object({...}).json` gives:
  `null`, `number`, `boolean`, `string`, `any`, `literal`, `array`, `object`,
  `union` and `record`. Every write is checked against the schema. The same
  schema picks each form field's widget and is what `canon_module describe`
  shows an agent (as JSON Schema; a variant as its object's `allOf` of
  if/then). Canon adds:
  - **Refs**: `{ "type": "ref", "to": "users" }` (a member of the workspace),
    `"deals"` (a deal the writer can see, not archived), `"teams"`, `"companies"` or `"people"` (a company or
    person the writer can see), or `{ "type": "ref", "to": "doc", "collection": "visits" }` (a doc of that
    collection the writer can read). Each is checked on every write; a job's
    writes check only that it exists in the workspace.
  - **Refs to companies and people** are the record service's, which a mutation can't read. So the action in front of
    a write admits them: its first run writes nothing and lists the ones its docs don't already hold, the writer's
    record client says which of those they see (a job's: which live in the workspace), and it runs again with those.
    `writeOp` is that action, and so are a call's and a job's writes. The original `op` mutation stays available for
    older clients. Dashboard and MCP writes use `describe.recordRefs` to select `writeOp` once the backend supports it.
    A transition, the original mutation, Canon's own op or transition, and an
    approved proposal admit none, so there only a company or person the doc already held passes. One layer judges them,
    `refResolver` in `convex/lib/modules/scope.ts`; one function admits them, `admitRecords` in `convex/modules.ts`
    (`tests/moduleSurfaces.test.ts` lists every write that takes admitted refs). Upgrades and migrations keep only refs
    the same doc already held. They cannot introduce new company or person refs. A people ref may name `company`, the
    sibling holding a companies ref, a list's sibling too: `"contacts": { "type": "array", "value": { "type": "ref",
    "to": "people", "company": "company" } }`. Its picker then offers that company's people; a write doesn't check
    it, so a visit's contacts may include a partner's. A page reads their names and joined fields as the caller
    (`api.modules.records`), `{$row.company|ref}` names one, a list of refs reads as their names, and a join gives
    the fields `reads.companies` or `reads.people` grants: `{$visit.company.industry}`. A call reads the people a
    doc names with `people.byIds` and `"ids": { "read": "visit", "field": "contacts" }`: their name, title and,
    granted, email, server side.
  - **Variants**: `{ "type": "variant", "variantOf": "type", "cases": { "flat_rate":
    {object}, "tiered": {object} } }` is an object field whose shape its sibling
    field picks: the value of `type` names the case, and a value with no case
    takes none. The sibling holds a list of values; each case is one of them.
    So a rule's `config` is checked against its `type` on every write, by an op,
    a call or a job alike.
  - **Refs under a parent**: a doc ref to a set collection may name `parent`, the sibling field holding the key of
    the doc it sits under: `"stop": { "type": "ref", "to": "doc", "collection": "stops", "parent": "visit" }` (a
    dispute's line is one of its statement's lines). Its picker offers only that doc's live set, and every write
    checks the doc it names sits there.
  - **Text bounds**: `{ "type": "string", "maxLength": 500 }`. Every write is checked against it, its input takes no
    more and counts down near it, and `describe` shows it as JSON Schema's `maxLength`.
  - **Files**: `{ "type": "file", "accept"?: [".pdf", "image/*"], "maxBytes"?: n }`
    holds a file a person uploads (10 MB unless it says, 19 MB at most). See "Files".
  - **Labels**: a union of literals may carry `"labels": { "won": "Closed won" }`,
    what tables, forms and status steps show for each value.
  - **Field hints**: a field may carry `label`, `widget` and `help`: how every
    form, dialog and nested editor shows it (`"widget": "money"` on a tier's
    threshold, `"date"` on a period's start). A text field's `"suggest": true`
    makes its input offer the values it already holds in the docs the person reads,
    most used first (`api.modules.suggest`): an activity's kind written the way the
    team writes it.
- **`key`** is `"auto"` (Canon makes one) or `{ "from": [fields] }`: the
  fields' values joined by `|`, so it is unique and an update can't change it.
- **`owner`** names a `ref users` field. It is what `own` and `team` compare with
  the caller. A create that leaves it out sets it to the caller.
- **`indexes`** (required; `{}` declares none): at most 8, each of at most 4 top-level fields that hold one
  value (text, a number, true/false, a literal or a member). Each is one of the
  8 physical index slots of Canon's `moduleDocs` table, in the order declared.
- **`access`**: per role, which docs it reads. `all`, `team` (owned by the
  caller or anyone on a team they belong to or lead), `hier` (owned by the caller
  or anyone under them by manager: the members whose `managerId` is theirs, and
  theirs in turn, ten levels down, so a VP reads their managers' reps without
  leading their teams; at most 2,000 people, else it refuses), `own`, or `none`; or
  `{ "scope": ..., "where": { "field", "in": [values] } }` to narrow further
  ("reps see only submitted ones"), or `"where": { "field", "neq": value }`
  ("reps never see drafts"). `in` reads a missing field as null; `neq` fails a
  missing field, so a doc without the field stays hidden. `{ "all": [...] }`
  combines conditions, and `{ "ref": field, "collection"?, "where" }` tests the
  module doc a field names (a doc ref, or text holding a key of `collection`):
  "reps see a month's tallies once the month is closed",
  `{ "ref": "month", "collection": "months", "where": { "field": "status", "in": ["closed"] } }`.
  It is false when that doc isn't there. `{ "scope": "own" | "team" | "hier", "or": <condition> }` widens instead:
  the role reads its scope's docs and every doc the condition holds on, so reps read their own audiences and the
  shared ones, `{ "scope": "own", "or": { "field": "shared", "in": [true] } }`. Writes ask the same scope, so an op
  that only a doc's owner may run says so in a guard (`{ "caller": "isOwner" }`). A collection with a `report` can't
  use `or` yet. The `where` may test a further doc the
  related one names, up to three docs away, each ref past the first naming its
  `collection`: "a rep reads a dispute only while its statement's plan is shown to
  reps", `{ "ref": "statementKey", "collection": "statements", "where": { "ref":
  "planKey", "collection": "plans", "where": { "field": "hiddenFromReps", "in":
  [false, null] } } }`. Canon reads the related docs itself, so
  the condition holds on every surface the scope does: views, pages, joins,
  counts, pickers, read plans and writes. Admins read every doc. A role left out reads
  none. `ownerOrUnrestricted` reads every doc when the caller's effective CRM
  access narrows no reads. A read denial, owner restriction or hidden field on
  any object resolves it to `own`, including custom roles and admin previews.
  It also accepts the `where` form, but not `or`. Ordinary reports use the same
  resolved scope. Explicit team aggregates keep their separate owner threshold.
  `own`, `team`, `hier` and `ownerOrUnrestricted` need an `owner`.
- **`retainedEvidence: { "deal": "deal" }`** fences collections that retain a deal's evidence or derived assessments.
  The named field must be a required deal ref. A member needs unrestricted CRM access and that deal must still
  exist, belong to this workspace and be visible and unarchived. A role restriction or view-as preview withholds
  even their own docs. The shared module scope applies this before owner/member grants and parent access,
  covering views, pages, calls, pickers, exports and history. Trusted system jobs retain internal access.
  Aggregate reads, activity declarations and visitor shares are unsupported for these collections and refuse.
  Work uses this for coaching snapshots, matching DS1's full-access requirement. Narrower roles need a future
  source-by-source reauthorization contract before they can retain coaching evidence.
  `{ "members": "attendees.person" }` grants read-only access to the exact
  workspace users the field names. Paths traverse arrays and objects, at most
  four fields deep, and must end in user refs. Add `"scope": "own"` (or another
  base scope) to retain that scope's existing reads and writes as well. A member
  named on a live set doc also reads its parent; retired or staged generations
  grant nothing. These extra reads do not authorize ops, transitions, call
  writes or share changes. Reports that would need member grants currently
  refuse rather than return incomplete or wider totals; unrestricted admin and
  system reports keep their existing scope.
- **`label`**: what one doc of it is called in words ("Team group"): a ref picker reads "Pick a team group" until
  something is picked. Its name, split and singular, when left out.
- **`title`**: the text field a picker and a ref show a doc by (its first
  required text field when left out, else its key), or a text over its fields,
  `"{$doc.position|number}. {$doc.title}"` (formats `money`, `date`, `time`,
  `number`, `percent`): a line item by its rule and its deal.
- **`integrity`**: `{ "field", "fields", "children"? }`, a seal Canon keeps
  (see "Integrity").
- **`setOf`**: `{ "parent": "<collection>" }` makes a set collection, whose docs
  each belong to one doc of the parent. A set doc is readable only while its
  parent is readable by the same caller: notes on a visit a rep can't see are
  hidden from them too. Its `access` may narrow further and may be `{}`. Its
  indexes have at most 2 fields: Canon puts the parent's key and generation
  first. Sets nest one level. Deleting a parent deletes its set docs (at most
  1,000).

## Views

```json
"visits.mine": { "kind": "list", "collection": "visits", "index": "byRep", "eq": [{ "caller": "userId" }] },
"visits.one": { "kind": "one", "collection": "visits", "args": { "key": "string" }, "key": { "arg": "key" } },
"notes.forVisit": { "kind": "list", "collection": "notes", "args": { "visit": "string" }, "parent": { "arg": "visit" } },
"visits.doneBetween": { "kind": "list", "collection": "visits", "args": { "from": "string", "to": "string" },
  "index": "byStatus", "eq": ["done"], "range": { "gte": { "arg": "from" }, "lte": { "arg": "to" } } },
"visits.forReps": { "kind": "list", "collection": "visits", "args": { "reps": "string[]" }, "index": "byRep", "eq": [{ "arg": "reps" }] },
"notes.forVisits": { "kind": "list", "collection": "notes", "args": { "visits": "string[]" }, "parent": { "arg": "visits" } }
```

- A `list` view reads a collection by one of its indexes, its leading fields
  equal to `eq`, or without an index in key order. `order` is `asc` or `desc`;
  `limit` is at most 1,000 (50 by default). A set collection's list names its
  `parent`.
- A list view may take a `where` (`in` or `neq`, as in `access`), applied
  after the index.
- **`range`** bounds the index's next field after `eq`: `gte` or `gt`, and
  `lte` or `lt`, as "visits done from `from` to `to`". It reads one index
  range.
- **List arguments** (`string[]`, `number[]`) read by a set of values: an `eq`
  value or a set's `parent` that names one reads one index range per distinct
  value, in the list's order (an `in`). `notes.forVisits` reads the notes under
  every visit it's given, each parent checked as the caller would read it. A
  view takes one list argument at most, of at most 500 values; more refuses.
  Only a call's read plan or `api.modules.view` gives a list, so a page can't
  bind such a view and a guard or effect can't name it.
- A `one` view reads a doc by key.
- Values are constants, `{ "arg": name }` (declared in `args` as `string`,
  `number`, `boolean`, `string[]` or `number[]`), `{ "caller": "userId" }`, or
  the clock: `{ "now": "date" }` (today, UTC) or `{ "now": "ms" }`, and
  `{ "nowPlusDays": n, "as"?: "date" }` (`n` days on, back when negative; ms
  unless `as` says date). `visits.comingUp` reads planned visits from today on
  with `"range": { "gte": { "now": "date" } }`, one index range however many
  past visits there are. The clock is when the read runs: a page left open past
  midnight keeps its day until its data changes or it reloads.
- A module declares up to **250 views**. A view costs its bytes of the stored
  manifest and a name, nothing until it is read. Measured (2026-10-18, one
  module's views repeated): about 120 bytes a view; checking the manifest took
  4.6 ms at 100 views, 4.4 ms at 200 and 4.8 ms at 300 (median of 21).
- Each doc comes with `key`, `version`, `data`, `owner`, `parentKey`,
  `createdAt` and `updatedAt` (times in ms).
- A view returns only the docs the caller's scope admits. When a role reads
  `own` and the view's index starts with the owner, Canon reads only the
  caller's docs; when it reads `team`, one range per owner the team admits, in
  the index's order. Other list views read up to 1,000 docs and drop the ones the
  scope doesn't admit, so a narrow scope over a wide view can return fewer than
  `limit`. A page's list says so rather than show part of its rows as all of
  them (see "Tables, queues and status").

## Ops

```json
"visits.update": { "label": "Save visit", "kind": "update", "collection": "visits", "fields": ["title", "status"], "roles": ["admin", "manager", "rep"], "agent": "allowed" },
"visits.delete": { "label": "Delete visit", "kind": "delete", "collection": "visits", "roles": ["admin"], "agent": "human", "reason": "deleting a visit deletes its notes too" }
```

An op is the only way to write. Canon checks, in order:

1. The caller's role is in `roles`. An admin previewing another member writes
   nothing (see "View as").
2. An agent (over `/mcp` or the canon CLI) runs an op whose `agent` is
   `allowed`. `human` refuses it with `reason`. `propose` turns it into a
   proposal a person approves (see "Agents").
3. The op writes only its `fields`, and never a field a machine owns. An update
   or delete needs a doc the caller can read, and refuses a stale `expect`
   version. An update removes the optional fields it lists in `unset`; a form
   unsets a field the person clears.
4. The doc, after the write, fits the schema, and every member it names belongs
   to the workspace.
5. The caller can still read the doc afterwards: a rep can't create a visit for
   someone else or hand theirs away.

An op's `set` writes fields the form never shows: `{ "loggedOn": { "now":
"date" }, "source": "manual", "createdBy": { "caller": "userId" } }`. It takes
any value a transition's `set` takes (see "Values") except `arg` and
`created`, read on an update's doc before it changes. A `set` field can't also
be in `fields`, can't be a machine's field (a new doc starts in its machine's
initial state anyway) and isn't for a delete.

An op's **`guards`** (`[{ when, message }]`, the predicates below) refuse it
with their message. They test a create's and an update's doc as it would be
after the write (an update's fields merged in, its `unset` removed, its `set`
in), so a guard can compare two dates the edit changes; `{ "doc": field }` reads
that doc too. A delete's guards test the doc as it is. `parentKey` names a set
doc's parent:

```json
"visits.update": { ..., "guards": [{ "when": { "field": "status", "in": ["planned", "done"] }, "message": "An archived visit is read only." }] },
"notes.create": { ..., "guards": [{ "when": { "ref": { "collection": "visits", "key": { "doc": "parentKey" } }, "where": { "field": "status", "ne": "archived" } }, "message": "An archived visit takes no more notes." }] }
```

Guards are checked in `moduleScope` for every caller: a person's page, an
agent (before it can propose), a call's `op` intent, and an approved proposal
when it applies. A page shows the op's button or form disabled with the
message only for a guard that fails whatever the form holds (the doc's state,
the role, a field the action fixes): a guard that reads a field the form asks for
(`{ "doc": f }`, a field it tests, a text's length, a list's rows) waits for the
submit, which judges the values given, and the dialog or form shows a refusal
beside its fields and stays open. So "Plan a visit" on a deal's row is never
disabled by a rule about the place it hasn't been asked for yet.

Ops, transitions, and calls may also declare `capability`, a key from Canon's
existing capability registry. Such a declaration lists all four built-in member
roles and cannot be a system or visitor/share declaration. The effective
member's custom-role capabilities decide admission through `can`, including
permission previews and fresh retained-member AI output. Page availability,
`onOpen`, file readiness, and `describe.allowed` use that same admission result.
A queued AI finish reauthorizes its starter before running the success path.
Existing role-only declarations retain their role semantics.

An op with **`"system": true`** and empty `roles` runs only as Canon (see
"System").

An op's **`dirties`** (`[{ job, key }]`) mark job keys stale in the op's own
transaction, each key part computed from the doc before and after the write
(see "Jobs, watches and schedules").

An op's **`effects`** are notifications, as a transition's `notify` effect (see
"Notifications"), from the doc as the write left it (a delete's: as it was). A
reply on a dispute tells the rep:

```json
"notes.create": { ..., "effects": [{ "notify": [{ "lookup": { "view": "visits.one", "args": { "key": { "doc": "parentKey" } } }, "field": "rep" }],
  "message": "New note on your visit: {$doc.body}", "link": "visits/:parentKey" }] }
```

Every write adds one `moduleEvents` row: the op, the doc, who (a person, or an
agent with its client) and the versions before and after.

## State machines

```json
"machines": {
  "visit": {
    "collection": "visits", "field": "status", "states": ["planned", "done", "archived"], "initial": "planned",
    "transitions": {
      "complete": {
        "label": "Mark done", "from": ["planned"], "to": "done", "roles": ["admin", "manager", "rep"], "agent": "allowed",
        "guards": [{ "when": { "not": { "field": "visitOn", "in": [null] } }, "message": "Set the visit's date before marking it done." }],
        "set": { "completedBy": { "caller": "userId" } }
      },
      "archive": {
        "label": "Archive", "from": ["done"], "to": "archived", "roles": ["admin", "manager"], "agent": "propose",
        "args": { "type": "object", "value": { "reason": { "fieldType": { "type": "string" }, "optional": false } } },
        "guards": [{ "when": { "count": { "view": "notes.forVisit", "args": { "visit": { "doc": "key" } } }, "atLeast": 1 }, "message": "Add a note before archiving a visit." }],
        "set": { "archiveReason": { "arg": "reason" } },
        "effects": [{ "create": "notes", "parent": { "doc": "key" }, "data": { "body": { "arg": "reason" } } }]
      }
    }
  }
}
```

A machine owns one field of one collection. Only its transitions change that
field: an op that writes it is refused when the manifest is checked, and again
when it runs. A new doc starts in `initial`. Every state must be a value the
field's schema holds.

A **transition** has:

- `label`, `from` (the states it starts from) and `to`: a state;
  `{ "restore": field, "fallback": state }` to return to a state the doc saved
  (a dispute restores the status it interrupted); or `{ "cases": [{ "when",
  "to" }], "else": state }`, the first case whose predicate holds on the doc.
  Without `to` the doc stays in its state: an action such as Duplicate, with its
  guards, effects and a history row.
- `roles`: who may run it. An empty list means it runs only as another
  transition's effect, or, with `"system": true`, as Canon (see "System").
- `agent`: `allowed`, `propose` or `human` (with `reason`), as for ops. An
  agent needs the strictest mode among the transition and every transition its
  effects reach.
- `guards`: `{ when, message }`. The first that fails refuses the transition
  with its message.
- `args`: an object validator for what the caller supplies, such as a reason.
- `set`: fields it writes on the doc. A value that comes out null leaves the
  field out; `{ "unset": true }` removes an optional one (a reopen clears when
  the doc was completed). An op's `set` takes it too, on an update.
- `seal`: `true` stores the collection's integrity seal once the transition
  and its effects are done (see "Integrity").
- `confirm`: a sentence the page asks the person to confirm.
- `effects`: what else it does in the same transaction, in order:
  - `{ "machine", "transition", "key" }` moves one related doc through its own
    machine. `{ "machine", "transition", "view", "args" }` moves every doc a list
    view returns (at most 100). `onlyFrom` skips docs in other states. Each
    effect checks its transition's `from` states and guards; a failing one
    refuses the whole transition.
  - `{ "create": collection, "parent"?, "data", "as"? }` creates a doc. `as`
    names it, so a later effect reads its key as `{ "created": name }` (a
    dispute and its first message).
  - `{ "copy": collection, "key", "set"?, "children"?, "related"?, "as"? }`
    copies the doc `key` names: its fields (machine fields back at their
    initial state), then `set`; the docs of each set collection in `children`
    under the copy; and each `related: [{ collection, field }]` doc whose
    `field` holds the source's key, pointing at the copy instead (the
    collection needs an index that starts with `field`). The whole copy counts
    against the write cap and is refused whole past it; bulk copies come with
    jobs.
  - `{ "notify": [recipients], "message", "link"? }` sends an in-app
    notification (see "Notifications").
  - Any effect may carry `when`, a predicate on the doc after the move: when it
    doesn't hold, the effect is skipped, not refused (a period moves to paid
    only once its last statement is paid).
  - A view effect with **`bulk: { then }`** moves its docs as a job instead,
    past the write cap: the doc waits in the transition's `to` state while
    Canon moves the view's docs in `onlyFrom` states 100 per transaction, then
    runs `then`, a system transition of the doc's machine from that state
    ("lock every draft statement of the period", then the period is locked).
    It needs `onlyFrom`, and its transition must move each doc out of it.
    `then` runs only once **every** doc has moved. Canon judges each doc's move
    first, as its own transaction would (its state and guards): one that refuses
    (a statement whose seal no longer matches) is skipped and named, and the
    others still move. When only refusing docs are left, the move **stops**: the
    doc stays in its waiting state, its history says which docs held it there,
    and a `bulkStatus` on its page names them with why, each linked, with
    **Retry** for a person whose role runs the transition that started it
    (`api.modules.retryBulk`). Cancelling is the module's own transition out of
    the waiting state; a doc leaving that state ends its move. So a period shows Paid only once every statement is paid.
    Without `then` (`"bulk": {}`) the doc moves on at once and the docs follow
    in batches: a period reopened, its statements after it. That is only for a
    transition with no guards, which no doc refuses; the manifest check refuses
    `bulk: {}` on a guarded one.
- `dirties`: job keys the move makes stale, computed on the doc after it moves.
- `at`: on a system transition, a field holding a time (ms) or a date. Canon
  runs the transition on each doc in a `from` state once that time has come,
  within a minute; the collection needs an index that starts with the
  machine's field and this one. One whose guard refuses is tried again each
  minute.

  Effects read the doc as the transition left it, and read related docs
  whoever can see them. One transition writes at most 200 docs. A transition
  whose effects lead back to it is refused when the manifest is checked.

**Values** in guards, `set` and effects are constants, `{ "arg": name }`,
`{ "doc": field }` (the doc before the transition moves it; `key` is its key,
`parentKey` a set doc's parent), `{ "caller": "userId" | "role" }` or
`{ "now": "ms" | "date" }`. Computed ones:

| Value | What it is |
|---|---|
| `{ "increment": field, "by"? }` | The number field plus `by` (1); a missing field counts as 0. |
| `{ "nowPlusDays": n, "as"?: "ms" \| "date" }` | The time `n` days on (a deadline). |
| `{ "copy": field }` | The field as stored, a list or an object too. |
| `{ "lookup": { "view", "args"? }, "field" }` | A field of the first doc the view returns, read whoever can see it; null when there is none. |
| `{ "created": name }` | The key of the doc an earlier effect of the transition created `as` name. |
| `{ "toMs": value, "endOfDay"?: true }` | A date (`YYYY-MM-DD`, UTC) as ms: its first ms, or its last; a time stays. A backdated event's time from its date. |
| `{ "toDate": value }` | A time in ms as its UTC date; a date stays. |
| `{ "count": { "view", "args"? } }` | How many docs a list view returns for its arguments (each a value): a new step's position, `{ "subtract": [{ "count": ... }, -1] }` for the one after the last. |
| `{ "subtract": [value, value] }` | The first number less the second (a field's, an argument's, a lookup's); null when either isn't a number: a version's signed change from the previous one. |
| `{ "addDays": value, "days": value, "as"?: "ms" \| "date" }` | A time or a date plus a computed number of days (a field's, a lookup's), as the base is unless `as` says; null when either isn't one: a step's deadline from now. |
| `{ "workspace": "fiscalYearStartMonth" }` | The month (1 to 12) the workspace's fiscal year starts (see "Fiscal year"). |
| `{ "fiscalYearStart": value, "as"?: "ms" \| "date", "years"? }` | The day the fiscal year holding a date or a time starts, as a date unless `as` says; `years` on, a later (or earlier) one, so `{ "years": 1 }` ends a year's range. |
| `{ "evidence": "ip" \| "userAgent" }` | Where the person ran a transition that declares `evidence` (see "Evidence"). |

A value that comes out null leaves its field out of a `set`.

**Predicates**: `{ "field", "in": [values] }`, `{ "field", "eq" | "ne" | "gte" |
"lte": value }`, `{ "truthy": value }`, `{ "caller": "isOwner" | "isNotOwner" |
"ownerOnTeam" }`, `{ "role": [roles] }`, `{ "not" }`, `{ "all": [] }`,
`{ "any": [] }`, `{ "intact": true }` (see "Integrity"), `{ "fresh": { "job", "keyPrefix": [values] } }` (see "Jobs,
watches and schedules"), `{ "count": { "view", "args", "where"? }, "atLeast"?,
"atMost"? }`, and `{ "ref": { "collection", "key" }, "where" }`: the doc of
`collection` whose key `key` computes (a field holding it, or `parentKey`)
passes `where`, false when there is none. `field` names a field of the doc
under test: the transitioning doc, the counted doc inside a count's `where`, the
related doc inside a ref's, or a row inside a list predicate's; a dotted path
reads into nested objects and a variant's case (`config.rate`).

`{ "length": field, "atLeast"?, "atMost"? }` holds when a text field's characters (a missing one: 0) are in bounds:
a 500-character note, as a guard as well as a schema bound.

**List predicates** test the rows of a list field (`list` may be a dotted path):

| Predicate | Holds when |
|---|---|
| `{ "ordered": { "list", "field", "strict"? } }` | the rows hold `field` in ascending order (`strict`: no two equal); a row without it fails: tiers by their floor |
| `{ "disjoint": { "list", "from", "to" } }` | no two rows' ranges overlap, each from its `from` to its `to` (a missing `to` runs on); one may end where the next begins |
| `{ "unique": { "list", "field" } }` | no two rows hold the same `field`: each attendee once |
| `{ "every": { "list", "where" } }` | every row passes `where` (true for none) |
| `{ "items": { "list", "where"? }, "atLeast"?, "atMost"? }` | the count of rows (passing `where`) is in bounds |
| `{ "sum": { "list", "field"? }, "eq" \| "ne" \| "gte" \| "lte": value }` | the sum of `field` over the rows (a list of numbers: the numbers; a missing value 0), to a millionth |

```json
{ "when": { "any": [{ "items": { "list": "splits" }, "atMost": 0 }, { "sum": { "list": "splits", "field": "share" }, "eq": 100 }] },
  "message": "Splits must add up to 100%." }
``` Counts and refs read whoever can see the docs;
a count reads a declared list view, at most 1,000 docs.

`api.modules.transition` runs one: `{ module, machine, name, key, expect, args?,
reason? }`. It checks, in order, the caller's role, the agent mode, that the
caller can read the doc, `expect` against its version, the args, its state and
its guards. Then it writes the doc (`set` and the new state, version + 1), one
`moduleEvents` row (the states, the args, the reason and who), and its effects,
each with its own event row naming the transition that caused it.

## Canon operation calls

A call can declare `canon: { operation: "agents.setSlack" }` instead of module code.
`operation` is a closed name from `modules/kernel/canonOperations.ts`; arbitrary function paths are refused.
The call keeps its typed `args`, `roles`, `reason`, `returns`, `result` and `confirm` metadata.
It must be `agent: "human"`, with `reads: {}`, and no `ai`, `step`, `system` or proposal configuration. Ordinary calls use `writes: []`. The bounded population binding below writes exactly its transition collection.
It needs no server bundle or exported function. It is always a write.

Only a direct human call can execute it. Page loads, refreshes, exports, isolate snapshots, module intents,
proposals, hosted calls, jobs, watches and schedules cannot execute Canon operations.
The write transaction rechecks the installed serving manifest, epoch, enablement, migration state, actual membership,
role and preview state, then checks both the declared arguments and Canon's independent operation schema and business permissions.
A successful response counts one Canon operation in `writes`.

`population.start` takes `{ query, title, detail? }` and returns `{ jobId }`.
The query is a strict JSON free-search request with `industries`, `countries`,
`buyer: { levels, departments, titles }`, and optional `employeeMin`, `employeeMax`
or fallback `employeeBands`. It rejects unknown keys, paid-source options,
invalid industries, countries and bounds. Canon requires `strategy.edit`, a
claimed workspace research session, configured transport, and fewer than three
running fills. The job uses the existing free QuickEnrich tasks and staging
review. It never requests paid execution or a credit cap. Its activity-tray link
opens staged review, and `runs.stopJob` stops it through the existing API.

Only `population.start` supports `canon.then`. For example:

```json
"canon": {
  "operation": "population.start",
  "then": {
    "machine": "marketDecision", "transition": "accept", "key": "key", "expect": "expect",
    "input": { "query": { "field": "search" }, "title": { "field": "name" } },
    "args": { "jobId": { "result": "jobId" } }
  }
}
```

The call takes only its required string key and numeric expected version.
The version must be a positive finite integer. `input` reads declared text data
fields of the selected writable document, never user overrides or metadata.
The transition must be a plain human member transition with the same capability,
without evidence requirements, effects, dirties, scheduled steps or seals.
`writes` names exactly its collection. Member-only read access is insufficient.
The binding checks the live generation and package revision as well as CAS.

One mutation reauthorizes the person, resolves that input, executes the closed
operation, checks its direct `{ jobId }` result, and runs the member transition.
There are no arbitrary result paths. A failure throws out of that mutation and
rolls back the job, staging row, scheduled tasks and transition. The bound
transition refuses direct calls, module intents and effects. Replaying a stale
version starts no second job. Operations without `then` retain raw arguments,
zero module writes and their existing result shape.

Hosted research operations use the same platform writers as the built-in AI fields page:

| Operation | Input | Value |
|---|---|---|
| `research.start` | `{ slug, filter?, contacts?, capCredits? }` | `{ runId, refused: null }` or `{ runId: null, refused }` |
| `research.probe` | same as start | same as start; the platform caps research at the probe sample size |
| `research.stop` | `{ runId }` | `null` |
| `research.autoAccept` | `{ slug, minConfidence: number \| null }` | `null` |
| `research.refresh` | `{ slug, cadence: "weekly" \| "monthly" \| null }` | `null` |

`filter` is the platform account filter: optional `segmentId`, `status`, `ownerId`,
`minFit`, `q`, `industry`, `country`, `employeeMin`, `employeeMax`, `sizeBand`,
`region`, `traits`, `icpId` and `custom`. Status is `new`, `working`, `qualified`
or `disqualified`. Industry, country, size band and region are string arrays.
Traits and custom map names to string arrays. Contacts take exactly one of
`{ kind: "all" }`, `{ kind: "view", viewId }`, or `{ kind: "ids", ids: string[] }`.
Canon rejects unknown keys and malformed nested values independently of a module's argument schema.
Saved views must belong to the workspace, apply to contacts, and be shared or owned by the caller.

Start and probe preserve platform credit admission, the billing latch, owner
standing and the duplicate-run check. Stop preserves the workspace check.
Auto-accept requires `writeGate.edit` and a threshold from 0.5 to 1, or `null`
for manual review. Lowering the threshold schedules the existing waiting-fact
reapply. Refresh requires `strategy.edit`; `null` turns it off. Definitions,
principals, custom attributes and research execution remain platform-owned.

`agents.rotateSecret` prepares an encrypted credential privately and binds the save to the same workspace, installation, module, call, epoch,
operation, caller and input. Storage encryption must be configured. Only after the authorized save succeeds does
its human response contain one transient `[{ secret, url }]` row. A table result can copy either cell and clear the result.
Plaintext never enters module code, snapshots, module documents, events or audits.

## Server code

A module computes with its own code, which Canon runs in the recipe runtime
(`services/recipe-runtime`, a Cloudflare isolate with no network and no
secrets). There is no other place module code runs. A call has three steps:

1. **Read plan.** Canon reads every entry of the call's `reads` in one Convex
   query, as the caller: the same scopes, set inheritance and field rules as
   any view. Each doc comes with its `version`.
2. **Compute.** The module's function gets `ctx` (`now`, `caller`, `args`, and
   `workspace`: `{ fiscalYearStartMonth, currency }`) and
   the reads, and returns `{ intents, value? }`. `ctx.now` is its only clock:
   `Date` reads it, and `Math.random`, `crypto.getRandomValues` and
   `crypto.randomUUID` throw.
3. **Apply.** Canon checks and applies the intents in one mutation, all or
   none.

The read plan also pins the installed package epoch. Staging, AI writes,
dry checks, proposals, and the final apply require that same epoch. If the
module upgrades while a foreground call runs, Canon refuses its result and
asks you to retry. It does not rerun the call silently. Background jobs
release stale work for a fresh execution, including empty or failed results.
Watches keep their original epoch through planning, execution, and cursor
advance, so an old watch cannot skip changes for the upgraded module.
A schedule retries a superseded computation once before giving up. Generation
cleanup also stops at an epoch change; staged rows can remain for later
reclamation. This change does not add an orphan cleanup sweep.

```json
"server": "dist/module.js",
"calls": {
  "summarize": {
    "label": "Summarize my visits", "roles": ["admin", "manager", "rep"], "agent": "allowed",
    "reads": {
      "mine": { "view": "visits.mine", "limit": 1000 },
      "current": { "view": "summaries.one", "args": { "rep": { "caller": "userId" } } }
    },
    "writes": ["summaries", "summaryLines"],
    "returns": "value"
  }
}
```

- A module declares up to **100 calls**, and an op or a transition up to **20 guards**. Each call costs only its bytes
  of the stored manifest (900 KB) and a name a page looks up, so the cap is the manifest's size. Measured (2026-10-18,
  one module's calls repeated): 572 bytes a call on average; checking the manifest took 5.0 ms at 50 calls and 5.9 ms
  at 100 (median of 21).
- **`reads`**: up to 40 named entries, each a module view
  (`{ "view", "args"?, "limit"? }`) or a Canon read (`{ "canon", "args"?,
  "limit"? }`). Arguments are constants, `{ "arg": name }`,
  `{ "caller": "userId" }`, `{ "read": name, "field"? }`, or one of those
  converted: `{ "toMs": x, "endOfDay"?: true }` (a date as ms, UTC) or
  `{ "toDate": x }` (ms as a date), as `deals.updatedSince` from a month's start
  date; `{ "fiscalYearStart": x, "as"? }` (the day its fiscal year starts) and
  `{ "workspace": "fiscalYearStartMonth" }` too (see "Fiscal year"), and the
  clock, `{ "now" }` and `{ "nowPlusDays" }` as in views. A call that reads
  "this fiscal year so far" takes no argument for it: it
  reads `deals.closedBetween` from `{ "fiscalYearStart": { "now": "date" } }`
  to `{ "now": "date" }`, so it reads the current period only, never the
  5,000-doc ceiling over every year. A team aggregate's filter takes no clock,
  as it takes no caller. A list read
  returns at most `limit` docs (1,000 by default, 5,000 at most), and a read
  with more refuses the call: code never computes on part of a set.
- **Earlier reads.** Entries are read in order, all in the one query. A list
  argument may take `{ "read": name, "field"? }`: the distinct values of
  `field` in an earlier entry's docs, nulls left out and lists spread. A module
  doc's fields are `key` (the default), `parentKey`, `owner` and its data's; a
  Canon record's are `id` (the default), `createdAt` and its granted ones. So
  "the line items of a rep's earlier statements" is two entries:

  ```json
  "prior": { "view": "statements.byUserBefore", "args": { "user": { "arg": "user" }, "before": { "arg": "start" } } },
  "lines": { "view": "lineItems.ofStatements", "args": { "statements": { "read": "prior" } } }
  ```

  More than 500 values refuses the call. Canon reads companies, people and activities after the plan's query (below),
  so a read of the plan can't take its values from one of them. One exception: a record read's ids (`facts.forRecords`,
  `companies.byIds`, `people.byIds`, `people.forCompanies`, `activities.forCompanies`, `suppression.check`, and
  `observations.forPeople`'s `people`) may come from an earlier read whose rows are companies or people
  (`companies.updatedSince`, `people.updatedSince`, `companies.byIds`, `people.byIds`, `people.forCompanies`,
  `deals.people`, `audiences.members`, `people.snapshotPage`, `companies.bestFit`). Canon reads both in order in the
  call's action, and past the later read's cap (100 for `facts.forRecords`, else 500) the call refuses. An argument that takes one value can
  take `{ "read", "field"? }` of an earlier read of **one** doc: that doc's
  field (a period's `start`). When that doc isn't there, the read that names it
  reads nothing (an empty list, or null) rather than refusing.
- **Report reads**: `{ "report": { "collection", "rows"?, "columns"?, "values"?, "filter"? } }` is an aggregate over
  every doc of a reported collection the caller reads (see "Reports and charts"), from the record service: its
  `groups` (`keys`, `values`), `total`, `rows` and `behind`, never the docs. So a wide status count needs no 5,000-doc
  read. Its `filter` is `[{ field, op, value? }]` over the doc's own dimensions (`eq`, `neq`, `in`, `gt`, `gte`, `lt`,
  `lte`, `empty`, `notEmpty`), its values from the call (constants, arguments, the caller, date conversions). It runs as
  the caller in the call's action, outside the plan's one query, so it may be a second behind; a system call can't read
  one. A year of docs counted by rep and month is one such read.
- **Canon reads** need the manifest's `reads` grant for their object. Each goes
  through an index, refuses past its cap rather than return part of what it
  names, and returns `id`, `createdAt` and the granted fields.

  | Read | Args | Reads |
  |---|---|---|
  | `deals.closedBetween` | `from`, `to` (dates) | deals closing in the range |
  | `deals.updatedSince` | `since` (ms) | deals changed since then |
  | `deals.byIds` | `ids` (a list, at most 500) | those deals, in order |
  | `deals.forOwner` | `owner` (a member's id) | that member's deals, by the owner index: a rep's own without the workspace's |
  | `deals.asOf` | `at` (ms), `from`, `to` (dates) | deals as they stood at `at`, closing in the range then |
  | `deals.changesBetween` | `since`, `until` (ms), `from`, `to` (dates) | deals closing in the range at either time: `{ id, before, after, closeDates, amounts, categories }` |
  | `users.all` | | the workspace's active members |
  | `users.withInactive` | | its members, those who left too |
  | `teams.all` | | its teams |
  | `research.fields` | `slug`? | field registrations, owner standing, gate, refresh and latest run; `refreshEstimate` uses the platform run estimate |
  | `research.runs` | `slug`, `run`? | latest ten runs, or any selected run of that field and workspace; counters, `progress` as a fraction, sample, verdict, stop reason and credits |
  | `research.traces` | `run` | per-record outcomes and search, read and model steps, model, prompt version, calls and elapsed time |
  | `research.answers` | `slug` | action-only field answers, newest first, at most 200; evidence, status, verification and observed time |
  | `recording.policy` | none | one workspace policy record, including defaults; grant `reads.recording` fields `consent`, `internalRecording`, `internalDomains`, `retentionDays`, `region`. Canon keeps never-record lists private. Recorder actions must enforce them in core. |
  | `targets.forYear` | `year` (a fiscal year) or `on` (a date in it) | the target plan saved in Settings > Targets for that fiscal year, or none |
  | `market.facets` | `query`, `groupBy`? (industry, country, region or sizeBand, default region) | `{ total, groups: [{ key, count }], truncated }` from the shared market cache, or null |
  | `companies.byIds` | `ids` (at most 500) | those companies, in order |
  | `people.byIds` | `ids` (at most 500) | those people, in order |
  | `suppression.check` | `ids` (at most 500), `purpose`? | visible people's email, LinkedIn and voice status; requires `reads.people` to grant `suppression` |
  | `people.forCompanies` | `ids` (companies, at most 500) | the people whose company each is |
  | `companies.updatedSince` (preview) | `since` (ms), `cursor?`, `owner?` (a member's id) | one page of the companies the caller sees that changed at or after `since`, oldest change first; see "Paging companies and people" |
  | `people.updatedSince` (preview) | `since` (ms), `cursor?`, `owner?` | the same, for people |
  | `deals.people` | `ids` (deals, at most 500) | the people on each deal the caller sees, by its contacts and their roles (or its legacy roles while it has none): a row per deal and person, with the granted people fields, `dealId` and `role`. People the caller can't see are left out, and so is a legacy role whose person the register no longer has (the deal page shows its saved name to unrestricted roles; a module reads only people the register holds). Needs `reads.people`. |
  | `deals.conversations` | `ids` (deals, at most 500) | Matched email and LinkedIn threads from the deal owner's inboxes, using DS1's inventory and `sourceMatches` (contacts, company domain or deal name). Needs `reads.conversations`. Rows have `id`, `createdAt` and granted `dealId`, `channel`, `at`, `ownerUserId`, `counterpart`, `subject`, `messages`, `more`, `inventoryLimited`. Threads are newest first; each holds its latest 100 messages oldest first, with `id`, `direction`, `at`, `from`, and `buyer` using DS1's team rules. `readableThread` includes `text` only from an inbox whose owner passes `mayReadText`; otherwise messages have `hidden: true` and `ownerUserId`. A hidden owner's subject is null. `more` marks older messages; `inventoryLimited` marks DS1 inventory caps. Refuses past the read's thread limit or 3,000,000 characters. Available in call actions, with caller-scoped company domains; requires a member. |
  | `deals.state` | `ids` (deals, at most 500) | DS1 state for visible, unarchived deals in this workspace. Needs `reads.dealState: ["state", "stateHidden"]`. Each row has `id`, `createdAt` and the granted fields. `stateForReader` applies DS1's reader policy; a restricted reader gets no rows, and email or LinkedIn quotes without a readable inbox owner are blank. A deal without a saved state has `state: null`. |
  | `activities.forDeals` | `ids` (deals, at most 500), `since?` (ms) | The existing timeline read, with caller-scoped activity dates, source ids, notes and recorded-call content through `reads.activities` (`at`, `date`, `subject`, `text`, `transcript`). It refuses overflow. Email and LinkedIn conversation text is not available through this read. |
  | `observations.forPeople` | `people` (at most 500), `since?`, `until?` (ms), `types?` (`email`, `linkedin`, `room`, `hot_lead`) | what each person the caller sees did, oldest first: a row per touch with the granted `observations` fields (`personId`, `at`, `channel`, `event`, `direction`). Never what was said: no subject, body or reply. A bounce, an auto-reply and a Gmail hot lead (its received email counts) are none; a deal room visit counts only once the visitor was verified as the person. Reads each person's 500 newest observations recorded since `since`. |
  | `activities.forCompanies` | `ids` (companies, at most 500), `since`? (ms) | the same, about those companies |
  | `audiences.all` | | the Canon audiences the caller sees, as the Audiences page shows them |
  | `audiences.snapshot` | `audience` (an audience's id) | one record: the audience's people frozen now (see "Audiences") |
  | `audiences.members` | `snapshot`, `page` (from 0) | one page of 500 people of a snapshot, as people records |
  | `people.snapshot` | `provide`, `key`, `module`? | one record: the people a module interface's doc names, frozen now (see "People queries") |
  | `people.count` | `provide`, `key`, `module`? | one record: how many people that doc names now, and how many have an email; stores nothing |
  | `people.snapshotPage` | `snapshot`, `page` (from 0) | one page of 500 people of a `people.snapshot`, as people records |
  | `calls.between` | `from`, `to` (dates) | the recorded calls and meetings dated in the range |
  | `calls.byIds` | `ids` | those calls |
  | `calls.transcript` | `call` | one call's record with `timed`, its `segments` and, granted, its `insights` |
  | `runs.between` | `from`?, `to`? (dates, UTC; either open) | every run Canon recorded in the range, newest first (see "Runs") |
  | `runs.cli` | `run` | one CLI run with its `findings`, `events` and `crm` |
  | `runs.artifact` | `artifact` | one retained evidence or lead run with its `document` |
  | `facts.forRecords` (preview) | `object` (`deals`, `companies` or `people`), `ids` (at most 100), `attributes?`, `receipts?` (0 to 20) | each record's fields from the fact ledger, as the caller sees them. Needs the manifest's `facts`, not `reads`. See "Facts". |

  A granted deal `products` field returns the distinct line-item names in line order when the deal has line items.
  With none, or when the caller cannot read line-item names, it returns the deal's stored product list.
  Names are snapshots taken when lines are saved; later catalog renames do not rewrite them.
  Canon's deal Products editor saves up to 100 ledger line items with a version check across the whole list.
  Each `totalPrice` is authoritative integer hundredths, Canon's money scale for every currency, independent of
  quantity and the displayed unit price.
  **Use as amount** is a separate edit through Canon's deal writer. Line edits never roll up the amount automatically.
  Line-item reads inherit the parent deal's visibility, including receipts, object lists, search and reports.
  The record API and MCP can create, edit, delete and restore individual line items through the same writer as Products.
  Updates, deletes and restores require `expectedVersion`. Create takes `dealId` and `productId` stream ids,
  positive integer `quantity`, explicit `totalPrice`, and optional `unitPrice` and nonnegative integer `position`.
  Names and source are derived; a line cannot move to another deal. Every write checks the caller's parent-deal
  visibility, object and field permissions, the 100-line limit and the exact final total, in one transaction.
  Generic bulk writes, automation edits, agent proposals and CRM imports remain unavailable for line items.
  Module line-item reads and booking writes need their later P2 and P10 contracts.

  `market.facets` needs `"reads": { "market": ["facets"] }`. Its query takes include-only industry, size,
  country and region keys. Other keys, negation and invalid lines return null. An empty query reads the whole market.
  The shared cache holds counts for 30 days and refreshes stale counts in the background. An unavailable index returns
  null. The read holds no workspace data and works for people and Canon's own calls.

  Deals are the ones the caller sees, never archived ones, with the granted
  fields their role doesn't hide: `name`, `amount`, `currency`, `closeDate`,
  `stage`, `dealType`, `revenueType`, `forecastCategory`, `probability`,
  `isClosed`, `isWon`, `closedAt`, `nextStep`, `ownerId` (the owner, a member's id: the fact ledger's deal attribute
  `crmOwnerId` is the CRM's user id instead, a different value), `splits` (split
  allocations), `companyId`, `products`, `contractLengthMonths`, `arr`, `mrr`,
  `createdAt`, `updatedAt`, `crmProvider` and `crmId`, `source` (how the deal came in: the CRM it syncs from, as
  `crmProvider` names it, else `manual` for a deal a person, an agent or a rule created in Canon, or `csv` for one a CSV
  import created; null on a deal created before Canon recorded it, until `deals:backfillOrigin` has run on the
  deployment), and `companyName`: the name of the deal's company, read in the call's action from the record service as
  the caller may read the company (null when they can't, or it has none), or for a deal synced from a CRM that no person
  linked to a company, its CRM account's name, as Canon's deals list shows it; so a rep's deals group by account. A role
  that hides a deal's `companyId` hides its `companyName` too. A deal ref's join gives `companyName` as well: a CRM
  account's name comes with the page, and a company's is read by the page as the caller sees it (the join carries its
  id as `companyRef`), so a join's company name shows on a page but not in a filter, a search, an export or a text on
  Canon's own pages. The `dealSource` format reads `source` as a line: "Manually created", "Imported from CSV" or
  "Synced from Salesforce". Members grant `name`,
  `email`, `role`, `managerId`, `startDate`, `endDate`, `title`, `department`
  and `isActive`. Research grants `label`, `attribute`, `kind`, `question`,
  `options`, `answerType`, `entity`, `autoAccept`, `refreshCadence`,
  `refreshNextAt`, `refreshHold` (a message or null), `recipe` (title and version
  or null), `owner` (name or null), `agentStatus`, `agentMessage`, `latestRun`
  (status, answered, errors, planned, and done or null), `canEditGate`, and
  `canRefresh`. It requires a person reader. Teams grant `name`, `managerId`,
  and `memberIds`. Targets grant `year` (the fiscal year, named by the
  year it ends in), `fyStart` (its first month), `total`, `months` (the workspace's target by fiscal month, the teams'
  summed), `repMonths` and `teamMonths` (each member's and team's by fiscal month, by their id) and `repTeam` (the team
  each member's target counts toward). Amounts are minor units. Every member reads the plan, as Reports does.
  Money is an integer in minor units (cents for USD) on every read: a deal's `amount`, `arr` and `mrr`, a company's
  `annualRevenue`, a target, and the fact ledger's money attributes. A page shows it in whole units with `|money`.
- **Deal history.** Canon folds every deal's ledger stream into versions (`dealVersions`, convex/dealHistory.ts), each
  valid from its entry's time until the next one's, in shard order from per-shard cursors as the module feed reads the
  ledger. The first fold is a workspace's backfill; while it runs, `deals.asOf` and `deals.changesBetween` refuse with
  "Deal history is still being built (n%)". It starts when a deal changes, or within a minute of a module that reads
  history being on. `deals.asOf` reads the versions current now plus those changed since `at` (never older ones), so its
  cost is the workspace's deals plus the changes since. A deal's versioned fields (`name`, `amount`, `currency`,
  `closeDate`, `stage`, `forecastCategory`, `probability`, `isClosed`, `isWon`, `ownerId`, `companyId`, `dealType`)
  are the ones it held then; any other granted field is its own now. Who may see a deal is today's rule. A change's
  `before` and `after` are null where the deal didn't exist (or was archived) then, and `closeDates` is every close
  date it held from `since` to `until`, in order: what "pushed twice" is read from. `amounts` and `categories` are
  every amount and forecast category it held the same way (only with that field granted): a drop from a peak in the
  window. A change carries no
  `companyName`. History starts at a deal's first ledger entry: a deal synced from a CRM has history from its first
  sync. The fold runs a moment behind the ledger.
- **Companies, people and activities** are the record service's. Canon plans them in the plan's one query (the ids,
  checked; a deal's ledger stream for its activities) and reads them in the call's action, through the caller's record
  client, so they are the records the caller sees, a second behind at most, and a field their role hides reads as null.
  A system call reads them as Canon. So no read of the plan's query takes its values from one of them (the manifest
  refuses it); only another record read takes ids from one ("Earlier reads").
  `ids` takes a list, or one id (a page's bound deal); `deals.byIds` takes one id too. Companies grant `name`,
  `domain`, `industry`, `employees`, `annualRevenue`, `country`, `city`, `status` and `ownerId`; people grant `name`,
  `title`, `email`, `phone`, `linkedinUrl`, `companyId`, `ownerId`, `lifecycleStage` and the derived `suppression` field; activities grant `kind`
  (`call`, `meeting`, `note`, `task`, `module`), `at` (a call's time, a meeting's start, else when it was logged), `ownerId`,
  `dealId` (the deal's id, as `deals.*` read it), `companyId`, `personId`, `subject` (a task's or call's subject, a
  meeting's title; never a note's body), `status` and `dueDate` (tasks), `direction` and `durationSeconds` (calls) and
  `outcome`. An activity is about a deal or company when its lookup names it or an activity edge points at it;
  `since` keeps those logged since then. Each read refuses past its limit, edges included. Emails aren't activities
  yet: nothing in Canon writes them.
- **Paging companies and people.** `companies.updatedSince` and `people.updatedSince` read a workspace's companies or
  people a page at a time, as the caller sees them: those that changed at or after `since`, ordered by when they last
  changed, oldest first, then by id. A page holds the read's `limit` rows, 500 by default and at most (the manifest
  check refuses more). Each row has `id`, `createdAt`, `updatedAt` and the granted fields. The last row of a page that
  has more after it carries `next`. Pass it back as `cursor`, with the same `since` and `owner`, to read the next page.
  A page with no `next` is the last one. Unlike other reads, a page never refuses because more rows follow.
  - A record changed while a module pages moves to the end, so a module that reads to the last page sees it again
    rather than missing it.
  - `owner` keeps the companies or people one member owns, and needs `ownerId` in the grant. A role that hides the
    owner refuses it.
  - The cursor is bound to the caller's visibility. A record the caller can't see is never on a page, and a page that
    only hidden records follow has no `next`. The cursor holds no count. A cursor another caller read, or one read with
    another `since` or `owner`, refuses ("Read again without it").
  - A job, a watch or a schedule reads every company or person, as Canon, as `deals.updatedSince` does. Its cursor
    reads only for Canon's own calls.
  - One page costs up to three record-service list requests of 200 rows, plus a count on the first (measured on the
    local stack with 10,000 companies; see the PR).

  ```json
  "args": { "type": "object", "value": { "cursor": { "fieldType": { "type": "string", "maxLength": 400 }, "optional": true } } },
  "reads": {
    "companies": { "canon": "companies.updatedSince", "args": { "since": 0, "cursor": { "arg": "cursor" } }, "limit": 100 },
    "facts": { "canon": "facts.forRecords", "args": { "object": "companies", "ids": { "read": "companies" } } }
  }
  ```

  ```ts
  const companies = reads.companies as Array<{ id: string; name: string | null; next?: string }>;
  const next = companies.at(-1)?.next ?? null; // the cursor of the following page, or null after the last
  ```
- **Custom deal fields** (win-loss.md PW3). `reads.deals` may grant `custom`, every custom field of a deal (Settings >
  Data model; a CRM's custom fields imported there), and a flat deal read asks for them with `"custom": true`: each deal
  then comes with `custom`, its custom fields' values by slug (`{ "loss_reason": "Price" }`), read from its ledger stream
  (`objects.ts dealCustomValues`), each field the caller's role hides left out. A read with custom fields reads at most
  500 deals; `deals.asOf` and `deals.changesBetween` carry none. A workspace names its own fields, so a module asks for
  them all and picks one by its slug at run time (a setting). Not yet: custom
  fields in joins, watches and report dimensions; `competitorMentioned`, which no CRM sync fills.
- **What was said** (shared gap P11) is three more activity grants. `text` is a note's body, or a call's or a meeting's
  notes (a Granola meeting's summary). `transcript` and `insights` come from the recorded calls and meetings filed on
  the deals an `activities.forDeals` read names (`callRecordings`: Granola, the dialer, imported Gong and others,
  `convex/moduleActivityContent.ts`): the transcript as a line per turn, "Customer (Sam Lee): …", from its speaker
  sides, and each insight's type, text and evidence. A recording joins the activity it belongs to (a Granola meeting, a
  dialer call); one with none comes as a call of its own, id `recording:<id>`. Only the deals the plan's query found
  the caller sees are read, so a rep's read never reaches a deal they can't see. A read past 3,000,000 characters of
  text refuses rather than return part of what was said. The install screen gives this grant a line of its own: "It
  reads what was said". `activities.forCompanies` gives `text`, and no transcripts yet: recordings are filed by deal.
- **Calls** (`calls.*`) are Canon's recorded calls and meetings (`callRecordings`: Granola, the dialer, imported Gong
  and others), read in the plan's one query by `convex/lib/modules/transcripts.ts`. They grant `title`, `at` (the call's
  time in ms), `durationSeconds`, `ownerId`, `dealId`, `provider` and `analyzedAt`. `transcript` grants
  `calls.transcript`: one call's `segments`, each `{ segment, speaker, side, startSec, endSec, text }`, with `side`
  rep, customer or unknown and the times the recording kept (Granola's, since G0), and `timed` when every line has its
  times. `insights` adds Canon's insights on the call, each `{ type, text, evidence }`. A plan reads one transcript at
  most, and a transcript past 5,000 lines or 600,000 characters refuses. A call reads when the caller's role sees call
  records by its owner (their own, their team's, or all), or when it is filed on a deal they see: the rule every call
  surface asks (`callVisible`). A system call reads every one. The install screen gives `transcript` and `insights`
  a line of their own: "It reads call transcripts".
- **Audiences** grant `name`, `size` (its people when the Audiences page last counted them), `shared` and `createdBy`. An audience can hold 25,000 people, more than one
  read returns, so a module reads it in two steps. A call reads `audiences.snapshot`: Canon lists the audience's
  people now (its filter as the reader sees the people, then those added one at a time, each once), stores their ids
  under a new snapshot, and returns `{ id, createdAt, audience, count, pages }`. A job then reads
  `audiences.members` by `{ snapshot, page }`, one key per page (`[plan, page]`), so every page reads the same
  people however the audience changes after; the members come with the granted `people` fields. Only the module
  that took a snapshot reads it, in the workspace it took it in, and Canon deletes it 30 days later. Past 25,000
  people the snapshot refuses, as the Audiences page does. A snapshot is a record-service read, so no later read of
  the plan takes its values from it: the call hands the id on in a write (a plan doc, whose create op
  dirties the job's first page). Saved views aren't snapshotted yet.
- **Team aggregates**: `{ "aggregate": { "collection", "values", "filter"?, "minOwners"? } }` is a count, sums and
  averages over every doc of a collection, the docs the caller can't read too (see "Team aggregates").
- **`args`**: an object validator, checked before anything is read.
- **`agent`**: `allowed` or `human` (with `reason`). Every transition a call
  returns is checked again against its own agent mode for the person or agent
  that started the call: an agent can't reach a human-only transition through a
  call, and a `propose` transition becomes a proposal.
- **`writes`**: the collections the call's intents may touch. Anything else
  refuses the whole call.
- **`returns`**: `"value"` hands the call's `value` back to the caller;
  `"none"` drops it.
- **`result`**: how a page shows the value, under the button that ran it (see
  "Forms and widgets"). Without one, a page shows a short value in its toast.
- **`confirm`**: a sentence the page asks the person to confirm before it runs the call (a call action may carry
  its own `confirm` too). Every confirm on a module page (a delete, picked rows, a transition, a call, a saved
  report's delete) is Canon's dialog, never the browser's.
- A call whose `writes` is empty is **read-only**: an admin viewing as a member runs it as that member (see "View as").

**Intents** each carry `expect`, a list of `{ collection, key, version }` for
the docs they were derived from (`version: null`: the doc must not exist), and
an optional `require` predicate on the doc they write, as a machine's guards
are written. Every `expect` is checked before any write, and a doc that changed
since the read refuses the whole call ("changed since the call read it. Run it
again.").

| Intent | What it does |
|---|---|
| `{ "op": "put", collection, key?, parentKey?, data, ifAbsent? }` | Creates the doc, or replaces its fields when `key` names one. With `ifAbsent: true`, an existing readable doc is left unchanged. Machine fields are never written; a new doc starts in its machine's initial state. |
| `{ "op": "patch", collection, key, data, unset? }` | Changes some fields. |
| `{ "op": "delete", collection, key, ifPresent? }` | Deletes the doc and its set docs. With `ifPresent: true`, an absent doc is a no-op; an existing doc still requires normal read/write authority. |
| `{ "op": "replaceSet", collection, parentKey, docs }` | Replaces every doc of a set under its parent at once. `require` tests the parent. |
| `{ "op": "transition", machine, name, key, args?, reason? }` | Runs a transition as the caller, with its roles, guards and agent mode. |
| `{ "op": "op", name, key?, parentKey?, data?, unset? }` | Runs a declared op as the caller, with its roles, guards and agent mode. |
| `{ "op": "event", collection, key, note }` | Adds a line to the doc's history. |
| `{ "op": "dirty", job, key }` | Marks a job key stale (Canon's own calls only: jobs, watches, schedules). |
| `{ "op": "notify", to, message, link? }` | Notifies members by id (Canon's own calls only; see "Notifications"). |

Each write is checked as the caller's own op would be: the schema, members of
the workspace, and that the caller can still see the doc. It adds a
`moduleEvents` row whose `cause` is `call <name>`. A call returns at most 2,000
intents and makes at most 4,000 writes besides its sets.

**Sets.** A `replaceSet` writes its docs under a new generation, in chunks of
1,000 (each below Convex's 8,192-element and 8 MiB argument limits) that no
reader sees. The apply mutation then moves the parent to the new generation
with the call's other writes, so readers see the old set or the new one, never
part of either. The old generation, or a staged one whose call failed, is
deleted afterwards. A set written by `replaceSet` has `"key": "auto"`.

**Isolates.** Each call runs in an isolate keyed by the bundle's hash, the
workspace and the principal (`<orgId>:user:<userId>`; `system` is for jobs), so
module globals never carry one person's reads into another's call.

**Ceilings** (measured on the local stack, 2026-10-17; see PR for the table):
4 MB of reads in and 4 MB of result out. A larger read plan refuses before it
is sent, and a larger result answers 413. CPU is 1,000 ms per call on
Cloudflare, where `limits.cpuMs` applies. `wrangler dev --local` doesn't
enforce it, and Convex stops waiting after 15 s.

**Writing one.** Put the code in `server.ts` beside `module.json`, exporting
the functions by name:

```ts
import type { CallFunctions, Intent, ReadDoc } from "@fullstackgtm/canon-module-kit/calls";
export const calls: CallFunctions = {
  summarize(ctx, reads) {
    const visits = reads.mine as ReadDoc[];
    const intents: Intent[] = [{ op: "put", collection: "summaries", key: ctx.caller.userId, data: { ... }, expect: [...] }];
    return { intents, value: `${visits.length} visits` };
  },
};
```

`npx canon-module-kit build <dir>` checks `module.json`, bundles `server.ts` with
its imports into one file at the `server` path, and checks the bundle exports a
function for every call. The bundle names no file path, so the same source
builds the same bytes, and the same hash, in any checkout. Commit the bundle with the manifest: install fetches
both at the pinned commit and stores the bundle by hash, and the install
screen shows its size and the `reads` grants.

A schema refusal says the field in words: "Reason is required", "Amount must be a number", "Tiers, row 2, rate is
required" (`plainProblem`, modules/kernel/schema.ts): the field's `label`, else its name split. A form or dialog first
refuses a required field it left empty itself, the same way, before it sends anything.

`api.modules.call` (`{ module, call, args? }` → `{ writes, proposed, factProposals?, value? }`)
runs one. `factProposals` is there when the call proposed facts ("Proposing facts"). A page action `{ "call", "label"?, "args"? }` runs it from a button,
asking in a dialog for the arguments `args` doesn't fix, each in the widget its
schema gives it.

## Team aggregates

A rep sees how they compare with the team without reading the team's docs. A call reads a team aggregate:

```json
"team": { "aggregate": { "collection": "visits", "values": [{ "fn": "count" }, { "fn": "avg", "field": "amount" }],
  "filter": [{ "field": "status", "op": "eq", "value": "done" }], "minOwners": 3 } }
```

Its code gets `{ withheld: false, owners, count, values }` (each value in order; an average is the sum over the docs
counted), or `{ withheld: true, minOwners }`. Canon asks the record service (in Convex, the fake: at most 5,000 docs)
for every doc of the collection that passes the filter, grouped by the collection's `owner`, and folds the groups in
one place, `teamAggregate` (modules/kernel/reports.ts), which `runAggregate` in convex/modules.ts returns; the code
never sees a group or a doc (`tests/moduleSurfaces.test.ts` checks the path).

**The privacy rule.** No reader can single out one person's docs from it:

- It is withheld unless its docs belong to at least `minOwners` people (3 at least, the default). With the reader one of
  them, the rest are at least two people: their sum is never one person's.
- Counts, sums and averages only; a min or a max is one doc's value.
- A filter value from the call's arguments is tested only with `eq`, so two arguments read disjoint sets, never one
  inside another. The caller and earlier reads aren't filter values.
- Every aggregate over a collection, in any call of the module, filters the same way (the arguments aside), so two
  aggregates never differ by a few docs.
- The collection is reported (so it is projected), has an `owner` and isn't a set.

What it can't stop: the same aggregate read before and after one doc changes differs by that doc. A module shows team
figures that move slowly (done visits, closed periods), not ones a single write moves alone. The install screen lists
each call's team figures.

## Hosted AI steps

A call may declare `ai` in place of code: Canon asks the caller's model to fill fields of one doc from what the call
reads, keeps only the quotes it finds word for word in those reads, and writes the rest through an update op as the
caller. The module never calls a model, never sees a key, and its model's answer lands nowhere but that op's fields.
This call summarizes a visit from its notes. In the open modules, `draftReview` in `modules/examples/win-loss/` and
`draftGoal` in `modules/examples/work/` are hosted AI steps:

```json
"summarizeVisit": {
  "label": "Summarize with AI", "roles": ["admin", "manager", "rep"], "agent": "allowed",
  "args": { "type": "object", "value": { "visit": { "fieldType": { "type": "string" }, "optional": false } } },
  "reads": { "visit": { "view": "visits.one", "args": { "key": { "arg": "visit" } } },
             "notes": { "view": "notes.forVisit", "args": { "visit": { "arg": "visit" } } } },
  "writes": ["visits"], "returns": "value",
  "ai": {
    "prompt": "Summarize this field visit for the rep's manager in at most three sentences ... each with the key of the note it comes from.",
    "output": { "op": "visits.saveSummary", "key": { "arg": "visit" }, "fields": ["aiSummary", "aiQuotes"] },
    "evidence": [{ "quote": "aiQuotes[].text", "source": "aiQuotes[].note", "in": "notes", "text": ["body"] }],
    "budget": { "inputChars": 20000, "perDay": 50 }
  }
}
```

- **The run.** The call's plan is read as the caller, with every scope a call's plan has, so the model sees only what
  the person may read. The doc `output.key` names (an argument, or a field of a read of one doc) must be one they read
  now, or the call refuses before any model runs, and the write expects the version read then: a doc changed while
  the model ran refuses the write ("changed since the call read it"). The call is a call in every other way: its
  `roles`, its `agent` mode, a page's `{ "call" }` action (its `toast` reads `{$result.kept}`, `{$result.dropped}`
  and `{$result.model}`), `canon_module call`, and "View as" refusing it, since it writes.
- **The prompt.** Canon writes the rules (what is data, the evidence rule, the choices), then the module's `prompt`
  (text, at most 8,000 characters), then every read as JSON inside a fence named by a hash of that data, so text inside
  it can't close it. The prompt says data is never instructions. `budget.inputChars` (60,000 unless it says, at most
  400,000) refuses a run that would send more, before the model runs.
- **The answer** is the op's collection's schema for `output.fields` (each a field the op writes), as JSON Schema.
  `choices` limit a value to an earlier read's values: `"drivers[].reason": { "read": "reasons" }` (the docs' keys, or
  `field`), which the schema also offers as an `enum`. Fields the answer leaves out are cleared, so one run's quotes
  never stand beside another's. A required field the gate empties fails the run.
- **The verbatim gate.** Each `evidence` entry names a quote's path in the answer (`aiQuotes[].text`; a quote sits in
  a list), the path of the id of what it quotes in the same list item (`source`: a module doc's key or a Canon record's
  id), the read it must come from (`in`) and the fields of that read's docs it may quote (`text`; every text field
  without it). A quote is kept only when, case, spacing and curly quotes aside, it is found in that doc's text and is at
  least `minLength` (12, the least) characters: `modules/kernel/evidence.ts` `quoteFound`, the rule Canon's meeting facts
  use too. A quote that fails drops its list item; `dropParent` (`drivers[]`) drops each item of an outer list left
  with no quote. A choice outside its read drops its list item the same way. A module can't opt out: every quote an
  `evidence` entry names is checked by Canon.
- **The model.** The caller's ChatGPT plan (`resolveLlm`). Without one, Canon's model on the workspace's credits: 1
  credit once the answer is written (`CREDIT_RATES.moduleAi`), nothing for a run that failed. With neither, the call
  says to sign in with ChatGPT. Tests and local stacks answer with Canon's test model (`MODULE_AI_MODEL=fake`, or a
  local stack unless `MODULE_AI_MODEL=live`): an answer of the schema's shape whose quotes are the first sentence of
  each doc it reads, at $0 and with no network.
- **Receipts.** Each run writes a `moduleAiRuns` row: who ran it, the model and whose bill, the prompt's version (a hash
  of the module's prompt), the characters sent, the ids each read gave it, the quotes it kept and those it dropped with
  why, the credits it cost, or why it failed. The doc's history gets a line: "Filled by AI (gpt-6-luna on your ChatGPT
  plan): 3 quotes found word for word; dropped 1: "Acme was 40% cheaper" (not found word for word in the record it names)."
  `budget.perDay` (100 unless it says, at most 1,000) caps one person's runs of the call a day (UTC). A run is reserved
  against it (`running`) before the model runs, so runs started together never pass it.
- **What Canon writes.** `output.set` puts values in the answer whatever the model said, on every item the gate
  kept: `"drivers[].by": "ai"`, `"drivers[].quotes[].verified": true`. So a model can't mark its own reasons a
  person's, or its quotes checked.
- **In the background.** A transition may name an AI call in `ai`: once the move commits, Canon runs the call on that
  doc in the background, and the doc waits in the move's state. The call declares `ai.queue: { machine, then, fail }`,
  two system transitions from that state: `then` once the answer is written, `fail` when the run fails, with why on
  the doc's history. It runs as the person who moved the doc, with their scopes and on their model, with no session
  (`personScope`, scope.ts); a system move (a job's) runs it as the doc's owner. Only a person's own move may fall back to
  Canon's model on credits: a move Canon made needs the owner's ChatGPT plan, or fails saying so. Win-loss's review moves
  to `drafting` by Draft with AI (`startDraft`), or by itself when its deal closes (`autoDraft`, from intake), then to
  `draft` by `drafted`, or back by `draftFailed`. A background run reads no report or team aggregate: those read as a
  signed-in person.
- **On the page.** The `ai` tone (`banner`, column and figure tones) marks what an AI step filled in Canon's provenance
  colour. A page can show a summary in an `ai` banner and its quotes beside the notes they came from.
- **Trust.** A transcript or note can say anything. What it can reach is the declared op's fields on one doc the caller
  already reads, through the op's own guards and the caller's role and agent mode, each quote checked against the
  record it names; it can't run a transition, notify, or touch Canon's records. The model is the person's own plan,
  or Canon's at a credit a run, capped per person per day.

### Research reads and member completion

`web.pages` is an explicit action read. Declare `reads.web: ["url", "text"]`
and `{ "canon": "web.pages", "args": { "domain": { "arg": "domain" } } }`
in the call's read plan. It takes one public HTTP(S) company domain without
credentials or a port. Alternatively, `{ "urls": { "arg": "urls" } }` reads at most six distinct public HTTPS pages. The two input modes are exclusive. URL-list mode skips unreadable pages and returns stable URL ids with at most 8,000 extracted characters per page. Canon validates the member,
workspace, installed grants, and resolved arguments in the snapshot, rechecks them
before transport, and fences them again at apply. System calls refuse this read.
Queries, live page bindings, reports, and printing never fetch websites implicitly.

The transport uses the website research public-HTTP guard, including pinned public
addresses, safe redirects, response and time limits. It reads the homepage, plain
`/llms.txt` when present, and at most four linked same-site key pages. It returns
at most six `{ id, url, text }` rows with stable source ids and unchanged extracted
text. Homepage and llms text each hold at most 28,000 characters. Linked pages hold
at most 10,000 each. An unreadable homepage or fewer than 200 total readable
characters refuses. The existing test-model mode substitutes public-source fixtures
before any fetch. Live transport failures never select those fixtures.

`web.search` is an explicit member action read on the caller's ChatGPT plan.
It declares `reads.web: ["search", "url", "text"]` and
`{ "canon": "web.search", "args": { "queries": { "arg": "queries" } } }`.
It takes one to four nonempty queries, each at most 200 characters. Without a
ChatGPT plan, it refuses and asks the caller to sign in with ChatGPT.
Search failures remain errors, with no paid search fallback.

Canon fetches the results through the same public-HTTP guard as `web.pages`
URL-list mode. It skips unreadable pages and hosts such as LinkedIn and X.
It attempts at most 12 readable HTTPS results per query and returns at most
12 `{ id, url, title, query, text }` rows in all, deduplicated by URL across
queries. The URL is the stable source id. Each row holds at most 8,000 extracted
characters. Search answers and snippets never count as page evidence.
The read uses the same snapshot admission, transport and apply fences as
`web.pages`. Hosted AI calls and their member completion steps may read it.
System calls, queries, live page bindings, printing and exports refuse it.
Test-model mode substitutes fixtures before any search or fetch.

`me.context` is an explicit member-only action read with grant
`reads.me: ["profile", "posts", "counterparts"]`. It always selects the initiating
member's own linked accounts. It accepts an optional `section`: `words` for
quotable profile and post rows, `counterparts` for interaction metadata,
`sources` for connection statuses, or `all` by default. System calls, queries,
page binds, printing, and exports refuse it. Admission and apply fence its
principal and grants as they do `web.pages`.

Profile rows contain bounded headline, summary, location, and up to 20 current
and past positions from Unipile's self profile. Post rows contain at most 20
recent own posts, each at most 8,000 characters. Only these own words may be
quoted with `exact: true`.

Counterparts aggregate the last 90 days of the member's opted-in Gmail and
LinkedIn intake, plus participants of calls visible under `calls.between`'s
rule. Rows contain only `{ ref, title, company, channels, interactions, lastAt }`,
at most 200 ordered by interactions. The opaque `ref` hashes the caller's user ID
and the deduplicated counterpart ID. Counterpart names, emails and raw IDs do
not cross this read.
Canon records supply matched titles and company names as the caller may read
them. Teammates, automated intake, and unnamed unknowns with only free mail
are excluded. No message body, subject, summary, or transcript crosses this
read. It refuses past 1,000 recent conversations per account, 2,000 messages
per conversation, or 5,000 calls rather than return partial interaction counts.
Source rows report `connected`, `not_connected`, or `not_opted_in`;
missing connections return statuses rather than errors. Live provider errors
remain errors. Test-model mode uses explicit Unipile fixtures before transport.
The read uses Canon's Unipile key and makes no treg calls.

`me.status` uses the same grant and member selection, returning only the three
source status rows and integration settings URLs. It is safe for live page
bindings and never fetches a provider. LinkedIn's separate `intakeStatus` tells
the member whether conversation intake is opted in; profile and posts require
only a connection.

`research.signup` declares `reads.signup` fields from `domain`, `spec`, `query`,
`heuristic`, `saved`, `icp`, and `sells`. The last two are the claimed current ICP and bounded jobs plus buyer reasons, for a module to compose its own context. It returns at most one row from the current workspace's
latest claimed research session, or an empty list. Canon builds the canonical spec
and query with the same pure normalization as core and checks saved state through
the owner-aware ICP interface. Modules never read core ICP tables. System calls
refuse signup reads. A changed claimed source or saved state refuses a pending
write at apply.

A hosted call can narrow model policy with `credits: false`. Without a ChatGPT
plan it refuses. The default policy remains unchanged. This option neither adds
a provider nor raises any budget. The ICP website consumer uses plan-only policy.
Its legacy key-only OpenRouter fallback parity remains unresolved.

`evidencePolicy: { "minimum": 2, "repair": true, "exact": true }` requires at
least that many kept quotes, with a minimum from 1 to 10. It compares exact
contiguous text in the named source. If too few quotes survive, the same reserved
run asks once more with the original sources and bounded rejected quotes. Both
prompts obey the run's input limit. The repair does not reserve another daily run
or create another charge. The receipt counts both prompts in `inputChars`.
Model, authorization, schema, and write refusals do not
retry as evidence repair. A second evidence failure writes no answer.

`output.copy: { "sources": "pages" }` copies a declared read into a separate
field the output op writes. `output.provenance: { "model": "model",
"provider": "provider" }` stamps separate text fields from the actual model
transport. Neither comes from model output. Both pass the op's normal schema and
write admission. The normal history and model receipt remain separate records.

A queued AI declaration can add `queue.next`, the name of a normal module call.
It takes exactly the queue key as one required string argument, reads its own
views and optionally explicit `web.pages`, `market.sample`, or `social.search` action reads, writes the waiting collection, uses agent mode `allowed`,
and requires the same capability as the AI call. Its name is queue-only. Direct
calls, ordinary plans, and ordinary applies refuse it. It cannot be System, AI, a Canon
operation, or a proposal. Runtime also refuses set replacement, proposals, sends,
notifications, and dirty-job intents from this completion.

After the intermediate answer is saved, Canon freshly plans and runs `next` as
the initiating member with their retained agent identity and current permissions.
Its semantic writes and `queue.then` share one mutation. Without `then`, the completion must itself advance the waiting machine as the initiating member. Version/count fences,
package revision, epoch, record admission, grants, row scope, schema, and write
guards still apply. A refusal rolls back completion writes and the success move,
then runs `queue.fail` with its reason in a fresh transaction. The completion
refusal cannot be swallowed into success. A superseded document or package is
left untouched. Existing queues without `next` retain their owner-background
branch and epoch retry behavior.

A pure call can declare `step: { "key": "key", "machine": "workflow", "fail": "failed" }`.
A member transition starts it with `run: "callName"`. It uses the same queued
runner and fresh member completion path, without a model, reservation or model
receipt. Its reads and writes obey the completion restrictions above. Its output
must advance the waiting machine. Each automatically selected next stage retains
the initiating member and optional agent. A System transition cannot start these
member continuations. Existing queues without member completion keep their
trusted owner background behavior.

Evidence can name several reads with `in: ["crm", "pages"]`.
`sourceField: "url"` uses each row's declared URL field as its source id.
`exact: true` compares contiguous unchanged text. With
`onInvalid: "hypothesis"`, an unsupported quote and its source are removed while
the claim survives. Without that option the existing drop-item policy holds.
`ai.sources: { "pages": { "read": "run", "field": "pages" } }` projects retained
evidence rows from an own one-document read. The declared field must hold records
with stable string ids. This lets a later stage cite pages already read without
fetching them again. The package and document fences cover that retained evidence.
Website `evidencePolicy` still allows exactly one evidence repair.

`ai.plan` grants `reads.plan: ["status", "available"]`. It returns only the
initiating member's connection status and availability, never credentials.
The test model reports `test-model`. A module can show disconnection and refuse
before creating a run, rather than fail after starting.

`deals.latestClosed { won }` returns at most 15 caller-visible closed,
nonarchived opportunities from the latest 300 ordered by close date. Deal fields
obey effective permissions. Associated account fields come only through the
caller-scoped record client and the module's company grants, never unrestricted
CRM mirror data. `companies.bestFit` returns at most 15 caller-visible accounts
sorted by fit. A caller who cannot read fit cannot use that ordering.

`social.search { source, query, limit }` is an explicit member action read requiring
`reads.social: ["search"]`. Sources are `reddit`, `x`, `linkedin_posts`, `hn`,
`jobs` (a company domain or name), and `linkedin_jobs` (paid keyword search).
It returns at most 25 `{ id, source, url, author, authorUrl, postedAt, text }`
rows, with stable source-prefixed ids and at most 8,000 text characters per row.
A call declares at most 12 social reads.
Queries, page bindings, exports, printing, and System calls cannot fetch these
sources. The snapshot, pre-transport recheck, and apply fence cover the member,
install grant, and resolved query. Queued member completions may use this read.
HN uses Algolia through the public-HTTP guard. Company jobs reuse the existing
Greenhouse, Lever, and Ashby board discovery and ownership checks. Paid sources
use treg with a per-call ceiling and `customer=<org>, feature=pull`, refuse
unless `TREG_PAID_CALLS=on`, and charge `creditsForCost` on metered cost.
Test-model mode selects fictional provider fixtures before fetching. Live errors
never select fixtures. `social.thread` is deferred.

`market.sample { queries }` is an explicit action read requiring
`reads.market: ["sample"]`. It accepts at most five free-search JSON strings
of the same shape as `population.start`. One original QuickEnrich request runs
per proposal, at the existing zero ceiling. It returns `{ id, size?, transport }`
rows. A size counts distinct nonempty company domains and is capped when a next
page exists or the reported people total exceeds the returned people count.
Missing transport or paused pacing omits every size. An ordinary query failure
omits that size and continues. `TregRefusal` stops remaining queries. Existing
country conversion, buyer defaults and provider range mapping are retained.
This read never uses the shared prospect index or market facet totals.

The existing explicit fake-model mode also selects fake page, sample and newly
started population transport. The fake population ends with an empty staged
review and never falls back to a live provider. Live failures never choose fakes.

`queue.logFailure` and a pure `step.logFailure` accept `{ "domain": "domain", "stage": "deriving" }`. The declaration names a text
field of the waiting doc. A successful failure transition logs its normalized
domain, bounded reason/detail, and trusted workspace to `researchFailures` in
the same transaction. A duplicate terminal notification logs nothing. A fail
transition that takes arguments receives `{ "error": "<reason>" }` and can save
that error for the module page. A completed model receipt proves an intermediate
answer, not successful semantic adoption or workflow completion.

## Jobs, watches and schedules

Module activity producer publication is documented in [Module activity publication](module-activity-publication.md).
It captures source changes and retains inactive activity-watch baselines. Watch delivery and mixed-source
freshness still use their existing behavior until W3-C. Producer status exposes pending publications and failures.
A failed publication retains its package pin and blocks that organization's readable activity prefix.

Background work runs as the module's system principal (see "System"), in the
isolate `<orgId>:system`, through the same read plans, checks and apply as a
person's call.

```json
"jobs": { "tally": { "label": "Monthly won-deal tally", "call": "recount", "key": ["month", "rep"], "batchBy": 1, "order": "month", "batch": 100, "attempts": 4 } },
"watches": [{ "object": "deals", "call": "onDeals", "fields": ["amount", "closeDate", "isWon", "ownerId"] }],
"schedules": { "months": { "label": "Open months", "call": "ensureMonths", "everyMinutes": 60 } }
```

**Jobs.** A job keeps something current per key: a statement per period, plan
and rep. Its `key` names the parts, joined by `|` (`2026-10|<rep>`). A key is
**dirtied** by an op's or a transition's `dirties` (same transaction), a call's
`dirty` intent, or a watch; a trailing `*` part stands for every value
(`2026-10|*`: every rep of October). Canon then runs the job's `call`, a system
call, on the dirty keys:

- **Batches.** Keys that share their first `batchBy` parts go to one call, at
  most `batch` (50) of them. The call gets `ctx.args.keys`, each shared part as
  one value and each other part as a list, so its read plan reads the period
  once for every rep in it. It returns `{ byKey: { <key>: [intents] } }`; a key
  it leaves out is done with nothing to write.
- **One key, one transaction.** Each key's writes apply all or none, in their
  own mutation, and only while the key is still at the count (`dirtySeq`) it was
  leased at. A key dirtied again while its run was out runs again and the stale
  result is dropped. A result computed under an earlier version of the module
  is dropped too.
- **Order.** Keys equal but for the `order` part form a group: one rep's
  periods. A group runs one key at a time, lowest `order` first. The part's text
  sorts, unless the job declares `orderBy: { collection, field }`: then the
  `order` part is a doc's key and that doc's field sorts it (a period's `start`),
  read each time the key is dirtied, so opaque period keys still run in date
  order. Keys with a `*` run before the keys under them.
- **Dependencies.** A run that changes what a later key reads says so with a
  `dirty` intent: a statement that changed dirties the same rep's next period,
  which reads it (its `expect` on the prior doc fences the read).
- **Failures.** A batch that fails (the code throws, or a read or a result is
  too big) is split in two until the failing key is alone. That key keeps its
  error, waits (5 s, doubling) and runs again, `attempts` (5) times at most;
  then it waits, with its error on the Customization page, until something dirties it
  again. A failed key doesn't hold up the later keys of its group.
- **Recovery.** Dirtying a key means its inputs changed, so a key that failed
  starts over whenever anything dirties it: an op's or a transition's `dirties`,
  a watch's change, a schedule's or another call's `dirty`. It gets all its
  attempts back and runs at once, not after its wait. A run already out keeps
  going, and its result is dropped as stale. A failure in the module's own code
  (a write its schema refuses) fails again on every retry until a fixed version
  is installed. A new version, once it serves, starts every failed key of its
  jobs over the same way, so the fix runs without waiting for a dirty. A bulk
  move stopped on docs that refuse it is the exception: it stays stopped until
  a person retries it.

**Watches: the records feed.** A watch reads Canon's records ledger
(`ledgerEntries`) from per-shard cursors, as automations do, and hands its call
each changed deal as `{ id, at, before, after }`: the `fields` it watches before
and after that change (null when the deal didn't exist or was archived), so it
can dirty the old owner and period as well as the new. A change to none of its
fields isn't sent. The call returns only `dirty` intents; Canon dirties those
keys and moves the cursors in one transaction. A watch watches only fields the
ledger carries (`name`, `amount`, `currency`, `closeDate`, `stage`,
`forecastCategory`, `probability`, `isClosed`, `isWon`, `ownerId`, `companyId`,
`dealType`). A watch's `object` may also be `companies`, `people` or
`activities`, from the same ledger: an `account` entry is a company's change, a
`contact` entry a person's, and a note, task, call or meeting entry an
activity's. Their ids are the ones the read plans use (a company's `acc_…`, a
person's `con_…`, an activity's own), and their fields the ones `reads` grants
and the ledger carries: companies `name`, `domain`, `industry`, `employees`,
`country`, `status`, `ownerId`; people `name`, `title`, `email`, `phone`,
`linkedinUrl`, `ownerId`, `lifecycleStage`; activities as `activities.*` read
them. An activity's change also carries `targets`, `{ deals, companies, people }`
it is about after the change, from its lookups and its activity edges (deals by
their ids), so a watch can dirty by deal. Companies and people reach the ledger
once someone works them, which is the set a module can act on. Emails have no
writer in Canon yet, so no watch sees them. Splits and products are on the deal row only, and nothing in Canon
edits them yet (see "Not yet"). A watch's cursors
start at the ledger's end when the module is turned on, so it sees changes from
then on. Its call failing leaves the cursors where they were, with the error on
the Customization page. An owner change (in Canon, or written back to a CRM) is a
ledger entry; a deal whose owner only its row held gets that owner on the ledger
first, so the change has the owner before it.

**Schedules** run a system call every `everyMinutes` (5 to 1,440) or daily at
`dailyAt` (UTC, `HH:MM`), its writes applied as any call's.

**`fresh`.** `{ "fresh": { "job", "keyPrefix": [values] } }` holds when no key
of the job under the prefix (or a `*` key over it) waits, runs or failed, and
every watch has read the ledger to its end. A statement's lock and a period's
close declare it, so nothing locks numbers a deal edit hasn't reached yet:

```json
"guards": [{ "when": { "fresh": { "job": "tally", "keyPrefix": [{ "doc": "month" }] } }, "message": "This month's tallies are still being counted." }]
```

**Running it.** A dirty key wakes a run, and a ledger entry wakes the feed,
right after the transaction. A one-minute sweep (`convex/moduleJobs.ts`) starts
the feeds' cursors, due schedules and timed transitions, and restarts runs a
lost wake-up or a dead action left. The Customization page shows each module's keys
waiting, running and retrying, its last run, how far its feed is behind and the
keys that stopped with their errors. Each connector feed shows its lag,
pending backfill and cursor error.

Measured on the local stack (2026-10-17): a Canon deal edit to its tally
applied in 342 to 567 ms; 500 keys that each write, plus the 500 next-month keys
they dirty, in 10.4 s.

## Connector feeds

`feeds` names the connector feeds a module reads. Each entry declares a `feed`,
a system `call`, 1 to 20 `fields` and optional `backfillDays`, from 0 to 365,
default 30. A module declares at most 10. Canon checks feed names and fields
against its connector registry at install and upgrade.

```json
"feeds": { "checkins": { "feed": "webhook.events", "call": "onCheckins", "fields": ["type", "data"] } }
```

The call receives `items` as `{ seq, id, link: { userId }, at, before, after }`,
with only its declared fields. Canon first pages current items in the backfill
window as `seq: null` and `before: null`, then follows the ordered log.
Calls must be idempotent because an item changed during backfill can arrive again.
For a one-time import, a stable key and `put` with `ifAbsent: true` preserve
the existing doc when the item arrives again.

A feed call uses its own `writes` and returns `intents`. `byKey` and
`replaceSet` are refused. Its writes and cursor movement commit together.
Failures hold the cursor and appear on the Recipes card. Canon delivers at
most 100 items per call and 600 per module and workspace in each UTC minute.
Excess items wait for the next pass. See [Connector feeds](connector-feeds.md).

## Pages

```json
{
  "path": "visits/:key",
  "title": "{$visit.title}",
  "bind": { "visit": { "view": "visits.one", "args": { "key": { "route": "key" } } } },
  "body": [
    { "c": "header", "title": "{$visit.title}", "subtitle": "{$visit.rep|user}" },
    { "c": "form", "op": "visits.update", "from": "visit", "fields": [{ "field": "status", "label": "Status" }] }
  ]
}
```

- **`path`** is segments of `a-z`, `0-9` and `-`, or `:param`. Pages with a
  `tab` show as tabs under the module's nav entry, by `order`. Each role's tab
  set is the tabs of the pages it sees, narrowed by the tab's own `roles`
  (`"tab": { "label": "All visits", "order": 0, "roles": ["admin", "manager"] }`
  keeps a page a rep can still open from a link out of their tabs). The
  module's root (`/dashboard/m/<name>`) opens the role's `nav.landing`, else its
  first tab. A `tabs` component's tabs take `roles` too.
- **`bind`** names the views the page reads (at most 20), with arguments from
  constants, route parameters (`{ "route": "key" }`), URL parameters
  (`{ "query": "month", "default"?: value }`: `?month=2026-10`; without one and
  no default the binding reads nothing), `{ "caller": "userId" }`, or a field of
  the doc another binding reads (`{ "bind": "statement", "field": "userId" }`,
  `key` its key: the rep's other statements, for previous and next, with no URL
  parameter; when that binding read no doc, this one reads nothing). Canon reads
  them all in one query, each after the bindings it reads from, as the caller,
  so a page updates live. A binding may instead name a **call** (see "Values a
  page loads"). A binding may
  also `join` ref fields, `count` related docs per row and set its `limit` (see
  "Tables, queues and status").
- **`roles`** on a page or a component, and **`when`** on a component
  (`{ "bind", "field", "in" }`, or `{ "bind", "field", "set": true | false }`: while the
  field holds a value, or doesn't), only decide what shows.
- **`persist`**: URL parameters (a range's `from` and `to`, a tab's `param`, a stepper's `year`) the page keeps per
  workspace and person in the browser; opened with none of them in its URL, it opens as they last left it.
- A page's loaded calls that fail say so once, at the top, with Try again, in the module's words ("Preview: The period ends
  before it starts.", not "failed in the module's code (threw)"); the sections that read them say they have nothing.
- **`fallback`** (`{ "text"?, "missing"?, "heading"?, "actions"?, "back": { "label", "path" } }`; `heading` in place of
  "Not found" or "This page couldn't be shown" ("Statement in progress"), `actions` up to three more pages to go to,
  "Use this month"): what the page shows when it
  can't be drawn. When a `one` binding read by a route `:param` finds no doc the caller
  reads (it is gone, or isn't theirs), the page shows **Not found** instead: `missing`, else
  "This record doesn't exist, or it isn't yours to see.", and the `back` link. It never
  draws an empty record. A read it makes refuses (a URL parameter that isn't the number a view
  takes) or a component fails: the reason, `text`, a link to `back` (its `:params` from the
  route) and Try again. Without one, the link goes to the module's root. A URL parameter a
  view takes as a number or true/false reads as one. The views and ops check
  again on the server.
- **Text** fills `{$<bind>.<field>}` and, in a table, `{$row.<field>}`; `{$query.<name>}` is a URL parameter, and
  `{$<list bind>.count}` how many rows a list read ("50+" when it read short). Action labels, tab labels, chart
  titles and a navigate's path are text too: "Recalculate {$period.year}", "Needs action ({$needs.count})". `key`
  and `version` are fields too, a count is one by its name, and
  `{$row.<join>.<field>}` is a joined doc's field (`{$row.deal.amount|money}`). A format follows a `|`: `money` (minor units, in
  the workspace's currency), `date` (`YYYY-MM-DD`), `number`, `percent` (a
  fraction), `user` (a member's name) and `ref` (what a deal, team or doc ref
  shows as; nothing when the reader can't see it). A value with no format shows
  its label when its field's schema has `labels`, a list its count, and
  true/false as Yes/No. `date` takes a date or a time in ms; `time` shows a time
  as a date and time. A number field with the `time` hint shows as a time with no
  format given, in text, tables, filters (a date range) and exports, and its form
  picks a day; `createdAt` and `updatedAt` are times, and a row's `owner` and
  `parentKey` read like fields. `|json` serializes a value exactly as JSON, including an empty array (`[]`),
  for query-string handoffs such as `{$aud.filter|json}`.

A binding `{ "canon": "research.fields", "args": {}, "limit": 200 }` reads Canon
live in the page query, as the caller. The module's `reads` must grant the read's
object and fields. Record-service reads and reads that need an action, such as
deal company names, cannot bind live. A table uses the same `from` and
`{$row.<field>}` text as a view. Each row has `id`, `key` (the same id),
`createdAt`, and its granted fields. More rows than `limit` refuses the read.
List arguments read comma-separated URL parameters.

`research.fields`, `research.runs` and `research.traces` can bind live.
Run samples and traces use the platform CP14 projection: the owner, starter,
or a viewer whose role narrows no reads can see record details. Other viewers
receive counters with no sample or traces. A selected run must belong to both
the named field and the caller's workspace, including runs older than the latest ten.
`research.answers` cannot bind live or supply a later read's inputs. Its call
plan records the requested slug, fields and limit; the call's action uses the
caller's scoped record client to admit record-service ids before asking the
platform answer reader for facts and evidence. Background reads refuse it.
The module renders only its granted fields after that admission.

```json
"reads": { "research": ["label", "entity"] },
"pages": [{ "path": "fields", "title": "AI fields",
  "bind": { "fields": { "canon": "research.fields", "limit": 200 } },
  "body": [{ "c": "table", "from": "fields", "columns": [
    { "label": "Field", "value": "{$row.label}" },
    { "label": "Applies to", "value": "{$row.entity}" }
  ] }]
}]
```

### Components

| Component | Keys | What it draws |
|---|---|---|
| `header` | `title`, `subtitle?`, `actions?` | The page title, a line under it and buttons. Several headers at the top of a page, each with its `when`, are one header's variants: the first that shows is the page's title (its H1 and its PDF's), and the others are left out. A title from a doc a call loads goes first with a `when` on that call's value, and a header over the page's own views follows it, so the page never shows the module's name while the call loads: a plan's name over a plan-period view, the period's name otherwise. |
| `table` | `from` (a list, Canon read, or call binding with `rows?`), `columns`, `rowLink?`, `empty?`, `rowActions?`, `id?`, `sort?`, `filters?`, `search?`, `group?`, `pageSize?` | Rows of a list, a live Canon read, or a call's value (see "Tables, queues and status"). `rowLink` is a page path whose `:params` come from the row (`:key` its key) or the route. The first column links. |
| `form` | `op`, `from?` (the doc an update edits), `parent?` (a set create's parent), `fields: [{ field, label, widget?, help? }]`, `submit?` | A form for a create or an update. |
| `actions` | `items` | Buttons. |
| `empty` | `text`, `action?` | A message with one button. |
| `prose` | `text` | Paragraphs separated by blank lines, `- ` bullet items and `**bold**` spans. Single line breaks continue the paragraph. Other markup, including HTML and links, stays literal text. The same content appears in print and in the wrapped WinAnsi PDF. |
| `tabs` | `tabs: [{ label, body }]` | Tabs, each a list of components. |
| `banner` | `tone` (`info`, `warn`, `success`, `danger`, `ai`), `text`, `actions?`, `list?: { from, rows?, label }` | A message across the page. With a `when` on the doc's state, it is the state's message. `list` names a binding's rows after the text, each `label` over the row, comma-separated: "Waiting on: Avery Chen, Jordan Patel". |
| `statusSteps` | `from` (a one-doc bind), `machine`, `steps?` | The machine's states in order (or `steps`), the doc's current one marked and the ones its history shows it was in checked, so a machine that skips a state doesn't show it done. |
| `timeline` | `of` (a one-doc bind), `limit?`, `hide?` | The doc's audit trail, newest first: each op, transition, effect and proposal, who did it, when and why. `hide: { actors?, events?, keep?, roles? }` leaves out, on the server, events whose actor is one of `actors` (`system`, `agent`, `person`) and whose kind or verb is one of `events` (`create`, `update`, `event`, a transition `machine.name` or an op), each any when left out, for the roles named (every role without `roles`); `keep` names verbs it never hides: System's backfills hidden from reps, its close kept. A transition shows its states by their labels. |
| `queue` | `sources: [{ from, label, title, subtitle?, date?, link?, actions? }]`, `empty?`, `search?` | Several lists as one, newest first: an inbox. |
| `jobStatus` | `job`, `keyPrefix?`, `label?` | A job's keys under a prefix as one line. Its `label` is a text over the page ("Recalculating {$query.year|fy}"), as every label is: tabs, filters, figures, details, steppers, ranges and a loaded call's heading. |
| `detail` | `items: [{ label, value, span? }]`, `columns?` (2, 3, 4) | Labels and values in a grid: a record's fields. |
| `kpis` | `items: [{ label, tone?, trend?, hint? } & ({ value } \| { total: { from, sum, format? } } \| { count: from })]` | Figures. A list read short shows none. `tone: { by, cases }` colours a figure by a text (cases as a column's `tone`), `trend` is a text whose sign draws an arrow up or down beside it, `hint` a line under it. A call's `kpis` result takes them too. |
| `thread` | `from` (a list), `body`, `author?`, `at?` (`createdAt`), `post?: { op, parent, field, label?, button?, placeholder? }`, `empty?`, `tags?` | Messages on a doc, oldest first, and a box that adds one through a create op; `post.placeholder` is what the empty box says ("Write a reply…"), `post.label` what a screen reader calls the box ("Reply") and `post.button` its button ("Send"; `label` by default). `tags` (`{ "rep": "Rep" }`) follows an author's name by their role: "Avery Chen (Rep)". |
| `approvalChain` | `from`, `title`, `approver?`, `state` or `progress`, `at?`, `order?`, `note?`, `done?`, `failed?`, `actions?`, `empty?` | Steps in order, each with its approver, state and time, done ones ticked and failed ones crossed, with row actions (approve, reject). A step's state is its own field (`state`), or comes from where the doc its steps belong to stands: `progress: { of, at, by, complete?, failed? }`, `of` a one-doc bind, `at` its field holding the current position and `by` each step's; before it Done, at it Current (Stopped while `failed` holds on the doc), after it Waiting, and all Done while `complete` holds. |
| `periodNav` | `from`, `current`, `label`, `link`, `sort?` | Previous and next around the doc `current` names, over an ordered list. |
| `integrity` | `from` (a one-doc bind) | Whether a sealed doc still matches its seal. |
| `callResult` | `from` (a call binding), `label?` | A call's value the page loaded, with Refresh (see "Values a page loads"). |
| `bulkStatus` | `from` (a one-doc bind), `link?`, `label?` | The bulk moves the doc waits on: moving, or stopped with the docs that refused named (each linked by `link`, `:key` its key) and Retry. |
| `pacing` | `id`, `sources`, `title?`, `target?` | Daily sums against historical pace and a fiscal target plan. See "Pacing". |
| `dashboards` | `title?` | The caller's private and workspace-shared dashboards of this module, drawn from its saved reports. See "Module dashboards". |
| `report` | `id`, `collection`, `title?`, `rows?`, `columns?`, `values?`, `chart?`, `sources?`, `display?` | A report builder (see "Reports and charts"). |
| `chart` | `kind` (`bar`, `stacked`, `line`, `pie`), `title?`; `from`, `rows?`, `x`, `y?`, `series?`, `bucket?`; or `report` | A chart of a binding's rows or of a report. |
| `tree` | `from`, `rows?`, `id?`, `parent`, `title`, `subtitle?`, `link?`, `empty?`, `details?` | Rows as a tree, each under the row its `parent` names: an org chart, with search, zoom, Expand all, Collapse all and an inspector. |
| `flow` | `from`, `rows?`, `id?`, `parent?`, `title`, `action?`, `metric?`, `card?`, `tone?`, `empty?`, `details?` | Rows as a flow canvas: each node after the row its `parent` names, or after the row before it (steps in order), with the arrow labeled by `action`, zoom and a pane of `details`. |
| `recordEditor` | `from`, `rows`, `selection`, `model`, `options`, `version`, `versionArg`, `change`, `message` | Sentence token controls and blur-save messages over module-returned values and declared calls. See "Editable hierarchy and sentence controls". |
| `setMap` | `from` (a call binding), `rows`, `overlaps`, `selection`, `title?`, `frameLabel?`, `empty?`, `focus?` | Nested, overlapping sets sized by count, with static geometry, URL selection and a read-only inspector. See "Overlapping sets". |
| `stepper` | `param`, `default` (a number, `"thisYear"` or `"thisFiscalYear"`), `label?`, `step?`, `min?`, `max?`, `format?` | Previous and next over a URL parameter the page's bindings read: a `?year=` navigator. A fiscal one names its years FY2027 when the fiscal year doesn't start in January (`format: "fy"` names a plain one's so too). |
| `wizard` | `op` (a create) or `call`, `steps: [{ title, description?, fields }]`, `preview?: { title?, items: [{ label, value }] }`, `submit?`, `then?`, `toast?`, `fixed?`, `initial?` | A create or a call asked in steps: a strip of the steps, Back and Next (Next waits for the step's required fields), a choice with descriptions as radio cards, a preview card over `{$draft.<field>}` (choices by their labels) and the last step's submit; `then` opens the page of what it made (`:key`); `toast` is what it says once done, over `{$draft...}` and a call's `{$result...}` ("Plan created"), in place of "<label>: done". Notetaker's rule editor (`modules/examples/notetaker/`) is one. |
| `grid` | `from` (a list), `op` (an update), `field` (a record of numbers, or with `cells` a number), `title`, `each` (as a column's), `label`, `widget?` (`number`, `money`, `percent`), `total?`, `cells?` | A spreadsheet: a row per doc, a column per item (a fiscal year's months), each cell the doc's `field` at the item's key. A cell's label and a refusal name its row by `title` and its column by `label` (a member id by the member's name), never by a key. Cells take typing and a block pasted from a spreadsheet (tabs and lines, filling from the cell it lands on); Enter moves down; Save runs the update on each changed doc at the version it read, then re-runs the page's loaded calls as any write does (a summary under the grid). With `cells: { from, row, column, create?, fixed? }` each cell is a doc of its own: the doc of the list `from` whose `row` field holds the row doc's key and whose `column` field the column's (a quota per rep and month); `op` updates its `field` (a number), an emptied cell removes it, and an empty cell typed into is made by `create` with the row, the column, the value and `fixed`. |
| `transcript` | `call` (a page value or a bound doc's field: a Canon call's id), `highlights?`, `lineActions?`, `empty?` | A Canon call's transcript, which Canon reads as the caller (see "Transcripts"). |
| `phone` | Queue mode uses `from`, `person`, `name`, `phone`, `detail?`, `skip?`, `since?`, `campaign?`, `empty?`. Record mode uses `record`, `from`, `phone`. | Canon's calling controls over a queue or one person (see "Calling people"). |
| `dateRange` | `from`, `to` (URL parameters), `label?`, `default?` | A date range in two URL parameters: presets, or words a person types ("last 2 quarters", "since March", "Q3 2026", "FY2027", "2026-01-05 to Feb 2026"), in the workspace's fiscal year (`modules/kernel/dateRange.ts`). `default` is the words it starts from. |

`tabs` takes `param` and an `id` per tab: the URL parameter names the open tab
(`visits/<key>?view=tasks`), and opening one sets it. Any action takes `when:
{ field, in }`: it shows only on a doc (its row or target) whose field holds one of
the values, as Delete on planned visits only.

A component's `when` may read a loaded call's value as it reads a doc (`{ "bind": "projection", "field": "status", "in":
["preparing"] }`), and `notifications`, the caller's unread notifications from the module (`unread`, `hasUnread`), which
text reads as `{$notifications.unread}`: "3 unread messages". A component's `when` may instead be `{ "bind", "empty": true }`: it shows only while that list binding read
no rows ("Log your first visit"), or with `false`, only while it read some. On a one-doc binding it reads whether there is
no such doc: the Dialer's "No queue loaded".

`actions` also takes `{ "machine", "target" }` instead of `items`: a button for
each transition of the machine the caller's role may run from the doc's
current state.

**Actions** are `{ "op", "label"?, "target"?, "parent"?, "then"?, "fixed"?, "initial"? }`,
`{ "transition", "machine", "label"?, "target"?, "fields"?, "fixed"?, "then"? }`,
`{ "call", "label"?, "args"?, "confirm"?, "then"? }`, `{ "navigate": path, "label", "report"? }`,
`{ "export", "label"?, "args"?, "formats"? }`, `{ "print": label }`, `{ "pdf": label, "filename"? }` or `{ "canon", "label", "bind"?, "ref"? }`
(a Canon page: `settings`, Settings; `workspace`, Settings > Workspace; `team`, Settings > Team; `deals`, the
deals list; `deal`, the record of the deal whose ref field `ref` the bound doc `bind` joins; or `company` and `person`,
the page of the company or person its ref field `ref` names, joined or not; a column's `link` takes the same, and on a
call's row `ref` names a field of the row holding the id). A transition action's
`fields` (`[{ field, label, widget?, help? }]`) are the arguments its dialog
asks for, in order, with the labels the page gives them; `fixed` gives others
from the page and doesn't show them, and a picker scoped to a sibling argument (a
ref with `parent`) reads the fixed value: a Skip to a stop action offers only
the visit's own stops. A call's dialog does the same with the arguments its action
fixes. A transition action's `then` opens the doc its effects created (a
Duplicate's copy): a path whose `:key` is that doc's key, or `{ "created": true |
"<as>", "path"? }`, `created` naming the create or copy effect by its `as` and
`path` the page, by default the table's `rowLink` on a row, else the page's own
path. A transition action's `initial` starts its dialog's fields, as an op action's does. A call action's `then` opens
the page its value names: `:key` and the other `:params` from the value's fields (a call that makes a draft returns
`{ key }`; the key a `put` gives a new doc is the code's). A transition field with `rows: { from, list?, title, value?, initial?, options? }` asks one
choice per row of a list binding (its argument a record of text keys to a choice, keyed by the row's `value`, its key
by default): "how each rep is paid" when a month pays out. `from` may also bind a call's value, with `list` naming its rows.
`options: { list, value?, label }` takes each row's own options from its `list` field.
The option value is its `value` field, or its position from zero, and must match a choice in the argument schema.
Its label fills `{$item.<field>}` and `{$row.<field>}`. Without `options`, every row uses the schema's choices and labels. `initial` starts on a value that row offers, or its first option. Empty or stale
choices block submission. These options control the dialog; module code must still check row-specific
answers or restrictions when applying a transition. A `navigate`'s `{$...}` fill as text does (each URL-encoded),
and `report: { id, rows?, columns?, values?, chart? }` opens the report builder `id` on that page with that shape. A
`navigate` fills its `:params`, in its path
and its query (`digest?from=:visitOn&to=:visitOn`), from the row it sits on, else from
the doc its `target` binds, else from the route. An action's `when` may be `{ field,
set }` as well as `{ field, in }`, or `{ field, me }`: with `me: true` only while the doc's member field (or list of
members) names the person who opens the page, with `me: false` only while it doesn't, so "Assign to me" hides on a
dispute that is already theirs: `"when": { "field": "assignee", "me": false }`. A create opens a dialog with the op's fields; `then` opens a page
after it, `:key` the new doc's. An update opens the dialog on `target` (a bind)
or the row; a delete asks first. A transition runs on `target` or the row, and
opens a dialog first when it takes args or has a `confirm`. An action whose op
the caller's role can't run, or whose transition doesn't start from the doc's
current state, doesn't show. One that shows but whose guard fails now (a
transition's guard that needs no arguments, an op's guard on its doc or a set
create's on its parent, one that reads no field its form asks for) shows disabled,
with the guard's message; so does a form. A refusal on submit shows in the dialog. The server checks again on every write. Every write action names
an op or a transition, so each has an agent mode.

**Hidden while it can't run.** A write action with `blocked: "hide"` doesn't show while a guard the server judged on its
doc fails, rather than showing disabled with the guard's message. A transition is judged with the arguments its action
fixes (`fixed`, from the row: the stop a route's step names), so a guard over them counts; one over an argument its
dialog asks for waits for the submit. A "Go back here" action on a route's stops shows only on the stops its visit has reached.

**A dialog's words.** An op, transition, call or export action takes `dialog: { title?, description?, submit? }`, texts
over the page and the row: the dialog's title in place of the action's label, the line under it, and its submit
button's label. A delete's confirm takes them too: `{ "title": "Remove \"{$row.repName}\" from the plan?", "submit":
"Remove" }`. A text may read a call the page loaded (`"Projection review: {$projection.status}"`). `badge` is a text
beside the title ("Override", the doc's status). A dialog with no `description` (and no `confirm`) has no line under its
title; it never falls back to the module's name.

**Judged by what it fixes.** Two buttons of one transition (or op) that fix other arguments are judged apart: "Approve"
with `fixed: { force: false }` disabled by "open disputes" while "Approve anyway" with `force: true` runs. The page and the
server key each judgement by the action's name and its `fixed` as declared (`blockedId`, modules/kernel/document.ts).

**An op's own fields.** An op action takes `fields: [{ field, label, widget?, help?, placeholder?, options?, hide? }]` as a
transition action does: its dialog asks those, in that order, with those labels, and `help` and `placeholder` are texts
over the page and the row ("Plan default: {$plan.quota|money}", a joined doc's `{$row.plan.quota}`).

**Waits that follow.** A write's `wait` takes `follow: [{ job, keyPrefix? }]`, the jobs its job's runs dirty in turn
(Recalculate dirties `route`, whose runs dirty `recalc`): the wait lasts until none of them waits or runs either. A run
dirties the next job's keys and finishes its own in one transaction, so the wait never sees a gap. `busy` is what the
action's button says, disabled with a spinner, while its wait lasts ("Recalculating {$query.year}"). Its toast reads
`{$job.count}`, the keys the last job of the chain was seen running ("Statements updated: {$job.count} statements in
{$job.seconds}s"), and each job's by its name. It also reads the module's page open when the job is done, as the job
left it: the write's own page, or the one its `then` opened, whose bindings it may name. So it can count what the job
made or wrote rather than its keys: a New month action can say "{$tallies.count} tallies counted for {$month.month}"
over the month's page, and a job that writes how many requests it sent on its doc can say "{$plan.requestsSent}
acceptance requests sent".

**Section links.** A `navigate` (on no row) whose page and URL parameters are the page the person is on shows as the
current one (`aria-current="page"`): a strip of section links (Plans, Metric inputs, SPIF campaigns) marks the open one.

**Exports by member.** An export action on a call's export takes `members: { arg, label?, roles? }`: its dialog lists the
workspace's members of `roles`, searched, with Select all and Clear (all picked to start), the format as cards when it has
several, and "Export N CSV"; the call gets the ids picked as `arg`. An export's `toast` reads `{$result.rows}`: "Exported
{$result.rows} statements". `picks: [{ arg, label?, options }]` adds lists beside the members (the periods), each from
`options` as a field's are (`{ from, list?, value?, label }`), searched, every option picked to start; the call gets the
values picked as `arg`. `count: { from, label, member?, picks? }` counts the rows of the list binding `from` (statements)
for each member (`member`, the rows' member field) and each option (`picks`: per argument, the rows' field holding the
option's value), shows each count beside its name, and an **Export summary** beside the lists: the rows every pick holds
on under `label`, then how many of each list are picked; the submit says "Export <n> <format>". A member's (or an
option's) count holds only the rows the other lists' picks hold too: a rep's statements in the periods picked. A PDF
export's page (`pdf: { page: "statements/:key" }`) gets each doc's key as it is, so a key holding `|` prints.

**Canon links with a query.** A `canon` action, a column's `{ canon }` link and a tree's `canonLink: { canon, query? }` take
`query`, URL parameters each a text over the page and the row: `{ "canon": "team", "query": { "title": "{$row.title}" } }`
opens Settings > Team filtered; one that comes out empty is left out. `{ "canon": "companies", "query": { "line": "…",
"of": "…" } }` opens the companies list filtered by query lines (";" between them, every one of
which a company must pass), with `of` naming them above the list.

A `pdf` opens in a tab of its own (the tab opens on the click, so no popup blocker stops it); without a tab, it downloads.

**More actions.** `{ "menu": "Export", "items": [...] }` holds actions (no menus) under one button: an export once per
format, a PDF, a sealed export. An item may carry `line`, a text under its label ("Choose format, reps, and periods"),
and `separator: true`, a rule above it. `{ "viewAs": { "row": "rep" }, "label", "path"? }` starts Canon's "view as" preview of
that member (an admin's, never of themselves), then opens `path`. A `pdf` takes `toast`. A transition's `then: { "path"
}` (no `created`) opens that page once it has run, its toast shown there; its `toast` may read the doc as the move left
it, `{$doc.<field>}` ("Shared with {$doc.sharedWith} reps"). A write's `wait: { job, keyPrefix?, toast }` watches the
job's keys under the prefix (`api.modules.jobProgress`) and, once none waits or runs, says `toast` over the page as the
write left it, a call's value and `{$job.seconds}`: "Statements updated: {$result.statements} statements in
{$job.seconds}s". A call that writes reads the page's loaded calls, and the read-only values drawn on it, again.

Every action takes `aria`, what a screen reader says for its button, filled as its label is ("Mark {$row.title}
done"), and a write (op, transition, call) takes `toast`, what it says when it is done in place of "<Label>: done",
over the page, the row and, for a call, its value (`{$result.visits}`); for an op's dialog, what was submitted as
`{$doc.<field>}`, a field picked from `options` by its label ("Assigned to {$doc.plan}"). A wait's toast reads
`{$job.count}`, the distinct keys it saw busy, and `{$job.<job>}` per job it follows: a publish that waits on the job
it starts says "{$job.count} acceptance requests sent". An action's `when` may test a page value
instead of its doc: `{ "page": { "query": "year" } | { "route" } | { "bind", "field" }, "in" | "set" | "gte" | "lte" }`,
`gte` and `lte` comparing numbers as numbers and text (dates) as text, against a constant or `{ "now": "year" | "month"
| "date" }`: no "Plan a visit in 2025" on a past year. An action with a `target` acts on that doc, on a row too. A
transition's `then` that opens what it created (`created: true`) needs one of its create or copy effects named by `as`.

### Overlapping sets

`setMap` draws caller-provided sets from a call binding's value. It has no domain-specific data access.
For example, a call bound as `coverage` can return:

```json
{
  "sets": [
    { "key": "all", "parent": null, "label": "All accounts", "count": 100 },
    { "key": "north", "parent": "all", "label": "North", "count": 60, "summary": "Northern offices" },
    { "key": "enterprise", "parent": "all", "label": "Enterprise", "count": 50 }
  ],
  "shared": [{ "a": "north", "b": "enterprise", "count": 20 }]
}
```

The component declaration is:

```json
{
  "c": "setMap", "from": "coverage", "rows": "sets", "overlaps": "shared",
  "title": "Coverage", "selection": { "param": "sel", "aliases": ["legacy"] },
  "focus": {
    "title": "{$row.label}",
    "items": [{ "label": "Description", "value": "{$row.summary}" }],
    "sharedLabel": "Shared accounts with siblings"
  }
}
```

`frameLabel` optionally labels the enclosing circle, such as "Your CRM".
Each row needs a unique, nonempty string `key`, a `parent` key or literal `null`, a string `label`, and a
nonnegative count or `null`. It may carry an `active` boolean and any extra fields the inspector's texts read.
There are at most 100 rows and 4,950 shared pairs. Parents must exist and form an acyclic forest. Each shared
pair needs sibling keys `a` and `b` and a nonnegative `count` or `null`; each unordered pair appears at most once.
Malformed values refuse visibly instead of drawing a partial map. Zero means a known empty set or overlap.
Null counts and missing pairs mean unavailable, shown as such in the inspector and print. Unknown set counts use
a minimum radius before enclosing their children, with a dashed outline.

Selection reads `selection.param` first, then the first nonempty alias, and falls back to the first row if that
key is stale or absent. Selecting a circle writes the primary parameter and clears aliases. Circles support
Tab, Enter and Space. The selected circle fills, its ancestors are outlined, shared siblings are dashed and
unrelated sets fade. A row with `active: false` is dashed. Selection and hover never change layout coordinates.
The inspector's title and items are texts over `{$row...}`; empty item values are omitted. It lists all siblings'
shared counts with buttons that select those siblings, including known zeros and unavailable pairs.

A table's `focus: { "param": "sel", "aliases": ["legacy"] }` connects its rows to the same selection. Its row keys
must match the map keys and its row order determines the same first-row default. A first-column button selects
the row; table hover and keyboard focus light the map without changing the URL. `focus` cannot combine with
`rowLink`. This single-row focus is separate from the table's bulk `select` checkboxes.

The layout reuses the core map's compressed radius, `4 + 2.2 * count^0.4`, and deterministic pairwise best-fit
relaxation. Nested circles remain enclosed. Shared fractions guide sibling overlap; these compressed circles
do not claim exact area encoding for arbitrary inconsistent pairs. Layout is pure and independent of React.
Native print and the page PDF include a text/table representation of every set's key, parent, count and state,
every sibling pair's shared count, and the selected inspector. The PDF does not silently omit the map.

### Values a page loads

A binding `{ "call", "args"?, "refreshMinutes"?, "refreshOn"? }` runs a call when the page opens, as the caller:
one that writes nothing (`writes: []`) and returns its value, its arguments from
the page or a bound doc's field as a view binding's are. A `callResult` draws the
value as the call's `result` declares (a table, figures or a message), and text
reads it as `{$<bind>.<field>}`. The page keeps the value per call and arguments
while the tab is open, so opening it again shows it at once; **Refresh** runs the
call again. The cache is separated by workspace and principal. Optional `refreshMinutes` (5–1440)
adds a time bucket to the cache key and refreshes an active binding at that interval. Concurrent loads of the
same key share one request; leaving the page cancels its timers and ignores superseded responses.
Only read-only value calls can be bindings, including bindings with a refresh interval.
A role the call doesn't name loads nothing.

A loaded call may declare `refreshOn: ["research"]`, naming page bindings of own-doc views.
Canon includes those caller-readable docs' keys, versions and update times in the load cache key.
A background write that changes an observed binding reloads the call without a timer.
Unchanged bindings keep their cached value; `refreshMinutes` and principal separation still apply.

```json
"bind": { "fiscal": { "call": "fiscalYear", "args": { "month": { "route": "key" } } } },
"body": [{ "c": "callResult", "from": "fiscal", "label": "This fiscal year" }]
```

### Forms and widgets

A field the page doesn't pick a widget for gets the one its schema implies (or
its own `widget` hint). In a dialog, a field shows with the label and widget a
form on any page gives it, else its schema's `label`.

| Widget | Edits |
|---|---|
| `text`, `textarea`, `date` | text; `date` has a calendar picker and stores `YYYY-MM-DD`, its empty input saying the field's `placeholder` ("Ongoing") |
| `number`, `money`, `percent` | a number; `money` is entered in whole units and stored in minor units, `percent` entered as 5 and stored as 0.05 |
| `bool`, `tristate` | true/false: a checkbox, or yes, no or not set (an optional one's default, so "not set" writes nothing) |
| `choice` | a union of literals, by its labels; with `descriptions` (`{ "flat_rate": "Pays a percent of each deal" }` beside `labels`), one option per line with its description |
| `user` | a member, searched by name, the workspace's active members first and then those who left under Inactive |
| `ref` | a deal, team or module doc, searched as the person types among what they may read (`api.modules.pick`); a company or person from the record service (`api.modules.records`), a company's people when its `company` sibling names one |
| `file` | a file: checked against the field's types and size, uploaded, then shown by name with Remove (see "Files") |
| `list` | a list: one row per item, each an object's fields side by side or one value; rows add, remove and move up and down (tiers, steps, splits) |
| `object` | a nested object's fields (an attainment window) |
| `variant` | the fields of the case its sibling picks; picking another value starts the case afresh (a rule's config by its type) |

Metadata `options` on an array preserve its list editor and label each item by the selected metadata.
`options.by: { sibling, key, list }` reads groups from the options source, matches their `key` against a declared
sibling, and offers the choices and labels in that group's `list`. Changing the sibling drops array items no longer offered.
A form field can attach `optionTargets: [{ path, options }]` to fields inside its declared object schema.
Each relative dotted path must resolve through actual object fields; unknown paths and non-choice targets refuse.
Nullable object wrappers survive the transformation. No payload is flattened.
Dependent choice labels are carried in `choicesBy.labels`, keyed by sibling value, so identical keys can have different labels in different groups.
Literal `null` in an action's arguments or a form's prefill is submitted as null; a computed null remains missing.
Off actions can therefore confirm and send null explicitly without making an empty editor mean two things.

Nested fields get their widgets from their own schema, so a list of tiers whose
threshold says `"widget": "money"` shows money in every row. A nested text field's `"suggest": true` offers the values
that field holds across the docs the reader reads (`api.modules.suggest` takes its dotted path, `agenda.topic`), as a
top-level one does.

**Fields that follow other fields.** Three schema keys tie a field to the ones around it, nested in a list's rows too:

- `inherit: "<field>"` on a field nested in a list's rows (or an object): the row takes the value the form around it holds
  in that field, and the form doesn't show it. An override row's plan is the assignment's plan, so its rule picker
  (`{ "type": "ref", "to": "doc", "collection": "rules", "parent": "planKey" }`) lists that plan's rules at once:
  `"planKey": { "fieldType": { "type": "ref", "to": "doc", "collection": "plans" }, "optional": false, "inherit": "planKey" }`.
  The form fills it on save (the doc an update edits and the action's fixed values count as the form's); the server
  checks it as any value, so an agent writing the row sets it itself.
- A ref with `parent` resets when the field it sits under changes: pick another plan and the rule empties.
- `choicesBy: { sibling, cases: { <sibling value>: [values] } }` on a choice: the values offered for each value the
  sibling holds; any other sibling value offers them all, and a value no longer offered empties. A condition's operators
  by the field it tests: `{ "sibling": "field", "cases": { "stage": ["eq", "neq", "in"] } }`. The server still takes
  every value the field holds (as a form's `hide`).
- A schema `placeholder` may read a doc a ref field names, the row's own or one in the form around it:
  `"placeholder": "Plan: {$ruleKey.config.rate|percent}"` shows the rule's rate in an empty override input. Each value is
  read as the person may read it (`api.modules.refValues`, a field or a dotted path into an object, a doc's, a deal's, a
  member's or a team's); a placeholder whose values are all empty says nothing. A page's field `help` and `placeholder`
  likewise say nothing when every value in them is empty ("Deal: {$row.dealId.contractMonths}" on a deal with none).

For example, a task's Checklist rows can inherit the task's visit, pick one of its stops, offer
Required and Optional only for a Photo or Note check, and say "At stop 2: Loading dock" in their empty input. A New task
form can empty its Stop when its Visit changes.

**Form checks.** A field's `placeholder` (in its schema, or a page's field) is what its empty input says ("Jane Smith").
A field's label holds up to 200 characters (a checkbox's is its whole sentence). A page's field `help` and `placeholder` are texts over the page and the row: "Plan default: {$plan.quota|money}". A form's
or a dialog's submit stays off, saying which field is missing, until every required field holds a value. Closing a
dialog whose fields changed asks "Discard changes?" first. A field whose type is `{ "type": "literal", "value": true }` is a
checkbox the person must tick ("I agree to this plan"): it counts as unfilled until ticked, and the server refuses false.

**Options from a doc.** A page's field (a form's, an op's, a call's or a transition's action `fields`, a wizard step's) takes
`options: { from, list?, value?, label }`: a choice among the rows of the list binding `from` (or a loaded call's value), or
the items of the list field `list` of the doc `from` binds, each by its `value` (a row's key, an item's place from 0) and
labelled by `label` over `{$item.<field>}` and `{$item.n}` (its place from 1): "Step {$item.n}: {$item.label} ({$item.role})"
in place of a typed step number. A call action's `fields` give its dialog's arguments their own label, help, placeholder
and options: Test a deal's rep among the plan's reps, `{ "call": "testDeal", "fields": [{ "field": "rep", "label": "Rep",
"options": { "from": "planReps", "label": "{$item.name}" } }] }`. On a member field the options narrow the member picker
rather than replace it: it keeps its search and Active/Inactive sections and offers only the members the options list
(`"value": "userId"`), saying "No one is left to pick." when they list none: Assign a rep among the members not on the
plan. `sub` and `badge` (texts over `{$item.<field>}`) draw a line under each option and a tag beside it: `"sub": "{$item.title}
· {$item.plans} plans", "badge": "{$item.role}"`. One whose every value is empty draws nothing, so a badge shows only on
the items that have one. On a choice field, `sub` lists the options with their lines, as a choice with descriptions does. A field with options starts among them: an `initial` or the person creating it that they leave out starts as the
only option, or empty. Options bind the form, not the op: to bind every caller, an agent's too, give the action an op
whose guard says the same, as this "Add a task at a stop" op does (`tasks.atStop`: the owner is one of the visit's
attendees, `{ "ref": { "collection": "visits", "key": { "doc": "visit" } }, "where": { "items": { "list": "attendees",
"where": { "field": "person", "eq": { "doc": "owner" } } }, "atLeast": 1 } }`). `hide: [values]` leaves choices out of that one form (Add rule without two SPIFF types);
the server still takes them.

**Suggestions from deals.** A text field's `suggest` may be `{ "deals": "<field>" }`: the values that Canon deal field
(granted in `reads.deals`) holds across the deals the person sees, most used first; or `{ "deals": { "sibling": "<field>" } }`,
the deal field a sibling field names now (a rule condition's value, by the deal field the condition picked). The list
under the input names where its values come from: "Values on deals", or "Used before" for the field's own. A list of text
with `suggest` is picked as several values, as chips, from those found, and any other typed with Enter ("Deal sources").

**Lists drag.** A list widget's rows drag by their handle into place, as Move up and down move them.

**Values from the page.** A `form`, an op action and a transition action take `fixed` and `initial` (an `initial` may be
`{ "text": "{$row.title} (Copy)" }`, a text over the page and the row):
`{ <field>: value }`, each a constant, `{ "route": param }`, `{ "caller":
"userId" }`, `{ "bind": b, "field": f }` (a field of a doc the page binds;
`key` is its key), `{ "today": true }` (the person's date, as their browser has it: a
new visit starts today) or, on a table's row action, `{ "row": f }` (a field of that row; a row action that runs a call takes it in `args` too). A `fixed` field doesn't show and is written as given (the
plan whose page it is); an `initial` one starts the form. Both name fields the
op writes, and the server checks them as any other:

```json
{ "c": "form", "op": "tasks.create", "fixed": { "visit": { "route": "key" } },
  "initial": { "owner": { "bind": "visit", "field": "rep" } },
  "fields": [{ "field": "title", "label": "Task" }, { "field": "owner", "label": "Owner" }] }
```

A `form` alone also accepts a fixed JSON People filter, `{ "filter": { "query": "filter", "json": true } }`.
Its target field is an array of filter objects with required string `field` and `op` fields. Missing or malformed
JSON refuses the form visibly. Canon validates the complete filter against the caller's available People fields,
operators and `FILTERS_MAX`, shows a summary, and links to the existing People filter builder. No raw JSON editor
is shown. A fixed-only update can declare `fields: []`. This prefill does not extend scalar bindings, action
arguments or call arguments. The op's schema, authorization, guards and version check still decide every write.

**Call results.** A call with `returns: "value"` may declare `result`; the page
then draws the value under the button that ran it (with Clear), not in a toast:

| `result` | Draws |
|---|---|
| `{ "kind": "table", "rows"?, "columns", "empty"? }` and any table key (`sort`, `filters`, `search`, `group`, `rowLink`, `rowActions`, column `sort`, `total` and `link`) | the list in the value's field `rows` (or the value, when it is a list), each column's text filling `{$row.<field>}`, as a full table |
| `{ "kind": "kpis", "items": [{ "label", "value" }] }` | figures, each filling `{$result.<field>}` |
| `{ "kind": "message" }` | the value as text |

### Editable hierarchy and sentence controls

Page tables over declared call rows can add `hierarchy`. The module still owns its
parent rules and semantic writes. This declaration names row values, not tables
or platform record APIs:

```json
"hierarchy": {
  "parent": "parent", "depth": "depth", "icon": "icon", "muted": "muted", "star": "star",
  "add": { "call": "addChild", "args": { "key": { "row": "key" }, "expect": { "row": "documentVersion" } }, "choices": "addChoices", "arg": "kind" },
  "move": { "call": "move", "args": { "key": { "row": "key" }, "expect": { "row": "documentVersion" } }, "targets": "moveTargets", "arg": "parent" }
}
```

Rows carry stable keys, nullable parent keys, integer depths, an icon of `target`,
`layers` or `users`, and boolean muted/default-star values. Choice lists hold
`{value,label}` entries. The module computes allowed move target keys with its
own domain rules. Canon checks hierarchy metadata and references, hides collapsed
descendants locally, and adds ghost choices after expanded branches. Drag/drop
passes the source row's fixed arguments and the target key. Keep a declared
Move-to row action for keyboard users. Server calls must recheck parent rules,
versions and caps. Hierarchy tables cannot also sort, group, filter, reorder or
use cards. Their existing `focus` still shares URL selection and hover with maps.

A column's `edit` names a direct declared member call, `args`, the text `field`
and edited `arg`, a version row path and its fixed numeric `versionArg`, and
`maxLength`. Optional `nonempty: true` trims names and reverts an empty input.
Optional `prefix`/`suffix` name display-only row values. Enter/blur submits once;
Escape reloads the current authoritative value. A changed external version
refuses a dirty save. A `validate: {call,args}` can name a read-only call taking
the same edited argument and version. It returns `{text,error?}`; Canon debounces
actual edits and discards stale validation responses. The writing call remains
the authority. Read-only members get cell text.

A definition column uses `definition: {sentence,param,query}` instead of `edit`.
`sentence` names a row value, `param` stores the Sentence/Query mode in the URL,
and `query` is an inline-edit declaration over the same stored representation.
Sentence text is clamped with its complete text on hover. Parsing and raw-query
fallback belong to the module.

The `recordEditor` component uses `from`, `rows`, and `selection` like the table
and map. `model` names a row's `RecordEditorValue`. `options` names one shared
choice dictionary in the call's value. Its types live in `modules/kernel/editor.ts`.
A model contains plain sentence parts, tokens with stable ids, addable conditions,
message fields, and help text. Controls have one of these shapes:

```json
{ "kind": "choices", "values": ["yes"], "options": "answers" }
{ "kind": "terms", "values": ["director"], "placeholder": "A term, then Enter" }
{ "kind": "range", "min": 5, "max": 20 }
```

`options.answers` holds `{value,label}` entries once for the whole response.
Choice controls search when they have more than twelve options. Term controls
accept typed values. Range controls submit a finite minimum or maximum with Set.
Tokens marked `negative` have a dashed underline. Each edit goes through
`change: {call,args,arg}` with a `TokenChange` value. The module resolves ids and
transforms its own query representation. Unknown ids and invalid values must
refuse without a write.

The collapsible Message section uses `message: {call,args,fieldArg,valueArg}`.
The component's `version` and `versionArg` bind the source version for message
blur saves. Model fields supply their keys, current values, labels, placeholders,
maxima and row counts. Prefer a CAS field write that preserves siblings and
supports explicit clearing. Non-editors see disabled message inputs and plain
sentence tokens. Returned metadata cannot name calls, supply expressions or run
code. Manifest validation checks declared calls, arguments and version bindings;
these controls cannot bypass a confirmation, hosted step or Canon operation.
Server admission, read scoping and semantic write gates still apply.

`recordEditor` is for member pages; shared pages and record panels do not admit
that component. Call-result tables do not admit editing declarations. PDF exports retain a page's declared
read-only detail/map focus and table text. `recordEditor` does not add PDF blocks.

### Tables, queues and status

A binding reads what a list shows:

```json
"bind": { "visits": { "view": "visits.all", "limit": 200, "join": ["deal"],
  "count": { "notes": { "view": "notes.forVisits", "by": "parentKey" }, "tasks": { "view": "tasks.forVisits", "by": "visit" } } } }
```

- **`join`** names ref fields. Each row comes with the doc it names as its
  reader may read it: a module doc's fields, a deal's granted fields (`reads`)
  with its name, a member's granted fields with their name, a team's name; null
  when the reader can't see it. Text reads `{$row.deal.amount}`. A joined field
  that names a member (a rep's `managerId`, a deal's `ownerId`, a team's manager,
  a joined doc's member field) filters, groups, sorts and searches by the
  member's name, and a joined date filters as a date range, as the row's own
  fields do: a list of visits can filter by each rep's manager.
- **`count`** with `collect: <field>`: instead of how many, the distinct values those docs hold in `field`, as a list:
  a plan's reps from its assignments, drawn by an `avatars` column (`"avatars": "reps"`).
- **`count`**: per row, how many docs of a list view hold the row's `of` value
  (its key by default) in `by` (a field, or `parentKey` for a set). The view
  takes one list argument and nothing else, read once for every row, as the
  reader sees the docs; past 5,000 counted docs the counts say so instead.
- **`limit`**: the rows it reads (its view's, else 50; at most 1,000). A list
  with more rows than it read says so on the page and offers **Show more**
  (up to 1,000); while it does, it doesn't sort, filter, search or total, so it
  never shows part of its rows as all of them.

A **table** over it:

| Key | What it does |
|---|---|
| `columns[].sort` | A row value (a field, a count or `join.field`) a click on the header sorts by, then the other way. |
| `columns[].total` | `{ sum, over?, format? }`: the sum a section's header and the table's foot show. With `over`, that sum over the sum of `over`, as a ratio (`percent` by default; none when `over` sums to 0): attainment as credited over quota, per section and in the foot, never an average of the rows' ratios. |
| `columns[].group` | What a section's header says in this column: a text over the section's first row, not a sum (`"{$row.deal.amount\|money} deal value"`). On the first column it follows the section's label and count, so a collapsed section still shows it. Needs `group` or `groupBy`. |
| `columns[].cases` | `[{ when, value }]` chooses the first text whose row condition holds, otherwise `value`. Uses the same conditions as a column's `when`. |
| `columns[].empty` | What the cell says when its text comes out empty ("Ongoing", "Not yet"). |
| `columns[].tone` | `{ by, cases, badge? }`: the cell's tone (`info`, `success`, `warn`, `danger`, `neutral`, `ai`: what an AI step filled) by a row value, the first case that holds (`in`, `gte`, `lte`; none: always), as a badge with `badge`: attainment green past 100%. |
| `columns[].tooltip`, `columns[].copy` | A text over the row the cell shows on hover; a text a button beside the cell copies (a rep's email). |
| `columns[].avatars` | A member field, a list of them, or a list's member field (`attendees.person`), drawn as initials with every name on hover and in a list. On the table's first column (with `rowLink`) or a column with `link`, the cell's text follows the initials as the link: a rep's avatar and their statement. |
| `columns[].link` | A page the cell opens, `:params` from the row; or `{ record }` (or `{ "canon": "deal", "ref" }`), the Canon page of a joined deal; `{ "canon": "company" \| "person", "ref" }`, the page of the company or person a ref names; or `{ "canon": "team" }` or `{ "canon": "deals" }`. |
| `sort` | `{ by, dir? }`: the order before anyone clicks. |
| `filters` | `[{ field, label, options? }]`: a choice of the values the rows hold (labels, member and ref names) and every value a choice field's schema holds, or a from–to range for a date field. On a call's rows, `options` names a field of its value listing the values to offer (every stage). |
| `search` | Row values a search box matches as they show (a member field by the member's name, on a call's rows too). A search also matches what the row's cells say, so a joined name (`{$row.plan.name}`, `{$row.rep\|user}`) is found. |
| `emptyFiltered` | What the table says when its search, filters or chip leave no row ("No approvals match"). Under it, **Clear filters** clears the search, the filters and the chip. |
| `group` | `{ by, collapsed?, link?, pageSize? }`: sections by a row value, each with its count and totals, opened and closed by a click; `link` a page its header opens, `:params` from the section's first row (the plan a section of statements is for). `pageSize` pages each section on its own: it shows its first `pageSize` rows and ends with "Show N more of M in <section>", which adds as many again, in place of the table's one "Show more" (on a phone's cards, one button shows more in every section). |
| `columns[].each` | One column per item: `{ "fiscalMonths": <page value> }`, the twelve months of that fiscal year (this one without it) in fiscal order, or `{ from, rows? }`, the rows of a binding. In the column's texts and row paths `{col}` is the item's key (`m7` for July) and `{$col.<field>}` its fields (a month's `label`, `month`, `start`, `end`): `"value": "{$row.{col}\|money}"`, `"sort": "{col}"`. |
| `columns[].headerLink` | A page the header opens, a text over the page and the item: `"statements?month={$col.month}"`. A column's `label` is a text over the page too. |
| `id` | The table's sort, filters and search live in the URL under it (`?v.f.status=planned&v.sort=amount:desc`), so a link opens it as it was. |
| `pageSize` | Rows shown before "Show more" (50). |
| `chips` | `[{ label, when }]`: one-tap chips over the rows (one at a time, or All), each the rows its `when` holds on, a **row condition**: `{ field, in }`, `{ field, set }`, `{ field, me }` (`true`: a member field naming the person; `false`: not naming them) or `{ field, gte }` (a number at least that), with its count after the search: "Assigned to me", "Exceptions". In the URL under `id`. |
| `attention` | A row condition (as a chip's `when`): the rows that need the person, each with a dot. |
| `summary` | `true`: "{n} shown · {m} need attention · {t} total" over the rows (needs `attention`). |
| `groupBy` | `[{ by, label }]`: a "Group by" select of the sections a person may pick, besides the table's `group` and "No grouping". |
| `totalBar` | `{ label }`: a bar at the foot of the window while the table shows, with each total column's sum over the rows shown ("Statement total"). |
| `cards` | `true`: at a phone's width, each row as a card of its columns' labels and values (an `each` column's label filled per item: "Jul"), with its actions and expansions. **Show more** sits under the cards as under the table. |
| `reorder` | `{ call, by?, arg?, args? }`: rows drag by a handle into a new order (while no sort, filter, search, chip or section narrows them), then `call` runs with the keys in that order as `arg` (`keys`) and `args` from the page; `by` is the field holding the order, which the table shows them by. Sequences' steps (`reorderSteps`) are an example. |
| `columns[].bar` | `{ value, tone? }`: a 3px bar under the cell, as full as `value` (a fraction; past 1, full), toned as a column's tone is: attainment against quota. Tone cases take fractions (`"gte": 1`, `"gte": 0.5`). |
| `columns[].popover` | `{ items, label, title? }`: the cell's text as a button that lists the row's list `items`, each as `label` over `{$item.<field>}` (`{$item.value}` for a plain value): "Applied to 2 of 4 reps", then the reps. |
| `columns[].expand` | `{ label?, bind?, body }`: the cell's text as a toggle that opens `body` under the row, across the table: components over the page with the row as `{$row...}`, reading `bind` views per row (`{ "row": "key" }` arguments): a dispute's thread, a deal's walkthrough. Components that draw from their bindings (`table`, `thread`, `detail`, `kpis`, `banner`) draw there. A `thread` there posts under the row's doc with `"post": { "op", "parent": { "row": "key" }, "field" }`: a reply composer on each dispute. |
| `columns[].when` | A row condition (`{ field, in }`, `{ field, set }`, `{ field, me }` or `{ field, gte }`, as a chip's): the cell shows only on the rows it holds on: a "Hidden" badge on hidden plans only. `field` is a row path as a cell's text reads it: a field, a count the binding gives each row (`{ "field": "held", "in": [1] }`; a count of none or an empty list isn't `set`) or a joined doc's field. A printed page leaves the cell empty the same way. |
| `select.param` | A URL parameter holding the picked rows' keys, comma-separated, while any are picked (`?reps=a,b`). A binding's or a call's argument reads it as `{ "query": "reps", "default": "" }`, a list argument as a list, so picking rows narrows what the rest of the page reads. `select` may have only a `param`. |
| `select` | `{ actions }`: checkboxes on the rows, and transitions, deletes or calls run on the rows picked, each row's on its own with every check (one that isn't open to it now is skipped and counted, one the server refuses named). Arguments and a confirmation are asked once. `edit: { op, label?, fields }` adds "Edit (N)": one dialog with a row per picked doc and a column per field (placeholders over the row), Save running the update on each changed row as one row's edit would. On a call's rows, `edit.key` names the row field holding each doc's key (the row's key by default): the dialog reads each doc as the caller reads it now and saves at that version, leaving out a row whose doc is gone or not theirs to edit. |

A table, a queue source and an approval chain take up to 12 row actions; past four on a row, the first three show and
the rest sit under **More**. A row action with `key: { "row": field }` on a list's row acts on the doc that field names,
of any collection (Hold on another collection's doc; a task row that marks its visit done): the server judges
that doc's state and guards, as on a call's row. An approval chain's actions with a `key` are judged the same way: "Go
to this stop" on a route's step moves the visit the step belongs to. An update's dialog on such a doc starts from it.

A row action's call with a `result` draws its value under the row it ran on, across the table, with Clear; a table
there has its own row actions, judged as any call's rows. A write on the page reads a drawn value again when its call
only reads: a task edited from a visit's brief shows its new title there.

**A call's rows.** A table's `from` may name a call binding (`rows`: the field of its value
that holds the list), and a call's `result` table takes the same keys: one table either way,
searched, filtered (a filter's values say what they are: members, dates, true/false), sorted,
grouped and totalled in the page. Its row actions name their doc by a row field: `{ "transition",
"machine", "key": { "row": "openVisit" } }`, an op's update or delete the same way, a create's
values from the row (`"fixed": { "deal": { "row": "id" } }`). The server judges each one before it
shows (`api.modules.judge`): the doc the row names as the caller reads it (one they can't read
hides the action), its state, and the guards that need no arguments, which show as the
disabled button's reason; a write expects the version it judged. A write on the page loads
its calls again, so the row shows what the write did.

A **queue** merges list bindings into one list: each row as its source's `label`,
a `title` and `subtitle` (text over the row), a `date` (a row value; newest
first), a `link` and `actions`. A source's `attention` (`{ field, in }` or `{ field, set }`) marks the rows that need
the person; the queue's `filters: true` offers All, Needs attention and one chip per source, each with its count, and
`group: true` shows a section per source. An approvals inbox is a queue over pending steps,
disputes and reopen requests.

A **jobStatus** line shows a job's keys under `keyPrefix` (each a page value or
`{ bind, field }`; none for the whole job): up to date, or how many wait, run,
retry or stopped (admins see the errors), when jobs last ran and how far the deal
feed is behind:

```json
{ "c": "jobStatus", "job": "tally", "keyPrefix": [{ "route": "key" }], "label": "This month's tallies" }
```

## Reports and charts

### Pacing

A `pacing` component sums a Canon source's money field by day of a date or datetime field. It shares Canon's
pacing runner and chart, fiscal periods, comparison periods, historical target curve, team and owner filters,
and optional split. Every aggregate uses the caller's record client and role visibility. Hidden required fields
make a source unavailable. It reads no module report projection.

```json
{
  "bind": { "plan": { "canon": "targets.forYear" } },
  "body": [{
    "c": "pacing", "id": "bookings", "target": "plan",
    "sources": [{
      "id": "booked", "label": "Bookings", "collection": "canon.deals",
      "date": "closeDate", "amount": "amount",
      "filter": [{ "field": "isWon", "op": "eq", "value": true }]
    }]
  }]
}
```

`sources` holds one to six named choices, each with a unique `id`, `label`, `collection`, `date` and `amount`.
The collection is a `canon.*` record source granted by the module's reads. The date and money fields belong to
that source itself. `filter` holds up to ten fixed filters; callers cannot override those fields or the date.
`coverage: true` multiplies the target by the plan's pipeline coverage, for a created-pipeline source.

`target` names a `targets.forYear` page binding without arguments. The component supplies each compared fiscal
year, up to eight years back. Grant `reads.targets` the fields `year`, `fyStart`, `total`, `coverage`, `repMonths`
and `teamMonths`. Without a saved plan the chart has no plan target. Without `target` it still offers fixed targets.
Targets stay workspace planning data when Reports is off. A Canon action `{ "canon": "targets", "label": "Edit targets" }`
opens `/dashboard/settings/targets`. A standalone `targets.forYear` read without arguments reads the current fiscal year.

### Module dashboards

A static page with `{ "c": "dashboards", "title": "Dashboards" }` lists the caller's own dashboards and the workspace's
shared dashboards for that module. Add a page `tab` to make it reachable beside the builder. The module's landing
page stays as declared by `nav.landing`.

Saved report builders offer **Pin to dashboard** when the caller's role sees a dashboards component in the module.
Pin adds the saved version to an editable dashboard, or creates a private one. Tiles run through `api.modules.report`
as the viewer and use Canon's report charts and table. The grid supports reorder, wide tiles and removal; its owner,
or an admin moderating a shared dashboard, can rename, share or delete it. An admin cannot open another person's
private dashboard. View-as disables writes and reads dashboards as the member previewed.

A dashboard holds at most 24 tiles; each caller can create at most 100 dashboards per module. Names contain 1–80
characters after trimming. A tile must reference a readable saved report from the same module and workspace.
Sharing a dashboard requires every report on it to be shared. A deleted or no-longer-readable report shows as
unavailable. Module dashboards stay separate from Canon's legacy dashboards; `dashboards.module` is optional
until the Reports migration.

### Report sources

A collection that declares `report` can be reported on over every doc a caller reads, past any
index or page limit:

```json
"visits": { ..., "report": { "dimensions": ["rep", "status", "format", "visitOn", "deal", "urgent"], "measures": ["amount"] } }
```

- **Joined dimensions** `<ref>.<field>` group by a field of what a ref names: a deal's
  `stage`, `dealType`, `forecastCategory`, `ownerId`, `closeDate`, `isWon` and the rest a deal
  reads (granted by `reads.deals`), a member's `managerId`, `title`, `department`, `role` (granted
  by `reads.users`) or `team` (the first team, by name, they are on or manage), a team's `name`, a
  company's `name`, `industry`, `country`, `city`, `status` and `ownerId` or a person's `name`, `title`,
  `lifecycleStage` and `ownerId` (granted by `reads.companies` and `reads.people`, read in the report's action from the
  record service as the caller sees them), or a module doc's own field. The record service groups by the ref; Canon then reads each one's
  field as the caller may (null for one they can't see) and merges the groups. They group, and a date
  of one (a deal's close date) buckets by day, week, month, quarter or year, but they don't filter or average.
- **Dimensions** are top-level fields a report groups and filters by: a choice (by its labels), a
  member, a deal, team or doc ref (shown by what it names, as the caller may see it), true/false,
  a number, text, or a date (by its `date` hint; a `time` hint makes a number a time). A date
  groups by day, week, month, quarter or year. `createdAt` and `updatedAt` are dimensions too.
  **Measures** are number fields (money by its `money` hint): sum, average, min and max. Count is
  always there.
- **The projection.** Canon keeps a copy of each reported collection's docs in the workspace's
  record service (`module_docs`), and of every collection its read scope reads (a set's parent, a
  doc a scope's `ref` tests). Every write of such a doc dirties it in the write's own transaction
  (Canon's job `#report`, `convex/lib/modules/jobs.ts`), and the job runner sends the doc as it is
  then, or its deletion, a second or so later. Turning the module on, and every new version that
  serves, sends each collection whole and sweeps what it didn't send. A report says when changes
  are still on their way.
- **The scope.** A report counts only the docs the caller reads: `scope.ts` `reportPlan` turns the
  caller's read scope into the record service's (an owner list for `own` and `team`, the `where`
  with its related docs, a set's live generation under a parent the caller reads), and
  `api.modules.report` is the one way a report reads (`tests/moduleSurfaces.test.ts`). Without a
  record service, the report reads the docs through the scope in Convex (at most 5,000).
- A report answers Canon's report shape (groups, a subtotal per first key, a total), drawn with
  Canon's report table and charts.

The **`report`** component is a report builder: the collection's dimensions and measures as a
palette (in sections: People, Time, Related, Fields), dragged onto **Rows** (two at most), **Columns** (one; three
dimensions in all, a button swaps a row and a column) and **Values** (five at most, moved left and right),
or clicked to add (a dimension to the rows, a measure to the values); a drop onto a zone that holds
something replaces it (the last of the rows when there are two); Canon's filters; a chart; and the
results as a table with totals, sorted by a click on a header, a matrix when it has rows and
columns; **CSV** and **Excel** download the results as they show (money in units with two decimals,
then the total). It opens as declared:

```json
{ "c": "report", "id": "visits", "title": "Visits", "collection": "visits", "sources": ["tasks"], "rows": ["rep"],
  "values": [{ "fn": "count" }, { "fn": "sum", "field": "amount" }], "chart": "column",
  "display": { "axes": ["left", "right"], "types": ["bar", "line"] } }
```

- **Sources.** `sources` names other reported collections the builder offers. A report reads one, picked under **Data
  source**: Add a field lists only that source's fields, and switching to another starts the report over on its fields.
  A saved version may read any of them.
- **Canon's deals and members.** A source may be `canon.deals` or `canon.members`, Canon's own records, as a chart's or a
  call's report read's `collection` may be. Their fields are the ones the install grants (`reads.deals`, `reads.users`):
  a deal's owner, **Account** (`companyName`: the name of the company its `companyId` names; it groups, it doesn't
  filter), stage, deal type, forecast category, close date, won, closed and currency, its owner's team and member
  fields (`ownerId.team`, `ownerId.managerId`), and its amount, probability and **weighted amount** (amount × probability,
  needing both); a member, their team (the first, by name, they are on or lead), role, title, department, manager, start
  date and whether they're active. Deals count as Canon's own deal report counts them, through the caller's record client
  (`records.callerClient`, CP14): the deals their role sees, with the fields it hides left off the palette. Members count as
  the caller's deal scope admits them: everyone, their team's, or only themselves (`scope.ts` `memberRows`). A module
  collection still joins to them the other way, by a ref: a line item's `deal.dealType`, a statement's `rep.team`.
  Canon's deal records don't carry a deal's products or revenue type, so a deals report doesn't group by them: the
  record service's deal object (the registry in `convex/lib/objects/registry.ts` and the service's) and the deal's
  ledger stream have neither field, and deals take no custom fields. Both sit only on the Convex `deals` row
  (`revenueType`, `products`), which a module reads as `reads.deals` and joins through a deal ref. So a collection with
  a deal ref groups by them (`dealId.revenueType`), and its own measures (a credited amount) sum by them there.
  Products is a list, so it is no group key anywhere.
- **Every Canon object.** `reads.records` names the Canon objects a module reports on: `deals`, `companies`, `people`,
  `leads`, `activities` (every note, task, call and meeting), `tasks`, `calls`, `meetings`, `notes`, `products`, a
  custom object's apiName (`custom_projects`), or `"*"` for every one. Each is a source, `canon.companies`,
  `canon.custom_projects` (the registry is `RECORD_SOURCES` in `modules/kernel/reports.ts`), and `"sources": ["canon.*"]`
  offers every one the install grants, the workspace's custom objects too. Its palette is Canon's own report builder's,
  made per workspace when the page opens: the object's fields with their relabels and picklist labels, its custom
  fields, and each lookup's related record's fields as `<lookup>.<field>` ("Company: Industry"), which group but don't
  filter. A field the caller's role hides is neither offered nor accepted, and an archived object has none. It runs as
  Canon's Reports page runs a report (`convex/reports.ts` `run`): `checkSpec`, then the caller's record client, so the
  totals are the same. A declared report over one names only fields every workspace has; a custom field or object is
  checked when it runs. With `reads.records` granting deals, `canon.deals` is this palette (with **Account** and
  **weighted amount**); without it, it stays the fixed one above. The install screen lists the grant, and an upgrade
  that adds one asks for approval.
- **Stage history.** `canon.stageHistory` reads one row per stage visit from the records ledger, through the same
  visibility-scoped reader as Canon's stage-history page. Grant its fields in `reads.stageHistory`: `deal` (the current
  deal name), `stage` (the stage entered), `fromStage`, `changedAt`, `leftAt`, `daysInStage`, `daysSoFar`, `current`,
  and `ownerId` (the current owner). The first observed stage has no from-stage; imported history starts when Canon
  first saw the deal. Deleted deals have no visits. Stage picklists use the workspace's labels. Finished stays have
  `daysInStage`; open stays have `daysSoFar` instead, so averages never mix the two. Group `changedAt` by month and
  count to reproduce Canon's stage entries over time. Count visits by `stage` for entries; filter `current` for open
  or finished stays. Canon's median and distinct deal count remain on its legacy page because generic reports have
  neither measure. The source needs its own grant, including in a `canon.*` builder; `reads.records: ["*"]` alone
  does not grant ledger history. An upgrade adding the grant needs approval. Only the caller's visible deals enter
  the fold. Hidden stage or denied deal reads withhold the source, and hidden deal name or owner removes that field.
  The existing 400,000-entry ledger bound marks a partial report as truncated.
- **Module figures on members.** A collection whose `report` declares `members: "<member ref among its dimensions>"`
  rolls its measures onto Canon's members: a members report offers each as `<collection>__<field>` ("Visits: Amount"),
  each member's value the sum of that field over their docs, read by the collection's own report as the caller (so a
  member's row adds only the docs the caller reads; a member with none reads 0). It groups, filters and sums by team,
  manager or title as any member field: a rep's net commission, total quota or credited revenue on their row.
- **Module dimensions on members.** `report.memberLatest` puts some of the collection's own dimensions on members too, as
  `<collection>__latest_<field>` ("Statements (latest): Attainment bucket"). A member takes the value on their latest
  doc: the one with the greatest `by` (a date, time or text dimension), among the docs `where` keeps (at most five
  filters over the collection's own dimensions, with static values) and, with `"upTo": "today"`, whose `by` is not after
  today. When their latest docs disagree, the value more of them hold wins, then the lowest. A member with no such doc
  has none. It groups and filters as any member field. Canon reads it as the caller, from the collection's report grouped by
  member, `by` (by day) and the field. A result past a report's 500 groups is refused, with a message to narrow `where`:

  ```json
  "report": { "dimensions": ["userId", "periodStart", "periodType", "attainmentBucket"], "measures": ["netCommission"], "members": "userId",
    "memberLatest": { "by": "periodStart", "fields": ["attainmentBucket"], "upTo": "today", "where": [{ "field": "periodType", "op": "eq", "value": "monthly" }] } }
  ```
- **Module figures on deals: not yet.** A collection's deal ref holds the Convex deal's id, and Canon's deal report runs in
  the record service over ledger streams. The two id spaces join (`canonEntities.by_orgId_projectionId`, as a watch's
  deals do), but the record service sums deals by their own fields only. A rollup would need Canon to fold the caller's
  deals itself, each into its group, with the date buckets and the Account join the service applies. That is its own
  piece of work.
- **Three dimensions.** Two rows and a column: the matrix's rows pair the first two ("Ana · Done"), each with its subtotal,
  and a chart draws the pairs along its axis, the third as its series (stacked with **Stacked**). A chart's `report` and a
  call's report read take three the same way.
- **Charts.** `bar` (horizontal bars), `column` (vertical, side by side or `stacked`), `line`, `area` (filled, or
  stacked), `pie` and `number`. With one dimension and several values, a column, line or area chart draws each value as
  its own series, each on the left axis or a second one on the right (`display.axes`: a count beside money), and a
  column chart draws a value as bars or a line over them (`display.types`). The builder's value chips toggle both, and
  a Stacked box stacks columns and areas; `display` is saved with the version.
- **Share of total.** `display.shares` (per value, toggled by a value chip's "% of total") shows a value as its share
  of the report's total of it, a percent: each group's and subtotal's, so the total reads 100% ("% of Reps": a count of
  members by team as shares).
- **Dates.** A date dimension groups by day, week, month, quarter or year (record service 1.36.0), a deal's close date
  too (`deal.closeDate`). Canon's own report builder takes year as well. A date
  range filters one of the source's own dates: a preset (This month, Last quarter, This fiscal year, Last 30 days, All
  time) or words, as a page's `dateRange` reads them.
- **Empty.** With no dimension and only a count, it says **Build a report**; a report that counts nothing says **No
  data**. A matrix sorts its rows by a click on a column's header (its first value), or on the corner (by name), and a
  result past 500 groups says "(showing top groups)", its totals still over every doc.

A link may open it with a shape of its own: `?<id>.config=` (rows, columns, values, chart, as JSON), what a navigate
action's `report` writes (Explore in Report Builder).

Each person saves versions of it (Save, with a name), theirs until they share one (Share), as
Canon's saved reports are. A shared one runs as whoever opens it, over the docs they read. The URL
names the one open (`?visits.saved=<id>`). `api.modules.report` (`{ module, spec | reportId }`),
`savedReports` and `saveReport`, and `canon_module report` and `saved_reports`, are the same for
an agent; `describe` lists each collection's report and each page's reports.

A **`chart`** draws a report (`report`: `{ collection, rows, columns?, values? }`), or a
binding's rows: a list binding's docs or a call binding's value (`rows`, a field of it), each row's
`y` summed (a count without one) by `x` (a date by `bucket`), split by `series`. `stacked` stacks
the series; a list read short says it charts only the rows it read. `order: "value"` (with `dir`) puts the bars by
their value rather than their label, `top: n` keeps the first n, and `format` (`percent` of a fraction, `money`,
`number`) shows the values and axis that way: attainment by rep, highest first, top 15. `link` is a page a click on a
bar opens, `{$point.x}` and `{$point.series}` the bar's values: `"statements?rep={$point.x}"`.

A **`waterfall`** chart (a bridge) walks a call's value from a total through signed steps to another: `start` (a field
of the value) is the first bar, each row of `rows` a step that floats from the running total, labeled by its `x` and
changed by its signed `y`, in the call's order, and `end` (a field, start plus the steps when absent) the last bar.
`startLabel` and `endLabel` name the totals. Increases are green, decreases orange and totals the axis ink, each with
its signed value, and dashed lines join each bar to the next. An end that disagrees with the steps says by how much. It
takes no `series`, `bucket`, `order` or `top`; `format` and `link` (`{$point.x}`, the step) work as on any chart.
Forecast's What moved draws one, and Customer success 0.2.0's Retention walks starting ARR through churn,
contraction and expansion to ending ARR:

```json
{ "c": "chart", "kind": "waterfall", "title": "How the amount moved", "from": "moved", "rows": "steps", "x": "step",
  "y": "amount", "start": "start", "end": "end", "startLabel": "At the start", "endLabel": "At the end", "format": "money" }
```

A **`tree`** has a search that marks the rows it matches and opens the branches over them, zoom, **Expand all** and
**Collapse all**; a click on a row opens its inspector: its `details` (`[{ label, value }]`, texts over the row), who it
reports to, its direct reports and everyone under it. A **`tree`** shows a binding's rows (docs, or a call's value) each under the row whose `id` (its
key by default) its `parent` field holds: a team, by each member's manager.

A page's **`onOpen`** (`{ machine, transition, target }`) runs a transition when the caller opens
the page, on the doc `target` binds, while it may run: the doc is in one of its `from` states, the
caller's role runs it and no guard refuses it. A guard that fails once it has run (`seenAt` set)
makes it idempotent, as for marking a visit seen the first time its own rep opens it. The
transition takes no arguments and asks no confirmation, and isn't a button on that page.

Measured on the local stack (2026-10-18, contract 1.35.0) over 10,008 accounts (`devSeed:seedTam`), 50 runs each, the
record service alone: one key in 4.0 ms at the median (6.5 ms p95), two keys in 5.7 ms (7.9 ms), three keys in 6.4 ms
(7.6 ms), and three keys with a weighted sum over 500 groups (truncated, the third key each account's name) in 12.8 ms
(16.6 ms). A deals report by owner, owner's team and stage over the seed's 24 deals took 35 to 66 ms through Convex.

Measured on the local stack (2026-10-17) over 10,006 visits: the record service answered a report
by rep and status in 16.9 ms at the median (21.9 ms p95, 50 runs), and one scoped to a rep's 2,416
in 8.5 ms (21.5 ms p95); the report action, through Convex, took 22 to 50 ms warm and 133 ms cold.

## Records, exports and print

A record's page is a `detail` grid, its figures (`kpis`), a `thread` of
messages, an `approvalChain` of steps with their actions and a `periodNav` to the
previous and next period.

**Exports** are declared once and read by the page and by agents alike:

```json
"exports": {
  "visits.csv": { "label": "Export visits", "filename": "visits", "view": "visits.all", "join": ["deal"],
    "columns": [{ "label": "Visit", "value": "{$row.title}" }, { "label": "Pipeline", "value": "{$row.amount|money}" }] },
  "digest.csv": { "label": "Export digest", "call": "digest", "rows": "reps", "columns": [...] }
}
```

- A view's export reads every doc of the view the caller reads (up to `limit`,
  at most 5,000; more refuses), with its `join`s. The caller gives the view's
  arguments.
- A call's export runs the call as the caller and writes the rows of its value
  (`rows`, a field of it, or the value).
- Columns are texts over `{$row...}`, with plain values: money as `1234.50`,
  dates as `YYYY-MM-DD`, times in ISO, percents as fractions, members and refs by
  name, labels as they show. A cell a spreadsheet would run as a formula is
  prefixed with `'`.
- A view's export may declare `require: { when, message }`, a predicate every row
  must pass (`{ "intact": true }`: a payout lists only tallies whose seal still
  matches). Otherwise it refuses, with `message` and the rows that fail by name.
- `api.modules.exportCsv` (`{ module, export, args? }` → `{ filename, csv, rows }`)
  and `api.modules.exportFile` (`{ ..., format: "csv" | "xlsx" | "pdf" }` → `{ filename,
  contentType, base64, rows }`) are the ways in: a page's `{ "export" }` action downloads
  it, asking for arguments its `args` don't give, and `canon_module export` and
  `export_file` return it. An action with `"formats": ["csv", "xlsx"]` is a menu.
- A people source declares `people: { provide, key: { arg } }` instead of `view` or `call` and `columns`.
  The provider must be this module's own people-query interface. Its only argument is the named key.
  Canon resolves the filter and visible additions as the caller, refuses more than 25,000 people, and builds
  CSV in the action. Standard contact columns are followed by optional other emails/phones and sorted custom
  columns. Only nonempty `custom.*` values from caller-scoped register rows become variables (`variableName`);
  scalar lists become semicolon-separated text. Company names use the same scoped client and visible name field.
  Cells use `csvOf` formula escaping. No contact rows enter module code or a Convex query result.
  This source accepts CSV only; it cannot declare columns, joins, guards or PDF pages.
- A people export may also declare `record: { op }`. The op must be a system-only create with no member roles
  on a set under the provider's collection. Its schema and fields must accept `target`, `at`, `sent`, `exported`,
  `skipped` and optional `by` (a user ref). Before returning the file, an internal mutation rechecks the current
  caller, workspace, module epoch, declaration, parent visibility and actor's workspace membership. It invokes
  that declared op with target `csv`, the mutation's time, exact exported row count, zero sent/skipped and the
  current actor when `by` is declared. An optional `record.parent: { op, field }` updates one numeric field on
  the provider doc to the same time when at least one person was exported. Its op must be a system-only update
  of that field alone. Both writes are atomic. Failure refuses the export. Recorded exports refuse in a view-as preview.
  For example: `"audience.csv": { "label": "Export CSV", "filename": "audience", "people": {
  "provide": "audiences.v1", "key": { "arg": "audience" } }, "record": { "op": "runs.record" } }`.
- **PDF**: an export with `pdf: { page, key }` also downloads as one PDF: the page `page` (its `:key`) printed for
  each doc its rows name at `key` (a row field; `key` a view row's own), each from a new page under its own title, in
  the rows' order, up to 100. An action offers it with `"formats": [..., "pdf"]`: a statement per rep and period picked.
- **Excel**: one sheet, a bold header, and each column typed by its one value's format:
  money as a number with two decimals, numbers as numbers, dates as dates, the rest as text
  (never a formula). Canon writes it itself, with no spreadsheet library.

`{ "print": "Print" }` prints the page as a document: Canon's print stylesheet
leaves out the navigation, buttons, tabs and forms, so what prints is the record.
`{ "pdf": "Download PDF" }` renders the same on Canon's server (`api.modules.pagePdf`,
`canon_module pdf`): the page read as the person (its URL's parameters too), the calls it
loads run as them, and its header, banners, details, figures, tables (sorted, filtered and
grouped as the URL has them, with totals), status, loaded values, messages, approval steps and set maps as count/overlap tables
in the open tab, set in Helvetica on US Letter pages with "Page i of n". Forms, buttons,
charts, reports, trees and history aren't drawn. Times show in the person's time zone. Canon
writes the PDF itself (`modules/kernel/pdf.ts`, no dependency, no fonts embedded): text is
WinAnsi, Latin-1 and common punctuation, and another character prints as "?". A page's
`document` (`{ heading?, wordmark?, footer? }`, texts over the page) gives its PDF a line over the
title ("COMMISSION STATEMENT"), a wordmark at the top of every page and its own footer line before
Canon's ("Generated by Visits · Visits · printed 2026-10-18"). An `each` column prints
one column per item, as the page shows it.

## Runs

Canon's run history is the platform's, written by whatever ran: the paired CLI (`cliRuns`, and `cliArtifacts` for retained
evidence and lead runs), CRM and call syncs, patch-plan events, health checks and record jobs. A module reads it with
`reads.runs` and the `runs.*` Canon reads (convex/lib/runs.ts shapes each ledger's rows). A run carries `kind` (`cli`,
`evidence`, `lead`, `sync`, `plan`, `health`, `records`), `title`, `detail`, `status`, `at`, `durationMs`, `counts`,
`error`, `href` (Canon's page for it), `startedAt`, `progress` (a running CLI run's or sync's stage and items), `phases`
(a record job's providers) and `stoppable`. Every member reads every run. `runs.cli` reads nothing for a role that sees
only some records, because a CLI run's findings name CRM records. `runs.between` refuses past its limit rather than read
part of a range.

A table column links to a Canon page a row value holds with `link: { "path": "<field>" }` (a `/dashboard/` path, never
another origin: a sync's integration, a job's import) and to a web page with `link: { "url": "<field>" }` (http or https
only, in a new tab: an evidence source, a HubSpot record).

## Event agent reads

`agents.event` returns live event agents, or one live agent with `agent: <id>`, granted through `reads.agents`.
It includes fields and deleted-field labels, owner standing, budgets and recent usage, routing, triggers and webhook
metadata. Signing secrets stay platform-owned. `agents.turns` reads an agent's fixed latest 25 turns, newest first,
through `reads.agentTurns`. A plan whose limit is below the actual window size refuses. `agents.grants` reads its
complete standing-grant set through `reads.agentGrants`, including signature state and exact recent usage, without
signatures or key material. Same-workspace archived agents retain their historical turns and grants.

`agents.options` accepts optional `agent` and returns at most one row, projected to `reads.agentOptions`:
`fields`, `owners`, `audiences`, `slack`, `permissions` and `grantSigningReady`. Fields retain their stable slugs and
human choice labels; owners are eligible candidates, audiences are visible to both caller and owner, and connector
and signing readiness expose no credentials. Preview and agent sessions report management as read only.

These reads and the legacy agent queries share `convex/lib/agentReads.ts`. They use the effective member and role,
including an admin's preview and a membership outside the user's home workspace. Canon's system scope keeps its
existing admin-like reads. Turn records follow `seesRunRecords`: principals and members whose role narrows no read
see record details; others see outcomes and spend. Private routing audience messages are masked independently.
Event sets, grant sets and usage counts refuse when incomplete. Display scans have shared row and serialized-byte
budgets, so large recent histories can refuse instead of returning a partial count.

The Agents module's list and detail pages are read-only. A `?turn=<id>` link selects a turn in its latest-25 window.
Agent creation, definition changes and grant mutations continue through the existing platform surface until their
module actions are migrated.

## Transcripts

A `transcript` shows a Canon call's transcript on a module page: each line's speaker, side (rep or customer, from the
recording when the provider sends it, as Granola does) and time, so a module points at a moment without copying the
call. Canon reads the call itself, as the person looking (`convex/lib/modules/transcripts.ts`), and draws it; no module
doc, view or call holds its text, so a module needs no grant to show one. A call the person can't read, or in
another workspace, shows `empty`. Which calls a person reads is the rule of the `calls.*` reads (see "Server code"):
by the call's owner as their role sees call records, or by the deal it is filed on. A transcript longer than 5,000
lines says so instead.

```json
{ "c": "transcript", "call": { "bind": "visit", "field": "call" },
  "highlights": [{ "from": "notes", "segment": "segment", "tone": "info", "label": "Note: {$row.body}" }],
  "lineActions": [{ "op": "notes.onLine", "label": "Note this line", "parent": { "route": "key" }, "fixed": { "segment": { "row": "segment" } } }] }
```

- **`highlights`** (up to 6): each row of a list binding `from`, or each item of the row's list field `list`, marks the
  line whose index is its `segment`, from character `start` to `end` of the line (the whole line without them), in a
  `tone` (one, or `{ by, cases }` over the row as a column's). `label` is a text over the row. The marked lines show above
  the transcript as chips, each by its time, and a click scrolls to the line.
- **`lineActions`** (up to 3): create ops shown on each line. Their `{ "row": ... }` values read the line: `segment`,
  `speaker`, `side`, `startSec`, `endSec` and `text`.
- **The `call` widget** on a text field picks a call from those the person reads, newest first, by title, and stores
  its id.

## Calling people

A `phone` places calls from a module page through Canon's dialer: the rep's session on their phone or
in the browser, the live call, its outcome and notes, and their lines and voicemail settings, all drawn by Canon
(`src/components/crm/dialer-console.tsx`). The calls are Canon's. Telnyx, the numbers, the recording and its consent
notice, calling hours, the do-not-call list and the abandoned-call cap stay in Canon's connector, which module code
can't reach, and every dial passes the same checks as a call from a person's page. The finished call is a `call`
activity on the person, written as the rep, so a module hears about it with an `activities` watch.

```json
{ "c": "phone", "from": "queued", "person": "person", "name": "name", "phone": "phone", "detail": "{$row.phone}",
  "skip": { "transition": "skip", "machine": "item" }, "since": { "bind": "queue", "field": "loadedAt" },
  "campaign": { "id": { "bind": "queue", "field": "audience" }, "name": "{$queue.audienceName}" } }
```

- **Who is next** is the first row of `from`, in its order, that the session hasn't called since `since` (a time in ms,
  from a one-doc bind or a page value: when the list was loaded). *Call* dials them, or the next few at once when the
  rep dials parallel lines, skipping anyone outside calling hours or on the do-not-call list (the rep is told how many
  wait). A row's `phone` only picks who is next: Canon dials the number on the person's record, read as the rep sees
  them.
- **`skip`** is an action on the next row, beside *Call*.
- **`campaign`** names the audience the rows came from (`id`, a one-doc bind's field or a page value, and `name`, a
  text). Preview and final claims validate that explicit audience in the current workspace and apply its
  abandoned-call cap together with the rep's cap. The component omits the campaign when its id is absent or
  empty. A non-audience queue uses the rep's cap and never inherits the session's previous audience.
  A supplied invalid audience id is refused. The final claim atomically sets
  or clears the session campaign and stamps calls from that same validated audience. A stale parallel limit
  refuses the claim so the rep can check the next people again. Caps still permit a single-line call.
- **Not yet:** a module can't dial by itself (a job or an agent placing a call). That needs a connector action behind a
  per-call approval (shared gap P5).

Record mode draws one person's calling controls, recent calls, recordings, transcripts and insights:

```json
{ "c": "phone", "record": { "query": "record" }, "from": "person", "phone": "phone" }
```

`from` binds a read-only call returning people as an array. Canon selects the row whose `id` matches `record`.
The Dialer's `person` call uses `people.byIds`, with the person's id and a limit of one. The module must grant
`reads.people.phone`. History and recording reads stay caller-scoped platform reads. Call, hangup and log controls
use the same platform connector as the recipe panel. Record mode can appear in a record-page panel.

The Dialer (`modules/examples/dialer/`) loads an audience or the rep's due Sequences call tasks, works the queue
with a `phone`, and marks each person called through an `activities` watch.

## CSV imports

A module takes a spreadsheet of rows through Canon's import flow, the one Accounts and People use: **Upload →
Match columns → Review → Import**. It declares the import and the call that receives the rows:

```json
"csvImports": {
  "visits": {
    "label": "Import visits",
    "call": "importVisits",
    "columns": [
      { "field": "title", "synonyms": ["Name", "Visit name"] },
      { "field": "visitOn", "synonyms": ["Visit date"] },
      { "field": "amount", "label": "Pipeline", "synonyms": ["Value"] }
    ],
    "batch": 100
  }
}
```

and a page offers it in its actions: `{ "csvImport": "visits", "label": "Import CSV" }`.

- **The call** is a person's call (not `system`, not a Canon operation) whose only required argument is `rows`, a list
  of objects. Each column names a field of a row. A row field the call requires must be a column, and the file must
  match it. The column's label is its `label`, else the row field's.
- **Cells** read by the row field's type: text; a number (`$1,250`, `7.5k`, `(200)` for a negative); money in cents
  (`widget: "money"`); a day as `YYYY-MM-DD` (`widget: "date"`, from any shape the record import reads, day first
  when the column is); yes or no (`boolean`); one of a union's literals, by value or label. A ref, a list, an object
  or a file can't be a column.
- **Matching** pairs each column with the file's column named as its field, its label or one of its `synonyms`
  (case, spaces and punctuation ignored). The person changes any match.
- **Review** lists the rows to import and each row it skips: a required cell blank, or a cell that doesn't read. A
  blank optional cell leaves the field out.
- **Import** runs the call with `batch` rows at a time (100 when not given, 500 at most), as the person, through the
  call's role, agent and write checks. Each batch writes all or nothing; a batch that fails stops the import there and
  says from which line. A file holds at most 5,000 rows. Nothing dedupes across runs unless the call does, so a call
  that might be run twice over the same file keys its docs.
- **Agents** don't upload: `describe` lists each import's columns, and an agent runs the call with its rows itself, as
  the call's `agent` mode allows.

## Files

A `file` field holds a file a person uploads:

```json
"photo": { "fieldType": { "type": "file", "accept": ["image/*", ".pdf"], "maxBytes": 5242880 }, "optional": true, "label": "Photo or report" }
```

- **Upload.** The `file` widget checks the file's type and size, asks for an upload URL
  (`api.modules.uploadUrl`: a person whose role writes a file field, never an agent) and
  posts the file there: Canon's upload route on the Convex site (`POST /modules/upload`,
  `convex/lib/modules/uploadRoute.ts`), with a ticket for that person, secret, good for
  30 minutes and once. The route stores the body and records it as the ticket person's file
  in one step, with the size and type it measured (at most 19 MB, under Convex's 20 MB
  body cap), so no storage id is ever handed out to be claimed. The form holds the file's
  id; the write puts it in the doc.
- **Writes.** A write may put a file in a doc only when the writer uploaded it, or it is
  already in a doc they read (a copy), and it fits the field's `accept` and `maxBytes`. A
  file's first doc is where it belongs. Canon's own writes take any of the module's files.
- **Reads.** A detail item or a column that shows one file field (`{$visit.photo}`) shows
  its name; a click asks `api.modules.fileUrl` (`{ module, collection, key, file }`) for a
  download link, which only a reader of a doc that holds the file gets. The link is a
  storage link: whoever holds it can open it, so it is handed only to a reader.
  `canon_module file` returns it to an agent. Exports show the file's name.
- Files a person uploads but never saves stay in storage (see "Not yet").

## Shares (buyer-facing pages)

A share declares the fields of one module doc and its one-level sets that a customer may read. Seller controls,
authenticated preview, visitor sessions, declarative visitor writes, visitor files and email verification are built.
Shares remain off outside the local demo until the security suite and independent boundary review.

```json
"shares": { "customer": {
  "label": "Customer sign-off", "collection": "visits", "when": { "field": "status", "in": ["done"] },
  "identity": { "default": "link", "allow": ["link", "email"] }, "expiresDays": { "default": 30, "max": 120 },
  "read": { "visits": { "fields": ["title", "visitOn", "followUpNote"] } },
  "members": [], "write": { "ops": [], "transitions": [] },
  "pages": [{ "path": "visit", "title": "{$visit.title}", "bind": { "visit": { "root": true } },
    "body": [{ "c": "header", "title": "{$visit.title}" }] }],
  "issue": { "roles": ["admin", "manager", "rep"], "agent": "human" },
  "limits": { "writesPerHour": 60, "uploadsPerDay": 0, "uploadBytes": 0 }
} }
```

- `read` includes the root collection and may include its direct set collections. Each names explicit `fields` and
  an optional `where`, a scalar field with `in` or `neq`, or `all` of those. The root's `when` uses the same shape.
  There is no wildcard. Every field must exist. Member refs use the shown fields in `members`, `name` or `title`.
  A top-level document ref may name the same root or a declared direct set. The closed projection admits only
  the current root generation and each read predicate. Invalid, private, foreign and retired targets lose both
  their ref value and label. Nested document refs, Canon refs and arbitrary `any` data are refused. Ref labels use
  the target's declared projected title, or `Shared item`. Visitor form choices come from that same projection.
- A share owns its `pages`. They never enter the member page list or `pagesOf`. Bindings read only `{ "root": true }`
  or `{ "set": "notes" }`. A set may select one admitted doc with `key: { "route": "key" }`, or filter a projected
  document ref with `where: { "field": "step", "eq": { "route": "key" } }`. The route parameter must occur in the
  page path. A missing selected doc refuses the page. `{ "rootList": "sellerTeam" }` binds a projected root array
  of schema objects, with at most 100 rows. Larger lists refuse the page. The checker allows `header`, `banner`, `detail`, `kpis`, `statusSteps`, `table`, `thread`,
  `actions`, `empty` and `tabs`; links stay among the share's own pages. No member view, call, join, count binding or
  member ref picker runs. Counts and totals use projected rows. Tables sort projected scalars with a key tie-break
  and group projected fields with their safe labels. `Column.link: { "url": "url" }` renders HTTPS links only,
  without credentials or control characters. Other navigation stays within the share's pages. Thread `post.fixed`
  uses bounded form expressions, such as `{ "step": { "bind": "step", "field": "key" } }`. Ref inputs still pass
  the server's closed-tree check.
- `write` names the ops and transitions visitors may run. An op creates only in a read set, or updates
  a doc in the tree. Writes have no effects except `notify`, no `dirties`, no system work or bulk work, and no
  visitor-written text without `maxLength` at most 5,000. Visitor-only writes use `roles: ["visitor"]` and
  `share: "customer"`. Visitor values are `email`, `name`, `label`, `verified` and `id`; a guard or `set` using name
  or email requires a positive verified guard. Member execution refuses visitor values. Page actions must name
  writes declared by that share.
- Visitor-only writes may read `{ "shared": { "from": "root", "field": "rep" } }` or the direct child's
  `parent`. A shared predicate uses `{ "shared": { "from": "root" }, "where": { "field": "status", "in": ["live"] } }`.
  Shared fields must be projected schema paths, and shared predicates admit only bounded projected scalar
  comparisons. The server supplies these subjects from the fresh closed tree. Root docs have no parent. Member
  and system callers refuse these forms. `get`, `first`, `count` and reference traversal remain unavailable.
- The additive shared-root notification recipient must name a top-level projected user ref on the current root.
  It resolves only a current active workspace member, without fallback. A declaration using this branch cannot
  mix it with legacy recipients. Reassignment also fences coalesced notice updates to the current recipient.
  Legacy visitor role recipients and `email: true` declarations keep their existing semantics. Email flags add
  no send authority. Deal rooms uses only `{ "shared": { "from": "root", "field": "rep" } }`.
- `issue.agent` is always `human`. `api.modules.issueLink`, `links`, `revokeLink` and `extendLink` take
  `{ module, share, key }`. Each requires a caller who reads the root and holds one of `issue.roles`; agents cannot
  issue a link. Issue also takes `to: { name?, email?, contactId? }`, `emails?`, `identity?` and `expiresDays?`, and requires the
  root's `when`. It returns `{ url, publicId, expiresAt }` once. The URL is `<site>/r#<token>`, with a 32-byte random
  token. Canon stores its SHA-256 only. The 16-byte random `publicId` grants no access. `links` returns recipient,
  identity, expiry, revocation and open counts, never the token. Revoke and extend take `publicId`; extend takes
  `days` and caps expiry at now plus the share's maximum, at most 120 days. Each change adds a root audit event.
- Each link pins the root's creation time and a SHA-256 policy hash of the share declaration, the read collections'
  schemas, keys, tree membership and integrity declarations, and the full declarations of its named ops and
  transitions. Named transitions also pin their machine's collection, field, states and initial state. Unrelated
  op or transition changes do not change that hash.
- `{ "c": "shareLinks", "share": "customer", "from": "visit" }` belongs on a member page whose `visit` binding
  reads the root doc. It lists links, issues one in a dialog with a one-time copy field, revokes and extends, and
  opens **Preview as customer**. The preview uses `api.modules.previewShare`, no grant, and the visitor renderer
  outside the dashboard shell. Actions are off and preview records no visit.
- The preview reads raw docs only through `scope.shareDocs`, which checks the member's read access on the root and
  every child. It filters the tree and each `where`, then projects fields
  before building a payload. Member labels use only declared member fields of members referenced on the root;
  file metadata uses only projected file fields of visible docs. The member page's labels, joins and counts never
  enter this path.
- Shares are on only with Convex `MODULE_SHARES=on` or the explicit local demo auth bypass. Otherwise writes and
  preview refuse and the component says "Customer links aren't on in this workspace yet". Turning them on for dev
  remains a human step after V3 and independent boundary review.

- The recipient opens `/r#<token>`. GET renders the notice without reading a grant or recording a visit. The page
  clears the fragment; a deliberate Open POST exchanges it for an HttpOnly per-grant cookie and redirects to
  `/r/v/<publicId>`. In link mode, forwarded browsers declare an unverified name and email. An existing session is
  reused; a grant permits at most 25 sessions. Email-mode opens create or reuse a pending session with the same cookie.
  Pending sessions return no shared content, opened events, owner notices, daily records or observations.
- Each visitor request uses a short-lived server-signed RS256 envelope bound to its one hardcoded function and
  canonical arguments. `visitorScope` rechecks the issuer, module, root identity, expiry, revocation and pinned
  policy. It exposes the share's projected page and its declared `op` and `transition` capabilities. Visitor paths
  never acquire a member identity or execute member views. Member previews keep actions disabled.
- JSON routes require the configured Origin and a body of at most 64 KB. Cookies are Secure and `__Host-` scoped
  except on the explicit local HTTP stack. Duplicate cookies refuse. Responses have private no-store caching,
  no-referrer, nosniff, noindex and a restrictive CSP. A configured `CANON_CLIENT_IP_HEADER` must be overwritten by
  the deployment's ingress; X-Forwarded-For uses its last hop, and an absent setting reads as unknown.
- Opens and page reads have session, grant, workspace and deployment bounds. Only admitted requests reserve
  nonce rows. Open events identify the visitor; page events coalesce per visitor/page/hour and store no IP. Reads
  start no module job. The page refreshes every 30 seconds while visible; revocation applies to its next request.
- Email identity permits exact recipient emails or exact domains. `emails` adds recipients to `to.email`, which
  remains the first recipient. Canon trims, lowercases and deduplicates them, with at most 25 emails. Optional
  `identity.domains` declares at most 10 exact domains and is pinned by the share policy. Without that declaration,
  issuance uses the existing member-read canonical account domain pin when available. A module without a pin needs
  a declared domain or explicit email. An email link with neither refuses. Wildcards and subdomain suffixes do not match.
- `/api/visit/request-code` takes `{ publicId, email }`; `/api/visit/verify-code` takes `{ publicId, code }`.
  Both are same-origin JSON POSTs, with only the per-grant cookie supplying the session. Their hardcoded signed
  mutations are `visits.visitRequestCode` and `visits.visitVerifyCode`. Request returns `{ ok: true }` for both
  eligible and ineligible emails. Verify returns `{ ok: true }` only on success. Failures expose no private details.
  The page endpoint alone returns HTTP 403 with `{ verificationRequired: true }` for a live pending session, which
  makes the reader display its email and code form before any content is delivered.
- The six-digit code expires after ten minutes or the grant's expiry, whichever comes first. `moduleVisitCodes`
  keeps one salted hash per visitor, bound to its workspace, grant and email, with `issued` or `used` state and a
  five-attempt ceiling. Resend invalidates the previous code. Successful verification consumes the code and sets
  only that visitor's normalized email and verified flag in one transaction. A verified session cannot switch emails.
  Admitted code requests and attempts consume their signed nonce, including wrong codes. Indexed request-time cleanup
  deletes at most 20 expired codes, without module jobs.
- Code requests allow three per session per hour and one per minute. Per-hour request limits also allow 30 per
  grant, five per workspace/email, 20 per IP and 200 per workspace. Attempts allow five per session per hour across
  resends, 100 per grant, ten per workspace/email, 50 per IP and 1,000 per workspace. The IP key uses the same signed
  ingress metadata as other visitor limits. Rate keys hash email and IP values. Exhausted budgets return HTTP 429.
- Codes use only `queueWorkspaceEmail(ctx, { orgId, to: { address }, subject, body, cause })` and its existing
  workspace system-notice gate, suppression and dispatcher. The private code lives in the mail body, never in a
  public response, URL, event or observation. Causes use `visit-code:`, separate from reserved sequence causes.
  No mailbox consent, provider or gate override is involved. A local stack uses the existing email sink.
- Email-mode page, op, transition, upload and file capabilities require a verified visitor. Grant, issuer, module,
  root and policy checks still run on every request before and after verification. First verification records the
  opened event and owner notice once. The first subsequent admitted page uses the existing coalesced daily record
  and engagement path. Only verified email matching the grant's canonical contact pin attributes to that contact.
- `/api/visit/op` and `/api/visit/transition` call separate hardcoded mutations with cookie-bound, signed arguments.
  They accept no browser evidence, identity, parent override or function name. Successful writes return only
  `{ "ok": true }`, then the page reads again. Forms receive only writable field metadata. They receive no complete
  member manifest, guards, server `set`, effects or hidden values. Projected docs carry their version for CAS.
  A share thread uses `post.parent: { "root": true }`; the server supplies the root key and accepts no parent argument.
- Updates and transitions require the current version of a visible doc in the grant's live tree. Creates choose
  their parent from the grant and use its active set generation. Both paths preserve schema validation and index
  slots during upgrades. Machine fields, key fields and integrity seals remain protected; sealed docs and their
  sealed child sets refuse visitor changes. Visitor inputs cannot attach refs. New files require the upload lifecycle
  below. Text holds at most 5,000
  characters; URL, href and link fields accept only HTTP or HTTPS URLs.
- Every successful visitor write records its session-bound visitor id, grant, verification status and declared
  email when present. Its event keeps the signed edge-reported IP and browser. Only admins read visitor evidence
  through the event reader. A self-declared name or email labels the action and grants no ownership. Ownership
  guards compare with `{ "visitor": "id" }`. A denied write allocates no nonce receipt, and a replay duplicates
  no document, event or notification.
- Write budgets are the share's `writesPerHour` for each session, 300 per grant per day, and 10,000 per workspace
  per day. Notification updates share one five-minute window for each visitor and root. A bounded counter stores
  the count, first event cause and at most 50 notification ids. Repeated writes update the notification's readable
  count and room title. Only active workspace recipients receive notices. Visitor notifications never send email,
  including declarations with `email: true`, and never enqueue jobs or outbound work.

Visitor file fields and transition file arguments use top-level `file` validators. The customer form sends a binary
body to the same-origin `POST /api/visit/upload`, with URI-encoded JSON in `X-Canon-Upload` containing only the public
grant id, declared action, field, intended key/version when updating, and filename. The route requires the grant's
HttpOnly cookie and exact Origin. It counts the actual stream, at most 19 MB, including requests without
Content-Length, and ignores browser MIME. PNG, JPEG and PDF magic bytes must match the filename extension and the
field's `accept` and `maxBytes`, as a `customerPhotos` field that accepts PNG and JPEG up to 5 MB.

The server obtains a signed `visits:visitUpload` reservation before storage. Tickets bind the org, module, grant,
session, policy, root creation time, live child generation, action, field, target, filename, measured bytes, type and
SHA-256 digest. They expire after ten minutes. The separate `/modules/visitor-upload` storage route accepts ticket
credentials in headers, rechecks their live authority and verifies the body again. Member and visitor upload routes
refuse each other's tickets. The browser receives only the module file id, filename, type and byte count.

Tickets move from `reserved` to `stored` to `attached`, or from `reserved` to `released`. One mutation reserves the
share's daily upload count and lifetime byte budget, alongside workspace caps of 1,000 uploads and 1 GiB
per UTC day. Failed storage releases an unused reservation once. Each new reservation reconciles at
most twenty expired pending tickets. Stored files remain charged even if their forms are abandoned or expire.
Repeated finalization cannot replace the stored blob; failed and losing blobs are deleted. Saving through the
declared op or transition attaches the file and writes the document in the same mutation, with CAS, guards, seals,
schema validation, evidence and the existing notification coalescing. It creates no jobs or outbound messages.

`POST /api/visit/file` accepts JSON with the public grant id and module file id. Its signed `visits:visitFile` call
resolves only files in projected fields of live visible share documents. The server fetches the signed storage URL
and streams an attachment. It never redirects to storage or returns a storage URL. Downloads use private no-store,
no-referrer, nosniff and sandbox CSP headers with a safe filename. Buyer files show their visitor label,
verified/unverified status and `not scanned` to customer and seller. A declared name grants no authority.

Buyer links live in `moduleShareGrants`, read and written only by `convex/lib/modules/visitors.ts`. The original
`moduleGrants` table continues to hold signed standing approvals for Canon record writes. The surfaces test enforces
the buyer-link table boundary and permits only `visitors.ts` to call `shareDocs` and `writeShareDoc`.
A module can require verified identity for one visitor write and permit link-mode writes in separate projected sets.
`modules/examples/deal-rooms/` shares a room through a link-mode buyer link. Internal notes and browser ownership ids stay out of the share.

## Evidence

A transition may record where the person ran it: `"evidence": ["ip", "userAgent"]`. Its
`set` reads them as `{ "evidence": "ip" }` (a Sign off transition can keep both on the doc),
and its history row keeps them.

- Convex sees neither on a dashboard write. So the page sends such a transition to Canon's
  web server (`POST /api/modules/transition`, JSON from Canon's own pages only), which reads
  the request's IP address (Cloudflare's `cf-connecting-ip`, else the first `X-Forwarded-For`
  hop) and its User-Agent, signs them with the transition they are for (module, machine,
  name, doc and the version it expects) and the person, for two minutes, under Canon's
  service key (the one MCP's service tokens use), and runs it as the person with their own
  session. Convex checks the signature against that key's public JWKS
  (`convex/lib/modules/evidence.ts`) before the transition runs. Without a signed token,
  such a transition refuses; module code and calls can't run it.
- It needs `agent: "human"`, isn't system and isn't a page's `onOpen`: it is a person's.
- **Privacy.** An IP address and a browser string are personal data. Canon records them
  only for a transition that declares them, on that doc's history and in the fields its
  `set` names. The history shows them to admins and to the person who ran it; other readers
  of the doc see the row without them. A module that `set`s them into fields shows them to
  whoever reads those fields: declare it only for what needs it, such as an e-signature.

## Integrity

A collection's `integrity` declares a seal: `field` (an optional text field Canon
owns), `fields` (the doc's fields it covers) and `children` (set collections of
this one, and their fields). A transition with `"seal": true` stores, once the
transition and its effects are done, `sha256:<hex>` of the canonical JSON of
those fields and of each set's live docs (sorted, so rewriting a set with the
same docs keeps the seal):

```json
"integrity": { "field": "seal", "fields": ["title", "amount", "status"], "children": { "notes": ["body", "author"] } }
```

- No op, call or effect writes the seal; a `set` only unsets it (unarchiving,
  reopening).
- `{ "intact": true }` holds when the doc is sealed and the seal, recomputed,
  matches: a guard on paying or exporting a locked statement.
- `{ "c": "integrity", "from": "<bind>" }` shows Sealed (it matches), Changed
  since it was sealed, or Not sealed, recomputed for each page read.
- `api.modules.verify` and `canon_module verify` (`{ module, collection, key }`)
  return the same for an agent.
- A set may hold at most 1,000 live docs under a sealed doc.
- On a local stack, `modules.devTamper` changes a doc with no checks, to see a
  seal catch it.

## Notifications

A transition's `notify` effect, or an op's `effects`, sends an in-app notification:

```json
{ "notify": [{ "role": ["manager"] }, { "doc": "rep" }], "message": "{$doc.title} is done. Review it by {$doc.reviewBy|date}.", "link": "visits/:key" }
```

- Recipients are values naming a member (a member field, a `lookup` of one, a
  list of them) or `{ "role": [roles] }`, every member with one of those roles,
  at most 50. The person who caused it isn't notified, and an id that isn't a
  member of the workspace is skipped.
- `message` fills `{$doc.<field>|format}` from the doc after the move. `link`
  is a page of the module, with `:key`, `:parentKey` and the doc's fields.
- Canon's own calls (jobs, watches, schedules) notify with the `notify` intent.
- `subject` (a text over `{$doc...}`, at most 120 characters) is the line above the message, and `badge` what kind of
  notice it is ("Dispute"); the `notify` intent takes both.
- Members see them under **Notifications** in the sidebar, newest first, each with its badge, its subject and two
  lines of its message. Only the person marks one read (decision 2026-10-18, reversing M13): opening it, its **Mark
  read**, or **Mark all read**; opening the list marks nothing. A page reads the caller's unread count from the module
  as `{$notifications.unread}`. An admin viewing as a member sees that member's, and nothing marks them read. Agents read their person's with
  `canon_module notifications` (`{ module?, limit? }`).
- `"email": true` emails it too, to each member who wants the module's notices by email (see "Outbound").

## Outbound

### Workspace suppression

The SQ3 suppression authority is shared by contact delivery paths. A suppression preview grants no permission to
send. Module mailbox email also requires the sender authority and current recipient checks described below.
Installing a module does not enable a channel or migrate suppression data.

The `suppressions` table keeps one row per workspace, kind, normalized value and source. Kinds are `email`, `domain`,
`phone` and `linkedin`. Sources are `unsubscribe`, `reply`, `bounce`, `manual` and `dnc`. Each cause retains its own
`active` or `lifted` state. Lifting a DNC cause cannot lift a manual or bounce cause on the same phone. Original
`addedBy`, `addedAt`, `reason` and `contactId` provenance remains on the row; `suppressionEvents` records adds, lifts
and reactivations with the actor and time. An identical repeated add or lift writes no second event.

`normalizeSuppression` shares Dialer's `toE164` and LinkedIn's `publicIdentifierOf`. Email keys are trimmed and
lowercased. Email domains match exactly, without matching subdomains. LinkedIn keys canonicalize the profile URL,
ignoring tracking parameters and host variants. Phone rules match the normalized number even without a contact id,
or when multiple contacts share it. Indexed reads include the workspace in every key and read at most six rows per
identifier, refusing an inconsistent excess rather than returning a partial verdict.

Every decision has an explicit `SuppressionPurpose`:

| Purpose | Applicable causes |
| --- | --- |
| `automated_outreach` | unsubscribe, reply, bounce, manual, dnc |
| `manual_action` | bounce, manual, dnc |
| `system_notice` | bounce, manual, dnc |

Email and domain rules affect email, phone rules affect `voice`, and LinkedIn rules affect `linkedin`. An email
unsubscribe does not stop unrelated workspace notices, Slack posts or webhooks. The public preview purpose is not
send authorization. Egress chooses its purpose on the server. Gmail claims and Dialer preview/admission/final
claims use `callerOutreachPurpose`; service-JWT CLI/MCP callers count as automated agents, and explicit rep clicks,
including Log and call next, count as manual actions. LinkedIn cadences and vendor campaign pushes are automated.
Workspace notices use `system_notice`. Owner-approved automated email remains `automated_outreach`. Personal
module email reaches `manual_action` only after the mailbox owner's exact-message confirmation. A module's kind
label, an agent proposal or a manager's approval cannot supply that confirmation. Calling hours and recording
consent remain separate Dialer checks.

The shared database helper is `suppressionFor(ctx, orgId, identifiers, purpose)` in
`convex/lib/suppressions/store.ts`. It returns `ChannelSuppressions`, with `email`, `linkedin` and `voice` verdicts.
Each verdict has `blocked`, a stable `code` such as `suppression.dnc`, `text`, and `reasons` containing codes and text.
A clear verdict has `code: null`, `text: null` and no reasons. Verdicts never contain the matching address, normalized
value, contact metadata or an admin's note.

**Derived contact read.** `reads.people: ["name", "title", "suppression"]` grants suppression status without granting
the module email addresses, phone numbers or LinkedIn URLs. `suppression` is a derived field, removed from raw
record-service field lists. `suppression.check` takes contact `ids` and an optional `purpose` with the three values
above; the default is `automated_outreach`. Its action resolves those contacts through the caller-scoped record
client and checks only identifiers the caller's own field permissions expose. Invisible, missing or other-workspace
contacts are omitted. Hidden identifiers contribute no matches. The result is a list of
`{ id, createdAt, email, linkedin, voice }`; no identifiers or suppression rows are returned. There is no privileged
system fallback. A system call cannot read `suppression.check`. Other caller-scoped people reads include the
`suppression` field when granted; system reads omit it.

The people ref picker uses the same derived grant and scoped resolution through `modules.records`. It adds
`doNotContact` to its existing visible options and shows "Do not contact" beside blocked people. It does not hide
candidates or expand record access. The badge does not authorize a send. Egress always resolves its recipient and rechecks independently.

**Administration.** Settings > Outbound > Do not contact lists, adds and lifts causes for workspace admins. Public
`suppressions.list({ paginationOpts })`, `add({ kind, value, source, reason? })` and `lift({ id, reason? })` derive the
workspace from authentication. Preview mode, reps and managers cannot administer rules. List pages read 1–100 rows;
canonical rows come first, followed by legacy DNC rows without a canonical cause. Cursors are opaque and a filtered
legacy page may be empty before `isDone`. `lift` accepts either canonical or old DNC ids. The frontend skips new
queries and mutations until the stable `organizations.context.features.suppressions` capability is true. An older
backend can still serve the existing Settings and picker UI.

**Egress inventory.** These are the actual recipient delivery paths:

- `emailActions.sendToContact` resolves the visible current address and passes `emailAccounts.claimSend` before
  Unipile's `/emails`. The claim transaction applies canonical suppression before reserving daily capacity.
- `dialerActions.callContact` and `dialContacts` resolve the current visible phone before `claimCall` or
  `claimRace`. Both final claims and the list preview checks reach the canonical helper through Dialer's
  compliance functions. `setOutcome` adds the rep's DNC in its existing mutation.
- LinkedIn enrollment admission checks canonical rules, and `linkedinWorker.claim` stops suppressed eligible invite
  or message work while continuing through its bounded scan for healthy rows. `performInvite` and `performMessage`
  receive only claimed work. Connection syncs and invitation withdrawals are not new outreach.
- `audienceActions` implements the required `PushPorts.suppressed` read. `previewPush` reports `skippedSuppressed`
  and subtracts it from `toSend`. `pushTo` checks again before each Instantly, Smartlead or EmailBison provider
  batch, records skipped reasons and excludes suppressed people from rejected counts. Adapters recheck at their
  batch boundary; EmailBison checks again before attaching saved leads to a campaign.
- `outboundDispatch` claims run the same gate as enqueueing. `queueWorkspaceEmail`, including deal-room access
  codes, and module notification email use the same path. Suppressed rows stay persisted and are never dispatched.

`agentSlack` and `dealPlayKeeper` send internal workspace Slack notices, and `recordWebhooks` delivers subscribed
record events to configured endpoints. The outbox also posts Slack notices and signed module webhooks. These have
no contact email, phone or LinkedIn recipient to match; an email unsubscribe does not affect them. Dialer's agent
leg calls the rep's own device, not a contact. Gmail drafts and keeper drafts are not sends.

**DNC migration and compatibility.** `dialerDoNotCall` remains unchanged and read-only for the rollout release. There
are no runtime legacy inserts, patches or deletes. The local-only `devSeed.seedSuppressionLegacy` fixture creates
two fake legacy rows for rollout proof. New DNC adds write canonical `source: "dnc"` rows. `dialer.doNotCallList`
retains `{ _id, number, reason, addedAt }`, `numberStatus` retains `{ doNotCall }`, and `removeDoNotCall` accepts both
`Id<"dialerDoNotCall">` and `Id<"suppressions">`. A stale client's old id maps to the same canonical cause, creating a
lifted tombstone if needed. Only phone/DNC canonical ids can be lifted through that legacy mutation. Other causes
remain independent. Reps can still add DNC rules; only an admin can lift them.

`internal.suppressions.migrateDncPage({ orgId })` processes at most 100 legacy rows in one transaction. Its persisted
`suppressionMigrations` row owns the cursor, processed count (`migrated`) and explicit `complete` state. Callers
cannot skip pages by supplying a cursor. Check-then-insert preserves every existing canonical cause, including
lifted rows. The migration copies original DNC provenance and leaves other workspaces untouched. A repeated call
after completion returns the same result without changing rows. A malformed legacy number refuses the page and
cannot mark migration complete.

No deployment, cron, UI action or writer automatically runs this migration. The parent owns local migration proof;
a human must separately authorize and complete any shared-data rollout. During and after this release, legacy
fallback is used only when no canonical DNC row exists. Any canonical DNC row, including a lifted tombstone, wins.
Completion does not disable fallback in this code. A later release may remove compatibility reads only after the
human confirms completed migration for every workspace. Retiring the legacy table and stale-client arguments is a
separate followup; this slice never deletes legacy data.

### Outbox and delivery

A send is a write. It leaves Canon only through the outbox (`outboundMessages`), and it is decided in the same
transaction as the op, transition or call that asks for it. Nothing a module declares sends until an admin turns its
channel on.

```json
"outbound": {
  "email": { "from": ["workspace"], "kinds": ["notice"] },
  "slack": { "channels": ["field-team"] },
  "webhook": { "events": ["visit.done"] }
},
"templates": {
  "visitDoneSlack": { "channel": "slack", "text": "*{$doc.title}* is done ({$doc.rep|user}, {$doc.visitOn|date})." },
  "visitDoneHook": { "channel": "webhook", "data": { "visit": "{$doc.key}", "title": "{$doc.title}", "completedAt": "{$doc.completedAt|time}" } }
}
```

- **`outbound`** names the channels. `slack.channels` and `webhook.events` are names: an admin maps a Slack name to a
  channel and points webhook endpoints at events in Settings > Outbound, so the module never sees a URL, a token or a
  secret. The install screen lists them, and Settings > Outbound turns each channel on per module.
- **`templates`** are the messages, by name: an email's `subject` and `body`, a Slack `text`, a webhook's `data` (each
  value a text, sent as JSON). They fill `{$doc...}` from the doc as the write left it, `{$vars...}` from a call's
  `vars`, and `{$to...}` (`name`, `firstName`, `email`) from a member they go to. A `{$...}` that comes out empty
  refuses the whole message: nothing sends half-filled. Every error names its path, as `templates.done.channel`.
- **`send`**, an effect on an op or a transition: `{ "send": { "template", "to", "kind"?, "approval"? } }`, with `to`
  one of `{ "slack": name }`, `{ "webhook": event }` or `{ "members": [recipients] }` (as `notify` names them, at most
  20; a notice email). `approval: "person"` holds it until a person approves it. `when` skips it, as any effect.
- **`{ "op": "send", template, to, kind?, vars?, key }`**, the call intent (jobs too). `to` takes member ids. `key`
  names the send: a rerun with the same key queues nothing again.
- **`notify` with `"email": true`** emails the notice to each member it reaches, as they chose for the module under
  Notifications > Email me: each one as it happens (the default), one digest a day at 08:00 UTC, or off. It needs
  `outbound.email` with `"workspace"` and `"notice"`.

Each recipient is one row: `queued` to go, `held` until `notBefore`, `awaiting_approval`, `suppressed`, or `refused` with why. Its
idempotency key is sha256 of the workspace, the module, the cause (the op's or transition's `moduleEvents` row, or
`call:<name>:<key>`), the effect's place and the recipient, checked before it is inserted in the same mutation: a
retried mutation, a job rerun or a re-applied proposal finds the row and writes nothing. The causing doc's history gets
a line naming the row.

**The send gate** (`convex/lib/outbound/gate.ts`) runs when a row queues and again when the dispatcher claims it. It is
an ordered list of checks, and the first with a verdict decides: the channel is declared, and on for the module; the
template rendered; workspace email is a notice to a member; the channel can deliver here (workspace email needs Postmark on a deployment); the Slack name is
mapped, or an endpoint takes the event; a person approved it, when it asks; and the rate limits: one post a second to a
Slack channel, 10 a second to a webhook endpoint, 500 sends a day from a module. Member recipients must still have
an active workspace membership and an email address. Canonical suppression is checked before provider readiness; a match keeps the row `suppressed`. Notification email rechecks the member's current delivery choice.
Over a limit the row is `held` with `notBefore`, never dropped.

### Member mailbox email

Contact email uses the same `outboundMessages` table and dispatcher. The closed mailbox branch in
`convex/lib/outbound/mailboxQueue.ts` prepares the exact delivery before reserving an attempt. It rechecks live
authority at enqueue, approval and final claim. The generic workspace-notice branch cannot send a mailbox row.

A module declares `member_mailbox` and `personal`, `automated`, or both under `outbound.email`. Its saved document
holds an explicit `senders` ref and canonical `people` refs. Grant `reads.senders` the fields the module needs from
`ownerId`, `name`, `address` and `status`. Sender reads, labels and pickers follow the current caller's scope. They
return no provider account id, credential or send permission.

An op or transition sends from its actual saved document, including the version written by that action:

```json
{ "send": {
  "template": "agendaEmail",
  "to": { "people": [{ "copy": "contacts" }] },
  "from": { "sender": { "doc": "emailSender" } },
  "kind": "personal"
} }
```

`to.people` expressions may resolve contact ids or arrays of ids. Canon flattens and deduplicates them, refusing
anything other than 1–20 canonical contacts. It never truncates an oversized result. `from.sender` names one
`emailAccounts` ref. Canon does not infer a mailbox from a member id. The same email template can use unformatted
`{$to.name}`, `{$to.firstName}`, `{$to.email}`, `{$sender.name}`, `{$sender.email}` and explicit top-level text fields
such as `{$doc.emailBody}`. Missing fields refuse preparation. Authored values are substituted once and never become
new template instructions. Mailbox sends accept no `vars` or module-supplied address, rendered text or authorization
reference.

A call's people-email intent instead names literal contact and sender ids, plus the current source document:

```json
{ "op": "send", "template": "agendaEmail", "key": "agenda:visit-1",
  "to": { "people": ["con_example"] }, "from": { "sender": "<emailAccounts id>" },
  "source": { "collection": "visits", "key": "visit-1", "version": 3 },
  "kind": "personal" }
```

The source version must match before any call writes and again before preparation. The source and recipient must
be visible to both the causal person and the mailbox owner. Canon resolves the current recipient from its worked
contact mapping and ledger version in the claim transaction. Missing, stale, hidden or ambiguous authority refuses;
an action snapshot or cached address cannot substitute. Generic agent, background and system mailbox sends refuse.
An agent can propose a saved draft edit through a propose-only op, with the normal patch-plan version check. Applying
that source proposal creates no mailbox consent. A person requests the saved email separately.

**Exact owner approval.** Personal email always waits in `awaiting_approval`. Automated email without an applicable
manifest grant also waits for its mailbox owner. The owner opens **Review exact email**, reads the frozen sender,
recipient, subject and full body, then confirms that exact binding. Managers and admins may cancel unclaimed rows
but cannot approve for another owner. Preview sessions and service callers cannot approve. Source, template,
recipient, permissions or mailbox linkage changes refuse the old preparation. Exact preparations expire after seven
days. Editing a draft requires a fresh request and owner decision; an old row is never silently refreshed.

**Standing grants.** Only the active mailbox owner can create or revoke a `mailboxSendGrants` row. Canon signs its
workspace, module, owner, mailbox linkage, template terms, daily cap and expiry. Missing signing configuration
refuses creation. Generic automated sends use only a unique current manifest grant matching the sender and exact
template. Manifest grants allow literal text and the closed canonical recipient fields, not module-document or AI
draft text. Multiple matching grants refuse ambiguity. A revoked, expired or changed grant cannot authorize a final
claim. Grant ids are not bearer credentials.

The separate closed `sq1.email.v1` path consumes Canon-owned sequence launch, enrollment and request authority.
Its set grant binds the launch id and canonical template-set hash. SQ1's live consent epoch is checked separately.
The selected template must belong to that approved set. A set grant permits only the canonical merge allowlist,
never module-doc text or per-contact AI drafts. Enqueue atomically pairs one frozen row with one canonical request;
final claim atomically reserves that pair, its request allowance and P4 budgets. A request-bound row cannot fall back
to exact approval, `sendNow` or a manifest grant. Modules cannot supply this reference or use the reserved
`canon:sq1.email.v1:` cause namespace. These internal ports do not expose a sequence launch or enrollment API.

**Limits and compliance.** Automated email uses the live workspace timezone until a canonical recipient or company
timezone is available. It waits for Monday–Friday, 08:00 inclusive to 18:00 exclusive, and the workspace recipient cap
of at most three emails per rolling seven days across modules. Its frozen delivery includes the current postal
address, signed unsubscribe link and RFC 8058 headers. GET confirms without changing suppression; a valid one-click
POST adds the canonical unsubscribe cause. Invalid tokens answer uniformly without changing state. Expired material
refuses rather than refreshing under the old approval.

An owner's personal confirmation skips automated hours, recipient weekly caps and unsubscribe material, but retains
manual, bounce and DNC suppression floors. Every mailbox path shares the existing `emailSends` rolling limit of
100 sending, sent or unknown rows per day with direct Gmail, and the module's 500-claim daily limit. Known failures
release mailbox capacity; claimed outbox rows still count against grant and recipient limits. Holds consume no attempt. Final claim
reserves one paired outbox and email-attempt record in the same mutation. Provider failure does not refund SQ1's
logical request allowance. Ambiguous transport results and expired sending leases become `unknown`, never an
automatic replay. Historical settlement records the actual pair and attempt revision even after uninstall or lost
live consent. It cannot revive work or advance a stale step. This is not an exactly-once delivery guarantee.

Transition previews show current scoped sender, recipient and full text, or an explicit refusal. They create no
row or consent. A transition that changes its source cannot preview a frozen future delivery; Canon prepares the
actual saved source afterward. Both public outbox readers recheck current contact-field, sender and source access
before returning a mailbox message. Historical result recording does not require that current read access.

**Dispatch.** A per-minute cron and a wake after each write that queues a row claim due rows in a mutation (the gate
again), then send each in an action (`convex/outboundDispatch.ts`) and land it `sent`, `failed` or `unknown`. Every notice in a
digest passes the gate separately and reserves its rate allowance before the next notice is checked.

- **Slack** goes through the mapped incoming webhook. Slack takes no idempotency key, so a timeout lands `unknown`
  and is never retried.
- **Webhooks** are a signed POST of `{ id, event, module, at, data }` with `Canon-Event-Id` (the row's id, which a
  receiver dedupes by) and `Canon-Signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<ms>.<body>")>`. The secret is shown
  once, when the endpoint is added. HTTPS only, and a name that resolves to a private address is refused on a
  deployment. A failure is tried 5 times, after 30 s, 2 min, 10 min and 30 min.
- **Email** comes from Canon's transactional sender, Postmark (`POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS`), as
  a notice. Without both, email is refused, not sent. Postmark refusals with HTTP 429 or 5xx are tried 5 times. A
  transport error, an unreadable response body, or an unconfirmed success response is `unknown` and is never retried. Canon's own features send workspace email the same way, outside any module, with
  `internal.outbound.sendWorkspaceEmail` (`{ orgId, to: { member } | { address }, subject, body, cause }`), or
  `queueWorkspaceEmail` in their own mutation.

**Local and CI.** Nothing sends for real off a deployment: the adapters (`convex/lib/outbound/adapters.ts`) decide it
themselves from the Convex site URL, so no caller can ask for a real send. Email goes nowhere, Slack and webhook posts
reach loopback receivers only, and every row lands `sent` with `providerId: "local"`.

**Pages.** `{ "c": "outbox", "from", "states"?, "actions"? }` lists the module's rows a reader sees, newest first:
every one (`"from": "module"`) or those a bound doc caused. A member sees the ones they caused and notices to them, a
manager their team's, an admin every one. `actions` offers `approve`, `cancel` and `sendNow` (a held row, the gate still
deciding) to the row's sender, their manager or an admin. A transition with a send asks first, and its dialog shows
each message rendered on the doc as the move would leave it. Settings > Outbound lists every row by module and state.
The app waits for `organizations.context.features.outbound` before querying these APIs, so existing Settings,
notifications and transition dialogs keep working while the backend deploy catches up.

## Fiscal year

A module reads the workspace's fiscal year (Settings: the month it starts) without
a grant: it is no record's data.

- In guards, `set` and effects: `{ "workspace": "fiscalYearStartMonth" }`, and
  `{ "fiscalYearStart": value, "as"? }`, the day the fiscal year holding a date or
  a time starts (a month guarded to start in this fiscal year:
  `{ "field": "start", "gte": { "fiscalYearStart": { "now": "date" } } }`).
- In read plans, the same two as arguments: deals closed since the fiscal year
  began, `{ "from": { "fiscalYearStart": { "read": "month", "field": "start" } } }`,
  or since the current one began, `{ "from": { "fiscalYearStart": { "now": "date" } } }`
  (last fiscal year with `"years": -1`).
- On a page, a `stepper` with `default: "thisFiscalYear"` starts on the fiscal year today is in, named by the year it
  ends in (FY2027 runs July 2026 to June 2027 with a July start), its buttons "FY2026" and "FY2028"; text formats a year
  that way with `|fy` ("No visits in {$query.year|fy}"); and a table's `each: { "fiscalMonths": { "query": "year" } }`
  column repeats once per month of that fiscal year, July first. A plain calendar year reads as itself.
- In code, `ctx.workspace.fiscalYearStartMonth` (a year to date that starts again
  in the first fiscal month).

## Modules Canon ships

`modules/examples/<slug>/` holds the modules Canon ships, each a `module.json`
and its `server.ts`. `node --experimental-strip-types
scripts/build-module-examples.ts` builds each one's bundle and
`modules/examples/_examples.generated.ts`, which Convex installs from with no
GitHub; Canon's module tests fail when either is stale. The Customization page
lists them under **Browse → Modules from Canon**: **Install** previews and installs one
in one click (an admin or manager), pinned to the hash of its files, as the
source `canon:<slug>`. When Canon ships a newer build, the row offers **Upgrade
to vX**, which opens the install screen on that source, with what the upgrade
does, as any upgrade (see "Upgrades").

The public repository holds Canon's open modules. Canon's private modules are not in it. See
[Module marketplace](modules-marketplace.md) for the split. The open modules are AI fields, Audiences, Customer
success, Deal rooms, Dialer, Forecast, ICPs, Monthly goals, Notetaker, Reports, Sequences, Win-loss and Work, each in
`modules/examples/<slug>/`. `examples/modules/stale-facts/` is a module built outside this directory, the way another
author builds one (see "Build a module from your own repository").

A module's own tests sit beside it, in `__tests__/` directories under its
folder; `tests/moduleExampleSuites.test.ts` runs them all in one process with the
root suite, which is what CI runs. A module installed from GitHub upgrades only
from GitHub: to move it to Canon's build of the same id, an admin turns it off,
uninstalls it (its data stays) and installs it from Modules from Canon, which keeps its
docs as an upgrade does.

**Audiences** (`modules/examples/audiences/`, `@canon/audiences`) is moving out of Canon's core. Version 0.4.0 adds reader-scoped People CSV, aggregate export history, an active
15-minute summary refresh and creation from an active ICP through `@canon/icps`'s `icps.v1`. Its legacy import keeps
audience keys and module edits while copying additions and history. Version 0.2.0 publishes `audiences.v1` with its people (see "Reading another module", "People queries") and shows how
many people each audience holds now. Version 0.1.0 lists a workspace's audiences (yours, the shared ones and, for admins
and managers, each rep's own), renames them and shares them; `convex/audienceImport.ts` copies Canon's own audiences
into it every 15 minutes wherever it is on, each under its old id.

**AI fields** (`modules/examples/ai-fields/`, `@canon/ai-fields`) lists hosted
research fields live. Version 0.2.0 adds direct human run, probe, stop,
auto-accept and refresh controls. Field details link to owner management in
Agents, Fact Review and recipe customization. Run pages show live counters and
progress, with refreshable samples, Jev distributions, traces and cited answers.
The run dialog supports common account filters and all, saved-view or selected-id
contact scopes. Canon independently validates the exact scope shape. Map filters
remain available through the platform operation. Definition dialogs, list
integrations, default installation and the built-in page cutover belong to later units.

**Sequences** (`modules/examples/sequences/`, building) is multi-step outreach sent from the rep's own linked Gmail,
LinkedIn and calls (decision 2026-10-18: no Canon-provisioned mailboxes in phase 1). Version 0.1.0 builds sequences:
named schedules, steps of seven kinds with day delays, A/B variants on email steps (at most 5, shares adding to 100),
settings for senders, pacing and stop rules, and "When each step goes out" for someone enrolled now (`timeline`, over
the pure engine in `engine.ts` and the kit's `sequences.ts`, whose step timing and A/B arms Canon also runs launched
sequences by). Version 0.2.0 adds people from an audience: Add people freezes it (`audiences.snapshot`)
as an enroll run, the `snap` job copies each page of 500 (`audiences.members`) and the `check` job marks who to skip
and why (no email or LinkedIn URL for the steps' channels, active in another sequence, enrolled before, a name field it
can't fill); Enroll them writes the enrollments page by page (`enroll` job), leaving out anyone active elsewhere by
then. Suppressed and LinkedIn-cadence contacts are skipped once Canon gives modules those reads. Version 0.3.0 runs
sequences whose steps a rep does (calls, tasks, LinkedIn tasks, manual emails): Launch (a person's, never an agent's)
starts the enrolled people (`launch` job), an enrollment's timed transitions (`start`, `wake` at `nextAt`) dirty the
`advance` job, which plans each person's next step with the engine and puts a task on its day, and Done or Skip on a
task moves the person on, or finishes them after the last step. Reps land on Tasks, their open tasks oldest first.
Launch refuses a sequence with an automatic email or LinkedIn step until Canon's outbox (SQ1) sends them. Version 0.4.0 puts a Sequences panel on Canon's person page (`contributes.personPage`): the person's
enrollments with Pause, Resume and Finish, and Add to a sequence (`enrollOne`, agent `propose`), which runs the same
checks as an audience's and refuses with the reason. Version 0.5.0 reports on what runs now: a sequence's Report tab
(`sequenceStats`: people by state and finish reason, tasks done, open and overdue, tasks by step), a Team page for
admins and managers (report builders over `enrollments` and `tasks` by rep and state) and an Export people CSV. The
send funnel and A/B figures follow Canon's outbox.

**Win-loss** (`modules/examples/win-loss/`, building) opens a review on every closed deal from the deal feed, or by a
backfill over a date range, with the outcome, amount, rep and segment it closed at. A rep confirms it with the reasons
from the workspace's taxonomy (Canon's 15 to start, an admin's to edit), each helped or hurt, primary or contributing;
a manager approves it, sends it back, or dismisses it; a draft the rep leaves goes to the manager on its date. Version
0.1.0 is that loop with reasons a person enters. Version 0.2.0 drafts each review with AI from the deal's calls,
meetings and notes (Draft with AI, and on its own when a deal closes, as its owner): reasons from the taxonomy, each
with quotes Canon found word for word, a summary and the competitor; and a job checks every quote again after any
edit, so a reason a person typed is marked verified only when its quote is in the record it names. Version 0.3.0
publishes each approved review to a copy every role reads (its deal by ref, so a reader who can't see the deal sees no
name), keeps each open deal's stage so a loss says where it was lost, and adds Trends: win rate and dollar win rate over
every closed deal in a date range, in all and by competitor, rep, team, segment and quarter (report reads, a small
sample under four deals marked), each reason's share of approved wins and losses, how many reviews are approved, and
lost deals by the last stage they reached. Version 0.4.0 adds competitors' pages and battlecards: win rate against each,
why we lose to them and what buyers said; battlecard sections an admin or manager edits; and card updates a job proposes
once three approved reviews against a competitor share a primary reason, carrying their quotes word for word, which a
person accepts into the card or declines with why. It also keeps the CRM's own loss reason, region and lead source on
each review (custom deal fields Setup names, read through `reads.deals: custom`) and groups Trends by region and source. Version 0.5.0 adds to Trends the median days from a deal's close to its
review's approval, reasons ranked by influence (how often times how strongly), win rate by deal type, a report builder
over approved reviews (and reviews, for admins and managers), and every quote of the range as CSV or Excel. Version
0.6.0 puts two panels on Canon's deal page (`contributes.dealPage`): the deal's review, with its status, outcome,
primary reason, the CRM's loss reason and competitor, Draft with AI and Fill in, and the battlecards, each opening its
competitor's card.

**Forecast** (`modules/examples/forecast/`) is the weekly forecast: each person's call for the fiscal quarter, rolled
up their manager chain (`hier`) beside Canon's own numbers from the deals closing in it, cumulative as Clari and
Salesforce count them (Closed won; Commit, won plus commit; Best case, Commit plus best case; Pipeline). The Team page
shows the caller and each direct report with their call, their reports' call after the caller's adjustments and
before (Adjust rollup and Team rollup), Canon's numbers, the target from Settings > Targets (`targets.forYear`) and
coverage, with Adjust (a reason, never by an agent), Reopen, Drill in and History. My forecast shows a rep's deals in
the quarter by category and submits their call, upside and note, freezing the numbers it rests on. A week's calls are
keyed by the week, so a new week starts at "Update required" with nothing to reset. Its engine (`engine.ts`) is
golden-tested against the plan's §12. Version 1.1.0 adds Inspect: the quarter's open deals with the last 7 days' changes
marked (`deals.changesBetween`: an amount down in red, a pushed close date with every date it held, a category move),
chips for At risk, Pushed, Amount down and Mine, and the open risks with Dismiss (a reason). A `risk` job keeps each
deal's flags (close date pushed twice, amount down 10%, category down, no activity in 14 days, overdue, fewer than two
contacts engaged, and no next step where it is read), each with evidence built from the values read, dirtied by a deal
watch and an activity watch; a dismissed flag reopens when its evidence moves on. Version 1.2.0 adds What moved (managers): between two dates
(a date range, the last 7 days to start), the quarter's amount at the start and the end with the steps between (new
and moved in, increased, decreased, slipped out, lost; won stays in), each deal's category move, and where Commit's and
Best case's deals went (won, upgraded, downgraded, unchanged, slipped, lost, and the deals that came in), read from
Canon's deal history (`deals.changesBetween`); and it reads deals' next step, so "No next step" flags. Version 1.3.0 closes a quarter (Settings, admins; never an agent):
each person's call at the accuracy week (the fourth week anyone called, by default) against what their part of the tree
won, in an Accuracy tab, and the quarter's final won; and puts a Forecast panel on Canon's deal page (the deal's
category, close date, next step and risks, with Dismiss, and Open in Forecast). An agent's Submit my call (`saveCall`, `agent: propose`) is a
draft: it waits on Patch plans as one plan, "Submit a call of $X (upside $Y) for the week of …: <note>", for the person
to approve; a person's own submits at once. Version 1.5.0 draws What moved as a waterfall: the amount at the start,
each step, and the amount at the end. Version 1.6.0 lists the people on a deal on its Insights (`deals.people`): each
with their title, role and when activity last named them, and how many of them activity has reached. It reads people's
names and titles.

## Install and enable

An admin or manager installs a module on the Customization page (**Browse → From
GitHub**) from `github:owner/repo[/path]@ref`, public or private through a
connected GitHub account, as a recipe installs. The preview shows the nav entry,
the collections and what agents may do. Install fetches `module.json` again at
the pinned commit and refuses one that changed since the preview. Installed
modules start off. Turning one on adds its nav entry and pages for the whole
workspace; turning it off hides them and keeps its data. Uninstalling refuses a
module that is on, and keeps its data for a reinstall. Agents can preview an
install; installing, turning on and off and uninstalling are a person's.

### Default modules

A module Canon ships with `"default": true` is installed and on in every workspace. New workspaces seed server-less
modules inline and schedule an action to store server bundles. The hourly `seed default modules` cron in
`convex/moduleDefaults.ts` reaches existing workspaces. It installs only when the workspace has neither a package
row nor an on or off row for the module. Until then, `modules.list` shows it as on.

The sweep also upgrades an installed default module from Canon when its build changes and its version is not older.
It uses the manual installer's upgrade plan. For Canon sources whose example is a Canon default, it automatically approves the plan's new reads and permissions.
It still refuses problems, version downgrades, and dropped collections that have docs. GitHub modules and other
non-default modules still require admin approval for new reads. Other upgrades wait for an admin in Customization.
The package's `autoUpgrade` receipt records the latest automatic upgrade's version, new reads, and time. Once that
version serves, Customization shows "Upgraded to vX; now also reads: ..." and `canon_module list` returns the receipt. A running upgrade is
left alone. A stopped upgrade can be replaced. Turning a module off stays off, and uninstalling stays uninstalled.
**Work** (`modules/examples/work/`) is the first default module.

### Shipped reports and dashboards

A manifest's `reports` maps stable template keys to `{ name, report, spec }`. `report` names a builder node ID;
`spec.object` names one of its sources. `dashboards` maps stable keys to `{ name, tiles: [{ report, wide }] }`, where
`report` names a shipped report key. Canon installs these shared once per workspace after imports finish. A
`recipeEnablements` receipt at `module.templates.reports` or `module.templates.dashboards` survives deletion,
upgrades and reinstalls. Existing rows with the same module and `builtIn` key are adopted without changes.
An adopted private row keeps its visibility. A deleted or private report is omitted from a new shared dashboard.

Reports 0.6.0 ships canon-base's seven reports and Revenue and Activity dashboards. The optional Enterprise and
Velocity recipe reports still install when their templates are enabled, now owned by Reports with module source
names. Canon's legacy installers remain for the RP6b cleanup after dev verification.

### Imports from Canon

A manifest's `imports` lists up to 10 unique dotted names, such as `"icps.legacy"`. Canon owns their code in
`MODULE_IMPORTS` in `convex/lib/modules/imports.ts`. Each entry names the one module allowed to take it, its
install-screen label, and a `batch(ctx, orgId, cursor)` query that returns docs and the next cursor. A null cursor
finishes the import. Canon refuses unknown imports and imports owned by another module at install or upgrade.
Module tracks own their entries. `audiences.legacy` belongs only to `@canon/audiences`: its bounded cursor
finishes the parent pass before additions and history. It preserves old audience IDs, imports all native aggregate
history in pages, then the latest member-grouped runs from at most 2,001 member rows, dropping a cut oldest group.
Native aggregates win duplicate target/time pairs. Parents whose owners cannot belong to the workspace are skipped;
sets are imported only under parents that were actually copied.

`reports.legacy` belongs only to `@canon/reports`. It adopts Canon saved reports and dashboards in place, in bounded
pages, keeping IDs, owners, sharing, tile order and template keys. A report's object becomes its `canon.<source>`
name, with its field names unchanged. An unmappable report stays untouched, and so does a dashboard with a tile on one. The completed import shows a refusal
count and up to five examples in Customization. Other reports and dashboards still migrate. Legacy recipe install
receipts, including deleted templates, become module receipts before shipped templates install.

An import starts when the first version naming it serves, on a manual or default install, or at upgrade cutover.
It runs even if the module is off. Scheduled internal mutations apply one batch at a time through the module's
system scope. Copied module docs pass the serving schema and reference checks. Canon-owned in-place adoptions validate against
their existing schemas and preserve their rows. Parent docs must exist before their children.
An existing key keeps its data. For a derived-key set only, `importSetKey(parentKey, derivedKey)` supplies a
deterministic parent-qualified import identity. The importer accepts only the declared derived key or this exact
qualified form; it still validates schema, workspace references and the existing parent. A matching legacy derived
key under that parent keeps its stored key and edits. Qualified imports never rekey an existing doc, change the
manifest key, or change normal ops: creates still derive their usual key and reject a supplied different key;
updates/deletes address the actual stored key, and key fields remain immutable. This exception does not make
ordinary create ops parent-scoped. Audiences declares no ordinary additions create op in this version.
Each package records the cursor, completion, or error under `imports`.
An upgrade that migrates docs pauses the import at its cursor. It resumes when the new version starts serving.

A failed batch rolls back its writes, records an error, and stops without retries. Customization shows the import's
state on the module row. Completed imports never run again on later sweeps, upgrades, or reinstalls.

While the core Audiences feature still runs, its existing copy sweep also pages additions and catches recent history
up. Parent fields retain their three-way fingerprints. Imported history has fingerprints too: only untouched imported
counts follow a legacy aggregate's later write batches; module-authored runs and edits survive. Histories contain
aggregate counts and destinations, never people or custom field values. The module's count binding refreshes every
15 minutes as the reader; no system summary count is stored. The legacy cron remains until the core cutover.

### Places in the nav

Canon's pages that aren't core each have a place in the nav (`NAV_SLOTS` in `modules/kernel/manifest.ts`): its
section, its position, the id workspace.nav hides it by, and its URL. `icps`, `audiences`, `my-work`, `review`,
`reports`, `linkedin`, `dialer`, `runs`, `agents`, `integrations`, `ai-fields` and `cli-pairing`.

- **`links`** shows Canon's own page in its place: the page, its data and its writes stay Canon's. Work links
  `["my-work", "review"]`; My work keeps its count of tasks due.
- **`nav.slot`** gives the module's own entry the place: it sits where the page sat, keeps the id (so a workspace
  that hid the page, or opens on it, still does), and the page's URL and every URL under it open the module's landing
  page with the query kept (`src/app/dashboard/[...moved]`). That holds once Canon's own page is deleted; while it
  still serves, it keeps the place and the module's entry doesn't show (Canon's page links into the module meanwhile, as
  Reports' "New report" opens `@canon/reports`' builder). Reports 0.6.0 removes Canon's nav entry and explicitly
  redirects its still-existing pages while the module is on. `/dashboard/reports` opens the builder, `?report=` opens
  that saved report, `?view=stages` opens Stage history, and `?view=targets` opens Settings → Targets.
  `/dashboard/dashboards?d=` opens that dashboard; the bare URL and nav open Pacing. Queries survive the redirect.
  When Reports is off or uninstalled, the old pages render Canon's components over the adopted rows, with legacy
  object names at the read boundary. New saves retain Reports ownership for a later reinstall. A refused report
  remains reachable at its old URL. `nav.section` must be the place's section.
- Entries without a place go after the placed ones in their section. A section that only modules fill shows where the
  sections' order puts it. A module whose only entries are links has no `nav` and no pages.

```json
"nav": { "label": "LinkedIn", "icon": "linkedin", "section": "Activity", "landing": "inbox", "slot": "linkedin" }
```

On a local stack, serve a fixture with `scripts/recipe-github-fixture.ts` and
install from it:

```sh
node --experimental-strip-types scripts/recipe-github-fixture.ts --repo canon-fixtures/modules --tags <dir> --port 4831
convex run modules:installFromLocalBase '{"base": "http://127.0.0.1:4831", "source": "github:canon-fixtures/modules/visit-log@v1.0.0"}'
```

`<dir>/v1.0.0/visit-log/module.json` is the module at tag `v1.0.0`. Run
`convex run` against your own development backend. `installFromLocalBase` refuses unless the backend sets
`FSGTM_ENABLE_DEMO_DATA=true`, and a self-hosted Canon (`CANON_AUTH=local`) refuses it. A module
installed this way upgrades the same way, with `installFromLocalBase` at a
newer tag (`"approveReads": true` when it reads more, `"drop": [...]` when it
removes collections with docs): the Customization page's Upgrade button opens the
GitHub install screen, which can't reach a local fixture.

## Upgrades

Installing a newer version of an installed module, from the same repo, upgrades
it in place. Its data stays. A new commit of the same version upgrades too, so
a branch can be installed at each push; an older version is refused.

- Each installed version records its **epoch** and its **slot map**: which of
  `moduleDocs`' 8 index slots each index uses. An index that keeps its name and
  fields keeps its slot; a new or changed one takes a slot the installed
  version doesn't use. A collection's key and `setOf` can't change. Its owner
  field can only be added where it had none: that narrows access, every doc is
  rewritten to store it, and docs without one belong to no member, so only
  roles with `all` access see them. The module's data is read only during an
  owner backfill, until the new version serves. Changing or removing an owner
  field is refused.
- When a slot or a collection's schema changes, the new version waits while a
  **backfill** (scheduled mutations of 200 docs each, resumable from the last
  key) fills the new slots and checks every doc against the new schema. The
  installed version serves meanwhile. Unless the upgrade adds an owner, every
  write also fills the new slots and must fit the new schema. The new version
  serves once the backfill is done. A doc that doesn't fit stops it with the
  reason; an admin cancels it on the Customization page and the installed version
  keeps serving.
- A version that leaves out a collection with docs needs the admin to confirm
  that its docs go (`drop` on install); the backfill deletes them.
- Canon fields the new version reads that the installed one didn't need
  approving (`approveReads`): the install screen lists them under the upgrade.
- A proposal made under an earlier epoch doesn't apply: it was checked against
  another version.

A version's **`upgrade`** (`{ "job", "key"? }`) names a job Canon dirties once, in
the transaction where that version starts serving over an earlier one (a version
with no backfill, at once; one with a backfill or a migration, when it is done): the
backfill a new version needs, which reads other docs a migration can't, run once
instead of on a schedule. `key` gives one value or `"*"` per part of the job's key,
every part `"*"` when left out. A first install dirties nothing. Win-loss
(`modules/examples/win-loss/`) publishes the reviews approved before 0.3.0 this way (`publishAll`).

The Customization page shows an **Upgrade** button on each installed module, which
opens the install screen on its source; the preview says what the upgrade does
and the button reads "Upgrade to vX". While a backfill runs the module's row
shows its progress, and `canon_module list` returns it as `upgrade`.

## Upgrades and migrations

A version that changes the shape of stored docs declares how each doc moves to
it. Per collection, a list of `{ from, call }`: the first entry whose `from`
range holds the installed version runs. `from` is comparators joined by spaces,
all of which the version meets: `<1.3.0`, `>=1.0.0 <1.3.0` or `1.2.0`. `call`
names a function in the server bundle's `calls` that isn't a declared call, so
only Canon runs it.

```json
"migrations": { "visits": [{ "from": "<1.3.0", "call": "migrateVisits" }] }
```

```ts
import { migration } from "../../kernel/calls.ts";
export const calls = {
  migrateVisits: migration((doc, ctx) => {
    const { followUp, ...rest } = doc.data;
    return { data: followUp ? { ...rest, followUpOn: followUp.on } : rest };
  }),
};
```

- **The function is pure and per doc.** It gets `{ key, parentKey, data }` in
  the installed shape and `{ collection, from, to, now }`, and returns
  `{ data }` (the doc in the new shape), or `{ drop: true }`. Either may carry
  `patches`: `[{ collection, key, set?, append?, unset? }]` to other docs of the
  module, laid over their new shape (`append` adds items to a list field). That
  is how a collection folds into another: the new version leaves it out, and
  its migration drops each doc and appends it to the doc it belongs on. A
  migrated collection the new version leaves out needs no drop consent. A patch
  may name only a doc already in the new shape: one in a collection that
  migrated before (the new version's collections migrate in order, removed ones
  last), or one whose collection doesn't migrate.
- **Canon runs it as the system**, in the recipe runtime, in the workspace's
  system isolate, 100 docs a batch, wrapped by `migration()` (which returns one
  result per doc, and a doc whose function throws as its error). Each result is
  checked against the new version's schema. A batch applies all or none, once:
  its place is saved with it.
- **The installed version serves until the new one does.** Migrated docs wait
  in `next` beside their data, marked with the upgrade's epoch, and the module's
  writes (ops, transitions, calls that write, jobs, timed transitions and
  schedules) wait with a "read only until the upgrade is done" refusal, so
  nothing changes under the migration. Reads, views and calls that only read go
  on as before.
- **Cutover.** When every doc has migrated, Canon swaps them in, in batches: new
  data, owner and slots, and a new version per doc; dropped docs go. For those
  seconds the module's pages say it is finishing its upgrade, and nothing runs
  in it. Then the new version serves and its jobs pick up the keys that waited.
- **A doc that fails stops the upgrade, named:** "visits mvc… failed its
  migration (migrateVisits): …", or the doc and its schema errors. The installed
  version keeps serving and its writes open again. Ship a fixed version (a new
  commit of the same version will do) and upgrade to it: it replaces the stopped
  upgrade and migrates from the start, under a new epoch. **Cancel upgrade**
  keeps the installed version; it can't cancel a cutover.
- A migration doesn't touch a doc's seal: a doc sealed before (see "Integrity")
  whose sealed fields it changes reads "changed since it was sealed".

## Facts

Canon keeps every value it learns about a deal, company or person as a fact in its ledger: what it says, where it came
from, its evidence, and whether a person accepted it. Each field resolves to one winning value. A module reads that
ledger with `facts.forRecords`, after declaring which attributes it reads:

```json
"facts": { "companies": { "read": ["industry", "custom.tier"] }, "deals": { "read": ["stage"] } },
"calls": { "tiers": { "reads": { "facts": { "canon": "facts.forRecords",
  "args": { "object": "companies", "ids": { "arg": "ids" }, "receipts": 3 } } } } }
```

- **The grant.** `facts.<object>.read` names at most 20 attributes per object: a standard one (the table below) or a
  workspace's own, `custom.<slug>` (companies and people). The manifest check refuses a name that isn't a standard
  attribute of its object, naming both. A `custom.<slug>` is the workspace's, so it is checked when read: one the
  workspace has no field for reads as `unknown`. The install screen lists them as facts "with their sources and
  evidence", and an upgrade that reads a new one needs approving, as a new read does.
- **The read.** `object` is `deals`, `companies` or `people`; `ids` are their ids as other reads return them (a deal's
  id, a company's or person's record id), at most 100. `attributes` narrows to some of the declared ones; without it,
  every declared one. `receipts` (0 by default, at most 20) adds each field's newest facts. An attribute the module
  doesn't declare, a structured field (a deal's `splits`), more ids or more receipts refuses the call: nothing is left
  out quietly.
- **What it returns.** A row per record: `{ id, fields, receipts? }`. Each field is `{ attribute, value, state, winner,
  contestedBy?, confirmedAt? }`: `state` is `resolved`, `contested`, `empty` (no value yet) or `unknown` (a
  `custom.<slug>` the workspace has no field for); `winner` is the winning fact's id;
  `contestedBy` the facts that disagree with it; `confirmedAt` when the winning fact was last confirmed (ms). `receipts`
  holds each field's facts, newest first: `{ id, value, status, source: { kind, actor }, evidence, confidence,
  observedAt, validFrom, lastConfirmedAt, validTo, decidedAt }`. `source.kind` is a label (`salesforce`,
  `enrichment`, `user`), not a closed list; `actor` is `user:<member id>`, `agent:<agent id>` or `integration:<id>`.
- **Visibility.** It reads as the caller, in the call's action: a record they can't see has no row, and a field their
  role hides has no field, as on the record's own receipts. A company or person they see that the ledger holds nothing
  for yet (never synced from a CRM or edited) has a row with every field `empty`, so a module can propose its first
  value. A missing row means the caller can't see the record, or there is none: a module can't tell which. A system
  call (a job, a watch, a schedule) can't read facts.
- **A fact a module proposed** carries `source.module`, the module's id, and `proposal`, the id of the proposal it
  came in (see "Proposing facts"). Other facts have neither.

The standard attributes, and what each value is. Money is an integer in minor units (cents for USD), a date is
`YYYY-MM-DD`, a choice is one option's key, and a user is a member's id (`ownerId`) or the CRM's user id
(`crmOwnerId`). A deal's `splitAllocations` holds several values: `facts.forRecords` refuses it (read `deals.byIds`)
and a proposal of it is `unknown_attribute`. A test checks this table against the kernel's `FACT_ATTRIBUTES`
(modules/kernel/facts.ts).

| Object | Standard attributes |
| --- | --- |
| `deals` | `name` text, `amount` money, `currency` text, `closeDate` date, `stage` choice, `forecastCategory` choice, `probability` number, `isClosed` boolean, `isWon` boolean, `crmOwnerId` user, `dealType` choice, `nextStep` text, `splitAllocations` splits |
| `companies` | `name` text, `domain` text, `industry` text, `employees` number, `annualRevenue` money, `country` text, `linkedinUrl` text, `ownerId` user |
| `people` | `fullName` text, `title` text, `email` text, `phone` text, `linkedinUrl` text, `ownerId` user |

### Proposing facts

A module proposes facts to the ledger, each with the text that supports it. A member with `facts.review` accepts or
rejects each one on the fact review queue, where every agent's proposed facts wait. No auto-accept rule and no standing
grant accepts a module's fact, whatever it covers.

```json
"facts": { "companies": { "read": ["industry"], "propose": ["industry", "employees"] } },
"reads": { "proposals": ["status", "pending", "applied", "skipped", "rejected"] }
```

```js
return { intents: [{ op: "propose", operation: "facts.propose", reason: "From the 10-K", stamp: { collection: "checks", key, field: "proposal" },
  args: { object: "companies", facts: [{ id: company, attribute: "employees", value: 120, evidence: "Our 10-K: 120 employees", confidence: 0.8 }] } }] };
```

- **The grant.** `facts.<object>.propose` names at most 20 attributes, as `read` does. The install screen lists them
  under "What it may propose to change", apart from what it reads, and an upgrade that proposes a new one needs
  approving.
- **The intent.** `args` is `{ object, facts }`: `object` is `deals`, `companies` or `people`; each fact is
  `{ id, attribute, value, evidence, confidence?, validFrom? }`, with `id` the record's id as reads return it, `value`
  text, a number, true, false or null, `evidence` 1 to 4,000 characters, `confidence` 0 to 1 (0.5 when absent) and
  `validFrom` when the value became true (ms). At most 100 facts per intent, and 5 proposals per call. An attribute the
  module doesn't declare, a missing or empty evidence, or more facts refuses the call.
- **Who it's from.** The facts are the member's who ran the call, from the module: the review queue shows them as that
  member "via module:<id>", and Canon derives the source (`agent_run`, `module:<id>`) itself. The source's field
  ownership applies as to any agent: a module can't propose a deal's amount or stage, or a company's name, domain or
  owner, unless the workspace's ownership settings allow it. A system call (a job, a watch, a schedule) can't propose
  facts.
- **Visibility.** A fact about a record the member can't see is refused as `unknown_record`, as one that doesn't
  exist, so a proposal never tells a module whether a record exists. An id of one object (a company's) given as
  another (a deal) names no record. A company or person the member sees that isn't in the ledger yet goes on it first,
  as `canonEntities.promote` puts it there: its identity and a stream that starts from the record as it is, when the
  member's role may edit companies (or people). At most 50 of each per proposal; past that, and for a role that
  can't edit them, they read as `unknown_record`. Hosted MCP's `canon_propose_facts` and the CLI do the same.
- **Attributes.** A `custom.<slug>` the workspace has no field for is `unknown_attribute`: a module's proposal never
  adds a field.
- **Reading the outcome.** Each intent is one proposal. `stamp` writes its id into a text field of a doc the call
  writes, as for record proposals, so a `put` of that doc goes before the `propose` in the call's intents: a stamp on
  a doc that doesn't exist yet refuses the call, saying so. `outcome` and `optional` aren't taken yet. The call's
  response lists each one in `factProposals`, `{ id, rejected, unchanged }` as below, so whoever ran it sees at once
  which facts weren't stored. `proposals.byIds` returns it later with
  `operation: "facts.propose"`, its `status` (`pending_approval`, then `applied` once every fact is decided and one
  was accepted, or `rejected`; a proposal that stored no fact reads `rejected` at once), `total` (the facts it named), `pending`, `applied` (accepted), `skipped` (rejected by
  a person), `unchanged` (already proposed with the same value and evidence) and `rejected`: the facts the ledger
  didn't store, `{ index, reason }`, `reason` being `unknown_record`, `unknown_attribute`, `field_locked` (the member's
  role can't edit the field), `not_owned` (the source doesn't own it) or `invalid_value`. `facts.forRecords` with
  `receipts` then shows each fact's status, and the field's value once one is accepted and wins.
- **A worked example.** `examples/modules/stale-facts/` reads `facts.forRecords`, proposes a corrected value with its
  evidence through `facts.propose`, and shows each proposal's outcome from `proposals.byIds`.

### Preview reads

A read marked **preview** in `CANON_READS` (`stability: "preview"`, with the date it shipped in `since`) works and is
supported, but its arguments and rows may still change before it is marked stable. A change to a preview read ships
with a note here; a stable read changes only by adding. `facts.forRecords` is preview since 2026-11-09, and
`companies.updatedSince` and `people.updatedSince` since 2026-11-10. A proposal
operation is marked the same way in `PROPOSAL_OPERATIONS`: `facts.propose` is preview since 2026-11-09.

## Writes to Canon records

A module never writes Canon's own records. It **proposes** a write, and a person decides it on the **Patch plans**
page, as any agent's proposal waits there, or an admin's standing grant decides it in advance (see "Standing grants"). This is the trust boundary between a module's code and the workspace's
records (shared gap P10).

```json
"proposes": ["accounts.reassign"],
"reads": { "proposals": ["status", "total", "applied", "skipped", "pending", "skippedRows", "decidedAt"] }
```

- **`proposes`** lists operations from a registry Canon owns (`modules/kernel/proposals.ts`). The install screen lists
  them under "What it may propose to change", and an upgrade that adds one needs approving, as a new read does.
  Today: `accounts.reassign` (`{ from, to }`, members' ids): move every company `from` owns to `to`; and
  `accounts.assignTerritories` (`{ territories: [{ key, parent?, order?, query, owner? }], named?: [{ territory, company }],
  scope: "all" | "unowned" }`): give each company the owner of the nearest territory on its path that has one (see
  "Territories"), every company or only unowned ones. A line that doesn't read refuses the proposal, and so does a
  tree that would move more than 1,000 companies at once, unless `limit` (1 to 1,000) asks for only the first that many. And `targets.set` (`{ year, total, months? }`, minor units,
  12 month weights): a fiscal year's company target on Canon's Targets, which Reports pacing reads. Its one row holds
  the year's total and version then; apply re-reads the plan (CAS) and saves through Canon's own `targets.set` as the
  approver (their `targets.set` capability), keeping the plan's coverage, team and rep choices.
- **`meetings.log`** takes `{ deal, title, startAt, ownerId, endAt?, notes?, location? }`. `deal` is a module
  `deals._id`, not a ledger stream ID. Times are integer epoch milliseconds in years 1 to 9999, and `endAt` cannot
  precede `startAt`. The title is required, up to 1,000 characters. Notes and location are each up to 4,000 characters.
  The owner must be an active workspace member. A person confirms these values and proposes the meeting for approval.
  It is not grantable, and background or agent calls cannot propose it. It does not infer attendance or a completed
  meeting outcome from a planned visit.
- **A call proposes** with an intent: `{ "op": "propose", "operation", "args", "reason", "stamp"?, "outcome"? }`, at
  most 5 a call. In the call's action Canon lists the records the write would change **as the caller reads them**,
  each with its value and version (its `updatedAt`) then, at most 1,000 (more refuses the call: propose in parts).
  The call's mutation holds them as one patch plan, `do module.records`, `approvalRequirement: required`, one
  operation row per record: its name, the value before with its version, and the value after. Its reason ends with a
  whole summary by move ("2 companies: 2 from Ria to Rex"). Nothing is written to the records, whoever ran the call.
  A proposal is a person's: Canon's own calls (jobs, schedules) make one only under a standing grant (below), and a
  proposal that names no record refuses.
- **`stamp`** (`{ collection, key, field }`) writes the plan's id into a text field of a doc the call writes, in the
  same transaction, so the module finds its proposal again. **`optional: true`**: when nothing would change, there's no
  plan and no refusal; the stamp reads `"none"` and the outcome job is dirtied anyway, so the module says so. **`outcome`** (`{ job, key }`) names a key of one of the
  module's jobs, which Canon dirties when the plan is applied, fails, or is rejected.
  `examples/modules/stale-facts/` is a worked example. Its `propose` call writes a `corrections` doc, then proposes
  `facts.propose` stamped on that doc's `proposal` field. The doc's write must come before the `propose` intent. Its
  `outcomes` call reads the stamped ids back with `proposals.byIds`.
  A meeting proposal requires a writable stable document stamp and cannot be optional. A repeat call with the same
  stamp and canonical meeting arguments returns the existing plan, including a rejected, canceled, failed or applied
  plan. A different payload or an unrelated plan ID refuses the call. This replay scope is the module's document,
  operation and request. It is not an anonymous intake nonce contract.
- **Deciding it.** A member who may approve patch plans approves (all rows or some) and applies it; an agent can't
  decide one. Apply writes each approved row **as the person applying it**, through the records edit path (their
  role, the record and the field's rules, a receipt and a history line under their name; CRM write-back follows the
  edit rules). A row is written only while the record still holds the version and value the proposal read: one
  changed since, or already set, or that the applier can't see, is **skipped and named** ("Brightline Robotics:
  changed since it was proposed"), never overwritten. A row the edit refuses fails, and fails the plan.
- **Reading the outcome.** `{ "canon": "proposals.byIds", "args": { "ids": { "read": "doc", "field": "proposal" } } }`
  returns the module's own proposals (another module's read as missing) with their plan `status`, `total`, `applied`,
  `skipped`, `failed`, `pending`, `decidedAt` and `skippedRows` (at most 100, `{ id, name, why }`; empty for a reader
  who doesn't see every company).
  Declaring `reads.proposals: ["created"]` also returns bounded canonical creation outcomes as
  `created: [{ operation: "meetings.log", object: "meeting", streamId }]`. Other proposals return an empty list.
  Meeting proposals require current deal visibility, and a meeting ID is returned only when the current reader can
  see that meeting. Background outcome jobs read within their module's workspace scope. Internal receipt data is not
  exposed. Apply revalidates the live deal, active owner and authenticated applier's meeting create and field
  permissions. The stored approved row supplies the meeting values. Creation, its deal activity edge and its receipt
  commit together. Replaying the operation returns the same canonical stream ID.

### Standing grants

An admin may let a module make one kind of proposal without a person deciding each one: the standing grant of shared
gap P10, as an agent's grant works. Only an operation the registry marks
grantable can be granted, and only for rows that fill an empty field: today `accounts.assignTerritories`, for companies
with no owner. Changing an owner someone holds always waits for a person.

- **Giving one.** On the Customization page each installed module lists its grantable proposals. An admin chooses "Allow
  without asking", for 90 days (1 to 90; an optional cap of records a day). The grant is signed (HMAC-SHA256 over
  its exact terms, with a key derived from `TOKEN_ENCRYPTION_KEY`), and revoked there too. Agents can't give or
  revoke one (`src/lib/gtm-human-only-mutations.ts`).
- **Live** means the signature verifies, it hasn't expired or been revoked, the module is on and still lists the
  operation in `proposes`, and the admin who gave it is still an admin of the workspace.
- **Using it.** A grant covers Canon's own calls (jobs, schedules), which list the records as the grant's admin reads
  them. A proposal a live grant covers whole (every row fills an empty field, within the day's cap) is held as usual
  and approved as that admin in the same transaction: the use records the plan's hash and a digest binding it to the
  grant's signature. One that doesn't fit is never partly granted: without a grant that covers it, an `optional`
  proposal makes nothing and any other refuses. A person's or an agent's proposal always waits for a person. The
  owners a grant gives come from the module's own data (its territories), so whoever may edit that data
  steers it.
- **Applying it.** Canon applies the plan right after, as the grant's admin, through the same path as a person's apply:
  each row written while the record holds the version the proposal read. It first checks the grant again and the
  digest against the plan's rows, in the transaction that claims it. Until then Patch plans can't decide or apply the
  plan; revoking the grant sends it back there for a person, as does recovering an apply that never finished. Every
  grant, use and apply is in the audit log.

A daily schedule that proposes `accounts.assignTerritories` with `scope: "unowned"`, a daily cap and `optional` is the
case a grant is for. With the grant, new companies get their territory's owner the next morning. Without it, nothing is
proposed.

## Reading another module

A module publishes what other modules may read of it, and reads theirs, as **versioned interfaces** (shared gap P9).
In the open modules, Audiences publishes `audiences.v1` and ICPs publish `icps.v1`; Audiences reads `icps.v1`, and
Dialer reads Sequences' `callTasks.v1`. The shape, for a module that publishes monthly tallies and one that reads them:

```json
"provides": { "tallies.v1": { "view": "tallies.forMonths", "fields": ["month", "rep", "won", "amount"] } }
```

```json
"uses": { "@acme/visits": ["tallies.v1"] },
"calls": { "progress": { "reads": {
  "tallies": { "module": "@acme/visits", "provide": "tallies.v1", "args": { "months": { "read": "goals", "field": "month" } }, "limit": 5000 }
} } }
```

- **`provides`** names an interface, `<word>.v<n>`, with the view that serves it (its arguments are the interface's)
  and the fields it hands over. A doc comes with its `key`, `version`, `owner`, `parentKey` and times, and only
  those fields. An interface's **structural contract is frozen**. An upgrade cannot drop it or change its published
  field set, field validators, top-level required or optional presence, view arguments, list or one shape, or backing
  collection. Keeping the collection preserves returned keys' collection identity. Keep `tallies.v1` unchanged and
  publish a breaking contract as `tallies.v2` beside it. Unpublished fields and top-level labels, help, and presentation
  may change. This check does not freeze access policies, row selection, calculations, or business meaning. Authors
  must use a new interface version for semantic changes that would break readers, even when the shape stays the same.
- **`uses`** names, per module id, the interfaces this module reads. The install screen lists them under "What it
  reads of other modules" (and a provider's under "What other modules may read of it"); an upgrade that uses a new
  one needs approving, as a new read does.
- **A read plan entry** `{ "module", "provide", "args"?, "limit"? }` reads it in the call's one query, **as the
  caller, through the provider's own scope**: the same principal (a person's access and role, in "view as" the
  member's; Canon for a job), so the provider's read scopes hold. A rep reading another module's tallies sees only the
  months a rep may see there. Arguments are the call's values, as any read's; a list argument
  takes `{ "arg" }` or `{ "read" }`. A read past `limit` refuses the call, as any list read does.
- **When it can't be read**, the read is `{ "missing": "not_installed" | "off" | "not_provided" }`, never an empty
  list, so the module says why: "Visits is turned off, so its tallies can't be read."

**ICPs** publish `icps.v1` (`name`, `description`, `spec`, `query`, `active`, `isDefault`, `source`, `pointOfView`,
`offer`) and `icpNodes.v1` (`icp`, `parent`, `kind`, `name`, `query`, `role`, `pointOfView`, `offer`) as
`@canon/icps`. A doc's key is the id fit, `icpIds` and audience filters already hold. Until ICPs move into that
module, Canon serves both from its own tables, installed or not, to every member.

The provider needn't be installed when the reader is, and either can be upgraded alone. Watching another module's
interface for changes is not yet here (see "Not yet").

**People queries.** An interface may say which people each of its docs names, so another module (or the
providing module itself) can work them without rebuilding the query:

```json
"provides": { "audiences.v1": { "view": "audiences.visible", "fields": ["name", "owner", "shared", "filter"],
  "people": { "filter": "filter", "added": { "set": "additions", "field": "person" } } } }
```

`filter` names the doc's field holding a People list filter; `added` a set under the doc whose field holds people added
one at a time. A call reads `people.snapshot` with `{ "module": "@canon/audiences", "provide": "audiences.v1", "key": ... }`
(no `module` for the module's own interface; `module` and `provide` are written as text). Canon reads the doc as the
caller through the providing module's scope, refusing one they can't read, lists the filter's people as the caller sees
them, adds the set's people they see, each once, and stores the ids as a snapshot: `{ id, createdAt, source, count,
withEmail, pages }`. A job then reads `people.snapshotPage` by `{ snapshot, page }`, 500 people a page, as with
`audiences.members`. `people.count` takes the same arguments and returns `{ source, count, withEmail }` without storing
anything, for a page that shows how many people a doc names. Past 25,000 people both refuse. Audiences 0.2.0 publishes
`audiences.v1` this way and counts each audience's people on its page.

**Monthly goals** (`modules/examples/monthly-goals/`) reads Canon's deals, not another module: a won-deal goal per rep
and month against the deals that rep won that month (`deals.closedBetween` over the last 400 days, as the reader sees
them), with won revenue formatted as money. A month before that window or after this one shows "Not counted",
separately from a counted zero. A call result drawn as a table reads its value in its texts (`{$result.message}`), as
figures do.

## ICP trees

An `icpTree` read counts overlapping ICP sets from earlier own-doc list reads:

```json
"definitions": { "view": "icps.all", "limit": 25 },
"nodes": { "view": "nodes.all", "limit": 75 },
"counts": { "icpTree": { "icps": "definitions", "nodes": "nodes" } }
```

The collections must have the typed spec, query and relationship fields in `modules/kernel/icpTree.ts`.
The read needs `reads.companies` and `reads.people` with `title`. Canon compiles each ICP's spec and each
segment or persona's query line, then asks the record service for counts as the caller sees companies and people.
Hidden criteria fields refuse the read. Invalid queries or parent graphs refuse visibly. The value contains
`nodes: [{ key, accounts, people }]` and sibling `overlaps: [{ a, b, accounts }]`; siblings retain their shared
companies. Explicit system calls count the workspace, so do not save their totals on member-readable docs.

`icpTree.market: true` also needs `reads.market: ["facets"]`. The frozen read projection carries each root's
market dimensions from its own validated spec. After scoped counting succeeds, Canon reads those estimates through
the existing shared market cache, using the same `icpMarketFilter` and `sizeBand` grouping as core. The root's
`market` is a number or `null` when its market dimensions are unsupported, empty or unavailable. Market is the
provider-searchable part of the root spec, not its full gated membership. Segments and personas receive no market
estimate. The organization, user and grant checks still guard the entire read; hidden criteria refuse it in full.

`@canon/icps` 0.2.0 is the read-only map and focus example. Its docs retain legacy keys; installing it does not copy or take
ownership of Canon's definitions. Page text can use `{$objects.account.pluralLabel}` or another native or custom
object's `label` or `pluralLabel` to follow workspace names. `objects` is reserved as a page binding name.

## Territories

A module that carves the market counts a **territory tree** over the workspace's companies: its own
docs as the nodes, each a query line in the grammar ICPs use (`size:1001-5000,5001-10000,10001+ country:us,ca`,
`-country:us,ca`, `industry:`; `modules/kernel/icpQuery.ts`).

```json
"reads": { "companies": ["name", "ownerId", "country", "employees", "industry"], "deals": ["amount", "isClosed", "isWon", "closedAt", "companyId"] },
"calls": { "territoryCounts": { "reads": {
  "territories": { "view": "territories.forScenario", "args": { "scenario": { "arg": "scenario" } }, "limit": 1000 },
  "named": { "view": "named.forScenario", "args": { "scenario": { "arg": "scenario" } } },
  "tree": { "tree": { "nodes": "territories", "query": "query", "parent": "parent", "order": "order",
    "named": { "read": "named", "node": "territory", "company": "company" }, "owners": true, "deals": true } }
} } }
```

- **Precedence.** Each company walks down from the top. At each level it goes to the first sibling, lowest `order`
  first, whose line it passes, and stops where none does. A company **named** to a node goes there, and to every node
  above it, whatever the lines say. Siblings never share a company in the answer.
- **The value** (`TreeReadValue`, modules/kernel/calls.ts) gives, per node by its doc's key: the companies under it,
  those in an ICP, and, with `owners`, how many each owner holds (what a carve would move). With `deals` it also gives
  the open pipeline and the last 365 days' bookings of the deals at its companies. A deal synced from a CRM that no
  person linked to a company counts at its CRM account's company, matched by domain. The value also carries sibling
  overlaps by their lines alone (before precedence gives each company to the first), the companies in no top-level
  node, the nodes whose line didn't read (`errors`: they count nothing), and with `cells: { node, by }` one node's
  companies by up to two of country, region, size band and industry, each cell with its owners (what a carve
  partitions). With `place` (a company id from the call), it answers `placed`: the territory that company lands in,
  or null, and whether by a name.
- **Market.** `market: true` needs `"reads": { "market": ["facets"] }`. Each node gets `market`, the number of
  companies in the shared market index matching its own line and every ancestor's line. Named companies and sibling
  precedence do not change it. Include-only industry, size, country and region keys are supported. A disjoint path
  returns 0. An unsupported line anywhere on the path or an unavailable index returns null. Distinct filters reuse
  the shared cache. Market counts hold no workspace data.
- **As the caller sees companies.** The record service counts (`POST /v1/workspaces/{ws}/territory-tree/counts`,
  contract 1.37.0, `services/record-service/src/territoryTree.ts`; the fake client runs the same function) only the
  companies the caller's role sees, by fields it shows: a line on a field their role hides refuses, and so do owners
  for a role that can't see the owner. Deals are the ones the caller sees, at most 8,000 looked through. Canon's own
  calls (a job, a watch, a schedule) count every company. Nothing is stored; a page reads it when it opens, and
  Refresh reads it again. Don't save a system call's counts on docs people read: they'd show totals the
  reader's role hides.
- The read needs `reads.companies` (with `ownerId` for owners or cells) and, for deals, `reads.deals` with `amount`,
  `isClosed`, `isWon`, `closedAt` and `companyId`.

**Owner moves.** The record service also answers the moves a tree implies (`moves: { owners, scope, limit }`,
contract 1.39.0): each company whose owner isn't its territory's, listed with its name, owners and version, and counted
whole by from and to. A module proposes them with `accounts.assignTerritories`; Canon expands the proposal through the
same count, as the caller sees companies, and the approver applies it row by row, CAS on each company's owner (see
"Writes to Canon records").


## System

A transition, op or call with `"system": true` and empty `roles` runs only as
Canon, never as a person or their agent: the auto-approve and supersede steps a
job takes. Canon reads every doc, and the history shows the actor as
**System**. Jobs, watches, schedules, timed transitions and bulk moves run
them (see "Jobs, watches and schedules"); the internal functions
`modules.systemTransition`, `systemOp` and `systemCall` (`{ orgId, module, ... }`)
run one directly, reachable only from Canon's own code or `convex run` on a
local stack. A system call runs in the isolate `<orgId>:system`, with `ctx.caller`
`{ userId: "system", role: "system" }`.

## Agents

`canon_module` (`src/app/mcp/_canonModuleTools.ts`) has `list`, `describe`,
`view`, `op`, `transition`, `call`, `export`, `verify`, `bulk_status`,
`retry_bulk`, `pacing_context`, `pacing`, `report`, `retry_reports`, `saved_reports`, `dashboards`, `save_dashboard`, `remove_dashboard`, `pin_report`, `notifications`, `mark_read`, `export_file`, `pdf`, `file` and `preview_install`. They call the same
`api.modules` functions a module page calls, as the agent's person, so read
scopes, roles and agent modes apply unchanged. `describe` lists each machine's
transitions with their states, roles, guards and agent mode. The dashboard
reads and writes module data only through `api.modules.page`, `view`, `op`,
`transition` and `call`.

**Proposals.** An agent's op or transition whose mode is `propose` checks
everything a person's would (the role, the doc, the version, the args, the
state and guards) and writes nothing. It returns `{ proposed: <patch plan id> }`:
a patch plan with one operation, pending approval, on the **Patch plans** page
(`/dashboard/patch-plans`), and a "proposed" row on the doc's timeline that
links to it. A member who may approve patch plans approves and applies it
there; an agent can't decide a module proposal, its own or another's. Applying runs the op or transition again as that member, in one
transaction, with every check but the agent mode: their role, the guards and
the version the agent read. A proposal whose doc changed since fails. Its event
row names the proposal.

**Proposed calls.** A call whose `agent` is `propose` runs for an agent as it runs for a person, through its read plan
and its code, and then writes nothing: Canon applies its intents in a dry run (every check its apply makes: the
schema, the scopes, guards, each transition's own agent mode, the write cap, each `expect`) and rolls it back, then
stores one patch plan (`module.call`) holding the intents and the call's arguments, with one row a reviewer reads per
write. Its `proposal.summary` is a text over the call's arguments and value (`"Plan {$value.count} visits from
{$args.day}"`), filled by Canon, so the figures it shows are the call's own, never the agent's words. Approving it on
Patch plans applies the intents again as the approver, in one transaction, all or none, with the approver's role and
guards: a doc whose version moved since the agent ran it refuses ("changed since the call read it"). A person running
the same call writes at once. A proposed call can't replace a set (its docs are staged by the action) or be a system
call.

## View as

An admin's "view as" preview (Settings > Permissions) shows a module as the member sees it. Reads run as the member:
views, pages, reports and **read-only calls** (a call whose `writes` is empty) read with the member's role and scope,
in the member's isolate. Writes stay off: `moduleScope` (convex/lib/modules/scope.ts) refuses every module mutation
while a preview is live, which covers ops, transitions, a call's writes, uploads, saved reports, bulk retries and
proposals at one point; a call that writes refuses before it runs; a read-only call that returns writes anyway refuses
before they apply. A page's write actions show disabled with "Viewing as <name>: actions are off", a page's `onOpen`
doesn't run, and the bell lists the member's notifications with marking read off.

## On Canon's pages

A module adds to Canon's own pages what its docs say about Canon's records, read as the person who opens the page:

```json
"contributes": {
  "deals": { "badges": [{ "view": "visits.planned", "deal": "deal", "label": "Visit planned", "tone": "info" }] },
  "team": { "columns": [{ "label": "Planned visits", "view": "visits.planned", "member": "rep", "value": "{$row.title}", "filter": true }] }
}
```

- **People list actions.** `contributes.people.listActions` takes up to four `{ id, label, path, param, roles? }`
  entries. Each id is unique within the module. `path` names a literal module page such as `audiences/new`;
  `param` names the URL parameter its form consumes as a fixed JSON People filter. A page accepts one such
  handoff. Manifest validation checks the page, form field and role contract. The People list groups actions under
  **Modules**, with the destination module's name, and opens `/dashboard/m/<slug>/<path>?<param>=<JSON>` using
  the actual expanded list filter. The list never writes a module doc.
- **People filter round trips.** `{ "canon": "people" }` opens `/dashboard/records/contact`, the full filter
  builder. Its `query` may include `filter: "{$aud.filter|json}"` and a `returnTo` such as
  `/dashboard/m/audiences/audiences/{$aud.key}/filter`. Canon accepts a return only to a declared fixed JSON
  filter form of an enabled, role-visible module. It refuses external URLs, query strings, fragments and traversal.
  The list loads the complete filter with the existing day-filter helpers, then offers **Back to <module>** with
  the edited, expanded filter under that form's declared parameter. This explicit module context hides core
  audience save and update controls; CSV export remains. A legacy `?audience=` takes priority. Invalid filters or
  return paths show an error and issue no People list request. Ordinary saved views and core audience saves keep
  their existing behavior outside this context.
- **Panels on record pages.** `contributes.dealPage`, `companyPage` and `personPage` each take up to 3 `panels`:
  `{ id, title, roles?, replaces?, bind?, body, link? }`, at most 4 bindings, drawn from `detail`, `kpis`, `table`, `banner`,
  `callResult`, `actions`, `chart` and record-mode `phone`. A panel edits through an action's dialog or Canon's
  phone controls, or links to the module's page. The page's record is the URL parameter `record`,
  `{ "query": "record" }`: a deal's id as `deals.*` read it
  (Canon resolves the deal page's ledger stream to it), a company's `acc_…`, a person's `con_…`. Canon serves each
  panel as a page of the module's own at `panel/<page>/<id>` (`panelPages`, modules/kernel/manifest.ts), checked as a
  page is, read as the person who opens the record (in an admin's "view as", the member), so every component, action,
  read and call works as on the module's pages. The record page draws the panels its role sees after its own
  sections, each titled "From <module>", with `link` (its `{$query.record}` filled) beside it; a panel that fails says
  "Couldn't load" with Try again and never breaks the page. A module's own page path can't start `panel/`.
  On company and person recipe pages, `replaces` names a recipe section kind, such as `callPanel`.
  One contribution read supplies both the displayed panels and the sections to omit. Only enabled, role-eligible
  contributions participate. The first panel claiming a kind wins. The original recipe section, with its actions,
  stays available while contributions load, and replaces a panel that is hidden, loading, upgrading, missing or
  failed. Turning the module off or uninstalling it restores the recipe. No module slug is built into the host.
  A host without replacement support treats the panel as additive.
- **Deals list badges.** Per deal, a badge for each doc of `view` whose `deal` field names it (`when`, a row condition as
  a chip's, on the doc, the reader as `me`), its `label` a text over the doc ("Override", "Held", "Visit planned"), in
  `tone`, with "From <module>" on hover. With `count: true` it is one badge per deal, its label over the deal's first
  doc with the deal's docs as `{$docs.count}`: `{ "view": "credits.extra", "deal": "deal", "label": "+{$docs.count}
  credited", "count": true }` says "+2 credited" on a deal two more reps share.
- **Settings > Team columns.** Per member, the texts `value` makes of the docs of `view` whose `member` field (a member
  ref, or `owner`) names them, each once ("Enterprise AE 2027"); with `filter`, a filter of those texts and "No …".
  `when`, a row condition, keeps only the docs it holds on. A column with a filter is how a module adds a member filter
  Canon doesn't keep itself, computed from a doc the module keeps per member: "Has closed won" is
  `{ "label": "Activity", "view": "repSummaries.all", "member": "rep", "value": "Has closed won", "when": { "field":
  "closedWon", "gte": 1 }, "filter": true }`, and the Team filters then offer "Any activity", "No activity" and "Has
  closed won". A "Visits done" column has this shape over a per-rep `summaries` collection. A readiness column is a
  text field of the same doc: `"value": "{$row.readiness}"`.
- **Opportunities** (the deals list) has an Export menu (CSV or Excel of the deals as filtered and sorted), a close-date
  range (presets, or words in the fiscal year: a pay period, "last quarter"), and "Split by" owner, stage or deal type on
  its chart. Canon's deal fields read as the workspace names them in module text too: `|stage` and `|dealType` (a format's name is
  matched as written, camel case too), and a
  joined deal's `stage` with no format.
- Settings > Team takes `?title=<title>` (and `?team=`, `?group=`, `?role=`, `?status=active|inactive`), `?search=<text>`
  (the search box), `?manager=<member id or name>` (that manager's reports), and a contributed column by its label,
  plural or singular (`?plan=<value>` for a "Plans" column, or `?col=<label>&value=<value>`). The value is the text the
  column shows, or the key of the doc behind it: a column's `key` names the doc field a link names it by (`"key": "plan"`
  for `?plan=<plan key>`; the doc's own key by default). So a module's link opens the list filtered ("Account Executive"
  on an org chart, a plan's reps). `none` names the members the column says nothing for (`?plan=none`: members with no
  plan), as its filter's "No …" does. A filter that leaves no one shows **Clear filters**; the Member cell copies the
  member's email; and "Pick all N" counts the members the search and filters show.
- **Opportunities** "Split by" also takes the account, its chart steps by month, quarter or year, and the close-date
  range a person picks comes back when they return without one in the URL. So does their Split by (`?split=`; Stage when
  they never picked one, `none` for no split). A Stage filter (`?stage=<stage value>`) offers the picked pipeline's
  stages, else every pipeline's. Its CSV import maps Notes (to the deal's
  description) and needs Amount, Close date and Stage mapped. It still offers no External ID target: an imported deal
  never claims a CRM id (M16's decision).
- Each contributed data `view` is a list view with no arguments, read with its `join`s at most 1,000 docs.
- **The choke point.** `api.modules.contributions` (`{ page: "deals" | "team" | "deal" | "company" | "person" | "people", record? }`) is the only way a Canon page reads
  module data. For `people` it returns role-visible action and filter-form metadata only. For data contributions,
  it builds each enabled module's scope as the caller (`moduleScope`; in an admin's "view as", the member's)
  and reads through `scope.pageRows`, so a rep's deals list shows badges only from the visits they read, and a manager's
  team column only their team's. `tests/moduleSurfaces.test.ts` fails when a dashboard page or component outside a
  module's own pages names any other `api.modules` function.

## The choke point

All module data is in three tables, `moduleDocs`, `moduleEvents` and `moduleFiles`, and only
`convex/lib/modules/scope.ts` reads or writes them. A scope belongs to the
caller's workspace and one module that is installed and on there, so every read
and write carries the org and the module. `tests/moduleSurfaces.test.ts` fails
when any other file names either table, and lists every function in
`convex/modules.ts` as a data surface (it builds a scope), an action (`call`,
which reads and writes only through `callPlan` and `applyCall`) or a
package-only one. A module's job keys and feed cursors (`moduleJobs`,
`moduleCursors`) are read and written only by `convex/lib/modules/jobs.ts`, and
every query and mutation in `convex/moduleJobs.ts` builds Canon's system scope
first; the test checks both.

## Not yet

- Deal rooms' verified attachment requirement remains a later share unit.
- A fact proposal's `outcome` job and `optional`, a system call proposing facts, and proposing a structured field
  (a deal's splits) or an edge (a company's parent).

- A watch on deal splits and products: they live on the deal row only (`splitAllocations`, `products`), the object
  registry has no field type for a list of splits, and no Canon surface edits
  them yet.
- Line items read *as docs* by deal across set parents (a set's indexes start with its
  parent and generation). An index without them would return staged and retired
  generations too, so each row would need its parent read to tell whether it is
  live and readable: one more read per row, on the reads meant to be cheap. Aggregates
  by deal across every parent are cheap now, as a report read grouped by the deal
  (the projection keeps only live generations); the docs themselves stay out until a
  read needs them at volume.
- Editing a queued message, threaded mailbox replies, generic agent or background mailbox sends, company merge
  fields without proven canonical relationship authority, and connector-action sends. Agent draft edits can be
  proposed separately; their approval grants no mailbox consent.
- A sweep of files uploaded but never saved in a doc, and an agent uploading a file.
- A PDF of charts, reports, trees and history, and text outside WinAnsi.
- A joined dimension that filters or averages, or reaches past one ref.
- Company and person names in exports and printed pages (a `|ref` cell of one prints empty), a transition or an
  approved proposal that names a company or person its doc didn't hold, and a picker that lists a company's people
  by more than their name.
- Canon deals and members as a report builder's own source (their fields reach a module report through a ref's joined
  dimensions: `deal.stage`, `rep.team`); a pay period's dates as an Opportunities filter.
- A dialog that edits one row per picked doc, and an export dialog with format cards and searchable pick lists.
- Per-collection document caps and `workspace.nav` hiding a module's entry.
- A migration that creates docs (other than patching existing ones), and
  reseals a sealed doc it changes.

### Inbound matching

A system call may declare `match.inbound` with `{ email, companyName? }` and a
`reads.match` grant for `by`, `personId`, `leadId`, `companyId`, `accountOwner`
and `candidates`. It returns one result. Only Canon jobs, watches and schedules
run this read. Member and agent calls cannot directly run this read, even with full visibility.
An admin or their agent can queue the system job that runs it.
The workspace comes from the installed module, never from the email or input.
The kit's `inboundMatchInput.ts` checks and normalizes `{ email, companyName? }` as Canon does, so a module can refuse
a bad address before it queues the job.

An exact person or lead email wins, followed by a company domain and then its
domain family. Matching reuses the duplicate keys and lead conversion's free-mail
list. Several matches at the strongest level return `ambiguous`; a company name
alone produces `none` with review candidates. Only IDs, the account owner's ID
and reasons leave the service. Deleted records are excluded. More than 50
candidates or 50,000 company rows refuses the read. The service must support
contract 1.42.0; an older service fails closed.

No open module uses this read yet. Hosted intake and embedding
remain separate units with independent security reviews. `MODULE_SHARES` stays
disabled.

### Sequences call tasks

Sequences 0.6.0 publishes `callTasks.v1` over `tasks.callsDue`, with `contact`, `contactName`, `dueDay` and
`sequence`. The view takes no arguments and returns at most 500 open call tasks assigned to the caller, including
when the caller is a manager or admin. It includes tasks whose sequence is active, ordered by due day ascending,
then Convex's stable creation order for equal dates. Each row retains its normal stable document key.
`contact` is Canon's `con_…` person ID; `contactName` is optional display text;
`sequence` is the stable Sequences document reference. `dueDay` is `YYYY-MM-DD`, planned in the sequence schedule's
time zone. Queue eligibility compares that date with today's UTC date, as the existing Tasks overdue count does.
Future snoozed tasks wait for that cutoff. A 500-row result may be truncated; consumers must not treat it as every task.

Dialer 0.4.0 declares `uses: { "@canon/sequences": ["callTasks.v1"] }`. Existing workspaces approve the normal
upgrade because this is a new read. **Load due call tasks** runs a public module call as the actual caller,
including when an agent prepares the queue. It reads the interface without arguments, then resolves its contacts
through `people.byIds` with `ids: { "read": "tasks", "field": "contact" }` and limit 500 as that same caller.
The existing people name and phone grants suffice. Calling controls and `dialContacts` remain human-only.

Each currently readable person with a dialable phone is queued once in the provider's due order. Equal due days
retain provider creation order. Optional item metadata retains every matching stable task key, sequence reference
and due day. Names and numbers come only from current visible people, never from cached task display fields.
The load result counts distinct queued people, tasks without dialable phones, tasks with unavailable people,
and repeated tasks for queued people separately. The queue records its UTC cutoff date. A full 500-task response
warns that more tasks may exist. Missing, off or older providers, no tasks, and no dialable people explain the
result and preserve the existing queue. Clear is explicit.

Task loads atomically replace the caller's queue and items, fencing the queue and existing item versions.
Reload intentionally requeues called or skipped people and resets the session-call cutoff. Audience loads retain
their snapshot job. An optional audience snapshot field keeps pending audience jobs from reading or overwriting
a task queue. Existing loaded audience docs remain readable, and their next audience load sets that field.

Dialer consumes the published queue and never writes Sequences documents. Sequences watches Canon's scoped
`call` activities, including outcome updates on the same activity. A logged outbound attempt with outcome
`connected`, `no_answer`, `left_voicemail`, `busy` or `wrong_number` completes one unambiguous open call task
for the same assigned rep and person. The call time (`after.at`, not the ledger observation time) must be on or
after task creation. The task must still be the person's current step in an active or paused enrollment. An actual
early call can complete that task even when a future due/snooze date keeps it out of the queue; completion does not
compare a schedule-local date with UTC. Multiple matching tasks complete none because Canon's call has no task correlation.

Call end already creates an activity with an outcome; the public contract has no rep-confirmed flag. Completion
therefore means a logged attempt, not confirmation in the outcome form. A later edit updates the completed task's
outcome using the same Canon activity ID, never a Dialer or Telnyx ID. Its ledger observation time prevents older
updates from replacing a newer outcome. The completed task keeps this evidence and appears under Logged calls on
Sequences' Tasks page, newest call first. Historical manual-Done tasks without call evidence are excluded. Done is
refused for call tasks; Skip still advances without a call. Generic and other manual
steps retain their existing behavior. Pausing a sequence removes its tasks from the published queue. A call logged
while paused can complete its current task, and progression waits for resume. Manually finishing an enrollment
synchronously skips only that enrollment's open tasks, withdrawing them from the queue while retaining call history.

Sequences 0.7.0 adds People from recent calls on the Tasks page. Its read-only `recentPeople` call takes no
arguments and resolves the caller's last 100 logged call steps through scoped `people.byIds`. Each currently
readable person appears once, most recent call step first, with their current name and title and a Canon person
link. Hidden people are omitted; missing or hidden fields never fall back to cached task snapshots. A company link
uses only the person's granted `companyId`; it does not read the company or grant access to its page. Task and
enrollment documents, task actions, call history and `callTasks.v1` are unchanged. Existing installations need the
normal module upgrade; publication does not upgrade or enable a tenant.

### Initial values in call dialogs

A page call action may set `initial` with the same expressions as an op or
transition. `args` remains fixed input; `initial` prefills editable fields and
cannot name a fixed argument. Nested `optionTargets` traverse object fields,
list rows, and variant cases. Dependent choices still name a sibling in the
matching object, including the object inside a variant case.

### Explicit interface ownership

Canon stores explicit ownership in `moduleInterfaceOwners`. Trusted cutovers
are separate from manifest `imports` and never start on installation. An owning
package cannot be disabled, uninstalled, replaced by an arbitrary matching id,
or upgraded to drop its authoritative interfaces. The initial ICP cutover is
restricted to the anonymous local stack for I5 proof. Automatic rollout remains
outside this contract. Trusted imports may retain original creation metadata;
ordinary module code cannot supply that metadata through call intents.

## History

Status: **M17 built** (2026-10-18). Shares include seller controls, visitor sessions and declarative visitor writes. M1 shipped the manifest and its checker,
module data with read scopes, install and enable, one nav entry, declarative
pages and `canon_module` over `/mcp`. M2 added state machines with guarded
transitions and effects, an audit timeline, agent proposals that a person
approves, and the `banner`, `statusSteps` and `timeline` components. M3 adds
server code: calls that read a declared plan, compute in the recipe runtime and
return writes Canon checks and applies (see "Server code"), plus op `set`
fields, `neq` row scopes and value labels. M4a adds op guards, computed values,
conditional and copying effects, cross-doc guards, a system principal, actions
that show why they are disabled, status steps from the doc's history, and
upgrading an installed module in place (see "Upgrades"). M4b adds read plans
by ranges, lists and earlier reads, then background work: jobs over dirty keys,
the deal feed from Canon's records ledger, schedules, timed transitions, bulk
effects and the `fresh` guard (see "Jobs, watches and schedules"). M5a adds the form
vocabulary: lists of rows, nested objects, variants picked by a sibling field, refs
to deals, teams and module docs with a picker, values a form takes from the page,
guards that judge an update as it would be, list guards, and call results drawn on
the page (see "Forms and widgets"); and Canon's own example module, installed from
Recipes in one click (see "Modules Canon ships"). M5b adds lists: bindings that
join the docs and deals rows refer to and count their children, tables that search,
filter, sort, group and total, links built from a row, row actions shown by state,
a queue over several lists, a job status line, pages read from URL parameters,
job keys ordered by a doc's date, and date conversions in read plans and guards
(see "Tables, queues and status"). M6 adds records: detail grids, threads,
approval chains, period navigation and figures, CSV exports and printing (see
"Records, exports and print"), a seal Canon computes over a locked doc and its
sets (see "Integrity"), in-app notifications (see "Notifications"), `set` values
that unset a field or add a field's days to a time, bulk moves with no waiting
state, read scopes on a related doc, labelled transition dialogs and `time`
fields. M7 adds upgrade migrations and a landing page per role. M8a makes a bulk move
hold its doc until every doc it moves has moved, naming the ones that refuse, with
Retry; adds exports that refuse rows a `require` fails, calls a page loads when it
opens, bindings that read from another binding's doc, notifications from ops, steps
whose state comes from where their doc stands, read scopes that chain through several
docs, and the workspace's fiscal year (see "Fiscal year"). M8b adds reports over every doc a
caller reads, from the record service (see "Reports and charts"), charts, trees, links to Canon
pages, a transition a page runs when it opens, and components shown while a list is empty. M9 adds file fields
(see "Files"), Excel exports and a page as a PDF Canon renders, call results as full tables whose row actions
the server judges, components shown while a field is set, links that fill their query from a row, a page's
fallback, one member's deals read by owner, forms that start on today, evidence of where a person ran a
transition (see "Evidence") and report dimensions from a ref's record (`deal.stage`). M10 adds row actions on another
collection's doc, refs that sit under a parent with their picker scoped to it, titles over several fields, text
bounds, guards that compare a list's rows, value suggestions, labels and links filled from the page, a `?year=`
stepper, confirmations on calls, more row actions (folded under More), queue filters and sections, picked rows run
together, charts ordered by value with a top N and percents, per-row choices in a dialog, a report opened from a link,
and report reads in a call's plan (counts over every doc, no 5,000-doc read). M12 judges a form-opening action's guards
on what the form can't change and its dialog on submit, gives scoped pickers in a dialog the action's fixed values, opens
the doc a row's transition created (`then`), names joined members everywhere a table shows them, links to Canon
Settings, runs a version's `upgrade` job once when it serves, raises the stored manifest to 900 KB, and gives the report
builder click-to-add, replace-on-drop, Export and sortable results. M13 draws a row action's call result under its row,
says a form's refusals in the field's words, hides a timeline's events by actor from roles, gives actions `aria`, `toast`
and a `when` over page values, adds team aggregates (see "Team aggregates"), opens what a call made (`then`), gives
columns an `empty` text and tones, tags a thread's authors by role, reads a deal's company name, starts dialogs from texts
over the doc (`initial`), judges an approval chain's actions on another doc and names a picker by its collection's
`label`. M15a gives dialogs their own words over the doc (`dialog`), cells a hover text, a copy button and avatars,
forms placeholders, help over the page, a submit that waits for required fields and a "Discard changes?" guard,
notifications a subject and a badge that only the person marks read, with an unread count a page reads, toasts after a
page a transition opens, after a job a write waits on and after a PDF, a component `when` over a call's value, a menu of
actions, a timeline hidden by verb, a fallback's heading and other ways out, figures with tones and trends, bars that
open a page, choices that describe themselves, suggestions on nested fields, filters that offer every value, View as
from a module page and a CRM deal's account name. M15b adds to Canon's own pages (badges on the deals list, columns and
filters on Settings > Team; see "On Canon's pages"), a report builder over several sources with columns, areas, stacking,
a second axis, a line over bars, five values, a deal's dates by month and a date range in words, fiscal years (a stepper
over this fiscal year, FY names, a column per fiscal month, header links), an org chart's search, zoom and inspector,
section links, a page's own document heading, wordmark and footer, actions hidden while a guard fails, and room for 100
calls, 20 guards and 200-character labels. M16 lets views and read plans read by the clock (`{ "now" }`,
`{ "nowPlusDays" }`: "from today", "this fiscal year so far") and raises the views a module declares to 250. M17 judges
two buttons of one transition by the arguments each fixes ("Approve anyway"), fills `{$...}` in every label (a job status
line's), adds waits that follow the jobs a write's job dirties with a busy label, dialog badges, op dialogs' own fields with
placeholders over the page, options read from a doc, choices a form hides, a box that must be ticked, suggestions and
multi-picks from a Canon deal field, drag to reorder (a list's rows, a table's docs), page parameters kept per person, one
message for a page's failed loads, PDFs in a tab, cell bars, popovers and row expansions, cells shown by a row condition,
deal stage labels, table chips, attention, a summary line, a chosen grouping, a total bar, phone cards and a multi-row edit,
an export dialog that picks members, a wizard and a spreadsheet grid, Canon links with a query, and on Canon's own
Opportunities an Export menu, a close-date range and a chart split. Read plans read companies, people and the
activities on deals and companies, and what was said on them: notes and call and meeting transcripts (see "Server
code"), and watches watch them too (see "Jobs, watches and schedules").
Hosted AI steps (shared gap P8) let a call ask the caller's model to fill one doc's fields, keeping only quotes Canon finds
word for word in what the call read (see "Hosted AI steps"). Docs refer to Canon's companies and people (shared gap P12):
checked on write as the writer sees them, picked, joined, linked to their pages and grouped by in reports (see "Refs to
companies and people"). Outbound effects (shared gap P4, first half) let a module
send: Slack posts to channel names an admin maps, signed webhooks for its events, and its notices by email, each one a row
of the outbox decided in the write that asks for it (see "Outbound"). The test
fixture `tests/fixtures/modules/visit-log/` is an early version of Canon's first example module, kept for the tests.
