import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Fluxbill" })).toBeVisible();
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name, exact: true }).click();

test("demo sends a usage event and shows totals", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("Protected public demo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Organization" })).toContainText("Acme Analytics");
  await expect(page.getByText("Hourly totals")).toBeVisible();
  await page.getByRole("button", { name: "Send usage event" }).click();
  await expect(page.getByRole("list", { name: "Recent simulator calls" })).toContainText("accepted", { timeout: 45_000 });

  await nav(page, "Billing");
  await expect(page.getByText("This month")).toBeVisible();
  await expect(page).toHaveURL(/section=billing/);
});

test("replaying an idempotency key is a duplicate", async ({ page }) => {
  await signIn(page);
  await page.getByText("Reuse idempotency key").click();
  await page.getByRole("radio", { name: "×5" }).click();
  await page.getByRole("button", { name: "Send 5 usage events" }).click();
  await expect(page.getByText("1 accepted · 4 duplicate")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent simulator calls" }).getByText("duplicate")).toHaveCount(4);
});

test("themed dropdowns are keyboard operable", async ({ page }) => {
  await signIn(page);
  const trigger = page.getByRole("button", { name: "Simulator metric" });
  await expect(trigger).toHaveText("API requests");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const listbox = page.getByRole("listbox", { name: "Simulator metric" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option", { name: "API requests" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(trigger).toHaveText("AI tokens");
  await expect(trigger).toBeFocused();
});

test("event explorer opens a trace", async ({ page }) => {
  await signIn(page);
  await nav(page, "Events");
  await expect(page.getByText("Event explorer")).toBeVisible();
  await page.locator("tbody tr").first().click();
  const drawer = page.getByRole("dialog", { name: "Event trace" });
  await expect(drawer).toContainText("Pipeline timeline");
  await expect(drawer).toContainText(/accepted/i);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("mobile navigation remains keyboard and touch accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
  await nav(page, "Events");
  await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
});
