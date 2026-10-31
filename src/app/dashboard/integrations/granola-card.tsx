"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowDown, ArrowUp, KeyRound, Loader2, RefreshCw, Search, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { GRANOLA_DEFAULT_LOOKBACK_DAYS, GRANOLA_LOOKBACK_DAYS } from "../../../../convex/lib/calls/granola";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { formatRelativeTime } from "./call-provider-card";
import { SelectField } from "@/components/ui/select";

/** Disconnect Granola after confirming what it deletes: `imported` meetings and what came of them. */
export function useGranolaDisconnect() {
  const disconnect = useMutation(api.granola.disconnect);
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run(imported: number) {
      const meetings = imported >= 1000 ? "1,000+ meetings" : `${imported} ${imported === 1 ? "meeting" : "meetings"}`;
      if (!window.confirm(`Disconnect Granola? This deletes the ${meetings} it imported: their transcripts, insights and suggestions, and the meeting entries it logged on timelines. Companies, people and deals stay, and so do values already applied to them.`)) return;
      setBusy(true);
      disconnect({})
        .then(() => void toast.success("Granola disconnected. Its meetings are being deleted."))
        .catch((cause) => void toast.error(getErrorMessage(cause)))
        .finally(() => setBusy(false));
    },
  };
}

/** Granola: the workspace's API key, checked and stored encrypted. New meetings come in on their own every 15 minutes. */
export function GranolaControls() {
  const status = useQuery(api.granola.status);
  const connect = useAction(api.granolaActions.connect);
  const syncNow = useAction(api.granolaActions.syncNow);
  const disconnect = useGranolaDisconnect();
  const setRule = useMutation(api.canonGate.setAutoAcceptRule);
  const setLookback = useMutation(api.granola.setLookback);
  const setMembersOnly = useMutation(api.granola.setSuggestMembersOnly);
  const setOurTeam = useMutation(api.granola.setOurTeam);
  const recheck = useAction(api.granolaActions.recheck);
  const [team, setTeam] = useState<string | null>(null);
  async function saveTeam(entries: string[]) {
    await setOurTeam({ entries: entries.filter((e) => e.trim()) });
    setTeam(null);
    void toast.success("Team saved. Imported meetings are being checked again.");
  }
  const [lookback, setLookbackChoice] = useState<number>(GRANOLA_DEFAULT_LOOKBACK_DAYS);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="granola-card">
      {!status?.connected && (
        <p className="text-sm text-muted-foreground">Create a key in Granola under Settings, API (Business or Enterprise plan).</p>
      )}
      {status?.connected ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Last checked {formatRelativeTime(status.lastSyncAt ?? undefined)}
              {status.catchingUp && <span className="text-muted-foreground"> · importing older meetings</span>}
              {status.rescoping && <span className="text-muted-foreground"> · switching folders</span>}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => {
                  const r = await syncNow({});
                  void toast.success(r.calls ? `${r.calls} ${r.calls === 1 ? "meeting" : "meetings"} synced, ${r.linkedToDeals} on a deal` : "No new meetings");
                })}
                className={OUTLINE}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check now
              </button>
              <button
                type="button"
                disabled={busy || disconnect.busy}
                onClick={() => disconnect.run(status.imported)}
                className={OUTLINE}
              >
                <Unplug className="h-4 w-4" /> Disconnect
              </button>
            </div>
          </div>
          {status.lastSyncStatus !== "success" && status.lastSyncError && <p className="mt-2 text-sm text-destructive">{status.lastSyncError}</p>}
          <dl className="mt-4 grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-3 border-t border-border/70 pt-4 text-sm">
            <dt className="text-muted-foreground">Look back</dt>
            <dd title="Looking further back imports older meetings over the next few minutes. Meetings over a week old are logged but propose no updates.">
              <LookbackSelect
                value={status.lookbackDays}
                disabled={busy}
                onChange={(days) => void run(async () => {
                  const r = await setLookback({ days });
                  void toast.success(r.rewound ? `Importing meetings from the last ${days} days` : `Looking back ${days} days for new connections`);
                })}
              />
            </dd>
            {status.canManage && (
              <>
                <dt className="self-start pt-1.5 text-muted-foreground">Folders</dt>
                <dd><FolderChooser chosen={status.folders} rescoping={status.rescoping} imported={status.imported} /></dd>
              </>
            )}
            <dt className="text-muted-foreground">Suggestions</dt>
            <dd data-testid="granola-suggestions">
              <label className="flex items-center gap-2" title="New people, companies and deals from meetings wait on the Deals page. Our team: the note's owner or an attendee is a member, at a member's company, or listed under Our team.">
                <input
                  type="checkbox"
                  checked={status.suggestMembersOnly}
                  disabled={busy}
                  onChange={(e) => {
                    const membersOnly = e.target.checked;
                    void run(async () => { await setMembersOnly({ membersOnly }); });
                  }}
                />
                Only from our team&apos;s meetings
              </label>
            </dd>
            {status.canManage && (
              <>
                <dt className="self-start pt-1.5 text-muted-foreground">Our team</dt>
                <dd>
                  <div className="flex flex-wrap gap-2">
                    <input
                      aria-label="Also count as our team"
                      placeholder="fullstackgtm.com, ryan@oldcompany.com"
                      value={team ?? status.ourTeam.join(", ")}
                      onChange={(e) => setTeam(e.target.value)}
                      disabled={busy}
                      className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm"
                    />
                    {team !== null && (
                      <button type="button" disabled={busy} onClick={() => void run(async () => { await saveTeam(team.split(/[,\s]+/)); })} className={PRIMARY}>
                        Save
                      </button>
                    )}
                    <button type="button" disabled={busy} title="Check imported meetings again for suggestions" onClick={() => void run(async () => {
                      const r = await recheck({});
                      void toast.success(r.meetings ? `Checking ${r.meetings} imported ${r.meetings === 1 ? "meeting" : "meetings"} again` : "No imported meetings to check");
                    })} className={OUTLINE}>
                      Re-check
                    </button>
                  </div>
                  {status.outsideOwners.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="granola-outside-owners">
                      Not counted:
                      {status.outsideOwners.map((owner) => {
                        const domain = owner.slice(owner.indexOf("@") + 1);
                        return (
                          <button key={owner} type="button" disabled={busy} title={`Meetings owned by ${owner} didn't count as your team`}
                            className="rounded-full border border-input px-2 py-0.5 hover:bg-muted disabled:opacity-50"
                            onClick={() => void run(async () => { await saveTeam([...status.ourTeam, domain]); })}>
                            + {domain}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Call updates</dt>
            <dd className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="granola-updates">
              <label className="flex items-center gap-2" title={status.updates.canEdit ? "Next step and close date apply without review when an independent check confirms the quote supports them." : "Only an admin can change this."}>
                <input
                  type="checkbox"
                  checked={status.updates.autoApply}
                  disabled={busy || !status.updates.canEdit}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    void run(async () => {
                      for (const attribute of ["nextStep", "closeDate"]) await setRule({ sourceKind: "call", attribute, minConfidence: 0.8, enabled });
                      void toast.success(enabled ? "Next step and close date now apply from calls" : "Call updates wait for review");
                    });
                  }}
                />
                Auto-apply next step and close date
              </label>
              <Link href="/dashboard/facts" className="underline underline-offset-2">
                {status.updates.pending ? `${status.updates.pending} to review` : "Fact Review"}
              </Link>
            </dd>
          </dl>
        </>
      ) : (
        <form
          className="mt-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await connect({ apiKey: key, lookbackDays: lookback });
              setKey("");
              void toast.success("Granola connected. Your recent meetings are on their way.");
            });
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            Import the last
            <LookbackSelect value={lookback} disabled={busy} onChange={setLookbackChoice} />
          </label>
          <input
            type="password"
            autoComplete="off"
            aria-label="Granola API key"
            placeholder="grn_..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-72 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect Granola
          </button>
        </form>
      )}
    </div>
  );
}

