"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Loader2, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";

const EXAMPLES: Array<{ label: string; criterion: string }> = [
  { label: "Fast growing", criterion: "The company is growing 50% or more year over year." },
  { label: "Commissioned reps", criterion: "The company employs commissioned sales reps." },
  { label: "Leans Republican", criterion: "The company's leadership or customer base leans Republican." },
  { label: "Sells to enterprise", criterion: "The company mainly sells to large enterprises." },
];

export function AiSegmentDialog({
  open,
  onOpenChange,
  scopeCount,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeCount: number;
  onCreated: (key: string) => void;
}) {
  const create = useMutation(api.tam.createSegment);
  const [label, setLabel] = useState("");
  const [criterion, setCriterion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { key } = await create({ label: label.trim() || criterion.trim().slice(0, 60), criterion });
      onOpenChange(false);
      setLabel("");
      setCriterion("");
      onCreated(key);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const scored = Math.min(scopeCount, 500);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> New AI segment
        </DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          Write a yes/no trait in plain English. Jev, TypeSafe&apos;s judgment model, reads each account&apos;s homepage
          and firmographics and returns the probability it&apos;s true. Accounts at 65% or more land in <b>Yes</b>, at
          35% or less in <b>No</b>, and the rest in <b>Unsure</b>, where the evidence doesn&apos;t settle it.
        </DialogDescription>
        <form onSubmit={submit} className="grid gap-3">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => (setLabel(ex.label), setCriterion(ex.criterion))}
                className="border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
              >
                {ex.label}
              </button>
            ))}
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Trait
            <textarea
              required
              minLength={4}
              maxLength={500}
              rows={3}
              value={criterion}
              onChange={(e) => setCriterion(e.target.value)}
              placeholder="The company employs commissioned sales reps."
              className="border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Name in the breadcrumb
            <input
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Commissioned reps"
              className="border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Scoring starts on the {scored.toLocaleString()} {scopeCount > 500 ? "best-fit " : ""}accounts in your current view
            (about ${((scored * 2000 * 0.042) / 1_000_000).toFixed(2)} of Jev). Answers are saved, so drilling elsewhere and
            scoring again only pays for accounts without an answer. Traits that a homepage can&apos;t show, like politics, lean on
            what&apos;s typical for similar companies, so expect more Unsure.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || criterion.trim().length < 4}
              className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3 animate-spin" />} Create and score
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
