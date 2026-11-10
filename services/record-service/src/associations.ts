// Edge streams (CP3, contract 1.20.0; convex/lib/objects/associations.ts). The
// projector keeps them in p_association like any object; for contact-to-company
// edges it also writes the contact's register accountId from its primary edge,
// in the same transaction, and marks the contact `accountLedger` so upserts and
// domain linking leave that accountId alone from then on.
//
// A contact's edges in one batch are resolved together: an active primary edge
// among them sets the account; otherwise a removed edge clears the account
// while it is that edge's company. Convex keeps at most one primary per
// contact, so the result does not depend on the order a catch-up or a rebuild
// applies edges in, and moving the primary is one change in the history.
import type { DuckDBConnection } from "@duckdb/node-api";
import { project, type FoldState } from "./core/objects/fold.ts";
import { edgeOf, type Edge, type ResolvedObjectDef } from "./core/objects/registry.ts";
import { all, lit } from "./db.ts";
import { refitSql, writeChanges, writeHistory } from "./upsert.ts";
import { isMergeRef } from "./register.ts";

type Touched = { edge: Edge; kind: string; actor: string; merged: boolean };

export async function writeBackAssociations(c: DuckDBConnection, def: ResolvedObjectDef, states: readonly FoldState[], now: number) {
  const byContact = new Map<string, Touched[]>();
  for (const st of states) {
    const row = project(def, st);
    const edge = edgeOf(row.values, row.deletedAt);
    if (!edge || edge.association !== "contact_account") continue;
    // Whoever set the primary flag's winning value: a person (`user:<userId>`) or the register row it was seeded from.
    const kind = row.meta.primary?.sourceKind ?? "ledger";
    const fact = st.fields.primary?.candidates.find((f) => f.factId === row.meta.primary?.factId);
    const actor = kind === "user" && fact ? fact.sourceRef.split(":")[1] || "user" : kind;
    byContact.set(edge.fromId, [...(byContact.get(edge.fromId) ?? []), { edge, kind, actor, merged: Boolean(fact && isMergeRef(fact.sourceRef)) }]);
  }
  // A person moving decides whether either company has a buyer (contract 1.30.0): both are refit below.
  const moved = new Set<string>();
  for (const [contactId, touched] of byContact) {
    const contact = (await all(c, `SELECT accountId, accountLedger FROM contacts WHERE id = $id LIMIT 1`, { id: contactId }))[0];
    if (!contact) continue;
    const current = String(contact.accountId ?? "");
    const primary = touched.find((t) => t.edge.active && t.edge.primary);
    // Only a removed edge clears its company: a demoted one is always demoted alongside the edge promoted in its
    // place, which can be on another shard and so be applied later.
    const cleared = !primary && touched.some((t) => !t.edge.active && t.edge.toId === current);
    const next = primary ? primary.edge.toId : cleared ? "" : current;
    if (next === current) {
      if (contact.accountLedger !== true) await c.run(`UPDATE contacts SET accountLedger = true WHERE id = $id`, { id: contactId });
      continue;
    }
    const by = primary ?? touched.find((t) => t.edge.toId === current)!;
    await c.run(`UPDATE contacts SET accountId = $a, accountLedger = true, updatedAt = $now, version = version + 1 WHERE id = $id`, { a: next, now, id: contactId });
    for (const id of [current, next]) if (id) moved.add(id);
    await writeHistory(c, [{ object: "contact", id: contactId, field: "accountId", oldValue: current, newValue: next }], by.actor, `ledger:${by.kind}`, now);
    // A move a merge or its undo made goes out as op `merge`, which no CRM sync pushes.
    await writeChanges(c, [{ object: "contact", id: contactId, values: { accountId: next } }], by.merged ? "merge" : "edit", by.kind, now);
  }
  if (moved.size) await c.run(refitSql(`WHERE a.id IN (${[...moved].map(lit).join(", ")})`));
}
