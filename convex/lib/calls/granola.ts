/**
 * Granola (public API, https://docs.granola.ai) adapter: list the notes changed
 * since the last poll and read each one with its attendees, AI summary and
 * transcript. The fetch is injected, so tests run it against a fake HTTP layer.
 *
 * The key goes only in the Authorization header. Errors carry the HTTP status
 * and never the response body or the key.
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";

export const GRANOLA_BASE_URL = "https://public-api.granola.ai";
/** Granola's page-size cap for GET /v1/notes. */
export const GRANOLA_PAGE = 30;
/** Notes one poll reads in full. Granola allows 5 requests a second; the rest wait for the next poll. */
export const GRANOLA_NOTES_PER_POLL = 40;
/**
 * List pages one poll reads to find the oldest changed notes (3,000 notes). Granola's list order is not
 * documented, so a window with more changed notes than this is refused rather than read in part.
 */
const LIST_PAGES_MAX = 100;
/** How far back an import may look, in days: the choices on the Granola page. */
export const GRANOLA_LOOKBACK_DAYS = [7, 14, 30, 90, 180, 365] as const;
export const GRANOLA_DEFAULT_LOOKBACK_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Meetings older than this when imported (a backfill) log history only: they propose no deal or contact updates. */
export const CALL_FACTS_MAX_AGE_MS = 7 * DAY_MS;

export class GranolaWindowTooLargeError extends Error {
  constructor() {
    super(`More than ${(LIST_PAGES_MAX * GRANOLA_PAGE).toLocaleString("en-US")} Granola notes changed in this window. Choose a shorter lookback on the Granola page.`);
    this.name = "GranolaWindowTooLargeError";
  }
}

export class GranolaError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401 || status === 403
        ? `Granola rejected the API key (HTTP ${status}). Create a new one in Granola under Settings, API.`
        : status === 429
          ? "Granola is rate limiting this key (HTTP 429). The next check retries."
          : `Granola request failed (HTTP ${status}).`,
    );
    this.name = "GranolaError";
    this.status = status;
  }
}

export type GranolaPerson = { name: string | null; email: string };

/**
 * One transcript line's side and times, as Granola sent them: `microphone` is the note owner (the rep), `speaker`
 * everyone else. Times are seconds from the first line's start, null when Granola sent none for the line.
 */
export type GranolaSegment = { side: "rep" | "customer"; startSeconds: number | null; endSeconds: number | null };
/** `sourceMetadata.timings` on a Granola call whose segments carry the note's sides and times, or never can. */
export const TIMINGS_VERSION = 1;
/** Lines whose sides and times an import keeps, at most (a Convex array holds 8,192; this is about 13 hours of talk). */
export const GRANOLA_SEGMENTS_MAX = 8000;

/** One meeting as Canon uses it. */
export type GranolaMeeting = {
  noteId: string;
  title: string;
  /** The calendar event's start when Granola has one, else the first transcript line, else when the note was made. */
  startAt: number;
  endAt: number | null;
  durationSeconds: number | null;
  owner: GranolaPerson | null;
  /** Everyone on the meeting but the note's owner: attendees and calendar invitees, by lowercased email. */
  attendees: GranolaPerson[];
  summary: string | null;
  webUrl: string | null;
  /** "Name: text" per line; the owner's side reads as their name. Empty when Granola kept no transcript. */
  transcriptText: string;
  /** Each line of `transcriptText`, in order: its side and times. */
  segments: GranolaSegment[];
  /** ISO 8601 as Granola sent it: the next poll's `updated_after`. */
  updatedAt: string;
};

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const ms = (x: unknown): number | null => {
  const t = Date.parse(str(x) ?? "");
  return Number.isFinite(t) ? t : null;
};

function personOf(raw: unknown): GranolaPerson | null {
  const r = rec(raw);
  const email = str(r.email)?.toLowerCase();
  return email && email.includes("@") ? { name: str(r.name), email } : null;
}

