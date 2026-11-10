"use client";

import "../research-reveal.css";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import {
  CARD_LABELS,
  useResearchReveal,
  type CardId,
} from "../research-reveal";
import { availableDraft } from "../research-scene-model";
import { OutreachConnector, ResearchScene } from "../research-scene";
import { SCREENS, screenAt, type ScreenId } from "../research-reveal-state";
import { ActivityLine, StepFeedback, narration } from "../research-engagement";
import {
  BrandImage,
  CompanyStage,
  MarketStage,
  BuyersStage,
  TeamStage,
  PositioningStage,
  PendingStage,
  FinalStage,
  Recap,
} from "../research-content";

const LABELS: Record<ScreenId, string> = {
  ...CARD_LABELS,
  waitlist: "Your next step",
};
const DESCRIPTIONS: Record<ScreenId, string> = {
  offer: "What your website says you sell, in your own words.",
  market: "Companies that match your buyers, and a sample sorted into segments.",
  buyers: "The companies and roles your website points to.",
  team: "What your website, pricing page and job posts show about how you sell.",
  plan: "A point of view on positioning, with the quotes behind it.",
  waitlist:
    "Canon opens by invitation. Join the waitlist and we’ll open your workspace with this research.",
};

/** Small screens and short desktop windows show fewer items per stage instead of scrolling. */
function useCompact() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px), (max-height: 820px)");
    const change = () => setCompact(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return compact;
}

