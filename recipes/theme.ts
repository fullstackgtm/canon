/**
 * Workspace themes (docs/recipes.md, "Points": workspace.theme). A recipe declares a few colours and two choices; Canon
 * derives every CSS variable the app reads (src/app/globals.css) from them, so a workspace's tweak can change the
 * look but never the readability: secondary text, labels and button text are moved until they pass contrast, and a
 * theme whose body text or surface can't is refused. Pure: no Convex and no Node imports, so it runs in queries and
 * the browser.
 */

/** What a theme declares, each value resolved from a literal or a workspace setting. */
export type ThemeSpec = {
  /** The page behind everything: the sidebar and the space around cards. */
  paper: string;
  /** Cards, tables and dialogs: where text is read. */
  surface: string;
  /** Body text. */
  ink: string;
  /** Actions, links, focus and won: the colour that does the work. */
  primary: string;
  /** The mark on values Canon filled in. */
  provenance: string;
  destructive: string;
  warning: string;
  /** Headings and record names in the serif, everything in the sans, or everything in the browser's Times (plain HTML). */
  headings: ThemeHeadings;
  /** Corner radius in px. */
  radius: ThemeRadius;
};

export const THEME_HEADINGS = ["serif", "sans", "plain"] as const;
export type ThemeHeadings = (typeof THEME_HEADINGS)[number];
export const THEME_RADII = ["0", "2", "4", "6", "8"] as const;
export type ThemeRadius = (typeof THEME_RADII)[number];

export const THEME_COLOR_KEYS = ["paper", "surface", "ink", "primary", "provenance", "destructive", "warning"] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export const THEME_KEYS = [...THEME_COLOR_KEYS, "headings", "radius"] as const satisfies readonly (keyof ThemeSpec)[];

/** Ledger, the look the app ships in (src/app/globals.css): what an unset value falls back to. */
export const LEDGER: ThemeSpec = {
  paper: "#eeeeeb", surface: "#fafaf8", ink: "#1c1a1a", primary: "#1e4d3a", provenance: "#7a2232",
  destructive: "#b3401a", warning: "#8f6400", headings: "serif", radius: "2",
};

