"use client";

import type { ViewFilter } from "../../../convex/lib/objects/validators";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { statusListed, type ListRow, type ListSort, type ProjectedThrough } from "../../../convex/lib/objects/listSpec";
import { projectedPast } from "../../../convex/lib/objects/views";
import { useRecordsSaved } from "./record-context";
import { getErrorMessage } from "@/lib/utils";

export type ListedObject = "account" | "contact" | "deal" | "lead" | "task" | "note" | "call" | "meeting" | "product" | "lineItem";
export type Save = { shard: number; seq: number };

/** Rows the live overlay covers; `objects.hotRows` reads at most 100 ids. */
const OVERLAY_MAX = 100;
const PAGE = 50;
/** How long to wait for the projector to pass a save before showing the list anyway. */
const CATCH_UP_MS = 4000;
const CATCH_UP_POLL_MS = 150;
/** After that, keep checking in the background, more slowly, so a lagging projector still lands the save. */
const LATE_POLL_MS = 1500;
const LATE_POLL_UNTIL_MS = 120_000;
/** Wait after seeing someone else's edit before refetching the page it may have moved. */
const STALE_RELOAD_MS = 800;
/** Refetches per observed edit, backing off from STALE_RELOAD_MS: about two minutes in all. */
const STALE_RETRIES = 10;
/**
 * Records the page has never shown (created elsewhere, or edited into the
 * filters) can only arrive by refetching: refresh the first page this often
 * while the tab is visible. A list paged past its first page is left alone,
 * so a refresh never collapses what the user scrolled to.
 */
const BACKGROUND_REFRESH_MS = 30_000;

export type ListQuery = { object: ListedObject; filter: ViewFilter[]; sort?: ListSort; deleted?: boolean; limit?: number };

/**
 * One list view's rows. Membership, order and the total come from the
 * projection (`objects.list`, an action); the cells of the first rows are
 * overlaid with `objects.hotRows`, so an edit shows at once and other people's
 * edits arrive live. `afterSaves` re-queries until the projection has caught up
 * with the given saves, so a created or deleted record joins or leaves the list.
 */
