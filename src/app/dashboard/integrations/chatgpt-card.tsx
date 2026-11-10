"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { CheckCircle2, Copy, ExternalLink, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "@/lib/toast";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";

/**
 * "Sign in with ChatGPT": device-code login (the Codex CLI's flow). The server
 * gets the code and polls for approval; this card only shows the code and
 * reacts to chatgptAuth.status. Tokens never reach the browser.
 */
export function ChatgptConnect() {
  const status = useQuery(api.chatgptAuth.status);
  const start = useAction(api.chatgptAuthActions.start);
  const disconnect = useMutation(api.chatgptAuth.disconnect);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const { userCode } = await start({});
      await navigator.clipboard?.writeText(userCode).catch(() => {});
    } catch (error: any) {
      toast.error(error?.data ?? error?.message ?? "Could not start ChatGPT sign-in");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await disconnect({});
      toast.success("ChatGPT disconnected");
    } finally {
      setBusy(false);
    }
  }

  if (status === undefined) return <LoadingRows count={2} height="h-24" />;
  if (status === null) return null;

  return (
    <section className="max-w-2xl rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Use your ChatGPT subscription</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your ChatGPT account and the AI tasks you start (call insights, market
        classification and new AI features) run on your ChatGPT plan instead of a workspace
        API key. Your ChatGPT session is encrypted on the server and never sent to this browser.
      </p>

      <div className="mt-5 border-t border-border pt-5">
        {status.status === "connected" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span>
                Connected{status.email ? ` as ${status.email}` : ""}
                {status.planType ? ` · ${status.planType} plan` : ""}
              </span>
            </div>
            <button
              onClick={() => void signOut()}
              disabled={busy}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : status.status === "pending" && status.userCode ? (
          <div className="space-y-3">
            <p className="text-sm">
              Open ChatGPT sign-in and enter this code. This page updates when you approve.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-lg border border-border bg-muted px-4 py-2 font-mono text-xl font-semibold tracking-widest">
                {status.userCode}
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(status.userCode ?? "");
                  toast.success("Code copied");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                <Copy className="h-4 w-4" /> Copy
              </button>
              {status.verificationUrl && (
                <a
                  href={status.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                >
                  Open ChatGPT sign-in <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for approval
              {status.expiresAt ? ` · code expires ${new Date(status.expiresAt).toLocaleTimeString()}` : ""}
            </div>
            <p className="text-xs text-muted-foreground">
              If ChatGPT rejects the code, turn on device code sign-in for Codex in ChatGPT
              Settings → Security, then start again.
            </p>
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
            >
              Get a new code
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {status.status === "error" && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{status.error}</span>
              </div>
            )}
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {status.status === "error" ? "Reconnect ChatGPT" : "Connect ChatGPT"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
