/**
 * Job changes (Ryan, 2026-10-14): whether a person still works at the company we have them at, from LeadMagic's job
 * change detector through treg (a LinkedIn URL and the company we expect; $0.075 a check). Pure. Example reply on
 * Riley Morgan, expected at Northstar: `job_change_detected: true`, now Director, Global Revenue Enablement at Example Systems.
 */

export type JobChange = {
  changed: boolean;
  /** Their current employer and role, when the detector names one. */
  company: string | null;
  title: string | null;
  seniority: string | null;
  /** "Feb 2026" as the detector writes it. */
  since: string | null;
  summary: string | null;
};

const text = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** The detector's verdict, or null when it couldn't tell (no work history, no current position). */
export function readJobChange(body: unknown): JobChange | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.job_change_detected !== "boolean") return null;
  const pos = (b.current_position && typeof b.current_position === "object" ? b.current_position : {}) as Record<string, unknown>;
  return {
    changed: b.job_change_detected,
    company: text(b.current_company) ?? text(pos.company),
    title: text(pos.title),
    seniority: text(pos.seniority),
    since: text(pos.start_date),
    summary: text(b.summary),
  };
}

/** One line for the old contact and the deal: "Left Northstar. Now Director, Global Revenue Enablement at Example Systems since Feb 2026." */
export function departureNote(left: string, jc: JobChange): string {
  const now = jc.company ? ` Now ${jc.title ? `${jc.title} at ` : "at "}${jc.company}${jc.since ? ` since ${jc.since}` : ""}.` : "";
  return `Left ${left}.${now}`;
}

/** One line for the contact at their new company: "Previously at Northstar. Here since Feb 2026." */
export function arrivalNote(left: string, jc: JobChange): string {
  return `Previously at ${left}.${jc.since ? ` Here since ${jc.since}.` : ""}`;
}

/** The evidence a "no longer works here" answer rests on: the detector's own summary and the profile it read. */
export function departureEvidence(jc: JobChange, profileUrl: string): string {
  return `"${jc.summary ?? "The job change detector found a current employer other than the one expected."}"\n\nSource: ${profileUrl} (LeadMagic job change check)`;
}
