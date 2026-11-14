# Salesforce-compatible REST API

Canon accepts Salesforce REST requests under `/services/data/v50.0` through
`/services/data/v66.0`. Use your Canon instance URL and an existing paired
`fsgtm_` CLI token. Requests run as that token's workspace user, with the same
permissions, field visibility, rate limits and review gates as the record API.
IDs are opaque Canon IDs. No Salesforce login or OAuth flow is provided.

## Connect a client

```js
import jsforce from 'jsforce';
const conn = new jsforce.Connection({
  instanceUrl: process.env.CANON_URL,
  accessToken: process.env.CANON_TOKEN,
  version: '66.0',
});
console.log(await conn.query('SELECT Id, Name FROM Account LIMIT 10'));
```

```python
import os
from simple_salesforce import Salesforce
sf = Salesforce(instance_url=os.environ['CANON_URL'],
                session_id=os.environ['CANON_TOKEN'], version='66.0')
print(sf.query_all('SELECT Id, Name FROM Account'))
```

For the Salesforce CLI, isolate its home from any real Salesforce orgs and
supply the token as `SF_ACCESS_TOKEN` through your secret manager.

```sh
SF_CLI_HOME="$(mktemp -d)"
HOME="$SF_CLI_HOME" sf org login access-token --instance-url "$CANON_URL" --alias canon --no-prompt
HOME="$SF_CLI_HOME" sf data query --target-org canon --query 'SELECT Id, Name FROM Account LIMIT 10'
```

Keep the same isolated HOME for both commands. CLI compatibility has not yet
been verified. BI connectors that require SOAP, Bulk or OAuth cannot use this API.

## Object and field map

| Salesforce | Canon |
| --- | --- |
| Account | account |
| Contact | contact |
| Opportunity | deal |
| Lead | lead |
| Task | task |
| Event | meeting |
| Note | note |
| Product2 | product |
| User | workspace members, read only |
| `<apiName>__c` | workspace custom object |

`GET /sobjects` and `/sobjects/{Type}/describe` return the caller's visible
objects and fields. The mapping shares the Salesforce connector's standard
field names, with Canon storage aliases for employees, fullName and companyId.
Standard names include Id, Name, Email, Phone, OwnerId, StageName, Amount,
CloseDate, CreatedDate, LastModifiedDate and IsDeleted. Other fields use
`<apiName>__c`, replacing dots with underscores (custom.budget becomes custom_budget__c). Timestamps are Salesforce
ISO strings, dates are YYYY-MM-DD, and currency is converted from Canon cents
to currency units. GET supports `?fields=Id,Name`. POST returns an id and success;
PATCH returns 204. DELETE archives the record and returns 204. A held write
returns an error, never a successful write receipt.

Accounts require both Name and Website because Canon identifies accounts by
domain. POST uses Canon's existing fill-missing upsert semantics. Reusing an
existing domain or contact identity can return that existing record. Register
creation accepts fewer fields than updates; describe reports this distinction.
Contact FirstName and LastName are combined into Canon's fullName. Reads split
at its final space; separate source name components are not preserved.
Contact AccountId is set on creation and read from the existing primary link.
Changing that link uses Canon's association API rather than PATCH AccountId.

## SOQL subset

`GET /query?q=...` supports one FROM object, selected fields, one-level parent
fields such as Account.Name and Owner.Name, and COUNT(). Parent reads are
batched per page. WHERE supports AND, comparisons `= != < <= > >=`, null checks,
IN and NOT IN. OR accepts equalities on one field; parenthesize it when combined
with AND. LIKE supports exact strings, `prefix%` and `%contains%`.

Date literals include TODAY, YESTERDAY, TOMORROW, LAST_N_DAYS:n, NEXT_N_DAYS:n,
and THIS/LAST/NEXT_MONTH or YEAR, evaluated in UTC. ORDER BY supports one field
and ASC/DESC. LIMIT and OFFSET up to 2000 are supported. A batch defaults to
2000 records. `Sforce-Query-Options: batchSize=200` selects a batch from 200 to
2000. Follow nextRecordsUrl until done is true. Each locator is parsed and
authorized again. Unsupported syntax, fields and objects return Salesforce
error arrays rather than being ignored.

## Gaps

- OAuth login, Composite, sObject Collections, Bulk, SOSL and `/search`,
  Metadata, Tooling, SOAP, Apex and streaming.
- Child subqueries, GROUP BY, aggregates other than COUNT(), TYPEOF,
  FOR UPDATE, multiple sort fields and arbitrary boolean expressions.
- Suffix LIKE, underscore wildcards and IN strings containing commas.
- Filtering Contact.FirstName, Contact.LastName, Contact.AccountId or IsDeleted.
  Use Name and Canon's association API where applicable.
- queryAll. Canon's deleted option selects archived records instead of adding
  them to active records; the adapter does not promise a combined sorted stream.
  simple-salesforce's query_all follows ordinary query locators by default.
- Account and Contact CreatedDate, because the register only preserves last update time.
- External ID upsert, call and email objects, and independent Contact name parts.
- User reads use the existing workspace-member endpoint, capped at 200 members.
  Only Id equality and IN filters are supported on User.

See [the record API](record-api.md) for token pairing and Canon's native API.
