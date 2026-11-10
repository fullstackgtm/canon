"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Network, ScanSearch } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { EmptyState, LoadingRows } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { primary, secondary } from "@/components/field-standards/shared";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

const count = (n: number, noun: string, plural = `${noun}s`) => `${n.toLocaleString()} ${n === 1 ? noun : plural}`;

export const hierarchyHref = (groupId?: string) => `/dashboard/account-hierarchy${groupId ? `/${groupId}` : ""}`;

const RESEARCH_TONE: Record<string, string> = {
  running: "border-border bg-muted text-foreground",
  done: "border-primary/50 bg-primary/10 text-primary",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * Candidate groups of duplicate or misplaced companies across the workspace, from the latest read-only scan of Canon
 * (or of Salesforce, when connected). Research and proposals live on each group's page, where an approved parent move
 * on a Canon scan changes the parent in Canon. Nothing on these pages writes to a CRM.
 */
export function AccountHierarchyList() {
  const data = useQuery(api.accountHierarchy.overview, {});
  const startScan = useMutation(api.accountHierarchy.startScan);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  async function scan(source: "canon" | "salesforce") {
    setBusy(true);
    try {
      await startScan({ source });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (data === undefined) return <LoadingRows count={4} />;
  const scanState = data.scan;
  const reading = busy || scanState?.status === "reading";
  const source = scanState?.provider === "salesforce" ? "Salesforce" : "Canon";
  const needle = filter.trim().toLowerCase();
  const groups = needle ? data.groups.filter((g) => g.names.some((n) => n.toLowerCase().includes(needle)) || g.research?.groupName.toLowerCase().includes(needle)) : data.groups;

  return (
    <>
      <Panel title="Account hierarchy">
        <p className="mb-3 max-w-[78ch] text-sm text-muted-foreground">
          Finds companies that may be duplicates or sit in the wrong corporate family: a shared website domain, the same name once legal suffixes are
          dropped, or an enrichment vendor&apos;s parent that disagrees with the parent on record. Research checks each group on the web, citing a page and
          a word-for-word quote for every claim, and proposes merges, parent moves and field fixes for you to approve. An approved parent move changes the parent in
          Canon at once; merges and field fixes are only recorded for now. Nothing is written to Salesforce or HubSpot.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={primary} disabled={reading} onClick={() => void scan("canon")}>
            {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            {scanState ? "Scan companies again" : "Scan companies"}
          </button>
          {data.salesforceConnected && (
            <button type="button" className={secondary} disabled={reading} onClick={() => void scan("salesforce")}>
              Scan Salesforce instead
            </button>
          )}
          {scanState && (
            <span className="text-xs text-muted-foreground">
              {scanState.status === "reading" && `Reading every company in ${source} since ${new Date(scanState.startedAt).toLocaleTimeString()}…`}
              {scanState.status === "done" &&
                `Scanned ${source} ${new Date(scanState.finishedAt ?? scanState.startedAt).toLocaleString()}: ${count(scanState.accounts ?? 0, "company", "companies")}, ${count(scanState.groups ?? 0, "candidate group")}, ${(scanState.shellGroups ?? 0).toLocaleString()} with a bulk-created shell.`}
              {scanState.status === "failed" && <span className="text-destructive">Scan stopped: {scanState.error}</span>}
            </span>
          )}
        </div>
      </Panel>

      <PolicyPanel policy={data.policy} effective={data.effectivePolicy} />

      <Panel title="Candidate groups">
        {!scanState || scanState.status !== "done" || data.groups.length === 0 ? (
          <EmptyState icon={Network} title="No groups yet" description="Scan your companies to find candidate groups. A scan only reads." />
        ) : (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by company name"
              className="mb-3 h-8 w-full max-w-sm border border-input bg-background px-3 text-sm outline-none focus:border-primary"
            />
            <ul className="divide-y divide-border border border-border">
              {groups.map((g) => (
                <li key={g._id}>
                  <Link href={hierarchyHref(g._id)} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2 text-sm hover:bg-muted/50">
                    <span className="tabular-nums text-muted-foreground">{g.size}</span>
                    <span className="min-w-0">
                      <span className="block truncate">
                        {g.research?.groupName && <span className="record-name mr-2 font-medium">{g.research.groupName}</span>}
                        {g.names.join(" · ")}
                        {g.size > g.names.length && <span className="text-muted-foreground"> · +{g.size - g.names.length}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{g.reasons.join("; ")}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {g.shellCount > 0 && <span className="border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Shell</span>}
                      {g.research && (
                        <span className={cn("border px-2 py-0.5 text-xs font-medium", RESEARCH_TONE[g.research.status])}>
                          {g.research.status === "done" ? "Proposal" : g.research.status === "running" ? "Researching" : "Stopped"}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

function PolicyPanel({ policy, effective }: { policy: unknown; effective: unknown }) {
  const save = useMutation(api.accountHierarchy.savePolicy);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(JSON.stringify(policy ?? effective, null, 2));
  }, [policy, effective]);

  async function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error("The policy isn't valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await save({ policy: parsed });
      toast.success("Policy saved. It applies to the next scan and research.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Workspace policy">
      <p className="mb-2 max-w-[78ch] text-sm text-muted-foreground">
        The hard rules (owners never change, active contracts are flagged, nothing applies without approval) and the fields this workspace uses: the
        active-contract date on opportunities, customer status, the enrichment parent field, region by country, and bulk-created shell batches.
        {policy ? "" : " Showing the defaults; nothing is saved yet."}
      </p>
      <button type="button" className={secondary} onClick={() => setOpen(!open)}>
        {open ? "Hide policy" : "Edit policy"}
      </button>
      {open && (
        <div className="mt-3 grid gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-80 w-full border border-input bg-background p-3 font-mono text-xs outline-none focus:border-primary"
          />
          <div>
            <button type="button" className={primary} disabled={busy} onClick={() => void submit()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Save policy
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
