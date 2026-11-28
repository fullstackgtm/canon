"use client";

import { useAction } from "convex/react";
import { Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useId, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { SuggestionScope } from "../../../convex/lib/customizeSuggestions";
import { cn } from "@/lib/utils";
import { matchingPrompts, promptCompletionKey } from "./prompt-completion";

const EMPTY: readonly string[] = [];

type SuggestionEntry = { pending: Promise<readonly string[]>; suggestions?: readonly string[] };
export type SuggestionCache = Map<string, SuggestionEntry>;

export function useDealRecordId() {
  const { object, id } = useParams<{ object?: string; id?: string }>();
  return object === "deal" ? id as Id<"canonEntities"> | undefined : undefined;
}

export function usePromptSuggestions(cache: SuggestionCache | null, scope: SuggestionScope | null) {
  const suggest = useAction(api.pageCustomize.suggest);
  const target = scope?.target;
  const sectionId = scope?.sectionId;
  const recordId = useDealRecordId();
  const dealId = target === "deal" ? recordId : undefined;
  const key = target === undefined ? null : JSON.stringify([target, sectionId, dealId]);
  const cached = key === null ? undefined : cache?.get(key)?.suggestions;
  const [result, setResult] = useState<{ cache: SuggestionCache; key: string; suggestions: readonly string[] }>();

  useEffect(() => {
    if (!cache || key === null || target === undefined || cached) return;
    let entry = cache.get(key);
    if (!entry) {
      const pending = suggest({ scope: target !== null && sectionId !== undefined ? { target, sectionId } : { target }, ...(dealId ? { dealId } : {}) })
        .then((response) => response.suggestions, () => EMPTY);
      const created: SuggestionEntry = { pending };
      void pending.then((suggestions) => { created.suggestions = suggestions; });
      cache.set(key, created);
      entry = created;
    }
    let current = true;
    void entry.pending.then((suggestions) => { if (current) setResult({ cache, key, suggestions }); });
    return () => { current = false; };
  }, [cache, cached, dealId, key, sectionId, suggest, target]);

  const current = result?.cache === cache && result.key === key ? result : undefined;
  return { suggestions: cached ?? current?.suggestions ?? EMPTY, loading: Boolean(cache && key !== null && !cached && !current) };
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onKeyDown" | "placeholder"> & {
  ref?: Ref<HTMLTextAreaElement>;
  value: string;
  suggestions: readonly string[];
  loading: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
};

const FONT = "break-words whitespace-pre-wrap rounded-lg px-2 py-1.5 text-sm";

export function SuggestedPrompt({ ref, value, suggestions, loading, onValueChange, onSubmit, disabled, className, ...props }: Props) {
  const hintId = useId();
  const [index, setIndex] = useState(0);
  const matches = disabled ? [] : matchingPrompts(value, suggestions);
  const suggestion = matches.length ? matches[index % matches.length] : undefined;

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const intent = promptCompletionKey({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    }, event.currentTarget, matches.length);
    if (intent) {
      event.preventDefault();
      if (intent === "accept" && suggestion) onValueChange(value + suggestion.slice(value.length));
      else setIndex((i) => (i + matches.length + (intent === "previous" ? -1 : 1)) % matches.length);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div>
      <div className="relative rounded-lg bg-white/5">
        {suggestion && <div aria-hidden className={cn(FONT, "pointer-events-none absolute inset-0 overflow-hidden text-stone-400")}><span className="invisible">{value}</span>{suggestion.slice(value.length)}</div>}
        <textarea {...props} ref={ref} value={value} disabled={disabled}
          aria-describedby={suggestion || loading ? hintId : undefined}
          onChange={(e) => { setIndex(0); onValueChange(e.target.value); }} onKeyDown={keyDown}
          className={cn(FONT, "relative block w-full resize-none bg-transparent text-white outline-none ring-1 ring-white/10 focus:ring-violet-500", className)} />
      </div>
      {(loading || suggestion) && <div id={hintId} className="mt-1 text-right text-[10px] text-stone-400">
        {loading ? <Loader2 role="img" aria-label="Suggesting a prompt" className="inline-block size-3 animate-spin" /> :
          <><span className="sr-only">{suggestion}. Press </span><kbd className="rounded border border-white/15 px-1">Tab</kbd><span className="sr-only"> to accept the suggestion.</span></>}
      </div>}
    </div>
  );
}
