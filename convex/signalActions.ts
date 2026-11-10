"use node";
import { siteUrl } from "./lib/siteUrl";

/**
 * The signal check (convex/signals.ts): walk the org's accounts by fit, one
 * page per step, find each account's public job board (cached, misses too),
 * read its open roles and its website (sitemap, feed, homepage links) and save
 * what they show as signals. Reschedules itself between
 * pages, like the research runs. Read-only against the boards; it writes only
 * Canon's own signal rows.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildSignalsFromAts, DEFAULT_SIGNALS_CONFIG } from "../engine/src/signals.ts";
import { fetchAtsJobs, type AtsBoardSource, type AtsJob } from "../engine/src/connectors/atsBoards.ts";
import { clientFor } from "./records";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { MAX_ACCOUNTS, boardBelongsTo, discoverBoard } from "./lib/signals/boards";
import { signalDomain } from "./lib/signals/heat";
import { readWebsite, type WebGet, type WebsiteRead } from "./lib/signals/website";

const PAGE = 50;
const CONCURRENCY = 8;
/** A domain with no board is not probed again for this long. */
const MISS_TTL_MS = 14 * 24 * 60 * 60_000;
/** Roles kept per account, newest first: heat saturates well before this. */
const MAX_PER_ACCOUNT = 15;

const boardFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) });

/** The account's own site: public addresses only (the domain is user data), bounded, and no answer on failure. */
const webGet: WebGet = (url) =>
  publicHttpGet(url, {
    timeoutMs: 8_000, maxRedirects: 4, maxBytes: 3_000_000,
    headers: { "User-Agent": `canoncrm-signals/1 (+${siteUrl()})`, Accept: "text/html,application/xml,application/rss+xml,application/atom+xml,*/*;q=0.5" },
  }).then((r) => ({ status: r.status, text: new TextDecoder().decode(r.body), finalUrl: r.finalUrl })).catch(() => null);

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

type Cached = { source: AtsBoardSource | null; token: string | null; checkedAt: number };

export const runSlice = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<null> => {
    if (!integrationEnabled("treg")) return null;
    try {
      await slice(ctx, args.orgId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`signals: run for ${args.orgId} failed: ${message}`);
      await ctx.runMutation(internal.signals.failRun, { orgId: args.orgId, error: message });
    }
    return null;
  },
});

async function slice(ctx: ActionCtx, orgId: Id<"organizations">): Promise<void> {
  const state = await ctx.runQuery(internal.signals.runState, { orgId });
  if (!state) return;
  const page = await clientFor(ctx).list(orgId as string, { filter: {}, sort: { field: "fit", dir: "desc" }, cursor: state.cursor ?? undefined, limit: PAGE });
  const rows = page.rows.filter((r) => r.domain).slice(0, MAX_ACCOUNTS - state.checked);
  const names = new Map<string, string | undefined>(rows.map((r) => [signalDomain(r.domain), r.name]));
  const domains = [...names.keys()];
  const cached = new Map<string, Cached>((await ctx.runQuery(internal.signals.boardsFor, { orgId, domains })).map((b) => [b.domain, b]));
  const now = Date.now();

  const accounts = await pool(domains, CONCURRENCY, async (domain) => {
    const [board, website] = await Promise.all([readBoard(domain), readWebsite(domain, webGet, now).catch((): WebsiteRead | undefined => undefined)]);
    return { ...board, website };
  });

  const finished = !page.nextCursor || state.checked + rows.length >= MAX_ACCOUNTS;
  const saved = await ctx.runMutation(internal.signals.applySlice, { orgId, accounts: accounts.map(toArgs), nextCursor: finished ? null : page.nextCursor, finished });
  if (saved && !finished) await ctx.scheduler.runAfter(0, internal.signalActions.runSlice, { orgId });

  async function readBoard(domain: string) {
    const known = cached.get(domain);
    if (known?.source && known.token) {
      const jobs = await fetchAtsJobs({ source: known.source, boardToken: known.token, accountDomain: domain, fetchImpl: boardFetch });
      // A cached board that no longer proves it is this account's is dropped, with its signals unread.
      if (jobs.length && !boardBelongsTo(jobs, { domain, name: names.get(domain) })) return { domain, board: null, signals: undefined };
      return { domain, board: undefined, signals: toSignals(jobs, known.source, domain, now) };
    }
    if (known && now - known.checkedAt < MISS_TTL_MS) return { domain, board: undefined, signals: undefined }; // a remembered miss
    const found = await discoverBoard(domain, names.get(domain), boardFetch);
    if (found.hit) {
      const { source, token, jobs: open } = found.hit;
      return { domain, board: { source, token }, signals: toSignals(open, source, domain, now) };
    }
    // A miss is remembered, unless the probes failed in a way that says nothing about whether a board exists.
    return { domain, board: found.transient ? undefined : null, signals: undefined };
  }
}

/** The mutation's shape: a website read that vouched for nothing is left out. */
function toArgs<T extends { website?: WebsiteRead }>(account: T) {
  const { website, ...rest } = account;
  if (!website?.buckets.length) return rest;
  const buckets = website.buckets.filter((b): b is "site" | "blog" | "social" => b !== "job");
  return { ...rest, website: { buckets, signals: website.signals } };
}

/** Open roles as signals: each keeps the board's own quote of the role and links its posting. */
function toSignals(jobs: AtsJob[], source: AtsBoardSource, domain: string, now: number) {
  return buildSignalsFromAts(jobs.map((j) => ({ ...j, source })), { domain }, DEFAULT_SIGNALS_CONFIG, { now: new Date(now) })
    .filter((s) => s.sourceUrl)
    .map((s) => ({
      trigger: s.trigger, quote: s.quote, sourceUrl: s.sourceUrl, source, reposted: s.reposted,
      observedAt: s.publishedAt ? Date.parse(s.publishedAt) : undefined,
    }))
    .sort((a, b) => (b.observedAt ?? now) - (a.observedAt ?? now))
    // One signal per trigger, the newest: several open roles with one title are one change at the account.
    .filter((s, i, all) => all.findIndex((o) => o.trigger === s.trigger) === i)
    .slice(0, MAX_PER_ACCOUNT);
}
