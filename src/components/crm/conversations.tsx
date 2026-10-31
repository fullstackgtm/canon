"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAction } from "convex/react";
import { CalendarDays, ChevronDown, ChevronRight, Linkedin, Mail, Phone } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Activity } from "../../../convex/lib/activities";
import { conversationRows, type ConversationRow } from "../../../convex/lib/conversations/view";
import type { Thread } from "../../../convex/conversationView";
import { RecordLink } from "@/components/records/record-context";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/background-activity";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { cn } from "@/lib/utils";
import { attributeLabel, factValueText } from "./fact-format";

/** A conversation's own page (the suggestions panel and the record lists link to it). */
export const conversationHref = (id: string) => `/dashboard/conversations/${id}`;

const PAGE = 10;
/** Rows one record's list holds before "Show more" stops: its newest threads, calls and meetings. */
const LIST_MAX = 100;
const CHANNEL: Record<"email" | "linkedin", string> = { email: "Email", linkedin: "LinkedIn" };
const STATUS: Record<string, string> = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", superseded: "Superseded" };
const SUGGESTION_STATUS: Record<string, string> = { pending: "Suggested", created: "Added", dismissed: "Dismissed" };
const SUGGESTION_KIND: Record<string, string> = { account: "Company", contact: "Person", deal: "Deal" };

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function RowIcon({ row }: { row: ConversationRow }) {
  const Icon = row.kind === "conversation" ? (row.channel === "email" ? Mail : Linkedin) : row.kind === "call" ? Phone : CalendarDays;
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/**
 * A record's email and LinkedIn threads, calls and meetings, newest first (docs/conversation-intake.md CI4). A thread
 * opens in place with what it changed; a call or meeting links to its notes. `activities` are the page's own
 * (useActivities), so the calls and meetings are read once for the page.
 */
export function RecordConversations({ object, id, activities, userName }: {
  object: "contact" | "account" | "deal"; id: string; activities: readonly Activity[] | undefined; userName: (id: string) => string;
}) {
  const load = useAction(api.conversationView.forRecord);
  const [threads, setThreads] = useState<Awaited<ReturnType<typeof load>> | undefined>(undefined);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load({ object, id }).then((r) => { if (live) setThreads(r); }, () => { if (live) setThreads([]); });
    return () => { live = false; };
  }, [load, object, id]);
  const rows = useMemo(() => conversationRows(threads ?? [], activities ?? [], LIST_MAX), [threads, activities]);
  const owners = useMemo(() => new Map((threads ?? []).map((t) => [t.ownerUserId, t.ownerName])), [threads]);
  const loaded = threads !== undefined && activities !== undefined;
  return (
    <section className="border border-border bg-card p-4" aria-label="Conversations" data-testid="record-conversations">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">Conversations</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{loaded ? "No emails, LinkedIn messages or calls yet." : "Loading…"}</p>
      ) : (
        <ul className="text-sm">
          {rows.slice(0, limit).map((row) => {
            const key = `${row.kind}:${row.id}`;
            const expanded = open === key;
            return (
              <li key={key} className="border-b border-border py-2 last:border-b-0">
                {row.kind === "conversation" ? (
                  <>
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}
                      className="flex w-full min-w-0 items-start gap-2 text-left">
                      <RowIcon row={row} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{row.counterpart}{row.subject && <span className="font-normal text-muted-foreground"> · {row.subject}</span>}</span>
                        <span className="block text-xs text-muted-foreground">
                          {CHANNEL[row.channel]} · {owners.get(row.ownerUserId) ?? userName(row.ownerUserId)} · <time title={when(row.at)}>{formatRelativeTime(row.at)}</time>
                          {row.proposals > 0 && <> · {row.proposals} {row.proposals === 1 ? "update" : "updates"}</>}
                          {row.suggestions > 0 && <> · {row.suggestions} {row.suggestions === 1 ? "suggestion" : "suggestions"}</>}
                        </span>
                      </span>
                      {expanded ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
                    </button>
                    {expanded && <div className="mt-2 pl-5"><ConversationThread conversationId={row.id} compact /></div>}
                  </>
                ) : (
                  <div className="flex min-w-0 items-start gap-2">
                    <RowIcon row={row} />
                    <span className="min-w-0 flex-1">
                      <RecordLink object={row.kind} id={row.id} className="block truncate font-medium hover:underline">{row.title}</RecordLink>
                      <span className="block text-xs text-muted-foreground">
                        {row.kind === "call" ? "Call" : "Meeting"}{row.ownerId ? ` · ${userName(row.ownerId)}` : ""} · <time title={when(row.at)}>{formatRelativeTime(row.at)}</time>
                      </span>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > limit && <Button size="xs" variant="ghost" className="mt-2" onClick={() => setLimit(limit + PAGE)}>Show more</Button>}
    </section>
  );
}

/** One thread's messages, oldest first, and what it changed: the proposals its extraction made and the suggestions it left. */
export function ConversationThread({ conversationId, compact }: { conversationId: string; compact?: boolean }) {
  const thread = useScopedQuery(api.conversationView.thread, api.conversationView.threadScoped, { conversationId });
  if (thread === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (thread === null) return <p className="text-sm text-muted-foreground">This conversation isn&apos;t in this workspace, or you can&apos;t see who it was with.</p>;
  return (
    <div className="grid gap-4">
      <Messages thread={thread} compact={compact} />
      <Changes thread={thread} />
      {compact && <Link href={conversationHref(thread.id)} className="text-xs text-primary hover:underline">Open conversation</Link>}
    </div>
  );
}

function Messages({ thread, compact }: { thread: Thread; compact?: boolean }) {
  if (!thread.messages.length) return <p className="text-sm text-muted-foreground">No messages kept. Its owner may have deleted what was read.</p>;
  return (
    <ol className="grid gap-3" aria-label="Messages">
      {thread.more && <li className="text-xs text-muted-foreground">Earlier messages aren&apos;t shown.</li>}
      {thread.messages.map((m) => (
        <li key={m.id} className={cn("min-w-0 border-l-2 pl-3", m.direction === "out" ? "border-primary/40" : "border-border")}>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{m.direction === "out" ? thread.ownerName : thread.counterpart}</span> · <time>{when(m.at)}</time>
          </div>
          {"text" in m ? (
            <p className={cn("mt-1 whitespace-pre-wrap break-words text-sm", compact && "line-clamp-6")}>{m.text}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Only {thread.ownerName} and roles that read their activity see this message</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Changes({ thread }: { thread: Thread }) {
  if (!thread.proposals.length && !thread.suggestions.length) {
    return <p className="text-xs text-muted-foreground">{thread.extractedAt ? "Nothing to change from this conversation." : "Canon reads it for updates once it has been quiet for 10 minutes."}</p>;
  }
  return (
    <div className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">What changed from this conversation</h3>
      <ul className="grid gap-2 text-sm">
        {thread.proposals.map((p) => (
          <li key={p.factId} className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{p.label} · {attributeLabel(p.attribute)}</span>
              <span>→ {factValueText(p.value)}</span>
              <span className={cn("text-xs", p.status === "accepted" ? "text-primary" : p.status === "rejected" ? "text-destructive" : "text-muted-foreground")}>{STATUS[p.status] ?? p.status}</span>
              {p.status === "proposed" && <Link href={`/dashboard/facts?fact=${p.factId}`} className="text-xs text-primary hover:underline">Review</Link>}
            </div>
            {p.evidence && <blockquote className="mt-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">{p.evidence}</blockquote>}
          </li>
        ))}
        {thread.suggestions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{SUGGESTION_KIND[s.kind]}{s.name ? ` · ${s.name}` : ""}</span>
            <span className="text-xs text-muted-foreground">{SUGGESTION_STATUS[s.status] ?? s.status}</span>
            {s.status === "pending" && s.mine && <Link href="/dashboard/deals" className="text-xs text-primary hover:underline">Review suggestions</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A conversation's own page: who it was with, the thread and what it changed. */
export function ConversationPage({ conversationId }: { conversationId: string }) {
  const thread = useScopedQuery(api.conversationView.thread, api.conversationView.threadScoped, { conversationId });
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-4 sm:p-8">
      <header>
        <div className="text-xs font-medium text-muted-foreground">{thread ? `${CHANNEL[thread.channel]} conversation` : "Conversation"}</div>
        <h1 className="record-name font-display text-3xl font-semibold">{thread?.counterpart ?? "Conversation"}</h1>
        {thread?.subject && <p className="mt-1 text-sm">{thread.subject}</p>}
        {thread && (
          <p className="mt-1 text-sm text-muted-foreground">
            {thread.mine ? "Yours" : `${thread.ownerName}'s`} · last message <time title={when(thread.lastMessageAt)}>{formatRelativeTime(thread.lastMessageAt)}</time>
            {thread.contactId && <> · <RecordLink object="contact" id={thread.contactId} className="text-primary hover:underline">Open person</RecordLink></>}
          </p>
        )}
      </header>
      <section className="border border-border bg-card p-4"><ConversationThread conversationId={conversationId} /></section>
    </div>
  );
}
