"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 whitespace-nowrap border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

/**
 * Canon's confirm: a dialog that asks before an action runs (never window.confirm, which blocks the tab). `onConfirm`
 * runs on the confirm button; the dialog closes when it settles, and a failure shows as a toast.
 */
export function ConfirmDialog({ title, description, confirmLabel, destructive, onConfirm, onClose }: {
  title: string; description?: string; confirmLabel?: string; destructive?: boolean;
  onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogTitle className="text-base">{title}</DialogTitle>
        {description ? <DialogDescription className="text-xs">{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" autoFocus disabled={busy}
            className={cn(btn, destructive ? "border-destructive bg-destructive text-white hover:bg-destructive/90" : "border-foreground bg-foreground text-background hover:bg-foreground/90")}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); onClose(); }
            }}>{confirmLabel ?? title}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
