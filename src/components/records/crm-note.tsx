"use client";

import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { LookupLink } from "./lookup-field";
import { formatValue, type CellValue, type FieldDescription, type TeamMember } from "./fields";
import type { Money } from "./money";

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

type ClaimView = FunctionReturnType<typeof api.fieldClaims.forDeal>[number];

/**
 * What a CRM says a deal field is, where the value a person chose in Canon held (fieldClaims.forDeal). Fields that move
 * together read as one note under the group's lead field: "Salesforce says the stage is Negotiation (forecast category
 * Commit, open)."
 */
export function CrmFieldNote({ claim, canTake, fields, team, money }: {
  claim: ClaimView;
  canTake: boolean;
  /** The deal's fields, to name and format the CRM's values as the page shows them. */
  fields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  money?: Money;
}) {
  const take = useMutation(api.fieldClaims.useCrmValue);
  const crm = CRM_NAME[claim.provider];
  const fieldOf = (id: string) => fields.find((f) => f.fieldId === id);
  const noun = FIELD_NOUN[claim.field] ?? fieldOf(claim.field)?.label.toLowerCase() ?? claim.field;
  // An amount reads in the currency the CRM gives with it.
  const currency = claim.values.find((v) => v.field === "currency")?.value;
  const inMoney = money && typeof currency === "string" && currency ? { ...money, currency } : money;
  const shown = (id: string, value: unknown): ReactNode => {
    if (id === "ownerId") return typeof value === "string" ? claim.label ?? "a former member" : null;
    if (id === "companyId") return typeof value === "string" ? <LookupLink object="account" id={value} className="underline hover:text-foreground" /> : null;
    const field = fieldOf(id);
    const text = field ? formatValue(field, value as CellValue, team, inMoney) : value === null || value === undefined ? "" : String(value);
    return text || null;
  };
  // A group's other fields: a checkbox as its own word ("closed", "not won"), the rest as "forecast category Commit".
  const rest = claim.values.filter((v) => v.field !== claim.field).map((v) => {
    const field = fieldOf(v.field);
    const label = field?.label.toLowerCase() ?? v.field;
    if (field?.type === "checkbox") return v.value === true ? label : `not ${label}`;
    const text = shown(v.field, v.value);
    return text === null ? `no ${label}` : <>{label} {text}</>;
  });
  const value = shown(claim.field, claim.value);
  const also = rest.length ? <> ({rest.map((r, i) => <span key={i}>{i ? ", " : ""}{r}</span>)})</> : null;
  const says = value !== null ? <>{crm} says the {noun} is {value}{also}.</> : <>{crm} has no {noun} for this deal{also}.</>;
  if (!canTake) return <p className="mt-1 whitespace-normal text-xs text-muted-foreground">{says}</p>;
  return (
    <CrmNote action={`Use ${crm}'s ${noun}`} take={() => take({ id: claim.id })} done={`The ${noun} now follows ${crm}`}>
      {says}
    </CrmNote>
  );
}
