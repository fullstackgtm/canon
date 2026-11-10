import { z } from "zod";
import { CALL_SYNC_STAGES, type ProgressEmitter } from "../../../engine/src/progress.ts";

// Contract: https://dev.avoma.com/openapi.yml (Meetings, Transcriptions, Recording).
// Authorization is Bearer; the API allows 60 requests per minute, including pagination.
const meetingSchema = z.object({
  uuid: z.string().min(1),
  subject: z.string(),
  start_at: z.string().optional(),
  duration: z.number().nonnegative().nullable().optional(),
  attendees: z.array(z.object({
    uuid: z.string().optional(), email: z.string(), name: z.string().nullable().optional(),
  })).default([]),
  transcript_ready: z.boolean().optional(),
  recording_uuid: z.string().nullable().optional(),
});
const transcriptionSchema = z.object({
  uuid: z.string(),
  meeting_uuid: z.string(),
  speakers: z.array(z.object({
    id: z.number().int(), email: z.string(), name: z.string().nullable().optional(), is_rep: z.boolean(),
  })),
  transcript: z.array(z.object({
    speaker_id: z.number().int(), transcript: z.string(), timestamps: z.array(z.number().nonnegative()).default([]),
  })),
});
const recordingSchema = z.object({
  meeting_uuid: z.string(),
  video_url: z.string().nullable().optional(),
  audio_url: z.string().nullable().optional(),
  valid_till: z.string().optional(),
});

export function normalizeAvomaCall(rawMeeting: unknown, rawTranscription: unknown, rawRecording?: unknown) {
  const meeting = meetingSchema.parse(rawMeeting);
  const transcription = transcriptionSchema.parse(rawTranscription);
  const recording = rawRecording ? recordingSchema.parse(rawRecording) : undefined;
  if (transcription.meeting_uuid !== meeting.uuid || (recording && recording.meeting_uuid !== meeting.uuid)) {
    throw new Error("Avoma meeting and transcript/recording IDs do not match");
  }
  const speakers = new Map(transcription.speakers.map((speaker) => [speaker.id, speaker]));
  const lines = transcription.transcript.filter((segment) => segment.transcript.trim()).map((segment) => {
    const speaker = speakers.get(segment.speaker_id);
    if (!speaker) throw new Error("Avoma transcription references an unknown speaker");
    // Keep one speaker-labelled line per segment so importProviderTranscript can retain its explicit side.
    const name = (speaker.name || speaker.email || `Speaker ${speaker.id}`).replace(/[:\[\]\r\n]/g, " ").trim().slice(0, 60);
    return {
      text: `${name}: ${segment.transcript.replace(/\s+/g, " ").trim()}`,
      timing: {
        side: speaker.is_rep ? "rep" as const : "customer" as const,
        startSeconds: segment.timestamps[0] ?? null,
        endSeconds: segment.timestamps.at(-1) ?? null,
      },
    };
  });
  const participants = new Map<string, Record<string, unknown>>();
  for (const attendee of meeting.attendees) participants.set(attendee.email.toLowerCase(), { ...attendee });
  for (const speaker of transcription.speakers) {
    const key = speaker.email.toLowerCase();
    participants.set(key, { ...participants.get(key), ...speaker, role: speaker.is_rep ? "rep" : "customer" });
  }
  return {
    externalCallId: `avoma:${meeting.uuid}`,
    title: meeting.subject || "Avoma call",
    callDate: meeting.start_at,
    durationSeconds: meeting.duration ?? undefined,
    recordingUrl: recording?.video_url || recording?.audio_url || undefined,
    participants: [...participants.values()],
    transcriptText: lines.map((line) => line.text).join("\n"),
    segments: lines.map((line) => line.timing),
    sourceMetadata: {
      provider: "avoma", meetingUuid: meeting.uuid, transcriptionUuid: transcription.uuid,
      ...(recording?.valid_till ? { recordingValidTill: recording.valid_till } : {}),
    },
  };
}

export async function fetchAvomaCalls(options: {
  apiKey: string;
  baseUrl: string;
  callsPath: string;
  progress: ProgressEmitter;
}) {
  const base = options.baseUrl.replace(/\/$/, "");
  const firstPage = new URL(`${base}${options.callsPath}`);
  const to = new Date();
  // Re-read this window so a meeting that was still processing on the last sync can be imported later.
  firstPage.searchParams.set("from_date", new Date(to.getTime() - 30 * 86_400_000).toISOString());
  firstPage.searchParams.set("to_date", to.toISOString());
  firstPage.searchParams.set("page_size", "100");
  const meetings: z.infer<typeof meetingSchema>[] = [];
  let next: URL | null = firstPage;
  let lastRequestAt = 0;
  const visited = new Set<string>();
  const request = async (url: URL) => {
    if (url.protocol !== "https:" || url.origin !== firstPage.origin || url.username || url.password) {
      throw new Error("Avoma API returned an invalid URL");
    }
    const delay = Math.max(0, 1_100 - (Date.now() - lastRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Avoma API error ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  while (next) {
    if (visited.has(next.href) || next.pathname !== firstPage.pathname) throw new Error("Avoma API returned an invalid next page");
    visited.add(next.href);
    const page = z.object({ results: z.array(meetingSchema), next: z.string().nullable().optional() }).parse(await request(next));
    meetings.push(...page.results);
    options.progress.items(meetings.length);
    next = page.next ? new URL(page.next, firstPage) : null;
  }
  options.progress.stage(CALL_SYNC_STAGES[1], 1, CALL_SYNC_STAGES.length);
  const calls = [];
  for (const [index, meeting] of meetings.entries()) {
    if (meeting.transcript_ready) {
      const url = new URL(`${base}/transcriptions/`);
      url.searchParams.set("meeting_uuid", meeting.uuid);
      // The list endpoint returns an array when queried by meeting_uuid.
      const transcriptions = z.array(transcriptionSchema).parse(await request(url));
      const transcription = transcriptions.find((item) => item.meeting_uuid === meeting.uuid);
      if (!transcription) throw new Error("Avoma ready meeting did not include its transcription");
      const recording = meeting.recording_uuid
        ? await request(new URL(`${base}/recordings/${encodeURIComponent(meeting.recording_uuid)}/`))
        : undefined;
      calls.push(normalizeAvomaCall(meeting, transcription, recording));
    }
    options.progress.items(index + 1, meetings.length);
  }
  return calls;
}
