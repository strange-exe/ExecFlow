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

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  // Three engines at full parallelism starved Firefox's software compositor on this PC (Socials, 2026-10-12).
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: { baseURL: ORIGIN },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // Tests run against the production build: the CSP, service worker and precache only exist there.
  webServer: {
    command: OUT_DIR ? `npx vite build --outDir ${OUT_DIR} && ${serve} --outDir ${OUT_DIR}` : `npm run build && ${serve}`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
