// A contact with no account takes the account its email's domain names (contract 1.16.0).
// Contacts from the ledger (CRM syncs, agents) arrive with no accountId; fills and CSV
// imports link theirs explicitly, and an explicit link always wins: this only fills an
// empty accountId. A contact whose companies are on the ledger (`accountLedger`, contract
// 1.20.0) takes its accountId from its primary edge only, so an empty one stays empty.
// Dependency-free, so db.ts's migrations can use it.

/** Personal mail domains: an address there says nothing about where the person works. */
export const PERSONAL_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "mail.com",
];

/**
 * Unlinked contacts and the account their email's domain names, as (contactId, accountId):
 * one account per domain (the lowest id), never a personal domain. `domainsIn`, a SQL list,
 * limits the accounts read to those domains. `beforeLedgerLinks`: for migration 9, which runs
 * before the `accountLedger` column exists.
 */
export function domainMatchSql(domainsIn?: string, opts?: { beforeLedgerLinks?: true }): string {
  return `SELECT c.id AS contactId, a.id AS accountId FROM contacts c
    JOIN (SELECT id, domain FROM accounts WHERE deletedAt IS NULL AND domain <> ''${domainsIn ? ` AND domain IN (${domainsIn})` : ""}
            AND domain NOT IN (${PERSONAL_DOMAINS.map((d) => `'${d}'`).join(", ")})
          QUALIFY row_number() OVER (PARTITION BY domain ORDER BY id) = 1) a
      ON a.domain = lower(split_part(c.email, '@', 2))
    WHERE c.accountId = '' AND c.deletedAt IS NULL${opts?.beforeLedgerLinks ? "" : " AND NOT coalesce(c.accountLedger, false)"}`;
}
