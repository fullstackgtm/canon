"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Check, Copy, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { agentClients, starterPrompt } from "@/lib/agentOnboarding";
import { api } from "../../../convex/_generated/api";

// Off until we've tried the agent flow on dev; set NEXT_PUBLIC_AGENT_GATE=true at build to lock again.
const AGENT_GATE_ENABLED = process.env.NEXT_PUBLIC_AGENT_GATE === "true";

// Pages that stay usable while locked: approving a headless agent's pairing code.
const UNGATED_PREFIXES = ["/dashboard/cli-auth"];

/**
 * Whether the dashboard is locked behind agent onboarding. False unless
 * NEXT_PUBLIC_AGENT_GATE is on, while loading, and on deployments where /mcp is off (MCP_REMOTE_ENABLED): an
 * agent could never connect there, so the gate would never lift.
 */
export function useAgentGate(pathname: string): { locked: boolean; domain: string | null } {
  const agent = useQuery(api.agentConnections.mine, {});
  const [mcpLive, setMcpLive] = useState(false);
  useEffect(() => {
    if (!AGENT_GATE_ENABLED) return;
    // The protected-resource metadata is a 404 exactly when /mcp is.
    fetch("/.well-known/oauth-protected-resource/mcp")
      .then((res) => setMcpLive(res.ok))
      .catch(() => setMcpLive(false));
  }, []);
  const ungated = UNGATED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  return { locked: mcpLive && agent?.connected === false && !ungated, domain: agent?.domain ?? null };
}

export function useOrigin(): string {
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_SITE_URL || "");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Agent onboarding, laid over a locked dashboard. Canon is set up and driven
 * from the user's own agent, so the app stays inert until an agent has signed
 * in to /mcp as this user (api.agentConnections.mine flips live when it does).
 */
export function AgentOnboardingOverlay({ domain }: { domain: string | null }) {
  const origin = useOrigin();
  const clients = agentClients(origin);
  const [clientId, setClientId] = useState(clients[0].id);
  const client = clients.find((c) => c.id === clientId) ?? clients[0];
  const prompt = starterPrompt(origin, domain);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/40 p-4 backdrop-blur-[2px] md:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-onboarding-title"
        className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <TerminalSquare className="mt-0.5 size-6 shrink-0 text-primary" />
          <div>
            <h2 id="agent-onboarding-title" className="text-base font-semibold">
              Run Canon from your agent
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Canon is set up and driven from Claude Code, Codex, Cursor or Claude. Connect yours and
              the workspace unlocks.
            </p>
          </div>
        </div>

        <section className="mt-6">
          <h3 className="text-xs font-medium text-muted-foreground">
            1 · Paste this into your agent
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            It connects Canon, confirms your ICP with you, picks sample accounts and starts account
            and contact research.
          </p>
          <div className="relative mt-2">
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 pr-24 font-mono text-[11px] leading-relaxed">
              {prompt}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton text={prompt} label="Copy prompt" />
            </div>
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-xs font-medium text-muted-foreground">
            2 · Or connect it yourself
          </h3>
          <div role="tablist" className="mt-2 flex flex-wrap gap-1">
            {clients.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === client.id}
                onClick={() => setClientId(c.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  c.id === client.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <ol className="mt-3 space-y-2 text-sm">
            {client.steps.map((step) => (
              <li key={step.text}>
                <div>{step.text}</div>
                {step.code && (
                  <div className="mt-1 flex items-start gap-2">
                    <pre className="flex-1 overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px]">
                      {step.code}
                    </pre>
                    <CopyButton text={step.code} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-sm text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          Waiting for your agent to sign in. This closes on its own.
        </div>
      </div>
    </div>
  );
}
