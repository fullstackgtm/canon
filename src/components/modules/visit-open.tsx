"use client";

import { useEffect, useRef, useState } from "react";
import { VISIT_DEAD, VISIT_SECRET } from "../../../modules/kernel/visit";

export function VisitOpen() {
  const token = useRef("");
  const [identity, setIdentity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (window.location.hash) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", "/r");
    }
  }, []);
  async function open(form: FormData) {
    if (!VISIT_SECRET.test(token.current)) { setError(VISIT_DEAD); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/visit/open", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ token: token.current, ...(identity ? { name: form.get("name"), email: form.get("email") } : {}) }) });
      if (response.redirected) {
        const url = new URL(response.url);
        if (url.origin === window.location.origin && /^\/r\/v\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) { token.current = ""; window.location.replace(url.pathname); return; }
      }
      const result = await response.json();
      if (result.identityRequired) setIdentity(true);
      else setError(response.status === 429 ? "Too many requests. Try again later." : VISIT_DEAD);
    } catch { setError("This page could not open. Try again."); }
    setBusy(false);
  }
  return <form action={open} className="mt-6 space-y-4">{identity && <fieldset className="space-y-3"><legend className="mb-3 font-medium">Who are you?</legend><p className="text-sm text-muted-foreground">Your name and email are self-declared and will be shown as unverified.</p><label className="block text-sm">Name<input required name="name" maxLength={200} autoComplete="name" className="mt-1 block w-full border p-2" /></label><label className="block text-sm">Email<input required type="email" name="email" maxLength={320} autoComplete="email" className="mt-1 block w-full border p-2" /></label></fieldset>}<button disabled={busy} className="border border-border px-5 py-2 text-sm disabled:opacity-50">{busy ? "Opening..." : "Open"}</button>{error && <p role="alert" className="text-sm">{error}</p>}</form>;
}
