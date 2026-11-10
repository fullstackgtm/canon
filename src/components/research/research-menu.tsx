"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { AccountsFilter } from "../../../convex/lib/recordContract";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunPreviewDialog, type ContactScopeArg, type RunTarget } from "@/components/research/run-preview-dialog";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type Field = NonNullable<ReturnType<typeof useQuery<typeof api.researchAgents.list>>>["agents"][number];

/**
 * A popover of the workspace's AI fields of one kind; picking one opens the run preview. `filter` is the account
 * scope; `selectedIds` are the contacts picked on the list. The run starts only after the preview is confirmed.
 */
function FieldMenu({ entityType, filter = {}, selectedIds, trigger, intro }: {
  entityType: "account" | "contact";
  filter?: AccountsFilter;
  selectedIds?: string[];
  trigger: React.ReactNode;
  intro: React.ReactNode;
}) {
  const data = useQuery(api.researchAgents.list);
  const startRun = useMutation(api.researchAgents.startRun);
  const [target, setTarget] = useState<RunTarget | null>(null);
  const fields = (data?.agents ?? []).filter((f: Field) => f.entityType === entityType);

  async function start(slug: string, contacts: ContactScopeArg | undefined, capCredits: number | undefined) {
    const cap = capCredits === undefined ? {} : { capCredits };
    try {
      const res = await startRun(entityType === "contact" ? { slug, contacts, ...cap } : { slug, filter, ...cap });
      if (res.refused) toast.error(res.refused);
      else toast.success(`Researching “${fields.find((f) => f.slug === slug)?.label ?? slug}” — follow it on AI fields`);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }

  return (
    <>
      <Popover>
        <PopoverTrigger className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <Sparkles className="size-3" /> {trigger}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2 text-sm">
          <p className="px-2 pb-2 text-xs text-muted-foreground">{intro}</p>
          {fields.map((f) => (
            <button
              key={f.slug}
              type="button"
              disabled={f.latestRun?.status === "running" || f.agent.status !== "active"}
              title={f.agent.message ?? undefined}
              onClick={() => setTarget({ slug: f.slug, label: f.label, entityType })}
              className="block w-full px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
            >
              {f.label}
              {f.latestRun?.status === "running" && <span className="ml-1 text-xs text-muted-foreground">(running)</span>}
              {f.agent.status !== "active" && <span className="ml-1 text-xs text-muted-foreground">(paused)</span>}
            </button>
          ))}
          <Link href="/dashboard/fields" className="mt-1 block border-t border-border px-2 pt-2 text-xs text-muted-foreground hover:text-foreground">
            {fields.length ? "Manage AI fields" : "Create an AI field"}
          </Link>
        </PopoverContent>
      </Popover>
      <RunPreviewDialog target={target} filter={filter} selectedIds={selectedIds} onClose={() => setTarget(null)} onStart={start} />
    </>
  );
}

/** Run an AI field over the explorer's current scope (the drill-down filter), after a preview of what it touches and costs. */
function ResearchMenuEnabled({ filter, scopeCount }: { filter: AccountsFilter; scopeCount: number }) {
  const n = Math.min(scopeCount, 100);
  return (
    <FieldMenu
      entityType="account"
      filter={filter}
      trigger="Research"
      intro={<>Answer an AI field for the {n.toLocaleString()} best-fit account{n === 1 ? "" : "s"} in this view without an answer yet. You see the time and cost before it starts.</>}
    />
  );
}

/** Run a contact AI field on all contacts, a saved view or the rows selected on the list, after a preview. */
function ContactResearchMenuEnabled({ selectedIds, quickTest = false }: { selectedIds: string[]; quickTest?: boolean }) {
  return (
    <FieldMenu
      entityType="contact"
      selectedIds={selectedIds}
      trigger={quickTest ? `Quick test (${selectedIds.length})` : selectedIds.length ? "Run selected" : "Full rollout"}
      intro={quickTest ? "Try an AI field on up to five visible contacts first. Review the scope and cost before confirming. Inspect the answers before running on more contacts." : selectedIds.length ? `Answer an AI field for the ${selectedIds.length} selected contact${selectedIds.length === 1 ? "" : "s"}, or choose another scope next.` : "Answer an AI field for all contacts or a saved view. You see the time and cost before it starts."}
    />
  );
}

export function ResearchMenu(props: React.ComponentProps<typeof ResearchMenuEnabled>) {
  return <IntegrationGate feature={["chatgpt", "openrouter"]}><ResearchMenuEnabled {...props} /></IntegrationGate>;
}

export function ContactResearchMenu(props: React.ComponentProps<typeof ContactResearchMenuEnabled>) {
  return <IntegrationGate feature={["chatgpt", "openrouter"]}><ContactResearchMenuEnabled {...props} /></IntegrationGate>;
}