const HEX = /^#[0-9a-f]{6}$/;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** `a` moved toward `b` by `t`, in sRGB. */
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
const channel = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (h: string) => { const [r, g, b] = rgb(h).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio of two colours. */
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** `c` darkened toward `toward` in steps until it reaches `target` contrast on `bg`. */
function until(c: string, bg: string, target: number, toward: string): string {
  let x = c;
  for (let i = 0; i < 20 && contrast(x, bg) < target; i++) x = mix(x, toward, 0.12);
  return x;
}

/** Why a theme can't be used: the app is built for a light page, and body text and marks must stay readable on it. */
export function themeProblems(t: ThemeSpec): Array<{ key: keyof ThemeSpec; message: string }> {
  const out: Array<{ key: keyof ThemeSpec; message: string }> = [];
  for (const k of THEME_COLOR_KEYS) if (!isHexColor(t[k])) out.push({ key: k, message: `${k} must be a colour like #1e4d3a` });
  if (!THEME_HEADINGS.includes(t.headings)) out.push({ key: "headings", message: `headings must be ${THEME_HEADINGS.join(" or ")}` });
  if (!THEME_RADII.includes(t.radius)) out.push({ key: "radius", message: `radius must be one of ${THEME_RADII.join(", ")}` });
  if (out.length) return out;
  const ratio = (a: string, b: string) => contrast(a, b).toFixed(1);
  if (luminance(t.surface) < 0.7) out.push({ key: "surface", message: "Canon's screens are built for a light page: pick a lighter surface" });
  if (luminance(t.paper) < 0.6) out.push({ key: "paper", message: "Canon's screens are built for a light page: pick a lighter paper" });
  if (contrast(t.ink, t.surface) < 7) out.push({ key: "ink", message: `body text needs 7:1 on the surface, and this is ${ratio(t.ink, t.surface)}:1` });
  for (const k of ["primary", "provenance", "destructive", "warning"] as const) {
    if (contrast(t[k], t.surface) < 3) out.push({ key: k, message: `${k} needs 3:1 on the surface to be seen, and this is ${ratio(t[k], t.surface)}:1` });
  }
  return out;
}

/** The theme with anything unusable replaced by Ledger's value, so a stored theme always renders. */
export function usableTheme(t: Partial<ThemeSpec>): ThemeSpec {
  const merged = { ...LEDGER, ...t } as ThemeSpec;
  const bad = new Set(themeProblems(merged).map((p) => p.key));
  if (!bad.size) return merged;
  const fixed = { ...merged };
  for (const k of bad) (fixed as Record<string, string>)[k] = LEDGER[k];
  return themeProblems(fixed).length ? LEDGER : fixed;
}

const PLAIN_FONT = '"Times New Roman", Times, serif';
const HEADING_FONTS: Record<ThemeHeadings, string> = {
  serif: "var(--font-plex-serif), Georgia, serif", sans: "var(--font-plex-sans), system-ui, sans-serif", plain: PLAIN_FONT,
};

/** Text on a colour: white when it reads at 4.5:1, else the ink when it does, else black (white or black always does). */
const on = (c: string, ink: string) => ["#ffffff", ink, "#000000"].find((x) => contrast(x, c) >= 4.5) ?? "#000000";

/**
 * Every CSS variable globals.css defines, derived from the theme. Lines and fills mix the ink into the surface;
 * secondary text is moved until it reads at 4.5:1 on both the surface and the paper.
 */
export function themeVars(input: Partial<ThemeSpec>): Record<string, string> {
  const t = usableTheme(input);
  const dim = until(until(mix(t.ink, t.surface, 0.36), t.surface, 4.5, t.ink), t.paper, 4.5, t.ink);
  const muted = mix(t.surface, t.ink, 0.06);
  return {
    "--background": t.surface, "--foreground": t.ink,
    "--card": t.surface, "--card-foreground": t.ink,
    "--popover": mix(t.surface, "#ffffff", 0.6), "--popover-foreground": t.ink,
    "--primary": t.primary, "--primary-foreground": on(t.primary, t.ink),
    "--secondary": mix(t.surface, t.ink, 0.055), "--secondary-foreground": t.ink,
    "--muted": muted, "--muted-foreground": dim,
    "--accent": muted, "--accent-foreground": t.ink,
    "--destructive": t.destructive, "--warning": t.warning,
    "--brand": t.provenance, "--provenance": t.provenance, "--provenance-tint": mix(t.surface, t.provenance, 0.2),
    "--border": mix(t.surface, t.ink, 0.09), "--input": mix(t.surface, t.ink, 0.18), "--ring": t.primary,
    "--chart-1": t.primary, "--chart-2": t.provenance, "--chart-3": t.warning, "--chart-4": dim, "--chart-5": mix(t.primary, t.surface, 0.45),
    "--sidebar": t.paper, "--sidebar-foreground": t.ink,
    "--sidebar-primary": t.primary, "--sidebar-primary-foreground": on(t.primary, t.ink),
    "--sidebar-accent": mix(t.paper, t.ink, 0.07), "--sidebar-accent-foreground": t.ink,
    "--sidebar-border": mix(t.paper, t.ink, 0.08), "--sidebar-ring": t.primary,
    "--radius": `${t.radius}px`,
    "--heading-font": HEADING_FONTS[t.headings],
    "--body-font": t.headings === "plain" ? PLAIN_FONT : "var(--font-plex-sans), system-ui, sans-serif",
    // Plain type also strips the page to bare HTML (globals.css, body[data-look="plain"]); WorkspaceTheme sets the attribute.
    "--look": t.headings === "plain" ? "plain" : "styled",
  };
}

/** A theme as a recipe declares it: each key a literal or `{ setting }`, a workspace setting of the recipe. Unset keys fall back to Ledger. */
export type ThemeDecl = Partial<Record<keyof ThemeSpec, string | { setting: string }>>;

const isBound = (v: unknown): v is { setting: string } => typeof v === "object" && v !== null && typeof (v as { setting?: unknown }).setting === "string";

/** The declaration with each binding replaced by the workspace's value, unset keys at Ledger's: what a save checks. */
export function declaredTheme(decl: ThemeDecl, settings: Readonly<Record<string, unknown>>): ThemeSpec {
  const out: Partial<Record<keyof ThemeSpec, string>> = {};
  for (const k of THEME_KEYS) {
    const v = decl[k];
    const value = isBound(v) ? settings[v.setting] : v;
    if (typeof value === "string") out[k] = value;
  }
  return { ...LEDGER, ...out } as ThemeSpec;
}

/** The theme a workspace sees: its declared theme, with anything unusable at Ledger's value so it always renders. */
export const resolveTheme = (decl: ThemeDecl, settings: Readonly<Record<string, unknown>>): ThemeSpec => usableTheme(declaredTheme(decl, settings));

/** A setting as a theme binding sees it. */
type BindableSetting = { key: string; kind: string; options?: readonly string[] };
const CHOICES: Partial<Record<keyof ThemeSpec, readonly string[]>> = { headings: THEME_HEADINGS, radius: THEME_RADII };

/** Why a declared theme doesn't hold together: an unknown key, a bad literal, or a binding to a setting that can't fill it. */
export function themeDeclProblems(decl: unknown, schema: readonly BindableSetting[]): string[] {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return ["the theme block must be a map of keys to values"];
  const out: string[] = [];
  const byKey = new Map(schema.map((d) => [d.key, d]));
  for (const [k, v] of Object.entries(decl as Record<string, unknown>)) {
    if (!(THEME_KEYS as readonly string[]).includes(k)) { out.push(`${k} is not a theme key (${THEME_KEYS.join(", ")})`); continue; }
    const key = k as keyof ThemeSpec, choices = CHOICES[key];
    if (isBound(v)) {
      const d = byKey.get(v.setting);
      if (!d) out.push(`${k} binds "${v.setting}", which is not a setting`);
      else if (!choices && d.kind !== "color") out.push(`${k} needs a color setting, and "${v.setting}" is ${d.kind}`);
      else if (choices && (d.kind !== "choice" || !(d.options ?? []).every((o) => choices.includes(o)))) out.push(`${k} needs a choice setting with options from ${choices.join(", ")}`);
    } else if (typeof v !== "string") out.push(`${k} must be a value or { setting: key }`);
    else if (choices ? !choices.includes(v) : !isHexColor(v)) out.push(choices ? `${k} must be one of ${choices.join(", ")}` : `${k} must be a colour like #1e4d3a`);
  }
  return out;
}
