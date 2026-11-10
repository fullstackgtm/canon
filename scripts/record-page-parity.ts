/**
 * The parity lever for the account and contact pages (docs/recipes.md, "Record pages"). It opens every account and
 * contact of a running local stack in a headless browser and lists, section by section, the fields and controls each
 * shows: buttons, links, selects, inputs and folds, with their names and whether they're disabled. Capture on the base
 * commit, capture again on the change, and compare the two. An account had two pages before they merged, so its base
 * is both pages together: a section either page showed must show on the merged one, with the same fields and controls.
 *
 *   node --experimental-strip-types scripts/record-page-parity.ts capture --url http://localhost:<port> --out before.json
 *   node --experimental-strip-types scripts/record-page-parity.ts compare before.json after.json
 *
 * `PLAYWRIGHT` names the playwright package to load (default /tmp/pw/node_modules/playwright), and `CHROME` the browser
 * (default Playwright's cached Chromium). Exits 1 when a page differs other than as INTENDED lists.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

type Section = { heading: string; fields: string[]; controls: string[] };
/** One record's page as the browser shows it: its back link, its title row's controls and its sections in order. */
type PageCapture = { url: string; frame: string[]; header: string[]; sections: Section[] };
type Capture = { at: string; pages: Record<string, PageCapture[]> };

/**
 * What the merge changes on purpose, by record kind: a section or header control the base showed and the merged page
 * doesn't, or one it adds. Anything else that differs is a regression.
 */
const INTENDED: Record<"account" | "contact", { gone: Record<string, string>; added: Record<string, string> }> = {
  account: {
    gone: {
      "section Firmographics": "its five fields are edited in place under Details, which lists every account field",
      "header a \"Fit and score on the Accounts page\"": "the fit and score are on the one page now",
      "frame a \"TAM\"": "one back link, to the Accounts list",
      "frame a \"Companies\"": "one back link, to the Accounts list",
    },
    added: {
      "frame a \"Accounts\"": "the back link to the Accounts list, which the nav names Accounts",
      "header button \"Archive\"": "Archive came to both pages in #464, after the base this was first run on (9014e65d)",
    },
  },
  contact: { gone: {}, added: { "header button \"Archive\"": "Archive came to the page in #464, after the base this was first run on (9014e65d)" } },
};

const PAGES = { account: ["/dashboard/accounts/", "/dashboard/records/account/"], contact: ["/dashboard/records/contact/"] } as const;
const LISTS = { account: "/dashboard/records/account", contact: "/dashboard/records/contact" } as const;

/** Runs in the page: the record page's back link, title row and cards, each with its fields and controls. */
function readPage(): Omit<PageCapture, "url"> | null {
  const h1 = document.querySelector("h1");
  const root = h1?.closest("div.p-4") as HTMLElement | null;
  if (!h1 || !root) return null;
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const nameOf = (el: Element) => clean(el.getAttribute("aria-label") ?? (el.tagName === "SELECT" ? "" : el.textContent ?? ""));
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute("role") === "combobox" ? "select" : tag === "input" ? `input[${el.getAttribute("type") ?? "text"}]` : tag;
    return `${kind} "${nameOf(el)}"${(el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" ? " disabled" : ""}`;
  };
  const CONTROL = "button, a[href], summary, select, input, textarea";
  const cards = [...root.querySelectorAll("section, details")].filter((el) => !el.parentElement?.closest("section, details"));
  const inCard = (el: Element) => cards.some((c) => c.contains(el));
  // The title row: the block holding the title, and the controls beside it.
  const header = h1.parentElement!.parentElement!;
  return {
    frame: [...root.querySelectorAll(CONTROL)].filter((el) => !header.contains(el) && !inCard(el)).map(describe),
    header: [`title "${clean(h1.textContent ?? "")}"`, ...[...header.querySelectorAll(CONTROL)].filter((el) => !inCard(el)).map(describe)],
    sections: cards.map((card) => ({
      heading: clean(card.querySelector("h2, summary")?.textContent ?? "(untitled)"),
      fields: [...card.querySelectorAll("dt")].map((dt) => clean(dt.textContent ?? "")),
      controls: [...card.querySelectorAll(CONTROL)].map(describe),
    })),
  };
}

