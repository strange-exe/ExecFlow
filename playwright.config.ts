import { defineConfig, devices } from "@playwright/test";

// Its own port: Pocket Run's suite uses 4317/4318 on this machine. PW_PORT and PW_OUTDIR let several
// runs happen at once (each serves its own build folder); they skip the prebuild runtime copies,
// which must already be in public/.
const PORT = Number(process.env.PW_PORT ?? 4327);
const OUT_DIR = process.env.PW_OUTDIR;
// One explicit address: on Windows `vite preview` listens on [::1] only, and Firefox now and then
// tried 127.0.0.1 for "localhost" and got "connection refused" mid-run.
const ORIGIN = `http://127.0.0.1:${PORT}`;
const serve = `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`;
/**
 * The move to a new address (src/ui/address-move.ts) needs two origins: the build under test treats
 * http://localhost:<port> as the OLD address and the suite's own http://127.0.0.1:<port> as the NEW
 * one, so every other test runs where no move notice shows (e2e/move.spec.ts).
 */
export const MOVE_FROM = `http://localhost:${PORT}`;
export const MOVE_TO = ORIGIN;
/**
 * The typing-speed test measures typing latency and main-thread work (a lab INP estimate, and long
 * tasks against suggestions off), so it runs alone: in its own project, after every test of the
 * three engines has finished (dependencies), never next to them (e2e/speed.spec.ts).
 * Playwright doesn't run a project whose dependencies had a failing test, and naming the spec or
 * the project runs those dependencies first (playwright.dev/docs/test-projects); to run it by
 * itself: npm run e2e:speed (--project=speed --no-deps)
 */
const SPEED = /speed\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  // Three engines at full parallelism starved Firefox's software compositor on this PC (Socials, 2026-10-12).
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: { baseURL: ORIGIN },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: SPEED },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: SPEED },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: SPEED },
    { name: "speed", use: { ...devices["Desktop Chrome"] }, testMatch: SPEED, dependencies: ["chromium", "firefox", "webkit"] },
  ],
  // Tests run against the production build: the CSP, service worker and precache only exist there.
  webServer: {
    command: OUT_DIR ? `npx vite build --outDir ${OUT_DIR} && ${serve} --outDir ${OUT_DIR}` : `npm run build && ${serve}`,
    url: ORIGIN,
    env: { MOVE_FROM, MOVE_TO },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
