"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SelectField } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/utils";
import type { ReportEnv } from "./module-report";

const control = "border border-border bg-background px-2 py-1 text-sm";

export function ModulePinControl({ reportId, env }: { reportId: Id<"reports">; env: ReportEnv }) {
  const boards = useQuery(api.modules.dashboards, { module: env.module });
  const pin = useMutation(api.modules.pinReport);
  const [name, setName] = useState<string | null>(null);
  const editable = boards?.filter((d) => d.canChange) ?? [];
  const done = (id: string) => {
    setName(null);
    toast.success("Pinned to dashboard", { action: { label: "Open", onClick: () => { window.location.href = `/dashboard/m/${env.module}/${env.dashboards}?d=${id}`; } } });
  };
  if (name !== null) return <form className="flex items-center gap-2" onSubmit={(e) => {
    e.preventDefault();
    void pin({ module: env.module, reportId, name }).then(done).catch((e) => toast.error(getErrorMessage(e)));
  }}>
    <input aria-label="New dashboard name" placeholder="Dashboard name" autoFocus className={control} value={name} onChange={(e) => setName(e.target.value)} />
    <button type="submit" className={control} disabled={env.readOnly}>Pin</button>
    <button type="button" onClick={() => setName(null)}>Cancel</button>
  </form>;
  return <SelectField aria-label="Pin to dashboard" value="" disabled={env.readOnly} onValueChange={(id) => {
    if (id === "new") setName("");
    else if (id) void pin({ module: env.module, reportId, dashboardId: id as Id<"dashboards"> }).then(done).catch((e) => toast.error(getErrorMessage(e)));
  }} options={[{ value: "", label: "Pin to dashboard" }, ...editable.map((d) => ({ value: d._id, label: d.name })), { value: "new", label: "New dashboard…" }]} />;
}

