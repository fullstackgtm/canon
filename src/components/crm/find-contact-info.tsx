"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

const btn = "border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

/**
 * "Find email" / "Find phone" for one contact: runs records.findEmail or
 * records.findPhone (the lookup writes what it finds onto the contact), says
 * when nothing was found, and calls `onFound` so the page rereads the row.
 */
function FindContactInfoEnabled({ kind, accountId, contactId, name, onFound, className, label, disabled }: {
  kind: "email" | "phone";
  /** The page's label for it, from the recipe. */
  label?: string;
  disabled?: boolean;
  accountId: string;
  contactId: string;
  name: string;
  onFound: () => unknown;
  className?: string;
}) {
  const findEmail = useAction(api.records.findEmail);
  const findPhone = useAction(api.records.findPhone);
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);

  async function find() {
    setBusy(true);
    try {
      const r = kind === "email" ? await findEmail({ accountId, contactId }) : await findPhone({ accountId, contactId });
      if (r.status === "limit_reached") toast.error(r.message);
      else if (r.status === "not_found") {
        setMissed(true);
        toast.error(`No ${kind === "email" ? "work email" : "phone number"} found for ${name}.`);
      } else await onFound();
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (missed) return <span className={cn("text-xs text-muted-foreground", className)}>{kind} not found</span>;
  return (
    <button type="button" onClick={() => void find()} disabled={busy || disabled} className={cn(btn, className)} data-testid={`find-${kind}`}>
      {busy ? "Finding…" : label ?? (kind === "email" ? "Find email" : "Find phone")}
    </button>
  );
}

export function FindContactInfo(props: React.ComponentProps<typeof FindContactInfoEnabled>) {
  return <IntegrationGate feature="treg"><FindContactInfoEnabled {...props} /></IntegrationGate>;
}
