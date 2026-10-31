"use client"

import { ChevronDownIcon } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const item = "rounded-none text-xs focus:bg-muted focus:text-foreground"

/**
 * A dropdown of checkboxes that stays open while you pick, styled like `SelectTrigger size="sm"`.
 * An empty selection means "no filter" and shows `emptyLabel`, which also gets its own item to clear the rest.
 */
export function MultiSelect({ label, options, value, onChange, emptyLabel, className }: {
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  value: readonly string[]
  onChange: (next: string[]) => void
  emptyLabel: string
  className?: string
}) {
  const chosen = options.filter((o) => value.includes(o.value))
  const summary = chosen.length === 0 ? emptyLabel : chosen.length === 1 ? chosen[0].label : `${chosen[0].label} +${chosen.length - 1}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(
          "border-border hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-primary/30 data-[state=open]:border-primary flex h-7 w-fit max-w-64 items-center justify-between gap-2 border bg-background px-2 text-xs text-foreground whitespace-nowrap transition-[color,border-color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width) rounded-none border-border shadow-lg">
        <DropdownMenuCheckboxItem className={item} checked={value.length === 0} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onChange([])}>
          {emptyLabel}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            className={item}
            checked={value.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onChange(on ? [...value, o.value] : value.filter((v) => v !== o.value))}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
