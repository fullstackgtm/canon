"use client";

import { useMutation, useQuery } from "convex/react";
import { User } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

/**
 * A local stack's "Signed in as": the dev auth bypass signs in as one seeded member, and this picks which, so a rep's
 * actions can be run in the UI (convex/devAuth.ts). DEV_MODE needs no Clerk key, and the server answers null where
 * the bypass is off, so it never draws on dev or prod.
 */
export function DevUserButton({ collapsed }: { collapsed?: boolean }) {
  const seeded = useQuery(api.devAuth.members, {});
  const actAs = useMutation(api.devAuth.actAs);
  const current = seeded?.members.find((m) => m.id === seeded.current);
  return (
    <div className="flex items-center gap-2 text-sm text-sidebar-foreground/70">
      <div className="flex size-7 shrink-0 items-center justify-center bg-sidebar-accent" title={current ? `Signed in as ${current.name}` : undefined}>
        <User className="size-4" />
      </div>
      {!collapsed && (seeded && current ? (
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="text-[10px] uppercase tracking-wide text-sidebar-foreground/70">Signed in as</span>
          <select
            aria-label="Signed in as"
            className="min-w-0 truncate bg-transparent text-sm text-sidebar-foreground outline-none"
            value={seeded.current}
            onChange={(e) => {
              const id = e.target.value as Id<"users">;
              void actAs({ userId: id }).then((m) => toast.success(`Signed in as ${m.name} (${m.role})`), (err) => toast.error(getErrorMessage(err)));
            }}
          >
            {seeded.members.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
          </select>
        </label>
      ) : <span>Dev User</span>)}
    </div>
  );
}
