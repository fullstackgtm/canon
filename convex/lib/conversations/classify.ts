/**
 * Whether a meeting or a conversation is a sales conversation, before it suggests adding anything. Vendors
 * pitching us, current customers, newsletters, cold outreach to us and automated mail are not new deals, and
 * mostly not new people either. Two layers: a deterministic check for bulk and one-sided mail, then Jev
 * (TypeSafe System One) classifying the rest. Without a Jev key only the deterministic check runs.
 *
 * Pure apart from the injected `ask`: no database access, no Node-only imports.
 */
import { jevSystemOne, type SystemOneQuestion } from "../segments/jev.ts";
import type { PlannedSuggestion } from "../calls/suggestions.ts";

export type ConversationClass = "sales" | "customer" | "vendor" | "marketing" | "other";

/** Below this Jev confidence a "sales" answer is not trusted to suggest a deal. */
export const SALES_MIN_CONFIDENCE = 0.6;

/** Sender mailboxes that are never a person writing to us. */
const BULK_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|newsletters?|marketing|mailer|mailer-daemon|bounces?|digest|alerts?|billing|receipts?|invoices?|webinars?)([+._-].*)?$/i;

/** Text that only bulk and automated mail carries. */
const BULK_TEXT = /\b(unsubscribe|manage (your )?(email )?preferences|view (this email )?in (your )?browser|you('| a)re receiving this|opt[- ]out)\b/i;

export type ClassifyInput = {
  channel: "call" | "email" | "linkedin";
  title: string;
  /** The counterpart's address for email, when there is one. */
  email?: string | null;
  summary?: string | null;
  /** The transcript or thread, newest last. */
  text: string;
  /** Messages each side sent (email and LinkedIn); calls leave these out. */
  fromUs?: number;
  fromThem?: number;
  /** The workspace has won a deal with the counterpart's company. */
  customer: boolean;
  /** The counterpart is on an open deal already. */
  openDeal: boolean;
  /** What the workspace sells, when its profile says (helps tell buyers from vendors). */
  weSell?: string | null;
};

/** Bulk or one-sided mail: marketing without asking anyone. Null when it needs reading. */
export function obviousClass(i: ClassifyInput): ConversationClass | null {
  if (i.channel === "call") return null;
  const local = i.email?.split("@")[0] ?? "";
  if (local && BULK_LOCAL.test(local)) return "marketing";
  if (BULK_TEXT.test(i.text)) return "marketing";
  // Nobody on our side ever answered: inbound pitches and promotions, not a conversation.
  if (i.fromUs === 0 && (i.fromThem ?? 0) > 0) return "marketing";
  return null;
}

const CLASSES: Record<ConversationClass, string> = {
  sales: "A real sales conversation: the counterpart is a prospective buyer of what WE sell (discovery, demo, evaluation, pricing, procurement, a renewal or expansion we are selling them).",
  customer: "An existing customer of ours talking about support, onboarding, account management or usage, with no new purchase being discussed.",
  vendor: "The counterpart is selling THEIR product or service to us, or is a supplier, agency, contractor or tool we pay.",
  marketing: "Newsletters, promotions, event invites, automated notifications, or unsolicited cold outreach that nobody on our side engaged with.",
  other: "Anything else: recruiting, hiring, investors, partners, friends, personal or internal matters.",
};

/** The Jev question; `state` is what it reads. */
export function classifyRequest(i: ClassifyInput): { state: unknown; questions: Record<string, SystemOneQuestion> } {
  return {
    state: {
      channel: i.channel, title: i.title, counterpartEmail: i.email ?? null, summary: i.summary ?? null,
      text: i.text.slice(-6000), messagesFromUs: i.fromUs ?? null, messagesFromThem: i.fromThem ?? null,
      counterpartIsCurrentCustomer: i.customer, counterpartHasOpenDeal: i.openDeal, whatWeSell: i.weSell ?? null,
    },
    questions: {
      kind: {
        type: "choice",
        instructions: "We are the workspace's sales team. Classify this conversation between us and the counterpart. A current customer only counts as `sales` when a new purchase, expansion or renewal is actively discussed.",
        criteria: CLASSES,
      },
    },
  };
}

export type Classification = { kind: ConversationClass; confidence: number; by: "rule" | "jev" | "none" };

/** Classify: the deterministic check first, then Jev when `ask` is given; with neither, a sales conversation is assumed. */
export async function classifyConversation(
  i: ClassifyInput,
  ask: ((state: unknown, questions: Record<string, SystemOneQuestion>) => Promise<{ choice: string; confidence: number } | null>) | null,
): Promise<Classification> {
  const rule = obviousClass(i);
  if (rule) return { kind: rule, confidence: 1, by: "rule" };
  if (!ask) return { kind: i.customer ? "customer" : "sales", confidence: 0, by: "none" };
  try {
    const { state, questions } = classifyRequest(i);
    const a = await ask(state, questions);
    if (a && a.choice in CLASSES) return { kind: a.choice as ConversationClass, confidence: a.confidence, by: "jev" };
  } catch {
    // Jev unavailable: fall through as unclassified.
  }
  return { kind: i.customer ? "customer" : "sales", confidence: 0, by: "none" };
}

/** `ask` over Jev's System One API. */
export const jevClassifier = (apiKey: string) => async (state: unknown, questions: Record<string, SystemOneQuestion>) => {
  const a = (await jevSystemOne(apiKey, state, questions)).answers.kind;
  return a?.type === "choice" ? { choice: a.choice, confidence: a.confidence } : null;
};

/**
 * What a class lets through. A sales conversation suggests everything (its deal only when Jev was confident or
 * did not run); a customer's suggests new people at the company, never a new deal; vendors, marketing and the
 * rest suggest nothing.
 */
export function gateSuggestions(c: Classification, planned: readonly PlannedSuggestion[]): PlannedSuggestion[] {
  if (c.kind === "sales") return c.by === "jev" && c.confidence < SALES_MIN_CONFIDENCE ? planned.filter((s) => s.kind !== "deal") : [...planned];
  if (c.kind === "customer") return planned.filter((s) => s.kind === "contact");
  return [];
}
