# ICP editing and ownership

`@canon/icps` 0.7.0 is source for the opt-in From Canon module. Every member reads its tree,
map, and focus. The existing `strategy.edit` capability admits editing,
including custom roles. Installation keeps Canon's legacy tables authoritative.
The module is read-only until an explicit ownership cutover. This I5 source
slice exposes that operation only on anonymous local stacks. It never runs
from installation, upgrade, or a scheduler.

The module publishes the accepted `icps.v1` and `icpNodes.v1` fields. An imported
doc's `key` must be its existing ICP or node id. `nodes.icp` and `nodes.parent`
hold those unchanged string keys. Omit absent optional fields rather than storing
null. Copy legacy `createdAt` into `data.createdAt` to preserve creation order.

The table orders the default ICP first, then creation time, and walks each tree
in child creation order. It shows each definition's current gate counts even
when the definition is off. This is a read preview, not a claim that an off ICP
owns fit memberships. A persona's people count can exceed its account count.
Sibling sets overlap. No sibling takes accounts away from another sibling.

## Platform read

The typed read plan is:

```json
{
  "definitions": { "view": "icps.all", "limit": 25 },
  "nodes": { "view": "nodes.all", "limit": 75 },
  "counts": { "icpTree": { "icps": "definitions", "nodes": "nodes", "market": true } }
}
```

`icpTree` requires earlier own-doc list reads. Their schemas must contain the
typed fields in `modules/kernel/icpTree.ts`. The manifest grants companies and
people's titles, plus `market.facets`. Canon compiles root specs with `specGate` and node lines with
the existing query grammar. `readTreesOf` checks the compiled principal,
workspace, and grants before calling the caller's scoped `icpTreeCounts` client.
Only explicitly system calls use the system client. Invalid queries, mismatched
root query/spec pairs, missing or cross-ICP parents, persona parents, cycles,
excess depth, and unknown account AI fields refuse the whole read visibly.

The same dispatcher already runs for member calls, exports and page printing,
system calls, jobs, watches, connector feeds, and schedules. Background AI
member contexts refuse tree reads, as territory reads already do.

The generic page text binding `{$objects.account.pluralLabel}` reads the
workspace's object names. `label` and `pluralLabel` also work for other native
and custom object names. `objects` is reserved as a page binding name. The page
and its printed document receive the same labels.

## Map and selected-row focus

The `tree` call returns its original table `rows`, canonical map `sets` and `overlaps`.
Both row arrays keep the same stable keys and default-first tree order. The generic
`setMap` component reads these arrays; Canon has no ICP-specific renderer branch.
Its account counts determine circle sizes. A persona's focus separately names its
people and account counts, so multiple people at one account stay distinct.

The table's `focus` and the map's `selection` both use `{ "param": "sel", "aliases": ["icp"] }`.
An absent or stale selection opens the first row. Selecting a table row, circle or
sibling writes `sel` and clears the compatible old `icp` parameter. Table hover
and keyboard focus light circles. Enter and Space select a focused circle or row
button. Selection and hover do not change geometry. Ancestors are outlined,
shared siblings and off sets are dashed, and unrelated sets fade.

The focus shows the row's kind and name, size, its existing query as a readable
sentence, sibling shared counts and any saved point of view, offer or role.
The table supplies inline editors and retains generic call dialogs as alternatives. Root market estimates use the existing platform market
cache and the same `icpMarketFilter` as core, after caller-scoped counting succeeds.
They count the spec's searchable industries, company countries and sizes, not its
full gate. An empty or unsupported market filter, or an unavailable index, stays
`null` and reads **Unavailable**. Segments and personas show no market estimate.
No module reads core ICP tables or another module's interface to obtain it.

`modules/kernel/setMap.ts` owns the general pure geometry and validates the map's
value. `src/lib/icp-map.ts` preserves the core map contract as a wrapper over that
same algorithm. Count compression and deterministic best-fit relaxation are
unchanged; circle areas do not exactly encode arbitrary inconsistent pair counts.
Both native print and the page PDF include every set's count, parent and state,
pairwise shared counts and selected-row focus as text and tables.

