"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  CARD_LABELS,
  type CardId,
  type ResearchEvent,
} from "./research-reveal-state";

/** What each stage is doing while it loads. The activity line is the only place narration appears. */
const NARRATION: Record<CardId, string[]> = {
  offer: [
    "Reading your public website.",
    "Looking for what you sell and who you sell to.",
    "Checking each description against a quote from your site.",
  ],
  market: [
    "Looking for companies that match your buyers.",
    "Counting the market and sampling accounts.",
    "Scoring sampled accounts against your buyer profile.",
  ],
  buyers: [
    "Reading the buyer profile.",
    "Grouping company filters and buyer roles.",
    "Sorting buyers into segments.",
  ],
  team: [
    "Looking for CRM and form code on your homepage.",
    "Reading your pricing page.",
    "Counting open sales roles on your job board.",
  ],
  plan: [
    "Reviewing the claims on your website.",
    "Looking for alternatives named in your sources.",
    "Checking each quote against its source.",
  ],
};

export function narration(id: CardId, elapsed: number) {
  const lines = NARRATION[id];
  return lines[Math.min(lines.length - 1, Math.floor(elapsed / 1800))];
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function ActivityLine({
  text,
  events,
  working,
}: {
  text: string;
  events: ResearchEvent[];
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <div className="research-activity" ref={root}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
      >
        {working && (
          <Loader2 size={14} aria-hidden className="motion-safe:animate-spin" />
        )}
        <span role="status">{text}</span>
      </button>
      {open && (
        <div id={panel} className="research-activity-log">
          <p className="research-activity-title">Research activity</p>
          <ol>
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <time>{time(event.at)}</time>
                <span>{event.text}</span>
              </li>
            ))}
            {!events.length && <li>Waiting for the first finding.</li>}
          </ol>
          <p className="research-unknown">
            No people or email addresses are researched before you open an
            invited workspace.
          </p>
        </div>
      )}
    </div>
  );
}

export function StepFeedback({
  id,
  value,
  onVote,
}: {
  id: CardId;
  value?: "up" | "down";
  onVote: (vote: "up" | "down") => void;
}) {
  return (
    <div
      className="research-feedback"
      role="group"
      aria-label={`Is ${CARD_LABELS[id].toLowerCase()} right?`}
    >
      {(["up", "down"] as const).map((vote) => (
        <button
          key={vote}
          type="button"
          aria-label={vote === "up" ? "This looks right" : "This looks wrong"}
          aria-pressed={value === vote}
          onClick={() => onVote(vote)}
        >
          {vote === "up" ? (
            <ThumbsUp aria-hidden size={15} />
          ) : (
            <ThumbsDown aria-hidden size={15} />
          )}
        </button>
      ))}
    </div>
  );
}
