"use client";

import { Suspense, useMemo, useState } from "react";
import { notFound, useParams, useSearchParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";

function ProviderOAuthContent() {
  const params = useParams<{ provider: string }>();
  const searchParams = useSearchParams();
  const provider = params.provider;
  if (provider !== "hubspot" && provider !== "salesforce") notFound();

  const code = useMemo(() => (searchParams.get("code") ?? "").trim().toUpperCase(), [searchParams]);
  const connected = searchParams.get("connected") === "1";
  const pairing = useQuery(api.cliAuth.describe, code.length >= 8 ? { userCode: code } : "skip");
  const getHubspotAuthUrl = useAction(api.hubspotActions.getAuthUrl);
  const getSalesforceAuthUrl = useAction(api.salesforceActions.getAuthUrl);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerLabel = provider === "hubspot" ? "HubSpot" : "Salesforce";

  async function connect() {
    if (!code || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const result =
        provider === "hubspot"
          ? await getHubspotAuthUrl({ cliUserCode: code })
          : await getSalesforceAuthUrl({ cliUserCode: code });
      window.location.href = result.authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start OAuth");
      setConnecting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Connect {providerLabel} for CLI login</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Complete {providerLabel} consent in this browser. The CLI will receive only a
          fullstackgtm broker token; CRM refresh tokens stay server-side.
        </p>

        {connected ? (
          <div className="mt-6 flex items-start gap-2 rounded-lg border border-border bg-background p-4 text-sm">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
            <div>{providerLabel} connected. Return to your terminal to finish login.</div>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="text-sm">
              Pairing code: <span className="font-mono font-medium tracking-widest">{code || "missing"}</span>
            </div>
            {pairing ? (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/15 p-4 text-sm">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div>
                  <div>
                    Request from <span className="font-medium">{pairing.requesterLabel}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Started {new Date(pairing.createdAt).toLocaleString()}. Continue only if you
                    started this login yourself.
                  </div>
                </div>
              </div>
            ) : code.length >= 8 ? (
              <p className="text-sm text-muted-foreground">
                No pending request for that code. It may have expired or already been handled.
              </p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <button
              type="button"
              onClick={() => void connect()}
              disabled={connecting || !code || !pairing}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Connect {providerLabel}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function ProviderOAuthPage() {
  return (
    <Suspense fallback={null}>
      <ProviderOAuthContent />
    </Suspense>
  );
}
