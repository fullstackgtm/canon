"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDown, ChevronRight, GripVertical, Loader2, MoreHorizontal, Plus, Star, Target } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { parseQuery, type NodeKind } from "../../../../modules/kernel/icpQuery";
import { treeMoveError } from "../../../../modules/kernel/icpTreeMove";
import type { IcpTreeCounts } from "../../../../convex/lib/recordContract";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { AddRecordsDialog } from "@/components/crm/add-records-dialog";
import { label } from "@/components/crm/icp-fields";
import { WinnersCheck } from "@/components/icps/winners-check";
import { MarketSources } from "@/components/icps/market-sources";
import { MapMyMarket } from "@/components/icps/map-my-market";
import { IcpMap } from "@/components/icps/icp-map";
import { IcpViewer } from "@/components/icps/icp-viewer";
import { IcpSentence } from "@/components/icps/icp-sentence";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { AiField } from "../../../../modules/kernel/icpSentence";
import { toast } from "@/lib/toast";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "w-full border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary";

type Tree = NonNullable<FunctionReturnType<typeof api.icpTree.list>>;
type Icp = Tree["icps"][number];
type Row = {
  id: string; kind: NodeKind; parent: string | null; icp: Icp; nodeId?: Id<"icpNodes">;
  name: string; query: string; on: boolean; role?: string; pointOfView?: string; offer?: string;
};
const ICON: Record<NodeKind, string> = { icp: "■", segment: "▣", persona: "●" };
const KIND: Record<NodeKind, string> = { icp: "ICP", segment: "Segment", persona: "Persona" };

function rowsOf(tree: Tree): Row[] {
  const icps = new Map(tree.icps.map((i) => [i._id as string, i]));
  return [
    ...tree.icps.map((i): Row => ({ id: i._id, kind: "icp", parent: null, icp: i, name: i.name, query: i.query, on: i.active, pointOfView: i.pointOfView, offer: i.offer })),
    ...tree.nodes.flatMap((n): Row[] => {
      const icp = icps.get(n.icpId);
      return icp ? [{ id: n._id, kind: n.kind, parent: n.parentId ?? n.icpId, icp, nodeId: n._id, name: n.name, query: n.query, on: icp.active, role: n.role, pointOfView: n.pointOfView, offer: n.offer }] : [];
    }),
  ];
}

/** Every row's counts, read again a moment after the tree changes (icpTree.counts). Null when the record service can't count trees. */
function useCounts(key: string): IcpTreeCounts | null | undefined {
  const run = useAction(api.icpTree.counts);
  const [counts, setCounts] = useState<IcpTreeCounts | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => run({}).then((r) => live && setCounts(r), () => live && setCounts(null)), 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, run]);
  return counts;
}

/** Each ICP's market (companies that exist for its industries, countries and sizes), from the shared cache. */
function useMarkets(key: string): Record<string, number | null> {
  const load = useAction(api.icps.sizes);
  const [markets, setMarkets] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => load({}).then((r) => live && setMarkets(Object.fromEntries(Object.entries(r).map(([id, s]) => [id, s.market]))), () => undefined), 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, load]);
  return markets;
}

const approx = (n: number) => (n >= 10_000 ? `~${Math.round(n / 1000)}k` : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);

