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

test("connection page shows org and sync state", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("sf-org-name")).toHaveText("Example Dev Org");
  await expect(page.getByTestId("sf-sync-mode")).toContainText("Polling every 15s");
  await expect(page.getByTestId("sf-readonly-status")).toHaveText("Off");
});

test("read-only toggle flips state and shows banner", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("sf-readonly-banner")).toHaveCount(0);
  await page.getByRole("switch", { name: "Read-only mode" }).click();
  await expect(page.getByTestId("sf-readonly-status")).toHaveText("On");
  await expect(page.getByTestId("sf-readonly-banner")).toBeVisible();
  // Banner persists across sync sections (client-side nav keeps the store).
  await page.getByRole("link", { name: "Conflicts" }).click();
  await expect(page.getByTestId("sf-readonly-banner")).toBeVisible();
  const readOnly = await page.evaluate(
    () => (window as any).__sfSyncFake.getState().syncState.readOnly,
  );
  expect(readOnly).toBe(true);
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

test("field authority editor updates syncAuthority", async ({ page }) => {
  await open(page, "/fields");
  const industry = page.getByLabel("Authority for Industry");
  await expect(industry).toHaveValue("review");
  await industry.selectOption("salesforce");
  await expect(industry).toHaveValue("salesforce");
  // Non-updateable fields can only be owned by Salesforce.
  await expect(
    page.getByLabel("Authority for SystemModstamp").locator('option[value="fsgtm"]'),
  ).toBeDisabled();

  await page.getByLabel("Object").selectOption("Contact");
  await expect(page.getByTestId("sf-field-Email")).toBeVisible();
  await expect(page.getByTestId("sf-field-Industry")).toHaveCount(0);
});

test("conflict review queue resolves conflicts", async ({ page }) => {
  await open(page, "/conflicts");
  const c1 = page.getByTestId("sf-conflict-c1");
  await expect(c1.getByTestId("fsgtm-value")).toHaveText("Software");
  await expect(c1.getByTestId("sf-value")).toHaveText("Technology");
  await c1.getByRole("button", { name: "Keep Salesforce" }).click();
  await expect(c1).toHaveCount(0);

  const c2 = page.getByTestId("sf-conflict-c2");
  await c2.getByLabel("Custom value for Title").fill("SVP, Sales");
  await c2.getByRole("button", { name: "Use custom" }).click();
  await expect(page.getByTestId("sf-conflicts-empty")).toBeVisible();

  await page.getByRole("tab", { name: "Resolved" }).click();
  await expect(page.getByTestId("sf-conflict-c1")).toContainText("Resolved: salesforce");
  await expect(page.getByTestId("sf-conflict-c2")).toContainText("Resolved: custom");
});

test("integrations page links to the sync dashboard", async ({ page }) => {
  await page.goto("/dashboard/integrations");
  await page.getByTestId("integration-row-salesforce").click({ timeout: 90_000 });
  await page.getByTestId("integration-open-salesforce").click();
  await expect(page).toHaveURL(new RegExp(`${BASE}$`));
});
