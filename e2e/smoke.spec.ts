import { expect, test } from "@playwright/test";

test("local sign-in opens the dashboard and CRM records render without browser errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/dashboard$/);
  for (const [path, name] of [["accounts", /Accounts|Companies/], ["contacts", /Contacts|People/], ["deals", /Deals|Opportunities/]] as const) {
    await page.goto(`/dashboard/${path}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.locator("tbody .record-name").first()).toBeVisible();
  }
  await page.goto("/dashboard/accounts");
  const record = page.locator('tbody a[href^="/dashboard/accounts/"]').first();
  const name = await record.innerText();
  await record.click();
  await expect(page).toHaveURL(/\/dashboard\/accounts\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  expect(errors).toEqual([]);
});
