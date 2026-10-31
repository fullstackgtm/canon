"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { Loader2, MessageSquare, SendHorizontal, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { cn, getErrorMessage } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChatgptConnect } from "@/app/dashboard/integrations/chatgpt-card";

/** Opens the panel from anywhere: window.dispatchEvent(new Event("fsgtm:open-ask-canon")). */
export const OPEN_ASK_EVENT = "fsgtm:open-ask-canon";

type Source = { object: string; id: string; title: string; href: string };
type Turn = { role: "user" | "assistant"; content: string; sources?: Source[]; error?: boolean };

const STARTERS = [
  "Which open deals close this month?",
  "Who are the contacts at our biggest accounts?",
  "Which accounts have no owner?",
];

const RECORD_LINK = /^\/dashboard\/records\/[^/]+\/[^/?#]+$/;

/** Bold and record links only: the server already dropped every other link. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[3] !== undefined) out.push(<strong key={key++}>{m[3]}</strong>);
    else if (RECORD_LINK.test(m[2])) {
      out.push(
        <Link key={key++} href={m[2]} className="underline underline-offset-2 hover:text-primary">
          {m[1]}
        </Link>,
      );
    } else out.push(m[1]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Answer({ text }: { text: string }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    const list = Boolean(item);
    const last = blocks[blocks.length - 1];
    if (last && last.list === list) last.lines.push(item ? item[1] : line);
    else blocks.push({ list, lines: [item ? item[1] : line] });
  }
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.lines.map((l, j) => <li key={j}>{inline(l)}</li>)}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}
          </p>
        ),
      )}
    </div>
  );
}

function ConnectPrompt({ expired }: { expired: boolean }) {
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        {expired
          ? "Your ChatGPT session is no longer connected."
          : "Ask Canon runs on your own ChatGPT plan, so Canon never pays for your questions."}{" "}
        Connect ChatGPT to start asking.
      </p>
      <ChatgptConnect />
    </div>
  );
}

function AskCanonEnabled() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [lostPlan, setLostPlan] = useState(false);
  const send = useAction(api.askCanon.send);
  const status = useQuery(api.chatgptAuth.status);
  // The active workspace: a conversation belongs to one, so switching drops it and any reply still in flight.
  const orgId = useQuery(api.users.me)?.orgId;
  const scope = useRef<{ orgId?: string; generation: number }>({ generation: 0 });
  const endRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Following a cited record closes the panel; the conversation stays for the next open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_ASK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_ASK_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  useEffect(() => {
    if (!orgId) return;
    if (scope.current.orgId && scope.current.orgId !== orgId) {
      scope.current.generation++;
      setTurns([]);
      setDraft("");
      setBusy(false);
    }
    scope.current.orgId = orgId;
  }, [orgId]);

  const connected = status?.status === "connected" && !lostPlan;
  useEffect(() => {
    if (status?.status === "connected") setLostPlan(false);
  }, [status?.status]);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history = turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }));
    const generation = scope.current.generation;
    const current = () => scope.current.generation === generation;
    setTurns((t) => [...t, { role: "user", content: question }]);
    setDraft("");
    setBusy(true);
    try {
      const reply = await send({ question, history });
      if (!current()) return;
      if (reply.status === "ok") setTurns((t) => [...t, { role: "assistant", content: reply.answer, sources: reply.sources }]);
      else if (reply.status === "not_connected") setLostPlan(true);
      else setTurns((t) => [...t, { role: "assistant", content: reply.message, error: true }]);
    } catch (cause) {
      if (current()) setTurns((t) => [...t, { role: "assistant", content: getErrorMessage(cause), error: true }]);
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" aria-describedby="ask-canon-desc">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="flex items-center gap-2 pr-8">
            <MessageSquare className="size-4" /> Ask Canon
          </SheetTitle>
          <SheetDescription id="ask-canon-desc" className="text-xs">
            Read-only questions about your accounts, contacts and deals. It never changes a record.
          </SheetDescription>
        </SheetHeader>

        {status === undefined ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : !connected ? (
          <div className="flex-1 overflow-y-auto"><ConnectPrompt expired={lostPlan || status?.status === "error"} /></div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" aria-live="polite">
              {turns.length === 0 && (
                <div className="space-y-2">
                  <p className="text-muted-foreground">Try asking:</p>
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void submit(s)}
                      className="block w-full border border-border px-3 py-2 text-left hover:bg-muted"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="ml-8 whitespace-pre-wrap bg-muted px-3 py-2">{t.content}</div>
                ) : (
                  <div key={i} className={cn("mr-4", t.error && "text-destructive")}>
                    <Answer text={t.content} />
                    {!!t.sources?.length && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {t.sources.map((s) => (
                          <Link
                            key={s.href}
                            href={s.href}
                            className="border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {s.object}: {s.title}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                ),
              )}
              {busy && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Looking through your records…
                </div>
              )}
              <div ref={endRef} />
            </div>
            <form
              className="flex items-end gap-2 border-t border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(draft);
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit(draft);
                  }
                }}
                rows={2}
                maxLength={2000}
                placeholder="Ask about your pipeline, accounts or contacts"
                aria-label="Your question"
                className="min-h-0 flex-1 resize-none border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex flex-col gap-1">
                <button
                  type="submit"
                  disabled={busy || !draft.trim()}
                  aria-label="Send"
                  className="inline-flex size-8 items-center justify-center border border-border hover:bg-muted disabled:opacity-50"
                >
                  <SendHorizontal className="size-4" />
                </button>
                {turns.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTurns([])}
                    disabled={busy}
                    aria-label="Clear conversation"
                    className="inline-flex size-8 items-center justify-center border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function AskCanon() {
  return <IntegrationGate feature="chatgpt"><AskCanonEnabled /></IntegrationGate>;
}
