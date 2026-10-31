/**
 * Tasks, calls, events, notes and files, mapped for Canon's activity objects
 * (task, call, meeting, note). Each keeps the Salesforce records it is about
 * (WhoId, WhatId, ParentId, ContentDocumentLink) as `targetSfIds`; Canon
 * resolves them to its own records and adds an `activity_target` edge per
 * target. Pure.
 */
import type { Mapped } from "./mapping.ts";
import { normalizeSfId } from "./mapping.ts";
import type { SfOwner } from "./deals.ts";

export type ActivityObject = "task" | "call" | "meeting" | "note";
export type ActivityValue = string | number | null;

export type ActivityImport = {
  sfId: string;
  object: ActivityObject;
  values: Record<string, ActivityValue>;
  ownerSfId?: string;
  targetSfIds: string[];
  createdAt?: number;
  modifiedAt?: number;
};

export const TASK_FIELDS = [
  "Id", "WhoId", "WhatId", "Subject", "ActivityDate", "Status", "Priority", "TaskSubtype", "CallType", "CallDurationInSeconds", "CallDisposition",
  "Description", "OwnerId", "CreatedDate", "SystemModstamp",
] as const;
export const EVENT_FIELDS = ["Id", "WhoId", "WhatId", "Subject", "StartDateTime", "EndDateTime", "Location", "Description", "OwnerId", "CreatedDate", "SystemModstamp"] as const;
export const NOTE_FIELDS = ["Id", "ParentId", "Title", "Body", "OwnerId", "CreatedDate", "SystemModstamp"] as const;
export const DOCUMENT_FIELDS = ["Id", "Title", "FileType", "FileExtension", "ContentSize", "OwnerId", "CreatedDate", "SystemModstamp"] as const;

const TASK_STATUS: Record<string, string> = {
  "not started": "not_started", "open": "not_started", "in progress": "in_progress", "completed": "completed", "closed": "completed",
  "waiting on someone else": "waiting", "waiting": "waiting", "deferred": "deferred",
};
const CALL_OUTCOME: Record<string, string> = {
  connected: "connected", "left voicemail": "left_voicemail", voicemail: "left_voicemail", "no answer": "no_answer", busy: "busy", "wrong number": "wrong_number",
};

const time = (v: string | undefined) => {
  const t = v ? Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const text = (v: string | undefined, max = 32_000) => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const lower = (v: string | undefined) => (v ?? "").trim().toLowerCase();

function base(row: Record<string, string>, owners: ReadonlyMap<string, SfOwner>, targets: Array<string | undefined>) {
  const ownerSfId = normalizeSfId(row.OwnerId);
  const memberId = ownerSfId ? owners.get(ownerSfId)?.memberId : undefined;
  return {
    owner: { ownerId: memberId ?? null } as Record<string, ActivityValue>,
    meta: {
      ...(ownerSfId ? { ownerSfId } : {}),
      targetSfIds: [...new Set(targets.map((t) => normalizeSfId(t)).filter((t): t is string => t !== undefined))],
      ...(time(row.CreatedDate) !== undefined ? { createdAt: time(row.CreatedDate) } : {}),
      ...(time(row.SystemModstamp) !== undefined ? { modifiedAt: time(row.SystemModstamp) } : {}),
    },
  };
}

/** A Task: a call when Salesforce logged it as one (TaskSubtype Call), else a task. */
export function mapTask(row: Record<string, string>, owners: ReadonlyMap<string, SfOwner>): Mapped<ActivityImport> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const { owner, meta } = base(row, owners, [row.WhoId, row.WhatId]);
  if (lower(row.TaskSubtype) === "call") {
    const disposition = text(row.CallDisposition, 200);
    const notes = [text(row.Description), disposition && !CALL_OUTCOME[lower(disposition)] ? `Call result: ${disposition}` : null].filter(Boolean).join("\n\n");
    const direction = lower(row.CallType);
    return {
      ok: {
        sfId, object: "call", ...meta,
        values: {
          subject: text(row.Subject, 500), direction: direction === "inbound" || direction === "outbound" ? direction : null,
          outcome: CALL_OUTCOME[lower(disposition ?? "")] ?? null, callAt: time(row.ActivityDate) ?? meta.createdAt ?? null,
          durationSeconds: row.CallDurationInSeconds ? Number(row.CallDurationInSeconds) : null, notes: notes || null, ...owner,
        },
      },
    };
  }
  return {
    ok: {
      sfId, object: "task", ...meta,
      values: {
        subject: text(row.Subject, 500) ?? "Task", status: TASK_STATUS[lower(row.Status)] ?? null, priority: ["high", "normal", "low"].includes(lower(row.Priority)) ? lower(row.Priority) : null,
        dueDate: /^\d{4}-\d{2}-\d{2}/.test(row.ActivityDate ?? "") ? row.ActivityDate.slice(0, 10) : null, description: text(row.Description), ...owner,
      },
    },
  };
}

export function mapEvent(row: Record<string, string>, owners: ReadonlyMap<string, SfOwner>): Mapped<ActivityImport> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const startAt = time(row.StartDateTime);
  if (startAt === undefined) return { reject: "Event has no start time" };
  const { owner, meta } = base(row, owners, [row.WhoId, row.WhatId]);
  return {
    ok: {
      sfId, object: "meeting", ...meta,
      values: { title: text(row.Subject, 500) ?? "Meeting", startAt, endAt: time(row.EndDateTime) ?? null, location: text(row.Location, 500), notes: text(row.Description), ...owner },
    },
  };
}

/** A classic Note (the Note object, before Salesforce's ContentNote). */
export function mapLegacyNote(row: Record<string, string>, owners: ReadonlyMap<string, SfOwner>): Mapped<ActivityImport> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const body = [text(row.Title, 500), text(row.Body)].filter(Boolean).join("\n\n");
  if (!body) return { reject: "Note is empty" };
  const { owner, meta } = base(row, owners, [row.ParentId]);
  return { ok: { sfId, object: "note", ...meta, values: { body, ...owner } } };
}

/** A note's HTML body (ContentNote) as plain text, paragraphs kept. */
export function noteText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

/**
 * A ContentDocument: a note (FileType SNOTE) with its text, or a file Canon
 * keeps as a reference, since Canon has no file storage yet. `links` are the
 * records it is shared to; `content` is a note's body when it was read.
 */
export function mapDocument(
  row: Record<string, string>, owners: ReadonlyMap<string, SfOwner>, links: readonly string[], instanceUrl: string, content?: string,
): Mapped<ActivityImport> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  // A file shared only to users is someone's own file, not about a record.
  const targets = links.filter((id) => !id.startsWith("005"));
  if (!targets.length) return { reject: "Not linked to any record (only to users)" };
  const { owner, meta } = base(row, owners, targets);
  const title = text(row.Title, 500) ?? "Untitled";
  if (lower(row.FileType) === "snote") {
    const body = [title, content ? noteText(content) : null].filter(Boolean).join("\n\n");
    return { ok: { sfId, object: "note", ...meta, values: { body, ...owner } } };
  }
  const name = row.FileExtension ? `${title}.${row.FileExtension}` : title;
  const link = `${instanceUrl.replace(/\/$/, "")}/lightning/r/ContentDocument/${sfId}/view`;
  const bytes = Number(row.ContentSize);
  return { ok: { sfId, object: "note", ...meta, values: { body: `File in Salesforce: ${name}${Number.isFinite(bytes) && bytes > 0 ? ` (${size(bytes)})` : ""}\n${link}`, ...owner } } };
}