export function useObjectList(
  query: ListQuery | null,
  opts: {
    /**
     * What decides membership and order: fieldIds, or the system columns
     * `$updatedAt`, `$createdAt` and `$title` (a `$` never starts a fieldId;
     * a lead's job title is the field `title`). When a live row changes one of
     * them, or its lifecycle, through someone else's edit, the page is stale.
     */
    watch?: readonly string[];
    /** Called instead of reloading this list when it goes stale (a board reloads every column). */
    onStale?: () => void;
  } = {},
) {
  const list = useAction(api.objects.list);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const key = query ? JSON.stringify(query) : null;
  // A response for an older query must not overwrite a newer one.
  const generation = useRef(0);
  // A reload started from an older render (a bulk action that outlived a filter change) refreshes the current query.
  const currentKey = useRef(key);
  // Bumped whenever the first page replaces the rows.
  const rowsEpoch = useRef(0);
  currentKey.current = key;

  const fetchFirst = useCallback(async (q: ListQuery) => {
    const { object, filter, sort, deleted, limit } = q;
    return list({ object, filter, ...(sort ? { sort } : {}), ...(deleted ? { deleted } : {}), limit: limit ?? PAGE });
  }, [list]);

  const reload = useCallback(async (saves: readonly Save[] = []) => {
    const k = currentKey.current;
    if (!k) return;
    const q = JSON.parse(k) as ListQuery;
    const mine = ++generation.current;
    const started = Date.now();
    const show = (page: Awaited<ReturnType<typeof fetchFirst>>) => {
      rowsEpoch.current++;
      setRows(page.rows);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError("");
    };
    const caughtUp = (page: Awaited<ReturnType<typeof fetchFirst>>) => projectedPast(page.projectedThrough as ProjectedThrough, saves);
    try {
      let page = await fetchFirst(q);
      while (!caughtUp(page) && Date.now() - started < CATCH_UP_MS) {
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS));
        if (mine !== generation.current) return;
        page = await fetchFirst(q);
      }
      if (mine !== generation.current) return;
      show(page);
      // Still behind: show what there is, and replace it once the projector passes the saves.
      while (!caughtUp(page) && Date.now() - started < LATE_POLL_UNTIL_MS) {
        await new Promise((resolve) => setTimeout(resolve, LATE_POLL_MS));
        if (mine !== generation.current) return;
        page = await fetchFirst(q);
        if (mine !== generation.current) return;
        if (caughtUp(page)) show(page);
      }
    } catch (cause) {
      if (mine === generation.current) setError(getErrorMessage(cause));
    }
  }, [fetchFirst]);

  useRecordsSaved((saves) => void reload(saves));

  useEffect(() => {
    setError("");
    setRows(null);
    setCursor(null);
    void reload();
    // Unmounting, or moving to another query, abandons any reload still polling.
    return () => {
      // A counter, not a DOM node: bumping its latest value is the point.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [key, reload]);

  const loadMore = useCallback(async () => {
    if (!key || !cursor || loadingMore) return;
    const q = JSON.parse(key) as ListQuery;
    const mine = generation.current;
    // A page continues the rows its cursor came from; if a refresh replaced them meanwhile, appending would skip records.
    const epoch = rowsEpoch.current;
    setLoadingMore(true);
    try {
      const page = await list({ object: q.object, filter: q.filter, ...(q.sort ? { sort: q.sort } : {}), ...(q.deleted ? { deleted: true } : {}), limit: PAGE, cursor });
      if (mine !== generation.current || epoch !== rowsEpoch.current) return;
      setRows((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (mine === generation.current) setError(getErrorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [key, cursor, loadingMore, list]);

  // Register rows (accounts, contacts) carry record-service ids, not streams, and an edit returns once its row is written back.
  const register = query?.object === "account" || query?.object === "contact";
  const overlayIds = useMemo(() => (register ? [] : (rows ?? []).slice(0, OVERLAY_MAX).map((r) => r.id as Id<"canonEntities">)), [rows, register]);
  const live = useQuery(api.objects.hotRows, overlayIds.length ? { streamIds: overlayIds } : "skip");

  const shown = useMemo(() => {
    if (!rows) return null;
    const byId = new Map((live ?? []).flatMap((r) => (r ? [[r.streamId as string, r] as const] : [])));
    const deleted = Boolean(query?.deleted);
    return rows.flatMap((row) => {
      const hot = byId.get(row.id);
      if (!hot || hot.version < row.version) return [row];
      // Deleted or restored since the page loaded: it leaves this list until the next reload.
      if (!statusListed(hot.lifecycle.status, deleted)) return [];
      // A hot row holds no formula or rollup values (CP7c): the listed row's stay until the next read.
      return [{ ...row, version: hot.version, title: hot.title, values: { ...row.values, ...(hot.values as ListRow["values"]) }, updatedAt: hot.updatedAt, status: hot.lifecycle.status }];
    });
  }, [rows, live, query?.deleted]);

  const firstPageOnly = rows !== null && rows.length <= (query?.limit ?? PAGE);
  useEffect(() => {
    if (!key || !firstPageOnly) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, BACKGROUND_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key, firstPageOnly, reload]);

  // Rows whose live version changed something the query filters or sorts on: membership may have moved.
  const watchKey = (opts.watch ?? []).join("|");
  const stale = useMemo(() => {
    if (!rows || !live) return "";
    const watch = watchKey ? watchKey.split("|") : [];
    const byId = new Map(live.flatMap((r) => (r ? [[r.streamId as string, r] as const] : [])));
    const changed = rows.filter((row) => {
      const hot = byId.get(row.id);
      if (!hot || hot.version <= row.version) return false;
      // Deleted or restored elsewhere: the total and the page's fill change, whatever the sort.
      if (hot.lifecycle.status !== row.status) return true;
      return watch.some((w) => {
        const before = w === "$updatedAt" ? row.updatedAt : w === "$createdAt" ? row.createdAt : w === "$title" ? row.title : row.values[w] ?? null;
        const after = w === "$updatedAt" ? hot.updatedAt : w === "$createdAt" ? hot.createdAt : w === "$title" ? hot.title : (hot.values as ListRow["values"])[w] ?? null;
        return JSON.stringify(before) !== JSON.stringify(after);
      });
    });
    return changed.map((r) => `${r.id}@${byId.get(r.id)!.version}`).join(",");
  }, [rows, live, watchKey]);
  const onStale = useRef(opts.onStale);
  onStale.current = opts.onStale;
  // Refetch until the page reflects the edit: a reload before the projector applies it returns the same stale rows.
  const [attempt, setAttempt] = useState({ stale: "", n: 0 });
  const tries = attempt.stale === stale ? attempt.n : 0;
  useEffect(() => {
    if (!stale || tries >= STALE_RETRIES) return;
    const timer = setTimeout(() => {
      if (onStale.current) onStale.current();
      else void reload();
      setAttempt({ stale, n: tries + 1 });
    }, Math.min(STALE_RELOAD_MS * 2 ** tries, 15_000));
    return () => clearTimeout(timer);
  }, [stale, tries, reload]);

  return { rows: shown, total, hasMore: cursor !== null, loadMore, loadingMore, reload, error };
}
