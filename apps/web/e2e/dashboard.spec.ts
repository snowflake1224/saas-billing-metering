import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Fluxbill" })).toBeVisible();
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name, exact: true }).click();

test("protected demo tells the metering story across dashboard sections", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("Protected public demo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Organization" })).toContainText("Acme Analytics");
  await expect(page.getByLabel("System health")).toContainText("Postgres");
  await expect(page.getByText("Tenant isolation")).toBeVisible();
  await page.getByRole("button", { name: "Send usage event" }).click();
  await expect(page.getByRole("list", { name: "Recent simulator calls" })).toContainText("accepted", { timeout: 45_000 });

  await nav(page, "Pipeline");
  await expect(page.getByText("Event flow")).toBeVisible();
  await expect(page.getByText("Delivery guarantees")).toBeVisible();

  await nav(page, "Members");
  await expect(page.getByText("Workspace members")).toBeVisible();
  await expect(page.getByText("Maya Chen")).toBeVisible();
  await expect(page.getByText("Management controls are intentionally read-only")).toBeVisible();

  await nav(page, "Teams");
  await expect(page.getByRole("heading", { name: "Platform" })).toBeVisible();

  await nav(page, "Billing");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  await expect(page.getByText("What-if cost estimator")).toBeVisible();

  await nav(page, "Admin");
  await expect(page.getByText("Entitlement overrides")).toBeVisible();
  await expect(page.getByText("Queue is clear")).toBeVisible();
  await expect(page).toHaveURL(/section=admin/);
});

test("themed dropdowns are keyboard operable", async ({ page }) => {
  await signIn(page);
  await nav(page, "Usage");
  const trigger = page.getByRole("button", { name: "Focus metric" });
  await expect(trigger).toHaveText("API requests");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const listbox = page.getByRole("listbox", { name: "Focus metric" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option", { name: "API requests" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(trigger).toHaveText("AI tokens");
  await expect(trigger).toBeFocused();
});

test("simulator bursts demonstrate idempotent deduplication", async ({ page }) => {
  await signIn(page);
  await page.getByText("Reuse idempotency key").click();
  await page.getByRole("radio", { name: "×5" }).click();
  await page.getByRole("button", { name: "Send 5 usage events" }).click();
  await expect(page.getByText("1 accepted · 4 duplicate")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent simulator calls" }).getByText("duplicate")).toHaveCount(4);
});

test("event explorer opens a pipeline trace", async ({ page }) => {
  await signIn(page);
  await nav(page, "Events");
  await expect(page.getByText("Event explorer")).toBeVisible();
  await page.locator("tbody tr").first().click();
  const drawer = page.getByRole("dialog", { name: "Event trace" });
  await expect(drawer).toContainText("Pipeline timeline");
  await expect(drawer).toContainText(/accepted/i);
  await expect(drawer).toContainText("curl -X GET");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("API playground sends authenticated requests", async ({ page }) => {
  await signIn(page);
  await nav(page, "API");
  await page.getByRole("button", { name: "Endpoint" }).click();
  await page.getByRole("option", { name: /GET \/health/ }).click();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(/x-request-id:/)).toBeVisible();
  await expect(page.getByRole("list").filter({ hasText: "/health" })).toContainText("200");
});

test("mobile navigation remains keyboard and touch accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
  await nav(page, "Usage");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
});
