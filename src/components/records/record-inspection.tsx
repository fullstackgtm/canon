"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { RecordDialog } from "./record-page";
import { inspectionHref, inspectionTarget, type RecordTarget } from "./record-target";
import { RECORDS_SAVED, RecordDraftContext, RecordInspectionContext } from "./record-context";

type DraftOwner = { identity: string | null | undefined; generation: number; store: Map<string, Map<string, unknown>> };

function useDraftOwner(identity: DraftOwner["identity"]): DraftOwner {
  const [owner, setOwner] = useState<DraftOwner>(() => ({ identity, generation: 0, store: new Map() }));
  if (identity !== undefined && identity !== owner.identity) {
    const resolvedFirst = owner.identity === undefined;
    const next = resolvedFirst ? { ...owner, identity } : { identity, generation: owner.generation + 1, store: new Map() };
    setOwner(next);
    return next;
  }
  return owner;
}

export function RecordInspection({ children }: { children: ReactNode }) {
  const me = useQuery(api.users.me);
  const owner = useDraftOwner(me === undefined ? undefined : me ? `${me._id}:${me.orgId}` : null);
  const pathname = usePathname(), params = useSearchParams(), router = useRouter();
  const target = useMemo(() => inspectionTarget(params, pathname), [params, pathname]);
  const origin = useRef<string | null>(null);
  const open = useCallback((next: RecordTarget) => {
    const href = inspectionHref(pathname, params.toString(), next);
    if (target) router.replace(href, { scroll: false });
    else {
      origin.current = pathname;
      router.push(href, { scroll: false });
    }
  }, [router, pathname, params, target]);
  const close = () => {
    if (origin.current === pathname) {
      origin.current = null;
      router.back();
    } else router.replace(inspectionHref(pathname, params.toString(), null), { scroll: false });
  };
  useEffect(() => { if (!target || origin.current !== pathname) origin.current = null; }, [target, pathname]);
  const recordKey = target ? JSON.stringify([target.object, target.id]) : "";
  let drafts = owner.store.get(recordKey);
  if (!drafts) owner.store.set(recordKey, drafts = new Map());
  const context = useMemo(() => ({ target, open }), [target, open]);
  return <RecordInspectionContext.Provider value={context}>
    {children}
    {target && <RecordDraftContext.Provider value={drafts}>
      <RecordDialog key={`${owner.generation}:${recordKey}`} {...target} onClose={close} onSaved={(saves) => window.dispatchEvent(new CustomEvent(RECORDS_SAVED, { detail: saves }))} />
    </RecordDraftContext.Provider>}
  </RecordInspectionContext.Provider>;
}
