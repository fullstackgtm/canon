/**
 * The interaction-parity audit (scripts/fsgtm.ts) lists these as human-only
 * instead of as gaps. Keep the names out of gtm-mutation-registry.ts and the
 * CLI/MCP sources.
 *
 * Boundary: the server checks the signed-in person's role. A process holding
 * a person's own Clerk session token is that person, as for every admin
 * action (canonGate.decide and setAutoAcceptRule are already on the tool
 * surface); hosted agents, CLI tokens and agent tokens never reach these.
 */
export const gtmHumanOnlyFunctions: Readonly<Record<string, string>> = {
  // docs/org-agents.md: agents never create or modify standing write grants.
  "api.agentGrants.create": "standing write grants are an admin's approval; agents never grant themselves writes",
  "api.agentGrants.revoke": "standing write grants are an admin's approval; agents never modify them",
  "api.moduleGrants.create": "a module's standing grant is an admin's approval in advance; agents never grant writes",
  "api.moduleGrants.revoke": "a module's standing grant is an admin's approval in advance; agents never modify it",
  "api.mailboxGrants.createManifest": "only the real mailbox owner gives consent to send a reviewed template; agents never grant mailbox rights",
  "api.mailboxGrants.createSq1Set": "only the real mailbox owner gives consent to the reviewed canonical sequence template set",
  "api.mailboxGrants.revoke": "only the real mailbox owner manages their mailbox consent",
  // docs/conversation-intake.md: reading a person's messages needs that person's own consent. Agents list and read
  // conversations and stop intake on their own person's account through canon_conversations (conversationsApi.stopIntake).
  "api.conversations.setIntake": "only the account's owner consents to Canon reading their messages; an agent never turns it on (it may turn it off with canon_conversations stop_intake)",
  // convex/emailLog.ts: the address is a secret that logs mail as its member; replacing it breaks their mail filters.
  "api.emailLog.regenerate": "a member's logging address logs mail as them; only that member makes or replaces it, in the app",
  "api.conversations.deleteRead": "erasing what was read cannot be undone and is the owner's decision about their own messages, made in the app",
  // docs/account-hierarchy-manager.md: a person approves proposed merges and parent moves, and owns the hard rules.
  "api.accountHierarchy.decide": "approving a proposed merge, parent move or field fix is a person's decision; an agent never approves its own research",
  "api.accountHierarchy.approveParent": "approving a parent move changes Canon's hierarchy as the approver; the hierarchy page is its only approval, and an agent never approves its own research",
  "api.accountHierarchy.undoParent": "undoing an applied parent move reverses a person's approval; it stays with the person who decides",
  "api.associations.useCrmParent": "taking a CRM's parent over the one a person set in Canon is that person's call on the record page or the hierarchy page; an agent sets parents with set_parent",
  "api.associations.useCrmCompany": "taking a CRM's company over what a person chose for someone in Canon is that person's call on the record page; an agent links a person's companies with canon_associations",
  "api.dealCommittee.useCrmRole": "taking a CRM's deal role over the one a person set in Canon is that person's call on the deal page; an agent sets deal roles with canon_deal_roles",
  "api.accountHierarchy.savePolicy": "the hierarchy policy holds the hard rules (owners never change, active contracts flagged); an agent never relaxes its own guardrails",
  // Admin settings that change what every record accepts or where data is sent.
  "api.dataModel.createField": "field definitions are admin settings: they change what every record, import and API write accepts",
  "api.dataModel.updateFieldDef": "field definitions are admin settings: they change what every record, import and API write accepts",
  "api.dataModel.setArchived": "field definitions are admin settings: they change what every record, import and API write accepts",
  "api.dataModel.relabel": "an object's name is an admin setting: it renames the object for everyone in the workspace",
  "api.customObjects.create": "object definitions are admin settings: they add or retire whole objects every page, import and API write resolves",
  "api.customObjects.edit": "object definitions are admin settings: they add or retire whole objects every page, import and API write resolves",
  "api.customObjects.setArchived": "object definitions are admin settings: they add or retire whole objects every page, import and API write resolves",
  "api.pipelines.save": "pipeline stages are admin settings that every deal and report depends on",
  // Workspace export (convex/workspaceTransfer.ts): a key reads every record of the workspace for an hour.
  "api.workspaceTransfer.createExportKey": "an export key lets whoever holds it read the whole workspace for an hour; an admin creates it in Settings, never an agent",
  "api.workspaceImport.createImportKey": "an import key lets whoever holds it write a whole archive into an empty workspace; an admin creates it in Settings, never an agent",
  "api.workspaceTransfer.revokeExportKey": "export keys are an admin's, made and revoked in Settings",
  "api.workspaceImport.revokeImportKey": "import keys are an admin's, made and revoked in Settings",
  "api.users.createMember": "adding a member decides who can own deals and who an invite signs in as; an admin's call, never an agent's",
  "api.users.invite": "it sends an invite email from Clerk to a person; an agent never invites people",
  "api.localAuth.invite": "it creates a login link that lets a person into the workspace; an admin decides who joins, never an agent",
  "api.sampleData.load": "loading sample data adds members who never sign in and hundreds of records to a test workspace; an admin's call, made in the app on dev and local stacks only",
  "api.users.importReportingLines":"reporting lines decide what every manager's team-scoped role sees; a person's call, from a file they chose",
  // CP14: permissions decide what every member, token and agent sees; an agent never widens its own access.
  "api.permissions.saveRole": "role permissions decide what every member, API token and agent sees and changes; an admin's call, never an agent's",
  "api.permissions.defineWorkspaceRole": "roles are admin settings: a role decides what everyone who holds it may do",
  "api.permissions.removeWorkspaceRole": "roles are admin settings: a role decides what everyone who holds it may do",
  "api.permissions.createTeam": "teams decide whose records a team-scoped role sees; an admin's call, never an agent's",
  "api.permissions.updateTeam": "teams decide whose records a team-scoped role sees; an admin's call, never an agent's",
  "api.permissions.removeTeam": "teams decide whose records a team-scoped role sees; an admin's call, never an agent's",
  "api.permissions.startPreview": "\"view as\" is an admin looking at the dashboard as a member, read-only; it has no meaning for a token or agent",
  "api.permissions.stopPreview": "ends an admin's own \"view as\" preview in the dashboard",
  // Local stacks only (convex/devAuth.ts): refused wherever the dev auth bypass is off.
  "api.devAuth.actAs": "a local stack's \"Signed in as\" switch for its seeded members; it exists only on the dev auth bypass, never for a token or agent",
  // CP12: the HubSpot portal import runs on the workspace's HubSpot connection, which only an admin or manager makes.
  "api.hubspotImport.start": "a whole-portal CRM import writes every company, person and deal in the workspace from the admin's own CRM connection; an admin starts it",
  "api.hubspotImport.resume": "a whole-portal CRM import writes every company, person and deal in the workspace from the admin's own CRM connection; an admin starts it",
  "api.hubspotImportActions.spotCheck": "re-reads the connected HubSpot portal to check an admin's import; it runs with the admin's CRM connection",
  "api.recordingPolicy.save": "recording consent and exclusions are the workspace legal floor; an admin decides them",
  "api.recordWebhooks.create": "outbound webhook endpoints send record data out and hold a signing secret; an admin's call",
  "api.recordWebhooks.update": "outbound webhook endpoints send record data out and hold a signing secret; an admin's call",
  "api.recordWebhooks.remove": "outbound webhook endpoints send record data out and hold a signing secret; an admin's call",
  "api.connectors.createWebhook": "a signed webhook lets an outside system write the workspace's feeds and hands back its signing secret; a person's call",
  "api.connectors.rotateWebhook": "rotating a signed webhook's secret cuts off its sender and hands back a new secret; a person's call",
  "api.connectors.removeLink": "removing a connector link stops a feed modules read; a person's call",
  "api.connectors.setFeedGrant": "only the signed-in account owner changes a module's read access to their personal connector; agents never grant or revoke it",
  // docs/modules.md, "Outbound": what a module may send, and where it goes, is an admin's; a message leaving Canon is a person's.
  "api.outbound.setChannel": "turning on what a module may send is an admin's call",
  "api.outbound.mapSlack": "a Slack channel's webhook URL is a credential, and where modules post is an admin's call",
  "api.outbound.addWebhook": "webhook endpoints send module data out and hold a signing secret; an admin's call",
  "api.outbound.removeTarget": "where modules send is an admin's call",
  "api.outbound.act": "approving a message, or sending it now, decides that it leaves Canon; a person's call",
  "api.outboundEmailPolicy.save": "postal address and recipient caps set the workspace compliance policy; a human admin decides them",
  "api.suppressions.add": "workspace do-not-contact rules record an admin's compliance decision",
  "api.suppressions.lift": "lifting a workspace do-not-contact cause permits outreach again; an admin's call",
  // CP17: a rule acts as its creator on every future change, with their access, unattended; like a standing grant, an admin's call.
  "api.automations.create": "an automation rule writes as its admin creator on every future matching change, unattended; an admin builds it, as with standing grants",
  "api.automations.update": "an automation rule writes as its admin creator on every future matching change, unattended; an admin changes it, as with standing grants",
  "api.automations.setStatus": "pausing or resuming a rule decides whether it writes as its admin creator; an admin's call",
  "api.automations.remove": "an automation rule writes as its admin creator; an admin removes it",
  "api.automations.retryRun": "a retry repeats a rule's write as its admin creator; an admin's call",
  "api.automations.preview": "a rule's dry run is part of the admin-only builder; it writes nothing, and agents do not build rules",
  // docs/recipes.md R4: an agent proposes recipe settings (canon_customization propose); an admin or manager decides in person.
  "api.recipes.approveProposal": "approving a package settings proposal is the human gate on agent-written methodology; agents propose, never approve",
  "api.recipes.rejectProposal": "deciding a package settings proposal is an admin's call; agents propose, never decide",
  "api.recipes.saveSettings": "package settings change how every deal is drafted, checked and researched; agents propose them and an admin approves",
  "api.recipes.enableContribution": "turning a package contribution on, such as switching the deal page package, changes every deal page or record for the whole workspace; an admin's call",
  "api.recipes.disableContribution": "turning a package contribution off changes what every record shows or runs for the whole workspace; an admin's call",
  // Customize mode: a person reshapes the deal page in place. Agents propose recipe edits with canon_customization propose_edit.
  "api.pageCustomize.edit": "customize mode is a person pointing at their own deal page and judging it live; an agent proposes customization.md edits with canon_customization propose_edit instead",
  "api.pageCustomize.save": "saving customize mode's draft changes the deal page for the whole workspace, and may make and switch to a workspace copy; an admin's call",
  "api.recipes.revertTo":"reverting package settings changes how every deal is drafted, checked and researched; an admin's call",
  // docs/recipes.md R5: agents preview installs and upgrades (canon_customization preview_install, check_upgrade); a person decides.
  "api.recipes.install": "installing a package brings another author's code into the workspace's deal pages; an admin reviews its permissions and evals and decides",
  "api.recipes.upgrade": "upgrading a package runs a new version of another author's code and resolves settings conflicts; an admin's call",
  "api.recipes.uninstall": "uninstalling a package removes it from every picker in the workspace; an admin's call",
  // docs/modules.md: agents list, describe, read and write modules through canon_module; a person installs and turns them on.
  "api.modules.issueLink": "issuing a customer link grants access outside the workspace; the share requires a person",
  "api.modules.install": "installing a module adds another author's collections and pages to the workspace; an admin reviews what it adds and decides",
  "api.modules.setEnabled": "turning a module on or off adds or removes its nav entry and pages for the whole workspace; an admin's call",
  "api.modules.uninstall": "uninstalling a module removes it from the workspace; an admin's call",
  "api.modules.cancelUpgrade": "cancelling a module's upgrade decides which version serves; an admin's call",
  "api.modules.uploadUrl": "a module's file field takes a file its person picks on their own machine; an agent downloads files (canon_module file) but doesn't attach them",
  // docs/recipes.md "Customizing in the app": agents read a workspace recipe's markdown and revisions (canon_customization get_markdown, list_revisions); a person edits it.
  "api.workspaceRecipes.customize": "customizing makes a workspace copy of a package that can then lay out every page; an admin or manager makes it",
  "api.workspaceRecipes.save": "a saved customization.md changes the pages and plays of whoever runs it in the workspace; agents read it and an admin or manager edits it",
  "api.workspaceRecipes.revert": "reverting a customization.md changes the pages and plays of whoever runs it in the workspace; an admin's call",
  // docs/recipes.md R5b: the workspace's connection to Canon's GitHub App decides which private repos it can read.
  "api.githubRecipes.startConnect": "connecting Canon's GitHub App lets the workspace read an organization's private repos; an admin or manager signs in to GitHub and picks the repos",
  "api.githubRecipes.completeSetup": "finishes connecting Canon's GitHub App from GitHub's redirect, with the admin's own GitHub sign-in",
  "api.githubRecipes.disconnect": "disconnecting GitHub stops the workspace's private packages from updating; an admin's call",
  // docs/dialer.md: a dialing session rings the rep's own phone and connects people to the rep's voice.
  // An agent can't be on the call; calling for a rep needs a per-call approval first (Next in that doc).
  "api.dialer.startSession": "a dialing session rings the rep's own phone; only the rep on that phone starts one",
  "api.dialer.endSession": "ends the rep's live phone call",
  "api.dialer.hangupCall": "hangs up a live call the rep is on",
  "api.dialer.setOutcome": "the rep's own account of a call they were on",
  "api.dialer.saveProfile": "the voicemail is left in the rep's name on calls only the rep places",
  "api.dialerActions.callContact": "dials a person onto the rep's own live phone call",
  "api.dialerActions.dialContacts": "dials people onto the rep's own live phone call",
  "api.dialerActions.browserToken": "signs this browser tab in as the rep's phone; it has no use outside the tab",
  "api.dialer.addNumber": "the numbers a workspace calls people from are an admin's telephony setup",
  "api.dialer.removeNumber": "the numbers a workspace calls people from are an admin's telephony setup",
  "api.dialer.saveSettings": "whether calls are recorded is an admin's legal call (recording consent)",
  "api.dialer.addDoNotCall": "a person's request not to be called, taken down by the rep or admin who heard it",
  "api.dialer.removeDoNotCall": "taking a number off the do-not-call list risks calling someone who asked not to be; an admin's call",
  // A Salesforce key connection (convex/lib/salesforceClientCredentials.ts) syncs on its own once made.
  "api.salesforceActions.connectWithClientCredentials": "stores the workspace's Salesforce app key, which reads and writes the org as its run-as user; an admin or manager pastes it",
  // Granola meetings come in on their own every 15 minutes (convex/granolaActions.ts); nothing here is an agent's to drive.
  "api.granolaActions.connect": "stores the workspace's Granola API key, which reads every meeting note its owner can see; an admin or manager pastes it",
  "api.granola.disconnect": "turns off the workspace's meeting feed and drops its Granola key; an admin or manager's call",
  "api.granola.setLookback": "how far back the workspace's meeting feed reads is an integration setting; looking further back re-reads every note in the window",
  "api.granola.setFolders": "which Granola folders feed the workspace is a setting for the meeting feed; changing it deletes and re-imports what was imported",
  "api.granolaActions.folders": "lists the workspace key's Granola folders for the folder chooser; reads Granola with the workspace's key",
  "api.granola.setOurTeam": "which addresses count as the workspace's own side of a meeting is a setting for the meeting feed",
  "api.granolaActions.recheck": "a person's nudge to check imported meetings again; the feed does it on its own when its settings change",
  "api.granola.setSuggestMembersOnly": "which meetings may suggest new records is a workspace setting for the meeting feed",
  // What your own meetings suggest adding is yours to review; an agent creates records through the record tools directly.
  "api.callSuggestions.create": "a person's review of what their own meetings suggest adding; agents create companies, people and deals through the record tools",
  "api.callSuggestionActions.identify": "part of a person's review of their own meeting's suggestions; it searches the web on their ChatGPT plan",
  "api.callSuggestions.dismiss": "a person's review of what their own meetings suggest adding; dismissed suggestions are never made again",
  "api.granolaActions.syncNow": "a person's nudge on top of the 15-minute poll; the feed already runs without anyone driving it",
  // Deepline is the workspace's own account: agents use it through canon_find_contact_info, never connect it.
  "api.deepline.connect": "stores the workspace's Deepline API key, which spends that Deepline account's credits; an admin or manager pastes it",
  "api.deepline.disconnect": "turns off Deepline for the workspace's email lookups and drops its key; an admin or manager's call",
};
