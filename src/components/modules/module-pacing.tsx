"use client";

import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Node } from "../../../modules/kernel/manifest";
import { LoadingRows } from "@/components/dashboard";
import { PacingExplorer } from "@/components/reports/pacing-view";

export function ModulePacing({ n, module }: { n: Extract<Node, { c: "pacing" }>; module: string }) {
  const context = useQuery(api.modules.pacingContext, { module, id: n.id });
  const run = useAction(api.modules.pacing);
  if (!context) return <LoadingRows count={4} />;
  if (!context.sources.length) return <p className="text-sm text-muted-foreground">You do not read the fields this pacing chart needs.</p>;
  return <section className="space-y-3">
    {n.title && <h2 className="font-display text-lg">{n.title}</h2>}
    <PacingExplorer key={`${module}:${n.id}:${context.userId}:${context.role}`} plans={context.plans} roster={context.roster} meId={context.userId ?? ""} meRole={context.role}
      sources={context.sources.map((s) => ({ ...s, fields: s.fields.map((f) => f.name) }))}
      run={({ measure, ...args }) => run({ module, id: n.id, source: measure, ...args })} />
  </section>;
}
