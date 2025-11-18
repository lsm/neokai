import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Testing Configuration
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: "./e2e",

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!Deno.env.get("CI"),

  /* Retry on CI only */
  retries: Deno.env.get("CI") ? 2 : 0,

  /* Opt out of parallel tests on CI */
  workers: Deno.env.get("CI") ? 1 : undefined,

  /* Reporter to use */
  reporter: [
    ["html", { outputFolder: "playwright-report" }],
    ["list"],
  ],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL to use in actions like `await page.goto('/')` */
    baseURL: "http://localhost:9283",

    /* Collect trace when retrying the failed test */
    trace: "on-first-retry",

    /* Screenshot on failure */
    screenshot: "only-on-failure",

    /* Video on failure */
    video: "retain-on-failure",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: "deno task dev",
    url: "http://localhost:9283",
    reuseExistingServer: !Deno.env.get("CI"),
    stdout: "ignore",
    stderr: "pipe",
    timeout: 120 * 1000,
  },
});