export default function IcpsPage() {
  const names = useObjectLabels();
  const tree = useQuery(api.icpTree.list);
  const fields = (useQuery(api.researchAgents.list)?.agents.filter((a) => a.entityType === "account") ?? []) as AiField[];
  // `icp` is the older link (recipe templates before #484): it selects the same way.
  const [url, setUrl] = useUrlState({ sel: "", icp: "" });
  const [hovered, setHovered] = useState<string | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const updateNode = useMutation(api.icpTree.updateNode);
  const rows = useMemo(() => (tree ? rowsOf(tree) : []), [tree]);
  const countsKey = JSON.stringify(rows.map((r) => [r.id, r.parent, r.query, r.on]));
  const counts = useCounts(countsKey);
  const markets = useMarkets(JSON.stringify(rows.filter((r) => r.kind === "icp").map((r) => [r.id, r.query])));
  const byId = new Map((counts?.nodes ?? []).map((n) => [n.id, n]));
  const selected = rows.find((r) => r.id === (url.sel || url.icp)) ?? rows[0] ?? null;

  const move = async (source: Row, target: Row) => {
    if (!tree?.canEdit || moving || treeMoveError(rows, source.id, target.id)) return;
    setMoving(true);
    try {
      await updateNode({ nodeId: source.nodeId!, parentId: target.nodeId ?? null });
      setClosed((c) => ({ ...c, [target.id]: false }));
      setUrl({ sel: source.id, icp: "" });
    } catch (e) {
      void toast.error(getErrorMessage(e));
    } finally {
      setMoving(false);
      setDragged(null);
      setDropTarget(null);
    }
  };
  const ordered: Array<[Row, number, boolean?]> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of rows.filter((x) => x.parent === parent)) {
      ordered.push([r, depth]);
      if (!closed[r.id]) {
        walk(r.id, depth + 1);
        if (tree?.canEdit && r.kind !== "persona" && depth < 4) ordered.push([r, depth + 1, true]);
      }
    }
  };
  walk(null, 0);

  return (
    <ViewFrame title="ICPs" description="Each ICP is the companies you sell to and who buys there. Segments narrow its accounts; personas are the people to reach inside them."
      secondaryActions={tree?.canEdit ? <NewIcp onCreated={(id) => setUrl({ sel: id, icp: "" })} /> : undefined}>
      {tree?.moduleOwned && <p className="mb-4 text-sm text-muted-foreground">ICPs are managed in the ICPs module. This compatibility page is read-only.</p>}
      {tree === undefined ? (
        <LoadingRows />
      ) : tree === null ? null : rows.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No ICPs yet"
          description={tree.canEdit ? "Start one, derive one from a website, or save the ICP your signup research found." : "An admin or manager can add the workspace's ICPs."}
        />
      ) : null}
      {tree && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={cn(label, "px-2 py-2 font-normal")}>Name</th>
                  <th className={cn(label, "px-2 py-2 font-normal")}>Definition</th>
                  <th className={cn(label, "px-2 py-2 text-right font-normal")}>{names("account")!.pluralLabel}</th>
                  <th className={cn(label, "px-2 py-2 text-right font-normal")}>{names("contact")!.pluralLabel}</th>
                  <th className={cn(label, "px-2 py-2 font-normal")}>On</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ordered.map(([r, depth, ghost]) => ghost ? (
                  <AddRows key={`${r.id}-add`} row={r} depth={depth} onCreated={(id) => setUrl({ sel: id, icp: "" })} />
                ) : (
                  <TreeRow
                    key={r.id} row={r} depth={depth} rows={rows} showQuery={tree.canViewQuery} canEdit={tree.canEdit}
                    selected={selected?.id === r.id} closed={Boolean(closed[r.id])}
                    moving={moving} dropTarget={dropTarget === r.id}
                    onMove={(target) => void move(r, target)}
                    onDragStart={() => setDragged(r.id)} onDragEnd={() => { setDragged(null); setDropTarget(null); }}
                    onDragOver={(e) => {
                      if (!tree.canEdit || moving || !dragged || treeMoveError(rows, dragged, r.id)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDropTarget(r.id);
                    }}
                    onDragLeave={() => setDropTarget((id) => id === r.id ? null : id)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const source = rows.find((row) => row.id === dragged);
                      setDragged(null);
                      setDropTarget(null);
                      if (source) void move(source, r);
                    }}
                    count={byId.get(r.id)} people={r.kind === "persona" ? byId.get(r.id)?.people : undefined}
                    onSelect={() => setUrl({ sel: r.id, icp: "" })} onHover={(on) => setHovered(on ? r.id : null)}
                    onToggle={() => setClosed((c) => ({ ...c, [r.id]: !c[r.id] }))} onCreated={(id) => setUrl({ sel: id, icp: "" })} onDeleted={() => setUrl({ sel: "", icp: "" })}
                  />
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">■ ICP · ▣ segment (narrower accounts) · ● persona (people to reach). A persona&apos;s accounts are those with at least one of its people. {tree.canEdit && "Drag a handle onto an ICP or segment to nest the row, or use its Move to menu. Personas are leaves; nesting is limited to four levels within an ICP."}</p>
          </div>
          <aside className="grid content-start gap-4 border border-border p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-auto">
            {counts === null ? (
              <p className="text-xs text-muted-foreground">The map needs the record service&apos;s ICP tree counts (1.31.0); they arrive with its next deploy.</p>
            ) : counts === undefined ? (
              <LoadingRows count={1} height="h-56" />
            ) : (
              <IcpMap nodes={rows} counts={counts} selected={selected?.id ?? null} hovered={hovered} onSelect={(id) => setUrl({ sel: id, icp: "" })} />
            )}
            {selected && <Focus row={selected} rows={rows} counts={counts ?? null} market={markets[selected.icp._id] ?? null} fields={fields} canEdit={tree.canEdit} onSelect={(id) => setUrl({ sel: id, icp: "" })} />}
          </aside>
        </div>
      )}
      {tree && <WinnersCheck key={countsKey} />}
      {tree && <MarketSources />}
      {tree && <MapMyMarket icpId={selected?.icp._id} />}
    </ViewFrame>
  );
}


