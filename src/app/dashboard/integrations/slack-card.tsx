"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Loader2, Send, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const secondary = "inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50";

/** Slack: an incoming-webhook URL for agent turn messages, stored encrypted. It is never shown again. */
export function SlackControls() {
  const status = useQuery(api.agentSlack.status);
  const connect = useAction(api.agentSlack.connect);
  const sendTest = useAction(api.agentSlack.sendTest);
  const disconnect = useMutation(api.agentSlack.disconnect);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="slack-card">
      {status?.connected ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {
              const res = await sendTest({});
              if (res.ok) void toast.success("Test message sent");
              else void toast.error(`Slack refused the test message${res.httpStatus ? ` (HTTP ${res.httpStatus})` : ""}${res.error ? `: ${res.error}` : ""}`);
            })}
            className={secondary}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test message
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => { await disconnect({}); void toast.success("Slack disconnected"); })}
            className={secondary}
          >
            <Unplug className="h-4 w-4" /> Disconnect
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await connect({ url });
              setUrl("");
              void toast.success("Slack connected");
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Slack incoming webhook URL"
            placeholder="https://hooks.slack.com/services/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full max-w-96 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect Slack
          </button>
        </form>
      )}
    </div>
  );
}