## Editing contract

Create starts a blank ICP. The first ICP is on and default. Later ICPs start off
unless requested on. Query editing and structured conditions use the canonical
parser and workspace account AI fields. A refusal leaves the doc and its
version unchanged. Rename, messages, activation, default selection, duplication,
move, and deletion all use declared calls over own docs. Every edit carries doc
versions and capped-collection snapshot counts, checked before any intent writes.

Duplicate copies the entire tree, remaps its relationships, and starts the copy
off. Move checks cycles, same-ICP membership, persona parents, and depth four.
Delete removes the subtree and promotes an active, then oldest, default when
needed. Gap results appear in the tree. The system result op changes only
`gapCheck`, which does not invalidate fit or schedule another gap check.
Message dialogs replace the fields they show. Clearing a control removes its saved value.

Inline token popovers, drag-and-drop, blur-save messages, ghost creation rows,
and equivalent keyboard editing are not implemented by these dialogs. Do not
mark those parity rows complete. Website and signup research are the next source seam within original I5.
Challenge and staged-fill initiation remain the following seam. P49 still uses
a free QuickEnrich page at a zero ceiling when that later PR implements it.

## Parent generation and source proof

This writer did not run generation, validation, a stack, or any network call.
The parent must regenerate with `npm run module:examples`, measure UTF-8 bundle
bytes against 1 MiB, and regenerate Convex bindings through its managed stack.
The grammar, sentence, and editing imports use the shared pure vocabulary and
geography files. Old imports from `addRecords` and `researchPipeline` still work.

Run these scoped commands through the resource runner after generation:

```sh
npm run test:target -- tests/icpsEditing.test.ts tests/moduleSurfaces.test.ts tests/fitReconciler.test.ts tests/icpsInterface.test.ts tests/icpTreeMutation.test.ts tests/icpQuery.test.ts tests/icps.test.ts tests/audienceSummary.test.ts
npm run typecheck
npm run lint
```

All commands above are unrun by the source writer. The parent's required review
and PR checks still apply. No test output or generated bundle size is claimed.

## Local ownership and editor proof

Preserve the existing `.devstack` state and all saved proof files. Start only
this worktree's stack with `npm run dev:isolated -- --background`. Read its
actual ports and `DEVSTACK_SANDBOX_HOME` from the READY output or ports file.
Use that literal sandbox path in each one-off command. The examples below use
`/absolute/sandbox/path` as a placeholder to replace manually before running.
Do not use shell expansion to build Convex JSON, and never call `devTamper`.

1. Save the current legacy interface, tree, latest gates, fixture account fit,
   and `icpIds` through their existing queries. Save both module collections
   through `modules:view`. Export and explicitly remove only the parent's
   synthetic preview docs with the existing `modules:devUnseedDocs` mutation,
   using individually reviewed literal prefixes. Do not reset the database.
2. Preview `canon:icps` with `modules:previewInstall`. Use its literal `sha` and
   `manifestHash` in `modules:install`, with `approveReads: true`. Confirm 0.3.0,
   enabled, and no pending upgrade. The unchanged ICP interfaces must still
   return the legacy definitions at this point.
3. Confirm vendor-free conditions before any active edit. Use a fresh synthetic
   `marketSize:store` entry matching the planned filter and TAM count to get
   `covered`, or establish that no TREG token can start a real fill. Account for
   every planned active query, since edits schedule the existing settled gap
   check. Do not invoke research, real providers, or fill actions for proof.
