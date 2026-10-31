/**
 * Heat: how much is happening at an account right now, from its recent signals.
 * Pure and free of Node imports: queries and the UI both use it. The numbers
 * are the workspace's signals.heat model (recipes/models.ts), which its queries
 * read and send to the browser.
 *
 *   points(signal) = points[bucket] x recency(age) x (repostFactor if reposted)
 *   recency(age)   = 1 for a signal posted today, falling in a straight line to 0 at windowDays
 *   heat           = round(100 x (1 - e^(-sum(points) / saturation)))
 *
 * `age` runs from when the source says the signal happened (a role's posting
 * date), or when Canon first saw it if the source gives none. The curve gives
 * each extra signal less than the one before it: on Canon's defaults one fresh
 * role is 22, three are 53, six are 78, ten are 92, so one account with fifty
 * open roles does not outrank a few well-timed ones. A website change or a blog
 * post counts for less than a role. A social profile is presence, not motion,
 * so it adds no heat; it counts toward growth (./growth.ts). A new bucket needs
 * an entry in HEAT_BUCKETS and the model's points.
 */
import type { HeatBucket, HeatModel } from "../../../recipes/models.ts";

export type HeatSignal = {
  bucket: HeatBucket;
  /** Epoch ms the signal happened (posting date), else when Canon first saw it. */
  observedAt: number;
  reposted?: boolean;
};

const DAY_MS = 86_400_000;

export type HeatLabel = "burning" | "warm" | "cool" | "none";

export function signalPoints(signal: HeatSignal, now: number, model: HeatModel): number {
  const ageDays = Math.max(0, (now - signal.observedAt) / DAY_MS);
  const recency = Math.max(0, 1 - ageDays / model.windowDays);
  return model.points[signal.bucket] * recency * (signal.reposted ? model.repostFactor : 1);
}

export function heatScore(signals: HeatSignal[], now: number, model: HeatModel): { score: number; label: HeatLabel } {
  const total = signals.reduce((sum, s) => sum + signalPoints(s, now, model), 0);
  const score = Math.round(100 * (1 - Math.exp(-total / model.saturation)));
  const { burning, warm, cool } = model.labels;
  return { score, label: score >= burning ? "burning" : score >= warm ? "warm" : score >= cool ? "cool" : "none" };
}

/** The key signals are stored and looked up under: a domain without protocol, "www." or path, lowercased. */
export const signalDomain = (domain: string) => domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

/** Domains one `signals.heatByDomain` call answers; a longer list is asked for in chunks of this size. */
export const HEAT_DOMAINS_MAX = 200;

/**
 * The domains of the rows on screen, normalized, deduplicated and split into
 * chunks the heat query accepts. A chunk's contents depend only on the rows
 * before it, so loading more rows leaves earlier chunks (and their live
 * subscriptions) unchanged.
 */
export function heatChunks(domains: readonly string[]): string[][] {
  const unique = [...new Set(domains.map(signalDomain).filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += HEAT_DOMAINS_MAX) chunks.push(unique.slice(i, i + HEAT_DOMAINS_MAX));
  return chunks;
}