const OUTLINE = "inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
const PRIMARY = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";

/** What a meeting's suggestion check found. */
const SUGGESTION_REASON: Record<string, (count: number) => string> = {
  suggested: (n) => `${n} on the Deals page`,
  not_our_meeting: () => "None: not our team's meeting",
  no_one_else: () => "None: no one from the other side",
  all_known: () => "None: everyone already in the CRM",
};

/** The meetings query's cap (convex/granola.ts MEETINGS_MAX). */
const MEETINGS_SHOWN = 500;
const OUTCOMES = { deal: "On a deal", logged: "No open deal", unmatched: "No matching contact" } as const;
type Meeting = FunctionReturnType<typeof api.granola.meetings>[number];
type SortKey = "title" | "at" | "owner" | "deal" | "people";
const COLUMNS: Array<[SortKey, string]> = [["title", "Meeting"], ["at", "Date"], ["owner", "Owner"], ["people", "People"], ["deal", "Deal"]];

/** Every imported Granola meeting: searchable, sortable, filtered by what the import did with it. */
export function GranolaMeetings() {
  const meetings = useQuery(api.granola.meetings);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState<"" | Meeting["outcome"]>("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "at", dir: "desc" });
  if (meetings === undefined) return <p className="text-sm text-muted-foreground">Loading meetings…</p>;
  if (meetings.length === 0) return <p className="text-sm text-muted-foreground">No meetings imported yet.</p>;

  const needle = search.trim().toLowerCase();
  const rows = meetings
    .filter((m) => !outcome || m.outcome === outcome)
    .filter((m) => !needle || [m.title, m.owner, m.deal].some((v) => v?.toLowerCase().includes(needle)))
    .sort((a, b) => {
      const x = a[sort.key] ?? "";
      const y = b[sort.key] ?? "";
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? order : -order;
    });
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "at" || key === "people" ? "desc" : "asc" }));

  return (
    <div data-testid="granola-meetings">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input aria-label="Search meetings" placeholder="Search meetings, owners, deals" value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-input bg-background py-1.5 pl-8 pr-3 text-sm" />
        </div>
        <SelectField aria-label="Filter meetings" value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)}
          options={[{ value: "", label: "All meetings" }, ...Object.entries(OUTCOMES).map(([value, label]) => ({ value, label }))]} />
        <span className="text-xs font-medium text-muted-foreground">{rows.length} of {meetings.length}{meetings.length >= MEETINGS_SHOWN ? " latest" : ""}</span>
      </div>
      <div className="max-h-[32rem] overflow-auto border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted text-left text-xs font-medium text-muted-foreground">
            <tr>
              {COLUMNS.map(([key, label]) => (
                <th key={key} className="whitespace-nowrap px-3 py-2" aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  <button type="button" onClick={() => toggle(key)} className="inline-flex items-center gap-1 hover:text-foreground">
                    {label}
                    {sort.key === key && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </th>
              ))}
              <th className="whitespace-nowrap px-3 py-2">Suggestions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="max-w-xs truncate px-3 py-2 font-medium" title={m.title}>{m.title}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={new Date(m.at).toLocaleString()}>{new Date(m.at).toLocaleDateString()}</td>
                <td className="max-w-[12rem] truncate px-3 py-2">{m.owner ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{m.people}</td>
                <td className="max-w-[14rem] truncate px-3 py-2">{m.deal ?? <span className="text-muted-foreground">{OUTCOMES[m.outcome]}</span>}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{m.suggestions ? SUGGESTION_REASON[m.suggestions.reason]?.(m.suggestions.count) ?? "" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No meetings match.</p>}
      </div>
    </div>
  );
}

