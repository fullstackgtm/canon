"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cn, getErrorMessage } from "@/lib/utils";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { Map, Trash2 } from "lucide-react";
import { MapDetail } from "./map-detail";

/**
 * Market Map — hosted MVP of the CLI `market` layer (capture → classify →
 * fronts/axes). Maps are org-shared config; capture/classify runs execute in
 * convex/marketActions.ts through the same package engines as the CLI.
 */

type CompetitorDraft = { name: string; domain: string };

const EMPTY_ROW: CompetitorDraft = { name: "", domain: "" };

export default function MarketPage() {
  const maps = useQuery(api.market.list);
  const createMap = useMutation(api.market.createMap);
  const deleteMap = useMutation(api.market.deleteMap);

  const [selectedMapId, setSelectedMapId] = useState<Id<"marketMaps"> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState<CompetitorDraft[]>([{ ...EMPTY_ROW }, { ...EMPTY_ROW }]);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (selectedMapId) {
    return <MapDetail mapId={selectedMapId} onBack={() => setSelectedMapId(null)} />;
  }

  function setRow(index: number, patch: Partial<CompetitorDraft>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const competitors = rows
      .map((row) => ({ name: row.name.trim(), domain: row.domain.trim() }))
      .filter((row) => row.domain);
    if (!name.trim() || !category.trim() || competitors.length === 0) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const mapId = await createMap({ name: name.trim(), category: category.trim(), competitors });
      setName("");
      setCategory("");
      setRows([{ ...EMPTY_ROW }, { ...EMPTY_ROW }]);
      setShowForm(false);
      setSelectedMapId(mapId);
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(mapId: Id<"marketMaps">, mapName: string) {
    if (!window.confirm(`Delete map "${mapName}" and all its captures/classifications?`)) return;
    try {
      await deleteMap({ mapId });
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  return (
    <ViewFrame
      title="Market Map"
      actions={[{ id: "market-new", label: showForm ? "Hide form" : "New map", onClick: () => setShowForm((v) => !v), primary: true }]}
    >
      {notice && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/15 px-4 py-3 text-sm text-destructive">
          {notice}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="mb-8 rounded-xl border border-border bg-card p-6">
          <p className="eyebrow text-muted-foreground mb-4">New market map</p>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-muted-foreground">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CRM data hygiene"
                required
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-muted-foreground">Category *</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. crm-data-hygiene-revops"
                required
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          <p className="eyebrow text-muted-foreground mb-2">Competitors</p>
          <div className="mb-3 space-y-2">
            {rows.map((row, index) => (
              <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => setRow(index, { name: e.target.value })}
                  placeholder="Vendor name"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <input
                  type="text"
                  value={row.domain}
                  onChange={(e) => setRow(index, { domain: e.target.value })}
                  placeholder="domain, e.g. clay.com"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}
            className="mb-4 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            + add competitor
          </button>

          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create map"}
            </button>
          </div>
        </form>
      )}

      {maps === undefined ? (
        <LoadingRows count={4} />
      ) : maps.length === 0 ? (
        <EmptyState
          icon={Map}
          title="No market maps yet"
          description="Name a category, list the competitors, then capture and classify their public messaging."
          details={[
            { label: "Capture", value: "Fetches each competitor's public pages and stores the readable text with content-addressed hashes." },
            { label: "Classify", value: "LLM positioning readings against a claim taxonomy — every quote mechanically verified verbatim against the stored page." },
            { label: "Views", value: "Front states (owned/contested/open) and PCA-derived strategic axes, recomputed per run." },
          ]}
          action={{ label: "New map", onClick: () => setShowForm(true) }}
        />
      ) : (
        <div className="divide-y divide-border/70 border-t border-border/70">
          {maps.map((map) => (
            <div key={map._id} className="flex items-center justify-between py-4">
              <button onClick={() => setSelectedMapId(map._id)} className="min-w-0 flex-1 text-left">
                <div className="flex items-baseline gap-3">
                  <span className="font-semibold hover:text-primary">{map.name}</span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {map.category}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{map.competitors.length} competitors</span>
                  <span>{map.claims?.length ?? 0} claims</span>
                  <span>
                    {map.lastCaptureAt
                      ? `captured ${new Date(map.lastCaptureAt).toLocaleDateString()}`
                      : "never captured"}
                  </span>
                  <span
                    className={cn(!map.lastClassifyAt && "italic")}
                  >
                    {map.lastClassifyAt
                      ? `classified ${new Date(map.lastClassifyAt).toLocaleDateString()}`
                      : "never classified"}
                  </span>
                </div>
              </button>
              <button
                onClick={() => handleDelete(map._id, map.name)}
                title="Delete map"
                className="ml-4 rounded-md p-2 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </ViewFrame>
  );
}
