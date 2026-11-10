import { all } from "./db.ts";
import { objectSource } from "./projectionQuery.ts";
import { ident } from "./projection.ts";
import { fieldColumn } from "./core/objects/listSpec.ts";
import { matchInbound, MATCH_SCAN_MAX, MATCH_CANDIDATES_MAX, type MatchCompany, type MatchPerson } from "./core/objects/inboundMatch.ts";
import { inboundMatchInput, type InboundMatchInput } from "./core/kernel/inboundMatchInput.ts";
import type { Workspace } from "./workspace.ts";

/** Authenticated workspace service read. The module planner admits only system calls. */
export async function registerInboundMatch(w: Workspace, raw: InboundMatchInput) {
  const input = inboundMatchInput(raw);
  const text = (v: unknown) => typeof v === "string" ? v : null;
  const { companies, people, leads } = await w.read(async (c) => {
    const source = await objectSource(c, "lead");
    const email = source?.def.byApiName.get("email");
    const leads = source && email ? await all(c, `SELECT id, ${ident(fieldColumn(email.fieldId))} AS email FROM ${source.from} WHERE ${source.live} AND lower(trim(${ident(fieldColumn(email.fieldId))})) = $email ORDER BY id LIMIT ${MATCH_CANDIDATES_MAX + 1}`, { email: input.email }) : [];
    return {
      leads,
      companies: (await all(c, `SELECT id, name, domain, ownerId FROM accounts WHERE deletedAt IS NULL ORDER BY id LIMIT ${MATCH_SCAN_MAX + 1}`)).map((r): MatchCompany => ({ id: String(r.id), name: String(r.name ?? ""), domain: text(r.domain), ownerId: text(r.ownerId) })),
      people: (await all(c, `SELECT id, email, additionalEmails, accountId FROM contacts WHERE deletedAt IS NULL AND (lower(trim(email)) = $email OR list_contains(list_transform(additionalEmails, e -> lower(trim(e))), $email)) ORDER BY id LIMIT ${MATCH_CANDIDATES_MAX + 1}`, { email: input.email })).map((r): MatchPerson => ({ id: String(r.id), email: text(r.email), accountId: text(r.accountId), additionalEmails: Array.isArray(r.additionalEmails) ? r.additionalEmails.map(String) : [] })),
    };
  });
  return matchInbound(input, companies, people, leads.map((r) => ({ id: String(r.id), email: text(r.email) })));
}