/** A speaker name that reads back as one line's speaker (engine/src/calls.ts parseTranscript): no colon or brackets, at most 60 characters. */
const speakerLabel = (name: string) => name.replace(/[:[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim() || "Them";

/** A note from GET /v1/notes/{id}, or null without the id Granola always sends. */
export function meetingOf(raw: unknown): GranolaMeeting | null {
  const r = rec(raw);
  const noteId = str(r.id);
  const updatedAt = str(r.updated_at) ?? str(r.created_at);
  if (!noteId || !updatedAt) return null;
  const owner = personOf(r.owner);
  const calendar = rec(r.calendar_event);

  const people = new Map<string, GranolaPerson>();
  for (const p of [...arr(r.attendees), ...arr(calendar.invitees)].map(personOf)) {
    if (!p || p.email === owner?.email) continue;
    const seen = people.get(p.email);
    if (!seen || (!seen.name && p.name)) people.set(p.email, p);
  }

  const lines: string[] = [];
  const timed: Array<{ side: GranolaSegment["side"]; start: number | null; end: number | null }> = [];
  let first: number | null = null;
  let last: number | null = null;
  const ownerLabel = owner?.name ?? "Me";
  for (const raw of arr(r.transcript)) {
    const s = rec(raw);
    // One line per segment, so every transcript line carries its speaker (lib/calls/whoIs.ts reads lines by speaker).
    const text = str(s.text)?.replace(/\s+/g, " ");
    if (!text) continue;
    const speaker = rec(s.speaker);
    // microphone is the note owner's side of the call; speaker is everyone else.
    const rep = speaker.source === "microphone";
    lines.push(`${speakerLabel(rep ? ownerLabel : str(speaker.name) ?? "Them")}: ${text}`);
    const start = ms(s.start_time);
    const end = ms(s.end_time);
    timed.push({ side: rep ? "rep" : "customer", start, end });
    if (start !== null && (first === null || start < first)) first = start;
    if (end !== null && (last === null || end > last)) last = end;
  }
  const offset = (t: number | null) => (t === null || first === null ? null : Math.round(t - first) / 1000);

  const scheduledStart = ms(calendar.scheduled_start_time);
  const scheduledEnd = ms(calendar.scheduled_end_time);
  const startAt = first ?? scheduledStart ?? ms(r.created_at) ?? ms(updatedAt)!;
  const endAt = last ?? scheduledEnd;
  return {
    noteId,
    title: str(r.title) ?? str(calendar.event_title) ?? "Meeting",
    startAt,
    endAt,
    durationSeconds: endAt !== null && endAt > startAt ? Math.round((endAt - startAt) / 1000) : null,
    owner,
    attendees: [...people.values()],
    summary: str(r.summary_markdown) ?? str(r.summary_text),
    webUrl: str(r.web_url),
    transcriptText: lines.join("\n"),
    segments: timed.map((t) => ({ side: t.side, startSeconds: offset(t.start), endSeconds: offset(t.end) })),
    updatedAt,
  };
}

export type GranolaNoteRef = { id: string; updatedAt: string };
export type GranolaFolder = { id: string; name: string; parentId: string | null };
/** Folder-list pages read (600 folders). */
const FOLDER_PAGES_MAX = 20;
/** Folders a workspace may import from. */
export const GRANOLA_FOLDERS_MAX = 20;
export type GranolaClient = ReturnType<typeof createGranolaClient>;

export function createGranolaClient(opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? GRANOLA_BASE_URL).replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" };
  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetchImpl(`${base}${path}`, { method: "GET", headers });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      return { status: response.status, body: null };
    }
    return { status: response.status, body: await response.json() };
  }
  return {
    /**
     * The notes changed after `updatedAfter`, oldest change first, at most `limit`. Reading oldest
     * first lets a poll that stops early resume from the last note it finished.
     */
    async changedNotes(updatedAfter: string, limit = GRANOLA_NOTES_PER_POLL, folderIds: readonly string[] = []): Promise<GranolaNoteRef[]> {
      // Only these folders (and their subfolders, as Granola lists them), or every note the key reads.
      const byId = new Map<string, GranolaNoteRef>();
      let pages = 0;
      for (const folderId of folderIds.length ? folderIds : [null]) {
        let cursor: string | null = null;
        for (;;) {
          if (pages++ === LIST_PAGES_MAX) throw new GranolaWindowTooLargeError();
          const q = new URLSearchParams({ updated_after: updatedAfter, page_size: String(GRANOLA_PAGE) });
          if (folderId) q.set("folder_id", folderId);
          if (cursor) q.set("cursor", cursor);
          const r = await get(`/v1/notes?${q}`);
          if (r.status !== 200) throw new GranolaError(r.status);
          const body = rec(r.body);
          for (const n of arr(body.notes)) {
            const note = rec(n);
            const id = str(note.id);
            const updatedAt = str(note.updated_at);
            if (id && updatedAt && !str(note.deleted_at)) byId.set(id, { id, updatedAt });
          }
          cursor = body.hasMore === true ? str(body.cursor) : null;
          if (!cursor) break;
        }
      }
      return [...byId.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).slice(0, limit);
    },
    /** The folders the key can read, by name, for choosing which ones to import. */
    async folders(): Promise<GranolaFolder[]> {
      const out: GranolaFolder[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < FOLDER_PAGES_MAX; page++) {
        const q = new URLSearchParams({ page_size: String(GRANOLA_PAGE) });
        if (cursor) q.set("cursor", cursor);
        const r = await get(`/v1/folders?${q}`);
        if (r.status !== 200) throw new GranolaError(r.status);
        const body = rec(r.body);
        for (const f of arr(body.folders)) {
          const folder = rec(f);
          const id = str(folder.id);
          const name = str(folder.name);
          if (id && name) out.push({ id, name, parentId: str(folder.parent_folder_id) });
        }
        cursor = body.hasMore === true ? str(body.cursor) : null;
        if (!cursor) break;
      }
      return out;
    },
    /** One note with its transcript, or without it when Granola says it is too large to send inline. Null when it is gone. */
    async meeting(noteId: string): Promise<GranolaMeeting | null> {
      const path = `/v1/notes/${encodeURIComponent(noteId)}`;
      let r = await get(`${path}?include=transcript`);
      if (r.status === 413) r = await get(path);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new GranolaError(r.status);
      return meetingOf(r.body);
    },
  };
}

