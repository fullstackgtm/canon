# Deal rooms

Install `@canon/deal-rooms` from Canon, add the two templates, and open a room on a deal with a close date. Stakeholders are entered on People until Canon exposes `people.forDeal`.

Health refreshes after seller step edits and transitions, after publishing, after watched deal changes, hourly, and daily at 13:00 UTC. Creation computes initial health. The daily run also sends in-app reminders to seller owners of open seller or joint steps due tomorrow. It never contacts buyers.

The deal's current close date sets the slip calculation and the room's target date. Template offsets apply only at creation: a later close-date change leaves every step date intact. The room's rep follows a nonempty deal owner; seller-team rows and step owners remain as manually assigned. A closed deal moves a draft or live room through `closeWon` or `closeLost`. Won, lost and archived rooms retain their history.

Buyer activity remains unknown until P3e supplies it. `lastBuyerAt` is never invented or overwritten by this module. An absent value means no buyer activity yet, `quietDays` is absent, and quiet time adds no health penalty. A known timestamp uses whole elapsed 24-hour days, so a visit 21 hours ago has zero quiet days. The digest returns unknown buyer actions, rather than a zero count implying measurement.

The health job uses two key parts, deal and kind, because composite room keys contain `|`. Watches can return only dirty intents, so the health job rereads the current deal and performs closure. Hourly and daily schedules enumerate open rooms and queue concrete keys; the platform passes wildcard keys through without expanding them. Each leased room applies independently, checks the room and contributing step versions, and avoids unchanged patches.

Phase-one read bounds are explicit: landing/digest/schedules read at most 500 rooms and 5,000 steps; a health batch holds 50 keys, reads at most 200 rooms and 5,000 steps. The platform refuses an overfull read instead of silently truncating it. Larger workspaces need paged sweep support before those bounds are raised.

Version 0.3.0 declares the bounded DR3 buyer consumer through `shares.room`. The seller's Share tab uses the existing link management and preview component. Only live rooms can be shared. Link identity is the only mode, with 45-day default and 120-day maximum expiry. Each session allows 60 writes per hour. Upload limits are 20 files per day and 100 MB per grant.

The buyer page shows the welcome, target date, rep, milestones, steps, shared content, and public conversation. Buyer and joint steps allow completion, reopening by the same visitor session, and file attachment. Completion records signed edge evidence and unverified visitor attribution. Seller completion and reopening clear stale visitor attribution. Visitor operations start no jobs. Derived progress still refreshes through the existing seller and scheduled health paths.

Visitor comments fix `internal=false`, `side=buyer`, and the author label. Members retain separate public-comment and internal-note operations. Files use the existing P3 download and upload routes. Visitors can upload PNG, JPEG, or PDF up to 10 MB. The collection retains office-file support for members. Downloaded files are not scanned.

The plan shows the full declared seller team and ordered milestone groups. Each step opens a share-local page
with its public conversation and a comment form fixed to that admitted step. Room comments may select a current
shared step. Document refs, labels and choices come only from the closed current-generation share tree. Private,
foreign, hidden and retired targets are omitted and cannot be supplied to a buyer write. Shared content links
open only HTTPS URLs without credentials or control characters.

Every buyer write checks that the current room is live and notifies only its current active workspace rep through
`shared.root.rep`. Reassignment changes the notification recipient, including within a coalescing window. These
writes declare no role fanout, email sending or jobs.

The reopen button appears on completed buyer or joint steps; the server allows only the completing session.
Visitor action visibility has no visitor-session value, and the unverified Mine filter remains deferred to DR6.

No grant records, engagement records, signals, verified-email mode, or reports are declared by this consumer. `MODULE_SHARES` remains unchanged. Dev enablement, V3 boundary proof, generation, and integrated validation belong to the parent.
