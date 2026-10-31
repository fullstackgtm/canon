"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useOutboundAvailable } from "@/hooks/use-outbound-available";
import { Bell, Check } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The member's in-app notifications (convex/notifications.ts): what a module told them, newest first, each with what
 * kind of notice it is, its subject and two lines of its message. Only the person marks one read: opening it, its
 * Mark read, or Mark all read (decision 2026-10-18); opening the list marks nothing. In an admin's "view as" preview it
 * lists the member previewed's, and marks nothing read.
 */
export function NotificationsBell({ collapsed }: { collapsed?: boolean }) {
  const feed = useQuery(api.notifications.list, {});
  const markRead = useMutation(api.notifications.markRead);
  const [open, setOpen] = useState(false);
  const unread = feed?.unread ?? 0;
  const items = feed?.items ?? [];
  const viewingAs = feed?.preview ?? null;
  const read = (id: Id<"notifications">) => { if (viewingAs === null) void markRead({ ids: [id] }); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className={cn("relative mx-2 mt-2 flex items-center gap-2 border border-sidebar-border px-2 py-1.5 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground/80", collapsed && "justify-center px-0")}>
          <Bell className="size-3.5 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Notifications</span>}
          {unread > 0 && <span className={cn("bg-primary px-1.5 font-mono text-[10px] text-primary-foreground tabular-nums", collapsed && "absolute top-0.5 right-1")}>{unread > 98 ? "99+" : unread}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-96 rounded-none p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-medium">Notifications{unread > 0 ? <span className="font-normal text-muted-foreground tabular-nums"> · {unread} unread</span> : null}</p>
          {unread > 0 && viewingAs === null && <button type="button" className="text-xs text-muted-foreground underline" onClick={() => void markRead({ all: true })}>Mark all read</button>}
        </div>
        {viewingAs !== null && <p role="status" className="border-b border-border bg-amber-100 px-3 py-1.5 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">{viewingAs}&apos;s notifications. Viewing as them, marking read is off.</p>}
        {!items.length ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p> : (
          <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
            {items.map((n) => {
              const body = (
                <>
                  <span className="flex items-center gap-1.5">
                    {n.badge && <span className="border border-border bg-muted px-1 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{n.badge}</span>}
                    {!n.read && <span className="sr-only">Unread.</span>}
                    {n.subject && <span className={cn("min-w-0 truncate", !n.read && "font-medium")}>{n.subject}</span>}
                  </span>
                  <span className={cn("line-clamp-2 block", n.subject ? "text-xs text-muted-foreground" : !n.read && "font-medium")}>{n.message}</span>
                  <span className="block text-xs text-muted-foreground">{new Date(n.at).toLocaleString()}</span>
                </>
              );
              return (
                <li key={n.id} className={cn("flex items-start gap-2 px-3 py-2 text-sm", !n.read && "border-l-2 border-primary")}>
                  <div className="min-w-0 flex-1">
                    {n.link ? <Link href={n.link} className="block space-y-0.5 hover:underline" onClick={() => { if (!n.read) read(n.id); setOpen(false); }}>{body}</Link> : <div className="space-y-0.5">{body}</div>}
                  </div>
                  {!n.read && viewingAs === null && (
                    <button type="button" className="inline-flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Mark read: ${n.subject ?? n.message}`} onClick={() => read(n.id)}><Check className="size-3" />Mark read</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <EmailChoices />
      </PopoverContent>
    </Popover>
  );
}

/** How the member wants each module's notices emailed (docs/modules.md, "Outbound"): as they happen, a daily digest, or not. */
function EmailChoices() {
  const available = useOutboundAvailable();
  const choices = useQuery(api.outbound.emailChoices, available ? {} : "skip");
  const set = useMutation(api.outbound.setEmailChoice);
  if (!choices?.length) return null;
  return (
    <div className="space-y-1 border-t border-border px-3 py-2">
      <p className="text-xs font-medium">Email me</p>
      {choices.map((c) => (
        <label key={c.moduleId} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{c.title}</span>
          <select className="border border-border bg-background px-1 py-0.5 text-xs" value={c.mode} aria-label={`Email ${c.title} notices`}
            onChange={(e) => void set({ moduleId: c.moduleId, mode: e.target.value as "instant" | "digest" | "off" })}>
            <option value="instant">Each one</option>
            <option value="digest">Daily digest</option>
            <option value="off">Off</option>
          </select>
        </label>
      ))}
    </div>
  );
}
