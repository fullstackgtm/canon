"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { can } from "../../../../../convex/lib/capabilities";
import { DataModelTab } from "../data-model-editor";
import { RecipesSubpage } from "../workspace-page";

export default function DataModelPage() {
  return (
    <RecipesSubpage title="Data model" description="Each object's standard and custom fields, and the workspace's own objects. Admins add, rename, hide and archive fields and objects.">
      <DataModelTab />
      <RecentChanges />
    </RecipesSubpage>
  );
}

function RecentChanges() {
  const me = useQuery(api.users.me, {});
  const changes = useQuery(api.dataModel.history, me && can(me, "dataModel.edit") ? { limit: 20 } : "skip");
  if (!changes) return null;
  return <section className="mt-6 border-t border-border pt-4">
    <h2 className="text-sm font-medium">Recent changes</h2>
    {changes.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No changes recorded yet.</p>}
    <ul className="mt-2 divide-y divide-border text-xs">
      {changes.map((change) => <li key={change._id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
        <time className="text-muted-foreground" dateTime={new Date(change.at).toISOString()}>{new Date(change.at).toLocaleString()}</time>
        <span>{change.memberName}</span>
        {change.agent && <span title={change.agent} className="border border-border px-1 text-muted-foreground">agent</span>}
        <span>{change.summary}</span>
      </li>)}
    </ul>
  </section>;
}
