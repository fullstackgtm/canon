/**
 * Canon tools for the writes a record page makes between records: merging
 * duplicates, links between people and companies, roles on a deal, and
 * activities logged against several records.
 *
 * Same Convex functions the dashboard calls, run as the caller, so their role
 * checks apply unchanged (merge, undo and dismiss are admin or manager; the
 * rest are the page's). `args` passes through to the function's validator.
 */
import { api } from "../../../convex/_generated/api.js";
import type { CanonTool } from "./_canonTools.ts";
import { a, groupTool, m, q } from "./_canonJobTools.ts";

const customizationTool = groupTool(
  "canon_customization",
  "The workspace's customizations (shown on the Customization page): sets of page changes, each with an id such as fsgtm-enterprise-deal, which args name recipeId. The deal page customization decides what every deal page shows and whether deals have a play. \"fsgtm-enterprise-deal\" (the default) runs canon_deal_play; \"canon-base\" shows each deal's fields and has no play, so canon_deal_play refuses. A customization has settings (draft limits, phrase checks, core roles, people research questions) and evals: sample calls whose results must hold on any settings. To change settings, call describe, try your change with run_evals, then propose it with a note. A customization contributes to points, such as deal.page; list_contributions shows each point, what the workspace's customizations offer there and which is on. A proposal waits for an admin or manager to approve or reject it on the Customization page; you can't approve, reject or save settings yourself, or turn a contribution on or off. Customizations also install from GitHub repos, public or private in an account an admin connected on the Customization page (github_connections and github_repos show them): preview_install shows what one asks for and how its evals do, and check_upgrade shows what an upgrade would change; installing, upgrading and uninstalling are for an admin or manager on the Customization page. A workspace customization (@workspace/<name>) is the workspace's own copy of one, edited as markdown in the app: get_markdown reads its customization.md, list_revisions its history, and get_upstream what changed in the customization it was copied from. propose_edit has a model rewrite a customization.md for a request in words and returns it checked, with its diff and evals; it saves nothing, so show the person the proposal. Phrase checks are case-insensitive JavaScript regex sources; nested or overlapping repeats like (a+)+ are refused. recipeId defaults to the deal page customization.",
  {
    for_org: q(api.recipes.forOrg, "{} -> { dealPage: { id, title, description, author, sections, ref, settings }, available, canEdit }"),
    list_contributions: q(api.recipes.contributions, "{} -> { points: [{ id, kind, cardinality: exclusive | additive, title, binds: data | code, contributions: [{ recipeId, key, title, recipeTitle, enabled }] }], canEdit } (an exclusive point has exactly one enabled; an additive one any number)"),
    describe: q(api.recipes.describe, "{ recipeId? } -> { id, version, title, author, dealPage (sections), schema (each setting's key, label, help, group, kind and limits), defaults, settings (in force), revision, evals: [{ name, description }], openProposals }"),
    get_settings: q(api.recipes.settings, "{ recipeId } -> { schema, defaults, settings, revision, revisions (latest 20 in force, each with a diff against its parent), proposals (open) }"),
    run_evals: a(api.recipes.runEvals, "{ recipeId?, changes: { <key>: value } (on top of the settings in force; {} runs them as they are) } -> { diff, evals: [{ name, ok, detail }] } (stores nothing)"),
    propose: a(api.recipes.proposeSettings, "{ recipeId?, changes: { <key>: value }, note (required: what it changes and why, for the approver) } -> { revision, diff, evals, next } (runs the evals and stores a proposal for an admin or manager to approve)"),
    list_proposals: q(api.recipes.listProposals, "{ recipeId? } -> { proposals: [{ revision, status: open | approved | rejected, author, note, diff, evals, decision }] } (open ones, then recently decided)"),
    preview_install: a(api.recipes.previewInstall, "{ source: \"github:owner/repo[/path]@ref\" } or { markdown: \"<a customization.md>\" } -> { id, version, title, author, pinned: { sha, ... } | null, bundleHash, hasCode, parts: [{ play, from: prompt|builtin|code, name }], permissions, dealPage, schema, defaults, evals, installed } (reads the repo's customization.md, and dist/customization.js if it has code, at the commit the ref names, a private one through the workspace's GitHub connection, and runs its evals; a pasted customization.md previews the same way and can't be installed; installs nothing)"),
    github_connections: q(api.githubRecipes.connections, "{} -> { configured, connections: [{ installationId, account: { login, type }, connectedAt, connectedBy }] } (the GitHub accounts whose private repos the workspace installs from)"),
    github_repos: a(api.githubRecipes.repositories, "{ installationId (from github_connections) } -> [{ fullName, private }] (the repos a connected GitHub account lets Canon read)"),
    get_upstream: a(api.workspaceRecipes.upstream, "{ recipeId } -> { version, base, theirs } (for a workspace customization, @workspace/<name>: the customization.md of the customization it was copied from as it is now, `theirs`, and as it was when last copied or merged, `base`, both with the copy's id, title and author; a three-way merge of base, the copy and theirs is how an admin takes an upstream update in the editor; reads only)"),
    get_markdown: q(api.workspaceRecipes.markdown, "{ recipeId, revision? } -> { recipeId, revision, markdown } (a workspace customization's customization.md, @workspace/<name>, at its current revision or the one named; a first-party customization's as Canon ships it, revision null)"),
    list_revisions: q(api.workspaceRecipes.revisions, "{ recipeId } -> { revisions: [{ revision, parent, status: current | superseded, note, author, createdAt, diff: { added, removed, text } }] } (a workspace customization's latest 20 saved customization.md revisions, newest first; customizing, saving and reverting are for an admin or manager on the Customization page)"),
    propose_edit: a(api.recipeAgent.proposeEdit, "{ recipeId, baseMarkdown (the whole customization.md to edit), request (what to change, in words, up to 2,000 characters), object?: deal | account | contact (the page the request is about) } -> { markdown, summary, diff (unified, against baseMarkdown), problems: [{ line, message }] (empty when Canon reads it), evals: [{ name, ok, detail }], evalsNotRun, attempts, tokens, model } (a model edits the customization.md on your own ChatGPT plan with Canon's layout skill, Canon's parser checks it with up to two retries, and its evals run; refuses without a connected plan; saves nothing)"),
    check_upgrade: a(api.recipes.checkUpgrade, "{ recipeId } -> { from, to: null (up to date) | { version, ref, sha }, lines: [{ key, kind: unchanged | takesDefault | keepsOverride | conflict | invalid | added | removed, ... }], permissions, sections, evals } (changes nothing)"),
  },
);

