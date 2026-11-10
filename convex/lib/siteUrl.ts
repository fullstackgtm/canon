export function siteUrl(): string {
  return (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://canoncrm.com").trim().replace(/\/+$/, "");
}
