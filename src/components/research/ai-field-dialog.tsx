"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useObjectLabels } from "@/components/records/object-labels";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

type Kind = "classify" | "qa";
type AnswerType = "text" | "number" | "boolean";
type Option = { key: string; label: string; description: string };

type Example = { label: string; kind: Kind; question: string; options?: Option[]; answerType?: AnswerType };

const CONTACT_EXAMPLES: Example[] = [
  {
    label: "Persona", kind: "classify", question: "What role does this person play in a purchase?",
    options: [
      { key: "economic-buyer", label: "Economic buyer", description: "Controls the budget" },
      { key: "champion", label: "Champion", description: "Day-to-day user who pushes for the product" },
      { key: "technical-evaluator", label: "Technical evaluator", description: "Judges fit and security" },
      { key: "other", label: "Other", description: "" },
    ],
  },
  {
    label: "Seniority", kind: "classify", question: "How senior is this person?",
    options: [
      { key: "c-level", label: "C-level", description: "" },
      { key: "vp", label: "VP", description: "" },
      { key: "director", label: "Director", description: "" },
      { key: "manager", label: "Manager", description: "" },
      { key: "individual-contributor", label: "Individual contributor", description: "" },
    ],
  },
  { label: "Connected to", kind: "qa", question: "Who at this company does this person work with or report to?", answerType: "text" },
];

const EXAMPLES: Example[] = [
  {
    label: "Sells to government", kind: "classify", question: "Who does this company mainly sell to?",
    options: [
      { key: "government", label: "Government", description: "Federal, state or local agencies" },
      { key: "enterprise", label: "Enterprise", description: "Large companies" },
      { key: "smb", label: "SMB", description: "Small and mid-sized businesses" },
      { key: "consumers", label: "Consumers", description: "" },
    ],
  },
  { label: "Insurance accepted", kind: "qa", question: "Which insurance carriers or plans does this practice accept?", answerType: "text" },
  { label: "Locations", kind: "qa", question: "How many physical locations or offices does this company list?", answerType: "number" },
  { label: "Has free trial", kind: "qa", question: "Does the company offer a free trial of its product?", answerType: "boolean" },
];

const YES_NO: Option[] = [
  { key: "yes", label: "Yes", description: "" },
  { key: "no", label: "No", description: "" },
];

const optionKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const input = "border border-border bg-background px-2 py-1.5 text-sm text-foreground";

/** A field being edited. Mount the dialog with it when editing starts: it reads the field once. */
export type EditedField = {
  slug: string; label: string; question: string; kind: Kind; entityType: "account" | "contact";
  options: { key: string; label: string; description?: string }[] | null; answerType: AnswerType | null;
};

const asOptions = (field: EditedField) => field.options?.map((o) => ({ key: o.key, label: o.label, description: o.description ?? "" })) ?? YES_NO;

