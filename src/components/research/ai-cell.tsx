"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQueries, useQuery } from "convex/react";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { offered, type Context, type PageAction } from "../../../recipes";
import { contactAnswerBatches } from "@/lib/contact-table";
import { useKeepSettled } from "@/components/records/live-rows";
import { api } from "../../../convex/_generated/api";

export type AiField = NonNullable<ReturnType<typeof useQuery<typeof api.researchAgents.list>>>["agents"][number];
export type AiAnswer = { value: string | number | boolean | null; status: "accepted" | "proposed"; evidence: string | null };

/**
 * An answer's quote and where it came from (agentLoop.ts evidenceText). A quote from a search
 * engine's snippet ends "(search result)"; an answer Jev inferred (probe.ts inferredEvidence) ends
 * "(inferred by Jev)" and its "quote" is what Jev read.
 */
export function quoteAndSource(evidence: string | null): { quote: string | null; url: string | null; via: "page" | "snippet" | "inferred" } {
  if (!evidence) return { quote: null, url: null, via: "page" };
  const m = evidence.match(/^([\s\S]*?)\n\nSource: (\S+)(?: \((search result|inferred by Jev)\))?$/);
  if (!m) return { quote: evidence, url: null, via: "page" };
  return { quote: m[1], url: /^https?:\/\//.test(m[2]) ? m[2] : null, via: m[3] === "search result" ? "snippet" : m[3] || m[1].startsWith("Inferred from:") ? "inferred" : "page" };
}

/** An answer as text: a yes/no, or a classify option's label. */
export function showAnswer(value: string | number | boolean | null, field: Pick<AiField, "options">): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return field.options?.find((o) => o.key === value)?.label ?? String(value);
}

/** The workspace's contact AI fields. */
export function useContactAiFields(): AiField[] {
  const data = useQuery(api.researchAgents.list);
  return useMemo(() => (data?.agents ?? []).filter((a) => a.entityType === "contact"), [data]);
}

/** Answers of the given contact fields for contacts (record-service ids), by contact then field slug. */
export function useContactAnswers(recordIds: readonly string[] | null | undefined, fields: readonly AiField[]) {
  const batches = fields.length ? contactAnswerBatches(recordIds ?? []) : [];
  const slugs = fields.map((f) => f.slug);
  // useQueries resubscribes whenever its argument's identity changes, and each answer re-renders: key it on content.
  const key = JSON.stringify([slugs, batches]);
  const queries = useMemo(() => {
    const [keySlugs, keyBatches] = JSON.parse(key) as [string[], string[][]];
    return Object.fromEntries(keyBatches.map((ids, index) => [String(index), {
      query: api.researchAgents.contactAnswers,
      args: { slugs: keySlugs, recordIds: ids },
    }]));
  }, [key]);
  const results = useQueries(queries);
  const answers: Record<string, Record<string, AiAnswer>> = {};
  let settled = true;
  let scoped = false;
  for (const result of Object.values(results)) {
    if (result instanceof Error) throw result;
    if (result === undefined) settled = false;
    // Null: the caller sees only some contacts, so the answers come from the action that admits them (CP14).
    else if (result === null) scoped = true;
    else Object.assign(answers, result);
  }
  const fromAction = useScopedContactAnswers(scoped ? key : null, fields.map((f) => f.latestRun?.updatedAt ?? 0).join());
  // New rows re-key the batches: keep showing the answers already known while they load.
  return useKeepSettled(scoped ? fromAction ?? {} : answers, settled && (!scoped || fromAction !== undefined));
}