const AUTOMATION_DOC = "name, object: deal | lead | task | custom_<name>, trigger: { kind: created | deleted } | { kind: updated, field?, from?: [value], to?: [value] } | { kind: schedule, cadence: daily | weekly, minute (0 to 1439 past local midnight), weekday? (0 Sunday to 6, weekly) }, conditions: [{ field, op: eq | neq | in | contains | startsWith | gt | gte | lt | lte | hasAny | hasAll | empty | notEmpty, value? (\"{today}\" on a date) }] (up to 10), actions: [{ kind: set_field, field, value } | { kind: create_task, subject (\"{record}\" is the record's name), dueInDays (0 to 365), owner } | { kind: assign_owner, owner } | { kind: notify_slack, channel (a Slack channel name an admin mapped in Settings > Outbound), message } | { kind: notify_email, to: { kind: member, userId } | { kind: record_owner } (members only, never a contact), subject, message } (in a message, {record} is the record's name and {<field>} a field's value, as the rule's admin sees the record) | { kind: call_webhook, endpointId (a record webhook an admin registered) } | { kind: wait, days (1 to 365) } | { kind: wait, until (a date or date-time field of the record; an empty or past date doesn't wait) } | { kind: if, conditions (1 to 10, as above; a related record's field as <lookup>.<field>, e.g. companyId.industry, read as the rule's member sees it), then: [steps], else?: [steps] } (an if holds one more if, which holds only actions)] (1 to 10 in a row, at most 25 steps in all, in order); owner: { kind: member, userId } | { kind: record_owner } (tasks only) | { kind: round_robin, userIds } | { kind: team, teamId } | { kind: routing_rule, routingRuleId }; money in cents";

