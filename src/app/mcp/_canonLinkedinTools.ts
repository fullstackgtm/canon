/**
 * Canon tools for LinkedIn cadences (docs/linkedin-cadences.md): read a
 * cadence's funnel and its results by segment, as the LinkedIn page shows
 * them. Same Convex functions, run as the caller. Sending, enrolling and
 * editing stay in the app.
 */
import { api } from "../../../convex/_generated/api.js";
import type { CanonTool } from "./_canonTools.ts";
import { a, groupTool, q } from "./_canonJobTools.ts";

export const canonLinkedinTools: CanonTool[] = [
  groupTool(
    "canon_linkedin_cadences",
    "LinkedIn cadences: an invite then up to five messages, sent from one connected LinkedIn account. Read each cadence's funnel, and its acceptance and response rates split by a trait of its people. Response rate is replies out of everyone connected. People's names show only to the cadence's sender and to roles that see every record.",
    {
      list: q(api.linkedinCadences.list, "{} -> [{ _id, name, status, steps, sender, funnel: { enrolled, invited, pending, accepted, alreadyConnected, messaged, replied } | null, funnelTruncated }]"),
      get: q(api.linkedinCadences.get, "{ cadenceId } -> { name, status, steps, activeWithinDays, counts, funnel, queue, enrollments } | null"),
      segments: a(api.linkedinCadences.segments, "{ cadenceId, by: \"title\" | \"company\" | \"seniority\" | \"tenure\" (time in current role) | \"activity\" (recent LinkedIn posts or comments) } -> { rows: [{ segment, people, invited, accepted, connected, replied, acceptRate, responseRate }], truncated } | null (null: the caller may not see who is in it)"),
    },
  ),
];
