import { expect, test } from "@playwright/test";

test("login, navigate sections, and use organization switcher", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Fluxbill" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator("select").first()).toContainText("Acme Analytics");
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Members", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByPlaceholder("New team name")).toBeVisible();
  await page.getByRole("button", { name: "Billing" }).click();
  await expect(page.getByText("Invoices", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Admin" }).click();
  await expect(page.getByText("Entitlement overrides")).toBeVisible();
});
