// Bombadil specification for CanonCRM, run against this worktree's isolated stack only.
// Run it with `npm run e2e:bombadil` (see e2e/bombadil/README.md). It is not part of PR CI.
//
// Bombadil bundles this module itself and supplies the `@antithesishq/bombadil` imports from
// its own binary. tsconfig excludes e2e/, so the repository never needs the package installed.
import { actions, always, eventually, extract, now, weighted } from "@antithesishq/bombadil";
import { registerCustomAction, type ActionTemplate } from "@antithesishq/bombadil/browser";
import { back, clicks, inputs, reload, scroll } from "@antithesishq/bombadil/browser/defaults/actions";

// The four default properties: uncaught exceptions, unhandled rejections, console errors and
// HTTP 4xx/5xx responses.
export {
  noConsoleErrors,
  noHttpErrorCodes,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

// ---------------------------------------------------------------------------------------------
// Extractors. Each runs in the page on every captured state and returns JSON.

const url = extract((s) => s.navigationHistory.current.url);

const pageError = extract((s) => {
  const doc = s.document;
  const text = doc.body?.innerText ?? "";
  // Next.js dev overlay: an open error dialog, or the "N Issues" indicator, in its shadow root.
  const portal = doc.querySelector("nextjs-portal")?.shadowRoot ?? null;
  const overlayOpen = Boolean(portal?.querySelector("[data-nextjs-error-overlay-nav], [data-nextjs-dialog]"));
  const issues = /\b\d+\s+Issues?\b/.exec(portal?.textContent ?? "")?.[0] ?? null;
  // src/app/dashboard/error.tsx, Next's production error page, src/app/not-found.tsx.
  const boundary = /Something went wrong|Application error: a (client|server)-side exception|Page not found/.exec(text)?.[0] ?? null;
  return { overlayOpen, issues, boundary };
});

// Names in the visible record list (accounts and people share the `record-name` cell).
const listed = extract((s) => {
  const path = s.window.location.pathname;
  if (path !== "/dashboard/accounts" && path !== "/dashboard/contacts") return null;
  const names = [...s.document.querySelectorAll("tbody input[type=checkbox][aria-label^='Select ']")]
    .map((el) => (el.getAttribute("aria-label") ?? "").slice("Select ".length));
  return { path, names };
});

// What the archive action below recorded. localStorage survives reloads within the run.
const archived = extract((s) => {
  try {
    return JSON.parse(s.window.localStorage.getItem("bombadil:archived") ?? "[]") as { path: string; name: string }[];
  } catch {
    return [];
  }
});

// The list summaries: "Showing X of Y" (accounts) and "N shown · M loaded of T people" (people).
const counts = extract((s) => {
  const path = s.window.location.pathname;
  const text = s.document.body?.innerText ?? "";
  const rows = s.document.querySelectorAll("tbody input[type=checkbox][aria-label^='Select ']").length;
  const num = (v: string) => Number(v.replace(/,/g, ""));
  if (path === "/dashboard/accounts") {
    const m = /Showing ([\d,]+) of ([\d,]+)/.exec(text);
    return m ? { path, rows, shown: num(m[1]), loaded: num(m[1]), total: num(m[2]) } : null;
  }
  if (path === "/dashboard/contacts") {
    const m = /([\d,]+) shown · ([\d,]+) loaded of ([\d,]+) people/.exec(text);
    return m ? { path, rows, shown: num(m[1]), loaded: num(m[2]), total: num(m[3]) } : null;
  }
  return null;
});

// The focused text field and its value, to check that typed text stays put.
const focused = extract((s) => {
  const el = s.document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return null;
  const textual = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search", "email", "url", ""].includes(el.type));
  return textual ? { key: `${el.tagName}#${el.id}|${el.getAttribute("name") ?? ""}|${el.getAttribute("placeholder") ?? ""}`, value: el.value } : null;
});

const lastAction = extract((s) => s.lastAction);

// ---------------------------------------------------------------------------------------------
// Properties.

// Properties and action filters run in Bombadil's own JavaScript runtime, which has no `URL`
// global (extractors run in the page and do). A throw there reads as a violation, so use a regex.
const localHost = (u: string) => u === "about:blank" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);

