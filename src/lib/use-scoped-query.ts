"use client";

import { useAction, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

/**
 * A read a narrowed role cannot be judged by in a query (CP14): the live query
 * while it answers, else its action twin. The query answers null when some
 * company or person it would show is one only the record service can judge for
 * the caller; the twin admits those through the caller's scoped client
 * (convex/permissions.ts sightJudge, lib/scopedRecordClient.ts admitThenRead).
 * `refresh` reads the twin again (after a write, or when a run moves). Undefined
 * while loading.
 */
export function useScopedQuery<Q extends FunctionReference<"query">, A extends FunctionReference<"action">>(
  query: Q,
  action: A,
  args: FunctionArgs<Q> | "skip",
  refresh: unknown = 0,
): FunctionReturnType<Q> | FunctionReturnType<A> | undefined {
  const live = useQuery(query, args);
  const read = useAction(action);
  const key = args === "skip" ? null : JSON.stringify(args);
  const [scoped, setScoped] = useState<{ key: string; refresh: unknown; value: FunctionReturnType<A> }>();
  useEffect(() => {
    if (live !== null || key === null) return;
    let on = true;
    read(JSON.parse(key) as FunctionArgs<A>)
      .then((value) => { if (on) setScoped({ key, refresh, value }); })
      .catch((error: unknown) => console.warn("Scoped read:", error));
    return () => { on = false; };
  }, [live, key, refresh, read]);
  if (live !== null) return live;
  return scoped?.key === key ? scoped.value : undefined;
}
