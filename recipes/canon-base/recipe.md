---
id: canon-base
version: 1.5.0
title: Canon defaults
description: "Canon's own way of working: the deal's record in sections, the reports and dashboards every workspace starts with, its forecast, customer health, lead scoring, ICP fit, signal heat, hygiene audit, calls and target account models, and the sidebar's pages."
author: { org: canon, kind: canon }
engines: { canon: "3" }
contributes: [deal.page, account.page, contact.page, templates.reports, templates.dashboards, forecast.model, health.model, scoring.lead, scoring.fit, signals.heat, hygiene.policy, calls.model, abm.model, workspace.nav]
permissions: { read: [deal, account, contact], llm: none, sources: [] }
---

# Deal

Every field is edited in place. A field this page doesn't name, such as a
workspace's custom field, shows under More.

## Deal {section=header}

The deal's name and what kind of record it is, and whether it is archived.

```action
id: archive
label: Archive
runs: kernel.archive
```

```action
id: restore
label: Restore
runs: kernel.restore
```

## Overview {section=fields}

```fields
name, companyId, amount, currency, closeDate, ownerId
```

## Pipeline {section=fields}

```fields
stage, probability, forecastCategory, dealType, nextStep, isClosed, isWon
```

## Notes {section=fields}

```fields
description
```

## More {section=fields}

```fields
rest
```

## System {section=fields collapsed=true}

```fields
crmOwnerId, createdAt, updatedAt
```

## Timeline {section=timeline}

## History {section=history}

## Related {section=related}

## Products {section=products}

The deal's line items: each product, its quantity and price, and the total,
which can set the deal's amount.

## Credit splits {section=splits}

Who gets credit for the deal and their share, when the workspace splits
credit.

## Apps {section=apps}

The panels the workspace's apps add to a deal.

# Account {page=account}

A company's page: its fit beside its name, every field edited in place, why it
fits and how its score moved, its timeline and signals, its deals and the
people across them, and the people and companies it is linked to.

## Account {section=header}

```action
id: setStatus
label: Status
runs: kernel.setStatus
```

```action
id: setOwner
label: Owner
runs: kernel.setOwner
```

```action
id: archive
label: Archive
runs: kernel.archive
```

```action
id: merge
label: Merge with…
runs: kernel.merge
```

```action
id: restore
label: Restore
runs: kernel.restore
```

## Fit {section=fitBar}

## Details {section=fields}

```fields
rest
```

```action
id: editField
label: Edit
runs: kernel.editField
```

## Why this fit {section=whyFit}

## Score history {section=scoreHistory}

## Timeline {section=timeline}

```action
id: logActivity
label: <kind>
runs: kernel.logActivity
```

## Top signals {section=topSignals}

## History {section=history}

## Deals {section=companyDeals}

```action
id: newDeal
label: New deal
runs: kernel.newDeal
```

## People across deals {section=peopleAcrossDeals}

## Related {section=related}

```action
id: addPerson
label: Add person
runs: kernel.link
```

```action
id: findEmail
label: Find email
runs: kernel.findEmail
```

```action
id: findPhone
label: Find phone
runs: kernel.findPhone
```

```action
id: removePerson
label: Remove
runs: kernel.unlink
```

```action
id: setParent
label: Set parent
label_after: Change
runs: kernel.setParent
```

```action
id: removeParent
label: Remove
runs: kernel.removeParent
```

```action
id: addChild
label: Add child company
runs: kernel.addChild
```

```action
id: removeChild
label: Remove
runs: kernel.removeChild
```

# Contact {page=contact}

A person's page: every field edited in place, their AI fields, the companies
and deals they are on, calls, email and their timeline.

## Contact {section=header}

```action
id: findEmail
label: Find email
runs: kernel.findEmail
```

```action
id: findPhone
label: Find phone
runs: kernel.findPhone
```

```action
id: restore
label: Restore
runs: kernel.restore
```

```action
id: archive
label: Archive
runs: kernel.archive
```

```action
id: merge
label: Merge with…
runs: kernel.merge
```

