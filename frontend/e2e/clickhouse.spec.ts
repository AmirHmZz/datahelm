import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
test.skip(
  process.env.DATAHELM_CLICKHOUSE_E2E !== "1",
  "Requires the disposable ClickHouse fixture runner",
);
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
test("ClickHouse connection, catalog, access actions, and engine switching", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill(readFileSync(process.env.DATAHELM_E2E_PASSWORD_FILE!, "utf8").trim());
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await select(page, "Database engine", "ClickHouse");
  await page.getByLabel("Connection name").fill("Browser ClickHouse");
  await page.getByLabel("HTTP(S) endpoint").fill("http://clickhouse:8123");
  await page.getByLabel("Username", { exact: true }).fill("operator");
  await page.getByLabel("Password", { exact: true }).fill("datahelm-test-only");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByText(/Connection successful/)).toBeVisible();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser ClickHouse", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit connection", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Database engine" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByText(/Connection successful/)).toBeVisible();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Databases", exact: true }).click();
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await page.getByRole("option", { name: /^fixture ·/ }).click();
  await page.getByRole("button", { name: "records", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Columns · fixture.records" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Users & roles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Role name").fill("browser_role");
  await dialog
    .getByRole("button", { name: "Create role", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username", { exact: true }).fill("browser_user");
  await dialog.getByLabel(/^Password/).fill("browser-password");
  await dialog
    .getByRole("button", { name: "Create user", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await select(page, "Assign role", "browser_role");
  await page.getByRole("button", { name: "Assign role", exact: true }).click();
  await expect(page.getByText("Role assigned", { exact: true })).toBeVisible();
  await page
    .getByLabel("New password", { exact: true })
    .fill("browser-new-password");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Password changed");
  await page.getByRole("button", { name: "Delete user", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm change" })
    .click();
  await expect(
    page.getByRole("button", { name: "browser_user", exact: true }),
  ).toHaveCount(0);
  for (const name of ["Operations", "Query history", "Topology"])
    await page.getByRole("button", { name, exact: true }).click();
  // A saved MongoDB connection must render its own views, even after ClickHouse access pages.
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await page.getByLabel("Connection name").fill("Browser MongoDB offline");
  await page.getByLabel("Hosts and ports").fill("127.0.0.1:1");
  await page.getByLabel("Collect server metrics every five seconds").uncheck();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByText("MongoDB control center", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Slow queries", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Browser ClickHouse.*ClickHouse ·/ })
    .click();
  await expect(
    page.getByText("ClickHouse control center", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
