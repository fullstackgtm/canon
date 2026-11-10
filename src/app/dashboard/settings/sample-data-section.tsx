"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { SAMPLE_SETS, withNeeds, type SampleSetKey } from "../../../../convex/lib/sampleDataset";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

/** Dev and local stacks only: an admin picks sample sets and loads them into this workspace. */
export function SampleDataSection() {
  const status = useQuery(api.sampleData.status);
  const [open, setOpen] = useState(false);
  if (!status?.available) return null;
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-label="Sample data">
      <h2 className="text-sm font-medium">Sample data</h2>
      <p className="text-sm text-muted-foreground">
        Test workspaces only. Fills this workspace with sample companies, people, deals and module examples, so everyone
        in it sees the same records.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Load sample data…</Button>
      {open && <SampleDataDialog loaded={status.loaded} onClose={() => setOpen(false)} />}
    </section>
  );
}

function SampleDataDialog({ loaded, onClose }: { loaded: SampleSetKey[]; onClose: () => void }) {
  const load = useAction(api.sampleData.load);
  const [picked, setPicked] = useState<SampleSetKey[]>([]);
  const [busy, setBusy] = useState(false);
  const sets = withNeeds(picked);
  const toggle = (key: SampleSetKey) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const confirm = () => {
    setBusy(true);
    load({ sets })
      .then(() => { toast.success("Sample data loaded"); onClose(); })
      .catch((cause) => toast.error(getErrorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="rounded-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Load sample data</DialogTitle>
          <DialogDescription>Pick the sets to add. Sample members never sign in. Loading a set again adds nothing new.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          {SAMPLE_SETS.map((s) => {
            const needed = sets.includes(s.key) && !picked.includes(s.key);
            return (
              <label key={s.key} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={sets.includes(s.key)} disabled={busy || needed} onChange={() => toggle(s.key)} />
                <span>
                  <span className="font-medium">{s.label}</span>
                  {loaded.includes(s.key) && <span className="ml-2 text-xs text-muted-foreground">Loaded</span>}
                  {needed && <span className="ml-2 text-xs text-muted-foreground">Needed by your picks</span>}
                  <span className="block text-muted-foreground">{s.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={confirm} disabled={busy || !sets.length}>{busy ? "Loading… this can take a minute" : "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
