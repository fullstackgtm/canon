var calls = {
  startRun(ctx, reads) {
    if (!reads.eligibility.some((d) => d.id === ctx.args.deal)) throw new Error("Coaching with retained evidence requires unrestricted CRM read access.");
    const deal = reads.deal.find((d) => d.id === ctx.args.deal);
    if (!deal) throw new Error("This deal is unavailable.");
    const evidenceSources = reads.acts.map((a) => ({
      id: String(a.id),
      ...typeof a.at === "number" ? { at: a.at } : {},
      ...typeof a.date === "string" ? { date: a.date } : {},
      subject: String(a.subject ?? a.kind ?? "Activity"),
      text: String(a.text ?? ""),
      transcript: String(a.transcript ?? "")
    }));
    for (const thread of reads.conversations ?? []) {
      for (const message of thread.messages) {
        if (typeof message.text !== "string") continue;
        evidenceSources.push({
          id: message.id,
          at: message.at,
          channel: thread.channel,
          from: message.from,
          direction: message.direction,
          buyer: message.buyer,
          subject: `${thread.channel === "email" ? "Email" : "LinkedIn"}: ${thread.subject ?? message.from}`.slice(0, 2e3),
          text: message.text,
          transcript: ""
        });
      }
    }
    if (JSON.stringify(evidenceSources).length > 8e4) throw new Error("This deal's evidence exceeds the coaching run's 80,000-character limit.");
    const key = `${ctx.caller.userId}:${ctx.now}`;
    return {
      intents: [
        { op: "put", collection: "nextBestActions", key, data: { deal: deal.id, rep: ctx.caller.userId, goal: "", repRead: "", evidenceSources }, expect: [{ collection: "nextBestActions", key, version: null }] },
        { op: "transition", machine: "nextBestAction", name: "draftGoal", key }
      ],
      value: { key }
    };
  },
  timelineRows(_ctx, reads) {
    const run = reads.run;
    const entries = run?.data.timeline ?? [];
    const sources = new Map((run?.data.evidenceSources ?? []).map((a) => [a.id, a]));
    return { value: {
      briefEvidence: run?.data.briefEvidence ?? [],
      decisionEvidence: run?.data.decisionEvidence ?? [],
      steps: run?.data.steps ?? [],
      timeline: entries.map((entry) => {
        const source = sources.get(entry.source);
        return { ...entry, at: source?.at ?? null, date: source?.date ?? source?.at ?? null, subject: source?.subject ?? "Source unavailable" };
      }).sort((a, b) => Number(a.at ?? Infinity) - Number(b.at ?? Infinity))
    } };
  }
};
export {
  calls
};