/** Saves for a row, whichever table it lives in. */
function useRowSave() {
  const updateIcp = useMutation(api.icps.update);
  const updateNode = useMutation(api.icpTree.updateNode);
  return async (row: Row, patch: { name?: string; query?: string; pointOfView?: string; offer?: string; role?: string }) => {
    try {
      if (row.kind === "icp") {
        await updateIcp({ icpId: row.icp._id, name: patch.name, query: patch.query, pointOfView: patch.pointOfView, offer: patch.offer });
      } else await updateNode({ nodeId: row.nodeId!, ...patch });
      return true;
    } catch (e) {
      void toast.error(getErrorMessage(e));
      return false;
    }
  };
}

function TreeRow({ row, depth, rows, showQuery, canEdit, selected, closed, count, people, onSelect, onHover, onToggle, onCreated, onDeleted, moving, dropTarget, onMove, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: {
  row: Row; depth: number; rows: Row[]; showQuery: boolean; canEdit: boolean; selected: boolean; closed: boolean;
  count: { accounts: number } | undefined; people: number | undefined;
  moving: boolean; dropTarget: boolean; onMove: (target: Row) => void;
  onDragStart: () => void; onDragEnd: () => void; onDragOver: React.DragEventHandler; onDragLeave: () => void; onDrop: React.DragEventHandler;
  onSelect: () => void; onHover: (on: boolean) => void; onToggle: () => void; onCreated: (id: string) => void; onDeleted: () => void;
}) {
  const createNode = useMutation(api.icpTree.createNode);
  const updateIcp = useMutation(api.icps.update);
  const setActive = (on: boolean) => updateIcp({ icpId: row.icp._id, active: on }).then(
    () => void toast.success(on ? `${row.name} is on: fit scores are updating.` : `${row.name} is off: its accounts no longer score from it.`),
    (e) => void toast.error(getErrorMessage(e)),
  );
  const hasKids = rows.some((x) => x.parent === row.id) || (canEdit && row.kind !== "persona" && depth < 4);
  const add = (kind: "segment" | "persona") => createNode({
    icpId: row.icp._id, ...(row.kind === "segment" ? { parentId: row.nodeId } : {}), kind,
    name: kind === "segment" ? "New segment" : "New persona", query: kind === "segment" ? "" : "level:manager",
  }).then((id) => onCreated(id), (e) => void toast.error(getErrorMessage(e)));
  return (
    <tr
      onClick={onSelect} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      className={cn("group border-b border-border align-middle", selected && "bg-primary/5 shadow-[inset_2px_0_var(--primary)]", dropTarget && "bg-primary/10 outline outline-primary", !row.on && "opacity-60")}
    >
      <td className="whitespace-nowrap px-2 py-1.5" style={{ paddingLeft: 8 + depth * 22 }}>
        <span className="inline-flex items-center gap-1.5">
          {canEdit && row.nodeId && <span
            draggable={!moving} title={`Drag ${row.name} into an ICP or segment`} aria-label={`Drag ${row.name}`}
            onDragStart={(e) => { e.dataTransfer.setData("text/plain", row.id); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
            onDragEnd={onDragEnd} className="cursor-grab text-muted-foreground active:cursor-grabbing"
          ><GripVertical className="size-3" /></span>}
          {hasKids ? (
            <button type="button" aria-label={closed ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); onToggle(); }} className="text-muted-foreground">
              {closed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
          ) : <span className="w-3" />}
          <span className={cn("text-[11px]", row.kind === "icp" ? "text-foreground" : "text-primary")} aria-label={KIND[row.kind]}>{ICON[row.kind]}</span>
          {canEdit ? <NameInput key={row.name} row={row} /> : <span className="font-medium">{row.name}</span>}
          {row.kind === "icp" && row.icp.isDefault && <Star className="size-3 fill-current text-muted-foreground" aria-label="Default ICP" />}
        </span>
      </td>
      <td className="min-w-[200px] max-w-[340px] px-2 py-1.5 text-muted-foreground">
        <IcpViewer query={row.query} kind={row.kind} showQuery={showQuery} queryEditor={<QueryCell key={row.query} row={row} canEdit={canEdit} />} />
      </td>
      <td className={cn("px-2 py-1.5 text-right text-xs tabular-nums", row.kind === "persona" && "text-muted-foreground")}>{count ? count.accounts.toLocaleString() : "—"}</td>
      <td className="px-2 py-1.5 text-right text-xs tabular-nums">{row.kind === "persona" ? (people?.toLocaleString() ?? "—") : ""}</td>
      <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        {row.kind === "icp" && <Switch checked={row.on} disabled={!canEdit} onCheckedChange={(on) => void setActive(on)} aria-label={`${row.name} is active`} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
        {canEdit && <RowMenu row={row} onAdd={add} onCreated={onCreated} onDeleted={onDeleted} moveTargets={rows.filter((target) => !treeMoveError(rows, row.id, target.id))} onMove={onMove} moving={moving} />}
      </td>
    </tr>
  );
}

function AddRows({ row, depth, onCreated }: { row: Row; depth: number; onCreated: (id: string) => void }) {
  const createNode = useMutation(api.icpTree.createNode);
  const [busy, setBusy] = useState(false);
  const add = async (kind: "segment" | "persona") => {
    setBusy(true);
    try {
      const id = await createNode({
        icpId: row.icp._id, parentId: row.nodeId, kind,
        name: kind === "segment" ? "New segment" : "New persona",
        query: kind === "segment" ? "" : "level:manager",
      });
      onCreated(id);
    } catch (e) {
      void toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return <>{(["segment", "persona"] as const).map((kind) => (
    <tr key={kind} className="border-b border-dashed border-border text-muted-foreground">
      <td colSpan={6} style={{ paddingLeft: 8 + depth * 22 }}>
        <button type="button" disabled={busy} onClick={() => void add(kind)} aria-label={`Add ${kind} under ${row.name}`}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-muted hover:text-foreground disabled:opacity-50">
          <Plus className="size-3" /> Add {kind}
        </button>
      </td>
    </tr>
  ))}</>;
}

function NameInput({ row }: { row: Row }) {
  const save = useRowSave();
  const [name, setName] = useState(row.name);
  return (
    <input
      value={name} onChange={(e) => setName(e.target.value)} onClick={(e) => e.stopPropagation()}
      onBlur={() => { if (name.trim() && name !== row.name) void save(row, { name }); else setName(row.name); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      aria-label={`${KIND[row.kind]} name`} title={row.role ? `${row.name} (${row.role})` : undefined} className="w-36 border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-border focus:border-primary focus:outline-none"
    />
  );
}

/** A row's stored query, edited in place: it saves on Enter or when the field loses focus, once it parses. */
function QueryCell({ row, canEdit }: { row: Row; canEdit: boolean }) {
  const save = useRowSave();
  // Keyed by the stored query (TreeRow), so a save from elsewhere starts a fresh draft.
  const [draft, setDraft] = useState(row.query);
  const { errors } = parseQuery(draft, row.kind);
  const commit = () => {
    if (draft !== row.query && !errors.length) void save(row, { query: draft });
  };
  const prefix = row.kind === "persona" ? "reach(" : row.parent ? ">" : "";
  if (!canEdit) return <code className="text-xs">{prefix} {row.query}{row.kind === "persona" ? ")" : ""}</code>;
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className={cn("flex items-center border font-mono text-xs", errors.length ? "border-destructive" : "border-border focus-within:border-primary")}>
        {prefix && <span className="pl-2 text-primary">{prefix}</span>}
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} spellCheck={false} aria-label={`${row.name} query`}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(row.query); }}
          className="w-full min-w-0 bg-transparent px-2 py-1 outline-none"
        />
        {row.kind === "persona" && <span className="pr-2 text-primary">)</span>}
      </div>
      {errors.length > 0 && <p className="mt-0.5 text-[11px] text-destructive">{errors.join(" · ")}</p>}
    </div>
  );
}

function RowMenu({ row, onAdd, onCreated, onDeleted, moveTargets, onMove, moving }: { row: Row; onAdd: (kind: "segment" | "persona") => void; onCreated: (id: string) => void; onDeleted: () => void; moveTargets: Row[]; onMove: (target: Row) => void; moving: boolean }) {
  const router = useRouter();
  const setDefault = useMutation(api.icps.setDefault);
  const create = useMutation(api.icps.create);
  const remove = useMutation(api.icps.remove);
  const removeNode = useMutation(api.icpTree.removeNode);
  const createAudience = useMutation(api.audiences.createFromIcp);
  const [fill, setFill] = useState(false);
  const run = (fn: () => Promise<unknown>, done?: string) => fn().then(() => done && void toast.success(done), (e) => void toast.error(getErrorMessage(e)));
  const del = () => {
    const what = row.kind === "icp" ? `${row.name} and its segments and personas` : `${row.name}${row.kind === "segment" ? " and what sits under it" : ""}`;
    if (!window.confirm(`Delete ${what}?`)) return;
    void run(async () => { await (row.kind === "icp" ? remove({ icpId: row.icp._id }) : removeNode({ nodeId: row.nodeId! })); onDeleted(); }, "Deleted.");
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className={btn} aria-label={`${row.name} actions`}><MoreHorizontal className="size-3" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {row.kind !== "persona" && (
            <>
              <DropdownMenuItem onSelect={() => onAdd("segment")}>Add a segment<span className="ml-auto pl-4 text-xs text-muted-foreground">narrower accounts</span></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAdd("persona")}>Add a persona<span className="ml-auto pl-4 text-xs text-muted-foreground">people to reach</span></DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {row.kind === "icp" && (
            <>
              {row.on && <DropdownMenuItem asChild><Link href={`/dashboard/accounts?icp=${row.icp._id}`}>View accounts</Link></DropdownMenuItem>}
              {row.on && <DropdownMenuItem onSelect={() => void run(async () => router.push(`/dashboard/records/contact?audience=${await createAudience({ icpId: row.icp._id })}`), "Audience created. Narrow it, then save.")}>New audience</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setFill(true)}>Fill from this ICP</DropdownMenuItem>
              {!row.icp.isDefault && <DropdownMenuItem onSelect={() => void run(() => setDefault({ icpId: row.icp._id }), `${row.name} is the default.`)}>Make default</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void run(async () => onCreated(await create({ name: `${row.name} (copy)`, query: row.query, pointOfView: row.pointOfView, offer: row.offer })), "Duplicated. The copy is off until you switch it on.")}>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {moveTargets.map((target) => <DropdownMenuItem key={target.id} disabled={moving} onSelect={() => onMove(target)}>Move to {target.name}</DropdownMenuItem>)}
          <DropdownMenuItem onSelect={del} className="text-destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {fill && <AddRecordsDialog open={fill} onOpenChange={setFill} icpId={row.icp._id} />}
    </>
  );
}

/** New ICPs: blank, read from a website, or the signup research not saved yet. */
function NewIcp({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useMutation(api.icps.create);
  const derive = useAction(api.icpActions.deriveFromWebsite);
  const importResearch = useMutation(api.icps.importFromResearch);
  const research = useQuery(api.icps.list)?.research ?? null;
  const [website, setWebsite] = useState(false);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Id<"icps">>, done: string) => {
    setBusy(true);
    try {
      onCreated(await fn());
      void toast.success(done);
      setWebsite(false);
      setDomain("");
    } catch (e) {
      void toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className={btn} disabled={busy}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}New ICP</button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void run(() => create({ name: "New ICP", query: "" }), "Created. It is off until you switch it on.")}>Blank</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setWebsite(true)}>From a website…</DropdownMenuItem>
          {research && <DropdownMenuItem onSelect={() => void run(() => importResearch({}), "Saved your signup research's ICP.")}>From signup research ({research.domain})</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={website} onOpenChange={setWebsite}>
        <DialogContent>
          <DialogHeader><DialogTitle>Derive an ICP from a website</DialogTitle></DialogHeader>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) void run(async () => (await derive({ domain })).icpId, `Derived an ICP from ${domain.trim()}. It is off until you switch it on.`); }}>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" aria-label="Website" className={input} autoFocus />
            <button type="submit" disabled={busy || !domain.trim()} className={btn}>{busy && <Loader2 className="size-3 animate-spin" />}Derive</button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The selected row, in a few lines: what it is, its sentence to edit, its size, and which siblings share its accounts. */
function Focus({ row, rows, counts, market, fields, canEdit, onSelect }: {
  row: Row; rows: Row[]; counts: IcpTreeCounts | null; market: number | null; fields: AiField[]; canEdit: boolean; onSelect: (id: string) => void;
}) {
  const save = useRowSave();
  const c = counts?.nodes.find((n) => n.id === row.id);
  const siblings = rows.filter((x) => x.parent === row.parent && x.id !== row.id);
  const shared = siblings.map((s) => [s, counts?.overlaps.find((o) => (o.a === row.id && o.b === s.id) || (o.b === row.id && o.a === s.id))?.accounts ?? 0] as const).filter(([, n]) => n > 0);
  const size = !c ? null : row.kind === "persona" ? `${c.people.toLocaleString()} people at ${c.accounts.toLocaleString()} accounts` : `${c.accounts.toLocaleString()} accounts${row.kind === "icp" && market !== null ? ` · ${approx(market)} in the market` : ""}`;
  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-primary">{ICON[row.kind]}</span>
        <b className="font-display">{row.name}</b>
        {size && <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-primary">{size}</span>}
      </div>
      <IcpViewer kind={row.kind} query={row.query} />
      {canEdit && <details><summary className="cursor-pointer text-xs text-muted-foreground">Edit conditions</summary><IcpSentence kind={row.kind} query={row.query} fields={fields} onSave={(query) => void save(row, { query })} /></details>}
      {counts && siblings.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {shared.length ? (
            <>Shares {shared.map(([s, n], i) => (
              <Fragment key={s.id}>{i ? ", " : ""}<b className="tabular-nums text-foreground">{n.toLocaleString()}</b> with <button type="button" onClick={() => onSelect(s.id)} className="underline underline-offset-2 hover:text-foreground">{s.name}</button></Fragment>
            ))}</>
          ) : `No accounts shared with ${row.kind === "icp" ? "other ICPs" : "its siblings"}.`}
        </p>
      )}
      <Message row={row} canEdit={canEdit} />
    </div>
  );
}

/** What the seller says: a point of view (ICPs and segments), an offer (ICPs and personas), a persona's role. */
function Message({ row, canEdit }: { row: Row; canEdit: boolean }) {
  const save = useRowSave();
  const fieldsFor: Array<["pointOfView" | "offer" | "role", string, string]> = [
    ...(row.kind !== "persona" ? [["pointOfView", "We believe", "What surprises them about their own problem"] as ["pointOfView", string, string]] : []),
    ...(row.kind !== "segment" ? [["offer", "We'll offer", "One free thing a first email can send"] as ["offer", string, string]] : []),
    ...(row.kind === "persona" ? [["role", "Role", "Champion, economic buyer…"] as ["role", string, string]] : []),
  ];
  return (
    <details className="text-sm" key={row.id}>
      <summary className={cn(label, "cursor-pointer")}>Message</summary>
      <div className="mt-2 grid gap-2">
        {fieldsFor.map(([key, title, placeholder]) => (
          <label key={key} className="grid gap-1">
            <span className={label}>{title}</span>
            <textarea
              defaultValue={row[key] ?? ""} rows={key === "role" ? 1 : 2} maxLength={key === "role" ? 40 : 400} placeholder={placeholder} disabled={!canEdit}
              onBlur={(e) => { if (e.target.value !== (row[key] ?? "")) void save(row, { [key]: e.target.value }); }}
              className={cn(input, "resize-y")}
            />
          </label>
        ))}
        {row.kind !== "icp" && <p className="text-[11px] text-muted-foreground">Deal drafts still read the ICP&apos;s point of view and offer.</p>}
      </div>
    </details>
  );
}
