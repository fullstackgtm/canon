import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAvomaCall } from "../convex/lib/calls/avoma.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("Avoma meeting and transcription normalize with participants, metadata and explicit speaker sides", async () => {
  const call = normalizeAvomaCall({
    uuid: "meeting-1", subject: "Vidmob discovery", start_at: "2026-10-26T14:00:00Z", duration: 1800.5,
    attendees: [
      { email: "riley@vidmob.example", name: "Riley", uuid: "attendee-1" },
      { email: "sam@buyer.example", name: "Sam" },
      { email: "pat@buyer.example", name: "Pat" },
    ],
  }, {
    uuid: "transcript-1", meeting_uuid: "meeting-1",
    speakers: [
      { id: 0, email: "riley@vidmob.example", name: "Riley", is_rep: true },
      { id: 1, email: "sam@buyer.example", name: "Sam", is_rep: false },
    ],
    transcript: [
      { speaker_id: 0, transcript: "What needs to change?", timestamps: [0.5, 1, 1.5, 2] },
      { speaker_id: 1, transcript: "We need better reporting.", timestamps: [3, 3.5, 4, 4.5] },
    ],
  }, { meeting_uuid: "meeting-1", video_url: "https://media.example/recording", valid_till: "2026-10-28T00:00:00Z" });
  assert.deepEqual(call, {
    externalCallId: "avoma:meeting-1", title: "Vidmob discovery", callDate: "2026-10-26T14:00:00Z",
    durationSeconds: 1800.5, recordingUrl: "https://media.example/recording",
    participants: [
      { email: "riley@vidmob.example", name: "Riley", uuid: "attendee-1", id: 0, is_rep: true, role: "rep" },
      { email: "sam@buyer.example", name: "Sam", id: 1, is_rep: false, role: "customer" },
      { email: "pat@buyer.example", name: "Pat" },
    ],
    transcriptText: "Riley: What needs to change?\nSam: We need better reporting.",
    segments: [
      { side: "rep", startSeconds: 0.5, endSeconds: 2 },
      { side: "customer", startSeconds: 3, endSeconds: 4.5 },
    ],
    sourceMetadata: { provider: "avoma", meetingUuid: "meeting-1", transcriptionUuid: "transcript-1", recordingValidTill: "2026-10-28T00:00:00Z" },
  });
  const intel = loadConvex(["callIntelligence.ts"])["callIntelligence.ts"]!;
  const db = memoryDb({});
  await intel.importProviderTranscript!.handler({ db }, { orgId: "org", provider: "avoma", ...call });
  assert.deepEqual(db.rows("callTranscriptSegments").map((segment) => [segment.speaker, segment.speakerRole, segment.startSeconds, segment.endSeconds]), [
    ["Riley", "rep", 0.5, 2], ["Sam", "customer", 3, 4.5],
  ]);
});