/** The answers of `key`'s batches through researchAgents.contactAnswersScoped, read again when a field's latest run moves. */
function useScopedContactAnswers(key: string | null, refresh: string): Record<string, Record<string, AiAnswer>> | undefined {
  const read = useAction(api.researchAgents.contactAnswersScoped);
  const [state, setState] = useState<{ key: string; answers: Record<string, Record<string, AiAnswer>> }>();
  useEffect(() => {
    if (!key) return;
    let live = true;
    const [slugs, batches] = JSON.parse(key) as [string[], string[][]];
    Promise.all(batches.map((recordIds) => read({ slugs, recordIds })))
      .then((pages) => { if (live) setState({ key, answers: Object.assign({}, ...pages) }); })
      .catch((error: unknown) => console.warn("AI answers:", error));
    return () => { live = false; };
  }, [key, refresh, read]);
  return state?.key === key ? state.answers : undefined;
}

/** One answer in a table cell; hovering shows the quote it rests on and the page it came from. */
export function AiCell({ field, answer }: { field: AiField; answer: AiAnswer | undefined }) {
  if (!answer) return <span className="text-muted-foreground">—</span>;
  const { quote, url } = quoteAndSource(answer.evidence);
  const title = [quote, url && `Source: ${url}`, answer.status === "proposed" && "Waiting for review in Fact Review."].filter(Boolean).join("\n\n");
  return (
    <span title={title || undefined} className={answer.status === "proposed" ? "cursor-help italic text-muted-foreground" : "cursor-help underline decoration-dotted decoration-provenance underline-offset-2"}>
      {showAnswer(answer.value, field)}
    </span>
  );
}

/**
 * A person's page's AI fields: each answer with the quote it rests on and a link to the page it came from, and the
 * page's action to research that field for this person (researchAgents.startRun).
 */
function AiFieldsPanelEnabled({ fields, answers, contactId, actions, ctx, title = "AI fields" }: {
  fields: readonly AiField[]; answers: Record<string, AiAnswer> | undefined; contactId: string; actions: readonly PageAction[]; ctx: Context; title?: string;
}) {
  const startRun = useMutation(api.researchAgents.startRun);
  const [running, setRunning] = useState<string | null>(null);
  async function research(field: AiField) {
    setRunning(field.slug);
    try {
      const r = await startRun({ slug: field.slug, contacts: { kind: "ids", ids: [contactId] } });
      if (r.refused) toast.error(r.refused);
      else toast.success(`Researching ${field.label}`);
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setRunning(null);
    }
  }
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      <dl>
        {fields.map((f) => {
          const answer = answers?.[f.slug];
          const { quote, url } = quoteAndSource(answer?.evidence ?? null);
          const run = offered(actions, "aiFields", ["kernel.runAiField"], { ...ctx, "field.answered": Boolean(answer) }, {}, "contact")[0];
          return (
            <div key={f.slug} className="border-b border-border py-2 last:border-b-0">
              <dt className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground" title={f.question}>
                {f.label}
                {run && <button type="button" disabled={run.disabled || running !== null} onClick={() => void research(f)} className="normal-case tracking-normal underline hover:text-foreground disabled:opacity-50">{running === f.slug ? "Starting…" : run.label}</button>}
              </dt>
              <dd className="mt-1 text-sm">
                {answer ? (
                  <>
                    <span className="font-medium">{showAnswer(answer.value, f)}</span>
                    {answer.status === "proposed" && <span className="ml-2 text-xs text-muted-foreground">waiting for review</span>}
                    {quote && <blockquote className="mt-1 whitespace-pre-line border-l-2 border-provenance/40 pl-2 text-xs text-muted-foreground">{quote}</blockquote>}
                    {url && <a href={url} target="_blank" rel="noreferrer noopener" className="mt-0.5 block truncate text-xs underline underline-offset-2 hover:text-foreground">{url}</a>}
                  </>
                ) : (
                  <span className="text-muted-foreground">No answer yet</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function AiFieldsPanel(props: React.ComponentProps<typeof AiFieldsPanelEnabled>) {
  return <IntegrationGate feature={["chatgpt", "openrouter"]}><AiFieldsPanelEnabled {...props} /></IntegrationGate>;
}
