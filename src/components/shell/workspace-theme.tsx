"use client";

import { Component, useEffect, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

/**
 * The workspace's theme (the workspace.theme recipe point, recipes/theme.ts) set on <body>, so the shell, its
 * content and the dialogs and sheets that portal to <body> all take it. Until it loads, after leaving the
 * dashboard, and if the query fails, the page shows Ledger from globals.css.
 */
function ThemeVars() {
  const vars = useQuery(api.recipes.theme, {});
  useEffect(() => {
    if (!vars) return;
    const style = document.body.style;
    for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
    document.body.dataset.look = vars["--look"] ?? "styled";
    return () => {
      for (const name of Object.keys(vars)) style.removeProperty(name);
      delete document.body.dataset.look;
    };
  }, [vars]);
  return null;
}

/** A theme that can't load leaves the page on Ledger; it never takes the dashboard down with it. */
class ThemeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function WorkspaceTheme() {
  return <ThemeBoundary><ThemeVars /></ThemeBoundary>;
}
