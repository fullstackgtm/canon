"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "./ui/button";

type Flow = "signIn" | "signUp" | "email" | "email-code" | "reset" | "reset-verification";

export function ConvexSignIn({ google, emailEnabled }: { google: boolean; emailEnabled: boolean }) {
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => { if (isAuthenticated) window.location.assign("/dashboard"); }, [isAuthenticated]);
  const [flow, setFlow] = useState<Flow>("signIn");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    data.set("email", email.trim().toLowerCase());
    data.set("redirectTo", "/sign-in");
    const emailFlow = flow === "email" || flow === "email-code";
    if (!emailFlow) data.set("flow", flow);
    try {
      const result = await signIn(emailFlow ? "resend" : "password", data);
      if (flow === "email") setFlow("email-code");
      else if (flow === "reset") setFlow("reset-verification");
      else if (result.signingIn) window.location.assign("/dashboard");
    } catch { setError("Sign-in failed. Check your details and try again. Existing members must verify their email before linking a new login."); }
    finally { setBusy(false); }
  }
  return <main className="flex min-h-screen items-center justify-center bg-background p-6">
    <div className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6">
      <h1 className="text-xl font-semibold">{flow === "signUp" ? "Create your workspace" : "Sign in to CanonCRM"}</h1>
      {isAuthenticated ? <Link href="/dashboard">Continue to dashboard</Link> : <>
        {google && <Button className="w-full" variant="outline" onClick={() => { void signIn("google", { redirectTo: "/sign-in" }).catch(() => setError("Google sign-in failed. Try again.")); }}>Continue with Google</Button>}
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm">Email<input className="mt-1 w-full rounded border bg-background p-2" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {["signIn", "signUp", "reset-verification"].includes(flow) && <label className="block text-sm">{flow === "reset-verification" ? "New password" : "Password"}<input className="mt-1 w-full rounded border bg-background p-2" type="password" name={flow === "reset-verification" ? "newPassword" : "password"} autoComplete={flow === "signIn" ? "current-password" : "new-password"} minLength={8} required /></label>}
          {(flow === "email-code" || flow === "reset-verification") && <label className="block text-sm">Code from your email<input className="mt-1 w-full rounded border bg-background p-2" name="code" autoComplete="one-time-code" required /></label>}
          {flow === "email-code" && <p className="text-sm">Check your email for a sign-in link or enter the code.</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Please wait…" : flow === "email" || flow === "reset" ? "Send email" : flow === "signUp" ? "Create account" : "Continue"}</Button>
        </form>
        <div className="flex flex-wrap gap-3 text-sm">
          <button onClick={() => { setFlow(flow === "signIn" ? "signUp" : "signIn"); setError(""); }}>{flow === "signIn" ? "Create an account" : "Use password sign-in"}</button>
          {emailEnabled && <><button onClick={() => setFlow("email")}>Email me a link or code</button><button onClick={() => setFlow("reset")}>Reset password</button></>}
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </main>;
}

export function ConvexUserButton({ collapsed }: { collapsed?: boolean }) {
  const { signOut } = useAuthActions();
  const me = useQuery(api.users.me);
  const [error, setError] = useState(false);
  return <div><button className="text-sm text-sidebar-foreground/70" title="Sign out" onClick={() => { void signOut().then(() => window.location.assign("/sign-in")).catch(() => setError(true)); }}>{collapsed ? "Sign out" : `${me?.name ?? "Account"} · Sign out`}</button>{error && <p role="alert">Sign-out failed. Try again.</p>}</div>;
}
