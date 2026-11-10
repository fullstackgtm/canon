/**
 * The account hierarchy scan's read of Canon (docs/account-hierarchy-manager.md): every company the scan's starter
 * sees, through the record client they are scoped to (records.principalClient), with the workspace's parent edges and
 * deals. Edges and deals arrive in pages from Convex; the snapshot drops any whose company the client did not return.
 */
import type { RecordClient } from "./recordClient";
import type { AccountRow } from "./recordContract";
import type { CanonicalGtmSnapshot } from "../../engine/src/types.ts";
import { canonSnapshot, type CanonCompany, type CanonDeal, type CanonMember, type CanonParentEdge } from "../../engine/src/accountHierarchy/canonSnapshot.ts";

/**
 * The most companies one scan reads. At 200 a page this is 100 record-service pages, well inside the 10-minute
 * action limit with detection and saving, and the snapshot stays a few megabytes in file storage. A larger workspace
 * gets a refusal that says so rather than a scan that silently misses companies.
 */
export const CANON_SCAN_MAX = 20_000;
const COMPANY_PAGE = 200;

export type Paged<T> = (cursor: string | null) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>;

export async function readCanonCompanies(client: Pick<RecordClient, "list">, orgId: string, max = CANON_SCAN_MAX): Promise<CanonCompany[]> {
  const out: CanonCompany[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.list(orgId, { limit: COMPANY_PAGE, sort: { field: "name", dir: "asc" }, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) out.push(company(row));
    if (out.length > max) throw new Error(`This workspace has more than ${max.toLocaleString("en-US")} companies, more than one scan reads.`);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

async function drain<T>(next: Paged<T>, max: number, what: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const r = await next(cursor);
    out.push(...r.page);
    if (out.length > max) throw new Error(`This workspace has more than ${max.toLocaleString("en-US")} ${what}, more than one scan reads.`);
    if (r.isDone) return out;
    cursor = r.continueCursor;
  }
}

export async function readCanonSnapshot(input: {
  client: Pick<RecordClient, "list">;
  orgId: string;
  parents: Paged<CanonParentEdge>;
  deals: Paged<CanonDeal>;
  members: CanonMember[];
  max?: number;
}): Promise<CanonicalGtmSnapshot> {
  const max = input.max ?? CANON_SCAN_MAX;
  const companies = await readCanonCompanies(input.client, input.orgId, max);
  // Edges and deals are bounded by companies in practice; the doubled cap only stops a runaway read.
  const [parents, deals] = await Promise.all([drain(input.parents, max * 2, "parent links"), drain(input.deals, max * 5, "deals")]);
  return canonSnapshot({ companies, parents, members: input.members, deals });
}

function company(row: AccountRow): CanonCompany {
  return {
    id: row.id,
    name: row.name,
    ...(row.domain ? { domain: row.domain } : {}),
    ...(row.industry ? { industry: row.industry } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.employees !== undefined ? { employees: row.employees } : {}),
    ...(row.annualRevenue !== undefined ? { annualRevenue: row.annualRevenue } : row.revenue !== undefined ? { annualRevenue: row.revenue } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    status: row.status,
    ...(row.traits ? { traits: row.traits } : {}),
  };
}
