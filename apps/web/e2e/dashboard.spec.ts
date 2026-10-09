import { expect, test } from "@playwright/test";

test("protected demo tells the metering story across dashboard sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Fluxbill" })).toBeVisible();
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Protected public demo")).toBeVisible();
  await expect(page.getByLabel("Organization")).toContainText("Acme Analytics");
  await expect(page.getByText("How this data moves")).toBeVisible();
  await page.getByRole("button", { name: "Send usage event" }).click();
  await expect(page.getByText(/Usage event accepted/)).toBeVisible();

  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("Workspace members")).toBeVisible();
  await expect(page.getByText("Maya Chen")).toBeVisible();
  await expect(page.getByText("Management controls are intentionally read-only")).toBeVisible();

  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByRole("heading", { name: "Platform" })).toBeVisible();

  await page.getByRole("button", { name: "Billing" }).click();
  await expect(page.getByText("Invoices", { exact: true })).toBeVisible();
  await expect(page.getByText("Plan catalog")).toBeVisible();

  await page.getByRole("button", { name: "Admin" }).click();
  await expect(page.getByText("Entitlement overrides")).toBeVisible();
  await expect(page.getByText("Queue is clear")).toBeVisible();
  await expect(page).toHaveURL(/section=admin/);
});

test("mobile navigation remains keyboard and touch accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
});
