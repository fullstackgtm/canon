// Loads the versioned taxonomy files (taxonomy/*.json).
import { readFileSync, existsSync } from "node:fs";

const dir = new URL("../../taxonomy/", import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));

export type Archetypes = {
  version: string;
  groups: Record<string, { label: string; definition: string; archetypes: Record<string, string> }>;
};
export type Jtbd = {
  version: string;
  conditions: Record<string, string>;
  jtbd: Record<string, { label: string; conditions: Record<string, number> }>;
  condition_overrides: Record<string, Record<string, number>>;
};
/** archetypeKey ("group/archetype") -> condition -> probability (Jev-scored, cached). */
export type ArchetypeConditions = { version: string; model: string; scores: Record<string, Record<string, number>> };

export const archetypes = (): Archetypes => read("archetypes.v1.json");
export const jtbd = (): Jtbd => read("jtbd.v1.json");
export const archetypeConditionsPath = dir + "archetype_conditions.v1.json";
export const archetypeConditions = (): ArchetypeConditions | null =>
  existsSync(archetypeConditionsPath) ? read("archetype_conditions.v1.json") : null;

/** Flat list of every archetype with its group, as "group/archetype" keys. */
export function allArchetypes(a = archetypes()) {
  return Object.entries(a.groups).flatMap(([g, grp]) =>
    Object.entries(grp.archetypes).map(([k, def]) => ({ key: `${g}/${k}`, group: g, groupLabel: grp.label, archetype: k, definition: def })));
}
