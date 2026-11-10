"use client";

import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { ProjectedThrough } from "../../../convex/lib/objects/listSpec";
import { projectedPast, type GroupsResponse, type ViewGroup } from "../../../convex/lib/objects/views";
import { getErrorMessage } from "@/lib/utils";
import type { ListedObject, Save } from "./use-object-list";

const CATCH_UP_MS = 4000;
const CATCH_UP_POLL_MS = 150;
/** As use-object-list refreshes its first page. */
const BACKGROUND_REFRESH_MS = 30_000;

/** The groups of a grouped list (`objects.groups`), read again after each batch of saves until the projection passes them. A null query reads nothing. */
export function useGroups(query: { object: ListedObject; filter: ViewFilter[]; group: ViewGroup } | null, saves: { n: number; saves: Save[] }) {
  const run = useAction(api.objects.groups);
  // Tagged with the query it answers, so a new grouping shows loading rather than the last one's groups.
  const [state, setState] = useState<{ key: string; res: GroupsResponse | null; error: string }>({ key: "", res: null, error: "" });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query);
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    const q = JSON.parse(key) as typeof query;
    if (!q) return;
    void (async () => {
      const started = Date.now();
      try {
        let page = await run(q);
        while (!projectedPast(page.projectedThrough as ProjectedThrough, saves.saves) && Date.now() - started < CATCH_UP_MS) {
          await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS));
          if (mine !== generation.current) return;
          page = await run(q);
        }
        if (mine === generation.current) setState({ key, res: page, error: "" });
      } catch (cause) {
        if (mine === generation.current) setState((cur) => ({ ...cur, key, error: getErrorMessage(cause) }));
      }
    })();
  }, [key, saves, tick, run]);
  // Records created or moved elsewhere can land in a group with no rows on screen: read the counts again now and then.
  useEffect(() => {
    if (key === "null") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") setTick((n) => n + 1); }, BACKGROUND_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key]);
  const current = state.key === key;
  return { res: current ? state.res : null, error: current ? state.error : "", reload: () => setTick((n) => n + 1) };
}

