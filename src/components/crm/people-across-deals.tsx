"use client";

import { useEffect, useState } from "react";
import { RecordLink } from "@/components/records/record-context";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { CompanyRole } from "../../../convex/dealCommittee";
import { ROLE_LABEL } from "../../../convex/lib/committee";
import { cn } from "@/lib/utils";

const head = "text-xs font-medium text-muted-foreground";
const FILTERS = [["current", "Current"], ["former", "Former"], ["all", "All"]] as const;
type Filter = (typeof FILTERS)[number][0];
const OUTCOME = { open: "Open", won: "Won", lost: "Lost" } as const;

/**
 * Everyone who has held a role on this company's deals. "Current" means they
 * are among the company's contacts today; anyone else has left or moved.
 */
export function PeopleAcrossDeals({ companyId, domain, stream, currentIds, title = "People across deals" }: { companyId: string; domain: string; stream?: string; currentIds: ReadonlySet<string>; title?: string }) {
  const read = useAction(api.dealCommittee.forCompany);
  const [rows, setRows] = useState<CompanyRole[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    read({ companyId, domain, ...(stream ? { stream } : {}) }).then((r) => { if (live) setRows(r); }, () => { if (live) setRows([]); });
    return () => { live = false; };
  }, [read, companyId, domain, stream]);
  const [filter, setFilter] = useState<Filter>("current");
  if (rows === undefined) return null;
  const shown = rows.filter((r) => filter === "all" || (filter === "current") === currentIds.has(r.contactId));

  return (
    <section className="border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        <div className="flex border border-border" role="group" aria-label="Employment">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn("px-2 py-1 text-xs font-medium", filter === value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one holds a role on this company&apos;s deals yet. Set a deal&apos;s buying committee on its page.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{filter === "current" ? "No one with a role still works here." : "Everyone with a role still works here."}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className={head}>
            <tr><th className="py-1 text-left">Person</th><th className="py-1 text-left">Role</th><th className="py-1 text-left">Deal</th><th className="py-1 text-left">Outcome</th>{filter === "all" && <th className="py-1 text-left">Here now</th>}</tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-2">{r.contactName}{r.title && <span className="text-muted-foreground"> · {r.title}</span>}</td>
                <td className="py-2">{ROLE_LABEL[r.role]}</td>
                <td className="py-2">{r.dealStreamId ? <RecordLink object="deal" id={r.dealStreamId} className="underline">{r.dealName}</RecordLink> : r.dealName}</td>
                <td className="py-2">{OUTCOME[r.outcome as keyof typeof OUTCOME]}</td>
                {filter === "all" && <td className="py-2">{currentIds.has(r.contactId) ? "Yes" : "No"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
