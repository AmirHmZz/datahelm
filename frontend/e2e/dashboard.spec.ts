import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
test("change the disposable administrator password through the dashboard", async ({
  page,
}) => {
  test.skip(
    process.env.DATAHELM_TEST_INTERNAL_NETWORK !== "1",
    "Password mutations require the disposable fixture runner",
  );
  const file = process.env.DATAHELM_E2E_PASSWORD_FILE!;
  const oldPassword = readFileSync(file, "utf8").trim();
  const password = randomBytes(24).toString("base64url");
  await page.goto("/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Change password",
    exact: true,
  });
  await dialog.getByLabel("Current password").fill(oldPassword);
  await dialog.getByLabel("New password", { exact: true }).fill(password);
  await dialog.getByLabel("Confirm new password").fill(password);
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Password changed");
  writeFileSync(file, password, { mode: 0o600 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  const oldLogin = await page.request.post("/api/v1/auth/login", {
    data: { username: "admin", password: oldPassword },
  });
  expect(oldLogin.status()).toBe(401);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(
    page.getByRole("button", { name: "Change password", exact: true }),
  ).toBeVisible();
});
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
test("sign in, save a connection, inspect all pages, preserve secrets, and confirm removal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const password = readFileSync(
    process.env.DATAHELM_E2E_PASSWORD_FILE ||
      resolve("../secrets/admin_password"),
    "utf8",
  ).trim();
  await page.goto("/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("button", { name: "light theme" }).click();
  await expect(page.locator("html")).toHaveClass("light");
  await page.getByRole("button", { name: "dark theme" }).click();
  await expect(page.locator("html")).not.toHaveClass("light");
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await page.getByLabel("Connection name").fill("Browser validation");
  await select(page, "Connection method", "Connection URI");
  await page
    .getByLabel(/MongoDB URI/)
    .fill(
      process.env.DATAHELM_E2E_MONGO_URI ||
        "mongodb://admin:datahelm-test-only@localhost:28018/?authSource=admin&directConnection=true",
    );
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByText(/Connection successful/)).toBeVisible({
    timeout: 20000,
  });
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser validation", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".page-heading p")).toContainText("Connected", {
    timeout: 20000,
  });
  for (const label of [
    "Databases",
    "Users & roles",
    "Operations",
    "Slow queries",
    "Topology",
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("main .skeleton")).toHaveCount(0, {
      timeout: 25000,
    });
  }
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".recharts-wrapper").first()).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByText("MongoDB version", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("MongoDB version", { exact: true }).locator(".."),
  ).toContainText(/\d+\.\d+\.\d+/);
  await select(page, "Metrics time range", "Last 6 hours");
  await select(page, "Metrics time range", "Last 30 minutes");
  const chart = page.locator(".chart").first();
  await chart.getByRole("application").click();
  await expect
    .poll(() =>
      chart
        .locator(":focus")
        .evaluate((el) => getComputedStyle(el).outlineStyle),
    )
    .toBe("none");
  // Tabbing onto the chart retains a visible keyboard focus indicator.
  await page.getByRole("combobox", { name: "Metrics time range" }).focus();
  await page.keyboard.press("Tab");
  await expect(chart.getByRole("application")).toBeFocused();
  await expect
    .poll(() => chart.evaluate((el) => getComputedStyle(el).outlineWidth))
    .toBe("2px");
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
  await page
    .getByRole("button", { name: "Edit connection", exact: true })
    .click();
  await expect(page.getByLabel(/MongoDB URI/)).toHaveValue("");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByText(/Connection successful/)).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete connection", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Remove saved connection?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Browser validation", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(page.locator("aside")).toHaveClass(/open/);
  await page.getByRole("button", { name: "light theme" }).click();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("manage users and custom privileges, and toggle node profiling", async ({
  page,
}) => {
  const password = readFileSync(
    process.env.DATAHELM_E2E_PASSWORD_FILE ||
      resolve("../secrets/admin_password"),
    "utf8",
  ).trim();
  await page.goto("/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(
    page.getByRole("heading", { name: "Browser validation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Slow queries", exact: true }).click();
  await select(page, "Profiler database", "browser_fixture");
  await page
    .getByRole("button", { name: "Users & roles", exact: true })
    .click();
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  await page.getByLabel("Role name", { exact: true }).fill("browser_auditor");
  await page
    .getByRole("button", { name: "Add privilege", exact: true })
    .click();
  await select(page, "Database", "browser_fixture");
  await select(page, "Collection", "events");
  await page
    .getByRole("button", { name: "Select actions", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search actions", exact: true })
    .fill("insert");
  await page.getByRole("checkbox", { name: "insert", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove find action", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove insert action", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/privilege-picker.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser_auditor", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("browser_reader");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-fixture-password");
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await select(page, "Role name", "browser_auditor");
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser_reader", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "browser_reader", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("browser_fixture");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Edit browser_reader", exact: true })
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .fill("updated-browser-password");
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delete browser_reader", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete user", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser_reader", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete browser_auditor", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete role", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser_auditor", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Slow queries", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable slow profiling", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Disable profiler", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disable profiler", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable slow profiling", exact: true }),
  ).toBeVisible();
});
