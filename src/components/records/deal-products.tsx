"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { lineMoneyText, parseLineMoney, MAX_DEAL_LINES } from "../../../convex/lib/objects/lineItems";
import { formatCurrency, getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { saveProblem } from "./list-view";
import { btn } from "./record-parts";

type Draft = { key: string; id?: Id<"canonEntities">; version?: number; productId: string; quantity: string; unitPrice: string; totalPrice: string };
type Product = { id: string; title: string };

export function DealProducts({ deal, version, amount, currency, active, canEditAmount, title = "Products" }: { deal: Id<"canonEntities">; version: number; amount: number | null; currency: string; active: boolean; canEditAmount: boolean; title?: string }) {
  const data = useQuery(api.dealLineItems.forDeal, active ? { deal } : "skip");
  const replace = useMutation(api.dealLineItems.replace);
  const applyAmount = useMutation(api.dealLineItems.useAsAmount);
  const list = useAction(api.objects.list);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [expected, setExpected] = useState<Array<{ id: Id<"canonEntities">; version: number }>>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const decimals = 2;
  const money = (value: number) => formatCurrency(value, currency);

  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    let current = true;
    void list({ object: "product", limit: 200, filter: [{ field: "active", op: "eq", value: true }] }).then((page) => {
      if (current) setProducts(page.rows.map((p) => ({ id: p.id, title: p.title })));
    }).catch((cause) => { void toast.error(getErrorMessage(cause)); });
    return () => { current = false; };
  }, [editing, list]);

  if (!data) return null;
  const lines = data.lines;
  function begin() {
    setExpected(lines.map((l) => ({ id: l.id, version: l.version })));
    setDraft(lines.map((l) => ({ key: l.id, id: l.id, version: l.version, productId: String(l.productId ?? ""), quantity: String(l.quantity ?? 1), unitPrice: typeof l.unitPrice === "number" ? lineMoneyText(l.unitPrice, decimals) : "", totalPrice: typeof l.totalPrice === "number" ? lineMoneyText(l.totalPrice, decimals) : "" })));
  }
  const update = (index: number, change: Partial<Draft>) => setDraft((rows) => rows!.map((row, i) => i === index ? { ...row, ...change } : row));
  async function save() {
    setBusy(true);
    try {
      await replace({ deal, expected, lines: draft!.map((l) => ({ ...(l.id ? { id: l.id, version: l.version } : {}), productId: l.productId as Id<"canonEntities">, quantity: Number(l.quantity), unitPrice: l.unitPrice ? parseLineMoney(l.unitPrice, decimals) : null, totalPrice: parseLineMoney(l.totalPrice, decimals) })) });
      setDraft(null);
      void toast.success("Products saved");
    } catch (cause) { void toast.error(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function setAmount() {
    setBusy(true);
    try {
      const result = await applyAmount({ deal, expectedVersion: version, expected: lines.map((l) => ({ id: l.id, version: l.version })) });
      const problem = saveProblem(result);
      if (problem) void toast.error(problem);
      else void toast.success("Amount updated");
    } catch (cause) { void toast.error(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section className="border border-border bg-card p-4" aria-label={title}>
    <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{title}</h2>{active && data.editable && !draft && <button type="button" className={btn} onClick={begin}>Edit products</button>}</div>
    {draft ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="mb-3 text-xs text-muted-foreground">Enter each line&apos;s full total in {currency}, including its term and discounts. The total is independent of quantity and unit price.</p>
      <div className="space-y-3">{draft.map((row, i) => <fieldset key={row.key} disabled={busy} className="grid gap-2 border border-border p-3 sm:grid-cols-4">
        <legend className="px-1 text-xs">Line {i + 1}</legend>
        <label className="text-xs">Product<select aria-label={`Product ${i + 1}`} className="mt-1 w-full border border-border bg-background p-2 text-sm" value={row.productId} required onChange={(event) => update(i, { productId: event.target.value })}>
          <option value="">Choose a product</option>{row.productId && !products.some((p) => p.id === row.productId) && <option value={row.productId}>{String(lines.find((l) => l.id === row.id)?.name ?? "Current product")}</option>}{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select></label>
        <label className="text-xs">Quantity<input aria-label={`Quantity ${i + 1}`} type="number" min="1" step="1" required className="mt-1 w-full border border-border bg-background p-2 text-sm" value={row.quantity} onChange={(event) => update(i, { quantity: event.target.value })} /></label>
        <label className="text-xs">Unit price ({currency})<input aria-label={`Unit price ${i + 1}`} inputMode="decimal" className="mt-1 w-full border border-border bg-background p-2 text-sm" value={row.unitPrice} onChange={(event) => update(i, { unitPrice: event.target.value })} /></label>
        <label className="text-xs">Total ({currency})<input aria-label={`Total ${i + 1}`} inputMode="decimal" required className="mt-1 w-full border border-border bg-background p-2 text-sm" value={row.totalPrice} onChange={(event) => update(i, { totalPrice: event.target.value })} /></label>
        <div className="flex gap-2 sm:col-span-4">
          <button type="button" className={btn} disabled={i === 0} onClick={() => setDraft((rows) => { const next = [...rows!]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; return next; })}>Move up</button>
          <button type="button" className={btn} disabled={i === draft.length - 1} onClick={() => setDraft((rows) => { const next = [...rows!]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; return next; })}>Move down</button>
          <button type="button" className={btn} onClick={() => setDraft((rows) => rows!.filter((_, index) => index !== i))}>Remove</button>
        </div>
      </fieldset>)}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={busy || draft.length >= MAX_DEAL_LINES} onClick={() => setDraft((rows) => [...rows!, { key: crypto.randomUUID(), productId: "", quantity: "1", unitPrice: "", totalPrice: "" }])}>Add line</button>
        <button type="submit" className={btn} disabled={busy}>Save products</button><button type="button" className={btn} disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
        <Link className="text-xs underline" href="/dashboard/records/product">Product catalog</Link>
      </div>
    </form> : <>
      {!lines.length ? <p className="text-sm text-muted-foreground">No line items yet.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">Product</th><th className="p-2">Quantity</th><th className="p-2">Unit price</th><th className="p-2">Total</th></tr></thead><tbody>{lines.map((line) => <tr key={line.id} className="border-b border-border"><td className="p-2">{String(line.name ?? "Hidden")}</td><td className="p-2">{typeof line.quantity === "number" ? line.quantity : "Hidden"}</td><td className="p-2">{typeof line.unitPrice === "number" ? money(line.unitPrice) : "—"}</td><td className="p-2">{typeof line.totalPrice === "number" ? money(line.totalPrice) : "Hidden"}</td></tr>)}</tbody></table></div>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm"><p>Line items total {data.total === null ? "hidden" : money(data.total)}; amount {amount === null ? "not available" : money(amount)}.</p>{active && canEditAmount && lines.length > 0 && data.total !== null && <button type="button" className={btn} disabled={busy} onClick={() => void setAmount()}>Use as amount</button>}</div>
    </>}
  </section>;
}
