"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { sfSync } from "@/components/salesforce-sync/data";
import { Panel, formatTime, formatValue } from "@/components/salesforce-sync/ui";
import type { ConflictResolution, ConflictStatus } from "@/components/salesforce-sync/types";

export default function SalesforceConflictsPage() {
  const [status, setStatus] = useState<ConflictStatus>("open");
  const conflicts = sfSync.useConflicts(status);
  const resolve = sfSync.useResolveConflict();
  const [custom, setCustom] = useState<Record<string, string>>({});

  function onResolve(conflictId: string, resolution: ConflictResolution, value?: unknown) {
    resolve({ conflictId, resolution, value })
      .then(() => toast.success("Conflict resolved"))
      .catch((err) => toast.error(getErrorMessage(err)));
  }

  return (
    <Panel title="Conflict review queue" testId="sf-conflicts">
      <div className="mb-4 flex gap-2" role="tablist">
        {(["open", "resolved"] as const).map((s) => (
          <Button key={s} role="tab" aria-selected={status === s} size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)}>
            {s === "open" ? "Open" : "Resolved"}
          </Button>
        ))}
      </div>
      {conflicts === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : conflicts.length === 0 ? (
        <p data-testid="sf-conflicts-empty" className="text-sm text-muted-foreground">
          {status === "open" ? "No open conflicts." : "No resolved conflicts yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {conflicts.map((c) => (
            <li key={c._id} data-testid={`sf-conflict-${c._id}`} className="border border-border p-3 text-sm">
              <p className="mb-2">
                <strong>{c.object}</strong>.<span className="font-mono">{c.field}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">{c.sfId}</span>
              </p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">CanonCRM · {formatTime(c.fsgtmAt)}</p>
                  <p data-testid="fsgtm-value">{formatValue(c.fsgtmValue)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Salesforce · {formatTime(c.sfAt)}</p>
                  <p data-testid="sf-value">{formatValue(c.sfValue)}</p>
                </div>
              </div>
              {c.status === "open" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => onResolve(c._id, "fsgtm")}>
                    Keep CanonCRM
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onResolve(c._id, "salesforce")}>
                    Keep Salesforce
                  </Button>
                  <input
                    aria-label={`Custom value for ${c.field}`}
                    placeholder="Custom value"
                    className="border border-border bg-background px-2 py-1 text-sm"
                    value={custom[c._id] ?? ""}
                    onChange={(e) => setCustom({ ...custom, [c._id]: e.target.value })}
                  />
                  <Button size="sm" variant="outline" disabled={!custom[c._id]} onClick={() => onResolve(c._id, "custom", custom[c._id])}>
                    Use custom
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Resolved: {c.resolution} {c.resolvedBy ? `by ${c.resolvedBy}` : ""} {formatTime(c.resolvedAt)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
