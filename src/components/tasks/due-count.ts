"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useObjectList, type Save } from "@/components/records/use-object-list";
import { useLocalDay } from "@/components/tasks/use-local-day";

export const TASKS_CHANGED = "canon:tasks-changed";

/** How many of the signed-in user's open tasks are overdue or due today; null until known. */
export function useDueTaskCount(): number | null {
  const me = useQuery(api.users.me);
  const today = useLocalDay();
  const { total, rows, reload } = useObjectList(
    me ? {
      object: "task",
      filter: [
        { field: "ownerId", op: "eq", value: me._id },
        { field: "status", op: "neq", value: "completed" },
        { field: "dueDate", op: "lte", value: today },
      ],
      limit: 1,
    } : null,
    { watch: ["status", "dueDate", "ownerId"] },
  );
  useEffect(() => {
    const onChange = (e: Event) => void reload([(e as CustomEvent<Save>).detail]);
    window.addEventListener(TASKS_CHANGED, onChange);
    return () => window.removeEventListener(TASKS_CHANGED, onChange);
  }, [reload]);
  return rows === null ? null : total;
}
