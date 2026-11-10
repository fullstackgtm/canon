"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "canon.accounts.treemap.collapsed";

export function CollapsibleTreemap({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      // Read the browser preference after mount so hydration matches the server.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "true");
    } catch { /* Storage may be disabled; keep the default for this visit. */ }
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch { /* The toggle still works when storage is unavailable. */ }
  }

  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section className="mb-4">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls="accounts-treemap"
        onClick={toggle}
        className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Chevron className="h-4 w-4" aria-hidden="true" />
        {collapsed ? "Show treemap" : "Hide treemap"}
      </button>
      <div id="accounts-treemap" hidden={collapsed}>
        {!collapsed && children}
      </div>
    </section>
  );
}
