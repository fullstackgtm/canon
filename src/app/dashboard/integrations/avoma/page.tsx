"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { IntegrationPage } from "../integration-ui";
import { CALL_PROVIDERS, CallProviderCard, emptyCallProviderForm } from "../call-provider-card";

const config = CALL_PROVIDERS.find((provider) => provider.key === "avoma")!;

export default function AvomaIntegrationPage() {
  const connections = useQuery(api.callProviders.listConnections);
  const runs = useQuery(api.integrations.listSyncRuns, { provider: "avoma", limit: 1 });
  const connect = useMutation(api.callProviders.connect);
  const disconnect = useMutation(api.callProviders.disconnect);
  const sync = useAction(api.callProviderActions.syncProvider);
  const [form, setForm] = useState(emptyCallProviderForm);
  const [busy, setBusy] = useState<string | null>(null);
  const perform = async (operation: "connect" | "sync" | "disconnect") => {
    setBusy(`avoma:${operation}`);
    try {
      if (operation === "connect") {
        await connect({ provider: "avoma", apiKey: form.apiKey, instanceUrl: form.instanceUrl, callsPath: form.callsPath });
        setForm(emptyCallProviderForm());
        toast.success("Avoma connected. Sync calls to import transcripts.");
      } else if (operation === "sync") {
        const result = await sync({ provider: "avoma" });
        toast.success(`Imported ${result.calls} calls from Avoma.`);
      } else {
        await disconnect({ provider: "avoma" });
        toast.success("Avoma disconnected.");
      }
    } catch {
      toast.error(`Could not ${operation} Avoma. Check the connection and try again.`);
    } finally {
      setBusy(null);
    }
  };
  const run = runs?.[0];
  return (
    <IntegrationPage integration="avoma">
      <CallProviderCard
        config={config}
        connection={connections?.find((connection) => connection.provider === "avoma")}
        activeRun={run?.status === "in_progress" ? run : undefined}
        loading={connections === undefined}
        form={form}
        busy={busy}
        onFormChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))}
        onConnect={() => void perform("connect")}
        onSync={() => void perform("sync")}
        onDisconnect={() => void perform("disconnect")}
      />
    </IntegrationPage>
  );
}
