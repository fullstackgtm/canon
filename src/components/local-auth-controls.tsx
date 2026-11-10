"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Building2, LogOut } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function LocalInviteDialog() {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") { setLink(event.detail); setCopied(false); }
    };
    window.addEventListener("canon-local-invite", listener);
    return () => window.removeEventListener("canon-local-invite", listener);
  }, []);
  return <Dialog open={Boolean(link)} onOpenChange={(open) => { if (!open) setLink(""); }}>
    <DialogContent><DialogHeader><DialogTitle>Invite your team member</DialogTitle><DialogDescription>Share this link with the member. It expires in seven days and can be used once. Creating another link replaces it.</DialogDescription></DialogHeader>
      <input aria-label="Invitation link" className="w-full border border-input bg-background p-2 text-sm" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
      <Button onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy invitation link"}</Button>
    </DialogContent>
  </Dialog>;
}

export function LocalUserButton({ collapsed }: { collapsed?: boolean }) {
  const me = useQuery(api.users.me);
  const [error, setError] = useState("");
  return <div>
    <button type="button" className="flex items-center gap-2 text-sm text-sidebar-foreground/70" title="Sign out" onClick={async () => {
      try {
        const result = await fetch("/api/local-auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "sign-out" }) });
        if (!result.ok) throw new Error();
        window.location.assign("/sign-in");
      } catch { setError("Sign-out failed. Try again."); }
    }}><LogOut className="size-4" />{!collapsed && <span>{me?.name ?? "Sign out"}</span>}</button>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function LocalOrgSwitcher({ collapsed }: { collapsed?: boolean }) {
  const org = useQuery(api.organizations.current);
  return <div className={cn("flex items-center gap-2 border-b border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground/70", collapsed && "justify-center px-0")} title={org?.name}>
    <Building2 className="size-4 shrink-0" />{!collapsed && <span className="truncate">{org?.name ?? "Workspace"}</span>}
  </div>;
}
