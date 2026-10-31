"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import { ICP_MAP_FILL } from "@/lib/icp-map";
import {
  buildResearchScene,
  circleAnchor,
  layoutLabels,
  ringChips,
  sceneCamera,
  shortList,
  JOURNEY,
  type SceneLabel,
} from "./research-scene-model";
import type { ResearchSession } from "./research-content";
import type { ScreenId } from "./research-reveal-state";

const EASE = [0.22, 0.61, 0.36, 1] as const;
const LEGEND = 28;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** One column: the map sits above the findings, so the outreach connector leaves downward. */
function useStacked() {
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const change = () => setStacked(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return stacked;
}
const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

export function ResearchScene({
  session,
  screen,
  reduced,
  draftIndex,
  compact,
}: {
  session?: ResearchSession;
  screen: ScreenId;
  reduced: boolean;
  draftIndex: number;
  compact: boolean;
}) {
  const scene = useMemo(
    () => buildResearchScene(session, draftIndex),
    [session, draftIndex],
  );
  const step = JOURNEY[screen];
  const camera = sceneCamera(scene, step);
  const [figure, box] = useSize<HTMLElement>();
  const column = compact ? 132 : 164;
  const size = Math.max(
    120,
    Math.floor(Math.min(box.width - column - 20, box.height - LEGEND)),
  );
  const scale = size / (2 * camera.r);
  const px = (point: { x: number; y: number }) => ({
    x: (point.x - camera.x + camera.r) * scale,
    y: (point.y - camera.y + camera.r) * scale,
  });
  const view = `${camera.x - camera.r} ${camera.y - camera.r} ${2 * camera.r} ${2 * camera.r}`;
  // Labels and leaders wait for the camera to arrive, then appear at their final positions.
  const [settled, setSettled] = useState(view);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(view), reduced ? 0 : 950);
    return () => clearTimeout(timer);
  }, [view, reduced]);
  const labelsShown = reduced || settled === view;
  const zoomed = step !== "overview" && step !== "market";
  const inFocus = (segment: string | null) =>
    !zoomed || segment === scene.focus.id;
  /**
   * Accounts in the framed segment show as logos once the map zooms in, if the whole logo is inside
   * the frame; the rest stay dots, so no logo is cut by the frame's edge.
   */
  const asLogo = (account: (typeof scene.accounts)[number]) =>
    zoomed &&
    account.size > 0 &&
    account.segment === scene.focus.id &&
    (account.isTarget ||
      Math.hypot(account.x - camera.x, account.y - camera.y) + account.size <
        camera.r * 0.9);
  const stacked = useStacked();
  const ids = useId();
  const [loaded, setLoaded] = useState<string[]>([]);

  // Once the map frames the buyer roles, their titles sit on the ring itself, clear of the account's
  // logo and of the line leaving it: rightward to the labels and the draft, downward when stacked.
  const chips = useMemo(() => {
    const ring = scene.focusRing;
    const target = scene.target;
    if (
      (step !== "persona" && step !== "outreach") ||
      !ring ||
      !target?.inPersona
    )
      return [];
    const node = px(target);
    const reach = target.size * scale + 4;
    const down = stacked && step === "outreach";
    return ringChips(
      scene.personas,
      { ...px(ring), r: ring.r * scale },
      {
        // The label column is empty on the stacked outreach view, so chips may use it there.
        box: { width: down ? size + 20 + column : size, height: size },
        avoid: [
          {
            x: node.x - reach,
            y: node.y - reach,
            width: reach * 2,
            height: reach * 2,
          },
          // The line leaving the logo: the outreach connector runs down when stacked; label
          // leaders and the side-by-side connector run right.
          down
            ? { x: node.x - 2, y: node.y, width: 4, height: size - node.y }
            : { x: node.x, y: node.y - 2, width: size - node.x, height: 4 },
        ],
        blocked: down ? [60, 120] : [-30, 30],
      },
    );
    // px and scale derive from camera and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, step, size, column, stacked]);

  const labels = useMemo(() => {
    const items: Array<Omit<SceneLabel, "y" | "height">> = [];
    const inside = (p: { x: number; y: number }) =>
      p.x >= 0 && p.x <= size && p.y >= 0 && p.y <= size;
    const segmentLabel = (id: string) => {
      const node = scene.nodes.find((n) => n.id === id)!;
      const circle = scene.circles.find((c) => c.id === id)!;
      const [industry, tier] = node.name.split(" · ");
      items.push({
        id,
        title: industry,
        detail: `${tier ? `${tier}, ` : ""}${node.count?.toLocaleString()} in the sample`,
        anchor: circleAnchor({ ...px(circle), r: circle.r * scale }, size),
      });
    };
    const accountLabel = (account: (typeof scene.accounts)[number]) => {
      const centre = px(account);
      if (!inside(centre)) return;
      // A logo is labelled from its edge, a dot from its centre.
      const reach = asLogo(account) ? account.size * scale : 0;
      const anchor = {
        x: centre.x + reach * Math.SQRT1_2,
        y: centre.y - reach * Math.SQRT1_2,
      };
      items.push({
        id: `account:${account.domain}`,
        title: account.name,
        detail:
          account.fit === undefined
            ? ""
            : `${Math.round(account.fit * 100)}% fit`,
        anchor,
      });
    };
    if (step === "overview" || step === "market") {
      const market = scene.nodes[0];
      items.push({
        id: "market",
        title: "Addressable market",
        detail:
          market.count === null
            ? "Counting companies"
            : `${market.count.toLocaleString()}${session?.tamSaturated ? " or more" : ""} companies`,
        anchor: circleAnchor(
          { ...px(scene.market), r: scene.market.r * scale },
          size,
        ),
      });
      if (step === "market")
        scene.nodes
          .filter((n) => n.kind === "segment")
          .slice(0, compact ? 1 : 4)
          .forEach((n) => segmentLabel(n.id));
    } else if (scene.focus !== scene.market) {
      const ring = scene.focusRing;
      const ringLabel = () =>
        ring &&
        items.push({
          id: "persona",
          title: "Buyer roles",
          detail: shortList(scene.personas),
          anchor: circleAnchor({ ...px(ring), r: ring.r * scale }, size),
        });
      if (step === "segment") {
        segmentLabel(scene.focus.id);
        ringLabel();
      } else if (step === "accounts") {
        segmentLabel(scene.focus.id);
        scene.accounts
          .filter((a) => a.segment === scene.focus.id)
          .sort((a, b) => Number(b.isTarget) - Number(a.isTarget))
          .slice(0, compact ? 2 : 3)
          .forEach(accountLabel);
        const modules = session?.startingPlan?.modules ?? [];
        if (scene.landing === scene.focus.id && modules.length)
          items.push({
            id: "landing",
            title: "Your workspace opens on this segment",
            detail: `With ${shortList(modules.map((m) => m.label))}`,
            anchor: circleAnchor(
              { ...px(scene.focus), r: scene.focus.r * scale },
              size,
              [35, 55, 15, 75],
            ),
          });
      } else if (step === "persona") {
        if (!chips.length) ringLabel();
        if (scene.target) accountLabel(scene.target);
        const target = scene.target;
        if (target && scene.angle) {
          const centre = px(target);
          const reach = target.size * scale;
          // The panel leads with the first recommendation; name it rather than repeat it.
          const lead =
            scene.angle ===
            session?.brief?.positioning.find(
              (p) => p.kind === "recommendation",
            );
          items.push({
            id: "angle",
            title: lead
              ? "Its draft leads with the angle to test"
              : "Its draft leads with",
            detail: lead ? "" : scene.angle.text,
            anchor: {
              x: centre.x + reach * Math.SQRT1_2,
              y: centre.y + reach * Math.SQRT1_2,
            },
          });
        }
      }
    }
    return layoutLabels(items, { width: column, height: size });
    // px and scale derive from camera and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, step, size, column, compact, session, chips]);

  const dots = scene.sample.length > 0;
  const legend =
    step === "overview" || (compact && step === "outreach")
      ? null
      : zoomed
        ? compact
          ? dots
            ? "Dots: sampled accounts. Dashed rings: buyer roles."
            : "Dashed rings: buyer roles, size not measured."
          : dots
            ? "Each dot is a sampled account. Dashed rings mark buyer roles, size not measured."
            : "Dashed rings mark buyer roles. Their size is not measured."
        : compact
          ? "Segments are sized by sampled accounts."
          : "Segments are sized by accounts in the sample. Dots are example accounts.";
  const dot = (account: (typeof scene.accounts)[number]) =>
    ((step === "outreach" || step === "persona") && account.isTarget
      ? 6
      : step === "accounts" || step === "persona" || step === "outreach"
        ? 4
        : 2.5) / scale;
  const summary = `${session?.tamTotal == null ? "Market count pending." : `${session.tamTotal.toLocaleString()} companies in the addressable market.`} ${scene.nodes.length - 1} segments from the account sample.${zoomed && scene.focus !== scene.market ? ` Showing ${scene.nodes.find((n) => n.id === scene.focus.id)?.name}.` : ""}${(step === "persona" || step === "outreach") && scene.target ? ` Example account ${scene.target.name}.` : ""}${chips.length ? ` Buyer roles: ${scene.personas.join(", ")}.` : ""}`;

  return (
    <figure
      ref={figure}
      className="research-scene"
      aria-label="Market map"
      data-step={step}
    >
      <div
        className="research-scene-frame"
        style={{ width: size, height: size }}
      >
        <motion.svg
          initial={false}
          animate={{ viewBox: view }}
          transition={{ duration: reduced ? 0 : 0.9, ease: EASE }}
          role="img"
          aria-label={summary}
          className="research-scene-map"
          width="100%"
          height="100%"
        >
          {scene.circles.map((circle) => {
            const node = scene.nodes.find((n) => n.id === circle.id)!;
            const isMarket = node.kind === "icp";
            const opacity = isMarket
              ? 1
              : step === "overview"
                ? 0
                : inFocus(node.id)
                  ? 1
                  : 0.35;
            return (
              <motion.g
                key={node.id}
                initial={false}
                animate={{ opacity }}
                transition={{ duration: reduced ? 0.15 : 0.4 }}
              >
                <circle
                  cx={circle.x}
                  cy={circle.y}
                  r={circle.r}
                  fill={
                    isMarket && node.count === null
                      ? "none"
                      : ICP_MAP_FILL[isMarket ? "icp" : "segment"]
                  }
                  stroke={
                    isMarket ? "var(--muted-foreground)" : "var(--primary)"
                  }
                  strokeOpacity={isMarket ? 0.5 : 0.7}
                  strokeWidth={zoomed && node.id === scene.focus.id ? 1.5 : 1}
                  strokeDasharray={
                    isMarket && node.count === null ? "4 4" : undefined
                  }
                  vectorEffect="non-scaling-stroke"
                />
                <title>{`${node.name}. ${node.count === null ? "Count pending" : `${node.count.toLocaleString()} ${isMarket ? "companies" : "accounts in the sample"}`}`}</title>
              </motion.g>
            );
          })}
          {scene.rings.map((ring) => (
            <motion.circle
              key={ring.id}
              initial={false}
              animate={{
                opacity: !zoomed ? 0 : ring === scene.focusRing ? 1 : 0.35,
              }}
              transition={{ duration: reduced ? 0.15 : 0.4 }}
              cx={ring.x}
              cy={ring.y}
              r={ring.r}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={1.25}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {zoomed &&
            scene.sample.map((point, index) => (
              <motion.circle
                key={index}
                initial={{ opacity: 0 }}
                animate={{
                  r: 2.25 / scale,
                  opacity: step === "outreach" ? 0.35 : 0.7,
                }}
                transition={{ duration: reduced ? 0 : 0.9, ease: EASE }}
                cx={point.x}
                cy={point.y}
                fill="var(--muted-foreground)"
              />
            ))}
          {scene.accounts.map((account) => (
            <motion.circle
              key={account.domain}
              initial={false}
              animate={{
                r: dot(account),
                opacity:
                  step === "overview" || asLogo(account)
                    ? 0
                    : step === "outreach" && !account.isTarget
                      ? 0.25
                      : inFocus(account.segment)
                        ? 1
                        : 0.3,
              }}
              transition={{ duration: reduced ? 0 : 0.9, ease: EASE }}
              cx={account.x}
              cy={account.y}
              fill="var(--primary)"
              data-target={account.isTarget ? "true" : undefined}
            >
              <title>{`${account.name}. Example account from the sample.`}</title>
            </motion.circle>
          ))}
          {scene.accounts.filter(asLogo).map((account, index) => {
            const r = account.size;
            const inner = r * 0.62;
            const clip = `${ids}-logo-${index}`;
            return (
              <motion.g
                key={account.domain}
                initial={{ opacity: 0 }}
                animate={{
                  opacity: step === "outreach" && !account.isTarget ? 0.35 : 1,
                }}
                transition={{ duration: reduced ? 0.15 : 0.4 }}
                data-outreach-anchor={
                  step === "outreach" && account.isTarget ? "true" : undefined
                }
              >
                <title>{`${account.name}${account.fit === undefined ? ", fit not scored" : `, ${Math.round(account.fit * 100)}% fit`}. Example account from the sample.`}</title>
                <clipPath id={clip}>
                  <circle cx={account.x} cy={account.y} r={inner} />
                </clipPath>
                <circle
                  cx={account.x}
                  cy={account.y}
                  r={r}
                  fill="var(--card)"
                  stroke="var(--primary)"
                  strokeOpacity={account.isTarget ? 1 : 0.55}
                  strokeWidth={account.isTarget ? 1.5 : 1}
                  strokeDasharray={
                    account.fit === undefined ? "3 3" : undefined
                  }
                  vectorEffect="non-scaling-stroke"
                />
                {!loaded.includes(account.domain) && (
                  <text
                    x={account.x}
                    y={account.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={r * 0.8}
                    fill="var(--foreground)"
                  >
                    {account.name.slice(0, 1).toUpperCase()}
                  </text>
                )}
                <image
                  href={favicon(account.domain)}
                  x={account.x - inner}
                  y={account.y - inner}
                  width={inner * 2}
                  height={inner * 2}
                  clipPath={`url(#${clip})`}
                  preserveAspectRatio="xMidYMid slice"
                  onLoad={() =>
                    setLoaded((domains) => [...domains, account.domain])
                  }
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              </motion.g>
            );
          })}
        </motion.svg>
      </div>
      <svg
        className="research-scene-leaders"
        aria-hidden
        style={{ opacity: labelsShown ? 1 : 0 }}
      >
        {labels.map((label) => (
          <g key={label.id}>
            <circle cx={label.anchor.x} cy={label.anchor.y} r={2.5} />
            <path
              d={`M ${label.anchor.x} ${label.anchor.y} L ${size + 10} ${label.y + 9} H ${size + 16}`}
            />
          </g>
        ))}
      </svg>
      <ul
        className="research-scene-labels"
        aria-hidden
        style={{ left: size + 20, width: column, opacity: labelsShown ? 1 : 0 }}
      >
        {labels.map((label) => (
          <li key={label.id} style={{ top: label.y }}>
            <span>{label.title}</span>
            {label.detail && <span>{label.detail}</span>}
          </li>
        ))}
      </ul>
      {chips.length > 0 && (
        <ul
          className="research-scene-chips"
          aria-hidden
          style={{ opacity: labelsShown ? 1 : 0 }}
        >
          {chips.map((chip) => (
            <li
              key={chip.text}
              data-more={chip.rest.length ? "true" : undefined}
              title={chip.rest.length ? chip.rest.join(", ") : undefined}
              style={{ left: chip.x, top: chip.y, width: chip.width }}
            >
              {chip.text}
            </li>
          ))}
        </ul>
      )}
      {legend && (
        <figcaption className="research-scene-legend" style={{ top: size + 8 }}>
          {zoomed ? (
            <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                strokeDasharray="2.5 2"
              />
            </svg>
          ) : null}
          {legend}
        </figcaption>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {summary}
      </p>
    </figure>
  );
}

/** Joins the outreach account's logo on the map to the visible email card, inside the stage. */
export function OutreachConnector({
  active,
  reduced,
  revision,
}: {
  active: boolean;
  reduced: boolean;
  revision: string;
}) {
  const path = useRef<SVGPathElement>(null);
  useEffect(() => {
    const line = path.current;
    const layout = line?.closest(".research-stage-layout");
    if (!line || !layout) return;
    let frame = 0;
    const until = performance.now() + (reduced ? 200 : 1600);
    const draw = () => {
      const from = layout
        .querySelector("[data-outreach-anchor]")
        ?.getBoundingClientRect();
      const to = layout
        .querySelector("#research-email-card")
        ?.getBoundingClientRect();
      const origin = layout.getBoundingClientRect();
      if (!active || !from || !to || !from.width) {
        line.setAttribute("d", "");
        return;
      }
      const y = (from.top + from.bottom) / 2 - origin.top;
      if (to.top >= from.bottom) {
        const x = (from.left + from.right) / 2 - origin.left;
        line.setAttribute(
          "d",
          `M ${x} ${from.bottom - origin.top + 2} V ${to.top - origin.top}`,
        );
      } else {
        const start = from.right - origin.left + 2;
        const end = to.left - origin.left;
        const entry = Math.max(to.top - origin.top + 24, y);
        const mid = start + Math.max(8, (end - start) / 2);
        line.setAttribute("d", `M ${start} ${y} H ${mid} V ${entry} H ${end}`);
      }
    };
    const tick = () => {
      draw();
      if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    tick();
    const observer = new ResizeObserver(draw);
    observer.observe(layout);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, reduced, revision]);
  return (
    <svg className="research-connector" aria-hidden>
      <path ref={path} />
    </svg>
  );
}
