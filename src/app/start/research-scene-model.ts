import { layoutMap, type MapNode } from "../../lib/icp-map.ts";
import { exampleAccounts } from "../../../convex/lib/onboardingBrief.ts";
import { segmentFor } from "../../../convex/lib/researchPipeline.ts";
import type { ResearchSession } from "./research-content";
import type { ScreenId } from "./research-reveal-state";

export type SceneNode = MapNode & { name: string; count: number | null };
/** Each stage frames the same map closer in: market, segment, its accounts, the buyer roles, one account. */
export type SceneStep =
  | "overview"
  | "market"
  | "segment"
  | "accounts"
  | "persona"
  | "outreach";
export const JOURNEY: Record<ScreenId, SceneStep> = {
  offer: "overview",
  market: "market",
  buyers: "segment",
  team: "accounts",
  plan: "persona",
  waitlist: "outreach",
};
/** Segments drawn in the market. The market stage lists every segment. */
const MAX_SEGMENTS = 6;

export function personaTitles(session: ResearchSession | undefined): string[] {
  const persona = session?.icp?.persona;
  const titles: string[] = persona?.titleKeywords ?? [];
  return titles.length
    ? titles
    : [
        [...(persona?.jobLevels ?? []), ...(persona?.departments ?? [])].join(
          " ",
        ),
      ].filter(Boolean);
}
/** The brief binds drafts to this joined form of the persona. */
function personaKey(session: ResearchSession | undefined) {
  const persona = session?.icp?.persona;
  return (
    persona?.titleKeywords?.join(" or ") ||
    [...(persona?.jobLevels ?? []), ...(persona?.departments ?? [])].join(" ")
  );
}
/** "VP Marketing, Head of Media +2" */
export function shortList(items: readonly string[], shown = 2) {
  const head = items.slice(0, shown).join(", ");
  return items.length > shown ? `${head} +${items.length - shown}` : head;
}

