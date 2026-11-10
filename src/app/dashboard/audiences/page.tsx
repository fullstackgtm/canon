"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Copy, Download, Filter, Lock, Pencil, Send, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { SEQUENCER_IDS, SEQUENCERS, targetLabel, type SequencerId } from "../../../../convex/lib/outbound/sequencers";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { downloadCsv } from "@/components/records/audience-actions";
import { toast } from "@/lib/toast";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

type Summary = { total: number; withEmail: number; customVariables: string[]; computedAt: number };
type PushPreview = { total: number; toSend: number; skippedNoEmail: number; skippedDuplicate: number; alreadySent: number; skippedUnfit: number; skippedSuppressed?: number };
type Campaign = { id: string; name: string };
const SEQUENCER_NAMES = SEQUENCER_IDS.map((id) => SEQUENCERS[id].label).join(", ").replace(/, ([^,]+)$/, " or $1");
type Listed = NonNullable<ReturnType<typeof useQuery<typeof api.audiences.list>>>[number];

/** Yours first, then the team's shared ones, then (admins and managers only) each rep's own. */
function sectionsOf(audiences: Listed[]): Array<{ label: string; items: Listed[] }> {
  const mine = audiences.filter((a) => a.mine !== false);
  const shared = audiences.filter((a) => a.mine === false && a.shared !== false);
  const reps = audiences.filter((a) => a.mine === false && a.shared === false);
  return [
    { label: "Yours", items: mine },
    { label: "Shared with the team", items: shared },
    { label: "Reps' audiences", items: reps },
  ].filter((s) => s.items.length > 0);
}

