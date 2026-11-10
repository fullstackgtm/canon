import type { ConnectorDecl } from "./registry.ts";

export const LINKEDIN_SENDERS = "linkedin.senders";
export const LINKEDIN_TOUCHES = "linkedin.touches";

export const linkedin = {
  id: "linkedin",
  label: "LinkedIn",
  scope: "member",
  auth: "canon",
  env: ["UNIPILE_API_KEY", "UNIPILE_DSN"],
  feeds: {
    [LINKEDIN_SENDERS]: {
      label: "LinkedIn senders",
      fields: {
        profileName: { type: "string", label: "Profile name" },
        status: { type: "string", label: "Status" },
        statusReason: { type: "string", label: "Status reason" },
        tier: { type: "string", label: "Account tier" },
        timezone: { type: "string", label: "Timezone" },
        window: { type: "object", label: "Sending window" },
        limits: { type: "object", label: "Effective caps" },
        usage: { type: "object", label: "Today's and this week's usage" },
        pendingInvites: { type: "number", label: "Pending invites" },
        acceptance: { type: "object", label: "Seven-day acceptance" },
        health: { type: "object", label: "Health throttle" },
        hold: { type: "object", label: "Sending hold" },
        inviteHold: { type: "object", label: "Invite hold" },
        rampStep: { type: "number", label: "Warm-up step" },
        connectedAt: { type: "time", label: "Account connected at" },
      },
      maxItemBytes: 8_192,
    },
    [LINKEDIN_TOUCHES]: {
      label: "LinkedIn legacy cadence enrollments",
      fields: {
        source: { type: "string", label: "Source" },
        contact: { type: "object", label: "Contact" },
        sender: { type: "string", label: "Sender account" },
        requester: { type: "object", label: "Legacy cadence" },
        state: { type: "string", label: "Enrollment state" },
        stepIndex: { type: "number", label: "Enrollment step" },
        nextAt: { type: "time", label: "Next action at" },
        reason: { type: "string", label: "Queue or stop reason" },
        enrolledAt: { type: "time", label: "Enrolled at" },
        invitedAt: { type: "time", label: "Invited at" },
        connectedAt: { type: "time", label: "Connection observed at" },
        acceptedAt: { type: "time", label: "LinkedIn acceptance time" },
        lastSentAt: { type: "time", label: "Last message sent at" },
        repliedAt: { type: "time", label: "Reply time, unavailable for legacy enrollments" },
      },
      maxItemBytes: 8_192,
    },
  },
} as const satisfies ConnectorDecl;
