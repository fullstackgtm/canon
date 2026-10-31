/**
 * What the kernel's runs send the model, and when they run, read from the workspace's recipe (docs/recipes.md): the
 * input and tool schema a draft is written with, a first touch's channel, a research run's limits and tool schemas,
 * and when the keeper researches again. The recipe chooses each value; the kernel keeps the answers' shapes, which it
 * stores, and its ceilings (CEILINGS in recipes/kernel.ts). The keeper (dealPlayKeeper.ts) and the research run
 * (dealPlayActions.ts) call these, and scripts/recipe-check.ts holds them to a frozen fixture. Pure.
 */
import { CEILINGS, type PlaysData, type Settings } from "../../../recipes/kernel.ts";
import { KERNEL_CONSTANTS, render } from "../../../recipes/template.ts";
import type { ControlPlane, PlayStep } from "../../dealPlays.ts";
import { ROLE_LABEL } from "../committee.ts";
import { DEAL_ROLES } from "../objects/registry.ts";
import type { DraftInput } from "./drafts.ts";
import { CONFIDENCE, ITEM_KINDS, PLAY_CHANNELS, type Channel, type Prospect } from "./model.ts";

const DAY = 86_400_000;

/** A recipe's value at a capped place, never past the kernel's ceiling. */
const capped = (path: keyof typeof CEILINGS, value: number) => Math.min(value, CEILINGS[path]);

/** A description from a prompt's ```output block, rendered on the settings in force. */
const described = (text: string, settings: Settings) => render({ text: [text] }, "text", { settings, kernel: KERNEL_CONSTANTS });

// ─────────────────────────────── Drafts ───────────────────────────────

/** What the model gets to write one step's draft: the step, the person, the brief, verified facts and recent touches. */
export function draftInputOf(plane: Pick<ControlPlane, "deal" | "brief" | "people" | "pointOfView" | "prep" | "items" | "touches">, step: Pick<PlayStep, "channel" | "title" | "targetId">, sender: string, now: number, plays: PlaysData): DraftInput {
  const person = plane.people.find((p) => p.contactId === step.targetId)!;
  const pov = plane.pointOfView?.text ? { icp: plane.pointOfView.icpName, text: plane.pointOfView.text } : null;
  return {
    channel: step.channel, stepTitle: step.title, company: plane.deal.companyName ?? "the account",
    context: plane.brief.context, whyNow: plane.brief.whyNow, alphaPitch: plane.brief.alphaPitch,
    person: { name: person.name, title: person.title, role: ROLE_LABEL[person.role], persona: person.persona, angle: person.angle },
    pointOfView: pov,
    offer: plane.pointOfView?.offer ?? null,
    openQuestions: plane.prep.answers.filter((a) => a.asked && a.answer === null).map((a) => a.question),
    facts: plane.items.filter((i) => i.evidence === "verified" && (i.kind === "timeline" || i.kind === "signal" || i.kind === "competitor")).slice(0, capped("drafts.facts", plays.drafts.facts))
      .map((i) => ({ text: i.text, quote: i.quote })),
    history: plane.touches.filter((t) => t.contactId === person.contactId).slice(0, capped("drafts.touches", plays.drafts.touches))
      .map((t) => ({ summary: t.summary, direction: t.direction, daysAgo: Math.floor((now - t.at) / DAY) })),
    sender,
  };
}

type Reachable = { email: string | null; linkedinUrl: string | null };
const REACHES: Partial<Record<Channel, (p: Reachable) => boolean>> = { email: (p) => Boolean(p.email), linkedin: (p) => Boolean(p.linkedinUrl) };

/** The channel a first touch goes on: the first of the recipe's that Canon can reach the person on, else its first. Null when it names none. */
export function firstTouchChannel(person: Reachable, plays: PlaysData): Channel | null {
  const channels = plays.drafts.firstTouch;
  return channels.find((c) => REACHES[c]?.(person)) ?? channels[0] ?? null;
}

