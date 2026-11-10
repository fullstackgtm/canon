"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useAction, useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { nameFromDomain } from "../../../convex/lib/peopleSources";
import { MAX_TARGET_ACCOUNTS, parseAccountList, type Market, type Persona } from "../../../convex/lib/addRecords";
import type { IcpExclude, IcpSpec } from "../../../modules/kernel/icpSpec";
import { Chips, ExcludeFields, MarketFields, PersonaFields, excludeCount, input, label } from "@/components/crm/icp-fields";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { PaidSourcesTab } from "@/components/crm/paid-sources-tab";
import { SelectField } from "@/components/ui/select";
import { resolveFillPrefill } from "@/lib/fill-prefill";

type Tab = "accounts" | "market" | "paid" | "one";

const primary = "flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";

function AccountsTab({ persona, setPersona, exclude, onStarted }: { persona: Persona; setPersona: (p: Persona) => void; exclude: IcpExclude; onStarted: () => void }) {
  const start = useAction(api.addRecords.startAccounts);
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = useMemo(() => parseAccountList(text), [text]);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const r = await start({ text, persona, exclude });
      void toast.success(`Finding the buyers at ${r.accounts.toLocaleString()} accounts. Review what it finds before anything is added.`);
      if (r.invalid.length) void toast.warning(`Skipped ${r.invalid.length} lines that aren't domains, e.g. "${r.invalid[0]}".`);
      setText("");
      onStarted();
      router.push(`/dashboard/imports/${r.jobId}`);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setText(await file.text());
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className={label}>Companies: one domain per line, optionally followed by a name, or a CSV with a domain column</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"acme.com\nglobex.com, Globex Corporation\nhttps://www.initech.com"}
          className={`${input} font-mono text-xs`}
          aria-label="Company domains"
        />
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {parsed.accounts.length.toLocaleString()} {parsed.accounts.length === 1 ? "company" : "companies"}
            {parsed.invalid.length > 0 && ` · ${parsed.invalid.length} lines aren't domains`}
            {parsed.accounts.length > MAX_TARGET_ACCOUNTS && ` · at most ${MAX_TARGET_ACCOUNTS.toLocaleString()} per run`}
          </span>
          <label className="cursor-pointer underline-offset-2 hover:underline">
            Upload CSV
            <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
          </label>
        </div>
      </div>
      <PersonaFields value={persona} onChange={setPersona} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Free. You review what it finds before anything is added.</p>
        <button type="button" onClick={() => void run()} disabled={busy || !parsed.accounts.length || parsed.accounts.length > MAX_TARGET_ACCOUNTS} className={primary}>
          {busy && <Loader2 className="size-3 animate-spin" />} Add accounts and buyers
        </button>
      </div>
    </div>
  );
}