## Details {section=fields}

```fields
rest
```

```action
id: editField
label: Edit
runs: kernel.editField
```

## AI fields {section=aiFields}

## Related {section=related}

```action
id: addCompany
label: Add company
runs: kernel.link
```

```action
id: makePrimary
label: Make primary
runs: kernel.makePrimary
```

```action
id: removeCompany
label: Remove
runs: kernel.unlink
```

## Calls {section=callPanel}

```action
id: call
label: Call <phone>
runs: kernel.callContact
```

```action
id: hangup
label: Hang up
runs: kernel.hangup
```

```action
id: logCall
label: Log call
runs: kernel.setCallOutcome
```

## Email {section=composeEmail}

```action
id: saveDraft
label: Save to Gmail drafts
runs: kernel.saveGmailDraft
```

```action
id: send
label: Send
runs: kernel.sendEmail
```

## Timeline {section=timeline}

```action
id: logActivity
label: <kind>
runs: kernel.logActivity
```

## History {section=history}

# Reports and dashboards

Every workspace starts with these, shared, installed the first time someone
opens Reports. A report or dashboard the workspace deletes stays deleted.

```template kind=report key=open_pipeline
name: Open pipeline
spec:
  object: deal
  filter: [{ field: isClosed, op: eq, value: false }]
  groupBy: []
  measures: [{ fn: sum, field: amount }, { fn: count }]
  chart: number
```

```template kind=report key=pipeline_by_stage
name: Pipeline by stage
spec:
  object: deal
  filter: [{ field: isClosed, op: eq, value: false }]
  groupBy: [{ field: stage }]
  measures: [{ fn: sum, field: amount }, { fn: count }]
  chart: bar
```

```template kind=report key=pipeline_by_forecast
name: Pipeline by forecast category
spec:
  object: deal
  filter: [{ field: isClosed, op: eq, value: false }]
  groupBy: [{ field: forecastCategory }]
  measures: [{ fn: sum, field: amount }, { fn: count }]
  chart: pie
```

```template kind=report key=won_lost_by_month
name: Won and lost by month
spec:
  object: deal
  filter: [{ field: isClosed, op: eq, value: true }]
  groupBy: [{ field: closeDate, bucket: month }, { field: isWon }]
  measures: [{ fn: sum, field: amount }, { fn: count }]
  chart: bar
```

```template kind=report key=activities_by_owner
name: Activities by owner and type
spec:
  object: activity
  filter: []
  groupBy: [{ field: ownerId }, { field: type }]
  measures: [{ fn: count }]
  chart: bar
```

```template kind=report key=new_deals_by_month
name: New deals by month
spec:
  object: deal
  filter: []
  groupBy: [{ field: createdAt, bucket: month }]
  measures: [{ fn: count }, { fn: sum, field: amount }]
  chart: line
```

```template kind=report key=new_leads_by_month
name: New leads by month
spec:
  object: lead
  filter: []
  groupBy: [{ field: createdAt, bucket: month }]
  measures: [{ fn: count }]
  chart: line
```

The Revenue page's numbers as reports:

```template kind=dashboard key=revenue
name: Revenue
tiles:
  - { report: open_pipeline, wide: false }
  - { report: pipeline_by_forecast, wide: false }
  - { report: pipeline_by_stage, wide: true }
  - { report: won_lost_by_month, wide: true }
```

The team's activity:

```template kind=dashboard key=activity
name: Activity
tiles:
  - { report: activities_by_owner, wide: true }
  - { report: new_deals_by_month, wide: false }
  - { report: new_leads_by_month, wide: false }
```

# Forecast {model=forecast.model}