export const DRAFT_TOOL = "write_touch";
export function draftSchema(plays: PlaysData, settings: Settings) {
  return {
    type: "object",
    properties: {
      subject: { type: "string", description: described(plays.drafts.output.subject, settings) },
      body: { type: "string" },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  };
}

export const REVIEW_TOOL = "review_touch";
/** The review's answers as the kernel stores them (DraftReview), each asking what the recipe's review describes. */
export function reviewSchema(plays: PlaysData, settings: Settings) {
  const q = plays.drafts.review;
  const yes = (text: string) => ({ type: "boolean", description: described(text, settings) });
  return {
    type: "object",
    properties: {
      relevant: yes(q.relevant), pointOfView: yes(q.pointOfView), surprising: yes(q.surprising), wouldReply: yes(q.wouldReply),
      termConcessions: { type: "array", items: { type: "string" }, description: "Keys of workspace terms the draft concedes. Empty if none." },
      note: { type: "string", description: described(q.note, settings) },
    },
    required: ["relevant", "pointOfView", "surprising", "wouldReply", "termConcessions", "note"],
    additionalProperties: false,
  };
}

// ─────────────────────────────── Research ───────────────────────────────

/** Searches one run makes, results read per search, and the most pages it keeps, the home page included. */
export function researchLimits(plays: PlaysData) {
  const r = plays.research;
  return { searches: capped("research.searches", r.searches), readsPerSearch: capped("research.readsPerSearch", r.readsPerSearch), pages: capped("research.pages", r.pages) };
}

/** Research still running after this is taken as stalled: another run may start. */
export const RESEARCH_STALL_MS = 10 * 60_000;
/** A failed run is tried again after this. */
const RETRY_FAILED_MS = DAY;

type Run = { status: string; startedAt: number; finishedAt?: number | null };

/** When research that finished at `last` is due again: the recipe's cadence, sooner when the prep asks something it didn't. */
export const researchAgain = (last: number, newQuestions: boolean, plays: PlaysData) =>
  last + (newQuestions ? Math.min(plays.research.newQuestionsAfterDays, plays.research.everyDays) : plays.research.everyDays) * DAY;

/**
 * Whether the keeper's daily check researches the account: it never ran, a run failed a day ago or stalled, or it is
 * as old as the recipe's cadence, which is shorter when the prep asks something it didn't (`newQuestions`).
 */
export function researchDue(r: Run | null | undefined, newQuestions: boolean, now: number, plays: PlaysData): boolean {
  if (r?.status === "running" && now - r.startedAt < RESEARCH_STALL_MS) return false;
  const last = r?.status === "done" ? r.finishedAt ?? r.startedAt : null;
  return last === null ? r?.status !== "failed" || now - r.startedAt > RETRY_FAILED_MS : now > researchAgain(last, newQuestions, plays);
}

/** The people the keeper's people research covers: the recipe's first few ICP buyers in the fan-out's order. */
export function scheduledBuyers(prospects: readonly Prospect[], plays: PlaysData): string[] {
  return prospects.filter((p) => p.contactId && p.buyer).slice(0, capped("people.buyers", plays.people.buyers)).map((p) => p.contactId!);
}

export const PLAN_TOOL = "plan_searches";
export function planSchema(plays: PlaysData) {
  return {
    type: "object",
    properties: { queries: { type: "array", items: { type: "string" }, maxItems: researchLimits(plays).searches } },
    required: ["queries"],
    additionalProperties: false,
  };
}

export const BRIEF_TOOL = "write_account_plan";
/** The account plan as the kernel screens and stores it; the recipe's ```output says what the brief and notes hold. */
export function briefSchema(plays: PlaysData, settings: Settings, questions = 0) {
  const o = plays.research.output;
  const text = (key: keyof typeof o) => ({ type: "string", description: described(o[key], settings) });
  return {
    type: "object",
    properties: {
      whyNow: text("whyNow"), alphaHypothesis: text("alphaHypothesis"), alphaPitch: text("alphaPitch"),
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...ITEM_KINDS] },
            text: text("item"),
            quote: { type: "string", description: "For timeline, signal and competitor: words copied exactly from one page above. Otherwise empty." },
            sourceUrl: { type: "string", description: "The URL of the page the quote is from, or empty." },
            occurredOn: { type: "string", description: "YYYY-MM-DD when the page dates the event, else empty." },
          },
          required: ["kind", "text", "quote", "sourceUrl", "occurredOn"],
          additionalProperties: false,
        },
      },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            suggestedRole: { type: "string", enum: [...DEAL_ROLES, ""] },
            persona: text("persona"),
            angle: text("angle"),
            confidence: { type: "string", enum: [...CONFIDENCE] },
            quote: { type: "string", description: "Words copied exactly from a page above that name this person, or empty when already mapped." },
            sourceUrl: { type: "string" },
          },
          required: ["name", "title", "suggestedRole", "persona", "angle", "confidence", "quote", "sourceUrl"],
          additionalProperties: false,
        },
      },
      steps: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            channel: { type: "string", enum: [...PLAY_CHANNELS] },
            personName: { type: "string", description: "The person the step is for, or empty." },
            role: { type: "string", enum: [...DEAL_ROLES, ""] },
            dueInDays: { type: "number" },
          },
          required: ["title", "channel", "personName", "role", "dueInDays"],
          additionalProperties: false,
        },
      },
      answers: {
        type: "array",
        maxItems: Math.max(questions, 0),
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, copied exactly." },
            answer: { type: "string", description: "One or two sentences, only what a page below says. Empty when no page answers it." },
            quote: { type: "string", description: "Words copied exactly from that page, or empty." },
            sourceUrl: { type: "string" },
          },
          required: ["question", "answer", "quote", "sourceUrl"],
          additionalProperties: false,
        },
      },
    },
    required: ["whyNow", "alphaHypothesis", "alphaPitch", "items", "people", "steps", "answers"],
    additionalProperties: false,
  };
}
