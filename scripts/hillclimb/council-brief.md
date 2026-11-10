# UI council brief

You are one reviewer on a design council for a B2B CRM. Your job is read only: look at screenshots and score them.
Do not edit files or run the app.

## The panel

`<panel dir>/<surface>/` holds, for each surface:

- `R.png`: a reference CRM, captured in its dark theme inside a browser window. **R is a calibrated 7/10 in
  every category.** Score everything else relative to it: better than R scores above 7, worse scores below.
- `X-1440.png`, `X-1024.png` (and `Y-…` when present): the product under review at two viewport widths. Labels are
  shuffled between rounds and carry no meaning.

The product under review is light-only by design. Judge design quality, not the choice of theme. Ignore browser chrome
in R. In X/Y, the round icon at the bottom right is a background-activity tray, and "Signed in as" in the sidebar
footer is a local-dev account switcher; neither is in scope.

## The product's own design system (score fidelity to it, do not replace it)

Read `docs/ui-style.md` ("Look: Ledger" and the controls rules). Those rules are intentional; a page that breaks
them scores lower on fidelity even if it looks more conventional.

## Rubric (1–10 per category, halves allowed)

1. Hierarchy: what draws the eye first, and whether it should
2. Typography: each family used for its job; a clear size/weight ladder
3. Color and contrast: legible, colour used for meaning, not decoration
4. Density and spacing: dense data without clutter; consistent rhythm
5. Data legibility: numbers, states, empty and loading states, provenance
6. Consistency: controls, labels, borders and radii agree across the page
7. Iconography and affordance: actions look actionable; state is visible
8. Design-system fidelity: reads as its own system above, not generic components
9. Distinctiveness: would a user mistake it for R or another off-the-shelf CRM? A 10 has its own point of view

A 10 means you cannot name a change that would make the category better. Copying R's look is not an improvement.

## Reply format

For each surface: a table of the 9 category scores for each X/Y label (R is fixed at 7, do not rescore it), an
overall score, then the **top 5 concrete changes** that would raise the lowest categories, most valuable first.
Each change names the element, what is wrong, and the fix, specific enough to implement (for example "Filter labels
above each control repeat the control's own placeholder; drop the labels and widen the controls"). End with one
line on what the surface does better than R, if anything.