export default function AudiencesPage() {
  const audiences = useQuery(api.audiences.list);
  const [url, setUrl] = useUrlState({ audience: "" });
  const current = audiences?.find((a) => a._id === url.audience) ?? audiences?.[0] ?? null;

  return (
    <ViewFrame
      title="Audiences"
      description={`A saved set of contacts for outbound. Build one from a contacts view, export it as CSV, or push it to a ${SEQUENCER_NAMES} campaign. Custom fields travel with each contact. Your audiences are yours until you share them with the team; admins and managers see everyone's.`}
      actions={[{ id: "audiences-build", label: "Build from contacts", href: "/dashboard/records/contact", icon: <Send className="size-3.5" />, primary: true }]}
    >
      {audiences === undefined ? (
        <LoadingRows />
      ) : audiences.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No audiences yet"
          description="Filter your contacts, then choose Save as audience. Its members are read again each time you export or push."
          action={{ label: "Open contacts", href: "/dashboard/records/contact" }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
          <nav className="flex flex-col gap-4" aria-label="Audiences">
            {sectionsOf(audiences).map((section) => (
              <div key={section.label}>
                <h2 className="mb-1 text-xs font-medium text-muted-foreground">{section.label}</h2>
                <ul className="flex flex-col gap-1">
                  {section.items.map((a) => (
                    <li key={a._id}>
                      <button
                        type="button"
                        onClick={() => setUrl({ audience: a._id })}
                        className={cn("w-full border border-border px-3 py-2 text-left text-sm hover:bg-muted", current?._id === a._id && "bg-muted font-medium")}
                      >
                        {a.name}
                        <span className="block text-xs text-muted-foreground">
                          {a.mine === false ? `${a.ownerName} · ` : a.shared ? "Shared · " : ""}
                          {a.lastSentAt ? `Last used ${new Date(a.lastSentAt).toLocaleDateString()}` : "Not used yet"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          {current && <AudienceDetail key={current._id} audience={current} />}
        </div>
      )}
    </ViewFrame>
  );
}

function AudienceDetail({ audience }: { audience: Listed }) {
  const { _id: id, name } = audience;
  const summary: Summary | undefined = audience.summary;
  const canEdit = audience.canEdit !== false;
  const preview = useAction(api.audienceActions.preview);
  const exportCsv = useAction(api.audienceActions.exportCsv);
  const loadCampaigns = useAction(api.audienceActions.campaigns);
  const push = useAction(api.audienceActions.push);
  const update = useMutation(api.audiences.update);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sequencers = useQuery(api.audiences.sequencerStatus);
  const connected = SEQUENCER_IDS.filter((p) => sequencers?.[p]?.connected);
  const [chosen, setChosen] = useState<SequencerId | null>(null);
  const provider = chosen && connected.includes(chosen) ? chosen : (connected[0] ?? null);
  const label = provider ? SEQUENCERS[provider].label : "";
  const history = useQuery(api.audiences.history, { audienceId: id });
  const [error, setError] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [pushPreview, setPushPreview] = useState<PushPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (campaign: string) => {
    try {
      setError("");
      if (!provider) return;
      const next = await preview({ audienceId: id, campaignId: campaign, provider });
      setPushPreview(next.push);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, [preview, id, provider]);

  useEffect(() => {
    if (!provider) return;
    let live = true;
    setCampaigns(null);
    setCampaignId("");
    setPushPreview(null);
    loadCampaigns({ provider }).then((list) => live && setCampaigns(list), (cause) => void toast.error(getErrorMessage(cause)));
    return () => { live = false; };
  }, [provider, loadCampaigns]);

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const editHref = `/dashboard/records/contact?audience=${id}`;
  const campaignName = campaigns?.find((c) => c.id === campaignId)?.name ?? campaignId;

  return (
    <section className="border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renaming === null ? (
          <h2 className="text-lg font-semibold">{name}</h2>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void guarded(async () => {
                await update({ audienceId: id, name: renaming });
                setRenaming(null);
              });
            }}
          >
            <input autoFocus aria-label="Audience name" value={renaming} onChange={(e) => setRenaming(e.target.value)} className="border border-border bg-background px-2 py-1 text-sm" />
            <button type="submit" disabled={busy || !renaming.trim()} className={btn}>Save</button>
            <button type="button" onClick={() => setRenaming(null)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </form>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && renaming === null && <button type="button" className={btn} onClick={() => setRenaming(name)}><Pencil className="h-3 w-3" /> Rename</button>}
          {canEdit && audience.shared !== undefined && (
            <button
              type="button"
              disabled={busy}
              className={btn}
              title={audience.shared ? "Only its creator, admins and managers will see it" : "Everyone in the workspace will see it and can use it"}
              onClick={() => void guarded(async () => {
                await update({ audienceId: id, shared: !audience.shared });
                void toast.success(audience.shared ? `${name} is private again` : `${name} is shared with the team`);
              })}
            >
              {audience.shared ? <><Lock className="h-3 w-3" /> Make private</> : <><Users className="h-3 w-3" /> {audience.mine === false ? "Promote to team" : "Share with team"}</>}
            </button>
          )}
          <Link className={btn} href={editHref}>{canEdit ? <><Filter className="h-3 w-3" /> Edit filter</> : <><Copy className="h-3 w-3" /> Copy as mine</>}</Link>
          <button
            type="button"
            disabled={busy || Boolean(error)}
            className={btn}
            onClick={() => void guarded(async () => {
              const { csv, count } = await exportCsv({ audienceId: id });
              downloadCsv(`${name.replace(/[^\w-]+/g, "-").toLowerCase() || "audience"}.csv`, csv);
              void toast.success(`Exported ${count} contacts`);
            })}
          >
            <Download className="h-3 w-3" /> Export CSV
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-destructive">
          {error} <Link className="underline underline-offset-2" href={editHref}>Edit the filter</Link>
        </p>
      ) : !summary ? (
        <p className="mt-3 text-sm text-muted-foreground">Audience summary pending background refresh. You can still export current contacts.</p>
      ) : (
        <p className="mt-3 text-sm" data-testid="audience-summary">
          {summary.total.toLocaleString()} contacts, {summary.withEmail.toLocaleString()} with an email.
          {summary.customVariables.length > 0 && <> Custom variables sent: {summary.customVariables.join(", ")}.</>}
          <span className="block text-xs text-muted-foreground">Updated {new Date(summary.computedAt).toLocaleString()}. Refreshed every 15 minutes. Exports and pushes use current contacts.</span>
        </p>
      )}

      <h3 className="mt-6 text-xs font-medium text-muted-foreground">Push to a campaign</h3>
      {sequencers === undefined ? null : !provider ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No sequencer is connected. Connect {SEQUENCER_NAMES} under <Link className="underline" href="/dashboard/integrations">Integrations</Link>.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {connected.length > 1 && (
              <SelectField
                aria-label="Sequencer"
                value={provider}
                onValueChange={(v) => setChosen(v as SequencerId)}
                options={connected.map((p) => ({ value: p, label: SEQUENCERS[p].label }))}
              />
            )}
            <SelectField
              aria-label={`${label} campaign`}
              value={campaignId}
              onValueChange={(v) => { setCampaignId(v); setPushPreview(null); if (v) void refresh(v); }}
              options={[
                { value: "", label: campaigns === null ? "Loading campaigns…" : "Choose a campaign" },
                ...(campaigns ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
          {pushPreview && (
            <div className="border border-border bg-muted/40 p-3 text-sm" data-testid="push-preview">
              <p>
                <strong>{pushPreview.toSend}</strong> to send to {campaignName}. Skipped: {pushPreview.skippedNoEmail} without an email
                {(pushPreview.skippedSuppressed ?? 0) > 0 && <>, {pushPreview.skippedSuppressed} do not contact</>}
                {pushPreview.skippedDuplicate > 0 && <>, {pushPreview.skippedDuplicate} sharing an email</>}
                {pushPreview.alreadySent > 0 && <>, {pushPreview.alreadySent} already sent</>}
                {pushPreview.skippedUnfit > 0 && <>, {pushPreview.skippedUnfit} with {SEQUENCERS[provider].requires?.reason ?? "fields it refuses"}</>}.
              </p>
              <button
                type="button"
                disabled={busy || pushPreview.toSend === 0}
                className={cn(btn, "mt-3 bg-primary text-primary-foreground hover:bg-primary/85")}
                onClick={() => void guarded(async () => {
                  const r = await push({ audienceId: id, campaignId, expectToSend: pushPreview.toSend, provider });
                  void toast.success(`Sent ${r.sent} to ${label}${r.rejected ? `; ${label} skipped ${r.rejected}` : ""}`);
                  await refresh(campaignId);
                })}
              >
                <Send className="h-3 w-3" /> Push {pushPreview.toSend} to {label}
              </button>
            </div>
          )}
        </div>
      )}

      <h3 className="mt-6 text-xs font-medium text-muted-foreground">History</h3>
      {history === undefined ? null : history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing exported or pushed yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {history.map((h) => (
            <li key={`${h.target}@${h.at}`}>
              {new Date(h.at).toLocaleString()}: {h.target === "csv" ? `exported ${h.exported} to CSV` : `sent ${h.sent} to ${targetLabel(h.target) ?? h.target}`}
              {h.skipped > 0 && `, ${h.skipped} skipped`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
