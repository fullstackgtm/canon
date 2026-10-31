"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { DealPeople } from "../../../convex/dealCommittee";
import { ROLE_LABEL, SLOTS, seniorityLabel, seniorityRank, suggestCommittee, type DealRole, type Person, type Slot } from "../../../convex/lib/committee";
import { SelectField } from "@/components/ui/select";

const head = "text-xs font-medium text-muted-foreground";
const btn = "border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
/** The slots a pincer needs; the panel always shows them and counts them as coverage. */
const CORE: readonly Slot[] = ["executive", "n1", "champion"];

function Level({ title }: { title?: string | null }) {
  const level = seniorityLabel(title ?? undefined);
  return level ? <span className="ml-2 border border-border px-1 text-xs font-medium text-muted-foreground">{level}</span> : null;
}

/**
 * A deal's buying committee on its record page: who holds each slot, Canon's
 * picks for the empty ones, and an add row. People on the deal with no slot
 * (Involved) are listed with the deal's people, not here.
 */
export function DealCommittee({ data, busy, onSet, onRemove }: {
  data: DealPeople;
  busy: boolean;
  onSet: (role: DealRole, contactId: string, reason?: string) => Promise<void>;
  onRemove: (contactId: string) => Promise<void>;
}) {
  const [addSlot, setAddSlot] = useState<Slot>("user");
  const [addPerson, setAddPerson] = useState("");
  const { companyId, companyPeople: people } = data;
  const members = useMemo(() => data.members.filter((m) => m.role !== "involved"), [data]);
  const onCommittee = useMemo(() => new Set(members.map((m) => m.contactId)), [members]);
  const suggestions = useMemo(() => {
    const holder = (slot: Slot) => members.find((m) => m.role === slot)?.contactId;
    return suggestCommittee(people, { executive: holder("executive"), n1: holder("n1") }, onCommittee);
  }, [people, members, onCommittee]);
  const free = useMemo(() => people.filter((p) => !onCommittee.has(p.id)).sort((a, b) => seniorityRank(b.title) - seniorityRank(a.title) || a.fullName.localeCompare(b.fullName)), [people, onCommittee]);
  const put = (slot: Slot, person: Person, reason?: string) => onSet(slot, person.id, reason);

  const covered = CORE.filter((s) => members.some((m) => m.role === s)).length;
  const shown = SLOTS.filter((s) => CORE.includes(s) || members.some((m) => m.role === s));
  const byId = (id: string) => people.find((p) => p.id === id);
  const pending = suggestions.filter((s) => byId(s.contactId));

  return (
    <section className="mt-6 border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className={head}>Buying committee</h2>
        <div className="flex items-center gap-3">
          {data.canEdit && pending.length > 1 && (
            <button type="button" disabled={busy} className={btn} onClick={() => void (async () => { for (const s of pending) await put(s.slot, byId(s.contactId)!, s.reason); })()}>
              Use Canon&apos;s picks
            </button>
          )}
          <span className="text-xs font-medium text-muted-foreground">Coverage {covered} of {CORE.length}</span>
        </div>
      </div>
      {!companyId ? (
        <p className="text-sm text-muted-foreground">Link this deal to a company to choose its committee from the company&apos;s people.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <tbody>
              {shown.map((slot) => {
                const holders = members.filter((m) => m.role === slot);
                const suggestion = holders.length === 0 ? pending.find((s) => s.slot === slot) : undefined;
                const suggested = suggestion ? byId(suggestion.contactId) : undefined;
                return (
                  <tr key={slot} className="border-t border-border align-top first:border-t-0">
                    <td className="w-32 py-2 text-xs font-medium text-muted-foreground">{ROLE_LABEL[slot]}</td>
                    <td className="py-2">
                      {holders.map((m) => (
                        <div key={m.contactId} className="flex items-start justify-between gap-2">
                          <div>
                            <span className="font-medium">{m.name}</span>
                            {m.title && <span className="text-muted-foreground"> · {m.title}</span>}
                            <Level title={m.title} />
                            {!m.atCompany && <div className="text-xs text-amber-600">Not among this company&apos;s people</div>}
                            {m.reason &&<div className="text-xs text-muted-foreground">Picked by Canon: {m.reason}</div>}
                          </div>
                          {data.canEdit && (
                            <button type="button" aria-label={`Remove ${m.name}`} disabled={busy} onClick={() => void onRemove(m.contactId)} className="p-1 text-muted-foreground hover:text-foreground">
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      ))}
                      {suggestion && suggested && (
                        <div className="flex items-start justify-between gap-2 text-muted-foreground">
                          <div>
                            <span>Canon suggests {suggested.fullName}</span>
                            {suggested.title && <span> · {suggested.title}</span>}
                            <Level title={suggested.title} />
                            <div className="text-xs">{suggestion.reason}</div>
                          </div>
                          {data.canEdit && <button type="button" disabled={busy} className={btn} onClick={() => void put(slot, suggested, suggestion.reason)}>Use</button>}
                        </div>
                      )}
                      {holders.length === 0 && !suggested && (
                        <span className="text-muted-foreground">
                          {slot === "champion" ? "None yet" : people.length === 0 ? "No people at this company yet" : "No one senior enough to suggest"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.canEdit && free.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <SelectField aria-label="Slot" value={addSlot} onValueChange={(v) => setAddSlot(v as Slot)}
                options={SLOTS.map((s) => ({ value: s, label: ROLE_LABEL[s] }))} />
              <SelectField aria-label="Person" value={addPerson} onValueChange={setAddPerson} className="min-w-0 flex-1"
                options={[
                  { value: "", label: "Choose a person at this company" },
                  ...free.map((p) => ({ value: p.id, label: `${p.fullName}${p.title ? ` · ${p.title}` : ""}` })),
                ]} />
              <button
                type="button"
                disabled={busy || !addPerson}
                className={btn}
                onClick={() => { const p = byId(addPerson); if (p) void put(addSlot, p).then(() => setAddPerson("")); }}
              >
                Add
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
