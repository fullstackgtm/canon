# UI controls

## Look: Ledger

Light stone paper, warm ink, bottle-green actions, a little oxblood (tokens and
rationale in `src/app/globals.css`; research in `docs/brand-lab/`).

- **Type**: IBM Plex Sans for the interface, IBM Plex Serif for headings and
  record names (`record-name` class on a company, person or deal name), IBM
  Plex Mono only for IDs, sources, tokens and code. Labels are sentence case in
  the sans (`text-xs font-medium text-muted-foreground`): no uppercase tracked
  mono labels. Numbers use `tabular-nums`, not mono.
- **Colour jobs**: `primary` (bottle green) is actions, links, focus and won.
  `provenance` (oxblood) only marks values Canon filled in. `destructive` is
  orange and `warning` ochre, so red never means error.

App UI uses the shared controls in `src/components/ui/`. They share one look:
square corners, `border-border`, `bg-background`, and a compact `h-7 text-xs`
size in dense views.

## Choosing from a list

- **One choice: `SelectField`** (`ui/select.tsx`). Pass `value`,
  `onValueChange(value: string)` and `options={[{ value, label, disabled? }]}`.
  An option with `value: ""` means none/any, as `<option value="">` did; the
  wrapper maps it for Radix, which forbids empty item values. A `""` value with
  no such option shows `placeholder`. It defaults to `size="sm"`; use
  `size="default"` (h-8) next to larger form inputs. `className` goes to the
  trigger, so use it for widths (`w-full`, `w-44`, `min-w-0 flex-1`).
  Convert numbers at the call site: `value={String(n)}`,
  `onValueChange={(v) => set(Number(v))}`.
- **Custom rendering**: compose `Select`, `SelectTrigger size="sm"`,
  `SelectValue`, `SelectContent` and `SelectItem` directly, as
  `StatusSelect` in `crm/crm-ui.tsx` does.
- **Several choices: `MultiSelect`** (`ui/multi-select.tsx`). A checkbox menu
  that stays open while you pick; an empty selection means "no filter" and
  shows `emptyLabel`.

**No native `<select>` in app UI.** It renders with the browser's own styling
and does not match the rest of the site. Tests that render a converted
component with a stubbed module map stub `@/components/ui/select` too (see
`tests/fieldsPageRender.test.ts`).

## Other controls

- **Dialogs**: `ui/dialog.tsx` for modal work (forms, previews, drafts);
  `ui/sheet.tsx` for side panels.
- **Menus**: `ui/dropdown-menu.tsx` for action menus (Edit, Delete, Export).
- **Buttons**: dense views use a local `btn` class, `inline-flex items-center
  gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted
  disabled:opacity-50`.
- **Text fields**: a local `input` class, `border border-border bg-background
  px-2 py-1 text-sm`, or `ui/input.tsx`.
