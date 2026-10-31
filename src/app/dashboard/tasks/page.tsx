"use client";

import { useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useQuery } from "convex/react";
import { CheckSquare } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ListRow } from "../../../../convex/lib/objects/listSpec";
import { EmptyState, LoadingRows, ViewFrame, ReadFailure } from "@/components/dashboard";
import type { TeamMember } from "@/components/records/fields";
import { RecordPicker, useLookupTitles, type PickedRecord } from "@/components/records/lookup-field";
import { RecordLink } from "@/components/records/record-context";
import { useObjectList, type Save } from "@/components/records/use-object-list";
import { TASKS_CHANGED } from "@/components/tasks/due-count";
import { useTaskWrite } from "@/components/tasks/use-task-write";
import { useLocalDay } from "@/components/tasks/use-local-day";
import { Button } from "@/components/ui/button";
import { GROUP_LABELS, GROUP_ORDER, groupTasks, type TaskRow } from "@/lib/my-tasks";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

const input = "border border-border bg-background px-2 py-1 text-sm";
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const LINKS = [["accountId", "account"], ["contactId", "contact"], ["dealId", "deal"]] as const;

/** A listed task: the row (id, version, values) and the fields the grouping reads. */
type Row = { row: ListRow; task: TaskRow };
const asTask = (row: ListRow): Row => ({ row, task: { id: row.id, subject: text(row.values.subject) ?? row.title, dueDate: text(row.values.dueDate), status: text(row.values.status) } });

export default function MyTasksPage() {
  const me = useQuery(api.users.me);
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const desc = useQuery(api.objects.describe, { object: "task" });
  const write = useTaskWrite();
  const today = useLocalDay();
  const subjectInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"open" | "done">("open");

  const query = me
    ? {
        object: "task" as const,
        filter: [{ field: "ownerId", op: "eq" as const, value: me._id }, { field: "status", op: tab === "open" ? "neq" as const : "eq" as const, value: "completed" }],
        sort: tab === "open" ? { field: "dueDate", dir: "asc" as const } : { field: "updatedAt", dir: "desc" as const },
        limit: 200,
      }
    : null;
  const { rows, reload, hasMore, loadMore, error } = useObjectList(query, { watch: ["status", "dueDate", "ownerId"] });
  const tasks = useMemo(() => rows?.map(asTask) ?? null, [rows]);
  const groups = useMemo(() => (tasks ? groupTasks(tasks.map((t) => t.task), today) : null), [tasks, today]);
  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.row.id, t])), [tasks]);
  const titles = useLookupTitles(desc?.fields.filter((f) => LINKS.some(([k]) => k === f.apiName)) ?? [], rows);

  async function save(row: (Pick<ListRow, "id" | "version"> & Partial<Pick<ListRow, "values">>) | null, values: Record<string, string | null>): Promise<boolean> {
    try {
      const r = await write({
        object: "task", values, ...(row ? { streamId: row.id as Id<"canonEntities">, expectedVersion: row.version } : {}),
      });
      if (r.status === "invalid") {
        toast.error(r.errors.map((e) => e.message).join("; "));
        return false;
      }
      if (r.status !== "applied" && r.status !== "proposed") {
        toast.error("That task changed elsewhere. Reloaded.");
        void reload();
        return false;
      }
      const saved: Save = { shard: r.shard, seq: r.seq };
      void reload([saved]);
      window.dispatchEvent(new CustomEvent(TASKS_CHANGED, { detail: saved }));
      if (r.status === "proposed") toast.success("Task change proposed for review");
      else if (row && values.status === "completed") toast.success("Task completed", { action: { label: "Undo", onClick: () => void save({ id: row.id, version: r.version }, { status: text(row.values?.status) ?? "not_started" }) } });
      return true;
    } catch (cause) {
      toast.error(getErrorMessage(cause));
      return false;
    }
  }

  const renderRow = (task: TaskRow) => {
    const item = byId.get(task.id);
    return item && <TaskItem key={task.id} row={item.row} task={task} today={today} team={team} titles={titles} writable={Boolean(desc?.writable)} onSave={(values) => save(item.row, values)} />;
  };

  return (
    <ViewFrame title="My work" description="Follow up, move a date or hand work to a teammate." actions={[
      { id: "tasks-refresh", label: "Refresh", onClick: () => void reload() },
      ...(me && desc?.canCreate ? [{ id: "tasks-new", label: "New task", onClick: () => subjectInput.current?.focus(), primary: true }] : []),
    ]} controls={<div className="mb-4 flex gap-1" role="tablist">
        {(["open", "done"] as const).map((t) => (
          <Button key={t} role="tab" aria-selected={tab === t} size="xs" variant={tab === t ? "secondary" : "outline"} onClick={() => setTab(t)}>
            {t === "open" ? "Open" : "Done"}
          </Button>
        ))}
      </div>}>
      {me && desc?.canCreate && <NewTask inputRef={subjectInput} meId={me._id} team={team} onCreate={(values) => save(null, values)} />}

      {error && <ReadFailure message={error} retry={() => void reload()} retained={rows !== null} />}
      {!tasks || !groups ? (
        error ? null : <LoadingRows />
      ) : tab === "done" ? (
        tasks.length ? <ul>{tasks.map((t) => renderRow(t.task))}</ul> : <EmptyState icon={CheckSquare} title="Nothing completed yet" description="Tasks you finish show up here." />
      ) : tasks.length === 0 ? (
        <EmptyState icon={CheckSquare} title="No open tasks" description="Log a task from an account page, or add one above." />
      ) : (
        GROUP_ORDER.filter((key) => groups[key].length).map((key) => (
          <section key={key} className="mb-6" aria-label={GROUP_LABELS[key]}>
            <h3 className={cn("mb-1 text-xs font-medium", key === "overdue" ? "text-destructive" : "text-muted-foreground")}>
              {GROUP_LABELS[key]} · {groups[key].length}
            </h3>
            <ul>{groups[key].map((t) => renderRow(t))}</ul>
          </section>
        ))
      )}
      {hasMore && <Button size="xs" variant="outline" onClick={() => void loadMore()}>Load more</Button>}
    </ViewFrame>
  );
}

