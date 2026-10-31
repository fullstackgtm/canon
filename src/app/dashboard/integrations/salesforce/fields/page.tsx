"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { sfSync } from "@/components/salesforce-sync/data";
import { Panel } from "@/components/salesforce-sync/ui";
import { SYNC_AUTHORITIES, type SyncAuthority } from "@/components/salesforce-sync/types";
import { SelectField } from "@/components/ui/select";

const AUTHORITY_HELP: Record<SyncAuthority, string> = {
  fsgtm: "CanonCRM wins",
  salesforce: "Salesforce wins",
  newest: "Most recent edit wins",
  review: "Send to the review queue",
};

export default function SalesforceFieldsPage() {
  const objects = sfSync.useObjects();
  const [picked, setPicked] = useState<string | null>(null);
  const object = picked ?? objects?.[0]?.apiName ?? null;
  const fields = sfSync.useFields(object);
  const setAuthority = sfSync.useSetFieldAuthority();
  const [filter, setFilter] = useState("");

  const visible = (fields ?? []).filter(
    (f) => !filter || f.apiName.toLowerCase().includes(filter.toLowerCase()) || f.label.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Panel title="Field authority" testId="sf-fields">
      <p className="mb-4 max-w-[70ch] text-sm text-muted-foreground">
        Choose which system wins when the same field changes on both sides.{" "}
        {SYNC_AUTHORITIES.map((a) => `${a}: ${AUTHORITY_HELP[a]}`).join(" · ")}.
      </p>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-sm">
          Object
          <SelectField
            aria-label="Object"
            value={object ?? ""}
            onValueChange={setPicked}
            options={(objects ?? []).map((o) => ({ value: o.apiName, label: `${o.label} (${o.apiName})` }))}
          />
        </label>
        <input
          aria-label="Filter fields"
          placeholder="Filter fields"
          className="border border-border bg-background px-2 py-1 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {fields === undefined ? (
        <p className="text-sm text-muted-foreground">{objects?.length === 0 ? "No objects described yet." : "Loading fields…"}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1">Field</th>
              <th>Type</th>
              <th>Authority</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f._id} className="border-t border-border" data-testid={`sf-field-${f.apiName}`}>
                <td className="py-1.5">
                  {f.label} <span className="font-mono text-xs text-muted-foreground">{f.apiName}</span>
                </td>
                <td>
                  {f.type}
                  {!f.updateable && <span className="ml-1 text-xs text-muted-foreground">(read-only in Salesforce)</span>}
                </td>
                <td>
                  <SelectField
                    aria-label={`Authority for ${f.apiName}`}
                    value={f.syncAuthority}
                    onValueChange={(v) =>
                      void setAuthority({ object: f.object, apiName: f.apiName, syncAuthority: v as SyncAuthority })
                        .then(() => toast.success(`${f.apiName}: ${v}`))
                        .catch((err) => toast.error(getErrorMessage(err)))
                    }
                    options={SYNC_AUTHORITIES.map((a) => ({ value: a, label: a, disabled: !f.updateable && a !== "salesforce" }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
