import type { CallFunctions, ReadDoc } from "../../kernel/calls.ts";

type EvidenceSource = { id: string; at?: number; date?: string; subject: string; text: string; transcript: string; channel?: string; from?: string; direction?: string; buyer?: boolean };

export const calls: CallFunctions = {
  startRun(ctx, reads) {
    if (!(reads.eligibility as Array<{ id: string }>).some((d) => d.id === ctx.args.deal)) throw new Error("Coaching with retained evidence requires unrestricted CRM read access.");
    const deal = (reads.deal as Array<{ id: string }>).find((d) => d.id === ctx.args.deal);
    if (!deal) throw new Error("This deal is unavailable.");
    const evidenceSources: EvidenceSource[] = (reads.acts as Array<Record<string, unknown>>).map((a) => ({
      id: String(a.id), ...(typeof a.at === "number" ? { at: a.at } : {}),
      ...(typeof a.date === "string" ? { date: a.date } : {}),
      subject: String(a.subject ?? a.kind ?? "Activity"), text: String(a.text ?? ""), transcript: String(a.transcript ?? ""),
    }));
    for (const thread of (reads.conversations ?? []) as Array<{ channel: string; subject: string | null; messages: Array<{ id: string; at: number; from: string; direction: string; buyer: boolean; text?: string }> }>) {
      for (const message of thread.messages) {
        if (typeof message.text !== "string") continue;
        evidenceSources.push({
          id: message.id, at: message.at, channel: thread.channel, from: message.from, direction: message.direction, buyer: message.buyer,
          subject: `${thread.channel === "email" ? "Email" : "LinkedIn"}: ${thread.subject ?? message.from}`.slice(0, 2000),
          text: message.text, transcript: "",
        });
      }
    }
    if (JSON.stringify(evidenceSources).length > 80_000) throw new Error("This deal's evidence exceeds the coaching run's 80,000-character limit.");
    const key = `${ctx.caller.userId}:${ctx.now}`;
    // The run starts empty and Canon drafts the goal and read on the rep's own model; the rep edits both before the timeline.
    return {
      intents: [
        { op: "put", collection: "nextBestActions", key, data: { deal: deal.id, rep: ctx.caller.userId, goal: "", repRead: "", evidenceSources }, expect: [{ collection: "nextBestActions", key, version: null }] },
        { op: "transition", machine: "nextBestAction", name: "draftGoal", key },
      ],
      value: { key },
    };
  },
  timelineRows(_ctx, reads) {
    const run = reads.run as ReadDoc | null;
    const entries = (run?.data.timeline ?? []) as Array<{ source: string; quote: string }>;
    const sources = new Map(((run?.data.evidenceSources ?? []) as EvidenceSource[]).map((a) => [a.id, a]));
    return { value: {
      briefEvidence: run?.data.briefEvidence ?? [], decisionEvidence: run?.data.decisionEvidence ?? [], steps: run?.data.steps ?? [],
      timeline: entries.map((entry) => {
        const source = sources.get(entry.source);
        return { ...entry, at: source?.at ?? null, date: source?.date ?? source?.at ?? null, subject: source?.subject ?? "Source unavailable" };
      }).sort((a, b) => Number(a.at ?? Infinity) - Number(b.at ?? Infinity)),
    } };
  },
};
