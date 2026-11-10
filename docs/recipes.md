# Customization packages: a small kernel, and packages for the rest

The Customization page (formerly Recipes) calls a recipe a **package**
(`docs/customization.md`). Agents use `canon_customization`; `canon_recipes`
remains an alias. Ids, Convex functions and `recipe.md` keep the word recipe.

Status: **R1 to R6, G1 to G7, E1, E2, E3 and E4b built** (2026-10-14). E1 lets a workspace customize any recipe into its own copy and edit that copy's markdown in the app ("Customizing in the app"); E2 adds a live preview, evals before save and merging upstream updates, E3 edits a page's layout visually without markdown ("Visual layout mode"), and E4b asks Canon for an edit in words ("Editing with an agent"). G6 made the account and contact pages points like the deal page ("Record pages"). G1 made recipes packages of contributions to registered points, with install and enable kept apart and a Customization page of their own ("Packages, contributions and points"). G3 lets a recipe ship templates, rows a workspace installs once ("Templates"). G2 added model points: the forecast, customer health, lead scoring, signal heat and hygiene audit numbers are canon-base's settings, which a workspace edits and another recipe can replace ("Model points"). G5 did the same for calls: what a call's next step, close date and opportunity mean, and the words behind each call insight ("Calls"). G4 lets a recipe ship AI fields, which a workspace turns on one by one ("Fields"). G7 made ICP fit weights a model point too, `scoring.fit`, and a change to them rescores the workspace. R6 writes recipes as markdown and TypeScript, and the markdown lays out the deal page: its sections, their order and folding, and its actions. The methodology the kernel still held (the research and people research cadences, a research run's limits, the draft input caps, the first-touch channel, and what the review, account plan and buyer-fit answers ask) is the recipe's too ("Methodology and kernel"). Decisions are Ryan's, from the thread that
followed the deal page work (#361 to #404). Builds on Canon's org agents, Signal
agents, deal plays and deal prep loop.

## Problem

Every Canon workspace sells the same way, because every rule about how to sell
is a constant in TypeScript. The deal page is the clearest case. Its rules came
from one methodology, Jen Abel's founder-led sales,
and they live in `convex/lib/plays/`:

- draft caps and checks (`drafts.ts`: `EMAIL_MAX_WORDS`, the `COMPARATIVE` and
  `MAGIC_WAND` phrase checks, the call talk track);
- keeper flags (`model.ts`: `CORE_ROLES`, `QUIET_DAYS`, `keeperReport`);
- the verdict and the reasons a deal goes slow (`model.ts`: `prepReport`);
- what research asks about a company and its people (`research.ts`,
  `peopleResearch.ts`: `PEOPLE_FIELDS`).

A workspace can change two things: an ICP's point of view and its offer
(`icps.ts`). Nothing else is configurable. A consultant with a different way of
running enterprise deals, or an agency that works one vertical, can't express it
without a Canon engineer.

HubSpot and Salesforce win partly through their partner networks. Salesforce
made its platform extensible with Apex, managed packages and custom objects.
That route assumes an expert's methodology is *code*, so a developer has to
translate it first. Most of what an agency sells is *judgment*: which signals
matter for fintech in DACH, what to ask a CFO, what a close plan for an ICM deal
looks like. With a model in the loop, judgment written as prose and rubrics runs
as written.

## Decisions

1. **A small kernel; everything else is a recipe.** The kernel holds the
   primitives below. A methodology (signals, research questions, plays, draft
   rules, the deal page layout) ships as a recipe: a versioned package a
   workspace installs, forks and tweaks.
2. **A recipe is a package like a pi package or a bb plugin.** It has a
   manifest, skills as markdown, server code in TypeScript, UI as declarative
   slot specs, agent specs and settings.
3. **Server code is sandboxed TypeScript.** It runs in an isolate outside
   Convex, with no network and no secrets. Its only capability is a Canon API
   scoped to what the workspace granted at install. Every write still goes
   through Canon's gates.
4. **UI is declarative slots only.** A recipe fills named slots with Canon's
   own components and binds them to its server code's output. It can't ship
   React. Sandboxed iframes for verified authors may come later; nothing here
   should block them.
5. **Canon's own features become recipes first.** The default record page
   is the base recipe. The current deal page is recipe #1,
   **FSGTM Enterprise multi-touch deal**, and FSGTM is the first agency
   author. No outside author ships a recipe before Canon's own run on the
   format.
6. **Layers stack: Canon, agency, workspace, rep.** This extends the
   center/edge split (ICPs per workspace, audiences per rep).

## Prior art

| | pi | bb (getbb.app) | Canon |
|---|---|---|---|
| Package | npm or git, `pi` key in `package.json`: `extensions`, `skills`, `prompts`, `themes` | npm, `bb` key: `server`, `app`, `skills` | A GitHub repo or directory: `recipe.md` (settings, page, actions, prompts, logic, evals), and `dist/recipe.js` when it has TypeScript |
| Code | In-process extension factory: `registerTool`, `registerCommand`, event hooks | `server.ts` (tools, endpoints, storage, lifecycle), `app.tsx` mounted in named slots (`app.slots.navPanel`, `threadPanelAction`, `messageDirective`) | `server.ts` in an isolate; slots are data, not code |
| Sandbox | **None.** An extension "runs inside the Pi process with the same operating-system permissions" (pi's security documentation). | None documented. A local app. | Required: hosted and multi-tenant. |
| Own features | Built-in tools, extensible | Tasks, drafts and the thread list are plugins | The default record page and the deal page become recipes |
| Install | `pi install npm:…@1.0.0`, pinned; personal or project scope | Marketplace | Workspace install from GitHub, pinned to a commit; forkable per layer |
| Authoring | People and agents write extensions | "The IDE that builds itself": the agent writes plugins | The user's agent writes recipes over `/mcp`; an admin approves |

What we take from them: the package shape, the rule that core features are
written as extensions, and agent authoring. What we can't take: their trust
model. Both run code with the user's own permissions on the user's own machine.
Canon runs one author's code next to many tenants' data.

## Packages, contributions and points

Three nouns, the way pi has packages and the resources inside them.

- A **package** is what a workspace installs: a `recipe.md` and, when it has code, its bundle ("The package"). The first-party recipes are packages that are always installed.
- A **contribution** is one thing a package offers Canon, such as its deal page. A package can make several.
- A **point** is a named place in Canon that takes contributions, such as `deal.page`. Each point is an entry in one registry, `POINTS` in `recipes/points.ts`. Nothing about a point lives in a branch elsewhere.

### Points

A point declares:

| Field | Means |
|---|---|
| `id` | Its name in `contributes` and in storage, like `deal.page`. |
| `kind` | `page`, `fields`, `signals`, `model`, `rules` or `templates`. |
| `cardinality` | `exclusive`: one contribution in force per workspace, or the point's default. `additive`: any number at once. |
| `discover` | How it finds a package's contributions in the parsed recipe, by convention. The deal page is the `{section=…}` headings. |
| `problems` | What it checks in a contribution past its shape. The deal page runs `pageProblems`, from the parser and from `parseManifest` alike. |
| `conflict` | Additive points only. Why two contributions can't both be on, such as two recipes defining one field slug. |
| `implies` | What contributing here reads. It is added to the recipe's `permissions.read`, and the point itself becomes one of `permissions.slots`. |
| `binds` | `code` when a contribution may bind recipe code, which runs in the isolate. `data` when it is plain data. |
| `defaults` | Exclusive points only. `unset` is what a workspace runs before anyone chose. `newWorkspace` is what a new workspace starts on. |
| `defaultOn` | Additive points only. The recipes whose contributions are on in every workspace until someone turns one off. |

A recipe lists the points it contributes to in its frontmatter, `contributes: [deal.page]`. The parser then asks each point what it finds in the body. A point listed with nothing for it in the body is an error at the `contributes` line. A part of the body that a point finds without being listed is an error at that part. So the list is the declaration an install screen shows, and the body is the contribution itself, as in a pi package whose `pi` key lists `skills/` and whose skills are the files there.

Registered today:

| Point | Kind | Cardinality | Binds | Defaults |
|---|---|---|---|---|
| `deal.page` | page | exclusive | code | unset: `fsgtm-enterprise-deal`; new workspace: `canon-base` |
| `account.page` | page | exclusive | code | `canon-base` |
| `contact.page` | page | exclusive | code | `canon-base` |
| `workspace.theme` | theme | exclusive | data | unset and new workspace: `canon-ledger` |
| `forecast.model` | model | exclusive | data | `canon-base` |
| `health.model` | model | exclusive | data | `canon-base` |
| `scoring.lead` | model | exclusive | data | `canon-base` |
| `scoring.fit` | model | exclusive | data | `canon-base` |
| `signals.heat` | model | exclusive | data | `canon-base` |
| `hygiene.policy` | model | exclusive | data | `canon-base` |
| `fields` | fields | additive | data | |
| `calls.model` | model | exclusive | data | `canon-base` |
| `abm.model` | model | exclusive | data | `canon-base` |
| `workspace.nav` | model | exclusive | data | `canon-base` |
| `templates.reports` | templates | additive | data | on: `canon-base` |
| `templates.dashboards` | templates | additive | data | on: `canon-base` |
| `templates.automations` | templates | additive | data | |
| `templates.icps` | templates | additive | data | |
| `templates.pipelines` | templates | additive | data | |
| `templates.cadences` | templates | additive | data | |

Planned, each added to the registry by the phase that needs it:

| Point | Kind | Cardinality | Binds |
|---|---|---|---|
| `signals` | signals | additive | data |
| `dedupe.rules` | rules | additive | data |
| `hygiene.rules` | rules | additive | data |
| `routing` | rules | exclusive | data |
| `call.extractors` | fields | additive | data |

`call.extractors` would add fields a call is read for. What a call is already read for is `calls.model` ("Calls").

A new point is one registry entry, its grammar in the parser, and one reader that calls `enabledFor`. The registry, the enablement table and the Customization page don't change.

### Model points

A model point holds the numbers behind a score or a policy. It is exclusive, and its contribution is data: typed settings with limits, and any built-in tables the point reads. No recipe code runs, so a query, a mutation and the browser all read the same values. `MODEL_POINTS` in `recipes/models.ts` defines the model points with one `modelPoint` factory. Each one declares:

- the settings it reads, each with the kernel's bounds (`Bound`). A recipe's own limits must sit inside them, so `healthAccountsScored` can't be set past 200, the most one health mutation can score inside Convex's read limit;
- its built-in tables, each with its columns and a `configure` that checks the rows;
- the partials it reads, if any: prose under `{partial=…}` headings inside the model's heading, rendered against the settings in force;
- `values`, which turns the settings in force, the tables and the prose into the typed shape its surface reads (`ForecastModel`, `HealthModel`, `LeadModel`, `FitModel`, `HeatModel`, `HygieneModel`, `CallsModel`).

A recipe writes a model contribution as a heading, `# Forecast {model=forecast.model}`. Under it go a settings table with the same columns as `## Settings`, and the point's tables. The settings join the recipe's settings, so a workspace edits them as revisions of that recipe in the same settings sheet, and an agent proposes changes to them the same way. canon-base groups each point's settings under the point's title.

`modelSettings(ctx, orgId, point)` in `convex/lib/recipes.ts` is the one read. It takes the recipe `enabledFor` returns at the point, puts the workspace's current revision for that recipe on top of its defaults, and returns `modelValues`. A workspace that never chose gets canon-base. Browser code never builds the values. Each surface's query sends them:

| Point | Read by | Sent to the browser by | canon-base's tables |
|---|---|---|---|
| `forecast.model` | `forecasting.getCurrentForecast`, `getForecastByRep` | `deals.context` (`forecast`) for the Revenue page; `getCurrentForecast` (`model`) for `/api/gtm/pipeline` | none |
| `health.model` | `customerHealth.generateFromCrm` | `customerHealth.context` (`bands`) | `canon.health`: points per part of the score |
| `scoring.lead` | `leadScoring.ensureActiveModelInternal` (the first model's rules and grades), `scoreContactsBatchInternal` (the owner points) | `leadScoring.context` (`template`) for the new model form | `canon.leadRules`: field, operator, value, points |
| `scoring.fit` | `icps.rescoreOrg` (each gate's weights through `specGate`), `icps.pointsOfView` (each ICP's buyer), `icpTree.counts` (each ICP's gate, through `icpTree.treeForOrg`) | `icps.list` (`buyerLevels`) for the deal page's buyer filter | none |
| `signals.heat` | `signals.heatByDomain`, `forAccount` | `signals.forAccount` (`model`) for the score history | none |
| `hygiene.policy` | `hygiene.preview`, `createPlanForRule`, `healthSnapshots` capture, through `hygiene.modelFor` in actions | none | none |
| `calls.model` | `callIntelligence.analyzeCall`, `analyzeImportedCall` (the insight phrases); `callFacts.context` (the definitions), for `callFactActions.propose` | none | none; five partials |
| `abm.model` | `abm.listCandidateAccounts`, `generateFromCrm` (through `convex/lib/abm.ts`) | none | none |

`scoring.fit` holds the points `icpToWeights` gives an ICP: the base, industry and country weights by rank (`ints` settings, so a list like `40, 34, 30` where every rank past the list takes the last), the central, inside and adjacent size bands, the points for a size Canon's band list doesn't know, and the levels a buyer has when an ICP picks none. Signup research has no workspace yet, so it ranks on canon-base's defaults. Version 1 of a workspace's ICP history, the weights its claimed session scored with, reads the defaults too. The gate formula, `isBuyer` and the title patterns stay the kernel's, because the record service compiles them to SQL. The base is at least 1, so every gate's perfect match has points: the record service refuses a gate whose maximum is 0. A size band the ICP names keeps its weight when that weight is 0, and only a size Canon's band list doesn't know earns the unlisted points.

A revision that changes the fit values in force rescores the workspace. `writeRevision` in `convex/recipes.ts`, which saving, reverting, approving a proposal and upgrading all go through, compares the point's values before and after and schedules `icps.rescore` when they differ. Switching the recipe at `scoring.fit` schedules it too. A rescore reads the settings when it runs, so it lands on whatever is in force by then. Score history stays as it was: each `icpVersions` row stores the weights and gates it scored with, and the same set again records no new version. Saves are a person's, one at a time behind the base-revision check, so the rescore isn't debounced.

The hygiene policy reaches the engine through `mergePolicy` (now in `engine/src/policy.ts`, free of Node imports), in Convex only. The engine CLI still reads `fullstackgtm.config.json`. Severity weights stay the kernel's, because changing them would rewrite every workspace's health trend. The ranking that picks which accounts a health run scores, the heat sources' fetch limits and the lead score's 0 to 100 clamp stay the kernel's too.

`scripts/model-check.ts` is the equivalence lever. `tests/fixtures/model-equivalence.json` froze 116 cases from `origin/main` 9014e65d, before the constants moved. They cover the forecast at each coverage boundary, health with and without customer signals and past the 50-account cut, every default lead rule on both sides of its value, heat and growth, and the audit of the demo and sample snapshots and a stale-days fixture. 20 more froze the ICP fit before `scoring.fit`: the weights, gate and buyer of ICPs with one to four industries, odd and even band sets, gapped and unlisted bands, and ten accounts against each gate, all of them at once and as score history reads them. On canon-base's settings each one returns the same output, and `tests/modelEquivalence.test.ts` holds them to it.

### Calls

`calls.model` holds the methodology in how Canon reads a call. canon-base contributes it under `# Calls {model=calls.model}`.

**What the answers mean.** After a meeting, `conversationFactsPrompt` (`convex/lib/conversations/facts.ts`) asks a model for the deal's next step and close date, job titles, company names, a new opportunity when no deal matched, and the other company and the people it names. Five partials under the model's heading say what an answer means: `calls.nextStep`, `calls.closeDate`, `calls.otherCompany`, `calls.mentionedPeople` and `calls.opportunity`. The kernel writes the rest of the prompt around them: the meeting and its deal, the people on record, each field's name, what to return when a field isn't asked for, the titles and company names lines, the word-for-word evidence rule and the transcript. `CONVERSATION_FACTS_SCHEMA`, the quote gate (`groundedFacts`, `groundedSuggestionRead`), the caps and the `whoIs` prompts stay the kernel's, so a recipe changes what the model looks for, never what Canon keeps. A recipe at this point writes all five partials. The prompt carries no version or fingerprint.

**Insight phrases.** Every call is also read without a model (`extractCallInsights` in `engine/src/calls.ts`). Each insight category's keywords are a `phrases` setting: `callPainPhrases`, `callObjectionPhrases`, `callCompetitorPhrases`, `callNextStepPhrases`, `callFeaturePhrases`, `callPricingPhrases`, `callCriteriaPhrases`, `callRiskPhrases` and `callFillerPhrases`. A workspace adds its own competitors to `callCompetitorPhrases` in canon-base's settings sheet, under Calls, and the next call it analyzes uses them. A category's title, confidence and importance stay the kernel's. The engine CLI keeps its own keywords; Convex passes the workspace's to `extractCallInsights`, which has no Node imports.

`scripts/model-check.ts` checks this point too, against `tests/fixtures/calls-equivalence.json`, frozen from `origin/main` ad398cac before the methodology moved: the prompt for 35 contexts (the `tests/callFacts.test.ts` context and every combination of a deal, mentions, an opportunity, new domains and new people), the insights of 34 transcripts (the test transcripts, one line per keyword and a seeded sweep), and 3 calls analyzed through `analyzeImportedCall`. All 72 are equal on canon-base's settings.

### Theme point (workspace.theme)

A recipe's theme is one ` ```theme ` block mapping keys to a colour or `{ setting: key }`. The keys are `paper`, `surface`, `ink`, `primary`, `provenance`, `destructive`, `warning`, `headings` (`serif` or `sans`) and `radius` (`0`, `2`, `4`, `6` or `8`). A key it leaves out takes Ledger's value. A binding names a `color` setting, or a `choice` setting whose options are that key's values. Those two setting kinds exist for themes: `color` takes `any` as its limits and a `#rrggbb` default, and `choice` takes its options, comma-separated.

`recipes/theme.ts` derives every CSS variable the app reads from those nine values: lines and fills are the ink mixed into the surface, and secondary text and button labels move until they pass 4.5:1. A save that would leave the page dark, body text under 7:1 on the surface, or a colour mark under 3:1 is refused with what to change, and a stored theme that fails anyway (a package's literal, say) renders with Ledger's value in its place. The dashboard shell reads the enabled theme (`recipes.theme`) and sets it on `<body>`, so dialogs take it too. The marketing site stays on Ledger.

Canon's built-in theme is `canon-ledger`, which binds every key to a setting, so an admin or manager tweaks the workspace's look from its Settings on the Customization page, with a live preview. A package can't be theme-only yet: an installed package still needs a deal page with plays.

### Install and enable

Installing a package makes its contributions available. Turning one on is a separate decision, per workspace and per point. An exclusive point has exactly one contribution in force. An additive point has any number.

What's on is stored in `recipeEnablements`: `{ orgId, point, recipeId, contributionKey, enabled, by?, at }`, one row per workspace, point, recipe and contribution once someone has turned it on. Turning it off keeps the row with `enabled: false`, so the table says who changed what. `by` is absent when Canon set it, at a workspace's creation. `contributionKey` is the contribution's key within the recipe and point, `page` for a page and a field's slug for a field.

`enabledFor(ctx, orgId, point)` in `convex/lib/recipes.ts` is the only read of it. For an exclusive point it returns one contribution: the enabled row, else the workspace's `dealPageRecipe` field for a workspace from before the table, else the point's `unset` default. For an additive point it returns every enabled row, and each contribution of a `defaultOn` recipe that has no row. A row whose recipe is no longer installed is skipped with a warning. `orgRecipe`, the Customization page, `/mcp` and uninstall all read through it.

`enableContribution` and `disableContribution` in `convex/recipes.ts` are the only writes. Both go through `requireDecider`, so an admin or manager decides and an agent never does, and both are human-only (`src/lib/gtm-human-only-mutations.ts`). Enabling at an exclusive point turns off the one in force. Enabling at an additive point refuses a contribution the point says conflicts with one already on. An exclusive point can't be turned off, only switched. The planning is pure, `planEnable` and `planDisable` in `recipes/points.ts`. Agents read the same state with `canon_customization list_contributions`.

Uninstalling a package refuses while any of its contributions is on. Turning a template off first leaves the rows it made.

**Layers.** Each point resolves Canon's default, then the installed package, then the workspace's settings revisions for that recipe (R2). A rep layer isn't built. It would sit in `enabledFor`, after the workspace's row, keyed by user, and only for points that mark themselves rep-overridable.

**Narrowing `dealPageRecipe`.** The schema change shipped as a widen. `organizations.dealPageRecipe` is still in the schema and still read as the fallback, but nothing writes it. A human-run migration then:

1. inserts a `deal.page` row for every workspace without one, naming `dealPageRecipe` when it is set and `fsgtm-enterprise-deal` when it isn't;
2. once no workspace lacks a row, sets `POINTS["deal.page"].defaults.unset` to `canon-base` and deletes the `LEGACY` fallback in `convex/lib/recipes.ts`;
3. after that deploys, drops `dealPageRecipe` from the schema in its own PR, clearing the field from every document first.

## The kernel

Six primitives. Each already exists, built for one feature.

| Primitive | What it is | Today |
|---|---|---|
| **Records** | Objects, fields and edges, each value with a receipt | CP0 ledger and registry, `objectDefs` |
| **Observations** | Dated events with a verbatim quote | `observations` |
| **Tools** | One governed set of actions, the same for people and agents | `/mcp` user parity, patch plans |
| **Agents** | An owned identity with a scope, triggers, a budget and turns | `agents`, `researchAgents`, `agentTurns` |
| **Gates** | Approvals, grants, ICP gates, evidence checks | `agentGrants`, ICP gates, the verbatim quote check |
| **Surfaces** | Named slots on Canon pages | Not yet. Pages are hard-coded |

Two kernel pieces are missing and recipes need them:

- **Versioned specs.** Org agents' design describes spec revisions, but they
  aren't built. The `agents` table has no revision field, and `researchAgents`
  questions are edited in place. A recipe's installs, forks and agent-written
  changes all need revisions with a diff and an author. The only versioned
  per-org extension point today is `objectDefs.registryVersion`.
- **Slots.** `deal.page`, `account.page` and `contact.page` are points
  ("Points"). Their sections, their order and folding, and their buttons come
  from the recipe; `PageSections` (`src/components/records/page-sections.tsx`)
  draws them.

The test for adding to the kernel: if a recipe can't express something, either
the kernel is missing a primitive (add it on purpose) or the feature has the
wrong shape. Methodology never goes into the kernel.

### Kernel, permanently

Some things no recipe will ever contribute, whatever points are added. Each would let one author's package weaken what every tenant relies on.

| Stays in the kernel | Why |
|---|---|
| Records, their receipts and the ledger | Every value keeps its provenance. A recipe that stored values its own way would fork the truth a workspace reads. |
| Writes and their gates: approvals, grants, CAS, the verbatim quote check, signed write plans | A recipe proposes and the kernel decides. If a recipe could define a write, a package could step around a gate. |
| Tenant isolation, roles and permissions | Recipe code runs next to many tenants' data. Who sees what can't be methodology. |
| Install and enable decisions (`requireDecider`) | A person decides what runs in their workspace. A recipe or an agent turning itself on would defeat the install screen. |
| Sending email, LinkedIn and calls, with their compliance checks | A message leaves as a person. Caps, consent and do-not-contact are duties, not taste. |
| Model spend and billing (`resolveLlm`, credits) | Who pays is the workspace's and the acting person's, never the author's choice. |
| The isolate and its wire: no network, no secrets, signed requests | The sandbox is what makes running a stranger's recipe safe. |
| Ceilings (`CEILINGS`) and scheduling (the keeper tick, leases) | They bound what one run costs and how much load a workspace makes. |
| The component vocabulary and the action registry | Pages stay on-style and accessible, and every button runs a kernel action with a known gate. |
| The points registry itself | A point is a promise about where a contribution shows and what it may touch. Adding one is a kernel change, reviewed like one. |

### Methodology and kernel

What the FSGTM recipes say, and what the kernel keeps whatever a recipe says:

| Methodology: the recipe's | Kernel |
|---|---|
| Every prompt, and what each field of the model's answer holds (```` ```output ````) | The answers' shapes, which Canon stores and screens: the draft, the review, the account plan (`convex/lib/plays/runs.ts`) |
| How often the keeper researches the account (`researchEveryDays`, `newQuestionsAfterDays`) and its people (`peopleResearchEveryDays`), and how many buyers (`peopleResearchBuyers`) | The hourly tick, a check per play every 20 hours, 8 plays a tick, a failed run's day before retrying, a stalled run's 10 minutes |
| A research run's searches, reads per search and pages (`researchSearches`, `researchReads`, `researchPages`) | Ceilings of 5, 3 and 18 (`CEILINGS` in `recipes/kernel.ts`), the 5-minute run, 5 questions a run, 8 plan steps, the prompt's page budget |
| How many verified facts and touches a draft gets (`draftFacts`, `draftTouches`) | Ceilings of 20 each; which facts count as verified (the quote gate) |
| Which channel a first touch goes on (`firstTouchChannels`) | Whether Canon can reach a person there (an address, a profile) |
| Jev's remit and buyer-fit questions | The left, right or tie the buyer order reads; the ranking cache |
| Settings, page, actions, rules, checks, evals | Storage, the evidence gates, approvals and grants, sending, 25 people a request, 5 first touches a call |

A ceiling holds at three places: a binding to a setting whose limits go past
it fails the build and the install (`bindingProblems`), plays data past it
fails `parseManifest`, and the kernel caps the value where it runs. A package
stored before its recipe could say these runs FSGTM's values, which were the
kernel's, until it upgrades (`refOf` in `recipes/index.ts`).

## The package

A package is a repo, or a directory in one. `recipe.md` is required; a recipe
with TypeScript also ships its bundle:

```text
velocity-deal/
└── recipe.md          settings, page, actions, prompts, logic and evals ("Writing a recipe")

enterprise-deal/
├── recipe.md
└── dist/recipe.js     its TypeScript, bundled: one ESM module exporting run(settings, calls)
```

A recipe written only in markdown runs on Canon's built-ins and needs no build
step from its author. Canon reads `recipe.md` at preview and at install, in an
action, and pairs it with its built-ins bundle (`BUILTINS_BUNDLE` in
`recipes/_bundles.generated.ts`, with the recipe in place of its placeholder).
The same `recipe.md` on the same built-ins gives the same bundle and hash, and
an installed package keeps the bundle it was installed with, so a later change
to Canon's built-ins doesn't move it.

`scripts/recipe-package.ts <recipeDir> <outDir>` makes a package from a
directory holding `recipe.md` and any `.ts` files. It writes `recipe.md`, and
`dist/recipe.js` when there is TypeScript. It first checks the recipe as an
install would and runs its evals on the code it will run. If anything fails,
it writes nothing. FSGTM's recipes live in this repo under `recipes/`, so
they're reviewed and their evals run in CI. A public repo holds only the
package.

The manifest (`recipes/manifest.ts`, `Manifest`) is the stored, validated form.
An install reads it from `recipe.md`:

```jsonc
{
  "id": "@fsgtm/velocity-deal",          // namespaced; first-party ids have no @
  "version": "2.0.0",                    // semver
  "title": "Velocity deal",
  "description": "...",
  "author": { "org": "fsgtm", "kind": "agency" },
  "engines": { "canon": "3" },             // the recipe format ("Format changelog")
  "permissions": {                        // what the install screen shows
    "read": ["deal", "contact", "account", "observations", "icps"],
    "slots": ["deal.page"],               // the points it contributes to, from contributes
    "llm": "owner",                       // prompts run on the rep's own plan
    "sources": ["web_search", "read_site"]
  },
  "settingsSchema": [ /* the kernel's descriptors: int, number, roles, channels, phrases, text */ ],
  "defaults": { "quietDays": 5, "emailMaxWords": 60, ... },
  "dealPage": [ { "component": "queue", "title": "Queue" }, { "component": "fanOut", "title": "Get a reply", "when": { "stage": ["in"] } }, ... ],
  "evals": [ { "name": "...", "description": "...", "call": { "fn": "drafts.check", "input": [...] }, "expect": ... } ],
  "data": { ... }                         // the plays data, below
}
```

The bundle has the same contract as `recipes/_bundles.generated.ts`:
`run(settings, calls)` takes the full settings in force and a batch of play
calls (`recipes/run.ts`), and returns one result per call.

### Data and bindings

Queries and mutations need some of a recipe's plays without running its code:
the core roles, the quiet window, stage labels and exits, which channels get
drafts, the people research fields, `centerMinConfidence`. That is `data`
(`PlaysData` in `recipes/kernel.ts`). Each bindable value is either a literal
or a binding, `{ "setting": "<key>" }`, which takes the workspace's value of
that setting:

```jsonc
"data": {
  "coreRoles": { "setting": "coreRoles" },
  "quietDays": { "setting": "quietDays" },
  "stages": { "in": { "label": "Get a reply", "exit": "The buyer replies and agrees to a call." }, ... },
  "drafts": { "channels": { "setting": "draftedChannels" }, "reviewed": { "setting": "reviewedChannels" },
              "perCheck": { "setting": "draftsPerCheck" }, "aheadDays": { "setting": "draftAheadDays" },
              "facts": { "setting": "draftFacts" }, "touches": { "setting": "draftTouches" }, "firstTouch": { "setting": "firstTouchChannels" },
              "output": { "subject": "Email subject, {{minus settings.subjectMaxWords 4}} words or fewer. …" }, "review": { "relevant": "…", ... } },
  "research": { "everyDays": { "setting": "researchEveryDays" }, "newQuestionsAfterDays": { "setting": "newQuestionsAfterDays" },
                "searches": { "setting": "researchSearches" }, "readsPerSearch": { "setting": "researchReads" }, "pages": { "setting": "researchPages" },
                "output": { "whyNow": "…", "alphaHypothesis": "…", ... } },
  "people": {
    "fields": [ { "slug": "primary_goal", "label": "Primary goal", "kind": "qa", "answerType": "text",
                  "question": { "setting": "primaryGoalQuestion" } }, ... ],
    "refresh": "monthly",
    "slugs": { "employed": "still_at_company", "goal": "primary_goal", "systems": "responsible_systems" },
    "center": { "type": "choice", "instructions": "...", "criteria": { ... } },
    "centerMinConfidence": { "setting": "centerMinConfidence" },
    "capability": { "tool": "new_capabilities", "schema": { ... } },
    "everyDays": { "setting": "peopleResearchEveryDays" }, "buyers": { "setting": "peopleResearchBuyers" },
    "fit": { "type": "choice", "instructions": "...", "criteria": { "left": "…", "right": "…", "tie": "…" } }
  }
}
```

`resolveData` replaces each binding with its value. It is a walk over plain
data, so it runs in queries and in the browser, and no recipe code runs. A
binding may sit only where `BINDABLE` allows, and only on a setting of a
matching kind: `quietDays` binds an `int`, `coreRoles` a `roles` setting, a
field's `question` a `text` setting. In `recipe.md` the data is its
```` ```stages ````, ```` ```data ```` and ```` ```people ```` blocks, three
prompt headings and the prompts' ```` ```output ```` blocks ("Writing a recipe"), the same for first-party recipes and
packages. A first-party recipe's code runs in-process; an installed recipe's
code is its bundle.

### Templates

A template is a row a recipe ships for a workspace to install: a report, a dashboard, a paused automation, an ICP, a pipeline or a LinkedIn cadence. A recipe writes each in its own block, its spec in YAML's subset or as JSON:

````markdown
```template kind=report key=open_by_owner_stage
name: Open deals by owner and stage
spec:
  object: deal
  filter: [{ field: isClosed, op: eq, value: false }]
  groupBy: [{ field: ownerId }, { field: stage }]
  measures: [{ fn: sum, field: amount }, { fn: count }]
  chart: bar
```
````

A template contribution is `{ kind, key, title, spec }` (`Template` in `recipes/templates.ts`). Its key is unique within the recipe and kind, and its title is the spec's `name`. Each kind is an additive point, `templates.<kind>s`, so the recipe lists it in `contributes` like any other point. Two recipes' templates never conflict: the key is per recipe.

The registry has two halves. `TEMPLATE_KINDS` in `recipes/templates.ts` is pure and holds, per kind, the spec's Convex validator, its checks past the shape, the state its rows install in and who may install them. `INSTALLERS` in `convex/lib/templates.ts` writes the row.

| Kind | Spec | Checked with | Installs | Who installs |
|---|---|---|---|---|
| `report` | `{ name, spec }`, a report spec | `reportSpec`, then `compileAggregateRequest` on a new workspace's fields; `checkSpec` on the workspace's own at install | shared | admin or manager |
| `dashboard` | `{ name, tiles: [{ report, wide }] }`, each tile a report template's key in the same recipe | every tile names one | shared, its reports installed first | admin or manager |
| `automation` | `{ name, object, trigger, conditions, actions }` | the rule validators, `conditionsProblem`, `actionProblem`, `scheduleProblem`; `checkRule` at install | paused, acting as its installer once resumed | admin |
| `icp` | `{ name, description?, pointOfView?, offer?, spec }` | `icpSpecValidator`; `cleanSpec` at install | inactive, unless it is the workspace's first, which is always its default | admin or manager |
| `pipeline` | `{ name, stages: [{ label, probability, forecastCategory }] }` | `planPipelineSave` for a new pipeline | a new pipeline with its own new stages | admin or manager |
| `cadence` | `{ name, steps }` | `validateSteps` on the most generous LinkedIn plan; the sender's own plan when it is made | offered: no row until someone starts a cadence from it on their own sender | admin or manager |

A template spec can't name a workspace's ids, so an automation gives tasks and records only to the record's owner. A bad spec is an error at its block's line in `parseRecipe`, and `parseManifest` checks a stored package's templates the same way.

**Enable means install.** `enableContribution` on a template point installs it as the decider (`requireDecider`, human-only), who is the row's `createdBy`. The install is once per workspace, recipe and key. It is recorded on the contribution's `recipeEnablements` row as `installed: { version, at, rowId? }`, and a row with `installed` is never installed again. So turning a template off and on again makes nothing new, and a row the workspace deleted stays deleted. Turning a template off stops offering it (a cadence template leaves the new cadence form) and leaves the rows it made. They stay when the package is uninstalled.

**Provenance.** Every installed row carries `recipe: { id, version, key }`: `reports`, `dashboards`, `automationRules`, `icps` (with `source: "recipe"`), `dealPipelines` and `linkedinCadences`. Canon's own reports and dashboards also keep `builtIn: <key>`, as rows seeded before templates have, so the two stay one set. The Customization page shows each template under its point with what it installed, linked, and its version; the report builder and the automations list say which recipe a row came from.

**Upgrades never rewrite a row.** Once installed, a row is the workspace's. A recipe version whose template spec changed affects only installs after it; Canon never writes to an installed row again, edited or not. The Customization page shows the version a row came from next to the one the recipe offers now. A three-way merge like settings' would need each kind to diff its row against the spec it came from, and no workspace has asked for one.

**Canon's built-ins.** `canon-base` contributes the seven reports and the Revenue and Activity dashboards that `dashboards.ensureSeeded` seeded, and both template points list it as `defaultOn`. `templates.ensureDefaults` installs every default-on template that isn't installed or turned off, as whoever opens Dashboards (an agent calls it as `canon_dashboards seed`). It checks each template, so a dashboard installed early from Customization doesn't hold back the rest, and a dashboard leaves out a report the workspace turned off before it was installed. The Customization page offers a default-on template's switch before it installs, so it can be turned off first. For a workspace seeded before templates, a canon-base template takes over the row with its `builtIn` key and makes nothing; when the workspace deleted that row, it records the install with no row, so it stays deleted. `tests/fixtures/built-in-seed.json` is what `ensureSeeded` wrote, and the new path writes the same.

**Default pipeline stages stay in code.** `defaultConfig` in `convex/lib/pipelines.ts` isn't a list of stages. It gives a probability and forecast category to every stage no pipeline claims, by its name and position, including one a CRM sync adds later, and it backs the virtual default pipeline of a workspace that stored none. A template installs a row once; this rule runs on every read.

### Fields

An AI field is a question Canon researches on accounts or contacts, answered per record as a `custom.<slug>` fact. A recipe ships its fields in one ```` ```ai-fields ```` block, a list in YAML's subset:

````markdown
```ai-fields
- slug: primary_goal
  label: Primary goal
  object: contact
  kind: qa
  answer: text
  question: { setting: primaryGoalQuestion }
  judgment: true
  refresh: monthly
  autoAccept: 0.8
  replaces:
    - "What is this person's primary goal at their current company? …"
```
````

A field contribution is `RecipeField` in `recipes/fields.ts`, stored as `fields` on the manifest:

| Key | Means |
|---|---|
| `slug` | Its attribute, `custom.<slug>`: 1 to 48 of `a-z`, `0-9` and `_`, starting with a letter. The contribution's key. |
| `label` | Its name in AI fields and on record pages, 1 to 80 characters. |
| `object` | `account` or `contact`. |
| `kind` | `classify` (one of its `options`) or `qa` (a free answer). |
| `question` | 8 to 1,000 characters, or `{ setting: <key> }`, a text setting of the recipe, so an admin can reword it. |
| `options` | A classify field's 2 to 12 answers, each `{ key, label, description? }`; `unknown` is Canon's. |
| `answer` | A qa field's `text`, `number` or `boolean`; `text` when absent. Stored as `answerType`. |
| `judgment` | No page states it outright, so it is answered as a cited inference. |
| `refresh` | `weekly` or `monthly`: how often its answers are asked again, on its owner's plan. Never when absent. |
| `autoAccept` | The suggested Jev confidence answers are auto-accepted at, from 0.5 to 1. |
| `replaces` | Earlier default questions: a workspace field still asking one moves to `question`, and its answers start over (`questionSince`). |

Each field is one contribution to the additive `fields` point, keyed by its slug. Turning one on (`enableContribution`, a decider, human-only) makes its `researchAgents` row through `ensureField` in `convex/researchAgents.ts`:

- **The slug is the field.** A workspace has one field per slug, from any recipe or from a person, and a recipe that finds one uses it as it is, with its answers. That is on purpose: FSGTM's people fields keep their facts when a workspace switches between its two deal recipes. A field no recipe made yet takes the recipe's provenance; one from another recipe keeps its own.
- **Slugs stay bare, with provenance.** The row carries `recipe: { id, version, key }`, the same provenance templates write, and the slug isn't prefixed. A prefix would give FSGTM's fields new attributes and leave their answers behind. The conflict rule is the point's: two recipes can't both have a field on under one slug. Turning on the second is refused, naming the field.
- **The person who turns it on owns it.** Its agent (`ensureFieldAgent`) is theirs, and its refreshes run on their plan.
- **Auto-accept needs an admin.** An admin's install auto-accepts at the field's `autoAccept`; a manager's, or a field with none, reviews every answer. An admin changes it later on AI fields, as for any field.
- **A deleted field stays deleted.** Its agent's ledger key (`research:<slug>`) outlives it, so turning the field on again makes nothing, and the Customization page says so.
- **The workspace holds 50.** Past `MAX_AGENTS` turning one on is refused with the field's name, and people research names it among the fields it skipped.
- **Turning one off leaves the row.** It stops people research from using it; the answers stay the workspace's. They stay when the recipe is uninstalled too.

How a field is researched stays in the kernel: `stepPrompt`, the evidence gate, the agent loop's limits and `PROMPT_VERSION`.

**People research.** The ```` ```people ```` block names its fields by slug, with the role each plays: `- { slug: primary_goal, role: goal }`. People research runs the deal page recipe's people fields. One nobody has decided on is turned on the first time it runs, by whoever ran it, unless another recipe's field with the slug is on, whose row it shares. One someone turned off on the Customization page is skipped and named. A field written inline in the people block, as recipes wrote them before this point, is a field of that recipe too (`fieldsOf`), on contacts, refreshing on the people block's cadence and auto-accepting at 0.8, as people research always made it. So a package stored before fields were a point runs its people research the same way.

**Where it shows.** The Customization page lists every recipe's fields under the `fields` point, each with its switch and the field it made, or that it was deleted. AI fields (`/dashboard/fields`) says which recipe and version each field came from. Agents read the same with `canon_customization list_contributions`.

### What an install checks

An install, a preview and an upgrade refuse the package, with every reason,
unless:

- `recipe.md` parses with no errors (each one names its line), its id is
  `@scope/name` and not first-party, and it has plays;
- its `engines.canon` is the format this Canon reads, `RECIPE_FORMAT`
  (`recipes/kernel.ts`). A recipe written for another format is refused with
  one line naming both formats, before the rest of it is read;
- the manifest it gives passes `parseManifest`: the version is semver; each settings descriptor has a known kind and sane
  limits, and each default passes the kernel's own `checkSetting` (phrase
  defaults also pass the backtracking guard and the timing probe in
  `recipes/regex.ts`); every deal page section names a kernel component and
  every eval calls a known play function; every binding names a real setting
  of the right kind at a bindable place, and `data` resolved on the defaults
  has the exact `PlaysData` shape;
- a package without `dist/recipe.js` names no code: every ```` ```logic ````
  line runs a Canon built-in, and it has no ```` ```ts ```` blocks;
- a package with `dist/recipe.js` answers `recipe.about` in the runtime with
  the hash of this `recipe.md` and exactly the names it uses, no more and no
  fewer;
- `recipe.md` is at most 256 KB and the bundle at most 1 MB.

### What a recipe can contribute

The three pages, the theme, the model points, `fields` and the six template points are registered ("Points", "Model points", "Fields", "Templates"). Rules, checks and view models ship inside the deal page's plays (`canon.rule`, `canon.check`, `canon.viewModel` in `recipes/builtins.ts`), not as points of their own. The rest of this table is what the planned points will carry. `docs/customization.md` lists what a workspace can change on every surface.

| Contribution | Shape | The deal page piece it replaces |
|---|---|---|
| **Skill** | Markdown the model reads in a turn: principles, rubrics, prompts | `draftPrompt`, `reviewPrompt`, `planPrompt`, `briefPrompt`, `capabilityPrompt` |
| **Field** | An AI field: slug, object, kind, question, answer type, refresh, a suggested auto-accept ("Fields"). Built. | `PEOPLE_FIELDS` (still at company, primary goal, responsible systems) |
| **Signal** | A Signal agent spec | none yet |
| **Rule** | A pure function from a snapshot to flags, each flag with a severity and an optional proposed step. Built inside plays: `keeper: rule` runs `canon.keeper` or a recipe's own. | `keeperReport` (now `canon.keeper`); `CORE_ROLES` and `QUIET_DAYS` are the `coreRoles` and `quietDays` settings |
| **Check** | A pure function from a draft to pass/fail lines | `checkDraft`, the phrase checks |
| **View model** | A pure function from a snapshot to the data a slot shows | `prepReport` (verdict, missing checks, questions), `fanOut`, `stageOf` |
| **Tool** | An action an agent can call, built on kernel tools | none yet |
| **Slot** | A declarative spec placing Canon components, bound to view models, with their actions | the sections of `Plane` in `deal-play.tsx` |
| **Setting** | A typed value an install exposes, with a default | the constants above, made editable |

Rules, checks and view models are **pure**. They take a snapshot Canon builds
(the deal, its people, their observations, the play, the matching ICPs) and
return data. That's already true of the code in `convex/lib/plays/`: its
header says "Pure: the model call is injected." Purity is what lets a rule run
for $0 on every read, be tested from `evals/` without a workspace, and run in
an isolate with no capabilities at all.

Model calls happen only in agent turns and in tools, through `canon.llm`. It
bills the recipe owner's or the acting user's ChatGPT plan through
`resolveLlm`. There's no server-key fallback, as for org agents.

## Writing a recipe

A recipe is one `recipe.md` that a person or an agent writes, the way a pi
skill or a bb plugin README is written, plus optional TypeScript for logic
markdown can't express. A less technical author writes markdown only and
configures Canon's built-ins. TypeScript unlocks the rest, the way a pi
extension registers tools and hooks through `ExtensionAPI`. Both compile to
the same target: a `RecipeDefinition` (`recipes/kernel.ts`) and a bundle
exporting `run(settings, calls)`.

The first-party recipes are written this way:

| Directory | Holds |
|---|---|
| `recipes/canon-base/` | `recipe.md`: Canon defaults. The default deal page with fields in sections and no plays, the built-in reports and dashboards, and every model point's settings and tables |
| `recipes/fsgtm-enterprise-deal/` | `recipe.md` on Canon's built-ins, and `fsgtm.ts` for FSGTM's own two draft checks |
| `recipes/fsgtm-velocity-deal/` | `recipe.md` only, on Canon's built-ins. From v3.0.0 it contributes to several points at once: the deal page, four AI fields (one on the account, Sales motion), a report, a paused automation and the `scoring.lead` model |

`scripts/build-recipes.ts` builds them into `recipes/_recipes.generated.ts`
(each recipe compiled, importing its `.ts` files) and
`recipes/_bundles.generated.ts`, since Convex and the app can't read markdown.
`recipes/md/parse.ts` reads `recipe.md`. It is pure and has no dependencies,
so the same parser runs in a Convex action at install time.

### recipe.md

**Frontmatter.** `key: value` lines between `---` lines, lists and maps
written inline. Every value stays a string, so `version: 1.10` is "1.10".

```yaml
---
id: "@fsgtm/velocity-deal"          # first-party ids have no @
version: 2.0.0
title: Velocity deal
description: A transactional or SMB deal one rep runs. …
author: { org: fsgtm, kind: agency }
engines: { canon: "3" }             # the recipe format it is written in
contributes: [deal.page]            # the points it adds to ("Points")
permissions: { read: [deal, contact, account, observations, icps], llm: owner, sources: [web_search, read_site] }
---
```

**Settings.** A `## Settings` heading and one table, one row per setting, in
form order:

```markdown
| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| quietDays | int | 5 | 1 to 365 | Keeper | Quiet after (days) | No touch either way in this many days reads as quiet. |
| closeProbability | number | 0.4 | 0 to 1 by 0.05 | Stage and prep | Close at probability | A deal at this probability or above … |
| coreRoles | roles | champion | executive, n1, champion, user, procurement, security, signer | Keeper | Core roles | … |
| pitchPhrases | phrases | `\b(our (platform\|product)\|demo)\b` | up to 500 characters | Draft checks | Pitch phrases | … |
| primaryGoalQuestion | text | What is this person's primary goal … | 8 to 1000 characters | People research | Primary goal | … |
```

| Kind | Limits | Default |
|---|---|---|
| `int` | `<min> to <max>` | a whole number |
| `number` | `<min> to <max> by <step>` | a number |
| `roles`, `channels` | the options, comma-separated | some of them, comma-separated |
| `phrases` | `up to <n> characters` | a case-insensitive pattern, in backticks |
| `text` | `<min> to <max> characters` | the text |
| `bool` | `true or false` | `true` or `false` |
| `rules` | the audit rule ids to choose from, comma-separated | some of them, comma-separated, or none |

A `|` inside a cell is written `\|`. Each default passes the kernel's
`checkSetting`, and a phrase default passes the regex guard and the timing
probe in `recipes/regex.ts`.

**Headings are the page.** A heading with `{section=<component>}` is a section,
shown in file order, the play's sections and the record's alike: one renderer
walks the page and maps each component to its React component. `when="stage = in"`, `when="stage != in"` or
`when="stage in [case, close]"` limits it to stages, and `collapsed=true`
folds it, and `show="health, amount"` draws only those of its component's
parts. Components are the kernel's vocabulary (`queue`, `summary`,
`stageRail`, `fanOut`, `prep`, `plan`, `keeper`, `brief`, `accountMap`,
`touches`, `fieldGrid`) and the record's pieces (`header`, `fields`,
`timeline`, `history`, `related`, `products`, `splits`, `apps`). Everything
on a deal's page is a section, its header included. A `fields` section names its fields in a
```` ```fields ```` block, and `rest` takes every field no section names, so a
workspace's custom field always shows. `{panel=<id>}` names a part of a
section, such as the draft panel.

**Record pages.** A `{page=account}` or `{page=contact}` heading starts that
object's page, and the sections under it lay it out; sections under no page
heading are the deal's. Each object has its own components:

| Page | Components |
|---|---|
| deal | the play's, and `fieldGrid`, `fields`, `timeline`, `history`, `related` |
| account | `header`, `fitBar`, `fields`, `whyFit`, `scoreHistory`, `timeline`, `topSignals`, `companyDeals`, `peopleAcrossDeals`, `related`, `history` |
| contact | `header`, `fields`, `aiFields`, `related`, `callPanel`, `composeEmail`, `timeline`, `history` |

`header` is the record's name with its actions. A `fitBar` right after the
`header` sits in it, and a `scoreHistory` right after `whyFit` sits in that
panel (`HOLDS` in `recipes/kernel.ts`). `timeline`, `history` and `related`
draw what their object has: a company's timeline holds its signals and deals,
its related records are its people, parent and children, and a person's are
their companies and deals. The sections after a run of `fields` sections
that read beside them (`BESIDE`) share two columns. `when=` is only for the
deal page. An action id is unique on its page.

`canon-base` lays out both pages, and every workspace runs them until it picks
another recipe's. FSGTM's recipes don't lay them out. The company's page lives
at `/dashboard/accounts/<id>`; it merged the Accounts page (fit and score) and
the Companies record page, and `/dashboard/records/account/<id>` redirects to
it. `scripts/record-page-parity.ts` is the lever for both pages: it captures
every seeded account's and contact's sections, fields and controls from a
running stack, and compares two captures. Against `origin/main` 9014e65d it
found 0 differences on the 3 seeded accounts and 2 contacts, past the merge's
intended ones: the Firmographics panel (its fields are edited under Details),
the "Fit and score on the Accounts page" link, and one back link, Accounts, for
TAM and Companies.

**Actions.** An ```` ```action ```` block under a section is one button or
edit there. The page offers the section's actions in the order the file lists
them, with the recipe's labels; an action the recipe leaves out isn't offered,
and an edit in place it leaves out reads only.

````markdown
```action
id: researchAccount
label: Research account
label_after: Research again
runs: kernel.researchAccount
prompts: [research.planPrompt, research.briefPrompt]
shows: canEdit
enabled: deal.companyId && research.status != "running"
gate: every cited item's quote is found word for word on a page read, or it is dropped
```
````

`runs` names one entry of the kernel's action registry (`KERNEL_ACTIONS` in
`recipes/actions.ts`), so a recipe can't define a write. Each entry declares:

- the sections or panels it can sit in, and what it acts on in each: the deal,
  the picked people, a person's row, a step, a draft, a flag or an item;
- the Convex function it calls, and whether that writes;
- the gate that function keeps, such as "never sends; a person reviews";
- the `canon_deal_play` method an agent calls for the same thing, if any;
- `requires`, which hides it, and `ready`, which disables it, whatever the
  recipe says, because the call can't run without them (Send needs a linked
  Gmail and the person's address); `after` switches its label to `label_after`.

| `runs` | Sits in | Acts on | Calls |
|---|---|---|---|
| `nav.nextDeal` | `queue` | the queue | a link to the next deal |
| `kernel.researchAccount` | `summary` | the deal | `dealPlayActions.research` |
| `kernel.researchPeople` | `fanOut` | the picked people, else those shown | `dealPlayActions.researchPeople` |
| `kernel.firstTouches` | `fanOut` | the picked people | `dealPlayKeeper.firstTouches` |
| `kernel.firstTouch` | `fanOut` | a row | `dealPlayKeeper.firstTouches` |
| `kernel.addToCanon` | `fanOut` | a row research named | `records.upsert`, `dealCommittee.setRole`, `dealPlays.dismissItem` |
| `kernel.markDone`, `kernel.setStepOwner`, `kernel.setStepDue` | `plan` | a step | `dealPlays.saveStep` |
| `kernel.removeStep` | `plan` | a step | `dealPlays.removeStep` |
| `kernel.addStep` | `plan` | the deal | `dealPlays.saveStep` |
| `kernel.draftStep`, `kernel.redraftStep` | `draftPanel` | a draft | `dealPlayKeeper.draftStep` |
| `kernel.writeDraft`, `kernel.editDraft` | `draftPanel` | a draft | `dealPlays.setDraft` |
| `kernel.sendEmail` | `draftPanel` | a draft | `emailActions.sendToContact` |
| `kernel.saveGmailDraft` | `draftPanel` | a draft | `emailActions.draftToContact` |
| `nav.linkedinProfile` | `draftPanel` | a draft | a link to the profile |
| `kernel.queueLinkedin` | `draftPanel` | a draft | `dealPlays.queueLinkedin` |
| `kernel.checkNow` | `keeper` | the deal | `dealPlayKeeper.checkNow` |
| `kernel.planFlag` | `keeper` | a flag | `dealPlays.saveStep` |
| `kernel.setWindow`, `kernel.setBrief` | `brief` | the deal | `dealPlays.setBrief` |
| `kernel.addToDeal` | `brief` | an item naming a person | `records.upsert`, `dealCommittee.setRole`, `dealPlays.dismissItem` |
| `kernel.dismissItem` | `brief` | an item | `dealPlays.dismissItem` |
| `kernel.addItem` | `brief` | the deal | `dealPlayActions.addItems` |
| `kernel.setPerson` | `accountMap` | a person | `dealPlays.setPerson` |
| `kernel.addSuggested` | `accountMap` | a suggestion | `dealCommittee.setRole` |
| `kernel.setRole` | `accountMap` | the deal | `dealCommittee.setRole` |

On the account and contact pages:

| `runs` | Sits in | Acts on | Calls |
|---|---|---|---|
| `kernel.setStatus`, `kernel.setOwner` | account `header` | the company | `records.edit` |
| `kernel.editField` | `fields` | the record; left out, the fields read only | `records.edit` |
| `kernel.findEmail`, `kernel.findPhone` | contact `header`; account `related` | the person; a person's row | `records.findEmail`, `records.findPhone` |
| `kernel.merge`, `kernel.archive`, `kernel.restore` | `header` | the record | `recordMerges.merge`, `records.bulkRegister` |
| `kernel.logActivity` | `timeline` | the record; `<kind>` names Note, Task, Call or Meeting | `activityTargets.logScoped` |
| `kernel.link` | `related` | the record | `associations.link` |
| `kernel.unlink` | `related` | a person's row; a company's row | `associations.unlink` |
| `kernel.makePrimary` | contact `related` | a company's row | `associations.makePrimary` |
| `kernel.setParent`, `kernel.removeParent`, `kernel.addChild`, `kernel.removeChild` | account `related` | the company; a child's row | `associations.setParent` |
| `kernel.newDeal` | `companyDeals` | the company | `deals.createScoped` |
| `kernel.callContact` | `callPanel` | the person; `<phone>` is the number | `dialerActions.callContact` |
| `kernel.hangup`, `kernel.setCallOutcome` | `callPanel` | the call | `dialer.hangupCall`, `dialer.setOutcome` |
| `kernel.sendEmail`, `kernel.saveGmailDraft` | contact `composeEmail` | the email | `emailActions.sendToContact`, `emailActions.draftToContact` |
| `kernel.runAiField` | `aiFields` | a field | `researchAgents.startRun` |
| `kernel.checkSignals`, `kernel.toggleSignals` | `topSignals` | the workspace's signal check | `signals.checkNow`, `signals.setEnabled` |

An entry sits on each object's page in its own places, and each place can
carry its own `requires`, `ready`, `after` and gate (`Placement` in
`recipes/actions.ts`): Send needs a draft on the deal page and an address on a
contact's. `canon-base` places the actions today's pages had. The last three
rows are there for a recipe to add: running one AI field for a person, and
the workspace's signal check (`SignalsStatus`) inside Top signals.

The draft panel is `{panel=draftPanel}` under the `plan` section. The same
panel opens from a person's row in `fanOut`, so its actions hold wherever it
shows. A label can name what its action acts on: `<n>` for the picked people
(`Draft first touches for <n>`), `{person|people}` for a word that follows
`<n>`, and `<role>` for an item's person, where `[ as <role>]` drops when there
is no role. Page controls such as search, toggles, select shown and copy are
the components' own and aren't actions. `input`, `writes`, `gate` and `llm`
say in words what the kernel does, and stay in `recipe.md`; nothing a recipe
writes can loosen them.

`canon_deal_play get` returns the same actions for the deal's stage, each with
its method, so an agent sees what a person sees.
`scripts/deal-page-parity.ts` renders the deal page from this checkout and
from a git ref on the same control planes, and lists every control per
section, stage and edit right. When the actions were first wired it found 0
differences from the hard-coded buttons in 3,876 section renders.

**Conditions.** `shows:` and `enabled:` are conditions. They are parsed and
type-checked when the recipe is built or installed, and evaluated in the
browser by a walk over the parsed tree. Nothing runs as code.

| Write | Means |
|---|---|
| `canEdit`, `draft.exists` | a yes-or-no name |
| `picked.count > 0`, `others.count >= 2` | a number compared with `==`, `!=`, `<`, `<=`, `>` or `>=` |
| `stage == "in"`, `research.status != "running"` | a name compared with one of its values, quoted |
| `!a`, `a && b`, `a \|\| b`, `( … )` | not, and, or, grouping |

Every action reads the page: `canEdit`, `stage`, `deal.companyId`,
`research.status` and `people.research.status` (`none`, `running`, `done`,
`failed`), `play.started`, `others.count` and `suggested.count`. It also reads
what it acts on:

| Acts on | Reads |
|---|---|
| the queue | `queue.next` |
| the picked people | `picked.count`, `shown.count`; `kernel.researchPeople` reads `targets.count` and `picked.count` |
| a row | `row.source` (`deal`, `company`, `research`), `row.inCanon`, `row.hasStep` |
| a step | `step.channel`, `step.done`, `step.doneByTouch`, `step.queued`, `draft.exists`, `draft.by` (`keeper`, `user`, `none`), `draft.subject`, `person.email`, `person.linkedinUrl` |
| a draft | a step's names, and `gmail.linked`, `linkedin.sender` |
| a flag | `flag.propose` |
| an item | `item.kind`, `item.person` |

On an account's page every action reads `canEdit`, `canDelete` and
`deleted`; on a contact's also `contact.email`, `contact.phone` and
`contact.company`. What they act on adds `row.primary`, `row.email` and
`row.phone` (a person's row), `row.primary` (a company's row),
`parent.exists`, `deal.canCreate`, `call.blocked`, `gmail.linked`,
`field.answered`, and `signals.canManage`, `signals.enabled` and
`signals.running`.

These are errors at the condition's line: a name the action can't read, a
value a name never takes (`stage == "won"`), a number used as yes or no, a call
(`x()`), an assignment, and anything else outside the table.

**Prose is prompts.** A heading with `{prompt=<play>}` makes the prose under
it, up to the next heading, a prompt: `drafts.prompt`, `drafts.reviewPrompt`,
`research.planPrompt`, `research.briefPrompt` or `people.capability.prompt`.
`args="_, draft"` names the call's arguments, and `_` spreads the first one's
fields into scope. `{partial=shape.email}` is a piece a prompt includes with
`{{> shape channel}}`. Templates are small: `{{path}}`, `{{helper arg "x"}}`,
`{{#if a && b == "x"}}…{{else}}…{{/if}}` and `{{#each list}}…{{else}}…{{/each}}`.
A paragraph that renders empty drops, and so does a line inside one that
renders empty. Helpers are `or`, `default`, `minus`, `nl` and `pagesBlock`;
every prompt also sees `settings.*` and `kernel.LINKEDIN_MAX`
(`recipes/template.ts`).

A ```` ```output ```` block under the draft, review and account plan prompts
says what each field of the model's answer holds, one `field: "description"`
line per field the kernel stores: `subject` for a draft; `relevant`,
`pointOfView`, `surprising`, `wouldReply` and `note` for a review; `whyNow`,
`alphaHypothesis`, `alphaPitch`, `item`, `persona` and `angle` for an account
plan. A description is a template like a prompt, so the draft's subject reads
`subjectMaxWords` as the prompt does.

**Logic.** A ```` ```logic ```` block says what runs each play that isn't a
prompt, one line per play, `<play>: <kind> <name>`. A name starting `canon.`
is a built-in; any other name is one the recipe's TypeScript registers:

````markdown
```logic
keeper: rule canon.keeper
drafts.check: check canon.draftChecks, check draft
```
````

| Play | Kind |
|---|---|
| `keeper` | `rule` |
| `drafts.check` | `check`; several join their lines in order |
| `stage`, `prep`, `fanOut`, `pointOfView`, `people.productContext` | `viewModel` |
| `people.capability.clean` | `parse` |

A recipe with plays binds every one of them and writes all five prompts.

**Plays data.** What queries read without running code: a
```` ```stages ```` block (each stage's label and exit), a ```` ```data ````
block (`coreRoles`, `quietDays`, `drafts`, `research`), a ```` ```people ````
block (the contact AI fields people research reads, named by slug and role
from the ```` ```ai-fields ```` block ("Fields") or written inline, their
refresh, and `everyDays` and `buyers` for the keeper's people research; `judgment: true` answers a field as a cited
inference, and `replaces` lists earlier default questions a workspace field
moves off), `{prompt=people.center kind=jev min_confidence=<setting>}` with a
```` ```choices ```` block for Jev's remit question, `{prompt=people.fit
kind=jev}` with `left`, `right` and `tie` choices for the order buyers are
reached in, and `tool=<name>` on the capability prompt with a
```` ```schema ```` block. A value is a literal or `{ setting: <key> }`.

**Evals.** An ```` ```evals ```` block lists sample calls and what their
results must match on any settings a workspace runs (`recipes/evals.ts`).

Blocks are YAML's simple subset: `key: value` lines and `- item` lists nested
by indentation, each value inline (`[a, b]`, `{ k: v }`, a quoted or bare
string). An unquoted `true`, `false`, `null` or number is that value.

### TypeScript

A `.ts` file next to `recipe.md` exports `defineRecipe` from `recipes/sdk.ts`
and registers named functions. Each gets the play call's arguments, then the
settings in force, and returns data:

```ts
import { defineRecipe, type StageInput } from "../sdk.ts";

type Settings = { closeProbability: number; magicWandPhrases: string };

export default defineRecipe<Settings>((canon) => {
  canon.viewModel("stage", (input: StageInput, s: Settings) =>
    !input.members.some((m) => m.thread.lastIn !== null) ? "in" : (input.probability ?? 0) >= s.closeProbability ? "close" : "case");
  canon.check("draft", ({ body }, s) => [{ key: "wand", label: "No magic-wand questions", ok: !new RegExp(s.magicWandPhrases, "i").test(body) }]);
});
```

`canon.rule` registers a keeper and `canon.parse` a cleaner for a model's
answer. A view model's parameters pick its signature, so annotate them. The SDK also
exports `ROLE_LABEL`, `CHANNEL_LABEL`, `daysUntil`, `LINKEDIN_MAX`, `DAY` and the
kernel's types. A ```` ```ts ```` block in `recipe.md` is inline extension
code, compiled the same way, with `canon` and those exports in scope. A
first-party recipe keeps its code in `.ts` files, which Convex imports.

The markdown and the TypeScript must use exactly the same names. A name the
markdown uses that nothing registers fails at its line, and so does a name the
TypeScript registers that the markdown never uses. The build, the packager and
the install all check this.

### Canon's built-ins

For a recipe with no TypeScript (`recipes/builtins.ts`). Each reads fixed
setting keys, which the recipe must declare with the kind shown; validation
says which is missing, at the logic line.

| Built-in | Play | Reads |
|---|---|---|
| `canon.stage` | `stage` | `closeProbability` (number): `in` until someone replies, then `close` from it, else `case` |
| `canon.keeper` | `keeper` | `coreRoles`, `windowUrgentDays`, `staleResearchDays`: missing core roles (an urgent champion inside the window), replies owed, untouched and quiet threads with the other channel proposed, single-threading, overdue steps, an empty plan, the window and research gone stale |
| `canon.prep` | `prep` | `nextCallDays`, `politeDays`, `maxPrepQuestions`: four checks before a deal moves, the stall, the verdict and research questions |
| `canon.fanOut` | `fanOut` | `suggestedFirstTouches`, and a weights table |
| `canon.draftChecks` | `drafts.check` | a checks table |
| `canon.pointOfView` | `pointOfView` | the default ICP's point of view, else the oldest |
| `canon.productContext` | `people.productContext` | the deal's context, the point of view and its offer |
| `canon.capabilities` | `people.capability.clean` | one capability line per person asked about, at most 400 characters |

A built-in that reads a table takes the one in the same section as its
```` ```logic ```` line. The fan-out weights:

```markdown
| Who | Weight | Suggest |
|---|---|---|
| buyer | 4 | |
| champion | 2 | |
| researched | 1 | |
| from research | -1 | |
| executive | -3 | last |
```

Each person's score is the sum of the rows that describe them (`buyer`,
`researched`, `from research`, `from the deal`, `from the company`, or a
role), highest first, then by name. The first `suggestedFirstTouches`
untouched people in Canon are suggested; a row marked `last` holds those
people back unless nobody else can be.

The draft checks, one line per row on its channels (`all`, `all except call`,
or a list):

```markdown
| Check | Key | Channels | Rule |
|---|---|---|---|
| Reads without scrolling on a phone | length | email | `length(emailMaxSentences, emailMaxWords, greetingPhrases)` |
| One ask | ask | all except call | `questions(1)` |
| No magic-wand questions | wand | all | `avoid(magicWandPhrases, body)` |
```

| Rule | Fails when |
|---|---|
| `length(sentences, words, greeting)` | the email, without its greeting line and sign-off, runs over either cap |
| `subject(words)` | there's no subject, or it runs over `words` |
| `characters(max)` | the body runs over `max` characters |
| `questions(max)` | the body asks more than `max` questions |
| `avoid(phrases[, body])` | a phrase is in the subject or body, or with `body` in the body alone |
| `plain(phrases, words)` | a phrase is in the body, or a sentence runs over `words` |
| `lastQuestion(words)` | the last question runs over `words`; no line when there's no question |
| `include(phrases)` | no phrase is in the body |

An argument is a setting of the right kind, or a number where the rule takes
a count.

### Checking a recipe

`parseRecipe` returns every problem with its line: frontmatter, a settings row
whose kind, limits or default is wrong, an unknown component or `when`, a
`fields` section without its block, an action with an unknown key, no label, a
`runs` outside the registry or one that can't sit in its section, a label
naming a value its action lacks, a condition that doesn't parse or a prompt
that isn't written, a prompt with
the wrong arguments, an unknown helper or partial or an unbalanced `{{#if}}`,
a logic line naming a play, kind or built-in that doesn't fit, a built-in
missing a setting or its table, plays data that doesn't resolve to the shape
queries read, and evals that don't call a play. `scripts/build-recipes.ts`
and `scripts/recipe-package.ts` fail on any of them, with `file:line`.

`scripts/recipe-check.ts` is the equivalence lever.
`tests/fixtures/recipe-equivalence.json` froze what FSGTM's TypeScript recipe
on `origin/main` 2731fb85 returned for 1,635 calls (the `dealPlays` test
inputs, both recipes' evals, twelve deal page batches and a seeded sweep) on
three settings sets, with each recipe's settings, page, plays data and evals.
The enterprise recipe in-process, its bundle, and Velocity's markdown-only
bundle each return the same result for all 4,905 calls; a setting added
since takes the recipe's default. The structure compared leaves out what came after the freeze and isn't plays: templates, AI fields, and model points with their settings. The fixture's kernel section holds what the
kernel's runs sent before the recipe said it, captured on
`origin/main` 71a64b1 (`kernelCases`: a draft's input and prompt, the review,
the tool schemas, the first-touch channel, the research limits and cadences,
and the buyer-fit question), 48 cases on the three settings sets; only the
draft schema's subject changed, on purpose, from "under 8 words" to the
prompt's `subjectMaxWords - 4`. Each target matches all 4,953, and
`tests/recipeEquivalence.test.ts` holds them to it in CI. With `--url` the
lever runs the same calls through the recipe runtime and times a deal page.
`--capture` rewrites the fixture from the code in force, for a change meant to
alter behaviour.

### Format changelog

`engines: { canon: "<n>" }` in the frontmatter is the recipe format a
`recipe.md` is written in. Canon reads one format, `RECIPE_FORMAT` in
`recipes/kernel.ts`. A recipe written for any other gets one error, at its
`engines` line: "written for recipe format 1; this Canon reads format 2". It
gets no error for each grammar difference. A package already installed keeps
running: Canon stores it parsed, and never reads its markdown again until an
upgrade. A stored manifest names its points only through `permissions.slots`
and its `dealPage`, both of which format 2 already had, so a format 2 package
installed before format 3 runs and switches like any other.

`RECIPE_GRAMMAR` in `recipes/md/parse.ts` collects every table the grammar
reads: frontmatter keys, setting kinds and columns, heading attributes,
components and panels, fence names, the kernel actions with their hosts and
each host's condition scope, prompts and their outputs, helpers, logic plays,
built-ins and draft-check rules, plays data keys and evals.
`tests/recipeFormat.test.ts` hashes it against `RECIPE_GRAMMAR_SHA256`. Any
change to one of those tables fails that test until the hash is updated. If
the change refuses a recipe the old grammar read, it also bumps
`RECIPE_FORMAT` and adds an entry here.

| Format | Since | What changed |
|---|---|---|
| 1 | R5 (#423) | The first published grammar. `@fsgtm/velocity-deal@v2.0.0` is written in it. |
| 2 | P4b | Actions name their kernel action by its current id (`kernel.researchAccount`, `kernel.markDone`, `kernel.sendEmail`; P3, #440). `shows:` and `enabled:` are typed conditions, not prose (P3). The draft, review and account plan prompts have ```` ```output ```` blocks, and a recipe with plays writes the `people.fit` question (P4). |
| 3 | G1 | `contributes` is a list of points, `contributes: [deal.page]`, each checked against what the body holds. `permissions` drops `slots`: the points a recipe fills are its `contributes`. |

Some grammar changes add to format 3 without refusing anything it read, so they update `RECIPE_GRAMMAR_SHA256` and keep the format:

| Since | What it added |
|---|---|
| G3 | ```` ```template ```` blocks and the `templates.*` points. |
| G2 | The five model points, the `{model=<point>}` heading, the `bool` and `rules` setting kinds, and the `canon.health` and `canon.leadRules` tables. A stored manifest may carry `models`. |
| G4 | The ```` ```ai-fields ```` block and the `fields` point. A people block field may name an ai-fields field by `slug` and `role`; one written inline still reads as before. A stored manifest may carry `fields`. |
| G5 | The `calls.model` point, and `{partial=…}` headings under a `{model=…}` heading as that model's prose. A stored manifest's `models` may carry `prose`. |
| G6 | `{page=account}` and `{page=contact}` headings, the `account.page` and `contact.page` points, their components, and the account and contact actions with per-object scopes. |
| G7 | The `scoring.fit` model point (#488 raised its `fitBase` floor to 1 before any release outside Canon's own recipe declared it), the `ints` setting kind (a list of whole numbers, limits `<min> to <max>, up to <n> values`) and the `levels` kind (job levels, as `roles` lists deal roles). |
| N1 | The `workspace.nav` model point, read as a `choice` (the landing page) and two `rules` lists (pages hidden from everyone and from reps). |
| M1 | The `abm.model` point. `forecast.model` gains `forecastClosingDays` and `calls.model` gains `callDefaultCloseDays`. Both have a kernel fallback, so a recipe written before them still reads the old 30 days. |
| C1 | The deal page's `header`, `products`, `splits` and `apps` components, so a recipe places everything on a deal's page; a deal page that names none of them still draws them where they were. `kernel.archive` and `kernel.restore` sit in a deal's header. A section's `show="…"` picks which of its component's parts it draws (`PARTS` in `recipes/kernel.ts`; the summary's are `health`, `amount`, `closeDate`, `owner` and `research`). |
| DS1 | The plays data key `qualification`: the deal state's qualification framework. A recipe without it reads BANT+. |
| DS4 | Optional Plays `data.terms` with keyed label, rule and severity for workspace deal terms. Existing packages inherit defaults. |

Canon doesn't translate format 1. P3's renames would fit a small table, but
format 1's prose conditions and P4's new blocks have no mechanical
translation. Only one published package is written in format 1, and its
author republishes it in format 2.

Canon doesn't translate format 2 either, though it could: the change is two
frontmatter lines. Reading two grammars would end the rule that Canon reads one
format, and the only published format 2 packages are FSGTM's own, which are
republished in format 3. A new install, preview or upgrade of a format 2
`recipe.md` gets the one-line refusal; a format 2 package already installed
keeps running as stored.

## Slots: declarative only

A slot is a named place on a Canon page. A recipe fills it with a tree of
Canon components, each bound to a field of one of its view models.

```jsonc
// slots/deal-page.json
{
  "slot": "deal.page",
  "when": { "stage": ["in"] },
  "viewModel": "fanOut",
  "layout": [
    { "component": "queue" },
    { "component": "stageRail", "bind": "stage" },
    { "component": "peopleTable", "bind": "people",
      "columns": ["person", "field:primary_goal", "field:responsible_systems",
                  "capability", "researched", "contacted", "firstTouch"],
      "filters": ["search", "icpBuyer", "rank"] }
  ]
}
```

**First slots:** `deal.page`, `deal.rail`, `contact.rail`, `account.rail`,
`list.columns` (by object), and `home.section`.

**Component vocabulary**, taken from what the deal page already renders:

- verdict
- checklist
- moves (steps with a draft, its checks and a send or queue action)
- people table
- flags
- brief and evidence
- org chart
- touches
- stage rail
- queue (deal n of m, Next deal)
- field grid (the base recipe's "every field" view)

A new component goes into the kernel, built to `docs/ui-style.md`. That keeps
every recipe on-style, on mobile and accessible. It also means a recipe can't
read the user's session or the page's other data.

Actions in slots (send, queue, add step, set role) run entries of the kernel's
action registry ("Actions"). A slot can't define a new write.

## Server runtime: an isolate with a capability API

Recipe `server.ts` runs in a V8 isolate outside Convex. The isolate has:

- **No network.** Outbound fetch goes through `canon.sources`, which reads
  through the shared source cache (`sourceReads`), and only for sources the
  install granted.
- **No secrets and no environment.**
- **One binding, `canon`,** scoped to the install's permissions and the
  calling workspace:

```ts
export default defineRecipe((canon) => {
  canon.rule("keeper", (snap, settings) => flags);           // pure
  canon.check("draft", (draft, settings) => lines);          // pure
  canon.viewModel("fanOut", (snap, settings) => view);       // pure
  canon.tool("draft_step", async (input, ctx) => {
    const text = await ctx.llm({ skill: "first-touch", input });  // owner's plan
    return ctx.propose("dealPlay.draft", { stepId: input.stepId, text });
  });
});
```

`ctx.propose` writes nothing directly. It goes through the same path as an
agent's proposal: ledger receipts, grants, approval, CAS and the verbatim quote
check. A recipe can't skip a gate, because the isolate holds nothing that could.

**Where the isolate runs.** In a Cloudflare Worker, `services/recipe-runtime`,
which loads each recipe's bundle into a Dynamic Worker isolate with no network
(`globalOutbound: null`), no env and a CPU limit. Convex keeps all state:
recipe code returns data, and every write still goes through Convex's gates.
QuickJS inside a Convex action was the fallback and is dropped.

- **Bundles.** `scripts/build-recipes.ts` bundles each first-party recipe
  with plays into one ESM string, with a content hash, in
  `recipes/_bundles.generated.ts`, next to Canon's built-ins bundle for
  markdown-only packages. A test fails when that file is stale.
- **One choke point.** Convex actions run recipe code only through `runPlays`
  (`convex/lib/recipeRuntime.ts`), a batch of named calls (`keeper`, `prep`,
  `stage`, `fanOut`, `drafts.check`, the prompts). A deal page is one call.
  With `RECIPE_RUNTIME_URL` unset (the local stack, the tests) the same
  calls run in-process. A runtime that fails or doesn't answer is an error,
  never a quiet fallback.
- **The wire** (`services/recipe-runtime/src/protocol.ts`): `POST /run`,
  HMAC-signed with `RECIPE_RUNTIME_SECRET` over the timestamp and body,
  refused past 60 s of skew. The runtime answers `409 {need: "code"}` for a
  bundle hash it hasn't seen, and Convex sends it again with the code.
- **Data stays in-process.** Queries and mutations read recipe *data*
  (settings, people fields, stage names), resolved from the recipe's `data`
  bindings. The browser gets that data from the server and runs no recipe
  code.

**Latency.** A deal page's batch takes about 4 ms through a local Worker and
0.15 ms in-process (`scripts/recipe-check.ts --url`). The cache the plan
called for (results on the play, keyed by recipe version and snapshot hash)
isn't built: measure the deployed round trip first.

An installed recipe's code runs only in the runtime. `runPlays` refuses an
installed bundle when `RECIPE_RUNTIME_URL` is unset, before it loads the
code. There is no in-process path for code that isn't in this repo. The
bundle is in Convex file storage, and `runPlays` reads it only when the
runtime answers 409, checks it against the hash the admin installed, and
sends it. First-party recipes still run in-process without a runtime, which
is how the tests run. The local stack runs the Worker, so it exercises the
same path as production (`runtime=` on the `READY` line).

## Layers, settings and forks

An install resolves through four layers. A lower layer overrides a higher one
by contribution id:

```text
Canon base recipe → installed recipe (e.g. @fsgtm/enterprise-deal) → workspace → rep
```

- **Settings** are typed values (`EMAIL_MAX_WORDS: 90`, the banned phrases, the
  core roles, `QUIET_DAYS`). A workspace admin changes them. A rep changes only
  settings the recipe marks `rep`, such as their own ICP filter, which today
  sits in localStorage (`deal-play.tsx:39`).
- **A fork** copies one contribution, for example a skill or a field question,
  into the workspace layer and edits it there. The fork records the upstream
  version it came from.
- **An upgrade** pins a new version. For settings this is built
  (`recipes/upgrade.ts`). Each setting gets one line of a three-way diff: the
  installed version's default, the new version's default and the workspace's
  override. A setting nobody overrode takes the new default. An override
  whose default didn't change stays. An override whose default changed is a
  conflict, and the admin keeps the override or takes the new default. An
  override the new version no longer accepts, or for a setting it removed, is
  dropped and shown. The upgrade is a new package version and a new settings
  revision, "Upgraded to vX". Forks of skills and fields wait for the
  contributions themselves.
- **Agency layer for clients.** An agency running many client workspaces
  installs its recipe in each one, and the client's own
  edits stay in their workspace layer.

All of this needs versioned specs (the kernel gap above). Every install,
fork, setting change and agent-written edit is a revision with an author and
a diff.

### Which deal page a workspace runs

The deal page is the `deal.page` point, so `enabledFor` answers ("Install and
enable"). Clerk's organization webhook creates a workspace with a `deal.page`
row on `canon-base` (`defaults.newWorkspace`), the plain fields page, the same
as the deal dialog. A workspace with no row runs its old `dealPageRecipe`
field if it has one, else FSGTM enterprise (`defaults.unset`): every workspace
made before P4b has neither, and its live deal page keeps its play. The
migration that narrows the field is under "Install and enable".

## Customizing in the app

A workspace makes a recipe its own the way a pi user copies a package and edits it: it takes a copy and edits that copy's `recipe.md`. The copy is a package like one from GitHub, so it installs, enables, carries settings revisions and uninstalls the same way. Only its source is different.

**Customize.** Every recipe on the Customization page that isn't the workspace's own has a Customize button, for an admin or manager. It makes `@workspace/<name>`, named after the recipe it copies (`@workspace/fsgtm-enterprise-deal`, then `-2` for a second copy), titled "<Org>'s <title>". The `@workspace` scope is reserved: a package from GitHub can't take it. The copy's `recipe.md` is the source's, with only `id`, `title` and `author` rewritten. A first-party recipe's text ships with Canon (`FIRST_PARTY_MARKDOWN` in `recipes/_bundles.generated.ts`). A GitHub package's is fetched again at its pinned commit and refused if its bundle no longer hashes to the one installed. The copy starts on the source's settings in force, as its first settings revision. It is off at every point until someone picks it there, like any recipe.

**The source.** `recipePackages.source` gains `{ kind: "workspace", markdownHash, bundle, forkedFrom: { id, version, markdownHash } }` (`WorkspaceSource` in `recipes/workspace.ts`). `forkedFrom` is the recipe it copied, for upstream updates later. `markdownHash` is the markdown in force, and it pins the copy as a commit pins a GitHub package. `bundle` says what code it runs:

- `builtins`: the source had no TypeScript. The copy runs Canon's built-ins bundle carrying its own markdown, which is rebuilt on every save.
- `kept`: the source had TypeScript. The copy runs the source's exact bundle, under the same hash, stored as its own file so an upgrade of the source can't remove it. That bundle carries the source's prompts and its ```` ```logic ```` lines, so in the copy those stay as copied. An edit to either is an error at its line. Everything Canon reads from the markdown can change: the pages, settings, stages, plays data, fields, templates and models. Because the logic is pinned to what the bundle registers, the markdown and the TypeScript still use exactly the same names.

**Edits are markdown only.** A ```` ```ts ```` block in a workspace recipe is an error at its line: code changes need a package from GitHub. On Canon's built-ins, every ```` ```logic ```` line must name a built-in. The id can't change.

**The editor.** `/dashboard/customization/<name>/edit`, linked as "Edit recipe.md" from the copy's row, is a textarea with line numbers. As you type it runs `workspaceProblems` (`recipes/workspace.ts`): `parseRecipe` plus the rules above, in the browser, 250 ms after the last keystroke. Each problem lists its line, and clicking one selects that line in Markdown. Save is off while there's an error. A member sees the editor read-only.

**The page.** One toolbar carries the revision, whether the draft has unsaved changes, the error count (click it for each problem by line), Markdown or Visual, History (the revisions, in a side panel), Discard and Save. Save asks for an optional note, then runs the evals. Below it, the outline or the markdown sits in a left column with Ask Canon under it, and the live preview takes the rest of the width.

**Live preview.** Beside the textarea, the editor draws a real record of the workspace with the draft's page and actions, through the app's own record page (`RecordPage` with a `layout`, so `PageSections` and every component's renderer are the ones a person sees). The tab follows the page the caret is in (`{page=account}`, `{page=contact}`, else the deal's) and can be switched, with a picker over the first five records. It redraws 250 ms after typing stops, when the draft checks clean. While the draft has errors it keeps the last clean version and marks it stale. It is `inert`: buttons show with the draft's labels and conditions, and none runs. A deal's play data (its stage, prep and keeper) still comes from the deal page recipe in force, because an unsaved draft has no bundle; only the layout and the actions are the draft's.

**Evals before save.** Save runs the draft's evals before it writes anything, on the copy's settings in force (the draft's defaults under the workspace's overrides). A copy on Canon's built-ins runs them in the recipe runtime, on the bundle the save would store. A copy that kept its source's TypeScript bundle reports them as not run, because that code runs only where its package's does. Failing evals stop the save and list each result; the admin either fixes the draft or confirms "Save anyway" (`acceptFailingEvals`), as a settings proposal is approved anyway. A runtime that can't be reached reports the evals as not run and doesn't block. A revert isn't gated: its text was in force before.

**Upstream updates.** A copy is behind its upstream when the recipe it came from is at another version than `forkedFrom.version`: Canon shipped a new first-party version, or the workspace upgraded the GitHub package (`upstreamChange` in `convex/lib/recipes.ts`). The package row shows "Upstream changed · vX" and the editor a banner with "Merge upstream vX". The merge is three-way over lines (`merge3` in `recipes/merge.ts`, diff3's rule): base is the upstream text the copy was made from, ours is the draft, theirs is the upstream now, base and theirs both rewritten to the copy's id, title and author first. A change only one side made applies. Changes from both sides whose base lines overlap or touch are a conflict, unless both made the same change; a conflict sits in the draft between `<<<<<<< yours`, `=======` and `>>>>>>> upstream vX`, is an error at its line, and the editor lists it with Keep yours, Take upstream and Keep both. The save names the version it merged (`upstreamVersion`); the server fetches the upstream again, refuses if it has moved on, notes the revision "Merged upstream vX" unless the admin wrote a note, stores that upstream text on the revision (`upstream`, the next merge's base, else the copy's first revision) and moves `forkedFrom` to it. A copy with a kept bundle takes the upstream's bundle in the same save, and its prompts and logic are checked against the upstream's. An upstream that gained or lost TypeScript can't be merged; customize it again. `tests/workspaceRecipes.test.ts` covers the merge (one side's change, a clash, the same change on both sides) and a merged save.

**Revisions.** Each save is a row in `recipeMarkdownRevisions`: `{ orgId, recipeId, revision, markdown, markdownHash, parent, author, note, diff: { added, removed, text }, bundle?, status }`, with the full text, a unified diff against its parent, and the first revision's diff against the recipe it copied. It works like settings revisions. Rows are immutable except to supersede. Exactly one is current. A save names the revision it was opened on (`baseRevision`) and is refused when that's no longer current. A revert writes the old text as a new revision. On a copy with a kept bundle each revision also records the bundle it runs on (`bundle: { hash, storageId }`, #499), and a revert puts that bundle back with the text, so a revert to before a merge that changed the prompts or logic runs the code it ran then; its prompts and logic are checked against that bundle's, which are the revision's own. A revision saved before revisions recorded their bundle gets it when it is superseded; one already superseded ran on the bundle in force unless an upstream merge came after it, and a revert to it across a merge is refused with the revision to go back to instead, since that code is gone. A copy on Canon's built-ins records no bundle: its bundle is rebuilt from the markdown on every save and revert, and the one it replaces is deleted. A kept bundle is never deleted while the copy exists, since a revision records each one. It changes only on a merge that brings new code (a merge with the same hash reuses the file), so a copy holds one bundle, at most 1 MB and about 100 KB in practice, per such merge. The save runs as an action (`workspaceRecipes.save`): it checks the markdown again on the server with the same function, builds and stores the bundle for a `builtins` copy, then `storeRevision` checks the base again, writes the revision and points the package at the new manifest and bundle. A save that changes the ICP fit values in force rescores the workspace, as a settings save does. It reads the fit model in force before it patches the package and again after, so a save that takes `scoring.fit` away from the copy in force rescores on the fallback recipe's values (#493).

**Settings and markdown revisions.** A recipe has both, each with its own history. The markdown declares the settings and their defaults. The workspace's settings revision stays on top, as overrides of those defaults, so a save that changes a default changes it only where nobody overrode it. An override of a setting the new markdown removes, or no longer accepts, is ignored on read and kept in the settings revision. The save names it, and it applies again if the setting comes back. A save doesn't change the question of an AI field the workspace already turned on; its settings sheet does.

**Rights.** Customize, save and revert are human-only (`requireDecider`, `src/lib/gtm-human-only-mutations.ts`). Over `/mcp`, `canon_customization get_markdown` reads a workspace recipe's markdown at any revision (or a first-party recipe's), and `list_revisions` its history. Agents will propose markdown edits for a person to approve, as they propose settings now.

**Stored form.** The copy's manifest is `toManifest` of its markdown, checked by `parseManifest` like a package's. To hold copies of Canon's own recipes, a manifest's `data` may be null (a recipe without plays, such as `canon-base`), its deal page may be empty (the theme) and it may have up to 100 settings. A package from GitHub still needs plays.

### Visual layout mode

The editor opens on Visual, which lays out a page without showing markdown. Markdown, the other mode, is the textarea described above. Both edit one draft, so a person can switch at any time and see the same recipe.

**Layout edits.** `recipes/md/edit.ts` holds them. `describeLayout(markdown, object)` returns what Visual draws for a page: each section's component, title, folding, stages, buttons and fields, the buttons each section could add, and the sections the page could add. `apply(markdown, op)` makes one `LayoutOp` in the text. It rewrites only the lines the edit is about: a heading line, an action's block or one key line, a section's span, or a fields line. It then parses the result again and refuses the edit unless the page comes out exactly as the op says and nothing else in the recipe changed. A visual edit can't write an invalid file, and an agent editing the file sees a diff of only those lines.

**The mode.** `LayoutMode` (`src/app/dashboard/customization/layout-mode.tsx`) takes `markdown`, an optional `object` (the page it opens on), `onPage(object)` and `onChange(nextMarkdown)`. The editor renders it over its draft in place of the textarea, opening on the page the caret was in, and the live preview stays beside it: it draws the page picked in Visual, and in Markdown the page the caret is in. It shows a picker of the pages the recipe lays out, then the page's sections top to bottom as an outline (`layout-section.tsx`). Each row is the section's title and one line saying where it shows, how many buttons or fields it has, and whether it starts folded. Clicking a row opens its settings below it; the rest stay one line each, so the outline fits beside the preview:

- Drag a section by its handle to reorder it, or focus the handle and press Alt with an arrow key. Drag is native HTML5 drag and drop, the same as the record board's.
- Starts, Open or Folded, sets whether the page shows the section folded.
- Rename edits the title in place. Enter or leaving the box keeps the new name, and Escape drops it.
- On a deal page, Shows in has one chip per stage. Clicking a chip writes `when=` in the form the heading already uses, `stage != in` or `stage in [case, close]`, so the line changes as little as it can. A section that hides in every stage is refused: remove it instead.
- Remove takes a section off the page. A section that holds a play's ```` ```logic ```` line can't go, because a recipe with plays binds every one of them. Visual says so and offers to fold the section or show it in fewer stages.
- Buttons lists the section's buttons, its own and each panel's, as separate lists, since a button moves only among its own. Each one can be dragged, renamed or, from the icons a row shows on hover, hidden or given conditions. The conditions editor lists every name that button can read (`scopeOf`). Add a button lists the kernel actions the section can still take, each with its gate. The first draft panel button added to a section whose text has no `{panel=draftPanel}` heading brings that heading with it.
- A fields section lists its fields. Drag one within the section or onto another fields section, or use Move to.
- Add a section lists the components the page can still take. The new section goes last, with its title open for renaming.

**One source.** Every change goes through `apply`, and `onChange` gets the new markdown. A refused change shows the reason on its card and leaves the draft as it was. Typing in Markdown updates Visual on the next render. A problem or conflict clicked while in Visual switches to Markdown at its line. While the markdown has errors, Visual shows "Fix the markdown first" with each problem and its line. Undo, or ⌘Z, steps back through the edits made in Visual. A change from elsewhere, such as typing in Markdown or a revert, ends that history, since undoing past it would drop the change.

`layout-drops.ts` turns a drop or an arrow press into its `LayoutOp`. It is pure, so `tests/recipeEdit.test.ts` checks that dragging Velocity's Activity above Next action asks for the same bytes as the hand-written change.

## Authoring by agent

Following bb, the user's agent writes recipes. Over `/mcp`, the agent reads
the installed recipe and its evals, then proposes a revision: a new skill, a
changed setting, a forked field. The revision passes the recipe's evals and
waits for an admin's approval, which is org agents' spec revision
flow. "Make the deal page ask about their current ICM vendor"
becomes one approved revision, not a ticket.

## Editing with an agent

A person asks for a change in words, such as "move Activity above Next action" or "make emails max 70 words", and a model rewrites the recipe.md for it. E4a is the backend; the recipe editor's Ask Canon pane (E4b) calls it, and the editor's Save (E1) saves what the person accepts.

**The skill.** `recipes/skills/canon-layout/SKILL.md` is what a model needs to edit a recipe.md correctly. `scripts/build-layout-skill.ts` generates it from the registries the parser checks a recipe against: `RECIPE_FORMAT` and `RECIPE_GRAMMAR`, the points, the setting kinds and their limits, each object's components, every kernel action with where it sits, its binding, its label placeholders, its conditions and its gate, each binding's condition names, the prompts, the built-ins and their tables, the model points with their bounds, AI fields, templates and evals. Its worked examples (move a section, fold it, rename, hide or reorder a button, add an AI field, tune a setting) are cut from `recipes/fsgtm-velocity-deal/recipe.md`, so they can't go stale either. The script also writes `skill.generated.ts` next to it, since Convex can't read markdown, and `tests/recipeAgent.test.ts` fails when either file is stale. The skill's header names the grammar hash it was built from. `scripts/layout-skill-sufficiency.ts` is the proof that the skill is enough: for five realistic requests it applies the change a person would expect to the Velocity recipe, checks that the skill documents every component, action, setting kind and key the change uses, and that the result parses and passes its evals.

**`recipeAgent.proposeEdit`** (`convex/recipeAgent.ts`, the loop in `convex/lib/recipeAgent.ts`) takes `{ recipeId, baseMarkdown, request, object? }` and returns `{ markdown, summary, diff, problems, evals, evalsNotRun, attempts, tokens, model }`:

1. It runs on the requesting person's ChatGPT plan, `resolveLlm(ctx, userId)`, with no server key behind it. Without a connected plan it refuses with `NO_PLAN` before any model call.
2. It sends the skill, the request (and the page it is about, when given) and the recipe.md, and asks for `{ markdown, summary }` through `forcedToolCall`.
3. Canon's parser checks the answer, with three rules on top: the id stays the recipe's, it names no code the base didn't, and it adds no ```` ```ts ```` blocks. On problems the model gets them back by line, with those lines and its last answer, at most twice.
4. A valid answer that names no code runs its evals on its defaults, on Canon's built-ins bundle with the recipe in it, through the recipe runtime: what an install of it would run, the same path as a pasted recipe.md's preview. A recipe whose play code is its own TypeScript returns `evalsNotRun` instead, and so does a deployment with no runtime.
5. It returns the diff against `baseMarkdown`, unified. It never saves and writes nothing; saving is the person's, through E1's save path.

A proposal's budget is 150,000 estimated tokens and 300 seconds (`turnMeter`, as event agents use), charged before each call. A run is logged, not stored: there is no proposals table, because nothing is kept until the person saves.

**Ask Canon in the editor** (E4b). The recipe editor has an Ask Canon box under the outline, for an admin or manager, with example requests before the first. A request in words goes to `proposeEdit` with the draft as it is in the editor, unsaved edits included. The pane shows the proposal's summary, the model, any problems by line, the evals (or why they didn't run) and, folded, the diff. **Apply to draft** makes the proposal the draft, and **Discard** drops it. Neither saves: the draft is saved, or not, with the editor's Save. A follow-up request is asked about the draft as it is then, so a run of requests builds on each accepted one, and the pane lists the session's last few requests with what became of each. The pane says whose plan pays: the person's own ChatGPT plan, named by its email, or, with none connected, that it needs one, with Connect ChatGPT in place (the same as Integrations → ChatGPT). The draft's transitions are one reducer, `draftReducer` in `src/app/dashboard/customization/editor-draft.ts`.

**A local stack never spends a plan.** On a loopback deployment with the demo-user bypass, `proposeEdit` asks a stand-in instead of a model (`convex/lib/recipeAgentStandIn.ts`), even when the dev user has a ChatGPT session: "move A above B" moves a section, and anything else folds the first open one. Canon's checks, retries and evals still run for real, and the pane says a stand-in answered. `RECIPE_AGENT_REAL_MODEL=true` in the local Doppler config turns the real model back on. dev.canoncrm.com and production have no bypass, so the stand-in never runs there. `devSeed:customizeLocal` customizes a recipe from a recipe.md served on 127.0.0.1, which is how a local stack copies a package `installLocalPackage` stored: that package has no GitHub commit for Customize to fetch again.

**Over /mcp**, `canon_customization propose_edit` returns the same proposal on the caller's own plan, so Claude or Codex can show a person the checked change. It saves nothing either.

Not verified without a real plan: how often a real model's first answer parses, and whether it keeps the rest of a long recipe.md byte for byte. Checking both needs a ChatGPT plan on dev.

## Distribution and trust

- **Sources.** A recipe installs from a public GitHub repo, as
  `github:owner/repo[/path]@ref` (`convex/lib/recipeSources.ts`). The ref
  resolves to a commit through the GitHub API, unauthenticated, and both
  files come from `raw.githubusercontent.com` at that commit, with timeouts
  and size caps. An install is pinned to the commit; a tag that moves later
  doesn't move it. `RECIPE_GITHUB_API_BASE` and `RECIPE_GITHUB_RAW_BASE` point
  this at a fixture (`scripts/recipe-github-fixture.ts`) in tests and local
  checks. A private repo installs from the same text through Canon's GitHub
  App (R5b, below). First-party recipes live in this repo under `recipes/`.
- **Who installs.** An admin or manager, on the Customization page
  (`/dashboard/customization`, in the nav under Settings, formerly Recipes), through `requireDecider`. Agents can call `preview_install` and
  `check_upgrade` over `/mcp`; install, upgrade and uninstall are human-only
  (`src/lib/gtm-human-only-mutations.ts`).
- **Install screen.** It shows the title, author, version, pinned commit and
  bundle hash, the permissions the recipe asks for, the deal page it fills,
  the settings it exposes with their defaults, and its evals run in the
  runtime. Install fetches the package again at the pinned commit and refuses
  a bundle whose hash isn't the one previewed.
- **Namespaces.** An installed recipe's id is `@scope/name`, so it can't take a
  first-party id. A workspace can't install a second package under an id it
  already has from another repo. A field's slug isn't namespaced: it is the
  field's attribute, so two recipes' `primary_goal` are one field, and only one
  of them can be on ("Fields"). A field a recipe creates is a normal custom
  field the workspace keeps after uninstalling it.
- **Uninstall** refuses a package while any of its contributions is on. The settings
  revisions stay, so a reinstall picks them up.
- **Evals ship with the recipe.** The install and upgrade screens show their
  results. A registry listing would show them too, and later outcomes across
  installs (reply rate, stage conversion), which are only comparable because
  every recipe runs on the same ledger.
- **Paid recipes** bill through credits, with a share to the
  author. That's out of scope until a second author exists.

## Recipe #1: FSGTM Enterprise multi-touch deal

How the code split. The kernel keeps the storage, the gates and the sending.
The recipe keeps the methodology, now `recipes/fsgtm-enterprise-deal/recipe.md`
on Canon's built-ins and its `fsgtm.ts` for two draft checks ("Writing a recipe").

| Recipe contribution | From |
|---|---|
| Skill `first-touch`, `call-track`, `draft-review` | `drafts.ts`: `SHAPE`, `RULES`, `draftPrompt`, `reviewPrompt` |
| Skill `account-research` | `research.ts`: `planPrompt`, `briefPrompt` |
| Skill `principles` | the deal prep loop's principles table |
| Fields `still_at_company`, `primary_goal`, `responsible_systems` | `peopleResearch.ts`: `PEOPLE_FIELDS` |
| Tool `new_capability` (remit plus the innovation/stability center) | `peopleResearch.ts`: `CENTER_QUESTION`, `capabilityPrompt` |
| Rule `keeper` | `model.ts`: `keeperReport`, `CORE_ROLES`, `QUIET_DAYS`, `STALE_RESEARCH_DAYS`, `WINDOW_URGENT_DAYS` |
| Check `draft` | `drafts.ts`: `checkDraft`, the phrase checks, `EMAIL_MAX_*` |
| View models `prep`, `fanOut`, `stage` | `model.ts`: `prepReport`, `fanOut`, `stageOf`, `STAGE_EXIT` |
| Slot `deal.page` | `deal-play.tsx`: `Plane`, `FanOut`, `Prep`, `Plan`, `Keeper`, `Brief`, `AccountMap`, `Touches` |
| Settings | the constants above, plus `pickPointOfView` reading each ICP's point of view and offer |

| Kernel keeps | From |
|---|---|
| Play storage and its command reducer | `dealPlays.ts`: `apply`, `changePlay`, the research leases |
| Committee roles on deals | `dealCommittee.ts`. The role *set* (`lib/committee.ts` `SLOTS`) becomes a recipe setting with today's three as the default. |
| Touches from observations, calls and meetings | `dealPlays.ts`: `touchLogs` |
| Research pipeline (plan, fetch, quote check, save) | `dealPlayActions.ts`: `runResearch`, with prompts, limits and answer fields from the recipe, under the kernel's ceilings |
| Sending and queueing | Gmail drafts, `queueLinkedin`, the dialer |
| Keeper scheduling | `dealPlayKeeper.ts`: `tick`, `onReply`, with rules and research cadences from the recipe |
| Buyer ranking | `dealPlays.ts`: `rankProspects` (Jev), a kernel tool recipes call |

Some `dealPlays` fields are named for this methodology: `whyNow`,
`alphaHypothesis`, `alphaPitch`. They stay for now. Moving brief sections into
a recipe-defined shape is a schema migration, so it waits until a second recipe
needs a different brief.

## Phases

Each phase puts a change in front of a user.

- **R1. Deal page recipe, in-process.**
  - Add `defineRecipe` and the `deal.page` slot.
  - Move the methodology out of `convex/lib/plays/` into
    `recipes/fsgtm-enterprise-deal/`, and the "every field" view into
    `recipes/canon-base/`. Both are markdown now (R6): the default page is
    `recipes/canon-base/recipe.md` (id `canon-base`, which stored workspace
    choices use). Its fields sit in sections (Overview, Pipeline, Notes, More,
    System), and the deal dialog and the field grid use the same sections.
  - *User-visible:* a workspace setting picks the deal page recipe. A
    workspace that never picked stays on FSGTM, so nothing changes until
    someone picks the base. A workspace created since P4b starts on the base
    ("Which deal page a workspace runs").
- **R2. Settings and forks.**
  - Add versioned specs (the missing kernel piece) and a recipe settings page.
  - *User-visible:* an admin edits the draft caps, the banned phrases, the
    core roles and the people research questions, and sees each revision.
- **R3. Isolate.**
  - Run the FSGTM recipe's server code in a Cloudflare Dynamic Worker
    (decided: QuickJS is dropped).
  - *User-visible:* none on purpose. Recipe output must match R2 exactly.
- **R4. Agent authoring.**
  - `/mcp` tools to read a recipe, run its evals and propose a revision.
  - *User-visible:* "change my deal page to …" from Claude or Codex lands as
    an approval.
- **R5a. Install from a public GitHub repo** (built).
  - The package format above, `recipePackages`, and recipe ids widened to
    strings. The registry is the first-party recipes plus the workspace's
    installed packages, resolved in `recipeIn` (`convex/lib/recipes.ts`).
  - Recipe #2, **FSGTM Velocity deal** (`recipes/fsgtm-velocity-deal/`): a
    transactional deal one rep runs. FSGTM's methodology on its own defaults
    (one champion, quiet after 5 days, 60-word emails, close at 40%) and a
    deal page without the account map. It ships only as a package, and from
    v2.0.0 it is markdown only, on Canon's built-ins.
  - *User-visible:* Customization → Packages lists installed recipes
    with their source and commit, installs from GitHub through the install
    screen, and checks for updates with the three-way settings diff.
- **R5b. Private repos through a GitHub App** (built).
  - *User-visible:* Customization → Browse → From GitHub has "Private repos on
    GitHub". An admin or manager clicks Connect GitHub, installs Canon's App on
    their GitHub organization and picks repos. The panel then shows
    "Connected to <login>", the repos the App can read, and Disconnect. The
    install screen, pinning, upgrades and trust rules are the same as for a
    public repo. The preview says the source is private.
  - *Connections.* `githubRecipeConnections` holds one row per workspace and
    installation: `{ orgId, installationId, account: { login, type },
    connectedBy, connectedAt, status }`. A workspace may connect several. No
    token is stored.
  - *Connect flow* (`convex/githubRecipes.ts`). `startConnect` (an admin or
    manager through `requireDecider`, never an agent) stores the SHA-256 of a
    random state in `githubRecipeSetupStates`, tied to the person and the
    workspace, for 10 minutes. It then sends them to
    `https://github.com/apps/<slug>/installations/new?state=…`. GitHub returns
    them to `src/app/api/recipes/github/setup/route.ts`. The route sits behind
    the Clerk session gate and passes the person's Convex token to
    `completeSetup`. That action spends the state, which must be the caller's
    own, in the caller's workspace and unexpired. Then it trades the sign-in
    `code` for a GitHub user token and lists `GET /user/installations`. It
    connects only an installation on that list. GitHub warns that anyone can
    forge the redirect's `installation_id`
    ([about the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)).
    That is why the App asks users to authorize it during installation: the
    design's original setup URL plus `GET /app/installations/{id}` alone would
    let one workspace claim another's installation by its number. Last, it
    reads the account with `GET /app/installations/{id}`. A return without a
    code, which GitHub sends when an existing install is only updated, goes
    through GitHub's sign-in under the same state. A return without a state
    sends the person back to Settings to connect again.
  - *Tokens* (`convex/lib/githubApp.ts`). The App JWT is RS256, signed with
    WebCrypto in the default Convex runtime. GitHub's PKCS#1 key is wrapped as
    PKCS#8 in code, so the key goes into Doppler exactly as GitHub issues it.
    `iat` is backdated 60 s and the JWT lives 10 minutes. Each operation (a
    preview, an install, an update check, an upgrade) mints one installation
    token scoped to the one repo, with Contents and Metadata read-only. It
    keeps the token in a local variable and drops it. Nothing stores, logs or
    returns a token, and error messages carry only GitHub's status.
  - *The source.* `RecipeSource` gains `{ kind: "github-app", installationId,
    owner, repo, path?, ref }`. `github:owner/repo[/path]@ref` resolves to it
    when one of the workspace's connections has that owner's login and sees
    the repo as private (`resolveSource`). Otherwise the source stays public.
    Reads go through the API: commits and tags as for a public repo, and the
    two files from `GET /repos/{owner}/{repo}/contents/{path}?ref=<sha>` with
    `Accept: application/vnd.github.raw+json`. The raw host doesn't take
    installation tokens. Size caps, timeouts and the bundle hash check are the
    public source's.
  - *Isolation.* A read through the App must name an installation on the
    caller's own workspace's connections (`openSource`), so a workspace can't
    read through another's. Packages, manifests and bundles stay in Convex and
    are read only by `orgId`, as in R5a. When the connection is gone,
    disconnected in Canon or uninstalled on GitHub, a preview, update check or
    upgrade fails with "Canon's GitHub App no longer has access to
    owner/repo; reconnect GitHub in Settings." An installed package keeps
    running its pinned code.
  - *MCP.* `canon_customization` gains `github_connections` and `github_repos`, and
    `preview_install` and `check_upgrade` read private sources the workspace
    connected. `startConnect`, `completeSetup` and `disconnect` are human-only
    (`src/lib/gtm-human-only-mutations.ts`).
  - *Local stacks.* GitHub can't redirect to localhost, so on a stack with
    `FSGTM_ENABLE_DEMO_DATA=true` (sign-in is already bypassed there) the
    setup route takes a pasted return. Click Connect GitHub on the local
    stack, install the App, and when GitHub lands on the dev site, copy that
    URL's query string onto `http://localhost:<port>/api/recipes/github/setup`.
    The state must still be the local stack's own, and the installation is
    checked with the App's JWT (`GET /app/installations/{id}`) before it's
    stored. The OAuth check is skipped there only. Unit tests stub `fetch`;
    nothing in CI calls GitHub.

- **R6. Recipes in markdown and TypeScript** (built).
  - A recipe is `recipe.md` plus optional `.ts` files ("Writing a recipe").
    The first-party recipes are written that way, and FSGTM's TypeScript
    modules are gone. Velocity is markdown only.
  - *User-visible:* the deal dialog and the default deal page show fields in
    sections. The install screen says which parts of a recipe are markdown,
    Canon built-ins or code, and previews a pasted `recipe.md`.

- **G1. Packages, contributions and points** (built).
  - The points registry (`recipes/points.ts`) with `deal.page` as its first
    entry, `contributes` as a list (format 3), `recipeEnablements` and
    `enabledFor` in place of `organizations.dealPageRecipe`.
  - *User-visible:* Customization has its own page in the nav. It shows each point
    with what's on there, every installed package with its source, commit,
    permissions, settings, proposals, updates and uninstall, and installing
    from GitHub with the private repo connections. A local stack installs a
    markdown-only package with `devSeed:installLocalPackage`.

- **G2. Model points** (built).
  - `forecast.model`, `health.model`, `scoring.lead`, `signals.heat` and
    `hygiene.policy` ("Model points"). canon-base, now "Canon defaults",
    contributes each with the values the code had.
  - *User-visible:* the Customization page shows each model point with its picker
    and a link to its settings. canon-base's settings sheet edits them, grouped
    by point, and the Revenue, health, leads, account signals pages and the
    hygiene audit follow. The Revenue page and the pipeline route now read one
    set of category weights, and the new lead model form starts from 70, 45
    and 0, the grades the first model gets, where it showed 80, 50 and 20.

- **G3. Templates** (built).
  - A generic template mechanism: ```` ```template ```` blocks, one additive point per kind, `TEMPLATE_KINDS` and `INSTALLERS`, provenance on every row ("Templates").
  - `BUILT_IN_REPORTS` and `BUILT_IN_DASHBOARDS` became canon-base templates, and `dashboards.ensureSeeded` is gone.
  - *User-visible:* the Customization page lists each recipe's templates under its point, with an Install button and what each installed. FSGTM enterprise ships a report, "Open deals by owner and stage", and a paused automation that asks for the buying committee on every new deal.
- **G5. Calls** (built).
  - `calls.model` ("Calls"): the call facts prompt's definitions as partials, and the insight categories' keywords as phrase settings.
  - *User-visible:* the Customization page shows the Calls model. canon-base's settings sheet edits each insight category's words under Calls, so a workspace adds its competitors.

- **G4. Fields** (built).
  - The `fields` point and the ```` ```ai-fields ```` block ("Fields"): a recipe's AI fields, each turned on per workspace through `ensureField`, with provenance on `researchAgents`.
  - FSGTM's three people fields moved into each FSGTM recipe's ai-fields block, and `ensurePeopleField` is gone: people research turns its fields on through the point.
  - *User-visible:* the Customization page lists each recipe's fields with a switch, and AI fields says which recipe each field came from.

- **G6. Account and contact pages** (built).
  - `account.page` and `contact.page`, laid out by `canon-base`; components,
    hosts and condition scopes per object; one page per company.
  - *User-visible:* a company has one page, with its fit, status and owner
    beside its name, every field, why it fits, its timeline, signals, deals and
    people. The Customization page picks each page's recipe.

- **G7. ICP fit weights** (built).
  - `scoring.fit`, a model point ("Model points"): the weights
    `icpToWeights` gives an ICP, and the levels a buyer has when an ICP picks
    none. canon-base 1.2.0 contributes it with the values the code had, and
    the `ints` and `levels` setting kinds join format 3.
  - A revision that changes the values in force, or a switch of the recipe at
    the point, schedules `icps.rescore`. The 20 fit cases in
    `tests/fixtures/model-equivalence.json` match.
  - *User-visible:* the Customization page lists `scoring.fit` among the model
    points, and Canon defaults' settings sheet has an ICP fit group with the
    rank lists and the default buyer levels.

- **E1. Customizing in the app** (built).
  - Workspace recipes: `{ kind: "workspace" }` sources, `recipeMarkdownRevisions`, and `workspaceProblems`, the editor's and the save's one check ("Customizing in the app").
  - *User-visible:* Customize on every recipe, and `/dashboard/customization/<name>/edit` with checks as you type, problems at their lines, save with a note, and revisions with their diffs and revert.

- **E2. Preview, evals before save, upstream updates** (built).
  - The editor's live preview, the eval gate on save, and the three-way merge of a copy with its upstream ("Customizing in the app"). `recipeMarkdownRevisions` gains `upstream`, widened.
  - *User-visible:* the draft's page drawn on a real record as you type, a "Save anyway" prompt when evals fail, and "Upstream changed" on the package row and in the editor, with a merge that applies clean changes and lists conflicts to resolve.
  - On the Customization page, a field another recipe already made reads "Already provided by <that recipe>, as <field>", without comparing two recipes' versions.
  - Locally, `devSeed:customizeLocal` copies a recipe from a served recipe.md, such as Canon defaults 1.1.0, so the copy's upstream has changed.

- **E3. Visual layout mode** (built).
  - E3a: `describeLayout` and `apply` in `recipes/md/edit.ts`, layout edits that rewrite only their own lines. E3b: `LayoutMode` over the editor's draft ("Visual layout mode").
  - *User-visible:* the recipe editor opens on Visual. An admin drags sections, folds, renames and stages them, removes or adds them, and reorders, renames, hides, adds and conditions buttons, without seeing markdown.

- **E4b. Ask Canon in the editor** (built).
  - The editor's Ask Canon pane over `recipeAgent.proposeEdit`, and a stand-in model on local stacks ("Editing with an agent").
  - *User-visible:* ask for a change in words, see its summary, diff, problems and evals, then Accept it into the draft or Discard it, and Save as usual.

### Setting up the GitHub App (human steps)

1. Create a GitHub App under the fullstackgtm organization (Settings →
   Developer settings → GitHub Apps → New GitHub App).
   - Homepage URL: `https://canoncrm.com`.
   - Callback URL: `https://dev.canoncrm.com/api/recipes/github/setup`. Add
     the production site's `/api/recipes/github/setup` as a second callback
     URL when production gets it.
   - Check **Request user authorization (OAuth) during installation**. GitHub
     then disables the Setup URL and returns users to the callback URL.
   - Leave "Expire user authorization tokens" on. Canon uses the user token
     once and drops it.
   - Webhook: uncheck **Active**.
   - Repository permissions: **Contents** read-only, **Metadata** read-only.
     No organization or account permissions.
   - Where can this App be installed: **Any account**.
2. Generate a private key, and a client secret under "Client secrets".
3. Add five keys in Doppler, project `canoncrm`, configs `dev` and `local`
   (and `prd` when production gets this). The first three read repos; the
   last two prove who connected, and connecting refuses without them:
   - `GITHUB_RECIPES_APP_ID`: the App ID (a number).
   - `GITHUB_RECIPES_APP_SLUG`: the slug from the App's public URL,
     `github.com/apps/<slug>`.
   - `GITHUB_RECIPES_APP_PRIVATE_KEY`: the downloaded `.pem`, as is
     (`BEGIN RSA PRIVATE KEY`). Real newlines or `\n` escapes both work.
   - `GITHUB_RECIPES_APP_CLIENT_ID`: the Client ID (`Iv1.…` or `Iv23…`),
     which isn't the App ID.
   - `GITHUB_RECIPES_APP_CLIENT_SECRET`: the client secret.
4. Merge to `main`. The dev deploy copies the keys to Convex dev before it
   deploys. On a local stack, `npm run secrets:sync` loads them. Then on the Customization page, Connect GitHub on a test
   organization with one private repo holding a package.

## Open questions

- **Which slots in R1.** The deal page alone, or also `contact.rail` for the
  people research fields? Default: the deal page alone.
- **Stages.** `STAGE_LABEL`/`STAGE_EXIT` (in / case / close) are methodology,
  but pipelines and stages are kernel CRM data. A recipe probably maps its
  stages onto a pipeline rather than owning them. Decide in R1.
- **Who owns a recipe's model spend** when no rep is acting (keeper ticks):
  the play's owner, as today, or the installing admin?
- **Iframes (option 3).** Revisit after R5, for verified authors only, if the
  component vocabulary turns out to be the limit.