const automationsTool = groupTool(
  "canon_automations",
  "Automation rules (the Automations page): when a record changes in Canon, or on a schedule, a rule sets a field, creates a task or assigns an owner, the same way every time, with no AI. Admins only. You can read rules and their runs, check a rule document, and propose one; a proposal does nothing until a person approves it on the Automations page, and you can't approve, reject, turn on, pause, retry or delete a rule yourself. The admin who approves a rule is who it acts as, with their access. Call check first and show your user the sentence it returns: that is what the rule will do. dry_run shows what it would have done over the last two weeks. Then propose it with a note saying why; the approver sees its replay. To change a rule, propose its whole new document with its ruleId.",
  {
    list: q(api.automations.list, "{} -> [{ id, name, object, trigger, conditions, actions, status: active | paused, pausedReason, actsAs, version, lastRun, nextSlotAt }] | null (not an admin)"),
    get: q(api.automations.get, "{ id } -> { ...the rule, sentence, versions: [{ id, version, parent, spec, note, status: proposed | approved | rejected | superseded, author, stale, decidedBy, decidedAt, reason, sentence }] } | null"),
    check: q(api.automations.check, `{ ruleId? (to change that rule), ${AUTOMATION_DOC} } -> { ok: true, sentence } | { ok: false, problem } (stores nothing)`),
    propose: m(api.automations.propose, `{ ruleId? (a new version of that rule; absent: a new rule), ${AUTOMATION_DOC}, note (why, for the approver) } -> { versionId, version, ruleId, status: proposed, sentence } (waits for an admin; nothing runs; its replay is kept for the approver)`),
    proposals: q(api.automations.proposals, "{} -> { open: [{ id, ruleId, version, parent, spec, note, author, stale, sentence, current }], decided: [...] } | null"),
    runs: q(api.automations.runs, "{ ruleId } -> [{ id, streamId, object, title, event, change, matched, status (waiting: a wait step holds it until resumeAt), resumeAt, reason, steps (each with its ref in the rule, and an if's branch: then | else, so the steps are the run's path), version, createdAt }] (latest 25; a record the rule's member can't see shows no title)"),
    dry_run: a(api.automations.replay, "{ versionId } | { ruleId } | { object, trigger, conditions, actions? } -> { wouldRun, runs: [{ streamId, at, title, change, path: [{ ref, took: then | else }] (its way through the ifs) }] (first 50), skipped: [{ reason, count }], partial, through, scanned, since, until, notes } | { schedule: true } (replays the last 14 days of the object's history through the rule's trigger and conditions, as you see records; writes nothing and runs no action; on a proposal it also keeps the summary for the approver. A schedule has no history to replay: use matches_now)"),
    matches_now: a(api.automations.preview, "{ object, trigger, conditions } -> { total, rows: [{ streamId, title }], nextSlotAt, capped } (the records the conditions match now, as you see them; for a schedule, as of its next run; writes nothing)"),
  },
);

