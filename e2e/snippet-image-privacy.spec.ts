// Capture snippet under Firefox's fingerprinting protection (.claude/design/snippet-image/final-v3.md
// e2e 27, F5): with privacy.resistFingerprinting on, canvas reads may return placeholder bytes. A
// download from a ready preview either is the real image (its ground pixel is --bg) or refuses with
// the privacy text; it is never a PNG of placeholder pixels. Light scheme only: the protection also
// reports prefers-color-scheme as light. Its blocked-extraction line is a console warning, not an
// error, so nothing is tolerated here.
import { readFileSync } from "node:fs";
import { expect, test } from "./helpers";
import { CARD_AT, decodeRgba, dialogOf, matOf, off, openFromFileMenu, openWith, previewReady, selectFixtureLines, tokens } from "./snippet-helpers";

test.skip(({ browserName }) => browserName !== "firefox", "privacy.resistFingerprinting is a Firefox preference");
test.use({ serviceWorkers: "block", launchOptions: { firefoxUserPrefs: { "privacy.resistFingerprinting": true } } });

test("27: with resist-fingerprinting, Download gives the real image or the privacy refusal, never placeholder pixels", async ({ page }, info) => {
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, /^Capture snippet of main\.py, lines 2 to 3\.\.\./);
  await previewReady(page);
  const t = await tokens(page);
  const app = page.locator("#app");
  const before = Number((await app.getAttribute("data-captures")) ?? 0);
  const download = page.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
  await dialogOf(page).getByRole("button", { name: "Download (.png)" }).click();
  await expect(app).toHaveAttribute("data-captures", String(before + 1));
  const outcome = await app.getAttribute("data-capture");
  info.annotations.push({ type: "27 outcome", description: `${outcome} ${(await app.getAttribute("data-capture-reason")) ?? ""}` });
  if (outcome === "downloaded") {
    const d = await download;
    expect(d, "the download arrived").not.toBeNull();
    const px = decodeRgba(readFileSync((await d!.path())!));
    // Round 2's default image: the card's ground inside the medium background, and the background itself.
    const g = CARD_AT + 10;
    expect(off(px.at(g, g), t.bg), "the ground pixel is --bg, not a placeholder").toBeLessThanOrEqual(2);
    expect(px.at(g, g)[3]).toBe(255);
    expect(off(px.at(10, 10), matOf(t)), "the background pixel is the background, not a placeholder").toBeLessThanOrEqual(2);
    expect(px.at(10, 10)[3]).toBe(255);
  } else {
    expect(outcome).toBe("failed");
    await expect(app).toHaveAttribute("data-capture-reason", "privacy");
    await expect(dialogOf(page).locator("#snippet-status")).toHaveText("This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.");
  }
});
