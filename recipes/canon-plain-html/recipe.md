---
id: canon-plain-html
version: 1.0.0
title: Plain HTML
description: "Craigslist-plain, like a 1990s academic or programming page: black Times on white, blue underlined links, no icons, boxes, fills or bold."
author: { org: canon, kind: canon }
engines: { canon: "3" }
contributes: [workspace.theme]
permissions: { read: [], llm: none, sources: [] }
---

# Plain HTML

Like a professor's home page or a language manual from 1996: the page as a
browser drew it with no stylesheet, or Craigslist today. Black Times on
white and blue underlined links; buttons read as links. No icons, boxes,
tinted panels, bold, capitals, rounded corners, shadows or motion. Only text
fields keep a border. Black does the work; visited
purple marks values Canon filled in.

Every colour below is a setting, so a workspace can adjust it. Canon keeps
it readable the same way it keeps Ledger readable.

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
| primary | color | #000000 | any | Colours | Actions | Buttons, links, focus and won deals. |
| provenance | color | #551a8b | any | Colours | Filled by Canon | The mark on values Canon filled in. |
| paper | color | #ffffff | any | Colours | Paper | The page behind everything: the sidebar and the space around cards. |
| surface | color | #ffffff | any | Colours | Surface | Cards, tables and dialogs, where text is read. |
| ink | color | #000000 | any | Colours | Text | Body text. Secondary text is derived from it. |
| destructive | color | #cc0000 | any | Colours | Errors | Errors and destructive actions. |
| warning | color | #806000 | any | Colours | Warnings | Things that need attention. |
| headings | choice | plain | serif, sans, plain | Type | Type | Plain strips the page to bare HTML in Times; serif and sans keep the styled look in IBM Plex. |
| radius | choice | 0 | 0, 2, 4, 6, 8 | Shape | Corners | Corner radius in pixels. |
