import { PAGE_OBJECTS } from "./blocks.ts";
import { NAV_ICONS } from "../modules/kernel/manifest.ts";
export { NAV_ICONS as PAGE_ICONS };
export const RESERVED_PAGE_SLUGS = [...PAGE_OBJECTS, "consolidate", "imports", "conversations", "market", "facts", "abm", "account-hierarchy", "accounts", "agents", "audiences", "automations", "cadences", "canon-fields", "cli-auth", "contacts", "customization", "dashboards", "deals", "duplicates", "fields", "health", "icps", "integrations", "leads", "linkedin", "m", "notes", "p", "patch-plans", "pipelines", "plays", "products", "records", "reports", "revenue", "runs", "settings", "tasks"];
export const validPageSlug = (slug: string) => slug.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && !RESERVED_PAGE_SLUGS.includes(slug);
