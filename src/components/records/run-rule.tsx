"use client";

import { useMutation, useQuery } from "convex/react";
import { Zap } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { btn } from "./record-parts";

/**
 * The automation rules a member can run on this record now (convex/automations.ts runOnRecord): each runs as the
 * admin who approved it, and only for someone who can edit the record. Shows nothing when there are none.
 */
export function RunRule({ object, id }: { object: string; id: string }) {
  const rules = useQuery(api.automations.manualRules, { object });
  const run = useMutation(api.automations.runOnRecord);
  if (!rules?.length) return null;
  async function go(ruleId: Id<"automationRules">, name: string) {
    try {
      const out = await run({ ruleId, id });
      if ("refused" in out) void toast.error(out.refused);
      else void toast.success(`${name} is running. Its run is on the Automations page.`);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={btn} data-testid="run-rule"><Zap className="h-3 w-3" /> Run a rule</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-sm">
        {rules.map((r) => (
          <DropdownMenuItem key={r.id} onSelect={() => void go(r.id, r.name)}>
            <span className="flex flex-col"><span className="font-medium">{r.name}</span><span className="text-xs text-muted-foreground">{r.sentence}</span></span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
