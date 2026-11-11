# Export and import a workspace

You can export a whole workspace to one archive file, from a self-hosted install or from canoncrm.com, and import it
into a new, empty workspace on a self-hosted install. Importing into canoncrm.com is not switched on yet.

## Export and verify

1. Sign in as an admin and open **Settings > Workspace**. Under **Export**, choose **Create export key**. The key is
   shown once and works for an hour. Creating another replaces it, and **Revoke** ends it early.
2. Run the export with the [canon CLI](../cli/canon.ts) and paste the key when it asks:

   ```sh
   canon workspace export --url https://crm.example.com
   ```

   It writes `canon-workspace-<slug>-<timestamp>.tar` to the current directory, or to `--out <path>`. To pass the key
   without a prompt, set `CANON_EXPORT_KEY`. The CLI never takes the key as an argument.
3. Check the archive:

   ```sh
   canon workspace verify canon-workspace-acme-20261109T120000Z.tar
   ```

   Verify checks every part's checksum and row count against the archive's manifest. With `CANON_EXPORT_KEY` set to a
   live key for the same workspace, it also counts each section on the deployment now and prints both. It exits
   non-zero on any difference. Records changed after the export show up as differences.

Only an admin can create an export key, and only from the app. An agent or a CLI token cannot create one. The key
names its workspace, so it can't export any other. Every read checks that the admin who created it still holds the
**Export the whole workspace to an archive** permission.

## What an archive holds

The archive is a tar file holding `manifest.json` and gzipped NDJSON parts under `sections/<name>/`, each up to about
8 MB. One section holds one table's rows for this workspace:

- The record ledger and its identities: every company, person, deal, association and activity stream, merges and
  duplicate decisions, and your object definitions.
- Facts, including their review state and verification.
- The record service's register: every stored account, contact and field history row.
- Settings, roles, teams, pipelines, saved views, reports, dashboards, ICPs, audiences, agents, installed modules and
  their documents, sequences, suppressions, the do-not-call list and the rest of the workspace's records.
- Members, as a `users` section with their name, email, role, manager, title and whether they're active. An import
  will match people by email.

The manifest records the source (self-hosted or hosted, the app commit, the data epoch, the record service contract),
when and by whom the archive was made, each section's row count, and each part's SHA-256. References between records
are written as `{"$ref": "<table>", "id": "<old id>"}`. Ids written inside text, such as `user:<id>` in a source
reference, are left as they are. The manifest counts them per section.

## What it leaves out

- Credentials and integration connections: CRM, mailbox, LinkedIn, dialer and GitHub connections, OAuth tokens,
  webhook and connector secrets, CLI tokens, and agents' and modules' signed standing grants. They are encrypted or
  signed with this deployment's own keys and would not work anywhere else. The manifest counts them without contents.
- Sign-in: passwords, sessions, invitation links and Clerk ids.
- Sync state, queues, cursors, background jobs and fills held for review.
- What Canon rebuilds from the ledger and from facts, such as list rows and field state.
- Data shared by every workspace, such as public website caches.
- Files and attachments, for now. The manifest counts how many stored files the exported rows reference.

The manifest's `notExported` list names every table left out, with its reason.

## Import an archive

Import only goes into a new, empty workspace: no records, deals or register rows, and no members but you.

1. Sign in as the admin of the new workspace and open **Settings > Workspace**. Under **Import**, choose **Create
   import key**. Like an export key it is shown once and works for an hour. An export key never imports.
2. See what the import would do. A dry run writes nothing:

   ```sh
   canon workspace import --dry-run canon-workspace-acme-20261109T120000Z.tar --url https://crm.example.com
   ```

   It checks every part's checksum, then reads every row the import would write against this install's schema. It
   prints each section's rows and whether it is imported, how members match, the references it clears and every
   value it refuses, and exits non-zero when it refuses anything.
3. Run it without `--dry-run`. If it stops part way, run the same command again: it continues where it stopped and
   writes nothing twice. A workspace takes one archive. To start over, import into another new workspace.

What arrives:

- Members are matched by email. You stay yourself and the only admin. Everyone else arrives as an inactive member
  who doesn't sign in, keeping their name, email, title and manager, so owners and history read right. An admin of
  the source arrives as a rep. Someone the history names who had left the source arrives as an inactive "Former
  member". Invite people from **Settings > Team** to give them their accounts back.
- Companies, people, deals, activities, custom objects and their whole history, merges (which you can still undo),
  duplicate decisions, the register (every stored company, person and field history row), roles, teams,
  pipelines and the workspace's settings.
- Facts with their review state and verification, so field values, contested fields and the review queue read as
  they did. Field ownership and auto-accept rules come along.
- ICPs with their segments and personas, and the scoring settings. When the import finishes, Canon rescores every
  company against them.
- Saved views, reports, dashboards and audiences with who they reached. A built-in report or dashboard replaces the
  copy this workspace already had. A module's report comes only when that module is installed here.
- Suppressions and the do-not-call list, the audit log, notifications, onboarding steps, health history, and the
  planning tables (competitors, playbooks, campaigns, budgets, market maps and the rest).
- Every record gets a new id here. References inside the archive, including ids written inside text, are rewritten
  to the new ids. An id the import can't map stops it before anything is written, and so does an id inside text in
  a form the import doesn't read. Text a person or a model wrote (an agent's answer, a message, a play's notes) is
  the exception: an id in it that the archive carries is rewritten, and any other word stays as it was written.
- Canon rebuilds list rows, associations, deal history and review queues from the history.
- Automation and routing rules, patch plans with their operations and approvals, and a sequence module's launches
  and enrollments (when that module is installed here). Each arrives switched off; see below.