/** The part of an email after the @, lowercased. */
export const domainOfEmail = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Who a meeting was with, outside the workspace: attendees whose email domain
 * is none of the workspace's own (its members' and the note owner's), and the
 * company domains among them (free-mail domains name no company).
 */
export function externalParticipants(meeting: Pick<GranolaMeeting, "attendees" | "owner">, workspaceEmails: readonly string[]) {
  const internal = new Set(
    [...workspaceEmails, ...(meeting.owner ? [meeting.owner.email] : [])]
      .map((e) => domainOfEmail(e))
      .filter((d) => !FREE_EMAIL_DOMAINS.has(d)),
  );
  const people = meeting.attendees.filter((p) => !internal.has(domainOfEmail(p.email)));
  const domains = [...new Set(people.map((p) => domainOfEmail(p.email)).filter((d) => !FREE_EMAIL_DOMAINS.has(d)))];
  return { people, domains };
}

export type CandidateDeal = { streamId: string; dealId: string; isClosed: boolean; updatedAt: number; matchedContacts: number; companyMatch: boolean };

/**
 * The deal a meeting was about: an open deal, the one with most of the
 * meeting's people on it, then one on the meeting's company, then the most
 * recently touched. No open deal, no deal: a closed deal is not reopened by a
 * meeting, and guessing between unrelated deals is worse than logging the
 * meeting on its people and company alone.
 */
export function pickDeal(candidates: readonly CandidateDeal[]): CandidateDeal | null {
  const open = candidates.filter((d) => !d.isClosed && (d.matchedContacts > 0 || d.companyMatch));
  open.sort((a, b) => b.matchedContacts - a.matchedContacts || Number(b.companyMatch) - Number(a.companyMatch) || b.updatedAt - a.updatedAt);
  return open[0] ?? null;
}

/** What the meeting activity's notes say: Granola's summary and a link back to the note. */
export function meetingNotes(meeting: Pick<GranolaMeeting, "summary" | "webUrl">): string {
  return [meeting.summary, meeting.webUrl ? `Granola note: ${meeting.webUrl}` : null].filter(Boolean).join("\n\n").slice(0, 20_000);
}