function MarketTab({ market, setMarket, persona, setPersona, exclude, setExclude, onStarted }: {
  market: Market; setMarket: (m: Market) => void; persona: Persona; setPersona: (p: Persona) => void;
  exclude: IcpExclude; setExclude: (e: IcpExclude) => void; onStarted: () => void;
}) {
  const preview = useAction(api.addRecords.previewMarket);
  const start = useAction(api.addRecords.startMarket);
  const router = useRouter();
  const [busy, setBusy] = useState<"preview" | "start" | null>(null);
  const [error, setError] = useState("");
  const [preview_, setPreview] = useState<{ key: string; value: Awaited<ReturnType<typeof preview>> } | null>(null);
  const narrow = market.industries.length > 0 || market.countries.length > 0 || market.employeeBands.length > 0;
  // A preview describes the filters it ran with: show it only while they are unchanged.
  const key = JSON.stringify({ market, persona, exclude });
  const result = preview_?.key === key ? preview_.value : null;

  async function act(kind: "preview" | "start") {
    setBusy(kind);
    setError("");
    try {
      if (kind === "preview") setPreview({ key, value: await preview({ market, persona, exclude }) });
      else {
        const { jobId } = await start({ market, persona, exclude });
        void toast.success("Searching this market. Review what it finds before anything is added.");
        onStarted();
        router.push(`/dashboard/imports/${jobId}`);
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3">
      <MarketFields value={market} onChange={setMarket} />
      <PersonaFields value={persona} onChange={setPersona} />
      <details className="border border-border px-3 py-2" open={excludeCount(exclude) > 0}>
        <summary className={`${label} cursor-pointer`}>Exclude{excludeCount(exclude) ? ` (${excludeCount(exclude)})` : ""}</summary>
        <div className="pt-3"><ExcludeFields value={exclude} onChange={setExclude} /></div>
      </details>
      {result && (
        <div className="grid gap-1 border border-border p-3 text-xs">
          <p className="text-sm">
            {result.total === null ? "The preview source returned no count." : `About ${result.total.toLocaleString()} people match.`}
          </p>
          {result.sample.map((s, i) => (
            <p key={i} className="text-muted-foreground">{s.name}{s.title ? ` · ${s.title}` : ""} · {s.company}</p>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{narrow ? "Free. You review what it finds before anything is added." : "Pick an industry, size or location first."}</p>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => void act("preview")} disabled={busy !== null || !narrow} className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium hover:border-primary disabled:opacity-60">
            {busy === "preview" && <Loader2 className="size-3 animate-spin" />} Preview
          </button>
          <button type="button" onClick={() => void act("start")} disabled={busy !== null || !narrow} className={primary}>
            {busy === "start" && <Loader2 className="size-3 animate-spin" />} Fill from this market
          </button>
        </div>
      </div>
    </div>
  );
}

function OneRecordTab({ initial, onDone }: { initial: "account" | "contact"; onDone: () => void }) {
  const upsert = useAction(api.records.upsert);
  const [object, setObject] = useState<"account" | "contact">(initial);
  const [f, setF] = useState({ domain: "", name: "", fullName: "", email: "", title: "", linkedinUrl: "", accountDomain: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  const ready = object === "account" ? f.domain.trim() && f.name.trim() : f.fullName.trim() && f.accountDomain.trim();

  async function save() {
    setBusy(true);
    setError("");
    try {
      const idempotencyKey = crypto.randomUUID();
      if (object === "account") {
        const domain = parseAccountList(f.domain).accounts[0]?.domain;
        if (!domain) throw new Error(`"${f.domain.trim()}" is not a domain.`);
        await upsert({ object, accounts: [{ domain, name: f.name.trim() }], idempotencyKey });
      } else {
        const accountDomain = parseAccountList(f.accountDomain).accounts[0]?.domain;
        if (!accountDomain) throw new Error(`"${f.accountDomain.trim()}" is not a domain.`);
        // A contact attaches to an account by domain: make sure it exists (fill-only, so an existing one is untouched).
        await upsert({ object: "account", accounts: [{ domain: accountDomain, name: nameFromDomain(accountDomain) }], idempotencyKey: `${idempotencyKey}:account` });
        await upsert({
          object,
          contacts: [{ fullName: f.fullName.trim(), email: opt(f.email), title: opt(f.title), linkedinUrl: opt(f.linkedinUrl), accountDomain }],
          idempotencyKey,
        });
      }
      void toast.success(object === "account" ? `Added ${f.name.trim()}.` : `Added ${f.fullName.trim()}.`);
      setF({ domain: "", name: "", fullName: "", email: "", title: "", linkedinUrl: "", accountDomain: "" });
      onDone();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof f, text: string, placeholder: string) => (
    <label className="grid gap-1">
      <span className={label}>{text}</span>
      <input value={f[k]} onChange={set(k)} placeholder={placeholder} className={input} />
    </label>
  );

  return (
    <div className="grid gap-3">
      <Chips options={[{ value: "account", label: "Account" }, { value: "contact", label: "Contact" }]} value={[object]} onChange={(next) => setObject((next.find((v) => v !== object) ?? object) as "account" | "contact")} />
      {object === "account" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("domain", "Domain", "acme.com")}
          {field("name", "Name", "Acme Inc")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("fullName", "Full name", "Jane Doe")}
          {field("accountDomain", "Company domain", "acme.com")}
          {field("title", "Title", "VP Sales")}
          {field("email", "Email", "jane@acme.com")}
          {field("linkedinUrl", "LinkedIn URL", "https://www.linkedin.com/in/…")}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">A record that already exists only gains the fields it was missing.</p>
        <button type="button" onClick={() => void save()} disabled={busy || !ready} className={primary}>
          {busy && <Loader2 className="size-3 animate-spin" />} Add {object}
        </button>
      </div>
    </div>
  );
}

/** Changes as the workspace's latest fill makes progress: a dependency for reloading a record list. */
export function useFillTick(): string | null | undefined {
  return useQuery(api.addRecords.fillTick);
}

/**
 * Add records: name companies (and find their buyers), fill from a market,
 * or add one record by hand. The first two run free population sources and
 * need an admin or manager; anyone can add one record.
 */
export function AddRecordsDialog({ open, onOpenChange, object = "account", icpId, onAdded }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which record the "one record" form starts on. */
  object?: "account" | "contact";
  /** Explicit current active ICP intent. An unavailable key refuses instead of using defaults. */
  icpId?: string;
  /** A record was written directly (the one-record form): the page can reload. */
  onAdded?: () => void;
}) {
  const explicit = icpId !== undefined;
  const queries = useMemo<RequestForQueries>(() => open ? {
    context: { query: api.addRecords.context, args: {} },
    ...(explicit ? { source: { query: api.icpsInterface.list, args: {} } } : {}),
  } : {}, [open, explicit]);
  // useQueries returns errors as values so an explicit link can refuse inside the dialog.
  const results = useQueries(queries);
  const ctx = results.context as FunctionReturnType<typeof api.addRecords.context> | undefined | Error;
  const source = results.source as FunctionReturnType<typeof api.icpsInterface.list> | undefined | Error;
  const prefill = resolveFillPrefill(icpId, source, ctx);
  const initial = prefill.status === "ready" ? prefill.icp : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Add records</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          Add companies you name and the buyers at them, fill from a whole market, or add one record by hand. Searches use
          free data sources and wait for your review; approved records fill only empty fields, so nothing you have edited is overwritten.
        </DialogDescription>
        {open && (prefill.status === "refused" ? (
          <p role="alert" className="text-sm text-destructive">{prefill.reason}</p>
        ) : ctx instanceof Error || ctx === null ? (
          <p role="alert" className="text-sm text-destructive">Add records could not load your workspace. Close this dialog and try again.</p>
        ) : ctx === undefined || prefill.status === "loading" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading current ICP settings...</p>
        ) : (
          <AddRecordsBody key={JSON.stringify([object, prefill.status === "ready" ? prefill.revision : null])} ctx={ctx} object={object} initial={initial} onAdded={onAdded} close={() => onOpenChange(false)} />
        ))}
      </DialogContent>
    </Dialog>
  );
}

type Context = NonNullable<FunctionReturnType<typeof api.addRecords.context>>;

/** The tabs, mounted once the context has loaded so the forms start from a saved ICP. */
function AddRecordsBody({ ctx, object, initial, onAdded, close }: { ctx: Context; object: "account" | "contact"; initial?: { key: string; spec: IcpSpec }; onAdded?: () => void; close: () => void }) {
  const names = useObjectLabels();
  const canRun = ctx.canRun && ctx.configured;
  const [tab, setTab] = useState<Tab>(canRun ? (initial ? "market" : "accounts") : "one");
  const [from, setFrom] = useState<string | null>(initial?.key ?? ctx.start.icpId);
  const startSpec: IcpSpec = initial?.spec ?? ctx.start.spec;
  const [market, setMarket] = useState<Market>(startSpec.market);
  const [persona, setPersona] = useState<Persona>(startSpec.persona);
  const [exclude, setExclude] = useState<IcpExclude>(startSpec.exclude);

  function pick(id: string) {
    const icp = initial?.key === id ? initial : ctx.icps.find((i) => i.key === id);
    if (!icp) return;
    setFrom(icp.key);
    setMarket(icp.spec.market);
    setPersona(icp.spec.persona);
    setExclude(icp.spec.exclude);
  }

  return (
    <>
      {!ctx.configured && ctx.canRun && (
        <p className="border border-border px-3 py-2 text-xs text-muted-foreground">Data search is off. Needs TREG_TOKEN. You can add a record by hand.</p>
      )}
      {canRun && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={label}>Start from ICP</span>
          {ctx.icps.length ? (
            <SelectField value={from ?? ""} onValueChange={pick} aria-label="Start from ICP" placeholder="Choose an ICP"
              options={ctx.icps.map((i) => ({ value: i.key, label: `${i.name}${i.isDefault ? " (default)" : ""}` }))} />
          ) : (
            <span className="text-muted-foreground">No saved ICPs yet.</span>
          )}
          <Link href="/dashboard/icps" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Manage ICPs</Link>
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="line">
          <TabsTrigger value="accounts" disabled={!canRun}>{names("account")!.pluralLabel}</TabsTrigger>
          <TabsTrigger value="market" disabled={!canRun}>Market</TabsTrigger>
          <TabsTrigger value="paid" disabled={!canRun}>Paid sources</TabsTrigger>
          <TabsTrigger value="one">One record</TabsTrigger>
        </TabsList>
        {!canRun && <p className="text-xs text-muted-foreground">Ask an admin or manager to add companies or fill from a market.</p>}
        <TabsContent value="accounts" className="pt-2">
          <AccountsTab persona={persona} setPersona={setPersona} exclude={exclude} onStarted={close} />
        </TabsContent>
        <TabsContent value="market" className="pt-2">
          <MarketTab market={market} setMarket={setMarket} persona={persona} setPersona={setPersona} exclude={exclude} setExclude={setExclude} onStarted={close} />
        </TabsContent>
        <TabsContent value="paid" className="pt-2">
          <PaidSourcesTab market={market} persona={persona} onStarted={close} />
        </TabsContent>
        <TabsContent value="one" className="pt-2">
          <OneRecordTab initial={object} onDone={() => onAdded?.()} />
        </TabsContent>
      </Tabs>
    </>
  );
}
