/**
 * Who a proposal batch is from, and everything the write gate derives from
 * that (convex/canonGate.ts:submitProposalBatch). Pure.
 *
 * An agent attribution needs an ActingAgent, which only convex/agents.ts
 * mints after a standing check in the same transaction. A user attribution
 * carries a DeclaredLabel: the caller's name for its tool, never an identity.
 * So `actor.kind === "agent"` on a new fact always means a verified agent.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";

declare const acting: unique symbol;
/** An agent that passed its standing check inside the current transaction. Never store it or pass it across a function boundary. */
export type ActingAgent = Doc<"agents"> & { readonly [acting]: true };

declare const declared: unique symbol;
export type DeclaredLabel = string & { readonly [declared]: true };

/** Agent ledger keys use these, so a declared label with one could write into an agent's sourceRef namespace. */
export const RESERVED_LABEL_PREFIXES = ["research:", "agent:"] as const;
const MAX_LABEL = 200;

/** Parse the wire field `agentId` (MCP, CLI, engine) into a label. */
export function declaredLabel(raw: string): DeclaredLabel {
  if (!raw || raw.length > MAX_LABEL) throw new ConvexError(`agentId must be 1 to ${MAX_LABEL} characters`);
  const reserved = RESERVED_LABEL_PREFIXES.find((p) => raw.startsWith(p));
  if (reserved) throw new ConvexError(`agentId may not start with "${reserved}": that prefix is reserved for agents Canon verifies`);
  return raw as DeclaredLabel;
}

export type Attribution =
  /** `triggeredBy`: the human whose action caused this work (a manual run's starter). */
  | { kind: "agent"; agent: ActingAgent; triggeredBy: Id<"users"> }
  | { kind: "user"; orgId: Id<"organizations">; userId: Id<"users">; cliTokenId?: Id<"cliTokens">; label: DeclaredLabel };

export type FactActor = { kind: "agent"; id: Id<"agents"> } | { kind: "user"; id: Id<"users"> };

export type Provenance = {
  orgId: Id<"organizations">;
  actor: FactActor;
  createdBy: Id<"users">;
  agentId?: Id<"agents">;
  cliTokenId?: Id<"cliTokens">;
  /** The namespace in sourceRefs and sourceRuleOrPolicy: the agent's ledger key, or the declared label. */
  refKey: string;
};

export function provenanceOf(a: Attribution): Provenance {
  switch (a.kind) {
    case "agent":
      return {
        orgId: a.agent.orgId, actor: { kind: "agent", id: a.agent._id }, createdBy: a.triggeredBy,
        agentId: a.agent._id, refKey: a.agent.ledgerKey,
      };
    case "user":
      return {
        orgId: a.orgId, actor: { kind: "user", id: a.userId }, createdBy: a.userId,
        ...(a.cliTokenId ? { cliTokenId: a.cliTokenId } : {}), refKey: a.label,
      };
  }
}

/** The ledger appends `:<attribute>`; the result is the proposal's dedupe key, so its format must not change. */
export function proposalSourceRefBase(sourceKind: string, p: Pick<Provenance, "refKey">, objectKey: string): string {
  return `${sourceKind}:${p.refKey}:${objectKey}`;
}