The server's forecast weighs each open deal by its probability, or by the
default when it has none. The Revenue page and the pipeline route weigh each
open deal by its forecast category instead.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| forecastDefaultProbability | number | 0.5 | 0 to 1 by 0.05 | Forecast | Probability when a deal has none | The forecast weighs an open deal without a probability at this. |
| forecastCommitWeight | number | 0.85 | 0 to 1 by 0.05 | Forecast | Commit weight | What an open commit deal counts for on the Revenue page. |
| forecastBestCaseWeight | number | 0.5 | 0 to 1 by 0.05 | Forecast | Best case weight | What an open best case deal counts for on the Revenue page. |
| forecastPipelineWeight | number | 0.25 | 0 to 1 by 0.05 | Forecast | Pipeline weight | What an open pipeline deal counts for on the Revenue page. |
| forecastCommitCoverage | number | 0.6 | 0 to 5 by 0.05 | Forecast | Review when commit covers less than | A share of target. Below it, the forecast asks for a review of best case deals. |
| forecastWeightedCoverage | number | 0.9 | 0 to 5 by 0.05 | Forecast | Add pipeline when weighted covers less than | A share of target. Below it, the forecast asks for more pipeline. |
| forecastOnTrack | number | 1 | 0 to 5 by 0.05 | Forecast | On track at | A share of target the weighted forecast covers. |
| forecastWatch | number | 0.8 | 0 to 5 by 0.05 | Forecast | Watch at | Below on track and at this share or above, the forecast is watched; below it, at risk. |
| forecastPipelineOverCommit | number | 2 | 0 to 100 by 0.5 | Forecast | Review when pipeline exceeds commit by | Pipeline this many times commit asks for a manager review. |
| forecastClosingDays | int | 30 | 1 to 365 | Forecast | Closing soon within (days) | An open deal closing within this many days counts toward Closing soon on the Revenue page. |

# Customer health {model=health.model}

A health run scores the accounts with won or expansion deals, highest
priority first. With none, it scores every account and takes the points for
no customer signal off each. Money is in cents.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| healthHealthy | int | 70 | 0 to 100 | Customer health | Healthy from | A score at this or above is healthy. |
| healthAtRisk | int | 45 | 0 to 100 | Customer health | At risk from | A score at this or above, and below healthy, is at risk. Below it, churning. |
| healthRevenueCap | int | 10000000 | 1 to 10000000000000 | Customer health | Revenue for full points (cents) | Revenue earns its points in proportion up to this. |
| healthContactTarget | int | 3 | 1 to 1000 | Customer health | Contacts for full points | Contacts earn their points in proportion up to this many. |
| healthSyncFreshDays | int | 7 | 0 to 3650 | Customer health | Sync fresh within (days) | |
| healthSyncRecentDays | int | 30 | 0 to 3650 | Customer health | Sync recent within (days) | Older than this, a sync is stale. |
| healthExpansionHighArr | int | 10000000 | 0 to 10000000000000 | Customer health | High expansion at won ARR (cents) | Any open expansion or renewal deal is high expansion potential too. |
| healthExpansionMediumArr | int | 5000000 | 0 to 10000000000000 | Customer health | Medium expansion at won ARR (cents) | |
| healthExpansionContacts | int | 2 | 0 to 1000 | Customer health | Medium expansion at contacts | |
| healthRenewalDays | int | 120 | 1 to 3650 | Customer health | Renewal without a renewal deal (days) | An account with no renewal deal renews this many days after it's scored. |
| healthAccountsScored | int | 50 | 1 to 200 | Customer health | Accounts a run scores | |

The score is the sum of these points, from 0 to 100.

| Score | Points |
|---|---|
| revenue | 35 |
| contacts | 20 |
| expansion.open | 20 |
| expansion.pipeline | 12 |
| expansion.neither | 6 |
| owner.yes | 15 |
| owner.no | 3 |
| sync.fresh | 10 |
| sync.recent | 6 |
| sync.stale | 2 |
| noCustomerSignal | -20 |

# Lead scoring {model=scoring.lead}

A workspace's first lead scoring model starts with these rules. Greater than
and less than include the value itself. A score runs from 0 to 100.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| leadHot | int | 70 | 0 to 100 | Lead scoring | Hot from | |
| leadWarm | int | 45 | 0 to 100 | Lead scoring | Warm from | Below it, cold. |
| leadOwnerPoints | int | 5 | -100 to 100 | Lead scoring | Points for an owned lead | A lead earns these when it or its account has an owner. |