export function buildResearchScene(
  session: ResearchSession | undefined,
  draftIndex = 0,
) {
  const segments = [...(session?.segments ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SEGMENTS);
  const nodes: SceneNode[] = [
    {
      id: "market",
      parent: null,
      kind: "icp",
      name: "Addressable market",
      count: session?.tamTotal ?? null,
    },
    ...segments.map((segment) => ({
      id: segment.id,
      parent: "market",
      kind: "segment" as const,
      name: segment.name,
      count: segment.count,
    })),
  ];
  // The market encloses its sampled segments; its own count is a label, not a radius, because
  // segment counts come from the account sample and the two scales are not comparable.
  const layout = layoutMap(
    // A segment-sized header band keeps the market snug around its segments.
    nodes.map((n) =>
      n.kind === "icp" ? { ...n, kind: "segment" as const } : n,
    ),
    {
      nodes: segments.map((segment) => ({
        id: segment.id,
        accounts: segment.count,
      })),
      overlaps: [],
    },
  );
  const byId = new Map(layout.circles.map((circle) => [circle.id, circle]));
  const market = byId.get("market")!;
  const key = personaKey(session);
  // Persona size is unknown, so every ring takes the same share of its segment.
  const rings = new Map(
    key
      ? segments.map((segment) => {
          const circle = byId.get(segment.id)!;
          return [
            segment.id,
            {
              id: `${segment.id}:persona`,
              x: circle.x + circle.r * 0.16,
              y: circle.y + circle.r * 0.14,
              r: circle.r * 0.5,
            },
          ];
        })
      : [],
  );
  const drafts = session?.brief?.drafts ?? [];
  const draft = drafts[draftIndex];
  const examples = exampleAccounts(session?.preview ?? []);
  const fits = new Map(
    (session?.preview ?? []).map((row) => [
      (row as { domain?: string }).domain,
      (row as { fit?: number }).fit,
    ]),
  );
  const placed: Array<{ x: number; y: number; r: number }> = [];
  const accounts = examples.map((account, index) => {
    const segment = segments.find((s) => s.id === segmentFor(account).id);
    const circle = segment ? byId.get(segment.id)! : market;
    const ring = segment ? rings.get(segment.id) : undefined;
    const drafted = drafts.some(
      (item) => item.account.domain === account.domain && item.persona === key,
    );
    const fit = fits.get(account.domain);
    const base = {
      ...account,
      fit,
      size: logoRadius(segment ? circle.r : 0, fit),
      segment: segment?.id ?? null,
      isTarget: account.domain === draft?.account.domain,
      inPersona: Boolean(ring && drafted),
    };
    // Only a verified draft target sits inside its buyer-role ring.
    let spot = {
      x: ring ? ring.x - ring.r * 0.1 : circle.x,
      y: ring?.y ?? circle.y,
    };
    if (!(ring && drafted)) {
      // Sunflower candidates spread evenly over the circle; the first that clears the ring, the
      // segments (for unsegmented accounts) and every logo already placed wins.
      const pad = circle.r * 0.03;
      for (let k = 0; k < 160; k++) {
        const reach = (circle.r * 0.9 - base.size) * Math.sqrt((k + 0.5) / 160);
        const angle = k * GOLDEN + index;
        const x = circle.x + Math.cos(angle) * reach;
        const y = circle.y + Math.sin(angle) * reach;
        const clear =
          (segment
            ? !ring ||
              Math.hypot(x - ring.x, y - ring.y) > ring.r + base.size + pad
            : segments.every((s) => {
                const c = byId.get(s.id)!;
                return Math.hypot(x - c.x, y - c.y) > c.r + 1.5;
              })) &&
          placed.every(
            (p) => Math.hypot(x - p.x, y - p.y) > p.r + base.size + pad,
          );
        spot = { x, y };
        if (clear) break;
      }
    }
    placed.push({ ...spot, r: base.size });
    return { ...base, ...spot };
  });
  const target = accounts.find((a) => a.isTarget);
  const focus = byId.get(target?.segment ?? segments[0]?.id ?? "market")!;
  const focusSegment = segments.find((s) => s.id === focus.id);
  const named = accounts.filter((a) => a.segment === focus.id);
  const match = session?.startingPlan?.landing.match(/[?&]segment=([^&#]+)/);
  const landing = match ? decodeURIComponent(match[1]) : null;
  return {
    nodes,
    circles: layout.circles,
    market,
    rings: [...rings.values()],
    accounts,
    target,
    focus,
    focusRing: rings.get(focus.id),
    // The rest of the focus segment's sample, one dot per account; named examples are logos instead.
    sample: focusSegment
      ? sampleDots(
          focus,
          rings.get(focus.id),
          focusSegment.count - named.length,
          named.map((a) => ({ x: a.x, y: a.y, r: a.size })),
        )
      : [],
    // The segment the workspace opens on, from the starting plan.
    landing: landing && byId.has(landing) ? landing : null,
    // The positioning point the visible draft is written on.
    angle: draft
      ? session?.brief?.positioning?.[draft.positioningIndex]
      : undefined,
    draft,
    personas: personaTitles(session),
  };
}

const GOLDEN = 2.39996;
/** A logo's largest radius as a share of its segment's; fit scales it from 55% to all of that. */
const LOGO = 0.13;
export const logoRadius = (circleR: number, fit: number | undefined) =>
  circleR * LOGO * (0.55 + 0.45 * Math.max(0, Math.min(1, fit ?? 0)));
/** Above this a dot per account stops being legible, so no dots are drawn. */
const MAX_DOTS = 400;

/**
 * `count` points spread evenly over a circle, clear of its buyer-role ring and of the logos in it.
 * A sunflower grows until enough candidates clear, then an even subset keeps the spread uniform.
 */
export function sampleDots(
  circle: { x: number; y: number; r: number },
  ring: { x: number; y: number; r: number } | undefined,
  count: number,
  avoid: Array<{ x: number; y: number; r: number }>,
) {
  if (count <= 0 || count > MAX_DOTS) return [];
  const pad = circle.r * 0.035;
  for (
    let total = Math.ceil(count * 1.5);
    total <= count * 20;
    total = Math.ceil(total * 1.4)
  ) {
    const free: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < total; k++) {
      const reach = circle.r * 0.9 * Math.sqrt((k + 0.5) / total);
      const p = {
        x: circle.x + Math.cos(k * GOLDEN) * reach,
        y: circle.y + Math.sin(k * GOLDEN) * reach,
      };
      if (ring && Math.hypot(p.x - ring.x, p.y - ring.y) < ring.r + pad)
        continue;
      if (avoid.some((a) => Math.hypot(p.x - a.x, p.y - a.y) < a.r + pad))
        continue;
      free.push(p);
    }
    if (free.length >= count)
      return Array.from(
        { length: count },
        (_, i) => free[Math.floor((i * free.length) / count)],
      );
  }
  return [];
}

export type Rect = { x: number; y: number; width: number; height: number };
export type RingChip = Rect & { text: string; rest: string[] };
const CHIP_H = 22;
const chipWidth = (text: string) => Math.ceil(text.length * 7) + 18;
const overlaps = (a: Rect, b: Rect, gap = 6) =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap;

/**
 * Persona title chips centred on points of a ring, in viewport pixels. Each takes the first free
 * angle: inside the box, clear of the other chips and of `avoid`, and outside the `blocked` arc the
 * connector leaves through. Titles that find no place collapse into a final "+N" chip.
 */
export function ringChips(
  titles: readonly string[],
  ring: { x: number; y: number; r: number },
  {
    box,
    avoid = [],
    blocked,
  }: {
    box: { width: number; height: number };
    avoid?: Rect[];
    blocked: [number, number];
  },
): RingChip[] {
  const angles = [
    -90, -135, -45, 180, 135, 45, -160, -20, 160, 20, 90, 0,
  ].filter((a) => a < blocked[0] || a > blocked[1]);
  const at = (text: string, taken: Rect[]) => {
    const width = chipWidth(text);
    for (const degrees of angles) {
      const angle = (degrees * Math.PI) / 180;
      const rect = {
        x: ring.x + Math.cos(angle) * ring.r - width / 2,
        y: ring.y + Math.sin(angle) * ring.r - CHIP_H / 2,
        width,
        height: CHIP_H,
      };
      if (
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + width <= box.width &&
        rect.y + CHIP_H <= box.height &&
        ![...taken, ...avoid].some((other) => overlaps(rect, other))
      )
        return rect;
    }
    return null;
  };
  const chips: RingChip[] = [];
  const rest: string[] = [];
  for (const text of titles) {
    const rect = at(text, chips);
    if (rect) chips.push({ ...rect, text, rest: [] });
    else rest.push(text);
  }
  while (rest.length) {
    const rect = at(`+${rest.length}`, chips);
    if (rect) {
      chips.push({ ...rect, text: `+${rest.length}`, rest });
      break;
    }
    const last = chips.pop();
    if (!last) break;
    rest.unshift(last.text);
  }
  return chips;
}
export type ResearchScene = ReturnType<typeof buildResearchScene>;

/** The scene circle (centre and radius) that fills the square viewport at each step. */
export function sceneCamera(scene: ResearchScene, step: SceneStep) {
  const { market, focus, focusRing, target } = scene;
  if (step === "overview" || step === "market" || focus === market)
    return { x: market.x, y: market.y, r: Math.max(4, market.r * 1.04) };
  if (step === "segment") return { x: focus.x, y: focus.y, r: focus.r * 1.6 };
  if (step === "accounts") return { x: focus.x, y: focus.y, r: focus.r * 1.1 };
  const ring = focusRing ?? { ...focus, r: focus.r * 0.5 };
  if (step === "persona") return { x: ring.x, y: ring.y, r: ring.r * 1.5 };
  return target
    ? { x: target.x, y: target.y, r: ring.r * 1.2 }
    : { x: ring.x, y: ring.y, r: ring.r * 1.1 };
}

export function availableDraft(index: number, count: number) {
  return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
}

export type SceneLabel = {
  id: string;
  title: string;
  detail: string;
  /** Point on the labelled circle or dot, in viewport pixels. */
  anchor: { x: number; y: number };
  y: number;
  height: number;
};
const LINE = 18;
/** Wrapped line count at 13px Plex Sans, word by word. */
function lines(text: string, width: number) {
  if (!text) return 0;
  let count = 1,
    used = 0;
  for (const word of text.split(/\s+/)) {
    const w = word.length * 7.4;
    if (used && used + 4 + w > width) {
      count++;
      used = w;
    } else used += (used ? 4 : 0) + w;
  }
  return count;
}

/**
 * Labels sit in a column beside the map, never over it. They keep their anchors' vertical order and
 * are pushed apart so none overlap, then pulled back inside the frame. Items arrive in priority
 * order; the lowest-priority labels are dropped when the column cannot hold them all.
 */
export function layoutLabels(
  items: Array<Omit<SceneLabel, "y" | "height">>,
  { width, height, gap = 10 }: { width: number; height: number; gap?: number },
): SceneLabel[] {
  let sized = items.map((item) => ({
    ...item,
    height: (lines(item.title, width) + lines(item.detail, width)) * LINE,
  }));
  while (
    sized.length > 1 &&
    sized.reduce((sum, item) => sum + item.height + gap, -gap) > height
  )
    sized = sized.slice(0, -1);
  sized.sort((a, b) => a.anchor.y - b.anchor.y);
  let floor = 0;
  const placed = sized.map((item) => {
    const y = Math.max(floor, item.anchor.y - item.height / 2);
    floor = y + item.height + gap;
    return { ...item, y };
  });
  let ceiling = height;
  for (let i = placed.length - 1; i >= 0; i--) {
    placed[i].y = Math.max(
      0,
      Math.min(placed[i].y, ceiling - placed[i].height),
    );
    ceiling = placed[i].y - gap;
  }
  return placed;
}

/** A labelled circle's anchor: the first point, upper right by default, that is inside the viewport. */
export function circleAnchor(
  circle: { x: number; y: number; r: number },
  size: number,
  angles = [-35, -15, 0, -55, 20, -75, 40],
) {
  for (const degrees of angles) {
    const angle = (degrees * Math.PI) / 180;
    const x = circle.x + Math.cos(angle) * circle.r;
    const y = circle.y + Math.sin(angle) * circle.r;
    if (x > 4 && x < size - 4 && y > 4 && y < size - 4) return { x, y };
  }
  return {
    x: Math.min(size - 6, circle.x + circle.r),
    y: Math.max(6, Math.min(size - 6, circle.y)),
  };
}
