"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseUrlState, serializeUrlState, type UrlStateShape } from "./url-state-core";

export { parseUrlState, serializeUrlState } from "./url-state-core";

/**
 * Filter/sort/tab state stored in the URL query string so it survives
 * navigation and can be shared. Values equal to the default are omitted.
 *
 *   const [state, setState] = useUrlState({ q: "", sort: "name" });
 *   setState({ sort: "created" });
 */
export function useUrlState<T extends UrlStateShape>(
  defaults: T,
): [T, (patch: Partial<T>, opts?: { push?: boolean }) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Callers usually pass an inline object literal; key on its content.
  const defaultsKey = JSON.stringify(defaults);

  const state = useMemo(
    () => parseUrlState(searchParams, JSON.parse(defaultsKey) as T),
    [searchParams, defaultsKey],
  );

  const setState = useCallback(
    (patch: Partial<T>, opts?: { push?: boolean }) => {
      const qs = serializeUrlState(
        searchParams.toString(),
        JSON.parse(defaultsKey) as T,
        patch,
      );
      // A pushed entry is one the back button undoes, such as opening a dialog.
      router[opts?.push ? "push" : "replace"](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, defaultsKey],
  );

  return [state, setState];
}