4. Run the explicit local cutover once, with the saved local org id. Replace
   the org id if the parent intentionally changed its fixture:

   ```sh
   env -u CONVEX_DEPLOYMENT HOME=/absolute/sandbox/path CONVEX_AGENT_MODE=anonymous ./node_modules/.bin/convex run icpsCutover:cutOver '{"orgId":"mx7tvsvzgxn7ashtrzjay9atw58gm916"}'
   ```

   Save its receipt. Repeat the identical literal call and expect
   `repeated: true`. Compare all keys, original creation times, relationships,
   gates, fit, and memberships. Never accept empty gates from a missing or
   upgrading provider. The reconciler must retain stale work on refusal.
5. Open the module's `icps` page on that stack. Create, rename, edit a valid
   query, and edit structured conditions with choices and an account AI field.
   In the actual **Edit query** dialog enter `size:banana`. Save, observe the
   visible refusal, and reread `modules:view` to prove unchanged query/version.
   This proves write-side refusal. The separate deferred stored-invalid-document
   read-side visual remains unverified. Do not substitute data tampering.
6. Exercise on/off, default, whole-tree duplicate off, valid move, rejected
   cycle/persona/cross-ICP/depth moves, subtree delete, default promotion, and
   role/point-of-view/offer clearing. Confirm map, sentence, and focus continuity.
   Turn off the final active ICP and prove the record service clears `icpIds`.
7. Preview a custom base-rep role with `strategy.edit` and a custom base-manager
   role without it. Compare availability and direct refusal as well as reading.
   Restore all roles and preview settings. The legacy compatibility page shows
   the owner-aware data read-only. Core semantic ICP/node/challenge writes refuse.
8. Verify a cached covered result and an audience query save using a module key.
   Result-only writes must not change the fit revision or queue another check.
   Fake-provider tests cover the remaining gap outcomes and fill limits.
9. Check the real dialogs at narrow width, the page PDF, and native print.
   Restore temporary fixtures. Stop the parent's stack with `npm run dev:stop`.

The local ownership switch is one-way in this slice. A failed cutover rolls back
every copied doc, event, stale mark, and owner row. Successful cutover keeps the
legacy rows frozen. Do not revert ownership or erase preserved proof state.

I3 and I4 remain SOURCE ONLY and track progress stays 3/8 shipped. This source
PR does not establish deployment, installation on dev, or authenticated runtime.
Real Clerk permissions and existing cloud schema/data remain unverified.
The Audiences-owned `createFromIcp` legacy-id adapter and its deferred ICP-keyed
people snapshot/count path are untouched. The former must migrate before I6
cloud cutover. No ICP deployment observer or infrastructure repair is included.

## Website and signup research source

Version 0.4.0 adds **From a website** and **Import signup research** to the header.
Installation and upgrade retain the current owner. The frozen public interfaces,
25/75 definition limits, string keys, fit/gap hooks, and trusted background signup
adoption are unchanged. The actual 0.3.0 manifest is retained as an upgrade fixture.

Website research creates a derivation and enters `deriving`. P8 reads safe public
sources as the initiating member, asks their plan, checks exact evidence, and
stores the intermediate answer with its sources and platform-stamped model.
`adoptDerived` uses the portable website result normalizer and shared pure
`specFromIcp` mapping. It builds the canonical query/spec and creates
`<Company> (from website)` with `source: website` and `sourceDomain`. The first
ICP is on and default. Later website ICPs are off.

The member completion and terminal success move commit together. Current effective
`strategy.edit`, original agent identity, row scope, CAS, count fences, package
revision, and epoch are checked again. A refusal creates no ICP and moves the run
to `failed` with a visible error and a trusted-org `researchFailures` entry.
The page shows progress, model/provider, failure reason, and retry. A stopped
`deriving` run can be explicitly retried after ten minutes. Old notifications
cannot change a newer run. This also allows recovery after package supersession.
The model receipt remains accurate separately from workflow adoption.

The exact gate retains the original single evidence repair retry with original
sources and failed quotes. It shares one reservation and charge, stays within the
input limit, and never repairs authorization or semantic writes. Fewer than two
kept exact quotes after repair fails visibly. No heuristic/template ICP is created.