function LookbackSelect({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (days: number) => void }) {
  return (
    <SelectField
      aria-label="How far back to import"
      value={String(value)}
      disabled={disabled}
      onValueChange={(v) => onChange(Number(v))}
      options={GRANOLA_LOOKBACK_DAYS.map((days) => ({ value: String(days), label: days === 365 ? "year" : `${days} days` }))}
    />
  );
}

/**
 * Which Granola folders feed this workspace: all meetings, or only the chosen folders (and their subfolders).
 * Granola's folder list is read when the chooser opens. Changing it starts the import over.
 */
function FolderChooser({ chosen, rescoping, imported }: { chosen: Array<{ id: string; name: string }>; rescoping: boolean; imported: number }) {
  const listFolders = useAction(api.granolaActions.folders);
  const setFolders = useMutation(api.granola.setFolders);
  const [options, setOptions] = useState<Array<{ id: string; name: string; parentId: string | null }> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const names = new Map((options ?? []).map((f) => [f.id, f.name]));
  const label = (f: { id: string; name: string; parentId: string | null }) => {
    const parent = f.parentId ? names.get(f.parentId) : null;
    return parent ? `${parent} / ${f.name}` : f.name;
  };

  return (
    <div className="text-sm" data-testid="granola-folders">
      {options === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{chosen.length ? chosen.map((f) => f.name).join(", ") : "All meetings"}</span>
          <button type="button" disabled={busy || rescoping} className={OUTLINE}
            onClick={() => void run(async () => {
              setOptions(await listFolders({}));
              setPicked(new Set(chosen.map((f) => f.id)));
            })}>
            {busy ? "Loading…" : "Choose"}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border/70 p-3">
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">This Granola key sees no folders. Create one in Granola and file the meetings for this workspace in it.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {options.map((f) => (
                <li key={f.id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={picked.has(f.id)} disabled={busy}
                      onChange={() => setPicked((p) => {
                        const next = new Set(p);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })} />
                    {label(f)}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">None ticked imports every meeting. Folders include subfolders.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy}
              className={PRIMARY}
              onClick={() => {
                const folders = options.filter((f) => picked.has(f.id)).map((f) => ({ id: f.id, name: label(f) }));
                const changed = JSON.stringify(folders.map((f) => f.id).sort()) !== JSON.stringify(chosen.map((f) => f.id).sort());
                const meetings = imported >= 1000 ? "1,000+ meetings" : `${imported} ${imported === 1 ? "meeting" : "meetings"}`;
                if (changed && imported && !window.confirm(`Change Granola folders? This deletes the ${meetings} imported so far (their transcripts, insights, suggestions and timeline entries) and imports your lookback window again from ${folders.length ? "the chosen folders" : "all your meetings"}. Companies, people and deals stay.`)) return;
                void run(async () => {
                  const r = await setFolders({ folders });
                  setOptions(null);
                  void toast.success(r.rescoping ? "Switching folders: re-importing in a few minutes" : "Folders saved");
                });
              }}>
              Save
            </button>
            <button type="button" disabled={busy} className={OUTLINE} onClick={() => setOptions(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
