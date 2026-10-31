"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

type Draft = { teamId: Id<"teamGroups"> | null; name: string; leadId: string; memberIds: string[] };
const btn = "border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-40";

/**
 * Settings, Teams (CP14): named groups of members with a lead. A member can be
 * on several teams. A role that sees "their teams' records" sees the records
 * owned by anyone on a team they are on or lead.
 */
export function TeamsTab() {
  const settings = useQuery(api.permissions.settings);
  const createTeam = useMutation(api.permissions.createTeam);
  const updateTeam = useMutation(api.permissions.updateTeam);
  const removeTeam = useMutation(api.permissions.removeTeam);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  if (settings === undefined) return <LoadingRows count={3} height="h-12" />;
  if (settings === null) return <p className="text-sm text-muted-foreground">Only admins change teams.</p>;
  const nameOf = new Map(settings.members.map((m) => [m.id as string, m.name]));

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      setDraft(null);
      toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const save = (d: Draft) => run(() => {
    const body = { name: d.name, memberIds: d.memberIds as Id<"users">[], ...(d.leadId ? { leadId: d.leadId as Id<"users"> } : {}) };
    return d.teamId ? updateTeam({ teamId: d.teamId, ...body }) : createTeam(body);
  }, "Team saved");
  const toggle = (id: string) => draft && setDraft({ ...draft, memberIds: draft.memberIds.includes(id) ? draft.memberIds.filter((m) => m !== id) : [...draft.memberIds, id] });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Teams decide what &quot;their teams&apos; records&quot; means in Permissions.</p>
        <button onClick={() => setDraft({ teamId: null, name: "", leadId: "", memberIds: [] })} className={`${btn} border-primary`} disabled={busy}>New team</button>
      </div>

      {draft && (
        <section className="space-y-3 border border-primary bg-card p-4">
          <div className="flex flex-wrap items-center gap-3">
            <input aria-label="Team name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Team name"
              className="w-64 border border-border bg-background px-2 py-1 text-sm font-medium" />
            <label className="flex items-center gap-2 text-sm">Lead
              <SelectField aria-label="Team lead" value={draft.leadId} onValueChange={(v) => setDraft({ ...draft, leadId: v })}
                options={[{ value: "", label: "No lead" }, ...settings.members.map((m) => ({ value: m.id, label: m.name }))]} />
            </label>
          </div>
          <fieldset className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Members</legend>
            {settings.members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.memberIds.includes(m.id)} onChange={() => toggle(m.id)} />
                {m.name} <span className="text-xs text-muted-foreground">{m.role}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button onClick={() => void save(draft)} disabled={busy || !draft.name.trim()} className={`${btn} border-primary`}>Save team</button>
            <button onClick={() => setDraft(null)} className={btn}>Cancel</button>
          </div>
        </section>
      )}

      {settings.teams.length === 0 && !draft ? (
        <p className="border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No teams yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs font-medium text-muted-foreground">
            <tr><th className="py-1">Team</th><th className="py-1">Lead</th><th className="py-1">Members</th><th /></tr>
          </thead>
          <tbody>
            {settings.teams.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="py-2 font-medium">{t.name}</td>
                <td className="py-2">{t.leadId ? nameOf.get(t.leadId) ?? "Former member" : "None"}</td>
                <td className="py-2">{t.memberIds.map((id) => nameOf.get(id) ?? "Former member").join(", ") || "None"}</td>
                <td className="py-2 text-right">
                  <button className={btn} onClick={() => setDraft({ teamId: t.id, name: t.name, leadId: t.leadId ?? "", memberIds: [...t.memberIds] })}>Edit</button>{" "}
                  <button className={btn} disabled={busy} onClick={() => { if (window.confirm(`Delete ${t.name}?`)) void run(() => removeTeam({ teamId: t.id }), "Team deleted"); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
