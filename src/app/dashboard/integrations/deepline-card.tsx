"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Loader2, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

/** Deepline: the workspace's own API key, checked and stored encrypted. Find email tries it first; Deepline bills that account. */
export function DeeplineControls() {
  const status = useQuery(api.deepline.status);
  const connect = useAction(api.deepline.connect);
  const disconnect = useMutation(api.deepline.disconnect);
  const [key, setKey] = useState("");
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
    <div data-testid="deepline-card">
      {status?.connected ? (
        <>
          <p className="text-sm">Find email tries Deepline first, then Canon&apos;s own sources.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => { await disconnect({}); void toast.success("Deepline disconnected"); })}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Unplug className="h-4 w-4" /> Disconnect
          </button>
        </>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await connect({ apiKey: key });
              setKey("");
              void toast.success("Deepline connected");
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Deepline API key"
            placeholder="Deepline API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full max-w-72 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect Deepline
          </button>
        </form>
      )}
    </div>
  );
}
