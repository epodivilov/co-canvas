import { defineConfig, devices } from "@playwright/test";

/** The Vite dev server binds loopback, and so does the hub each test starts. */
const HOST = "127.0.0.1";
const PORT = 5173;
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Every scenario runs two or three browser contexts against a hub of its own;
  // running several at once on one dev server buys little and costs stability.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --host ${HOST} --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Never reused. This repo is worked on in parallel git worktrees, and a dev
    // server left running by another branch answers on the same port — the
    // suite would then quietly grade a frontend nobody asked it about. A busy
    // port failing the run outright is the cheaper mistake.
    reuseExistingServer: false,
    timeout: 60_000,
    // `import.meta.env.DEV` follows NODE_ENV rather than the command, and the
    // whole suite reads the dev-only inspection handle: a `production` left in
    // the ambient environment would strip it out and fail every scenario on a
    // missing global instead of on anything real.
    env: { NODE_ENV: "development" },
  },
});
