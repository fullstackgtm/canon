"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon } from "lucide-react"
import * as SelectPrimitive from "@ui-sdk/react/select"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@ui-sdk/react/combobox"

import { type UiProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function Select({
  value, defaultValue, onValueChange, ...props
}: Omit<Extract<SelectPrimitive.SelectProps<string, false>, { multiple?: false }>, "onValueChange"> & { onValueChange?: (value: string) => void }) {
  return <SelectPrimitive.Select<string, false> {...props} multiple={false} value={value === "" ? null : value} defaultValue={defaultValue === "" ? null : defaultValue} onValueChange={(next) => onValueChange?.(next ?? "")} />
}

function SelectGroup({
  ...props
}: UiProps<typeof SelectPrimitive.SelectGroup>) {
  return <SelectPrimitive.SelectGroup data-slot="select-group" {...props} />
}

function SelectValue({
  placeholder, children, ...props
}: Omit<UiProps<typeof SelectPrimitive.SelectValue>, "placeholder"> & { placeholder?: React.ReactNode }) {
  return <SelectPrimitive.SelectValue data-slot="select-value" {...props} placeholder={typeof placeholder === "string" ? placeholder : undefined}>{children ?? ((state) => state.placeholder ? placeholder : state.label)}</SelectPrimitive.SelectValue>
}

/** The closed control's look, shared by SelectField and SearchableSelectField so the two sit level in one form. */
const TRIGGER_CLASS = "border-border data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-primary/30 aria-invalid:border-destructive data-open:border-primary flex w-fit items-center justify-between gap-2 border bg-background px-2.5 text-sm text-foreground whitespace-nowrap transition-[color,border-color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:px-2 data-[size=sm]:text-xs *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: UiProps<typeof SelectPrimitive.SelectTrigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.SelectTrigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        TRIGGER_CLASS,
        className
      )}
      {...props}
    >
      {children}
      <span aria-hidden="true">
        <ChevronDownIcon className="size-4 opacity-50" />
      </span>
    </SelectPrimitive.SelectTrigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  ...props
}: UiProps<typeof SelectPrimitive.SelectContent> & { position?: "popper" | "item-aligned" }) {
  return (
    <SelectPrimitive.SelectContent
      data-slot="select-content"
      className={cn(
        "bg-popover text-popover-foreground relative z-50 max-h-(--available-height) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto border border-border shadow-lg transition-[opacity,transform,scale] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none data-starting-style:scale-95 data-ending-style:scale-95",
        position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className
      )}
      alignItemWithTrigger={position === "item-aligned"}
      align={align}
      {...props}
    >
      <SelectPrimitive.SelectList
        className={cn(
          "p-1",
          position === "popper" &&
            "w-full min-w-[var(--anchor-width)] scroll-my-1"
        )}
      >
        {children}
      </SelectPrimitive.SelectList>
    </SelectPrimitive.SelectContent>
  )
}