Module data:

- A module's documents, their history, its AI step receipts and its snapshots go to the module installed here with
  the same id. Ids inside them are rewritten like everything else: the members, deals, teams and records a doc names,
  and the members inside a doc's key. Each doc keeps its version, owner and creation time, and must fit the version
  installed here.
- Every module in this workspace is turned off when the import begins, and the source's "on" doesn't carry over, so
  no module's schedules, timed steps or watches run on what the import writes. Turn each on in **Customization**
  when you're ready. Restoring docs tells nothing else either: an imported ICP doesn't start a fill.
- Rows of a module that isn't installed here are held, counted per module in the dry run and the summary, and no
  page reads them. Installing the module restores them, and turns it off again if it was on. A doc that doesn't fit
  the installed version stays held and is tried again when another version is installed.
- A private module (one Canon doesn't publish) restores only into Canon's own install of it. On a self-hosted
  install its data stays held and inert. Held rows are in the next export, so moving the workspace on to an install
  that has the module brings them back.
- Signed module grants and share links stay behind: they are signed with the source deployment's keys. Grant them
  again here.

What arrives switched off:

Nothing the archive brings sends, writes to a CRM, fires a rule or acts until a person here turns it on. The dry
run counts the rows of each section that arrive changed, and the import's summary lists every way Canon can send or
act, with what is connected on this deployment.

- **Automation rules** arrive paused. Turn one on in **Agents > Automations**: it runs on changes made from then on,
  never on the imported history.
- **Routing rules** arrive turned off, so an automation that assigns through one fails and says so. Turn one on
  with the `update_routing_rule` operation (`isActive: true`).
- **Patch plans** that weren't applied (drafts, plans awaiting approval and approved ones) arrive cancelled, with
  the reason on the plan, and their approval requests arrive cancelled. An approval given in the source workspace
  doesn't carry over: plan the change again here. Applied, rejected and failed plans arrive as history. A batch of
  proposed facts stays in the review queue, where you decide each fact.
- **Sequence launches** arrive paused with their approval spent, and their enrollments paused. Sending needs a member
  here to approve the launch again, from a mailbox connected here.
- **Agents** arrive paused with their Slack messages off, and with no standing grants, no webhook secret and no agent sign-in: those are signed or
  encrypted with the source deployment's keys. Turns that hadn't run arrive skipped, so they never run here. Resume
  an agent from its page (its owner must be an active member here): it runs on deal events and test runs from then
  on. Rotate its webhook secret to take webhook events again, choose its Slack messages again, and grant it again if
  it should write without review.
- **Research fields** keep their question, answers and history, and their scheduled refresh arrives off, with the
  source's cadence named on the field. Turn the refresh on here to start it one cadence from then. Runs that hadn't
  finished arrive cancelled.
- **Deal plays** keep their brief, people, steps, drafts and deal state. Their daily keeper arrives off: **Check
  now** on the play runs it once and turns the daily check back on. Research that hadn't finished arrives failed, a
  LinkedIn step that was handed to a cadence arrives planned again, and the play's LinkedIn cadences stay behind
  with their senders.
- **Conversations** (email logged by BCC or forward, and mail and LinkedIn threads read from a linked account)
  arrive with their messages and the people they're with. Each thread stays its owner's, so its text reads exactly
  as it did: to its owner, and to roles that read that owner's activity. Reading a thread for facts arrives off,
  and a new message here starts it again. A thread read from a mailbox or LinkedIn sender stays with that account's
  history; linking the account here reads it again as new threads.
- **Calls** from every provider arrive with their transcripts, insights and suggestions. The dialer's settings and
  the recording policy arrive with call recording off, and calling needs a number connected here. A dialer call's
  own row needs its dialer session, which stays behind, so it is left out and counted: the call stays on the
  person's activity, and its transcript and insights come along. Its audio was a file, and files don't come along
  yet, so the call shows no recording to play. A recording link from a meeting recorder or another provider stays.
- **The hierarchy manager and field consolidations** arrive with their settings, scans, research, decisions and
  runs. Nothing in them is automatic: every parent move and every consolidation is a person's decision. A scan,
  research or consolidation run that hadn't finished arrives failed; run it again here. What a connected CRM said
  about a company's parent stays with that connection, and the next sync of a CRM connected here finds it again.
- **LinkedIn cadences and enrollments** need the sender they ran on, which stays behind, so they're left out and
  counted. Every invite, message and reply stays on the person's activity. Make the cadence again on a sender
  connected here. Lead feed items stay with their connector link the same way.
- Sent emails keep their place on each person's activity. The per-mailbox send log stays behind with its mailbox,
  and the dry run counts it.

What doesn't, for now:

- The dry run lists every section that isn't imported yet, with why: the module packages themselves (a module is
  installed here, never from an archive), commissions and territories, installed recipe packages, and what a CRM
  sync rebuilds (CRM mirror scores and what a connected CRM says about a company's parent).
- A row that needs something not imported is left out and counted, such as an audience member an agent added. The
  dry run says how many, per section, and why.
- Files and attachments: references to them are cleared and counted per section, and a row that is only its file
  is left out.
- Nothing sends or syncs on its own: integrations, mailboxes and grants are never in an archive, so they stay
  disconnected until you connect them here. The import stops while this workspace has an active automation rule or
  a live record webhook, so imported history can't set either off. Turn them off, then run the import again.

## Protect the archive

An archive holds your CRM data in plain form: every company, person, deal, email address and note. Store and send it
as you would the workspace itself.