Signup import reads only the workspace's claimed session through `research.signup`.
It refuses absent or already-saved research. It preserves canonical query/spec,
`<domain> (signup research)`, `source: research`, and the heuristic indicator.
It becomes active only when no ICP is active and default only when it is first.
The page labels heuristic signup research explicitly.

The website call selects `credits: false`. It refuses without a plan instead of
spending workspace credits. Legacy key-only OpenRouter fallback and P16 parity
remain **unresolved**. Real ChatGPT, public fetches, and cloud installation are
unverified. There is no new free deployment-model route.

### Parent validation, all unrun by this writer

Regenerate examples with `npm run module:examples`. Let the parent's own local
stack regenerate Convex bindings. Do not hand-edit generated artifacts. Check
UTF-8 bundle size against 1 MiB after generation.

```sh
npm run test:target -- tests/moduleResearch.test.ts tests/moduleAi.test.ts tests/icpsEditing.test.ts tests/moduleSurfaces.test.ts tests/icps.test.ts tests/icpDerive.test.ts
npm run typecheck
npm run lint
```

The authored tests cover source grants and transport bounds, exact evidence and
one repair, plan-only refusal/default-policy continuity, actual 0.3 upgrade,
member completion rollback/revocation, website first/later semantics, stale
versions/counts/cap refusal, signup import/source drift, and terminal failure logs.
Existing System-owner queue and literal fit tests remain in place.

### Supported zero-spend local proof

Preserve the current local ownership, database, proof fixtures, and saved reviews.
Use the parent's existing stack and literal ports/sandbox path from its READY
output. Leave `MODULE_AI_MODEL` at the established local default so both model
and public-source transport are fake. No live model, fetch, vendor, or fill call
belongs in this proof. Active definitions still schedule the retained gap hook,
so retain the parent's cached covered fixtures or other established no-vendor
conditions before creating a first or active ICP.

1. Preview and upgrade `canon:icps` to 0.4.0 with explicit `approveReads: true`.
   Compare unchanged interfaces and the retained local owner. Do not repeat cutover.
2. On the real module page derive `acme.test`. Observe deriving then done, test
   model/no-AI provenance, exact source text, and a new canonical website ICP.
   With existing ICPs it must be off. Reread stored docs and the model receipt.
3. Derive `unreadable.test`, then `thin.test`. Observe specific visible failures,
   no new definitions, and one `researchFailures` row per failed attempt. Use
   Retry and confirm the new attempt remains truthful. Do not tamper with docs.
4. Import a claimed signup source if present. Verify its name, canonical criteria,
   active/default semantics, heuristic indicator, and already-saved refusal.
   With no claimed source, prove the visible refusal instead of inventing research.
5. Preview the base-rep custom editor and base-manager non-editor. Verify action
   availability and server refusals. Restore preview and roles after proof.
6. Inspect desktop, 390px, page PDF, and print for progress and failure content.
   Preserve evidence and stop the parent's stack when finished.

The source continuation below adds challenge and staged fills. Integrated proof remains parent-owned. Still open within original I5 are the documented
inline/token/drag/blur/keyboard editor gaps. Agent alias migration, navigation,
default installation, and cloud owner rollout remain I6. The read-side visual
refusal of an invalid stored document is still unverified. This source commit
makes no new test, visual, dev-installation, authentication, or shipping claim.


## Challenge source continuation

Version 0.5.0 adds **Challenge my ICP**, saved run history, explicit hypothesis
labels, dismissal reasons and human acceptance into staged review. The module
owns context and domain decisions. General caller-scoped reads supply signup
research, closed opportunities, best-fit accounts, safe public pages and free
QuickEnrich sample sizes.

The workflow reads the vendor homepage, proposes adjacent industries or disjoint
sizes, normalizes and excludes already decided markets, reads at most six safe
requested URLs, optionally cites those pages, then sizes at most five proposals.
The citation model is skipped when no usable page was read. Quote verification
uses the exact CRM context or actual read pages and retains unsupported claims as
hypotheses. Open markets appear before sizing finishes. Progress, actual provider
and model, optional sizes and visible failures remain in the history.

