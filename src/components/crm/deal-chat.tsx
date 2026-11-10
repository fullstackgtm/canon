"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Answer } from "@/components/shell/ask-canon";
import { getErrorMessage } from "@/lib/utils";

const OPEN = "canon:deal-chat";
const button = "text-xs font-medium text-primary underline underline-offset-2 disabled:opacity-50";
type Seed = { streamId: string; text: string };

function DealChatButtonEnabled({ streamId, text }: Seed) {
  return <button type="button" className={button} onClick={() => window.dispatchEvent(new CustomEvent<Seed>(OPEN, { detail: { streamId, text } }))}>Chat</button>;
}

function DealChatEnabled({ streamId, team }: { streamId: string; team?: ReadonlyArray<{ _id: string; name?: string }> }) {
  const chats = useQuery(api.dealChats.list, { streamId });
  const [chatId, setChatId] = useState<Id<"dealChats"> | null>(null);
  const chat = useQuery(api.dealChats.get, chatId ? { chatId } : "skip");
  const create = useMutation(api.dealChats.create);
  const remove = useMutation(api.dealChats.remove);
  const share = useMutation(api.dealChats.share);
  const send = useAction(api.askCanon.send);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const panel = useRef<HTMLElement>(null);
  const query = useSearchParams();
  const seed = query.get("dealChatSeed");
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<Seed>).detail;
      if (detail.streamId !== streamId) return;
      setChatId(null);
      setQuestion(`Help me with this: ${detail.text}`.slice(0, 2000));
      setAnswer("");
      setError("");
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      panel.current?.querySelector("textarea")?.focus({ preventScroll: true });
    };
    window.addEventListener(OPEN, open);
    if (seed && seeded.current !== seed) {
      seeded.current = seed;
      open(new CustomEvent<Seed>(OPEN, { detail: { streamId, text: seed } }));
    }
    return () => window.removeEventListener(OPEN, open);
  }, [streamId, seed]);

  const ask = async () => {
    if (busy || !question.trim() || (chatId && !chat?.owned)) return;
    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const id = chatId ?? (chats?.available ? await create({ streamId, title: question }) : null);
      if (id) setChatId(id);
      const reply = await send({ question, ...(id ? { chatId: id } : { streamId }) });
      if (reply.status === "not_connected") setError("Connect ChatGPT to ask about this deal.");
      else if (reply.status === "error") setError(reply.message);
      else {
        if (!id) setAnswer(reply.answer);
        setQuestion("");
      }
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  const changeSharing = async (userId: Id<"users">, checked: boolean) => {
    if (!chatId || !chat?.owned) return;
    try {
      await share({ chatId, userIds: checked ? [...chat.sharedWith, userId] : chat.sharedWith.filter((id) => id !== userId) });
    } catch (cause) { toast.error(getErrorMessage(cause)); }
  };
  const erase = async () => {
    if (!chatId) return;
    try {
      await remove({ chatId });
      setChatId(null);
      setQuestion("");
      setError("");
    } catch (cause) { toast.error(getErrorMessage(cause)); }
  };
  return <section ref={panel} aria-label="Deal chat" className="my-6 border border-border bg-card p-4">
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Deal chat</h2><button type="button" disabled={busy} className={button} onClick={() => { setChatId(null); setQuestion(""); setAnswer(""); setError(""); }}>New chat</button></div>
    <p className="mt-1 text-xs text-muted-foreground">Knows this deal&apos;s current state, brief, people and recent touches. Can draft text. Cannot send or change CRM records.</p>
    {chats === undefined ? <p className="mt-3 text-sm">Loading chats…</p> : <>
      {!chats.available && <p className="mt-3 text-xs text-muted-foreground">Saved chats require unrestricted read access. You can ask a question without saving history; deal state is hidden for restricted roles.</p>}
      {chats.available && <div className="my-4 grid gap-4 sm:grid-cols-2">
        {([['My chats', chats.mine], ['Shared with me', chats.shared]] as const).map(([label, rows]) => <div key={label}><h3 className="text-xs font-semibold">{label}</h3><ul className="mt-1 space-y-1">{rows.map((row) => <li key={row._id}><button type="button" disabled={busy} aria-pressed={row._id === chatId} className={button} onClick={() => { setChatId(row._id); setQuestion(""); setAnswer(""); setError(""); }}>{row.title}</button></li>)}</ul>{!rows.length && <p className="mt-1 text-xs text-muted-foreground">No chats yet.</p>}</div>)}
      </div>}
      {chatId && chat === undefined && <p className="text-sm">Loading messages…</p>}
      {chatId && chat === null && <p role="alert" className="text-sm text-muted-foreground">This chat is unavailable. Start a new chat.</p>}
      {chatId && chat && <>
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{chat.title}</h3>{chat.owned && <button type="button" className={button} disabled={busy} onClick={() => void erase()}>Delete chat and messages</button>}</div>
        {chat.owned && <details className="mb-3 text-xs"><summary className="cursor-pointer">Share with workspace members</summary><p className="my-2 text-muted-foreground">Recipients need unrestricted read access to this deal. Shared chats are read-only.</p><div className="flex flex-wrap gap-3">{team?.map((user) => <label key={user._id} className="flex items-center gap-1"><input type="checkbox" checked={chat.sharedWith.includes(user._id as Id<"users">)} onChange={(e) => void changeSharing(user._id as Id<"users">, e.target.checked)} />{user.name ?? "Member"}</label>)}</div></details>}
        <div className="max-h-[32rem] space-y-4 overflow-y-auto" aria-live="polite">{chat.messages.map((message) => <article key={message._id} className="border-t border-border pt-3 text-sm"><p className="mb-1 text-xs font-semibold text-muted-foreground">{message.role === 'user' ? 'You' : 'Canon'}</p><Answer text={message.content} /></article>)}</div>
      </>}
      {answer && <div className="my-4 text-sm" aria-live="polite"><Answer text={answer} /></div>}
      {(!chatId || chat?.owned) && <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <textarea aria-label="Ask about this deal" placeholder="Draft that for me…" className="min-h-24 w-full border border-border bg-background p-2 text-sm" maxLength={2000} value={question} disabled={busy} onChange={(e) => setQuestion(e.target.value)} />
        <button type="submit" className={button} disabled={busy || !question.trim() || chats === undefined}>{busy ? 'Thinking…' : 'Ask Canon'}</button>
      </form>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error} <Link className={button} href="/dashboard/integrations/chatgpt">ChatGPT connection</Link></p>}
    </>}
  </section>;
}

export function DealChatButton(props: React.ComponentProps<typeof DealChatButtonEnabled>) {
  return <IntegrationGate feature="chatgpt"><DealChatButtonEnabled {...props} /></IntegrationGate>;
}

export function DealChat(props: React.ComponentProps<typeof DealChatEnabled>) {
  return <IntegrationGate feature="chatgpt"><DealChatEnabled {...props} /></IntegrationGate>;
}
