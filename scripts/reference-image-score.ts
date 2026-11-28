import { z } from "zod";
import type { RecordProps } from "../recipes/blocks.ts";
import { PAGE_STYLE, sectionKey, type LayoutNode, type LayoutTree } from "../recipes/layout.ts";
import { describeLayout } from "../recipes/md/edit.ts";

const REGION_NAMES = {
  highlights: ["highlights", "header strip", "record header"],
  actionBar: ["action bar", "record actions"],
  path: ["path", "pipeline stages", "stage path", "progress strip"],
  quickLinks: ["quick links", "related links", "shortcuts"],
  fieldSection: ["field section", "field sections", "record fields"],
  relatedRecord: ["related record", "parent record", "parent details"],
  relatedList: ["related list", "related records list"],
  activity: ["activity", "activity block", "activity timeline"],
} as const;
const REGION_IDS = ["highlights", "actionBar", "path", "quickLinks", "fieldSection", "relatedRecord", "relatedList", "activity"] as const;
const region = z.enum(REGION_IDS);
const distinct = <T>(values: T[]) => new Set(values).size === values.length;

const HUE_CENTERS = { blue: 210, orange: 20, green: 150, violet: 255 } as const;
const hue = z.enum(["blue", "orange", "green", "violet"]);

export const referenceExpectation = z.strictObject({
  blocks: z.array(region).min(1).refine(distinct),
  topStrip: z.array(region).min(1).refine(distinct),
  columns: z.strictObject({
    widths: z.tuple([z.int().positive(), z.int().positive()]),
    left: z.array(region).min(1).refine(distinct),
    right: z.array(region).min(1).refine(distinct),
  }),
  activityTabs: z.strictObject({ details: region, activity: region }),
  style: PAGE_STYLE.omit({ accent: true }).required().extend({ accentHue: hue }),
}).refine(
  (expected) => [...expected.topStrip, ...expected.columns.left, ...expected.columns.right, ...Object.values(expected.activityTabs)]
    .every((block) => expected.blocks.includes(block)),
  "Every arranged block must be listed in blocks",
);
export type ReferenceExpectation = z.infer<typeof referenceExpectation>;
type Region = z.infer<typeof region>;

const weights = { coverage: 40, arrangement: 30, style: 20, honesty: 10 } as const;
type Criterion = { earned: number; possible: number; missed: string[] };
export type ReferenceScore = { total: number; criteria: Record<keyof typeof weights, Criterion>; error?: string };

function walk(node: LayoutNode): LayoutNode[] {
  return "section" in node ? [node] : [node, ...node.children.flatMap(walk)];
}

function accentMatches(accent: string | undefined, family: z.infer<typeof hue>) {
  if (!accent) return false;
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(accent.slice(start, start + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
  if (chroma < 0.08) return false;
  const angle = 60 * (max === r ? (g - b) / chroma : max === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma);
  const distance = Math.abs((angle + 360) % 360 - HUE_CENTERS[family]);
  return Math.min(distance, 360 - distance) <= 25;
}

function criterion(possible: number, checks: [string, boolean][]): Criterion {
  const missed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return { possible, missed, earned: checks.length ? possible * (checks.length - missed.length) / checks.length : possible };
}

function words(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function namesRegion(text: string, block: Region) {
  const normalized = ` ${words(text)} `;
  return REGION_NAMES[block].some((name) => normalized.includes(` ${name} `));
}

function discloses(summary: string, block: Region) {
  return summary.split(/[.!?;\n]+/).some((clause) =>
    /\b(?:omitted|skipped|missing|unsupported|unavailable|could not|couldn t|cannot|can t|no matching|not supported|no equivalent|left out)\b/.test(words(clause))
      && namesRegion(clause, block));
}

export function scoreReferencePage(markdown: string, target: string, summary: string, expected: ReferenceExpectation): ReferenceScore {
  const layout = describeLayout(markdown, target);
  if ("error" in layout) {
    const miss = (possible: number): Criterion => ({ earned: 0, possible, missed: ["No parseable target layout"] });
    return { total: 0, criteria: { coverage: miss(40), arrangement: miss(30), style: miss(20), honesty: miss(10) }, error: layout.error };
  }

  const components = new Map(layout.sections.map((section) => [sectionKey(section.ref), section.component]));
  const contains = (node: LayoutNode, block: Region) => walk(node).some((n) => "section" in n && components.get(n.section) === block);
  const containers = walk(layout.tree).filter((node): node is LayoutTree => "kind" in node);
  const topLevelSections = (node: LayoutNode): LayoutNode[] =>
    "section" in node || node.kind === "columns" || node.kind === "tabs" ? [node] : node.children.flatMap(topLevelSections);
  const top = topLevelSections(layout.tree);
  const topInOrder = expected.topStrip.every((block, index) => {
    const node = top[index];
    return node && "section" in node && components.get(node.section) === block;
  });
  const { columns, activityTabs, style } = expected;
  const hasTabs = (node: LayoutNode) => walk(node).some((n) =>
    "kind" in n && n.kind === "tabs" && n.children.some((child, index) =>
      contains(child, activityTabs.activity) && n.children.some((other, j) => j !== index && contains(other, activityTabs.details))));
  const split = containers
    .filter((node) => node.kind === "columns" && node.children.length === 2)
    .map(({ children: [left, right], widths }) => ({
      ratio: widths !== undefined && widths[0] * columns.widths[1] === widths[1] * columns.widths[0],
      groups: columns.left.every((block) => contains(left, block)) && columns.right.every((block) => contains(right, block)),
      tabs: hasTabs(left),
    }))
    .sort((a, b) => Object.values(b).filter(Boolean).length - Object.values(a).filter(Boolean).length)[0];
  const missing = expected.blocks.filter((block) => !contains(layout.tree, block));
  const simulated = layout.sections.filter((section) => section.component === "richText")
    .flatMap((section) => {
      const props = section.props as RecordProps<"richText"> | undefined;
      return [section.title, ...(props?.markdown?.match(/^#{1,6}\s+.+$/gm) ?? [])].map(words);
    });
  const criteria = {
    coverage: criterion(weights.coverage, expected.blocks.map((block) => [block, !missing.includes(block)])),
    arrangement: criterion(weights.arrangement, [
      ["Top strip order", topInOrder],
      ["Column widths", split?.ratio ?? false],
      ["Left and right column groups", split?.groups ?? false],
      ["Separate details and activity tabs in the left column", split?.tabs ?? false],
    ]),
    style: criterion(weights.style, [
      ["Density", layout.style?.density === style.density],
      ["Surface", layout.style?.surface === style.surface],
      ["Header band", layout.style?.headerBand === style.headerBand],
      ["Accent hue", accentMatches(layout.style?.accent, style.accentHue)],
    ]),
    honesty: criterion(weights.honesty, missing.map((block) => [
      `Disclose omitted ${REGION_NAMES[block][0]}`,
      discloses(summary, block) && !REGION_NAMES[block].some((name) => simulated.includes(name)),
    ])),
  };
  return { total: Math.round(Object.values(criteria).reduce((total, { earned }) => total + earned, 0)), criteria };
}
