"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function LocalAuthForm({ setup, invite }: { setup: boolean; invite?: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = setup || Boolean(invite);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <form className="grid w-full max-w-sm gap-4 border border-border p-6" onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          const response = await fetch("/api/local-auth", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: registering ? "register" : "sign-in", email: form.get("email"), password: form.get("password"),
              ...(registering ? { name: form.get("name") } : {}), ...(setup && !invite ? { workspaceName: form.get("workspaceName"), setupCode: form.get("setupCode") } : {}), ...(invite ? { invite } : {}) }),
          });
          const result = await response.json();
          if (!response.ok) { setError(result.error || "Sign-in failed"); return; }
          window.location.assign("/dashboard");
        } catch { setError("Could not reach Canon. Try again."); }
        finally { setBusy(false); }
      }}>
        <h1 className="font-display text-2xl">{setup ? "Set up your workspace" : invite ? "Accept your invitation" : "Sign in to CanonCRM"}</h1>
        {setup && <p className="text-sm text-muted-foreground">Create the owner account for this install.</p>}
        {setup && !invite && <label className="grid gap-1 text-sm">Setup code<input className="h-10 border border-input bg-background px-3 font-mono uppercase" name="setupCode" required maxLength={64} autoComplete="one-time-code" spellCheck={false} /><span className="text-xs text-muted-foreground">Printed in this install&apos;s logs when it starts, or the CANON_SETUP_CODE you set.</span></label>}
        {setup && <label className="grid gap-1 text-sm">Workspace name<input className="h-10 border border-input bg-background px-3" name="workspaceName" required maxLength={100} autoComplete="organization" /></label>}
        {registering && <label className="grid gap-1 text-sm">Name<input className="h-10 border border-input bg-background px-3" name="name" required maxLength={100} autoComplete="name" /></label>}
        <label className="grid gap-1 text-sm">Email<input className="h-10 border border-input bg-background px-3" name="email" type="email" required maxLength={254} autoComplete="username" /></label>
        <label className="grid gap-1 text-sm">Password<input className="h-10 border border-input bg-background px-3" name="password" type="password" required minLength={registering ? 12 : 1} maxLength={256} autoComplete={registering ? "new-password" : "current-password"} /></label>
        {registering && <p className="text-xs text-muted-foreground">Use at least 12 characters.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Please wait..." : setup ? "Create owner account" : invite ? "Create account" : "Sign in"}</Button>
        {!registering && <p className="text-xs text-muted-foreground">Need an account? Ask your workspace admin for an invitation link.</p>}
      </form>
    </main>
  );
}
