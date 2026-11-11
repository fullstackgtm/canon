/**
 * Slack notifications for agent turns. An org connects one incoming-webhook
 * URL; an agent opts in and picks which turns are worth a message. Pure and
 * runtime-neutral: convex/agentSlack.ts, convex/agentTurns.ts and tests call it.
 *
 * The URL is a credential: nothing here returns it, puts it in an error, or
 * follows a redirect from it. Messages carry names and outcomes, never
 * payloads, answers or contact details.
 */

export type SlackMode = "all" | "qualified" | "failures";

export type SlackDelivery = { ok: boolean; httpStatus?: number; error?: string };

/** Why the URL cannot be a Slack incoming webhook, or null. Loopback is for local stacks only. */
export function webhookUrlProblem(raw: string, allowLoopback: boolean): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return "That is not a URL."; }
  if (allowLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return null;
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/") || url.username || url.password) {
    return "Use a Slack incoming webhook URL (https://hooks.slack.com/services/...).";
  }
  return null;
}

type TurnState = { status: string; routing?: { status: string }; hasRoute: boolean };

/** Whether a turn that reached a terminal state is worth a message in the agent's mode. */
export function shouldNotify(mode: SlackMode, t: TurnState): boolean {
  if (t.status !== "done" && t.status !== "skipped" && t.status !== "failed") return false;
  if (mode === "all") return true;
  if (mode === "failures") return t.status !== "done" || t.routing?.status === "error";
  // Qualified: the route added the contact or found it already there, or qualified with no contact to add;
  // with no route every finished turn qualifies.
  if (t.status !== "done") return false;
  return t.hasRoute ? ["added", "already_member", "no_contact"].includes(t.routing?.status ?? "") : true;
}

/** Text as Slack shows it literally: `<!channel>` or `<@U123>` in it never mentions anyone. */
export const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TRIGGERS: Record<string, string> = { webhook: "webhook", crm_event: "deal stage change", test: "test run" };

export type SlackTurn = {
  agentLabel: string;
  trigger: string;
  status: string;
  account?: { name: string; domain: string };
  subjectDomain?: string;
  skipMessage?: string;
  error?: string;
  outputs: ReadonlyArray<{ status: string }>;
  routing?: { status: string };
  audienceName?: string | null;
  /** Absolute link to the turn in Canon, when the app's origin is known. */
  link?: string | null;
};

/** The message for a finished turn: who, why, about what, how it ended, and where to look. */
export function slackMessage(t: SlackTurn): string {
  const answered = t.outputs.filter((o) => o.status === "answered" || o.status === "unchanged").length;
  const outcome = t.status === "done" ? `Finished, ${answered} of ${t.outputs.length} fields answered`
    : t.status === "skipped" ? `Skipped: ${short(t.skipMessage ?? "no reason recorded", 160)}`
    : `Failed: ${short(t.error ?? "no reason recorded", 160)}`;
  const lines = [
    `*${escapeSlack(short(t.agentLabel, 80))}*: turn ${t.status === "done" ? "finished" : t.status}`,
    `Trigger: ${TRIGGERS[t.trigger] ?? t.trigger}`,
    `Account: ${escapeSlack(t.account ? `${t.account.name} (${t.account.domain})` : t.subjectDomain ?? "not resolved")}`,
    `Outcome: ${escapeSlack(outcome)}`,
  ];
  if (t.routing && (t.routing.status === "added" || t.routing.status === "already_member") && t.audienceName) {
    lines.push(`Routed to audience: ${escapeSlack(t.audienceName)}`);
  } else if (t.routing?.status === "error") {
    lines.push("Routing hit an error.");
  }
  if (t.link) lines.push(`<${t.link}|Open the turn in Canon>`);
  return lines.join("\n");
}

/**
 * Post text to the webhook. Never throws and never returns the URL or a
 * transport error's own message (which can contain it): failures are a status or a fixed word.
 */
export async function postToSlack(url: string, text: string, fetchImpl: typeof fetch = fetch): Promise<SlackDelivery> {
  try {
    const res = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      redirect: "manual", signal: AbortSignal.timeout(8000),
    });
    // Slack's refusals are short codes ("no_service", "invalid_token"); keep a few characters of it.
    const detail = res.ok ? "" : (await res.text().catch(() => "")).trim().slice(0, 40).replace(/[^\w .-]/g, "");
    return res.ok ? { ok: true, httpStatus: res.status } : { ok: false, httpStatus: res.status, ...(detail ? { error: detail } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error" };
  }
}
