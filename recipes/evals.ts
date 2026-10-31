/**
 * A recipe's evals (docs/recipes.md, "Authoring by agent"): sample play calls and what their results must look like.
 * They are plain data, so they ship with the recipe, run in the recipe runtime like any other call, and tell an
 * admin what a proposed settings change would break before they approve it.
 */
import type { PlayCall } from "./run.ts";
import type { Settings } from "./kernel.ts";

/**
 * What a result must match. A value matches itself. An object matches when each key it lists matches. A list
 * matches when, for each of its patterns, some item matches. `{ every }` matches a list whose every item matches.
 * `{ includes }` matches a string containing it, where `{key}` stands for that setting's value.
 */
export type Expect = string | number | boolean | null | { includes: string } | { every: Expect } | readonly Expect[] | { readonly [key: string]: Expect };

export type RecipeEval = { name: string; description: string; call: PlayCall; expect: Expect };
export type EvalResult = { name: string; ok: boolean; detail: string | null };

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v) : JSON.stringify(v) ?? String(v));
const fill = (text: string, s: Settings) => text.replace(/\{(\w+)\}/g, (m, key: string) => (Object.hasOwn(s, key) ? String(s[key]) : m));
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** An item's name in a path: its `key` when it has one, else its position. */
const itemAt = (path: string, item: unknown, i: number) => `${path}[${record(item) && typeof item.key === "string" ? item.key : i}]`;
/** The item's own note, which says why a check failed. */
const noted = (item: unknown, why: string) => (record(item) && typeof item.note === "string" ? `${why} (${item.note})` : why);

/** Why `value` doesn't match `expect`, or null when it does. */
export function mismatch(expect: Expect, value: unknown, settings: Settings, path = "result"): string | null {
  if (expect === null || typeof expect !== "object") return Object.is(expect, value) ? null : `${path} is ${show(value)}, expected ${show(expect)}`;
  if (Array.isArray(expect)) {
    if (!Array.isArray(value)) return `${path} is ${show(value)}, expected a list`;
    for (const want of expect as readonly Expect[]) {
      const misses = value.map((item, i) => mismatch(want, item, settings, itemAt(path, item, i)));
      if (misses.includes(null)) continue;
      const key = record(want) ? (want as Record<string, unknown>).key : undefined;
      const same = typeof key === "string" ? value.findIndex((item) => record(item) && item.key === key) : -1;
      return same >= 0 ? noted(value[same], misses[same]!) : `${path} has nothing matching ${show(want)}`;
    }
    return null;
  }
  if ("includes" in expect && typeof expect.includes === "string") {
    const needle = fill(expect.includes, settings);
    return typeof value === "string" && value.includes(needle) ? null : `${path} doesn't contain ${show(needle)}`;
  }
  if ("every" in expect) {
    if (!Array.isArray(value)) return `${path} is ${show(value)}, expected a list`;
    for (const [i, item] of value.entries()) {
      const why = mismatch(expect.every as Expect, item, settings, itemAt(path, item, i));
      if (why) return noted(item, why);
    }
    return null;
  }
  if (!record(value)) return `${path} is ${show(value)}, expected an object`;
  for (const [key, want] of Object.entries(expect as Record<string, Expect>)) {
    const why = mismatch(want, value[key], settings, `${path}.${key}`);
    if (why) return why;
  }
  return null;
}
