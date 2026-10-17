import { expect, test } from "./helpers";

test("the page is cross-origin isolated and sends its security headers", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("connect-src 'self' https://api.github.com");
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("worker scripts get a second policy that only allows this site", async ({ request }) => {
  const response = await request.get("/assets/w/missing.js");
  const csp = response.headers()["content-security-policy"] ?? "";
  // Two policies joined with a comma; the worker one has no GitHub.
  const policies = csp.split(",").map((p) => p.trim());
  expect(policies).toHaveLength(2);
  expect(policies[1]).toContain("connect-src 'self';");
  expect(policies[1]).not.toContain("api.github.com");
});
