"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { recordHref, type RecordTarget } from "./record-target";
import type { Save } from "./use-object-list";

export const RECORDS_SAVED = "canon:records-saved";
export const RecordInspectionContext = createContext<{ target: RecordTarget | null; open: (target: RecordTarget) => void } | null>(null);
export const RecordDraftContext = createContext<Map<string, unknown> | null>(null);

export function useRecordInspection() { return useContext(RecordInspectionContext); }

export function RecordLink({ object, id, ...props }: { object: string; id: string } & Omit<ComponentProps<typeof Link>, "href">) {
  return <Link {...props} href={recordHref(object, id)} />;
}

export function RecordQuickView({ object, id, label, className }: RecordTarget & { label: string; className?: string }) {
  const inspection = useRecordInspection();
  if (!inspection) return null;
  const name = `Quick view ${label}`;
  return (
    <button type="button" aria-label={name} title={name} aria-haspopup="dialog"
      onClick={(event) => { event.stopPropagation(); inspection.open({ object, id }); }}
      className={cn("inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
      <Eye className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function useRecordsSaved(onSaved: (saves: Save[]) => void) {
  const latest = useRef(onSaved);
  useLayoutEffect(() => { latest.current = onSaved; }, [onSaved]);
  useEffect(() => {
    const listener = (event: Event) => { if (event instanceof CustomEvent) latest.current(event.detail); };
    window.addEventListener(RECORDS_SAVED, listener);
    return () => window.removeEventListener(RECORDS_SAVED, listener);
  }, []);
}

export function useRecordDraft<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const drafts = useContext(RecordDraftContext);
  const [value, setValue] = useState<T>(() => drafts?.has(key) ? drafts.get(key) as T : initial);
  const current = useRef(value);
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(current.current) : next;
    current.current = resolved;
    drafts?.set(key, resolved);
    setValue(resolved);
  }, [drafts, key]);
  return [value, set];
}