The original member and optional agent start every automatic stage. Fetching,
normalizing and sizing use pure queued calls without a model. Every completion
reloads current permission and package/document fences. Legacy trusted owner
queues retain their old behavior. A disconnected ChatGPT plan refuses before a
challenge document is created. No paid model fallback or template proposals exist.

**Accept and stage free fill** is human-only. It binds the selected market's
stored free query and current version to `population.start`. The job, staging
record, scheduled task, accepted state and job id commit together. A refusal
leaves the market open and creates no job. The bound acceptance transition
cannot be called directly. The activity tray supplies progress and a staged
review link; the row can stop its job. No records join the CRM before staged
approval. Existing direct free-fill and query-prefill paths remain available.

The fake-model mode selects explicit fake web, sample and population transport.
It uses no real provider and labels test output. Fake population produces an
empty staged review. Missing live transport, paused pacing or an ordinary query
failure omits sizes; TregRefusal stops the remaining sizing requests. Live errors
never select fakes. Numeric min/max and the existing buyer/country/provider
mapping remain intact.

Parent-owned commands, all unrun by the source writer:

```sh
npm run module:examples
npm run test:target -- tests/moduleChallenge.test.ts tests/moduleResearch.test.ts tests/moduleAi.test.ts tests/moduleCanonReads.test.ts tests/moduleRecordReads.test.ts tests/icpChallenge.test.ts
npm run typecheck
npm run lint
```

Run generation before tests that load `dist/module.js`. The parent owns local
stack setup and Convex API regeneration. The source writer never hand-edits
those generated artifacts. Preview the 0.4 to 0.5 upgrade with explicit read
grant approval and retain the existing local owner and fixtures. Use only the
explicit fake-model transport for positive staged acceptance proof. Verify
revocation, field and row denials, artifact/epoch/version drift, no-page citation
skipping, refusal rollback, duplicate decisions and stopped-job progress.

No test, type, lint, generation, runtime, visual, deployment or installation
result is claimed by this source commit. P16 legacy key-only fallback and P66
agent acceptance remain unresolved. Residual inline, token, drag, blur and
keyboard editing parity stays in original I5. Cloud owner rollout, automatic
installation, navigation, redirects and tool aliases remain I6.


## Original I5 residual editor source, 0.6.0

This source adds generic editable hierarchy metadata, client-side collapse,
inline name/query editing, Sentence/Query URL mode, dashed child creation,
valid-target drag/drop and a keyboard Move-to alternative. Name/query drafts
keep the source version, revert on Escape, and suppress a duplicate Enter/blur.
Query validation is a declared read-only module call; final writes still parse,
canonicalize, validate account AI fields and use CAS.

The selected row uses module-returned sentence tokens and condition choices.
The module keeps canonical vocabulary, geography and answer types. Controls cover
checklists, title/free-answer terms, numeric min/max and boolean AI fields.
A shared option dictionary avoids duplicating vocabularies on every tree row.
Message fields keep the original per-kind maxima, placeholders and help.
Their dedicated field write preserves siblings and clears explicitly under CAS.

Published v1 schemas, caps, counts, best-fit scoring and duplicate-with-tree
semantics remain unchanged. The 0.5.0 manifest is retained in the upgrade fixture.
The people snapshot/count deferral, P16 key-only fallback and P66 human-only
acceptance boundary remain open. Automatic ownership, navigation and caller
cutover are still I6. No issue 823/827/829 polish sweep is included.

Parent-owned commands for this source, all UNRUN by the source writer:

```sh
npm run module:examples
npm run test:target -- tests/icpsEditing.test.ts tests/moduleEditors.test.ts tests/modulePanelsRender.test.ts
npm run typecheck
npm run lint
```

