// The ExecFlow wordmark (0.16.0, owner's pick "C. Code + flow", 2026-10-30): beside the mark in every
// page header, "Exec" in the code font and "Flow" in the UI font and the link colour. The link
// still reads as one word, and both halves keep 4.5:1 on the header's ground, light and dark.
// (404.html carries the same markup; its own spec, seo.spec.ts, covers its real 404 status.)
import { expect, openIn, test } from "./helpers";

test.use({ serviceWorkers: "block" });

const PAGES = ["/about", "/c", "/cpp", "/python", "/flowchart-from-code", "/privacy", "/terms"];

for (const scheme of ["light", "dark"] as const) {
  test(`every page header draws the ExecFlow wordmark (${scheme})`, async ({ page }) => {
    for (const path of PAGES) {
      await openIn(page, path, scheme);
      const home = page.locator('header a[href="/"]').filter({ has: page.locator(".wordmark") });
      await expect(home, `${path}: one home link with the wordmark`).toHaveCount(1);
      await expect(home).toHaveAccessibleName("ExecFlow");
      const look = await home.evaluate((a) => {
        const css = (sel: string) => getComputedStyle(a.querySelector(sel)!);
        const rgb = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (fg: string, bg: string) => {
          const [x, y] = [lum(rgb(fg)), lum(rgb(bg))].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        // The ground the wordmark is painted on: the first opaque background up the tree.
        let ground = "rgb(255, 255, 255)";
        for (let e: Element | null = a; e; e = e.parentElement) {
          const bg = getComputedStyle(e).backgroundColor;
          if (!/rgba\(.*, 0\)$|transparent/.test(bg)) {
            ground = bg;
            break;
          }
        }
        const probe = document.createElement("span");
        probe.style.color = "var(--link)";
        a.append(probe);
        const link = getComputedStyle(probe).color;
        probe.remove();
        const exec = css(".wm-exec");
        const flow = css(".wm-flow");
        return {
          execFont: exec.fontFamily,
          flowFont: flow.fontFamily,
          flowIsLink: flow.color === link,
          execRatio: ratio(exec.color, ground),
          flowRatio: ratio(flow.color, ground),
        };
      });
      expect(look.execFont, `${path}: Exec in the code font`).toMatch(/^"?JetBrains Mono/);
      expect(look.flowFont, `${path}: Flow in the UI font`).toMatch(/^"?Geist/);
      expect(look.flowIsLink, `${path}: Flow in --link`).toBe(true);
      expect(look.execRatio, `${path}: Exec contrast`).toBeGreaterThanOrEqual(4.5);
      expect(look.flowRatio, `${path}: Flow contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
