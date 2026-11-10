/**
 * Upgrading an installed recipe (docs/recipes.md, "Layers, settings and forks"): a three-way diff per setting between
 * the installed version's default, the new version's default and the workspace's override, and the overrides an
 * upgrade keeps once an admin has chosen keep or take for each conflict.
 */
import { checkSetting, sameSetting, type AnyDescriptor, type SettingValue, type Settings } from "./kernel.ts";

type Version = { settings: Settings; settingsSchema: readonly AnyDescriptor[] };

export type UpgradeLine =
  /** Not overridden, and the default didn't change. */
  | { key: string; kind: "unchanged"; value: SettingValue }
  /** Not overridden: the workspace takes the new default. */
  | { key: string; kind: "takesDefault"; from: SettingValue; to: SettingValue }
  /** Overridden, and the default didn't change: the override stays. */
  | { key: string; kind: "keepsOverride"; value: SettingValue; default: SettingValue }
  /** Overridden, and the default changed: an admin keeps the override or takes the new default. */
  | { key: string; kind: "conflict"; override: SettingValue; from: SettingValue; to: SettingValue }
  /** The new version has no such setting: its override, if any, is dropped. */
  | { key: string; kind: "removed"; default: SettingValue; dropped: SettingValue | null }
  /** Overridden with a value the new version no longer accepts: the override is dropped. */
  | { key: string; kind: "invalid"; dropped: SettingValue; to: SettingValue; reason: string }
  | { key: string; kind: "added"; value: SettingValue };

export type Choice = "keep" | "take";

/** Each setting of the new version in its form order, then each setting it removed. */
export function upgradeDiff(from: Version, to: Version, overrides: Settings): UpgradeLine[] {
  const lines = to.settingsSchema.map((d): UpgradeLine => {
    const key = d.key, next = to.settings[key];
    if (!from.settingsSchema.some((x) => x.key === key)) return { key, kind: "added", value: next };
    const old = from.settings[key], override = overrides[key];
    const changed = !sameSetting(old, next);
    if (override === undefined || sameSetting(override, next)) return changed ? { key, kind: "takesDefault", from: old, to: next } : { key, kind: "unchanged", value: next };
    const checked = checkSetting(d, override);
    if (!checked.ok) return { key, kind: "invalid", dropped: override, to: next, reason: `${d.label} must now be ${checked.error}` };
    return changed ? { key, kind: "conflict", override, from: old, to: next } : { key, kind: "keepsOverride", value: override, default: next };
  });
  const removed = from.settingsSchema.filter((d) => !to.settingsSchema.some((x) => x.key === d.key))
    .map((d): UpgradeLine => ({ key: d.key, kind: "removed", default: from.settings[d.key], dropped: overrides[d.key] ?? null }));
  return [...lines, ...removed];
}

/** The overrides the upgrade leaves, or the conflicts still waiting for a choice. */
export function upgradedOverrides(lines: readonly UpgradeLine[], choices: Readonly<Record<string, Choice>>): { overrides: Settings; unchosen: string[] } {
  const overrides: Record<string, SettingValue> = {};
  const unchosen: string[] = [];
  for (const line of lines) {
    if (line.kind === "keepsOverride") overrides[line.key] = line.value;
    if (line.kind !== "conflict") continue;
    const choice = choices[line.key];
    if (choice === "keep") overrides[line.key] = line.override;
    else if (choice !== "take") unchosen.push(line.key);
  }
  return { overrides, unchosen };
}
