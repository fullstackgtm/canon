import type { CompanyFinding } from "./startingPlan.ts";

type Page = { text: string; finalUrl: string };
type Brand = NonNullable<CompanyFinding["brand"]>;

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(
      (m) => [
        m[1].toLowerCase(),
        (m[2] ?? m[3] ?? m[4]).replace(/&amp;/g, "&"),
      ],
    ),
  );
}

export function imageUrl(
  value: string | undefined,
  base: string,
): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value, base);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.href.length <= 2000
    )
      return url.href;
  } catch {
    /* Unreadable website assets are optional. */
  }
}

function* customerSections(html: string): Generator<string> {
  const stack: Array<{ tag: string; start: number; marked: boolean }> = [];
  for (const match of html.matchAll(/<\/?(section|div)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    if (!match[0].startsWith("</")) {
      stack.push({
        tag,
        start: match.index,
        marked: /customer|trusted|clients|case-stud|logo-wall|logo-cloud/i.test(
          match[0],
        ),
      });
    } else if (stack.at(-1)?.tag === tag) {
      const open = stack.pop()!;
      const end = match.index + match[0].length;
      if (open.marked && end - open.start <= 16000)
        yield html.slice(open.start, end);
    }
  }
}

export async function discoverBrand(
  page: Page,
  fetchPage: (url: string) => Promise<Page | null>,
): Promise<Brand> {
  const html = page.text.slice(0, 1_000_000);
  const tags = [...html.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map((m) =>
    attributes(m[0]),
  );
  const header = html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] ?? "";
  const images = (text: string) =>
    [...text.matchAll(/<img\b[^>]*>/gi)].map((m) => attributes(m[0]));
  const logo = images(header).find((a) =>
    /logo/i.test(`${a.alt} ${a.src} ${a.class}`),
  );
  const icon =
    tags.find((a) => /apple-touch-icon/i.test(a.rel ?? "")) ??
    tags.find((a) => /(?:^|\s)icon(?:\s|$)/i.test(a.rel ?? ""));
  const og = tags.find((a) => a.property?.toLowerCase() === "og:image");
  const brand: Brand = { customers: [], sourceUrl: page.finalUrl };
  brand.logoUrl = imageUrl(logo?.src ?? icon?.href, page.finalUrl);
  const color = tags.find(
    (a) => a.name?.toLowerCase() === "theme-color",
  )?.content;
  if (color && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(color)) brand.color = color;
  if (!brand.logoUrl) {
    const manifest = imageUrl(
      tags.find((a) => a.rel === "manifest")?.href,
      page.finalUrl,
    );
    if (manifest) {
      const result = await fetchPage(manifest).catch(() => null);
      try {
        const data: unknown = result && JSON.parse(result.text);
        if (
          data &&
          typeof data === "object" &&
          "icons" in data &&
          Array.isArray(data.icons)
        ) {
          for (const icon of data.icons) {
            if (icon && typeof icon.src === "string")
              brand.logoUrl = imageUrl(icon.src, result!.finalUrl);
            if (brand.logoUrl) break;
          }
        }
      } catch {
        /* Invalid manifests leave the favicon fallback available. */
      }
    }
  }
  brand.logoUrl ??= imageUrl(og?.content, page.finalUrl);
  for (const section of customerSections(html)) {
    for (const img of images(section)) {
      const name = img.alt?.replace(/\s*logo\s*/gi, " ").trim();
      const url = imageUrl(img.src ?? img["data-src"], page.finalUrl);
      if (
        !name ||
        name.length > 80 ||
        /^(customer|client|partner|image)s?$/i.test(name) ||
        !url ||
        url === brand.logoUrl ||
        brand.customers.some((c) => c.name === name)
      )
        continue;
      brand.customers.push({ name, logoUrl: url });
      if (brand.customers.length >= 12) return brand;
    }
  }
  return brand;
}