Parent validation passed generation, 54 scoped tests, typecheck and scoped lint.
The local 0.5 to 0.6 upgrade required no drops, migrations or new read grants.
Live checks covered inline save/revert/refusal, ghost creation, collapse, token
controls, a valid drag, a refused cross-ICP drop, message clearing and viewer
refusal. Desktop, 390px and exported PDF were inspected. Original definitions
and member selection were restored; the exercised root version advanced.

Stored-invalid read-side rendering, native print and real Clerk roles remain
unverified. The PDF reads the table and map's read-only selected-row details.
The new editor does not add a PDF renderer. I5 remains unfinished and unshipped.

## Original I5 P21/P23 prefill source, 0.7.0

SOURCE ONLY. Active root rows declare **View accounts** and **Fill from this ICP**
through existing Canon `companies` links. They pass the exact key as `icp` or
`fill`. Nodes and inactive roots offer neither link. Inline name/query editing replaces their redundant dialog actions, so the table
retains all other actions and stays within the 12-row-action cap.
The published schemas, provides and platform caps do not change.

Accounts opens its existing Add records dialog for an explicit `fill` parameter.
The dialog waits for current caller-visible ICP definitions and fill context.
It copies the exact active definition's Market, Persona and Exclude into the
Market tab. Empty, unknown, foreign, removed, inactive, failed or unavailable
intent shows a refusal without mounting runnable forms. It never selects a
different ICP as a fallback. Without `fill`, Add records keeps its existing
workspace defaults. Normal filter links remain read-only.

Changed intent or current definition remounts the forms, clearing previous drafts
and preview results. Closing removes only `fill`; Back and reopening follow URL
presence without an effect that reopens the dialog. Navigation, resolution and
mounting do not invoke preview, start, acceptance, vendor or paid actions. Final
execution admission remains with the existing backend.

Parent-owned commands for this source, all UNRUN by the source writer:

```sh
npm run module:examples
npm run test:target -- tests/fillPrefill.test.ts tests/addRecordsDialogRender.test.ts tests/accountsPageRender.test.ts tests/icpsEditing.test.ts
npm run typecheck
npm run lint
```

The parent owns generated artifacts, local upgrade and runtime proof, visual
checks, independent review and shipping. Existing local definitions and upgrade
fixtures stay intact. The local owner's three roots are currently off, so the
parent must account for that when proving root-active links and explicit refusal.
No test, generation, type, lint, runtime, visual, installation or deployment result
is claimed here.

P16 remains ChatGPT-plan-only and P8 retains its current fail-closed policy.
P66 agent acceptance is unsupported: the existing Agents contract census found
no authorized delegated-population boundary. Human acceptance remains. No fallback, workspace-credit substitution, policy waiver or rollout
is part of this source. Issue 831 followups and I6 stay separate. I5 is unfinished.

### Parent verification for 0.7.0

The parent regenerated the package, passed 55 scoped tests, typecheck and scoped
lint (one existing unused import warning), then upgraded its own local 0.6.0
installation without drops, migrations or new read grants. An active root's View
accounts link filtered the exact key; Fill from this ICP opened Market with that
root selected. Current settings changed the open form from Ireland/VP to United
States/Director. Inactive, unknown and empty keys, and the seeded viewer, refused
without runnable forms. Normal opening retained the default ICP and Accounts tab.
Closing cleared only fill intent; Back/Forward through the module link worked.

The exercised root and member selection were restored through public APIs, with
normal version/audit/gap-check history retained. No preview or fill was started.
Desktop and 390px screenshots were inspected. The existing dialog controls
horizontally overflow at 390px; this is a recorded limitation. One initial local
frontend startup returned dashboard 404s; a supported stack restart restored it.
A cross-document Back attempt left a restored page unhydrated; the actual module
link's client navigation Back/Forward passed. Real Clerk, failed-provider runtime,
cloud installation, vendor execution and deployment remain unverified. P16/P66
limits above remain. No native print or new PDF renderer is part of this change.