async function capture(url: string, out: string) {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? "/tmp/pw/node_modules/playwright/index.mjs");
  const chrome = process.env.CHROME ?? `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  const browser = await chromium.launch({ executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const result: Capture = { at: new Date().toISOString(), pages: {} };
  try {
    for (const kind of ["account", "contact"] as const) {
      await page.goto(url + LISTS[kind], { waitUntil: "networkidle", timeout: 120_000 });
      const link = kind === "account" ? "a[href*='/accounts/'], a[href*='/records/account/']" : "a[href*='/records/contact/']";
      await page.waitForSelector(link, { timeout: 60_000 });
      const ids: string[] = await page.$$eval(link, (as: Element[]) => [...new Set(as.map((a) => decodeURIComponent(a.getAttribute("href")!.split("/").at(-1)!)))]);
      for (const id of ids) {
        const pages: PageCapture[] = [];
        let title = id;
        for (const prefix of PAGES[kind]) {
          await page.goto(url + prefix + encodeURIComponent(id), { waitUntil: "networkidle", timeout: 120_000 });
          let last = "", read: Omit<PageCapture, "url"> | null = null;
          // A page fills in as its actions answer: read it until two reads a second apart agree.
          for (let i = 0; i < 30; i++) {
            await page.waitForTimeout(1000);
            read = await page.evaluate(readPage);
            const now = JSON.stringify(read);
            if (read && now === last && !now.includes("Loading")) break;
            last = now;
          }
          if (!read) throw new Error(`${prefix}${id} showed no record`);
          title = read.header[0];
          pages.push({ url: new URL(page.url()).pathname, ...read });
        }
        result.pages[`${kind} ${title}`] = pages;
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${Object.keys(result.pages).length} records, ${Object.values(result.pages).flat().length} pages captured to ${out}`);
}

/** A record's pages as one: each section once, by heading, the first page's first; and every frame and header control. */
function union(pages: readonly PageCapture[]): PageCapture {
  const sections: Section[] = [];
  for (const s of pages.flatMap((p) => p.sections)) if (!sections.some((x) => x.heading === s.heading)) sections.push(s);
  const all = (pick: (p: PageCapture) => string[]) => [...new Set(pages.flatMap(pick))];
  return { url: pages.map((p) => p.url).join(" + "), frame: all((p) => p.frame), header: all((p) => p.header), sections };
}

function compare(beforeFile: string, afterFile: string) {
  const before = JSON.parse(readFileSync(beforeFile, "utf8")) as Capture;
  const after = JSON.parse(readFileSync(afterFile, "utf8")) as Capture;
  let differ = 0, same = 0, intended = 0, controls = 0;
  const intendedSeen = new Set<string>();
  for (const [key, basePages] of Object.entries(before.pages)) {
    const kind = key.split(" ")[0] as keyof typeof INTENDED;
    const allowed = INTENDED[kind];
    const a = union(basePages);
    const headPages = after.pages[key];
    if (!headPages) { differ++; console.log(`${key}: missing from ${afterFile}`); continue; }
    const b = union(headPages);
    const note = (what: string, gone: boolean) => {
      const why = (gone ? allowed.gone : allowed.added)[what];
      if (why) { intended++; intendedSeen.add(`${kind}: ${gone ? "dropped" : "added"} ${what}: ${why}`); return; }
      differ++;
      console.log(`${key}: ${gone ? "lost" : "gained"} ${what}`);
    };
    for (const part of ["frame", "header"] as const) {
      for (const c of a[part]) if (!b[part].includes(c)) note(`${part} ${c}`, true); else { same++; controls++; }
      for (const c of b[part]) if (!a[part].includes(c)) note(`${part} ${c}`, false);
    }
    for (const s of a.sections) {
      const t = b.sections.find((x) => x.heading === s.heading);
      if (!t) { note(`section ${s.heading}`, true); continue; }
      controls += s.controls.length;
      if (JSON.stringify([s.fields, s.controls]) === JSON.stringify([t.fields, t.controls])) { same++; continue; }
      differ++;
      console.log(`${key} · ${s.heading}\n  before: ${[...s.fields.map((f) => `dt "${f}"`), ...s.controls].join(" | ")}\n  after:  ${[...t.fields.map((f) => `dt "${f}"`), ...t.controls].join(" | ")}`);
    }
    for (const t of b.sections) if (!a.sections.some((s) => s.heading === t.heading)) note(`section ${t.heading}`, false);
  }
  for (const line of intendedSeen) console.log(`intended · ${line}`);
  console.log(`\n${Object.keys(before.pages).length} records: ${same} sections and controls the same, ${differ} differ, ${intended} intended changes; ${controls} controls compared.`);
  if (differ) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest[rest.indexOf(name) + 1];
if (cmd === "capture") await capture(flag("--url").replace(/\/$/, ""), flag("--out"));
else if (cmd === "compare") compare(rest[0], rest[1]);
else {
  console.error("usage: record-page-parity.ts capture --url <app url> --out <file> | compare <before> <after>");
  process.exit(2);
}