function TaskItem({ row, task, today, team, titles, writable, onSave }: {
  row: ListRow;
  task: TaskRow;
  today: string;
  team?: readonly TeamMember[];
  titles: Record<string, string>;
  writable: boolean;
  onSave: (values: Record<string, string | null>) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const save = async (values: Record<string, string | null>) => { setSaving(true); try { await onSave(values); } finally { setSaving(false); } };
  const done = task.status === "completed";
  const link = LINKS.flatMap(([field, object]) => {
    const id = text(row.values[field]);
    return id ? [{ object, id }] : [];
  })[0];
  return (
    <li className="flex items-center gap-3 border-b border-border py-2">
      <input
        type="checkbox" aria-label={done ? `Reopen ${task.subject}` : `Complete ${task.subject}`} checked={done} disabled={!writable || saving}
        onChange={() => void save({ status: done ? "not_started" : "completed" })}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", done && "text-muted-foreground line-through")}>{task.subject}</div>
        {link && (
          <RecordLink object={link.object} id={link.id} className="text-xs text-muted-foreground underline hover:text-foreground">
            {titles[link.id] ?? link.id}
          </RecordLink>
        )}
      </div>
      <input
        type="date" aria-label={`Due date for ${task.subject}`} value={task.dueDate ?? ""}
        className={cn(input, !done && task.dueDate && task.dueDate < today && "text-destructive")}
        disabled={!writable || saving} onChange={(e) => void save({ dueDate: e.target.value || null })}
      />
      <SelectField
        aria-label={`Owner of ${task.subject}`} value={text(row.values.ownerId) ?? ""}
        disabled={!writable || saving} onValueChange={(v) => void save({ ownerId: v || null })}
        options={[
          { value: "", label: "Unassigned" },
          ...(team ?? []).filter((u) => u.isActive !== false || u._id === row.values.ownerId).map((u) => ({ value: u._id, label: u.name })),
        ]}
      />
    </li>
  );
}

function NewTask({ inputRef, meId, team, onCreate }: {
  inputRef: RefObject<HTMLInputElement | null>;
  meId: string;
  team?: readonly TeamMember[];
  onCreate: (values: Record<string, string | null>) => Promise<boolean>;
}) {
  const [subject, setSubject] = useState("");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState(meId);
  const [account, setAccount] = useState<PickedRecord | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await onCreate({ subject, dueDate: due || null, status: "not_started", ownerId: owner || null, accountId: account?.id ?? null }).finally(() => setSaving(false));
    if (ok) {
      setSubject("");
      setDue("");
      setAccount(null);
    }
  }

  return (
    <form onSubmit={submit} className="mb-6 flex flex-wrap items-center gap-2 border border-border p-2">
      <input ref={inputRef} aria-label="New task subject" placeholder="New task" required value={subject} onChange={(e) => setSubject(e.target.value)} className={cn(input, "min-w-48 flex-1")} />
      <input type="date" aria-label="New task due date" value={due} onChange={(e) => setDue(e.target.value)} className={input} />
      <SelectField aria-label="New task owner" value={owner} onValueChange={setOwner}
        options={[{ value: "", label: "Unassigned" }, ...(team ?? []).filter((u) => u.isActive !== false).map((u) => ({ value: u._id, label: u.name }))]} />
      <div className="w-48">
        {account ? (
          <button type="button" className="text-xs underline" onClick={() => setAccount(null)}>{account.title} (clear)</button>
        ) : (
          <RecordPicker object="account" label="Company (optional)" onPick={setAccount} />
        )}
      </div>
      <Button type="submit" size="xs" disabled={saving}>Add task</Button>
    </form>
  );
}
