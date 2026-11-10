"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage } from "@/lib/utils";
import { moduleCallCache } from "@/lib/module-call-cache";

export type Loaded = { value?: unknown; error?: string; busy: boolean };
export type PageLoads = Record<string, { call: string; args: Record<string, unknown> | null; refreshMinutes?: number; revision?: string }>;
type RunCall = (args: { module: string; call: string; args: Record<string, unknown> }) => Promise<{ value?: unknown }>;
const loadKey = (who: string, module: string, call: string, args: Record<string, unknown>, refreshMinutes?: number, revision?: string) => JSON.stringify([who, module, call, revision ?? null, Object.entries(args).sort(([a], [b]) => a.localeCompare(b)), refreshMinutes ?? null, refreshMinutes ? Math.floor(Date.now() / (refreshMinutes * 60_000)) : null]);

export function usePageCallLoads(principal: string, module: string, given: PageLoads, runCall: RunCall, freshOnMount: boolean) {
  const loadsKey = JSON.stringify([principal, module, given, freshOnMount]);
  const [who, loadModule, loads] = useMemo(() => JSON.parse(loadsKey) as [string, string, PageLoads, boolean], [loadsKey]);
  const initial = useMemo(() => Object.fromEntries(Object.entries(loads).filter(([, l]) => l.args).map(([bind, l]) => {
    const key = loadKey(who, loadModule, l.call, l.args!, l.refreshMinutes, l.revision);
    const cached = freshOnMount ? undefined : moduleCallCache.get(key);
    return [bind, cached ? { value: cached.value, busy: false } : { busy: true }];
  })) as Record<string, Loaded>, [loads, who, loadModule, freshOnMount]);
  const [state, setState] = useState<{ key: string; values: Record<string, Loaded> }>({ key: loadsKey, values: {} });
  const loaded = { ...initial, ...(state.key === loadsKey ? state.values : {}) };
  const setLoaded = useCallback((update: (values: Record<string, Loaded>) => Record<string, Loaded>) => setState((s) => ({ key: loadsKey, values: update({ ...initial, ...(s.key === loadsKey ? s.values : {}) }) })), [loadsKey, initial]);
  const current = useRef<Record<string, symbol>>({});
  const subscribe = useCallback((bind: string, fresh: boolean): Promise<boolean> => {
    const l = loads[bind];
    if (!l?.args) return Promise.resolve(false);
    const args = l.args;
    const key = loadKey(who, loadModule, l.call, l.args, l.refreshMinutes, l.revision);
    const token = Symbol();
    current.current[bind] = token;
    return moduleCallCache.load(key, async () => (await runCall({ module: loadModule, call: l.call, args })).value, fresh)
      .then((value) => {
        if (current.current[bind] !== token) return false;
        setLoaded((s) => ({ ...s, [bind]: { value, busy: false } }));
        return true;
      }).catch((e) => {
        if (current.current[bind] === token) setLoaded((s) => ({ ...s, [bind]: { ...s[bind], error: getErrorMessage(e), busy: false } }));
        return false;
      });
  }, [loads, who, loadModule, runCall, setLoaded]);
  const runLoad = useCallback((bind: string, fresh: boolean): Promise<boolean> => {
    if (!loads[bind]?.args) return Promise.resolve(false);
    setLoaded((s) => ({ ...s, [bind]: { ...s[bind], busy: true } }));
    return subscribe(bind, fresh);
  }, [loads, setLoaded, subscribe]);
  useEffect(() => {
    current.current = {};
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let active = true;
    const schedule = (bind: string) => {
      const minutes = loads[bind]?.refreshMinutes;
      if (!active || !minutes || !loads[bind].args) return;
      const ttl = minutes * 60_000;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!active) return;
        runLoad(bind, false);
        schedule(bind);
      }, ttl - (Date.now() % ttl) + 25);
      timers.add(timer);
    };
    for (const bind of Object.keys(loads)) { subscribe(bind, freshOnMount); schedule(bind); }
    return () => { active = false; current.current = {}; for (const timer of timers) clearTimeout(timer); };
  }, [runLoad, subscribe, loads, freshOnMount]);
  return { loads, loaded, runLoad };
}