| Field | Operator | Value | Points |
|---|---|---|---|
| title | contains | chief | 25 |
| title | contains | vp | 20 |
| employee_count | greater_than | 200 | 20 |
| revenue | greater_than | 2000000000 | 20 |
| engagement | greater_than | 1 | 15 |

# ICP fit {model=scoring.fit}

An account is inside a saved ICP only when it passes every one of its
criteria, and outside them its fit is 0. Inside, it earns the base, its
industry's and country's weight by their rank in the ICP, and its size band's.
Its fit is those points as a share of a perfect match's. A change here rescores
the workspace.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| fitBase | int | 10 | 1 to 100 | ICP fit | Base points | What every account inside an ICP starts with. |
| fitIndustryWeights | ints | 40, 34, 30 | 0 to 100, up to 10 values | ICP fit | Industry weights by rank | The ICP's first industry earns the first, its second the second. Every industry past the list earns the last. |
| fitCountryWeights | ints | 25, 18 | 0 to 100, up to 10 values | ICP fit | Country weights by rank | The same, for the ICP's countries. |
| fitBandCentral | int | 25 | 0 to 100 | ICP fit | Central size band | A size band at the middle of the ICP's sizes. |
| fitBandInside | int | 18 | 0 to 100 | ICP fit | Other size bands | Any other size band the ICP names. |
| fitBandAdjacent | int | 8 | 0 to 100 | ICP fit | Size band next to the ICP's | Counts only where Canon ranks without gates, such as signup research. A gate refuses these sizes. |
| fitUnlistedBand | int | 18 | 0 to 100 | ICP fit | A size Canon doesn't list | A size range the ICP names that isn't one of Canon's bands. |
| fitBuyerLevels | levels | cxo, vp, head, director | cxo, vp, head, director, manager, owner, founder, partner | ICP fit | Buyers when an ICP picks no level | Someone at one of these levels counts as the ICP's buyer. |

# Signal heat {model=signals.heat}

Heat is 100 × (1 − e^(−points ÷ saturation)), so each extra signal adds less
than the one before it. A signal's points fade in a straight line to nothing
over the window.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| heatJobPoints | int | 10 | 0 to 100 | Signal heat | Points for a new role | |
| heatSitePoints | int | 5 | 0 to 100 | Signal heat | Points for a website change | |
| heatBlogPoints | int | 3 | 0 to 100 | Signal heat | Points for a blog post | |
| heatSocialPoints | int | 0 | 0 to 100 | Signal heat | Points for a social profile | A profile is presence, not motion, so it counts toward growth instead. |
| heatRepostFactor | number | 1.5 | 1 to 10 by 0.1 | Signal heat | A reposted role counts | Times a new role's points. |
| heatWindowDays | int | 30 | 1 to 365 | Signal heat | Signals fade over (days) | |
| heatSaturation | int | 40 | 1 to 1000 | Signal heat | Saturation | Points at which heat reaches 63. |
| heatBurning | int | 70 | 0 to 100 | Signal heat | Burning from | |
| heatWarm | int | 35 | 0 to 100 | Signal heat | Warm from | |
| heatCool | int | 1 | 0 to 100 | Signal heat | Cool from | Below it, no heat. |
| growthWindowDays | int | 30 | 1 to 365 | Signal heat | Growth within (days) | A role posted or a website change in this window reads as growth. |
| growthBlogPosts | int | 2 | 1 to 100 | Signal heat | Blog posts for growth | Posts in the window that read as blogging. |
| growthSocialProfiles | int | 2 | 1 to 20 | Signal heat | Networks for growth | Profiles on this many networks read as social. One LinkedIn page alone is nearly universal. |

# Hygiene audit {model=hygiene.policy}