const relationTools: CanonTool[] = [
  automationsTool,
  groupTool(
    "canon_duplicates",
    "Find and merge duplicate companies and people (object: \"account\" | \"contact\"). Merging, undoing and dismissing need an admin or manager. Call preview_merge first: it shows each record's values with their source and the default pick per field.",
    {
      list: a(api.duplicates.list, "{ object } -> groups of probable duplicates"),
      dismiss: a(api.duplicates.dismiss, "{ object, ids: string[] (2 to 8 records that are not duplicates) } -> null"),
      preview_merge: a(api.recordMerges.preview, "{ object, ids: string[] } -> { fields, records, picks }"),
      merge: a(api.recordMerges.merge, "{ object, survivorId, loserIds: string[], picks: { <field apiName>: <id of the record whose value survives> } } -> { mergeId, survivorId }"),
      undo: a(api.recordMerges.undo, "{ mergeId } -> { kept: string[] }"),
    },
    { destructive: true },
  ),
  groupTool(
    "canon_associations",
    "Links between people and companies, and a company's parent. The first company a person is linked to is their primary.",
    {
      related: a(api.associations.related, "{ object: \"account\" | \"contact\", id } -> the record's people, companies and parent"),
      link: a(api.associations.link, "{ contactId, accountId, primary?: boolean }"),
      unlink: a(api.associations.unlink, "{ contactId, accountId }"),
      make_primary: a(api.associations.makePrimary, "{ contactId, accountId }"),
      set_parent: a(api.associations.setParent, "{ accountId, parentId: string | null (null removes the parent) }"),
    },
  ),
  groupTool(
    "canon_icp_winners",
    "Check whether your ICPs rank the workspace's real winners near the top, using only accounts and won deals the caller can see. Free, no provider calls. Each company counts once, ties share the middle percentile of their rank range. With fewer than ten won accounts returns needs-ten and no statistics. Uses the first 500 distinct won accounts at most and reports sampled when capped. Below the 60th percentile, review your ICPs' criteria.",
    { read: a(api.icpWinners.read, "{} -> { sampled, check: { status: needs-ten, required: 10, wonAccounts } | { status: ready, wonAccounts, totalAccounts, medianPercentile, topQuarter, below60 } } | null (no active ICP)") },
  ),
  groupTool(
    "canon_market_sources",
    "Find directories, registries and company lists from up to ten workspace seed accounts. Won-deal accounts come first, otherwise the first active ICP's highest-fit accounts. This planning step costs the workspace no credits. Searches run only on dev and production. Source facts are public; seeds, verbatim quotes and exact search queries stay in this workspace. Browse-only catalog entries are never fetched. Read again while the run is running.",
    {
      start: a(api.marketSources.start, "{} -> search run id (starts a background search, or saves a refused run with its reason)"),
      read: a(api.marketSources.read, "{} -> { catalogVersion, catalog, run: { status, reason?, seeds, results: [{ sourceKey, seedDomain, quote, query }], calls, costMicro } | null, sources: [{ key, url, title, kind, listedCount?, filterable?, exportable?, seedHits, markets }] } (sources rank by distinct seedHits; seed evidence is limited to accounts you can currently read)"),
    },
  ),
  groupTool(
    "canon_market_investigations",
    "Map an ICP's market from public directories, employer title phrases and USAspending when relevant. Admins or managers with full workspace visibility can plan, start, read and stop. Plan is free and returns a run id. Read its estimate and sources before start. Start reserves min(estimate, cap), spends free monthly credits first and charges one credit per kept company. Default cap is 500. Read reports live events, found/duplicate/rejected/kept counts and source URLs with verbatim quotes. A paused run continues only by calling start with a larger capCredits. Kept companies wait in staged review at /dashboard/imports/<jobId>; nothing enters the CRM before approval.",
    {
      plan: m(api.tamInvestigations.plan, "{ icpId?, capCredits? } -> investigationId (free planning; read until awaiting_start)"),
      start: m(api.tamInvestigations.start, "{ investigationId, capCredits? } -> investigationId (starts the reviewed plan, or continues paused_at_cap with a raised cap)"),
      read: q(api.tamInvestigations.read, "{ investigationId? } -> { canMap, run: null | { plan, estimateCredits, capCredits, spentCredits, counts, events, jobId, candidates (up to 100) } }; omit id for latest"),
      stop: m(api.tamInvestigations.stop, "{ investigationId } -> null (returns unused held credits and opens kept companies for staged review)"),
    },
  ),
  groupTool(
    "canon_company_people",
    "Find contacts for an approved company, only when a person asks. Read the estimate before starting. Up to five people, one credit per newly kept contact and five per valid work email. Starts a held, capped background run. Free QuickEnrich buyer titles, then anyone at the domain, website staff, signed Google owner replies and an Exa owner answer when needed. Paid steps are skipped with a note on local deployments. Keyword-first buyer roles with model reasoning, source links and quotes. Suppressed people and duplicates are never kept or charged. Only valid emails are sendable. No automatic runs.",
    {
      read: a(api.companyPeople.read, "{ accountId } -> { canFind, estimateCredits, limit, paid, run: null | { status, people: [{ contactId, fullName, title?, role: decision_maker | champion | other, reasoning, source, url, quote?, email, emailStatus, sendable }], sourceCounts, spentCredits, notes } }"),
      start: a(api.companyPeople.start, "{ accountId, icpId? } -> runId (call only after presenting the estimate and the person requests Find people; repeated calls while running return the same run)"),
    },
  ),
  groupTool(
    "canon_website_facts",
    "Facts Canon read from a company's public website, each with the page it came from: LinkedIn URL, social profiles, addresses, founding year (or the first Wayback capture), size clues (RDAP domain registration year, first seen on the web, location count, open roles grouped by field/technician, sales, engineering, operations or other, and physical operations with verbatim website sentences), role mailboxes, and up to 25 staff names with stated titles, source URLs and verbatim quotes. Size clues are evidence, never inferred headcount. recordSize carries only existing private CRM headcount with its record URL; no paid size provider is called. Public website facts are shared across workspaces; suppressed names are excluded. Staff comes only from the team page, or the homepage when no team page is found. staffModelStatus reports complete, skipped-no-key or failed for the additional model extraction. discoverySources contains source URLs and verbatim quotes from this workspace's approved market investigations. Reading a company that has none or whose read is over 90 days old starts a read: call again until reading is false.",
    {
      get: a(api.companyWebFacts.forAccount, "{ accountId } -> { domain, reading, facts: { status: \"ok\" | \"unreadable\" | \"error\", pages, linkedinUrl?, socials, addresses, founded?, locationCount?, openRoles?, domainRegistered?, roleFamilies?, physicalOperations?, emails, staff?, staffModelStatus?, fetchedAt } | null, recordSize?: { employees?, url }, discoverySources?: [{ kind, url, quote }] } | null (null: no readable company or no domain)"),
    },
  ),
  groupTool(
    "canon_deal_roles",
    "The people on a deal and the role each plays (the buying committee). A deal is named by its stream id (the id canon_list_records returns for object \"deal\"). Roles: executive, n1, champion, user, procurement, security, signer, involved.",
    {
      for_deal: a(api.dealCommittee.forDeal, "{ streamId } -> the deal's people and roles"),
      for_company: a(api.dealCommittee.forCompany, "{ companyId, domain?, stream? } -> the company's people across its deals"),
      set_role: a(api.dealCommittee.setRole, "{ streamId, contactId, role, reason? } (adds the person to the deal if needed)"),
      remove: a(api.dealCommittee.removeFromDeal, "{ streamId, contactId }"),
    },
  ),
  groupTool(
    "canon_deal_play",
    "A deal's play: the control plane for working a large account (docs/deal-plays.md). get returns the brief, its cited evidence, the decision window, the account map with each person's thread (untouched, waiting, replied, engaged, quiet), the outreach plan (steps a touch completed are marked) and the keeper's flags with a proposed step for each. Write research you did with add_items: give each fact a sourceUrl and a quote copied exactly from that page, and Canon marks it verified when the quote is there. Persona, angle, why-now and the alpha are hypotheses. A deal is named by its stream id; roles are set with canon_deal_roles. Channels: linkedin, email, call, meeting, task, other. Item kinds: timeline, signal, competitor, risk, gap, discovery.",
    {
      list: a(api.dealPlays.list, "{} -> every play on a deal you see: health, window, coverage, engaged people, replies owed, next touch, ownerId, closeDate, lastTouch (date and channel, as of the keeper check), stateSummary (qualification completeness, stage label and mismatch, top open objection and risk, main issue, generatedAt). Restricted roles receive null stateSummary and lastTouch with stateHidden true."),
      get: a(api.dealPlays.get, "{ streamId } -> the control plane, including state (summary, stage read, cited qualification, concerns and coverage) and stateRun. Its actions are what the workspace's deal page customization offers a person at the deal's stage, in the page's order: each with its label, the method here that does the same (null when only a person can, such as sending from their Gmail), and the shows and enabled conditions the page checks"),
      regenerate_state: a(api.dealStateActions.regenerate, "{ streamId } -> { started, connected } (regenerates the evidence-backed deal state on your ChatGPT plan; owner, manager or admin only; poll get stateRun)"),
      dismiss_concern: a(api.dealPlays.dismissConcern, "{ streamId, key } (dismiss a saved deal-state objection or risk; dismissal survives later runs)"),
      set_brief: a(api.dealPlays.setBrief, "{ streamId, context?, whyNow?, alphaHypothesis?, alphaPitch?, windowLabel?, windowClosesOn?: \"YYYY-MM-DD\" } (\"\" clears a field)"),
      add_items: a(api.dealPlayActions.addItems, "{ streamId, items: [{ kind, text, quote?, sourceUrl?, occurredOn?: \"YYYY-MM-DD\" }] } (at most 25) -> { added, verified, unverified }"),
      dismiss_item: a(api.dealPlays.dismissItem, "{ streamId, itemId }"),
      set_person: a(api.dealPlays.setPerson, "{ streamId, contactId, reportsTo?: contactId, persona?, angle?, confidence?: \"high\" | \"medium\" | \"low\" } (\"\" clears)"),
      save_step: a(api.dealPlays.saveStep, "{ streamId, stepId? (omit to add), title, channel, contactId? | role?, ownerUserId?, dueOn?: \"YYYY-MM-DD\", state?: \"planned\" | \"done\" | \"skipped\" }"),
      remove_step: a(api.dealPlays.removeStep, "{ streamId, stepId }"),
      set_draft: a(api.dealPlays.setDraft, "{ streamId, stepId, contactId (who it is for), subject?, body } (the message for a step; \"\" body clears)"),
      draft_step: a(api.dealPlayKeeper.draftStep, "{ streamId, stepId } (Canon drafts the step's message on your ChatGPT plan) -> { subject?, body }"),
      first_touches: a(api.dealPlayKeeper.firstTouches, "{ streamId, contactIds: [contactId] } (Find the way in: puts each person on the deal, gives them a first-touch step and drafts it on your ChatGPT plan; at most 5; never sends) -> { drafted, error }"),
      rank_prospects: a(api.dealPlays.rankProspects, "{ streamId } -> { keys: [\"c:contactId\"], note } (the deal's ICP buyers ranked best fit first by Jev; a saved ranking is reused until the buyers, evidence or brief change)"),
      check_now: a(api.dealPlayKeeper.checkNow, "{ streamId } (run the keeper now: drafts the steps due in the next 3 days) -> { drafted, error }"),
      queue_linkedin: a(api.dealPlays.queueLinkedin, "{ streamId, stepId, senderAccountId (your LinkedIn sender) } (queues a LinkedIn step's draft on the play's cadence: invite, then the message)"),
      research: a(api.dealPlayActions.research, "{ streamId } (Canon researches the account on your ChatGPT plan in the background, or without one on Canon's model for 1 credit if it finds anything; poll get's research.status)"),
      research_people: a(api.dealPlayActions.researchPeople, "{ streamId, contactIds: [contactId] } (at most 25 of the deal's people: researches each one's primary goal and responsible systems as contact AI fields, then Jev's innovation-or-stability call and the new capability your product gives them; on your ChatGPT plan, or without one on Canon's model at 1 credit per answer found, in the background; poll get's peopleResearch.status, then prospects' center and capability) -> { note }"),
    },
  ),
  groupTool(
    "canon_deal_chat",
    "Ask Canon about one deal, with its deal state, play, people and recent touches loaded (docs/ask-canon.md, docs/deal-state.md DS5). Chats are saved per deal for their owner, who can share one with members who can see the deal; every read checks the reader can still see it. Answers are read-only and their links cite records; nothing is sent. A deal is named by its stream id.",
    {
      list: q(api.dealChats.list, "{ streamId } -> { mine, shared }: the deal's saved chats you own and those shared with you"),
      get: q(api.dealChats.get, "{ chatId } -> the chat and its messages"),
      create: m(api.dealChats.create, "{ streamId, title } -> chatId (a new saved chat on the deal)"),
      send: a(api.askCanon.send, "{ question, streamId, chatId? } -> { answer, sources } (answers on your ChatGPT plan with the deal's context; with chatId the turn is saved to that chat)"),
      share: m(api.dealChats.share, "{ chatId, userIds: [userId] } (owner only; the members must see the deal)"),
      remove: m(api.dealChats.remove, "{ chatId } (owner only; deletes the chat and its messages)"),
    },
  ),
  customizationTool,
  groupTool(
    "canon_activities",
    "Log a note, task, call or meeting about one or more records, and read a record's timeline.",
    {
      log: a(api.activityTargets.logScoped, "{ object: \"note\" | \"task\" | \"call\" | \"meeting\", values: { <field apiName>: value }, targets: [{ object: \"account\" | \"contact\" | \"deal\", id }], idempotencyKey? } -> the write's result; the same idempotencyKey and args return the first result"),
      for_record: a(api.activityTargets.forRecord, "{ object: \"account\" | \"contact\" | \"deal\", id } -> { activities, projectedThrough }"),
      history: a(api.objects.historyScoped, "{ streamId, paginationOpts: { numItems, cursor: string | null } } -> a record's change history, newest first"),
    },
  ),
];

const legacyRecipesAlias: CanonTool = {
  ...customizationTool,
  name: "canon_recipes",
  description: `The old name of canon_customization: the same actions and args. Prefer canon_customization.\n${customizationTool.description.slice(customizationTool.description.indexOf("Actions and their args:"))}`,
};
export const canonRelationTools: CanonTool[] = [...relationTools, legacyRecipesAlias];
