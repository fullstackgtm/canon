"use client";

import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { LookupLink } from "./lookup-field";

export const CRM_NAME: Record<"salesforce" | "hubspot", string> = { salesforce: "Salesforce", hubspot: "HubSpot" };

/**
 * What a CRM says about a link where a person's choice in Canon held against it (lib/objects/associations.ts
 * EdgeWriter.crm), and the one way to take it. Taking it hands the link back to the CRM, so later imports and syncs
 * move it.
 */
export function CrmNote({ children, action, take, done, onUsed }: {
  children: ReactNode;
  /** The button: "Use HubSpot's parent". */
  action: string;
  take: () => Promise<unknown>;
  /** The toast once taken. */
  done: string;
  onUsed?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await take();
      toast.success(done);
      onUsed?.();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <p className="mt-1 whitespace-normal text-xs text-muted-foreground">
      {children}{" "}
      <button type="button" disabled={busy} onClick={() => void run()} className="underline hover:text-foreground disabled:opacity-50">
        {action}
      </button>
    </p>
  );
}

/** A CRM parent that differs from the one a person chose in Canon (associations.crmParents). */
export function CrmParentNote({ accountId, provider, crmRef, parent, canonHasParent, onUsed }: {
  accountId: string;
  provider: "salesforce" | "hubspot";
  crmRef: string;
  /** The CRM's parent as a name or link; null when the CRM has none. */
  parent: ReactNode | null;
  canonHasParent: boolean;
  onUsed?: () => void;
}) {
  const take = useAction(api.associations.useCrmParent);
  const crm = CRM_NAME[provider];
  return (
    <CrmNote action={`Use ${crm}'s parent`} take={() => take({ accountId, crmRef })} done={`The parent now follows ${crm}`} {...(onUsed ? { onUsed } : {})}>
      {parent ? <>{crm} has this company under {parent}. </> : <>{crm} has no parent for this company. </>}
      {canonHasParent ? "Canon keeps the parent a person set here." : "Canon keeps it without a parent, as a person left it."}
    </CrmNote>
  );
}

/** What a CRM says about a deal's people where a person's choice held against it (dealCommittee.crmRolesOf). */
export function CrmRoleNotes({ roles, roleLabel, personLink, onUsed }: {
  roles: ReadonlyArray<{ id: string; provider: "salesforce" | "hubspot"; contactId: string; name: string; role: string; onDeal: boolean }>;
  roleLabel: (role: string) => string;
  personLink: (contactId: string, name: string) => ReactNode;
  onUsed?: () => void;
}) {
  const take = useAction(api.dealCommittee.useCrmRole);
  return roles.map((c) => {
    const crm = CRM_NAME[c.provider];
    return (
      <CrmNote key={c.id} action={`Use ${crm}'s role`} take={() => take({ id: c.id })} done={`${c.name}'s role now follows ${crm}`} {...(onUsed ? { onUsed } : {})}>
        {crm} has {personLink(c.contactId, c.name)} on this deal as {roleLabel(c.role)}.{" "}
        {c.onDeal ? "Canon keeps the role a person gave here." : "Canon keeps them off it, as a person left it."}
      </CrmNote>
    );
  });
}

const FIELD_NOUN: Record<string, string> = { ownerId: "owner", companyId: "company" };

/** What a CRM says a deal's owner or company is, where the one a person chose in Canon held (fieldClaims.forDeal). */
export function CrmFieldNote({ claim, canTake }: {
  claim: { id: string; field: string; provider: "salesforce" | "hubspot"; value: unknown; label: string | null };
  canTake: boolean;
}) {
  const take = useMutation(api.fieldClaims.useCrmValue);
  const crm = CRM_NAME[claim.provider];
  const noun = FIELD_NOUN[claim.field] ?? claim.field;
  const value = typeof claim.value !== "string" ? null
    : claim.field === "companyId" ? <LookupLink object="account" id={claim.value} className="underline hover:text-foreground" />
    : claim.label ?? "a former member";
  const says = value ? <>{crm} says the {noun} is {value}.</> : <>{crm} has no {noun} for this deal.</>;
  if (!canTake) return <p className="mt-1 whitespace-normal text-xs text-muted-foreground">{says}</p>;
  return (
    <CrmNote action={`Use ${crm}'s ${noun}`} take={() => take({ id: claim.id })} done={`The ${noun} now follows ${crm}`}>
      {says}
    </CrmNote>
  );
}
