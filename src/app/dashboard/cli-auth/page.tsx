"use client";

import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, Loader2, ShieldCheck, ShieldX, TerminalSquare } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { ViewFrame } from "@/components/dashboard";

function formatTimestamp(value: number | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function CliTokenList() {
  const tokens = useQuery(api.cliAuth.list);
  const revoke = useMutation(api.cliAuth.revoke);

  if (!tokens || tokens.length === 0) return null;

  return (
    <div className="max-w-xl rounded-xl border border-border bg-card p-6">
      <h2 className="mb-1 text-sm font-medium">Paired CLIs</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Every paired CLI holds its own revocable token. Revoking immediately cuts that
        machine off from the organization&apos;s sync credentials.
      </p>
      <ul className="divide-y divide-border">
        {tokens.map((token) => (
          <li key={token._id} className="flex items-center justify-between gap-4 py-3 text-sm">
            <div>
              <div>{token.userName}</div>
              <div className="text-muted-foreground">
                Paired {formatTimestamp(token.createdAt)} · last used {formatTimestamp(token.lastUsedAt)}
              </div>
            </div>
            {token.revokedAt ? (
              <span className="text-muted-foreground">revoked</span>
            ) : (
              <button
                type="button"
                onClick={() => void revoke({ cliTokenId: token._id })}
                className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CliAuthForm() {
  const searchParams = useSearchParams();
  const approve = useMutation(api.cliAuth.approve);
  const [code, setCode] = useState(searchParams.get("code") ?? "");
  const normalizedCode = code.trim().toUpperCase();
  const pairing = useQuery(
    api.cliAuth.describe,
    normalizedCode.length >= 8 ? { userCode: normalizedCode } : "skip",
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { status: "approved" | "denied"; orgName: string | null }
    | { status: "error"; message: string }
    | null
  >(null);

  async function decide(decision: "approved" | "denied") {
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    try {
      const response = await approve({ userCode: code.trim(), decision });
      setResult({ status: decision, orgName: response.orgName });
    } catch (error) {
      setResult({
        status: "error",
        message: error instanceof Error ? error.message : "Approval failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void decide("approved");
  }

  return (
    <div className="max-w-xl rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-3">
        <TerminalSquare className="h-6 w-6 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">Authorize a fullstackgtm CLI</h2>
          <p className="text-sm text-muted-foreground">
            A CLI run of <code>fullstackgtm login --via</code> is waiting. Confirm the pairing
            code matches what the terminal shows, then approve. The CLI will use this
            organization&apos;s stored CRM credentials.
          </p>
        </div>
      </div>

      {result?.status === "approved" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-4 text-sm">
          <ShieldCheck className="h-5 w-5 text-primary" />
          CLI authorized for {result.orgName ?? "your organization"}. You can return to the
          terminal.
        </div>
      ) : result?.status === "denied" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-4 text-sm">
          <ShieldX className="h-5 w-5 text-destructive" />
          Pairing request denied.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Pairing code</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              className="w-48 rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm tracking-widest outline-none focus:border-primary"
            />
          </label>
          {normalizedCode.length >= 8 && pairing === null ? (
            <p className="text-sm text-muted-foreground">
              No pending request for that code. It may have expired or already been handled.
            </p>
          ) : null}
          {pairing ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/15 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div>
                <div>
                  Request from <span className="font-medium">{pairing.requesterLabel}</span>
                </div>
                <div className="text-muted-foreground">
                  Started {new Date(pairing.createdAt).toLocaleString()}. Approve only if you
                  recognize this device and started this login yourself — approving grants it
                  this organization&apos;s CRM access.
                </div>
              </div>
            </div>
          ) : null}
          {result?.status === "error" ? (
            <p className="text-sm text-destructive">{result.message}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !code.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Approve
            </button>
            <button
              type="button"
              disabled={submitting || !code.trim()}
              onClick={() => void decide("denied")}
              className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <ViewFrame title="CLI Pairing">
      <div className="space-y-6">
        <Suspense fallback={null}>
          <CliAuthForm />
        </Suspense>
        <CliTokenList />
      </div>
    </ViewFrame>
  );
}
