"use client";

import { useAction } from "convex/react";
import { Loader2, Paperclip, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { SuggestionScope } from "../../../convex/lib/customizeSuggestions";
import { cn } from "@/lib/utils";
import { matchingPrompts, promptCompletionKey } from "./prompt-completion";
import { MAX_REFERENCE_IMAGES, REFERENCE_IMAGE_TYPES } from "../../../recipes/imageReferences";
import type { useReferenceImages } from "./use-reference-images";

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
  attachments: ReturnType<typeof useReferenceImages>;
};

const FONT = "break-words whitespace-pre-wrap rounded-lg px-2 py-1.5 text-sm";

export function SuggestedPrompt({ ref, value, suggestions, loading, onValueChange, onSubmit, disabled, className, attachments, ...props }: Props) {
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
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
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled || attachments.pending ? "none" : "copy";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (!disabled) void attachments.add(Array.from(event.dataTransfer.files));
      }}>
      <div className="relative rounded-lg bg-white/5">
        {suggestion && <div aria-hidden className={cn(FONT, "pointer-events-none absolute inset-0 overflow-hidden text-stone-400")}><span className="invisible">{value}</span>{suggestion.slice(value.length)}</div>}
        <textarea {...props} ref={ref} value={value} disabled={disabled}
          aria-describedby={suggestion || loading ? hintId : undefined}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (!images.length) return;
            event.preventDefault();
            if (!disabled) void attachments.add(images);
          }}
          onChange={(e) => { setIndex(0); onValueChange(e.target.value); }} onKeyDown={keyDown}
          className={cn(FONT, "relative block w-full resize-none bg-transparent text-white outline-none ring-1 ring-white/10 focus:ring-violet-500", className)} />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <input ref={fileInput} type="file" hidden multiple accept={REFERENCE_IMAGE_TYPES.join(",")} onChange={(event) => {
          void attachments.add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }} />
        <button type="button" aria-label="Attach images" title="Attach images" onClick={() => fileInput.current?.click()}
          disabled={disabled || attachments.pending || attachments.images.length >= MAX_REFERENCE_IMAGES}
          className="rounded p-1 text-stone-300 enabled:hover:bg-white/10 disabled:opacity-40">
          <Paperclip className="size-3.5" />
        </button>
        {(loading || suggestion) && <div id={hintId} className="text-right text-[10px] text-stone-400">
          {loading ? <Loader2 role="img" aria-label="Suggesting a prompt" className="inline-block size-3 animate-spin" /> :
            <><span className="sr-only">{suggestion}. Press </span><kbd className="rounded border border-white/15 px-1">Tab</kbd><span className="sr-only"> to accept the suggestion.</span></>}
        </div>}
      </div>
      {attachments.images.length > 0 && <ul aria-label="Attached images" className="mt-1 flex gap-2">
        {attachments.images.map((image) => <li key={image.id} className="relative">
          {/* The thumbnail is a transient data URL, so it does not use the image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={image.name} className="size-12 rounded border border-white/15 object-cover" />
          <button type="button" aria-label={`Remove ${image.name}`} disabled={disabled} onClick={() => attachments.remove(image.id)}
            className="absolute right-0 top-0 rounded-bl bg-stone-900 p-0.5 text-white enabled:hover:bg-stone-700 disabled:opacity-40">
            <X className="size-3" />
          </button>
        </li>)}
      </ul>}
      {attachments.pending && <p role="status" className="mt-1 text-[11px] text-stone-400">Preparing images…</p>}
      {attachments.error && <p role="alert" className="mt-1 text-[11px] text-rose-300">{attachments.error}</p>}
    </div>
  );
}