/** The run never leaves this machine. `--allow-url` already bounds exploration; this checks it held. */
export const staysOnLocalhost = always(() => localHost(url.current));

/** No error boundary, Next.js error overlay or "N Issues" indicator. */
export const noErrorScreens = always(() => {
  const e = pageError.current;
  return !e.overlayOpen && e.issues === null && e.boundary === null;
});

/** An archived record leaves its list within a few seconds and never comes back. */
export const archivedStayArchived = always(() => {
  const list = listed.current;
  if (!list) return true;
  const returned = archived.current.filter((a) => a.path === list.path && list.names.includes(a.name));
  if (!returned.length) return true;
  return eventually(() => {
    const later = listed.current;
    return !later || !returned.some((a) => a.path === later.path && later.names.includes(a.name));
  }).within(5, "seconds");
});

/** The list summary agrees with the rows on screen once the page settles. */
export const listCountsConsistent = always(() => {
  const c = counts.current;
  const ok = (v: typeof c) => !v || (v.shown <= v.loaded && v.loaded <= v.total && v.rows === v.shown);
  if (ok(c)) return true;
  return eventually(() => ok(counts.current)).within(5, "seconds");
});

/** Text typed into a focused field is still in that field in the next state. */
export const typedTextKept = always(() => {
  const a = lastAction.current;
  const f = focused.current;
  if (!a || typeof a !== "object" || !("TypeText" in a) || !f) return true;
  return now(() => f.value.includes(String(a.TypeText.text)));
});

// ---------------------------------------------------------------------------------------------
// Actions. Default clicks and inputs, minus the dev tooling and anything that undoes an archive
// or signs out; plus one action that archives a random visible record and records its name.

const blocked = /^(Open Next\.js Dev Tools|Undo|Restore.*|Sign out|Log out|Compiling\.\.\.)$/;
const allowed = (action: ActionTemplate) => {
  if (typeof action !== "object" || !("Click" in action)) return true;
  const fp = action.Click.fingerprint;
  const label = fp.accessibleName ?? fp.textContent ?? "";
  if (blocked.test(label.trim())) return false;
  // Links off this machine. `--allow-url` stops the navigation; this avoids wasting the step.
  return !fp.href || fp.href.startsWith("/") || fp.href.startsWith("#") || localHost(fp.href);
};

const archiveOne = registerCustomAction("archiveOne", async (document, window, pick: number) => {
  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  const path = window.location.pathname;
  const boxes = [...document.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox][aria-label^='Select ']")];
  if (!boxes.length) return;
  for (const box of boxes) if (box.checked) box.click();
  const box = boxes[pick % boxes.length];
  const name = (box.getAttribute("aria-label") ?? "").slice("Select ".length);
  box.click();
  await wait(300);
  const find = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
  find(/^\s*Archive 1\s*$/)?.click();
  await wait(300);
  const confirm = find(/^\s*Confirm archive 1\s*$/);
  if (!confirm) return;
  const list = JSON.parse(window.localStorage.getItem("bombadil:archived") ?? "[]");
  list.push({ path, name });
  window.localStorage.setItem("bombadil:archived", JSON.stringify(list));
  confirm.click();
  await wait(1500);
});

const onList = () => listed.current !== null && listed.current.names.length > 0;

/** Visit the record lists often enough for the domain properties to matter. */
const goToList = registerCustomAction("goToList", async (_document, window, which: number) => {
  const paths = ["/dashboard/accounts", "/dashboard/contacts", "/dashboard/deals", "/dashboard"];
  window.location.assign(paths[which % paths.length]);
});

export const canonActions = weighted([
  [20, clicks.filter(allowed)],
  [6, inputs],
  [3, scroll],
  [2, back],
  [1, reload],
  [2, actions(() => [0, 1, 2, 3].map((i) => goToList(i)))],
  [1, actions(() => (onList() ? [0, 1, 2, 3, 4, 5].map((i) => archiveOne(i)) : []))],
]);
