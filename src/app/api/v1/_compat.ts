import { api } from '../../../../convex/_generated/api.js';
import { listRecords, type ApiRecord } from './_records.ts';
import type { V1Client } from './_lib.ts';

/** Compatibility layers resolve a page's parent references with bounded IN reads. */
export async function recordsByIds(client: V1Client, object: string, ids: readonly string[]): Promise<Map<string, ApiRecord>> {
  const unique = [...new Set(ids)];
  if (object === 'user') return new Map((await memberRecords(client)).filter(r => unique.includes(r.id)).map(r => [r.id, r]));
  const records = new Map<string, ApiRecord>();
  for (let i = 0; i < unique.length; i += 200) {
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: '200', filter: `id:in:${unique.slice(i, i + 200).join(',')}` });
      if (cursor) params.set('cursor', cursor);
      const page = (await listRecords(client, object, params, true)).body as { data: ApiRecord[]; nextCursor: string | null };
      page.data.forEach(r => records.set(r.id, r)); cursor = page.nextCursor;
    } while (cursor);
  }
  return records;
}

export async function memberRecords(client: V1Client): Promise<ApiRecord[]> {
  return (await client.query(api.users.list, {})).map(u => ({ id: u._id, object: 'user', title: u.name, version: 1, status: 'active', createdAt: u._creationTime ?? 0, updatedAt: u._creationTime ?? 0, deletedAt: null, values: { name: u.name, email: u.email, isActive: u.isActive, title: u.title ?? null } }));
}
