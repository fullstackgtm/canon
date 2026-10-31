"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Domain-first onboarding: the submit starts an anonymous research session
 * (ICP -> TAM search) and routes to its live progress page at /start/<token>.
 */
export function DomainStartForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [examples, setExamples] = useState<{ domain: string; name: string }[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/lead-magnet/examples", { signal: controller.signal }).then(async (response) => {
      if (response.ok) setExamples(await response.json());
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const inputId = useId();
  const [domain, setDomain] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  function start(event: FormEvent) {
    event.preventDefault();
    void begin(domain, false);
  }

  async function begin(websiteDomain: string, example: boolean) {
    setError("");
    setStarting(true);
    try {
      const response = await fetch("/api/lead-magnet/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: websiteDomain, website: honeypot, example }),
      });
      const payload = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? "Could not start. Try again.");
      router.push(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start. Try again.");
      setStarting(false);
    }
  }

  return (
    <form className="domain-form" onSubmit={start}>
      <label htmlFor={inputId}>Your company website</label>
      <div className="domain-row">
        <span>https://</span>
        <input
          id={inputId}
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="yourcompany.com"
          autoComplete="url"
          autoFocus={autoFocus}
          required
        />
        <button className="btn btn--primary" disabled={starting}>
          {starting ? "Starting…" : "Research my company"}
        </button>
      </div>
      {/* Honeypot: hidden from people, filled by naive bots; the server rejects any value. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={honeypot}
        onChange={(event) => setHoneypot(event.target.value)}
        style={{ position: "absolute", left: "-10000px", width: 1, height: 1, opacity: 0 }}
      />
      {error && <p className="domain-error" role="alert">{error}</p>}
      <p className="domain-note">Research uses public website and company data. Workspace access is by invitation.</p>
      {!!examples?.length && <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Cached company examples">
        <span>Example research</span>
        {examples.map((example) => <button key={example.domain} type="button" disabled={starting} onClick={() => void begin(example.domain, true)} className="min-h-11 rounded-sm border border-current/20 px-3 disabled:opacity-50">{example.name}</button>)}
        <span className="w-full opacity-60">Saved public research. No new search is run.</span>
      </div>}
    </form>
  );
}
