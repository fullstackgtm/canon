/**
 * Salesforce sync dashboard specs (Phase 1b, workstream D).
 *
 * Runs against `next dev` started with NEXT_PUBLIC_SF_SYNC_FAKE=1 and no Clerk
 * key (dev-mode auth bypass), so the pages read the in-memory fake store
 * instead of the A/B/C Convex functions:
 *
 *   NEXT_PUBLIC_SF_SYNC_FAKE=1 npx next dev -p 3917 &
 *   SF_SYNC_E2E_BASE_URL=http://localhost:3917 npx playwright test e2e/salesforce-sync.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: process.env.SF_SYNC_E2E_BASE_URL ?? "http://localhost:3917" });
test.setTimeout(120_000);

const BASE = "/dashboard/integrations/salesforce";

async function open(page: Page, path = "") {
  await page.goto(`${BASE}${path}`);
  await expect(page.getByRole("heading", { level: 1, name: "Salesforce" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Fake data")).toBeVisible();
}

test("connection page shows the org, and no write-back controls: the sync is read-only", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("sf-org-name")).toHaveText("Example Dev Org");
  await expect(page.getByRole("switch", { name: "Read-only mode" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Conflicts" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Field authority" })).toHaveCount(0);
});

test("import page shows progress, rejections and starts a new import", async ({ page }) => {
  await open(page, "/import");
  await expect(page.getByTestId("sf-import-status")).toHaveText("completed");
  await expect(page.getByTestId("sf-import-row-Account")).toContainText("9,950");
  await expect(page.getByTestId("sf-rejected")).toContainText("no Website or domain");
  await expect(page.getByTestId("sf-object-Project__c")).toContainText("Custom");

  await page.getByRole("checkbox", { name: "Sync Project__c" }).check();
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByTestId("sf-import-row-Project__c")).toBeVisible();
  await expect(page.getByTestId("sf-import-status")).toHaveText("completed");
  await expect(page.getByTestId("sf-import-row-Project__c")).toContainText("340");
  await expect(page.getByTestId("sf-rejected")).toContainText("No rejected records");
});

test("integrations page links to the sync dashboard", async ({ page }) => {
  await page.goto("/dashboard/integrations");
  await page.getByTestId("integration-row-salesforce").click({ timeout: 90_000 });
  await page.getByTestId("integration-open-salesforce").click();
  await expect(page).toHaveURL(new RegExp(`${BASE}$`));
});
