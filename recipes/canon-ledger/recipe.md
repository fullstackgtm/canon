---
id: canon-ledger
version: 1.0.0
title: Ledger
description: "Canon's look: light stone paper, warm ink, bottle-green actions and a little oxblood on what Canon filled in."
author: { org: canon, kind: canon }
engines: { canon: "3" }
contributes: [workspace.theme]
permissions: { read: [], llm: none, sources: [] }
---

# Ledger

Like an accounting ledger: green-ruled paper with corrections in red ink.
Green does the work (buttons, links, focus and won deals). Oxblood only marks
values Canon filled in, so it keeps one meaning. Errors are orange and
warnings ochre, never red.

Every colour below is a setting, so a workspace can make Canon its own.
Canon keeps it readable: secondary text and button labels move until they
pass contrast, and a save is refused if body text drops under 7:1, a mark
under 3:1, or the page turns dark.

## Theme

```theme
paper: { setting: paper }
surface: { setting: surface }
ink: { setting: ink }
primary: { setting: primary }
provenance: { setting: provenance }
destructive: { setting: destructive }
warning: { setting: warning }
headings: { setting: headings }
radius: { setting: radius }
```

## Settings

| Setting | Kind | Default | Limits | Group | Label | Help |
|---|---|---|---|---|---|---|
| primary | color | #1e4d3a | any | Colours | Actions | Buttons, links, focus and won deals. |
| provenance | color | #7a2232 | any | Colours | Filled by Canon | The mark on values Canon filled in. |
| paper | color | #eeeeeb | any | Colours | Paper | The page behind everything: the sidebar and the space around cards. |
| surface | color | #fafaf8 | any | Colours | Surface | Cards, tables and dialogs, where text is read. |
| ink | color | #1c1a1a | any | Colours | Text | Body text. Secondary text is derived from it. |
| destructive | color | #b3401a | any | Colours | Errors | Errors and destructive actions. |
| warning | color | #8f6400 | any | Colours | Warnings | Things that need attention. |
| headings | choice | serif | serif, sans, plain | Type | Headings | Headings and record names in IBM Plex Serif, everything in IBM Plex Sans, or everything in plain Times. |
| radius | choice | 2 | 0, 2, 4, 6, 8 | Shape | Corners | Corner radius in pixels. |