The audit's policy. Severity weights stay Canon's, so a workspace's health
trend stays comparable over time.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| hygieneStaleDealDays | int | 30 | 1 to 3650 | Hygiene audit | Stale after (days) | An open deal with no activity for longer than this is stale. |
| hygieneStaleMediumDays | int | 45 | 0 to 3650 | Hygiene audit | Medium risk at (days) | A stale deal's follow-up is medium risk from this many idle days. |
| hygieneStaleHighDays | int | 90 | 0 to 3650 | Hygiene audit | High risk at (days) | |
| hygieneClosingSoonDays | int | 14 | 0 to 3650 | Hygiene audit | Closing soon within (days) | |
| hygieneClosingSoonIdleDays | int | 7 | 0 to 3650 | Hygiene audit | Closing soon and idle after (days) | A deal closing soon with no activity for longer than this is a finding. |
| hygieneFreshnessDays | int | 30 | 1 to 3650 | Hygiene audit | Evidence stale after (days) | Days since a record's last sync or activity. |
| hygieneRequireDealOwner | bool | true | true or false | Hygiene audit | Every deal has an owner | |
| hygieneRequireDealAccount | bool | true | true or false | Hygiene audit | Every deal has an account | |
| hygieneRequireDealAmount | bool | true | true or false | Hygiene audit | Every open deal has an amount | |
| hygieneDisabledRules | rules | | orphan-account, missing-deal-owner, missing-deal-account, past-close-date, stale-deal, missing-deal-amount, duplicate-account-domain, duplicate-contact-email, duplicate-open-deal, active-deal-account-without-contacts, closing-soon-inactive, account-single-source | Hygiene audit | Rules turned off | The audit skips these. |

# Calls {model=calls.model}

After a meeting, a model reads it for the CRM: the deal's next step and close
date, a new opportunity when no deal matched, and the company and people it
names. The prose below says what each of those means. Canon names the answer's
fields, asks for a word-for-word quote behind each one, and drops any answer
it can't find in the call.

Every call is also read for insights, without a model: a part of the
transcript with a word from a category below is an insight of that kind. Each
category is a case-insensitive pattern; separate words with `|`.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| callPainPhrases | phrases | `\b(struggling\|struggle\|pain\|problem\|challenge\|frustrat(?:ed\|ing)\|manual\|messy\|broken\|hard to\|difficult\|too much time\|takes too long)\b` | up to 500 characters | Calls | Pain | A problem the buyer has, or what slows them down. |
| callObjectionPhrases | phrases | `\b(concern\|worried\|not sure\|too expensive\|budget\|price\|pricing\|timing\|procurement\|security review\|legal review\|need to think\|another vendor)\b` | up to 500 characters | Calls | Objections | A concern that holds the deal back. |
| callCompetitorPhrases | phrases | `\b(competitor\|alternative\|evaluating\|looked at\|using\|salesforce\|hubspot\|gong\|chorus\|clari\|outreach\|salesloft\|6sense\|demandbase\|clay\|zapier\|workato)\b` | up to 500 characters | Calls | Competitors and alternatives | Add your own competitors here, each after a \|. |
| callNextStepPhrases | phrases | `\b(next step\|follow up\|send over\|circle back\|schedule\|book\|meet again\|by (monday\|tuesday\|wednesday\|thursday\|friday)\|action item\|I'll send\|we'll send)\b` | up to 500 characters | Calls | Next steps | An action someone agreed to take. |
| callFeaturePhrases | phrases | `\b(wish\|would love\|need it to\|feature\|capability\|does it support\|can it\|integration\|custom field\|dashboard\|report\|export\|import)\b` | up to 500 characters | Calls | Feature requests | Something the buyer asks the product to do. |
| callPricingPhrases | phrases | `\b(price\|pricing\|budget\|cost\|discount\|contract\|renewal\|procurement\|purchase order\|PO\|invoice\|annual\|monthly\|ARR\|MRR\|\$\d+)\b` | up to 500 characters | Calls | Pricing and budget | Price, budget, contracts and money. |
| callCriteriaPhrases | phrases | `\b(criteria\|decision\|evaluate\|evaluation\|success looks like\|requirements\|must have\|need to see\|stakeholder\|committee\|approve\|approval)\b` | up to 500 characters | Calls | Decision criteria | How the buyer decides, and who approves. |
| callRiskPhrases | phrases | `\b(delay\|blocked\|risk\|concern\|not a priority\|no budget\|push\|slip\|stalled\|ghost\|unresponsive\|champion left\|reorg)\b` | up to 500 characters | Calls | Deal risk | A sign the deal is slipping. |
| callFillerPhrases | phrases | `\b(let me tell you\|obviously\|basically\|trust me\|to be honest\|just checking in\|does that make sense\?)\b` | up to 500 characters | Calls | Filler | Words a rep leans on, worth coaching out. |
| callDefaultCloseDays | int | 30 | 0 to 365 | Calls | Suggested deals close after (days) | A deal a call suggests, with no close date said, closes this many days after the meeting. |

