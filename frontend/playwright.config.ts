import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.DATAHELM_E2E_URL || "http://localhost:8080",
    channel: process.env.DATAHELM_E2E_BROWSER || "chrome",
    viewport: { width: 1500, height: 1050 },
    screenshot: "only-on-failure",
    trace: "off",
  },
  reporter: "list",
});
