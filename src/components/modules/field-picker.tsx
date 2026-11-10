"use client";

import { useState } from "react";
import { Command } from "cmdk";
import { ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type FieldOption = { value: string; label: string; group: string };

/** A section's heading: a shaded band that stays on top while its fields scroll, so it never reads as a field. */
const heading = "[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-y [&_[cmdk-group-heading]]:border-border [&_[cmdk-group-heading]]:bg-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground";

/**
 * The report builder's Add a field: a button that opens the fields in their sections with a search box on top. Typing
 * narrows them to the fields (or sections) whose names match; Enter or a click adds the one highlighted.
 */
export function FieldPicker({ options, onPick, label = "Add a field", search = "Search fields…" }: { options: readonly FieldOption[]; onPick: (value: string) => void; label?: string; search?: string }) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, FieldOption[]>();
  for (const o of options) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className="flex h-8 w-full items-center justify-between gap-2 border border-border bg-background px-2.5 text-sm hover:border-foreground/30 data-[state=open]:border-primary">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Plus className="size-3.5" />{label}…</span>
          <ChevronDown className="size-4 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 rounded-none p-0">
        <Command label={label}>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Command.Input autoFocus placeholder={search} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <Command.List className="max-h-80 overflow-y-auto">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</Command.Empty>
            {[...groups].map(([group, items]) => (
              <Command.Group key={group} heading={group} className={heading}>
                {items.map((o) => (
                  <Command.Item key={o.value} value={o.value} keywords={[o.label, group]} onSelect={() => { onPick(o.value); setOpen(false); }}
                    className="cursor-pointer px-3 py-1.5 text-sm data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground">
                    {o.label}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
