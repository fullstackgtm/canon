# HubSpot-compatible CRM API

Point a HubSpot CRM client at `<instance>/hubspot` and use a Canon paired token
(from Canon's CLI pairing) as the access token. Requests run as the token's user.

```js
import { Client } from '@hubspot/api-client';
const client = new Client({
  accessToken: process.env.CANON_TOKEN,
  basePath: `${process.env.CANON_URL}/hubspot`,
});
await client.crm.contacts.basicApi.getPage();
```

```python
import os
from hubspot import HubSpot
client = HubSpot(access_token=os.environ['CANON_TOKEN'],
                 host=os.environ['CANON_URL'] + '/hubspot')
client.crm.contacts.basic_api.get_page()
```

## Objects and properties

| HubSpot object | Type ID | Canon object |
| --- | --- | --- |
| contacts | 0-1 | contact |
| companies | 0-2 | account |
| deals | 0-3 | deal |
| tasks | 0-27 | task |
| notes | 0-46 | note |
| meetings | 0-47 | meeting |
| calls | 0-48 | call |
| products | 0-7 | product |

Custom objects use their Canon API name. IDs remain Canon IDs. The caller's
`GET /crm/v3/properties/{type}` describes visible properties. Property names
follow `HUBSPOT_DEFAULT_FIELD_MAPPINGS` used by the importer. For example,
`domain`, `name`, `numberofemployees`, `firstname`, `lastname`, `email`,
`jobtitle`, `dealname`, `amount`, `closedate`, `dealstage` and `hubspot_owner_id`.
`pipeline` maps to Canon's pipeline ID. First and last names split Canon's full
name at the last space. Writing either preserves the other part on updates.

Unmapped fields use `canon_` plus the lowercase UTF-8 hex encoding of the
Canon API name. Encoding preserves dots and case, prevents collisions between
Canon fields, and separates these names from HubSpot's standard properties.

Property values are strings. Currency uses whole units rather than Canon cents.
Datetimes use ISO UTC, dates use `YYYY-MM-DD`, booleans use `true` or `false`,
and multi-value fields use semicolons. Empty values use an empty string.
System properties include `hs_object_id`, `createdate`, `lastmodifieddate`
(on contacts), and `hs_lastmodifieddate` (on other objects).

CRUD, ordered batches of at most 100 records, owners, deal pipelines and stages,
and contact-company, deal-company and deal-contact associations are supported.
Associations use the v4 default endpoints or the read `associations` parameter.
Property definitions are read only. Lists accept up to 100 records; searches
accept up to 200. Pass `paging.next.after` unchanged to the next request.
Batch partial failures return 207 with results and errors. Writes held by Canon
for review return an error rather than success. Archives use Canon soft deletion.
Creating a company requires `domain` and `name`. An existing domain fills the
existing company rather than duplicating it, and returns that company's ID.
Contact creation requires a company in `associations` (default type 1).
Other Canon required fields must also be supplied. Company creates accept `domain`, `name`, `industry`, `numberofemployees`,
`country`, and `linkedin_company_page`. Contact creates accept first/last/full
name, `email`, `jobtitle`, `hs_linkedin_url` and the company association.
Deal creates accept `dealname`, `amount`, `deal_currency_code`, `closedate`,
`dealstage`, `pipeline`, `dealtype`, owner and company IDs, revenue type and
custom fields. Other properties on these objects require PATCH. Create refuses
them with a named 400 rather than overwriting a record matched by Canon's
fill-only upsert. Required Canon fields, including currency and deal type,
must be present.

Association writes follow creation and are not atomic with it. If association
creation fails after the record was created, the error's `context.createdObjectId`
identifies it. Recover using that ID rather than retrying the create.

`GET` by `idProperty=email` (contacts) or `idProperty=domain` (companies) works
only when the field identifies at most one visible record.

## Search

`POST /crm/v3/objects/{type}/search` supports one sort, with `-` for descending,
and AND filters within one group. Operators are EQ, NEQ, LT, LTE, GT, GTE,
BETWEEN (inclusive), IN, NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY and
CONTAINS_TOKEN (substring matching). Multiple groups must reduce to an IN
on one property using EQ or IN. Other OR expressions, text `query`, derived
first/last-name filtering and sorting, and comma-containing IN values return
400. Unsupported conditions are never discarded.

## Gaps

Emails, line items, tickets and leads are not exposed. This API does not provide
OAuth installation, webhooks or subscriptions, property or schema writes, lists,
imports or exports, engagements v1, legacy contacts v1, CMS, marketing,
conversations, files, batch upsert, or GDPR delete. Other association pairs and
custom association labels are unsupported. Canon required fields and its
permissions still apply; this is a record translation API, not a HubSpot clone.