function AiFieldDialogEnabled({ open, onOpenChange, defaultEntityType = "account", field }: { open: boolean; onOpenChange: (open: boolean) => void; defaultEntityType?: "account" | "contact"; field?: EditedField }) {
  const names = useObjectLabels();
  const create = useMutation(api.researchAgents.create);
  const update = useMutation(api.researchAgents.update);
  const [entityType, setEntityType] = useState<"account" | "contact">(field?.entityType ?? defaultEntityType);
  const [label, setLabel] = useState(field?.label ?? "");
  const [kind, setKind] = useState<Kind>(field?.kind ?? "classify");
  const [question, setQuestion] = useState(field?.question ?? "");
  const [options, setOptions] = useState<Option[]>(field ? asOptions(field) : YES_NO);
  const [answerType, setAnswerType] = useState<AnswerType>(field?.answerType ?? "text");
  const [askAgain, setAskAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // FSGTM's deal page researches people with these fields, asking the workspace's questions; its new capability is per deal.
  const fsgtm = useQuery(api.recipes.settings, open && !field ? { recipeId: "fsgtm-enterprise-deal" } : "skip");
  const peopleExamples: Example[] = fsgtm ? fsgtm.peopleFields.map(({ label, kind, question, answerType }) => ({ label, kind, question, answerType })) : [];

  function reset() {
    setLabel(""); setEntityType(defaultEntityType); setKind("classify"); setQuestion(""); setOptions(YES_NO); setAnswerType("text"); setError("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const sent = options.filter((o) => o.label.trim()).map((o) => ({ key: o.key || optionKey(o.label), label: o.label, ...(o.description.trim() ? { description: o.description } : {}) }));
    try {
      if (field) {
        await update({ slug: field.slug, label, question, ...(kind === "classify" ? { options: sent } : {}), ...(askAgain && reworded ? { askAgain } : {}) });
        onOpenChange(false);
        return;
      }
      await create({
        entityType,
        label: label.trim() || question.trim().slice(0, 60),
        kind,
        question,
        ...(kind === "classify"
          ? { options: sent }
          : { answerType }),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // An edited field's options keep their keys: answers already recorded hold them.
  const saved = new Set(field?.options?.map((o) => o.key));
  const setOption = (i: number, patch: Partial<Option>) =>
    setOptions((all) => all.map((o, j) => (j === i ? { ...o, ...patch, ...(patch.label !== undefined && !saved.has(o.key) ? { key: optionKey(patch.label) } : {}) } : o)));
  const reworded = !!field && (question.trim() !== field.question.trim() || JSON.stringify(options) !== JSON.stringify(asOptions(field)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> {field ? `Edit ${field.label}` : "New AI field"}
        </DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          {entityType === "contact"
            ? "A contact AI field answers one question about each person from the web: a search for them, their company's website and their profile page, when the record has one. "
            : "An AI field answers one question about each account by reading its website, and searching the web when the site doesn't say. "}
          Every answer must quote the page or search result it came from, word for word{entityType === "contact" ? " (and name the person)" : ""}, or it isn&apos;t
          recorded. Answers become proposed facts on the {entityType} and go through the write gate.
        </DialogDescription>
        <form onSubmit={submit} className="grid gap-3">
          {field ? (
            <p className="text-xs text-muted-foreground">
              {entityType === "contact" ? names("contact")!.pluralLabel : names("account")!.pluralLabel} · {kind === "classify" ? "Classify" : `Question · ${answerType}`}. Answers are kept under
              these, so they can&apos;t change; create a new field for a different type.
            </p>
          ) : (<>
          <div role="radiogroup" aria-label="Answered about" className="flex w-fit border border-border text-xs font-medium">
            {([["account", names("account")!.pluralLabel], ["contact", names("contact")!.pluralLabel]] as const).map(([t, text]) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={entityType === t}
                onClick={() => setEntityType(t)}
                className={cn("px-3 py-1.5", entityType === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {text}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(entityType === "contact" ? [...peopleExamples, ...CONTACT_EXAMPLES] : EXAMPLES).map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => {
                  setLabel(ex.label); setKind(ex.kind); setQuestion(ex.question);
                  if (ex.options) setOptions(ex.options);
                  if (ex.answerType) setAnswerType(ex.answerType);
                }}
                className="border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div role="radiogroup" aria-label="Field type" className="flex w-fit border border-border text-xs font-medium">
            {([["classify", "Classify"], ["qa", "Question"]] as const).map(([k, text]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn("px-3 py-1.5", kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {text}
              </button>
            ))}
          </div>
          </>)}

          <label className="grid gap-1 text-xs text-muted-foreground">
            {kind === "classify" ? "What the options classify" : "Question"}
            <textarea
              required
              minLength={8}
              maxLength={1000}
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={kind === "classify" ? "Who does this company mainly sell to?" : "Which insurance carriers does this practice accept?"}
              className={input}
            />
          </label>

          {kind === "classify" ? (
            <div className="grid gap-1.5 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Options (the model may also answer “unknown”)</span>
                {!field && (
                  <button type="button" onClick={() => setOptions(YES_NO)} className="underline underline-offset-2 hover:text-foreground">
                    Yes / No
                  </button>
                )}
              </div>
              {options.map((o, i) => (
                <div key={i} className="flex gap-1.5">
                  <input aria-label={`Option ${i + 1}`} maxLength={80} value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} placeholder="Option" className={cn(input, "w-40")} />
                  <input aria-label={`Option ${i + 1} description`} maxLength={300} value={o.description} onChange={(e) => setOption(i, { description: e.target.value })} placeholder="What it means (optional)" className={cn(input, "flex-1")} />
                  {saved.has(o.key) ? <span className="w-[22px]" /> : (
                    <button type="button" aria-label="Remove option" onClick={() => setOptions((all) => all.filter((_, j) => j !== i))} className="px-1 hover:text-foreground">
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {options.length < 12 && (
                <button type="button" onClick={() => setOptions((all) => [...all, { key: "", label: "", description: "" }])} className="flex w-fit items-center gap-1 hover:text-foreground">
                  <Plus className="size-3" /> Add option
                </button>
              )}
            </div>
          ) : field ? null : (
            <label className="grid gap-1 text-xs text-muted-foreground">
              Answer type
              <SelectField size="default" aria-label="Answer type" value={answerType} onValueChange={(v) => setAnswerType(v as AnswerType)} className="w-40"
                options={[{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes / no" }]} />
            </label>
          )}

          <label className="grid gap-1 text-xs text-muted-foreground">
            Field name
            <input maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sells to government" className={input} />
          </label>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Runs use the ChatGPT plan of whoever starts them (Integrations → ChatGPT): one to five model calls per {entityType}, web searches
            included. The model reads the homepage{entityType === "contact" ? ", the person's profile page and a web search for them" : ""}, and may
            search the web or follow up to six links.
          </p>
          {reworded && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={askAgain} onChange={(e) => setAskAgain(e.target.checked)} className="mt-0.5" />
              <span>Ask every {entityType} again: answers to the old wording stop counting, and the next run researches every record. Leave it off
                for a small fix: runs keep skipping the records already answered.</span>
            </label>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || question.trim().length < 8}
              className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3 animate-spin" />} {field ? "Save" : "Create field"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiFieldDialog(props: React.ComponentProps<typeof AiFieldDialogEnabled>) {
  return <IntegrationGate feature={["chatgpt", "openrouter"]}><AiFieldDialogEnabled {...props} /></IntegrationGate>;
}
