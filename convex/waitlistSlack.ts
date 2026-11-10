/**
 * Posts each new /start waitlist signup to #project_canoncrm with the same
 * Slack bot the fsgtm agent uses (FSGTM_AGENT_SLACK_BOT_TOKEN). Without the
 * token (local stacks, CI) it does nothing; a Slack failure never affects the
 * signup, which is already saved in researchWaitlist.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { waitlistSlackText } from "./lib/waitlistSlackText";

const DEFAULT_CHANNEL = "C0C77TKV7RR"; // #project_canoncrm

export const notify = internalAction({
  args: { email: v.string(), domain: v.string(), role: v.optional(v.string()), teamSize: v.optional(v.string()) },
  handler: async (_ctx, lead) => {
    const token = process.env.FSGTM_AGENT_SLACK_BOT_TOKEN;
    if (!token) return null;
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: process.env.WAITLIST_SLACK_CHANNEL || DEFAULT_CHANNEL, text: waitlistSlackText(lead), unfurl_links: false }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!body.ok) console.error(`waitlist Slack post failed: ${body.error ?? response.status}`);
    return null;
  },
});
