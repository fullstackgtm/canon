"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Inbox, Scale, X } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ActorView } from "../../../../convex/agents";
import type { FactDecider } from "../../../../convex/lib/canon/decider";
import { EmptyState, LoadingRows, ViewFrame, SelectionBar, StatusBadge } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getErrorMessage } from "@/lib/utils";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { attributeLabel, factValueText } from "@/components/crm/fact-format";

type EntityType = "opportunity" | "account" | "contact";
const OBJECT_OF: Record<EntityType, string> = { opportunity: "deal", account: "account", contact: "contact" };
/** Each entity type named as the workspace calls its object. */
function useEntityNames() {
  const names = useObjectLabels();
  return (t: EntityType) => names(OBJECT_OF[t]) ?? { label: t, pluralLabel: t };
}

const label = attributeLabel;
const show = factValueText;
/** Who proposed a fact: a verified agent and its accountable owner, or a person and the tool they named. */
function actorText(a: ActorView): string {
  switch (a.kind) {
    case "agent": return a.ownerName ? `${a.label} · owned by ${a.ownerName}` : a.label;
    case "user": return a.via ? `${a.name} via ${a.via}` : a.name;
    case "integration": return a.id;
    case "legacy": return a.label;
  }
}
const DECIDER_TEXT: Record<FactDecider["kind"], string> = { user: "a reviewer", rule: "auto-accept rule", grant: "an agent's standing grant", unrecorded: "an unrecorded decider" };
const when = (t: number | null | undefined) => (t ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(t) : "—");

type Receipt = { entityId: Id<"canonEntities">; label: string; attribute: string } | null;

