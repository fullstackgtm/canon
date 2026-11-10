"use client";

import { useEffect, useState } from "react";
import type { SharePayload } from "../../../convex/lib/modules/shares";
import { VISIT_DEAD } from "../../../modules/kernel/visit";
import type { VisitorWrite } from "../../../modules/kernel/visit";
import { VisitorPage, type VisitorUploader } from "./visitor-page";

export function VisitReader({ grant, path }: { grant: string; path?: string }) {
  const [state, setState] = useState<{ payload?: SharePayload; error?: string; verificationRequired?: boolean }>({});
  const [email, setEmail] = useState(""), [code, setCode] = useState("");
  const [codeIssued, setCodeIssued] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function read() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const response = await fetch("/api/visit/page", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", signal: controller.signal, body: JSON.stringify({ publicId: grant, ...(path ? { path } : {}) }) });
        if (response.ok) setState({ payload: await response.json() });
        else if (response.status === 403 && (await response.json()).verificationRequired === true) setState({ verificationRequired: true });
        else setState({ error: response.status === 429 ? "Too many requests. Try again later." : VISIT_DEAD });
      } catch { if (!controller.signal.aborted) setState({ error: "This shared page could not load. Try again." }); }
      finally { pending = false; }
    }
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    const visible = () => void read();
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [grant, path, revision]);
  async function verify(requestCode: boolean) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/visit/${requestCode ? "request-code" : "verify-code"}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ publicId: grant, ...(requestCode ? { email } : { code }) }) });
      if (!response.ok) { setMessage(response.status === 429 ? "Too many requests. Try again later." : "Verification failed. Check the code or request a new one."); return; }
      setCode("");
      if (requestCode) { setCodeIssued(true); setMessage("If this email is allowed, a code will arrive shortly. It expires in 10 minutes."); }
      else { setState({}); setRevision((r) => r + 1); }
    } catch { setMessage("Verification is unavailable. Try again."); }
    finally { setBusy(false); }
  }
  async function run(input: VisitorWrite) {
    const { kind, ...body } = input;
    const response = await fetch(`/api/visit/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ publicId: grant, ...body }) });
    if (!response.ok) {
      setRevision((r) => r + 1);
      throw new Error(response.status === 429 ? "Too many changes. Try again later." : "This change could not be saved. Refresh the shared page and try again.");
    }
    setRevision((r) => r + 1);
  }
  function navigate(next: string) {
    if (/^[A-Za-z0-9_/-]+$/.test(next) && next.split("/").every((s) => s && s !== "." && s !== "..")) window.location.assign(`/r/v/${grant}/${next}`);
  }
  const upload: VisitorUploader = async (target, file) => {
    const response = await fetch("/api/visit/upload", { method: "POST", credentials: "same-origin", cache: "no-store", headers: {
      "Content-Type": "application/octet-stream", "x-canon-upload": encodeURIComponent(JSON.stringify({ publicId: grant, target, name: file.name })),
    }, body: file });
    if (!response.ok) throw new Error(response.status === 429 ? "The upload limit has been reached." : "This file could not be uploaded. Check its type and size.");
    return response.json();
  };
  async function download(file: string) {
    const response = await fetch("/api/visit/file", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicId: grant, file }) });
    if (!response.ok) throw new Error("This file is unavailable.");
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: state.payload?.files[file]?.name ?? "file" });
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  if (state.verificationRequired) return <main className="mx-auto max-w-lg space-y-5 px-6 py-16">
    <h1 className="text-xl font-semibold">Verify your email to open this page</h1>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void verify(true); }}>
      <label className="block text-sm">Your email<input className="mt-1 w-full border px-3 py-2" type="email" required autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button className="border px-3 py-2 text-sm disabled:opacity-50" disabled={busy}>{codeIssued ? "Request a new code" : "Email me a code"}</button>
    </form>
    {codeIssued && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void verify(false); }}>
      <label className="block text-sm">Six-digit code<input className="mt-1 w-full border px-3 py-2" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <button className="border px-3 py-2 text-sm disabled:opacity-50" disabled={busy}>Verify and open</button>
    </form>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </main>;
  return state.payload ? <VisitorPage payload={state.payload} navigate={navigate} run={run} upload={upload} download={download} /> : <main className="mx-auto max-w-lg px-6 py-16"><p role={state.error ? "alert" : "status"}>{state.error ?? "Loading shared page..."}</p></main>;
}
