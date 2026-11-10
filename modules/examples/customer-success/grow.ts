import type { CallFunctions, FeedItem, Intent, ReadDoc } from "../../kernel/calls.ts";
import { dailyUsage, domainOf, GROW_DEFAULTS, object, SIGNAL_KINDS, usageSignals, type GrowSettings, type Usage } from "./engine/usage.ts";

const docs = (value: unknown) => value as ReadDoc[];
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const usageOf = (doc: ReadDoc): Usage => ({ day: String(doc.data.day), metrics: doc.data.metrics as Usage["metrics"] });
const settingsOf = (doc: unknown): GrowSettings => ({ ...GROW_DEFAULTS, ...((doc as ReadDoc | null)?.data ?? {}) });
const sourceKey = async (id: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))), (n) => n.toString(16).padStart(2, "0")).join("");

export const growCalls: CallFunctions = {
  async onUsage(ctx, reads) {
    const day = dayOf(ctx.now);
    const accounts = new Set(docs(reads.accounts).map((a) => a.key));
    const domains = new Map<string, string[]>();
    for (const company of reads.companies as Array<{ id: string; domain?: string }>) {
      const domain = domainOf(company.domain);
      if (domain && accounts.has(company.id)) domains.set(domain, [...(domains.get(domain) ?? []), company.id]);
    }
    const usage = new Map<string, Pick<ReadDoc, "key" | "data">>(docs(reads.usage).map((u) => [u.key, u]));
    const writes = new Map<string, Intent>();
    for (const item of ctx.args.items as FeedItem[]) {
      if (![item.before, item.after].some((v) => typeof v?.type === "string" && v.type.startsWith("usage."))) continue;
      const source = await sourceKey(item.id);
      const removePrevious = () => {
        for (const row of usage.values()) {
          if (row.data.source !== source || Number(row.data.sourceAt) > item.at) continue;
          usage.delete(row.key);
          writes.set(`usage:${row.key}`, { op: "delete", collection: "usage", key: row.key, ifPresent: true });
        }
      };
      writes.set(`review:${source}`, { op: "delete", collection: "usageReview", key: source, ifPresent: true });
      const after = item.after;
      if (typeof after?.type !== "string" || !after.type.startsWith("usage.")) { removePrevious(); continue; }
      const domain = domainOf(object(after.subject) ? after.subject.domain : null);
      const daily = after.type === "usage.daily" ? dailyUsage(after.data, day) : "Only usage.daily aggregates are supported. Send raw events to your own aggregator.";
      const matches = domain ? domains.get(domain) ?? [] : [];
      const reason = typeof daily === "string" ? daily : !domain ? "Missing subject domain." : matches.length === 0 ? "No customer account has this domain." : matches.length > 1 ? "Multiple customer accounts have this domain." : null;
      if (reason || typeof daily === "string") {
        writes.set(`review:${source}`, { op: "put", collection: "usageReview", key: source, data: {
          source, domain: domain ?? "Unknown", day: object(after.data) && typeof after.data.day === "string" ? after.data.day.slice(0, 40) : "Unknown", reason: reason!,
        } });
        continue;
      }
      removePrevious();
      const account = matches[0], key = `${account}|${daily.day}`;
      const existing = usage.get(key);
      if (existing && Number(existing.data.sourceAt) > item.at) continue;
      const data = { account, ...daily, source, sourceAt: item.at };
      writes.set(`usage:${key}`, { op: "put", collection: "usage", key, parentKey: account, data });
      usage.set(key, { key, data });
    }
    return { intents: [...writes.values()] };
  },

  signals(ctx, reads) {
    const day = dayOf(ctx.now), settings = settingsOf(reads.settings);
    const usage = docs(reads.usage);
    const rows = docs(reads.accounts).filter((a) => Number(a.data.arr) > 0).flatMap((a) => {
      const dismissed = (a.data.dismissed ?? []) as string[];
      return usageSignals(usage.filter((u) => u.parentKey === a.key).map(usageOf), a.data, day, settings)
        .filter((s) => !dismissed.includes(s.kind))
        .map((s) => ({ ...s, account: a.key, companyName: a.data.companyName ?? a.key, arr: a.data.arr }));
    });
    const risk = rows.filter((r) => r.category === "Churn risk"), expansion = rows.filter((r) => r.category === "Expansion");
    const riskAccounts = new Set(risk.map((r) => r.account));
    return { value: { risk, expansion, riskArr: docs(reads.accounts).filter((a) => riskAccounts.has(a.key)).reduce((n, a) => n + Number(a.data.arr), 0), asOf: day } };
  },

  accountUsage(ctx, reads) {
    const account = reads.account as ReadDoc | null;
    if (!account) return { value: { rows: [], signals: [], summary: "No customer account is visible." } };
    const rows = docs(reads.usage).map(usageOf).sort((a, b) => a.day.localeCompare(b.day));
    const dismissed = (account.data.dismissed ?? []) as string[];
    const signals = Number(account.data.arr) > 0 ? usageSignals(rows, account.data, dayOf(ctx.now), settingsOf(reads.settings)).filter((s) => !dismissed.includes(s.kind)) : [];
    return { value: { rows: rows.filter((u) => u.metrics.active_users !== undefined).map((u) => ({ day: u.day, activeUsers: u.metrics.active_users })), signals,
      summary: rows.length ? `Last aggregate ${rows.at(-1)!.day}. Missing days are unknown; counts are daily active users.` : "No usage yet. Connect a signed usage.daily webhook in Settings > Feeds.",
    } };
  },

  restoreSignals(_ctx, reads) {
    const account = reads.account as ReadDoc | null;
    if (!account) throw new Error("Choose a visible account.");
    return { intents: [{ op: "patch", collection: "accounts", key: account.key, data: {}, unset: ["dismissed"], expect: [{ collection: "accounts", key: account.key, version: account.version }] }] };
  },

  dismissSignal(ctx, reads) {
    const account = reads.account as ReadDoc | null;
    if (!account || !SIGNAL_KINDS.includes(ctx.args.kind as typeof SIGNAL_KINDS[number])) throw new Error("Choose a visible account and a signal rule.");
    const dismissed = [...new Set([...(account.data.dismissed as string[] | undefined ?? []), String(ctx.args.kind)])];
    return { intents: [{ op: "patch", collection: "accounts", key: account.key, data: { dismissed }, expect: [{ collection: "accounts", key: account.key, version: account.version }] }] };
  },
};