function ReceiptDrawer({ target, onClose }: { target: Receipt; onClose: () => void }) {
  const data = useScopedQuery(api.canonGate.entityReceipts, api.canonGate.entityReceiptsScoped, target ? { entityId: target.entityId, attribute: target.attribute } : "skip");
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{target ? `${target.label} · ${label(target.attribute)}` : ""}</SheetTitle>
          <SheetDescription>
            {data?.state ? <>Canonical value <strong>{show(data.state.value)}</strong> from {data.state.sourceKind ?? "—"} ({data.state.state})</> : "Every fact behind this field, newest first."}
          </SheetDescription>
        </SheetHeader>
        <ol className="mt-4 space-y-3 px-4 pb-6">
          {data === undefined && <LoadingRows />}
          {data?.facts.map((f) => (
            <li key={f.factId} className={`rounded-md border p-3 text-sm ${data.state?.factId === f.factId ? "border-primary" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{show(f.value)}</span>
                <StatusBadge status={f.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {f.sourceKind} · {actorText(f.actor)} · learned {when(f.observedAt)}
                {f.validFrom ? ` · true since ${when(f.validFrom)}` : ""}
                {f.lastConfirmedAt > f.observedAt ? ` · re-confirmed ${when(f.lastConfirmedAt)}` : ""}
              </div>
              {f.evidence && <blockquote className="mt-2 border-l-2 pl-2 text-xs">{f.evidence}</blockquote>}
              <div className="mt-1 text-xs text-muted-foreground">
                confidence {f.confidence.toFixed(2)}
                {f.verification ? ` · ${f.verification.kind === "read" ? "Jev read" : "Jev check"} ${f.verification.score.toFixed(2)}` : ""}
                {f.decider ? ` · decided by ${DECIDER_TEXT[f.decider.kind]} ${when(f.decidedAt)}` : ""}
              </div>
            </li>
          ))}
          {data && !data.facts.length && <li className="text-sm text-muted-foreground">No facts recorded for this field yet.</li>}
        </ol>
      </SheetContent>
    </Sheet>
  );
}

type Queue = NonNullable<ReturnType<typeof useQuery<typeof api.canonGate.reviewQueue>>>;

function ProposedTab({ rows, canReview, focus, onReceipt, onDecided }: {
  rows: Queue["proposed"];
  /** A fact a link opened the queue at (`?fact=`): marked and scrolled to. */
  focus: string | null;
  canReview: boolean;
  onReceipt: (r: Receipt) => void;
  onDecided: () => void;
}) {
  const entity = useEntityNames();
  // Through the action, which admits the facts' companies and people for a role that sees only some (CP14).
  const decide = useAction(api.canonGate.decideScoped);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (status: "accepted" | "rejected", ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await decide({ decisions: ids.map((factId) => ({ factId: factId as Id<"facts">, status })) });
      setSelected(new Set());
      onDecided();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (focus) document.getElementById(`fact-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, rows.length]);
  if (!rows.length) return <EmptyState icon={Inbox} title="Nothing to review" description="Proposed changes appear here before becoming current values." />;
  const ids = [...selected];
  return (
    <div className="space-y-3">
      {canReview && (
        <SelectionBar count={ids.length} onClear={() => setSelected(new Set())}>
          <Button size="sm" disabled={busy || !ids.length} onClick={() => run("accepted", ids)}><Check className="mr-1 h-4 w-4" />Accept {ids.length || ""}</Button>
          <Button size="sm" variant="outline" disabled={busy || !ids.length} onClick={() => run("rejected", ids)}><X className="mr-1 h-4 w-4" />Reject {ids.length || ""}</Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </SelectionBar>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            <tr>
              {canReview && <th className="w-8 p-2" />}
              <th className="p-2">Record · field</th><th className="p-2">Now</th><th className="p-2">Proposed</th>
              <th className="p-2">Source</th><th className="p-2">Evidence</th><th className="p-2">Check</th>
              {canReview && <th className="p-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.factId} id={`fact-${r.factId}`} className={r.factId === focus ? "border-t align-top bg-primary/5" : "border-t align-top"}>
                {canReview && (
                  <td className="p-2">
                    <input type="checkbox" aria-label="Select fact" checked={selected.has(r.factId)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.factId); else n.delete(r.factId); return n; })} />
                  </td>
                )}
                <td className="p-2">
                  <button className="text-left underline-offset-2 hover:underline" onClick={() => onReceipt({ entityId: r.entityId, label: r.label, attribute: r.attribute })}>
                    {r.label} · <span className="text-muted-foreground">{label(r.attribute)}</span>
                  </button>
                  <div className="text-xs text-muted-foreground">{entity(r.entityType).label}</div>
                </td>
                <td className="p-2 text-muted-foreground">{show(r.currentValue)}</td>
                <td className="p-2 font-medium">{show(r.value)}</td>
                <td className="p-2 text-xs">{r.sourceKind}<div className="text-muted-foreground">{actorText(r.actor)}</div></td>
                <td className="max-w-xs p-2 text-xs">{r.evidence ?? <span className="text-muted-foreground">none</span>}</td>
                <td className="p-2 text-xs">{r.verification ? r.verification.score.toFixed(2) : "—"}</td>
                {canReview && (
                  <td className="whitespace-nowrap p-2">
                    <Button size="sm" variant="ghost" disabled={busy} aria-label="Accept" onClick={() => run("accepted", [r.factId])}><Check className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" disabled={busy} aria-label="Reject" onClick={() => run("rejected", [r.factId])}><X className="h-4 w-4" /></Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContestedTab({ rows, canReview, onReceipt, onDecided }: {
  rows: Queue["contested"];
  canReview: boolean;
  onReceipt: (r: Receipt) => void;
  onDecided: () => void;
}) {
  const entity = useEntityNames();
  const resolve = useAction(api.canonGate.resolveContestedScoped);
  const [error, setError] = useState<string | null>(null);
  if (!rows.length) return <EmptyState icon={Scale} title="No contested fields" description="A field is contested when peer sources disagree within 30 days." />;
  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows.map((r) => (
        <div key={`${r.entityId}:${r.attribute}`} className="rounded-md border p-3">
          <button className="text-sm font-medium underline-offset-2 hover:underline"
            onClick={() => onReceipt({ entityId: r.entityId, label: r.label, attribute: r.attribute })}>
            {r.label} · {label(r.attribute)} <span className="text-xs font-normal text-muted-foreground">({entity(r.entityType).label.toLowerCase()})</span>
          </button>
          <ul className="mt-2 space-y-1 text-sm">
            {r.options.map((o) => (
              <li key={o.factId} className="flex items-center justify-between gap-2">
                <span>{show(o.value)} <span className="text-xs text-muted-foreground">from {o.sourceKind} · {when(o.validFrom ?? o.observedAt)}{o.winner ? " · current" : ""}</span></span>
                {canReview && (
                  <Button size="sm" variant="outline" onClick={() => resolve({ factId: o.factId }).then(onDecided, (e) => setError(getErrorMessage(e)))}>Use this</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function GateTab() {
  const entity = useEntityNames();
  const [entityType, setEntityType] = useState<EntityType>("opportunity");
  const settings = useQuery(api.canonGate.settings, { entityType });
  const setOwnership = useMutation(api.canonGate.setOwnership);
  const setRule = useMutation(api.canonGate.setAutoAcceptRule);
  const [error, setError] = useState<string | null>(null);
  if (settings === undefined) return <LoadingRows />;
  if (!settings) return null;
  const agentRows = settings.grid.filter((r) => ["agent_run", "enrichment", "call", "email", "linkedin", "pipeline"].includes(r.sourceKind));
  const rule = (k: string, a: string) => settings.rules.find((r) => r.sourceKind === k && r.attribute === a);
  const guard = (p: Promise<unknown>) => p.catch((e) => setError(getErrorMessage(e)));
  const noun = entity(entityType).label.toLowerCase();
  return (
    <div className="space-y-6">
      <div className="flex gap-1" role="group" aria-label="Record type">
        {(Object.keys(OBJECT_OF) as EntityType[]).map((t) => (
          <Button key={t} size="sm" variant={t === entityType ? "default" : "outline"} onClick={() => setEntityType(t)}>{entity(t).pluralLabel}</Button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <section>
        <h3 className="font-medium">Field ownership</h3>
        <p className="mb-2 text-sm text-muted-foreground">Which source may write which {noun} field. Facts for fields a source does not own are rejected when submitted. CRMs, imports and people may write every field.</p>
        <div className="overflow-x-auto rounded-md border">
          <table className="text-xs">
            <thead><tr><th className="p-2 text-left">Source</th>{settings.attributes.map((a) => <th key={a} className="p-2">{label(a)}</th>)}</tr></thead>
            <tbody>
              {agentRows.map((row) => (
                <tr key={row.sourceKind} className="border-t">
                  <td className="p-2 font-medium">{row.sourceKind}</td>
                  {row.cells.map((c) => (
                    <td key={c.attribute} className="p-2 text-center">
                      <input type="checkbox" aria-label={`${row.sourceKind} may write ${c.attribute}`} checked={c.allowed} disabled={!settings.canEdit}
                        className={c.overridden ? "accent-amber-600" : undefined}
                        onChange={(e) => guard(setOwnership({ sourceKind: row.sourceKind, attribute: c.attribute, allowed: e.target.checked, entityType }))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="font-medium">Auto-accept</h3>
        <p className="mb-2 text-sm text-muted-foreground">Off by default. A rule accepts a proposed fact only when it has evidence and an independent Jev check of the value against that evidence scores at or above the threshold. Past reviewer decisions are shown to help set it.</p>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground"><tr><th className="p-2">Source · field</th><th className="p-2">Reviewed</th><th className="p-2">Threshold</th><th className="p-2">On</th></tr></thead>
            <tbody>
              {agentRows.flatMap((row) => row.cells.filter((c) => c.allowed).map((c) => {
                const r = rule(row.sourceKind, c.attribute);
                const h = settings.history[`${row.sourceKind}:${c.attribute}`];
                return (
                  <tr key={`${entityType}:${row.sourceKind}:${c.attribute}`} className="border-t">
                    <td className="p-2">{row.sourceKind} · {label(c.attribute)}</td>
                    <td className="p-2 text-xs text-muted-foreground">{h ? `${h.accepted} accepted / ${h.rejected} rejected` : "—"}</td>
                    <td className="p-2">
                      <input type="number" min={0.5} max={1} step={0.05} defaultValue={r?.minConfidence ?? 0.9} disabled={!settings.canEdit} className="w-20 rounded border px-1"
                        onBlur={(e) => Number(e.target.value) !== (r?.minConfidence ?? 0.9) && guard(setRule({ sourceKind: row.sourceKind as "agent_run", attribute: c.attribute, minConfidence: Number(e.target.value), enabled: r?.enabled ?? false, entityType }))} />
                    </td>
                    <td className="p-2">
                      <input type="checkbox" aria-label="Auto-accept" checked={r?.enabled ?? false} disabled={!settings.canEdit}
                        onChange={(e) => guard(setRule({ sourceKind: row.sourceKind as "agent_run", attribute: c.attribute, minConfidence: r?.minConfidence ?? 0.9, enabled: e.target.checked, entityType }))} />
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function FactReviewPage() {
  // A reviewer who sees only some companies or people reads the queue through its action twin (CP14); a decision reads it again.
  const [decided, setDecided] = useState(0);
  const focus = useSearchParams().get("fact");
  const queue = useScopedQuery(api.canonGate.reviewQueue, api.canonGate.reviewQueueScoped, {}, decided);
  const onDecided = () => setDecided((n) => n + 1);
  const [tab, setTab] = useState("proposed");
  const [receipt, setReceipt] = useState<Receipt>(null);
  const counts = useMemo(() => ({ proposed: queue?.proposed.length ?? 0, contested: queue?.contested.length ?? 0 }), [queue]);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <ViewFrame title="Review" description="Compare proposed changes with current values and their evidence." actions={[
        { id: "review-refresh", label: "Refresh", onClick: onDecided },
      ]} controls={<TabsList>
            <TabsTrigger value="proposed">Proposed ({counts.proposed})</TabsTrigger>
            <TabsTrigger value="contested">Contested ({counts.contested})</TabsTrigger>
            <TabsTrigger value="gate">Write gate</TabsTrigger>
          </TabsList>}>
      {queue === undefined ? <LoadingRows /> : !queue ? null : (
        <div>

          <TabsContent value="proposed" className="mt-4"><ProposedTab rows={queue.proposed} focus={focus} canReview={queue.canReview} onReceipt={setReceipt} onDecided={onDecided} /></TabsContent>
          <TabsContent value="contested" className="mt-4"><ContestedTab rows={queue.contested} canReview={queue.canReview} onReceipt={setReceipt} onDecided={onDecided} /></TabsContent>
          <TabsContent value="gate" className="mt-4"><GateTab /></TabsContent>
        </div>
      )}
      <ReceiptDrawer target={receipt} onClose={() => setReceipt(null)} />
      </ViewFrame>
    </Tabs>
  );
}
