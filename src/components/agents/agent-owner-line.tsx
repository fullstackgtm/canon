"use client";

import { useMutation, useQuery } from "convex/react";
import { UserRound } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { AgentView } from "../../../convex/agents";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { SelectField } from "@/components/ui/select";

/** Who answers for an agent, whether it may run, and the owner/admin controls. */
export function AgentOwnerLine({ agent }: { agent: AgentView }) {
  const setPaused = useMutation(api.agents.setPaused);
  const setOwner = useMutation(api.agents.setOwner);
  const candidates = useQuery(api.agents.ownerCandidates, agent.canReassign ? {} : "skip");
  const guard = (p: Promise<unknown>) => void p.catch((e) => toast.error(getErrorMessage(e)));
  const canResume = agent.status === "paused" && (agent.reason === "paused_by_user" ? agent.canManage : agent.canReassign && agent.ownerEligible);
  const ownerListed = candidates?.some((c) => c.id === agent.owner?.id) ?? false;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <UserRound className="size-3.5" />
      <span>
        Owner: {agent.owner?.name ?? "unknown"} ·{" "}
        {agent.status === "active" ? "Active" : <span className="text-destructive">{agent.message}</span>}
      </span>
      {agent.canReassign && candidates && (
        <SelectField
          aria-label="Change owner"
          value={agent.owner?.id ?? ""}
          onValueChange={(v) => guard(setOwner({ agent: agent.ref, ownerUserId: v as Id<"users"> }))}
          options={[
            ...(ownerListed ? [] : [{ value: agent.owner?.id ?? "", label: agent.owner?.name ?? "Choose an owner", disabled: true }]),
            ...candidates.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      )}
      {agent.status === "active" && agent.canManage && (
        <button type="button" onClick={() => guard(setPaused({ agent: agent.ref, paused: true }))} className="underline underline-offset-2 hover:text-foreground">
          Pause
        </button>
      )}
      {canResume && (
        <button type="button" onClick={() => guard(setPaused({ agent: agent.ref, paused: false }))} className="underline underline-offset-2 hover:text-foreground">
          Resume
        </button>
      )}
    </div>
  );
}
