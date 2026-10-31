# Customization (formerly Recipes)

The Customization page, `/dashboard/customization`, is where a workspace sees
what it runs and adds more. It was the Recipes page; `/dashboard/recipes` and
its subroutes redirect to it, and the `/mcp` tool `canon_recipes` is now
`canon_customization`, with the old name kept as an alias.

This doc also keeps the inventory from the audit of 2026-10-16: every surface,
what a workspace can change on it, what stays fixed on purpose, and what is not
built yet with what it waits on. `docs/recipes.md` describes the package
machinery and `docs/modules.md` the modules.

## The two pieces

- **Modules.** Self-contained units made by Canon or another author, installed
  from Canon's built-ins or from GitHub (`docs/modules.md`). A module brings its
  own data and pages under one nav entry.
- **Pages.** Every Canon page can be changed. A **package** (a `recipe.md`,
  called a recipe in ids and Convex functions) contributes to named points: the
  deal, account and contact pages, the theme, the navigation, eight model
  points (forecast, customer health, lead scoring, ICP fit, signal heat,
  hygiene, calls, target accounts), AI fields, and six template points. An
  admin or manager edits a package's settings on the Customization page; every
  save is a revision, and agents propose changes the same way. Customize copies
  a package so its `recipe.md` can be edited, visually or as markdown, with Ask
  Canon. A module's own pages can't be changed yet: no point exists for them.

Workspace data shapes Canon too: custom objects and fields, pipelines, ICPs and
audiences, role permissions, saved views on record lists, targets, automations,
workspace settings (fiscal year, currency, timezone), each AI field's spec, each
agent's budget and Slack mode, and integration field mappings.

## The page

Two tabs, one per job.

- **Applied** is what the workspace runs now: counts (modules on, pages
  changed, theme, packages), then **Modules** (on or off, version, Canon or
  GitHub, a newer Canon build), **Pages** (each Canon page a package changed,
  and each module's pages), **Every page** (theme, navigation, data model,
  pipelines) and **Packages**. Every row has one primary action: Open, Turn on,
  Update, Customize or Edit; the rest sits in its details or its More menu.
  Pages as Canon ships them fold behind one line.
- **Browse** (`?tab=browse`) is what to add: Canon's modules, what installed
  packages offer that isn't on yet, and installing a module or a package from
  GitHub, public or from a connected private account.

A page counts as changed when one of its points runs something other than what
a new workspace starts with. `src/app/dashboard/customization/page-map.ts`
places every point on the page it changes (`POINT_PAGE`), so a new point
doesn't compile until it has one.

## By surface

| Surface | What a workspace changes | Through |
|---|---|---|
| Sidebar and command palette | Pages hidden from everyone or from reps; the page Canon opens on | `workspace.nav` |
| Theme | Colours, heading type, corners | `workspace.theme` |
| Deal, account and contact pages | Sections, their order and folding, buttons | `deal.page`, `account.page`, `contact.page` |
| Record lists at `/dashboard/records/<object>` | Saved views: filters, sort, columns, table or board; private or shared | `savedViews` |
| Revenue | Forecast weights and coverage, the closing-soon window | `forecast.model` |
| Reports | Saved reports and dashboards, private or shared; targets by fiscal year | Workspace data, `templates.*` |
| Customer health, lead scoring, ICP fit, signal heat | Every weight, band and threshold | Their model points |
| ABM | The engagement score's parts and the engaged threshold | `abm.model` |
| Calls | What a call's answers mean, insight phrases, a suggested deal's close date | `calls.model` |
| Hygiene audit | Thresholds, required fields, rules turned off | `hygiene.policy` |
| Plays | Core roles, quiet days, the urgent window, drafts, research cadence, qualification and deal terms | The deal recipe's settings |
| AI fields | Questions, refresh, auto-accept per field | `fields`, field specs |
| Review | Which source owns each field; auto-accept rules | Workspace settings |
| Data model, pipelines | Objects, fields, picklists, stages | Admin editors |
| Roles | The workspace's own roles: a name, the built-in role each counts as, and the capabilities it holds beyond its record rules. Every role's records seen and fields hidden or read-only, per object | `orgRoles`, `rolePermissions`, `convex/lib/capabilities.ts` |
| Object names | What Accounts, People, Opportunities and every other standard object are called, everywhere they show and in Ask Canon's answers | `objectDefs.labels`, Data model |
| LinkedIn, dialer | Sending hours and limits per sender, cadences, recording, do-not-call | Per-user and workspace settings |
| Agents | Budgets, grants, Slack mode, automations | Per-agent specs |

## Fixed on purpose

These stay the kernel's whatever a workspace or recipe says
(`docs/recipes.md`, "Kernel, permanently"):

- The records ledger, the facts gate and source ownership.
- Writes and their gates: approvals, grants, compare-and-set, signed patch
  plans.
- Tenant isolation and the enforcement of permissions.
- Sending compliance: the email cap per inbox, LinkedIn limits, dialer calling
  hours and abandon rate.
- Credits, billing and spend caps; ceilings and scheduling.
- The record schema and identity: duplicate matching weights (shared with the
  record service), `DEAL_ROLES` (the deal-contact edge labels; which roles a
  deal needs is a recipe setting), the forecast categories, and the ICP gate
  formula (compiled to SQL).
- Hygiene severity weights, so a workspace's health trend stays comparable.
- Pages outside a workspace: the marketing site, sign-in and `/start` stay on
  Ledger. No workspace exists to theme them.

## Not built yet

| Gap | Waits on |
|---|---|
| Saved views and columns on the Deals and People pages | A list column for a deal's CRM account and a contact's account. Today a synced deal's company comes from the CRM mirror, which the shared list can't show. People also needs its six page actions ported. |
| Saved views on Accounts and My work | Accounts is a TAM explorer whose drill-down isn't a list filter. My work is a checklist, where columns add little. |
| Nav order | An ordered-list setting kind. |
| Record pages for leads, tasks, products and custom objects | Related lists or kernel actions on those objects. A recipe could only regroup fields today. |
| Notifications beyond agent turns | A rules point. |
| Signals, dedupe rules, hygiene rules, routing, call extractors | Their planned points (`docs/recipes.md`, "Points"). |
| Revisions for AI field specs and agents | Versioned specs (`docs/recipes.md`, "The kernel"). |
| Fiscal quotas and old targets plans | #520. |
