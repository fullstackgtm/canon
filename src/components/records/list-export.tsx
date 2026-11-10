"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { Download } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { IN_VALUES_MAX, LIST_LIMIT_MAX, type ListRow } from "../../../convex/lib/objects/listSpec";
import { EXPORT_ROWS_MAX, exportFileName, listCsv, type ExportField } from "@/lib/list-csv";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { downloadCsv } from "./audience-actions";
import type { ObjectDescription, TeamMember } from "./fields";
import type { ListQuery } from "./use-object-list";
import { useWorkspaceMoney } from "./money";

const LOOKUP_BATCH = Math.min(IN_VALUES_MAX, LIST_LIMIT_MAX);

/** Downloads every row the list's filters match (up to EXPORT_ROWS_MAX), in its order, with its columns. */
export function ExportView({ desc, query, columns, team, className }: { desc: ObjectDescription; query: ListQuery; columns: readonly string[]; team?: readonly TeamMember[]; className: string }) {
  const list = useAction(api.objects.list);
  const money = useWorkspaceMoney();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { object, filter, sort, deleted } = query;
      const rows: ListRow[] = [];
      let cursor: string | undefined;
      let total = 0;
      do {
        const page = await list({ object, filter, ...(sort ? { sort } : {}), ...(deleted ? { deleted } : {}), limit: Math.min(LIST_LIMIT_MAX, EXPORT_ROWS_MAX - rows.length), ...(cursor ? { cursor } : {}) });
        rows.push(...page.rows);
        total = page.total;
        cursor = page.nextCursor ?? undefined;
      } while (cursor && rows.length < EXPORT_ROWS_MAX);

      const fields = desc.fields as unknown as ExportField[];
      const titles: Record<string, string> = {};
      for (const f of fields.filter((x) => x.type === "lookup" && x.lookupTo && columns.includes(x.apiName))) {
        const ids = [...new Set(rows.flatMap((r) => (typeof r.values[f.fieldId] === "string" && r.values[f.fieldId] ? [r.values[f.fieldId] as string] : [])))].filter((id) => !(id in titles));
        for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
          const batch = ids.slice(i, i + LOOKUP_BATCH);
          const page = await list({ object: f.lookupTo as ListQuery["object"], filter: [{ field: "id", op: "in", value: batch }], limit: batch.length });
          for (const r of page.rows) titles[r.id] = r.title;
        }
      }

      const titleLabel = desc.fields.find((f) => f.fieldId === desc.titleFieldId)?.label ?? "Name";
      const users = new Map((team ?? []).map((u) => [u._id, u.name]));
      downloadCsv(exportFileName(desc.pluralLabel, new Date()), listCsv({ fields, titleLabel, columns, rows, users, titles, currency: money.currency }));
      if (total > rows.length) void toast.info(`Exported the first ${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}. Narrow the filters to export the rest.`);
      else void toast.success(`Exported ${rows.length.toLocaleString("en-US")} ${desc.pluralLabel.toLowerCase()}`);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" disabled={busy} onClick={() => void run()} className={className}>
      <Download className="h-3 w-3" /> {busy ? "Exporting…" : "Export view"}
    </button>
  );
}