export default function StartProgressPage() {
  const { token } = useParams<{ token: string }>();
  return <SessionProgress key={token} token={token} />;
}
function SessionProgress({ token }: { token: string }) {
  const session = useQuery(api.researchSessions.get, { token });
  const vote = useMutation(api.researchSessions.recordFeedback);
  const completions: CardId[] = [
    ...(session?.companyFinding || session?.icp ? ["offer" as const] : []),
    ...(session?.tamTotal !== null && session?.tamTotal !== undefined
      ? ["market" as const]
      : []),
    ...(session?.icp ? ["buyers" as const] : []),
    ...(session?.teamShape ||
    session?.events.some((event) => event.kind === "team")
      ? ["team" as const]
      : []),
    ...(session?.briefStatus === "ready" ||
    session?.briefStatus === "unavailable"
      ? ["plan" as const]
      : []),
  ];
  const failed = session?.status === "failed";
  const flow = useResearchReveal(
    completions,
    Boolean(session),
    failed,
    session?.events ?? [],
  );
  const compact = useCompact();
  const screen = flow.screen;
  const [requestedDraft, setDraftIndex] = useState(0);
  const draftIndex = availableDraft(
    requestedDraft,
    session?.brief?.drafts.length ?? 0,
  );
  useEffect(() => {
    const index = Number(
      new URLSearchParams(window.location.search).get("draft"),
    );
    if (!Number.isInteger(index) || index < 0 || index > 2) return;
    const frame = requestAnimationFrame(() => setDraftIndex(index));
    return () => cancelAnimationFrame(frame);
  }, []);
  function selectDraft(index: number) {
    setDraftIndex(index);
    const url = new URL(window.location.href);
    url.searchParams.set("draft", String(index));
    window.history.replaceState(window.history.state, "", url);
  }
  const selected = SCREENS.indexOf(screen);
  const frontier = SCREENS.indexOf(screenAt(flow.frontier));
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [voteError, setVoteError] = useState("");
  const company = session?.companyFinding;
  const accent =
    company?.brand?.color &&
    /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(company.brand.color)
      ? company.brand.color
      : "var(--primary)";
  const shown = screen === "waitlist" || flow.revealed.includes(screen);
  const timedOut =
    screen !== "waitlist" &&
    !shown &&
    (flow.browsing || flow.phase?.kind === "reveal");
  const activity = failed
    ? "Research stopped. Earlier findings stay here."
    : !shown && !timedOut
      ? narration(screen, flow.elapsed)
      : (flow.events.at(-1)?.text ?? "Starting research.");

  if (session === null)
    return (
      <main className="mx-auto max-w-xl px-6 py-24">
        <h1 className="font-display text-3xl">Research session not found</h1>
        <p className="mt-4 text-[15px] text-muted-foreground">
          Unclaimed research expires after seven days unless you save it to the
          waitlist.
        </p>
        <Link href="/" className="mt-6 inline-block underline">
          Start again
        </Link>
      </main>
    );
  return (
    <LayoutGroup id={`research-${token}`}>
      <main
        className="research-page"
        style={{ "--company-accent": accent } as CSSProperties}
      >
        <header className="research-topbar">
          <Link href="/" className="research-wordmark">
            Canon<span>.</span>
          </Link>
          <div className="research-context">
            {screen !== "offer" && company && (
              <BrandImage
                name={company.name}
                src={company.brand?.logoUrl}
                domain={session?.domain}
                shared
                reduced={flow.reduced}
              />
            )}
            <span>{company?.name ?? session?.domain ?? "Company research"}</span>
            {screen !== "market" &&
              flow.revealed.includes("market") &&
              session?.tamTotal !== null &&
              session?.tamTotal !== undefined && (
                <motion.span
                  layoutId={flow.reduced ? undefined : "tam-number"}
                  className="research-context-count"
                >
                  {session.tamTotal.toLocaleString()}
                  {session.tamSaturated ? "+" : ""} companies
                </motion.span>
              )}
          </div>
        </header>
        <div className="research-app">
          <nav className="research-rail" aria-label="Research stages">
            <ol>
              {SCREENS.map((id, index) => (
                <li
                  key={id}
                  data-state={
                    index < frontier ? "done" : index === frontier ? "now" : "next"
                  }
                >
                  <button
                    type="button"
                    disabled={index > frontier}
                    aria-label={`${index + 1}. ${LABELS[id]}`}
                    aria-current={screen === id ? "step" : undefined}
                    onClick={() => flow.navigate(id)}
                  >
                    <span className="research-step-mark" aria-hidden>
                      {index < frontier ? <Check size={13} /> : index + 1}
                    </span>
                    <span className="research-step-label">{LABELS[id]}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="research-workspace">
            <header className="research-stage-heading">
              <h1 id="stage-title" tabIndex={-1}>
                {LABELS[screen]}
              </h1>
              <p>{DESCRIPTIONS[screen]}</p>
            </header>
            <div
              className="research-stage-layout"
              onTouchStart={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.closest("input,textarea,select,button,a,summary")
                ) {
                  touch.current = null;
                  return;
                }
                touch.current = {
                  x: event.touches[0].clientX,
                  y: event.touches[0].clientY,
                };
              }}
              onTouchEnd={(event) => {
                if (!touch.current) return;
                const dx = event.changedTouches[0].clientX - touch.current.x;
                const dy = event.changedTouches[0].clientY - touch.current.y;
                if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
                  flow.move(dx > 0 ? "ArrowLeft" : "ArrowRight");
                touch.current = null;
              }}
            >
              <ResearchScene
                session={session ?? undefined}
                screen={
                  !shown && screen === "buyers"
                    ? "market"
                    : !shown && screen === "team"
                      ? "buyers"
                      : !shown && screen === "plan"
                        ? "team"
                        : screen
                }
                reduced={flow.reduced}
                draftIndex={draftIndex}
                compact={compact}
              />
              <div className="research-stage-panel">
                {failed && (
                  <div role="alert" className="research-error">
                    <p>{session?.error ?? "Research stopped before it finished."}</p>
                    <Link href="/">Try another website</Link>
                  </div>
                )}
                <AnimatePresence initial={false} mode="wait">
                  <motion.section
                    key={screen}
                    className="research-stage"
                    aria-label={LABELS[screen]}
                    aria-busy={!shown && !failed}
                    initial={{ opacity: 0, x: flow.reduced ? 0 : 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: flow.reduced ? 0 : -10 }}
                    transition={{
                      duration: flow.reduced ? 0.15 : 0.28,
                      ease: "easeOut",
                    }}
                  >
                    {!shown && (
                      <PendingStage screen={screen} waiting={timedOut} />
                    )}
                    {shown && session && (
                      <>
                        {screen === "offer" && (
                          <CompanyStage session={session} reduced={flow.reduced} compact={compact} />
                        )}
                        {screen === "market" && (
                          <MarketStage session={session} reduced={flow.reduced} compact={compact} />
                        )}
                        {screen === "buyers" && (
                          <BuyersStage session={session} compact={compact} />
                        )}
                        {screen === "team" && (
                          <TeamStage session={session} compact={compact} />
                        )}
                        {screen === "plan" && (
                          <PositioningStage session={session} compact={compact} />
                        )}
                        {screen === "waitlist" && (
                          <>
                            <FinalStage
                              session={session}
                              reduced={flow.reduced}
                              selected={draftIndex}
                              onSelect={selectDraft}
                            />
                            <Recap session={session} />
                          </>
                        )}
                      </>
                    )}
                  </motion.section>
                </AnimatePresence>
              </div>
              <OutreachConnector
                active={screen === "waitlist" && Boolean(session?.brief?.drafts.length)}
                reduced={flow.reduced}
                revision={`${screen}:${draftIndex}:${compact}`}
              />
            </div>
            <footer className="research-stage-footer">
              <ActivityLine
                text={voteError || activity}
                events={flow.events}
                working={
                  !failed &&
                  (session?.status !== "ready" || session?.briefStatus === "pending")
                }
              />
              {shown && screen !== "waitlist" && session && (
                <StepFeedback
                  id={screen}
                  value={session.feedback.find((entry) => entry.step === screen)?.vote}
                  onVote={(value) => {
                    setVoteError("");
                    void vote({ token, step: screen, vote: value }).catch(() =>
                      setVoteError("Could not save feedback. Try again."),
                    );
                  }}
                />
              )}
              <div className="research-pager">
                {selected > 0 && (
                  <button
                    type="button"
                    onClick={() => flow.move("ArrowLeft")}
                    aria-label="Previous stage"
                  >
                    <ChevronLeft size={16} aria-hidden />
                    <span>Back</span>
                  </button>
                )}
                {selected < frontier && (
                  <button
                    type="button"
                    onClick={() => flow.move("ArrowRight")}
                    aria-label="Next stage"
                  >
                    <span>Next</span>
                    <ChevronRight size={16} aria-hidden />
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {screen === "waitlist"
            ? "Your next step. Join the waitlist to save your research."
            : `${LABELS[screen]}. ${shown ? "Findings are ready." : timedOut ? "Findings are still pending." : "Research in progress."}`}
        </p>
      </main>
    </LayoutGroup>
  );
}
