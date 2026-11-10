"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

/** GitHub's return lands on Settings with ?github=<logins> or ?github_error=<message> (src/app/api/recipes/github/setup). */
function useSetupResult() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("github"), error = url.searchParams.get("github_error");
    if (connected === null && error === null) return;
    if (connected) toast.success(`Connected to ${connected.split(",").join(", ")} on GitHub`);
    if (error) toast.error(error);
    url.searchParams.delete("github"); url.searchParams.delete("github_error");
    window.history.replaceState(null, "", url);
  }, []);
}

function Repos({ installationId }: { installationId: number }) {
  const list = useAction(api.githubRecipes.repositories);
  const [repos, setRepos] = useState<Array<{ fullName: string; private: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    list({ installationId }).then((r) => { if (live) setRepos(r); }, (e) => { if (live) setError(getErrorMessage(e)); });
    return () => { live = false; };
  }, [installationId, list]);
  if (error) return <p className="mt-1 text-xs text-destructive">{error}</p>;
  if (!repos) return <p className="mt-1 text-xs text-muted-foreground">Reading its repos…</p>;
  if (!repos.length) return <p className="mt-1 text-xs text-muted-foreground">It can't read any repos yet. Pick some in the App&apos;s settings on GitHub.</p>;
  return <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{repos.map((r) => `${r.fullName}${r.private ? "" : " (public)"}`).join(" · ")}</p>;
}

/**
 * Private recipe repos (docs/recipes.md, R5b): the GitHub accounts this workspace connected Canon's GitHub App to.
 * An install from one of their private repos reads through the connection; the source text stays the same.
 */
export function GithubConnections() {
  const view = useQuery(api.githubRecipes.connections);
  const start = useAction(api.githubRecipes.startConnect);
  const disconnect = useMutation(api.githubRecipes.disconnect);
  const [busy, setBusy] = useState(false);
  useSetupResult();
  if (!view) return null;
  if (!view.configured) return view.canEdit ? <p className="mt-5 text-xs text-muted-foreground">Installing from private repos needs Canon&apos;s GitHub App, which isn&apos;t set up on this deployment.</p> : null;

  async function onConnect() {
    setBusy(true);
    try { window.location.assign((await start({})).url); } catch (e) { toast.error(getErrorMessage(e)); setBusy(false); }
  }
  async function onDisconnect(installationId: number, login: string) {
    setBusy(true);
    try {
      await disconnect({ installationId });
      toast.success(`Disconnected ${login}. To revoke access on GitHub too, uninstall Canon's App in that account's settings.`);
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Private repos on GitHub</p>
        {view.canEdit && <button type="button" className={btn} disabled={busy} onClick={() => void onConnect()}>Connect GitHub</button>}
      </div>
      {view.connections.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">Connect Canon&apos;s GitHub App to an organization and pick repos, then install from them as from a public repo.</p>
      )}
      <ul className="mt-2 divide-y divide-border border-y border-border">
        {view.connections.map((c) => (
          <li key={c.installationId} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p>Connected to {c.account.login} <span className="text-xs font-medium text-muted-foreground"> · {c.account.type === "User" ? "user" : "organization"} · by {c.connectedBy}</span></p>
              {view.canEdit && <button type="button" className={btn} disabled={busy} onClick={() => void onDisconnect(c.installationId, c.account.login)}>Disconnect</button>}
            </div>
            <Repos installationId={c.installationId} />
          </li>
        ))}
      </ul>
    </div>
  );
}