## Next step {partial=calls.nextStep}

the agreed next action on the deal, in one short imperative sentence (who does what, by when if said). Null if none was agreed.

## Close date {partial=calls.closeDate}

the date the buyer said they expect to sign or buy, as YYYY-MM-DD resolved against the meeting day. Null unless a timeframe for the purchase was stated.

## The other company {partial=calls.otherCompany}

the other side's company this meeting is with (a prospect, customer or partner, never the note owner's own company), as the title, summary or transcript names it, with a search hint and evidence. Null for an internal meeting or when no company is named.

## People it names {partial=calls.mentionedPeople}

people from that company the meeting names (by name, first name alone if that is all that is said), never the note owner or their colleagues, with evidence. An empty list when none are named.

## A new opportunity {partial=calls.opportunity}

only if the call shows a real new sales opportunity (a stated need with budget, a timeline, an evaluation, or an intent to buy): a short deal name "<Company> - <what they would buy>", the amount in dollars only if one was stated, the expected close date as YYYY-MM-DD only if a timeframe was stated, the agreed next step, and evidence quoting the buying signal. Null for an intro, a support call, or small talk.

# Target accounts {model=abm.model}

A target account's engagement score adds an open deal, its open pipeline, its
known contacts, an owner and a past win, each capped, to at most 100. An
account with a win is a customer, one with an open deal an opportunity, and
otherwise it reads engaged from the score below.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| abmOpenDealPoints | int | 35 | 0 to 100 | Target accounts | Points for an open deal | |
| abmPipelinePerPoint | int | 100000 | 1 to 10000000000000 | Target accounts | Open pipeline per point | Each this much open pipeline earns a point. |
| abmPipelineMax | int | 35 | 0 to 100 | Target accounts | Most points from pipeline | |
| abmContactPoints | int | 4 | 0 to 100 | Target accounts | Points per known contact | |
| abmContactMax | int | 16 | 0 to 100 | Target accounts | Most points from contacts | |
| abmOwnerPoints | int | 8 | 0 to 100 | Target accounts | Points for an owner | |
| abmWonPoints | int | 6 | 0 to 100 | Target accounts | Points for a past win | |
| abmEngaged | int | 40 | 0 to 100 | Target accounts | Engaged from | A target account at this score or above reads engaged. |

# Navigation {model=workspace.nav}

Which pages the sidebar and the command palette list, and where Canon opens.
A hidden page keeps its address, so links to it still work. Settings and
Customization always show, so an admin can always change this back.

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| navHome | choice | accounts | accounts, people, icps, audiences, my-work, review, deals, reports, linkedin, dialer, runs, agents | Navigation | Opens on | The page Canon opens on. Someone who can't see it opens on the first page they can. |
| navHidden | rules | | accounts, people, icps, audiences, my-work, review, deals, reports, linkedin, dialer, runs, agents, integrations, ai-fields, cli-pairing | Navigation | Hidden from everyone | |
| navRepHidden | rules | | accounts, people, icps, audiences, my-work, review, deals, reports, linkedin, dialer, runs, agents, integrations, ai-fields, cli-pairing | Navigation | Also hidden from reps | Admins and managers still see these. |