function SelectLabel({
  className,
  ...props
}: UiProps<typeof SelectPrimitive.SelectGroupLabel>) {
  return (
    <SelectPrimitive.SelectGroupLabel
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: UiProps<typeof SelectPrimitive.SelectItem>) {
  return (
    <SelectPrimitive.SelectItem
      data-slot="select-item"
      className={cn(
        "data-highlighted:bg-muted data-highlighted:text-foreground data-selected:text-primary [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.SelectItemIndicator>
          <CheckIcon className="size-3.5 text-primary" />
        </SelectPrimitive.SelectItemIndicator>
      </span>
      <SelectPrimitive.SelectItemText>{children}</SelectPrimitive.SelectItemText>
    </SelectPrimitive.SelectItem>
  )
}

function SelectSeparator({
  className,
  ...props
}: UiProps<typeof SelectPrimitive.SelectSeparator>) {
  return (
    <SelectPrimitive.SelectSeparator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({ onClick, ...props }: React.ComponentProps<"button">) {
  return <button type="button" aria-label="Scroll up" {...props} onClick={(event) => {
    onClick?.(event)
    event.currentTarget.closest('[data-slot="select-content"]')?.scrollBy({ top: -100 })
  }}><ChevronUpIcon className="size-4" /></button>
}

function SelectScrollDownButton({ onClick, ...props }: React.ComponentProps<"button">) {
  return <button type="button" aria-label="Scroll down" {...props} onClick={(event) => {
    onClick?.(event)
    event.currentTarget.closest('[data-slot="select-content"]')?.scrollBy({ top: 100 })
  }}><ChevronDownIcon className="size-4" /></button>
}

/** Options by their group, in first-seen order; ungrouped ones form a group of their own (no heading). */
function groupsOf<O extends { group?: string }>(options: ReadonlyArray<O>): Array<[string | undefined, O[]]> {
  const out = new Map<string | undefined, O[]>()
  for (const o of options) out.set(o.group, [...(out.get(o.group) ?? []), o])
  return [...out]
}

// Keep an empty option distinct from the absence of a selection.
const EMPTY_VALUE = "__select_field_empty__"

type SelectFieldOption = {
  value: string
  label: React.ReactNode
  disabled?: boolean
  className?: string
  /** A heading the option sits under; options of one group are listed together, in the order given. */
  group?: string
  /** Other text a search matches without showing it (SearchableSelectField), such as a zone's "Pacific Standard Time". */
  keywords?: readonly string[]
}

/**
 * The site's single-choice dropdown with a native-select-like API: a string
 * value, `onValueChange`, and a flat list of options. An option whose value is
 * `""` works like `<option value="">` (none/any). A `""` value with no such
 * option shows `placeholder`. Defaults to the compact `size="sm"` trigger;
 * `className` goes to the trigger, so use it for widths.
 */
function SelectField({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  size = "sm",
  className,
  open,
  defaultOpen,
  onOpenChange,
  ...triggerProps
}: Omit<UiProps<typeof SelectPrimitive.SelectTrigger>, "value" | "defaultValue" | "onChange" | "children"> & {
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<SelectFieldOption>
  placeholder?: React.ReactNode
  size?: "sm" | "default"
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const hasEmpty = options.some((o) => o.value === "")
  const toItem = (v: string) => (v === "" ? EMPTY_VALUE : v)
  return (
    <Select
      value={value === "" && !hasEmpty ? "" : toItem(value)}
      onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? "" : next)}
      disabled={disabled}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger size={size} className={cn("max-w-full", className)} {...triggerProps}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="rounded-none">
        {groupsOf(options).map(([group, items]) => {
          const rows = items.map((o) => (
            <SelectItem
              key={o.value}
              value={toItem(o.value)}
              disabled={o.disabled}
              className={cn("rounded-none", size === "sm" && "text-xs", o.className)}
            >
              {o.label}
            </SelectItem>
          ))
          return group === undefined ? <React.Fragment key="">{rows}</React.Fragment> : <SelectGroup key={`g:${group}`}><SelectLabel>{group}</SelectLabel>{rows}</SelectGroup>
        })}
      </SelectContent>
    </Select>
  )
}

/**
 * SelectField for long lists: the same closed trigger, and a popup that opens
 * with a search box which filters options by label or `keywords`. Options need
 * string labels. Escape or closing returns focus to the trigger.
 */
function SearchableSelectField({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  size = "sm",
  className,
  searchLabel = "Search",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  id,
  "aria-label": ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<SelectFieldOption & { label: string }>
  placeholder?: React.ReactNode
  disabled?: boolean
  size?: "sm" | "default"
  className?: string
  searchLabel?: string
  searchPlaceholder?: string
  emptyText?: React.ReactNode
  id?: string
  "aria-label"?: string
}) {
  const [button, setButton] = React.useState<HTMLButtonElement | null>(null)
  const [query, setQuery] = React.useState("")
  // Same as SelectField: an option valued "" is a real choice ("Any"), distinct from no selection.
  const hasEmpty = options.some((o) => o.value === "")
  const toItem = (v: string) => (v === "" ? EMPTY_VALUE : v)
  const labels = React.useMemo(() => new Map(options.map((o) => [toItem(o.value), o.label])), [options])
  return (
    <Combobox<string>
      value={value === "" && !hasEmpty ? null : toItem(value)}
      onValueChange={(next) => { if (next !== null) onValueChange(next === EMPTY_VALUE ? "" : next) }}
      itemToLabel={(v) => labels.get(v) ?? v}
      query={query}
      onQueryChange={setQuery}
      onOpenChange={(open) => { if (open) setQuery("") }}
      // Back to the trigger after Escape or a pick, but never away from a field the user tabbed or clicked into.
      onOpenChangeComplete={(open) => {
        const active = document.activeElement
        if (!open && (!active || active === document.body)) button?.focus()
      }}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxTrigger
        ref={setButton}
        id={id}
        aria-label={ariaLabel}
        data-size={size}
        className={cn(TRIGGER_CLASS, "max-w-full", className)}
      >
        <span data-slot="select-value">
          <ComboboxValue>{(state) => state.label || placeholder}</ComboboxValue>
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-4 opacity-50" />
      </ComboboxTrigger>
      <ComboboxContent
        anchor={button}
        align="start"
        sideOffset={4}
        className="bg-popover text-popover-foreground z-50 flex max-h-[min(24rem,var(--available-height))] w-(--anchor-width) min-w-[16rem] flex-col border border-border shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <ComboboxInput
            autoFocus
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ComboboxEmpty className="px-2.5 py-3 text-sm text-muted-foreground empty:hidden">{emptyText}</ComboboxEmpty>
        <ComboboxList className="min-h-0 flex-1 overflow-y-auto p-1">
          {groupsOf(options).map(([group, items]) => {
            const rows = items.map((o) => (
              <ComboboxItem
                key={o.value}
                value={toItem(o.value)}
                label={o.label}
                keywords={o.keywords ? [...o.keywords] : undefined}
                disabled={o.disabled}
                className={cn(
                  "data-highlighted:bg-muted data-highlighted:text-foreground data-selected:text-primary relative flex w-full cursor-default items-center py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  size === "sm" && "text-xs",
                  o.className,
                )}
              >
                {o.label}
                <ComboboxItemIndicator className="absolute right-2 flex size-3.5 items-center justify-center">
                  <CheckIcon aria-hidden="true" className="size-3.5 text-primary" />
                </ComboboxItemIndicator>
              </ComboboxItem>
            ))
            return group === undefined
              ? <React.Fragment key="">{rows}</React.Fragment>
              : <ComboboxGroup key={`g:${group}`}><ComboboxGroupLabel className="px-2 py-1.5 text-xs text-muted-foreground">{group}</ComboboxGroupLabel>{rows}</ComboboxGroup>
          })}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export {
  SearchableSelectField,
  Select,
  SelectContent,
  SelectField,
  type SelectFieldOption,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
