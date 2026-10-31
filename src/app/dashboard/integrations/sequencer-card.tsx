"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Loader2, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { SEQUENCERS, type SequencerId } from "../../../../convex/lib/outbound/sequencers";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const input = "w-full max-w-72 rounded-lg border border-input bg-background px-3 py-2 text-sm";

/** A sequencer (Instantly, EmailBison, Smartlead): the workspace's own key, checked and stored encrypted. It is never shown again. */
export function SequencerControls({ provider }: { provider: SequencerId }) {
  const def = SEQUENCERS[provider];
  const status = useQuery(api.audiences.sequencerStatus)?.[provider];
  const connect = useAction(api.audienceActions.connectSequencer);
  const disconnect = useMutation(api.audiences.disconnectSequencer);
  const [key, setKey] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
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
    <div data-testid={`${provider}-card`}>
      {status?.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          {status.instanceUrl && <span className="text-sm text-muted-foreground">{status.instanceUrl.replace(/^https:\/\//, "")}</span>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => { await disconnect({ provider }); void toast.success(`${def.label} disconnected`); })}
            className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
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
              await connect({ provider, apiKey: key, ...(def.instanceUrl ? { instanceUrl } : {}) });
              setKey("");
              void toast.success(`${def.label} connected`);
            });
          }}
        >
          {def.instanceUrl && (
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              aria-label={def.instanceUrl.label}
              placeholder={def.instanceUrl.placeholder}
              value={instanceUrl}
              onChange={(e) => setInstanceUrl(e.target.value)}
              className={input}
            />
          )}
          <input
            type="password"
            autoComplete="off"
            aria-label={`${def.label} ${def.keyLabel}`}
            placeholder={`${def.label} ${def.keyLabel}`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={input}
          />
          <button
            type="submit"
            disabled={busy || !key.trim() || (Boolean(def.instanceUrl) && !instanceUrl.trim())}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect {def.label}
          </button>
        </form>
      )}
    </div>
  );
}
