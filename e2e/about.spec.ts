// The About page (0.7.0, brief .claude/tasks/v07-about.md): served at /about as its own entry; the
// first viewport says what CodeEditor is, for whom, and offers "Open the editor"; the hero's poster
// (a pre-rendered still of the scene) shows at once and the real-time three.js scene replaces it only
// where WebGL works and motion is welcome; the changelog lists every release; light and dark, 320 px,
// keyboard and axe; and the editor's first visit loads nothing of it.
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG } from "../src/about/changelog";
import { olderLabel, olderRange } from "../src/about/timeline";
import { expect, hierarchyShots, openIn, test, tolerating } from "./helpers";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const scene = (page: Page) => page.locator("[data-scene]");

function shotsDir(info: TestInfo): string {
  const dir = process.env.ABOUT_SHOTS ? join(process.env.ABOUT_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe("the About page", () => {
  test.use({ serviceWorkers: "block" });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${vp.name} ${scheme}: the first viewport answers what, who and what next; axe clean; no sideways scroll`, async ({ page }, info) => {
        await page.setViewportSize(vp);
        await openIn(page, "/about", scheme);
        await expect(page).toHaveTitle("About CodeEditor");
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toBeInViewport();
        await expect(page.locator(".about-lede")).toBeInViewport();
        // The lede keeps its own space under the headline (a broader `main p` rule once zeroed it).
        const gap = await page.evaluate(() => document.querySelector(".about-lede")!.getBoundingClientRect().top - document.querySelector("h1")!.getBoundingClientRect().bottom);
        expect(gap).toBeGreaterThanOrEqual(16);
        const open = page.getByRole("link", { name: "Open the editor" }).first();
        await expect(open).toBeInViewport();
        await expect(open).toHaveAttribute("href", "/");
        // The poster is there at once, with its size reserved (no layout shift).
        const poster = page.locator(".about-poster");
        await expect(poster).toBeVisible();
        expect(Number(await poster.getAttribute("width"))).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
        const dir = shotsDir(info);
        await page.screenshot({ path: join(dir, `about-${vp.name}-${scheme}.png`), animations: "disabled" });
        await page.screenshot({ path: join(dir, `about-${vp.name}-${scheme}-full.png`), fullPage: true, animations: "disabled" });
        if (vp.name === "desktop") await hierarchyShots(page, join(dir, `about-${scheme}`));
      });
    }
  }

  for (const [saved, device] of [
    ["dark", "light"],
    ["light", "dark"],
  ] as const) {
    test.describe(() => {
    // The picture first starts on the device's source; page.ts shot() then switches it to the saved
    // theme's, and Firefox aborts the fetch it had started (measured 2026-10-29, 1 run in 6). That
    // cancel of the device's picture is the switch itself, so it alone is excused, here only; the
    // saved theme's picture must still load (asserted below).
    test.use(tolerating(new RegExp(`^request failed: http://127\\.0\\.0\\.1:\\d+/media/about-flowchart-${device}\\.[0-9a-f]+\\.webp NS_BINDING_ABORTED$`)));
    test(`a saved ${saved} theme on a ${device} device shows the ${saved} flowchart screenshot`, async ({ page }) => {
      await page.goto("/about");
      // A fixed theme (Signal Dark or Signal Light), not "match device": theme-boot.js paints it whatever the device says.
      await page.evaluate((scheme) => localStorage.setItem("codeeditor:theme-paint", JSON.stringify({ system: false, scheme, palette: "signal", colors: null })), saved);
      await openIn(page, "/about", device);
      await expect(page.locator("html")).toHaveAttribute("data-theme", saved);
      const shot = page.locator(".about-shot img");
      await shot.scrollIntoViewIfNeeded();
      await expect.poll(() => shot.evaluate((i: HTMLImageElement) => (i.complete ? i.currentSrc : ""))).toContain(`/media/about-flowchart-${saved}.`);
    });
    });
  }

  test("320 px: nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/about");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test("What's new is a timeline of every release, newest first, the latest 3 open, the build's version marked Current", async ({ page }) => {
    await page.goto("/about#changelog");
    const releases = page.locator("#changelog .release");
    // Every release is in the page (find-in-page, screen readers' lists), the older ones folded.
    await expect(releases).toHaveCount(CHANGELOG.length);
    await expect(page.locator("#changelog")).toBeInViewport();
    expect(await releases.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.version))).toEqual(CHANGELOG.map((r) => r.version));
    for (const [n, r] of CHANGELOG.entries()) {
      const item = releases.nth(n);
      // The title is the release's heading (an h3 under the section's h2); its version and date sit
      // beside it. By class, not role: the folded ones are hidden, and roles skip hidden elements.
      const title = item.locator(".release-title");
      await expect(title).toHaveText(r.title);
      expect(await title.evaluate((h) => h.tagName)).toBe("H3");
      await expect(item.locator(".release-version")).toHaveText(r.version);
      await expect(item.locator("time")).toHaveAttribute("datetime", r.date);
      if (n < 3) await expect(item).toBeVisible();
      else await expect(item).toBeHidden();
    }
    // The version shown is the build's, and that release (only) says Current, in words.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    await expect(page.locator("[data-app-version]")).toHaveText(pkg.version);
    await expect(page.locator('#changelog .release[data-current="true"]')).toHaveCount(1);
    await expect(page.locator('#changelog .release[data-current="true"]')).toHaveAttribute("data-version", pkg.version);
    await expect(page.locator('#changelog .release[data-current="true"] .release-badge')).toHaveText("Current");
    await expect(page.locator("#changelog .release-badge")).toHaveCount(1);
    await expect(page.locator("[data-release-count]")).toHaveText(String(CHANGELOG.length));
    await expect(page.locator("[data-first-date]")).toHaveText("18 October 2026");
  });

  test("a release's changes: a tag column (glyph and word, one neutral style) in Added, Changed, Fixed order, folded after 6", async ({ page }) => {
    await page.goto("/about#changelog");
    const r = CHANGELOG.find((x) => x.items.length > 6)!;
    const release = page.locator(`#changelog .release[data-version="${r.version}"]`);
    const ordered = ["added", "changed", "fixed"].flatMap((k) => r.items.filter((i) => i.kind === k));
    const rows = release.locator(".release-item");
    await expect(rows).toHaveCount(r.items.length);
    expect(await release.locator(".release-tag").evaluateAll((els) => els.map((e) => e.textContent))).toEqual(ordered.map((i) => i.kind[0].toUpperCase() + i.kind.slice(1)));
    expect(await release.locator(".release-text").evaluateAll((els) => els.map((e) => e.textContent))).toEqual(ordered.map((i) => i.text));
    await expect(release.locator(".release-sum")).toHaveText(
      (["added", "changed", "fixed"] as const)
        .map((k) => [k, r.items.filter((i) => i.kind === k).length] as const)
        .filter(([, n]) => n)
        .map(([k, n]) => `${n} ${k}`)
        .join(", "),
    );
    // Every tag has its glyph, and the kinds differ by glyph and word, never by colour alone.
    await expect(release.locator(".release-tag svg")).toHaveCount(r.items.length);
    const colours = await release.locator(".release-tag").evaluateAll((els) => [...new Set(els.map((e) => `${getComputedStyle(e).color} ${getComputedStyle(e).backgroundColor}`))]);
    expect(colours).toHaveLength(1);
    // The first 6 show; one button names how many more, and controls the list it opens.
    const more = release.locator(".release-more");
    await expect(more).toHaveText(`Show all ${r.items.length} changes (${r.items.length - 6} more)`);
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const list = page.locator(`#${await more.getAttribute("aria-controls")}`);
    await expect(list).toHaveClass(/release-items/);
    await expect(rows.nth(5)).toBeVisible();
    await expect(rows.nth(6)).toBeHidden();
    await more.focus();
    await page.keyboard.press("Space");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(rows.last()).toBeVisible();
    await expect(more).toHaveText("Show fewer changes");
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(rows.nth(6)).toBeHidden();
    // Short releases have no such button.
    await expect(page.locator(`#changelog .release[data-version="${CHANGELOG.find((x) => x.items.length <= 6)!.version}"] .release-more`)).toHaveCount(0);
  });

  test("the older releases wait behind one button that names how many and their range; it opens by keyboard", async ({ page }) => {
    await page.goto("/about#changelog");
    const toggle = page.locator("#changelog .release-older-toggle");
    const older = CHANGELOG.slice(3);
    // The words' format is unit-tested (timeline.test.ts); here, that the button carries them.
    await expect(toggle).toHaveAccessibleName(`${olderLabel(older.length)} ${olderRange(older)}`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const list = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
    await expect(list).toBeHidden();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();
    await expect(list.locator(".release")).toHaveCount(older.length);
    await expect(list.locator(".release").last()).toBeVisible();
    await expect(toggle.locator(".release-older-label")).toHaveText("Hide older releases");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();
  });

  test("from 1080 px a release index lists every version, the current one marked; a link to an older release opens it and moves focus to its title", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/about#changelog");
    const index = page.getByRole("navigation", { name: "Releases" });
    await expect(index).toBeVisible();
    const links = index.getByRole("link");
    await expect(links).toHaveCount(CHANGELOG.length);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const current = index.locator('a[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(pkg.version);
    await expect(current).toContainText("(current version)");
    const target = CHANGELOG.find((r) => r.version === "0.4.0")!;
    const link = index.getByRole("link", { name: new RegExp(`^${target.version.replaceAll(".", "\\.")} `) });
    await expect(link).toHaveAttribute("href", "#v0-4-0");
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#changelog .release-older-toggle")).toHaveAttribute("aria-expanded", "true");
    const title = page.locator("#v0-4-0");
    await expect(title).toBeFocused();
    await expect(title).toHaveText(target.title);
    await expect(title).toBeInViewport();
    expect(new URL(page.url()).hash).toBe("#v0-4-0");
    // Narrower, the index goes (the timeline alone).
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(index).toBeHidden();
  });

  test("Ctrl, Cmd, Shift and Alt clicks on the release index are left to the browser (new tab, window); a plain click is the page's", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/about#changelog");
    const index = page.getByRole("navigation", { name: "Releases" });
    await expect(index.getByRole("link").first()).toBeVisible();
    const prevented = await page.evaluate(() => {
      const link = document.querySelector<HTMLAnchorElement>('.release-index a[href="#v0-4-0"]')!;
      const out: Record<string, boolean> = {};
      for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey", "plain"]) {
        let seen = false;
        // Runs after the index's own listener; it records what that listener did, then keeps the
        // click from going anywhere (no new tab in the test).
        const record = (e: Event): void => {
          seen = e.defaultPrevented;
          e.preventDefault();
        };
        addEventListener("click", record, { once: true });
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, [key]: true }));
        out[key] = seen;
      }
      return out;
    });
    expect(prevented).toEqual({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, plain: true });
  });

  test("a deep link to an older release opens the fold, shows its title and moves focus there; so does a hash change after load", async ({ page }) => {
    await page.goto("/about#v0-2-0");
    const toggle = page.locator("#changelog .release-older-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#v0-2-0")).toBeInViewport();
    await expect(page.locator("#v0-2-0")).toBeFocused();
    // After load: fold it again, then change the hash in the page.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => {
      location.hash = "#v0-3-0";
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const title = page.locator("#v0-3-0");
    await expect(title).toBeInViewport();
    await expect(title).toBeFocused();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: with every fold open, What's new is axe clean; on a phone its buttons are 44 px and nothing scrolls sideways`, async ({ page }) => {
      await openIn(page, "/about#changelog", scheme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      // The older releases' button and one per long release (else this would pass with nothing to open).
      const folds = 1 + CHANGELOG.filter((r) => r.items.length > 6).length;
      await expect(page.locator("#changelog button[aria-expanded][aria-controls]")).toHaveCount(folds);
      // The older releases first: their own "Show all" buttons show only once that fold is open.
      await page.locator("#changelog .release-older-toggle").click();
      // One at a time (an opened button leaves this selector, so indexes would shift).
      const closed = page.locator('#changelog button[aria-expanded="false"]');
      for (let n = folds - 1; n > 0; n--) {
        await closed.first().click();
        await expect(closed).toHaveCount(n - 1);
      }
      const axe = await new AxeBuilder({ page }).include("#changelog").withTags(AXE_TAGS).analyze();
      expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${width} px`).toBe(false);
        const heights = await page.locator("#changelog button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
        expect(Math.min(...heights), `${width} px`).toBeGreaterThanOrEqual(44);
      }
    });
  }

  test("keyboard: the first Tab stop is a skip link, then Open the editor; focus is visible", async ({ page }) => {
    await page.goto("/about");
    await page.keyboard.press("Tab");
    // Safari leaves links out of the Tab order unless "Press Tab to highlight each item" is on, and
    // Playwright's WebKit differs by platform (share-design.spec.ts): read it from the browser.
    const skip = page.getByRole("link", { name: "Skip to the content" });
    const linksAreStops = await skip.evaluate((a) => a === document.activeElement);
    if (!linksAreStops) {
      expect(test.info().project.name, "only WebKit may skip links").toBe("webkit");
      await skip.focus();
    }
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    if (linksAreStops) {
      // The home link, the bar's three section links (Overview, Flowcharts, What's new), then Open the editor.
      for (const name of ["CodeEditor", "Overview", "Flowcharts", "What's new"]) {
        await page.keyboard.press("Tab");
        await expect(page.locator(".about-head").getByRole("link", { name, exact: true })).toBeFocused();
      }
      await page.keyboard.press("Tab");
    } else {
      await page.locator(".about-head .about-btn").focus();
    }
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { text: el.textContent?.trim(), outline: getComputedStyle(el).outlineStyle };
    });
    expect(focused.text).toBe("Open the editor");
    expect(focused.outline).not.toBe("none");
  });

  test.describe("the launch video", () => {
  // Linux WebKit's media player (GStreamer) sometimes drops its first request for the file and
  // fetches it again while the video keeps playing (CI run 40590457063, 2026-10-27: cancelled 158 ms
  // after it started, no navigation near it). That cancel is the player's own, so it is excused for
  // this file only; every other failure still counts, and playing is asserted below.
  test.use(tolerating(/^request failed: http:\/\/127\.0\.0\.1:\d+\/media\/launch-[^ /]+\.mp4 Load request cancelled$/));
  test("the launch video plays like a hero video once in view: muted, looping, nothing fetched before, and its button pauses it for good", async ({ page, request }) => {
    const media: string[] = [];
    page.on("request", (r) => (/\.(mp4|webm)$/.test(new URL(r.url()).pathname) ? media.push(r.url()) : null));
    await page.goto("/about");
    const stage = page.locator("#launch-video .about-stage");
    const video = stage.locator("video");
    const button = stage.getByRole("button");
    // Below the fold: no file yet (Linux WebKit fetches a source even with preload="none").
    await expect(stage).toHaveAttribute("data-video", "idle");
    await page.waitForTimeout(500);
    expect(media).toEqual([]);
    expect(await video.evaluate((v: HTMLVideoElement) => ({ controls: v.controls, autoplay: v.autoplay, muted: v.muted, loop: v.loop, src: v.getAttribute("src") }))).toEqual({ controls: false, autoplay: false, muted: true, loop: true, src: null });
    await stage.scrollIntoViewIfNeeded();
    const h264 = await video.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.640028"') !== "");
    if (!h264) {
      // Only an engine that can't decode H.264 may stop short of playing (some Playwright builds).
      await expect(stage).toHaveAttribute("data-video", /^(still|unplayable)$/, { timeout: 10_000 });
    } else {
      await expect(stage).toHaveAttribute("data-video", "playing", { timeout: 15_000 });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5_000 }).toBeGreaterThan(0.3);
      await expect(button).toHaveText("Pause video");
      await button.click();
      await expect(stage).toHaveAttribute("data-video", "paused");
      await expect(button).toHaveText("Play video");
      // A pause by the button holds: out of view and back, it stays paused.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      await stage.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      await button.click();
      // As long as the first start: a software decoder (Linux WebKit in CI) may need to fill its
      // buffer again after the pause (run 40590457063 was still "paused" at 5 s).
      await expect(stage).toHaveAttribute("data-video", "playing", { timeout: 15_000 });
    }
    // Its text equivalent names every scene and offers the file; the poster and the file are served.
    await expect(page.locator("#video-text li")).toHaveCount(5);
    const file = await video.getAttribute("data-src");
    await expect(page.locator("#video-text a[download]")).toHaveAttribute("href", file!);
    await expect(video).toHaveAttribute("aria-describedby", "video-text");
    for (const path of [await video.getAttribute("poster"), file]) expect((await request.get(path!)).status(), path!).toBe(200);
  });

  test("clicked while the file is still loading, the button pauses the video (its label said Pause), and the pause holds", async ({ page }) => {
    // The file is held back, as on a slow connection: play() has started, no frame has come yet.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let routed = false;
    await page.route(/\/media\/launch-[^/]+\.mp4$/, async (route) => {
      routed = true;
      await held;
      // The player may have dropped the request meanwhile.
      await route.fallback().catch(() => {});
    });
    await page.goto("/about");
    const stage = page.locator("#launch-video .about-stage");
    const video = stage.locator("video");
    const button = stage.getByRole("button");
    await stage.scrollIntoViewIfNeeded();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    // The section's reveal (a 16 px rise) has ended: on a moving target the click rescrolled first,
    // and in WebKit that scroll took the video out of view for a moment, so the page paused it (out
    // of view) and the click then played it again.
    await expect.poll(() => page.locator("#launch-video").evaluate((s) => getComputedStyle(s).transform)).toBe("none");
    if (routed) {
      await expect(stage).toHaveAttribute("data-video", "loading");
    } else {
      // Playwright's WebKit loads media outside page.route here, so the file can't be held back: it
      // may already be playing. The click must pause it all the same.
      expect(test.info().project.name, "only WebKit may load the video outside page.route").toBe("webkit");
      await expect(stage).toHaveAttribute("data-video", /^(loading|playing)$/);
    }
    await expect(button).toHaveText("Pause video");
    await button.click();
    await expect(stage).toHaveAttribute("data-video", "paused");
    await expect(button).toHaveText("Play video");
    release();
    await page.waitForTimeout(1500);
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(stage).toHaveAttribute("data-video", "paused");
  });

  test("a file that can't be decoded: the button goes, and stays gone when the video comes into view again", async ({ page }) => {
    // The real file's header and the start of its data, then noise (the same each run): the player
    // reads the metadata, starts, and fails to decode (MEDIA_ERR_DECODE). A play() after that still
    // fires "play", and that once brought the button back as "Pause video".
    const name = readdirSync("public/media").find((f) => /^launch-.+\.mp4$/.test(f))!;
    const body = readFileSync(join("public/media", name));
    let seed = 12345;
    for (let i = 12 * 1024; i < body.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      body[i] = seed & 0xff;
    }
    let routed = false;
    await page.route(/\/media\/launch-[^/]+\.mp4$/, (route) => {
      routed = true;
      return route.fulfill({ status: 200, contentType: "video/mp4", body });
    });
    // Counts the page's play() calls: after a decode error Linux WebKit (CI run on 1bc4da4) leaves
    // the video paused when asked again, where Chromium and Firefox start it, so "the page asked it
    // to play" is read from the calls, not from paused.
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      (window as unknown as { plays: number }).plays = 0;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        (window as unknown as { plays: number }).plays++;
        return play.call(this);
      };
    });
    const plays = () => page.evaluate(() => (window as unknown as { plays: number }).plays);
    await page.goto("/about");
    const stage = page.locator("#launch-video .about-stage");
    const button = stage.locator(".about-play");
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute("data-video", /^(unplayable|playing)$/, { timeout: 15_000 });
    if (!routed) {
      // Playwright's WebKit loads media outside page.route here: it got the real file.
      expect(test.info().project.name, "only WebKit may load the video outside page.route").toBe("webkit");
      test.info().annotations.push({ type: "skip-reason", description: "the corrupt file can't be served to WebKit's media loader" });
      return;
    }
    await expect(stage).toHaveAttribute("data-video", "unplayable");
    await expect(button).toBeHidden();
    // Out of view and back: the page asks it to play again.
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    const before = await plays();
    await stage.scrollIntoViewIfNeeded();
    await expect.poll(plays).toBeGreaterThan(before);
    await page.waitForTimeout(500);
    await expect(stage).toHaveAttribute("data-video", "unplayable");
    await expect(button).toBeHidden();
  });
  });

  test("with reduced motion the launch video never starts by itself: the poster, and a Play button", async ({ page }) => {
    const media: string[] = [];
    page.on("request", (r) => (/\.(mp4|webm)$/.test(new URL(r.url()).pathname) ? media.push(r.url()) : null));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/about");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced motion applied").toBe(true);
    const stage = page.locator("#launch-video .about-stage");
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await expect(stage).toHaveAttribute("data-video", "still");
    await expect(stage.getByRole("button")).toHaveText("Play video");
    expect(await stage.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    expect(media).toEqual([]);
  });
});

test.describe("the hero scene", () => {
  test.use({ serviceWorkers: "block" });

  test("with WebGL and motion welcome, the real-time scene replaces the poster once it has drawn", async ({ page, browserName }) => {
    await page.goto("/about");
    await expect(scene(page)).toHaveAttribute("data-scene", /^(running|unavailable)$/, { timeout: 20_000 });
    const state = await scene(page).getAttribute("data-scene");
    // Only a browser with neither WebGL 2 nor WebGL may say unavailable (lessons.md, Pocket Run).
    if (state === "unavailable") {
      const any = await page.evaluate(() => {
        const c = document.createElement("canvas");
        return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
      });
      expect(any, `${browserName} has WebGL but the scene says unavailable`).toBe(false);
      await expect(page.locator(".about-poster")).toBeVisible();
      return;
    }
    await expect(page.locator(".about-scene canvas")).toBeVisible();
    await expect(page.locator(".about-scene canvas")).toHaveAttribute("aria-hidden", "true");
  });

  /** Waits for the scene to start; false where the browser has no WebGL (checked as above). */
  async function sceneRuns(page: Page): Promise<boolean> {
    await expect(scene(page)).toHaveAttribute("data-scene", /^(running|unavailable)$/, { timeout: 20_000 });
    if ((await scene(page).getAttribute("data-scene")) === "running") return true;
    expect(await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl"))), "WebGL works, yet the scene is unavailable").toBe(false);
    await expect(page.locator(".about-scene-toggle")).toBeHidden();
    return false;
  }
  const framesOf = async (page: Page) => Number(await scene(page).getAttribute("data-frames"));

  test("the scene has a Pause button (WCAG 2.2.2): the pause holds out of view and back, and Play runs it again", async ({ page }) => {
    await page.goto("/about");
    if (!(await sceneRuns(page))) return;
    // By its class: its name changes with the state.
    const toggle = page.locator(".about-scene-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAccessibleName("Pause animation");
    const box = (await toggle.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    await toggle.focus();
    expect(await toggle.evaluate((b) => getComputedStyle(b).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(scene(page)).toHaveAttribute("data-scene", "paused");
    await expect(toggle).toHaveText("Play animation");
    // The paused frame stays (not the poster), and no frame is drawn, even after scrolling away and back.
    await expect(page.locator(".about-scene canvas")).toBeVisible();
    const frames = await framesOf(page);
    await page.locator("#changelog").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(800);
    expect(await framesOf(page)).toBe(frames);
    await expect(scene(page)).toHaveAttribute("data-scene", "paused");
    await toggle.click();
    await expect(scene(page)).toHaveAttribute("data-scene", "running");
    await expect(toggle).toHaveText("Pause animation");
    await expect.poll(() => framesOf(page)).toBeGreaterThan(frames);
  });

  test("reduced motion turned on mid-visit stops the scene (the poster again) and the launch video", async ({ page }) => {
    await page.goto("/about");
    const runs = await sceneRuns(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced motion applied").toBe(true);
    await expect(scene(page)).toHaveAttribute("data-scene", runs ? "still" : "unavailable");
    const frames = await framesOf(page);
    await page.waitForTimeout(800);
    expect(await framesOf(page)).toBe(frames);
    await expect(page.locator(".about-poster")).toBeVisible();
    await expect(page.locator(".about-scene-toggle")).toBeHidden();
    // The launch video no longer starts by itself in view; its button still plays it.
    const stage = page.locator("#launch-video .about-stage");
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await expect(stage).toHaveAttribute("data-video", "still");
    expect(await stage.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(stage.getByRole("button")).toHaveText("Play video");
  });

  test("reduced motion turned on while the scene's button has focus: focus moves to the hero's title, not to the page", async ({ page }) => {
    await page.goto("/about");
    if (!(await sceneRuns(page))) return;
    const toggle = page.locator(".about-scene-toggle");
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(scene(page)).toHaveAttribute("data-scene", "still");
    await expect(toggle).toBeHidden();
    await expect(page.locator("#hero-title")).toBeFocused();
    // The next Tab goes on from the hero: the first link after the title.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
  });

  /** The space kept under the scene for its button, and the hero's height (where the next section starts; its reveal moves it, so not its own box). */
  const room = (page: Page) =>
    page.evaluate(() => ({
      margin: getComputedStyle(document.querySelector(".about-scene")!).marginBottom,
      hero: document.querySelector<HTMLElement>(".about-hero")!.offsetHeight,
    }));

  test("the scene's button keeps its room from the poster on (no shift when the scene starts), and none where it can't show", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/about");
    const before = await room(page);
    expect(before.margin).not.toBe("0px");
    if (await sceneRuns(page)) {
      expect(await room(page)).toEqual(before);
      await page.locator(".about-scene-toggle").click();
      await expect(scene(page)).toHaveAttribute("data-scene", "paused");
      expect(await room(page)).toEqual(before);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(scene(page)).toHaveAttribute("data-scene", "still");
    }
    // Still (or unavailable): no button, so no gap under the poster.
    expect((await room(page)).margin).toBe("0px");
  });

  test("reduced motion: the poster stays and the scene never starts a frame", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/about");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expect(scene(page)).toHaveAttribute("data-scene", "still");
    await page.waitForTimeout(1500);
    expect(Number(await scene(page).getAttribute("data-frames"))).toBe(0);
    await expect(page.locator(".about-poster")).toBeVisible();
    await expect(page.locator(".about-scene canvas")).toHaveCount(0);
    expect((await room(page)).margin).toBe("0px");
  });

  test("WebGL unavailable: the poster stays, and the page says nothing is wrong", async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
    await page.goto("/about");
    await expect(scene(page)).toHaveAttribute("data-scene", "unavailable", { timeout: 20_000 });
    await expect(page.locator(".about-poster")).toBeVisible();
    // Its button can never show: no gap kept for it.
    expect((await room(page)).margin).toBe("0px");
  });
});

// After a release, an older service worker keeps serving its own precached about.html until the user
// takes the update (it waits: an editor tab can hold unsaved text). That page must still find its
// code: every script and stylesheet it names is in the same precache (only the optional 3D scene,
// imported later from assets/a/, may be missing, and then the poster stays). The page's entry once
// lived in assets/a/, and the live About page lost its changelog after the next deploy.
test("every script and stylesheet the About page names is precached with it", async ({ request }) => {
  const html = await (await request.get("/about")).text();
  const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+\.(?:js|css))"/g)].map((m) => m[1].replace(/^\//, ""));
  expect(refs.length).toBeGreaterThan(1);
  const sw = await (await request.get("/sw.js")).text();
  for (const ref of refs) expect(sw, `${ref} is not in the service worker's precache`).toContain(`"${ref}"`);
  expect(refs.filter((r) => r.startsWith("assets/a/"))).toEqual([]);
});

test("the editor's first visit loads nothing of the About page", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  expect(html).not.toContain("/assets/a/");
  const seen: string[] = [];
  page.on("request", (r) => seen.push(new URL(r.url()).pathname));
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(seen.filter((p) => p.startsWith("/assets/a/") || p.startsWith("/media/"))).toEqual([]);
});

test("with the service worker in control, /about works offline after one visit, and / is still the editor", async ({ page, context }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
    .toBe("activated");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The scene's code is fetched at idle (page.ts scene()), which can come after networkidle: going
  // offline first left it uncached, and the offline reload's fetch of it failed in the service
  // worker (Firefox on CI, run 40566760719). Every end state means its code came (or isn't needed),
  // and then it is in the About cache (vite.config.ts runtimeCaching) before the network goes.
  await expect(page.locator(".about-scene")).toHaveAttribute("data-scene", /^(running|unavailable|still)$/, { timeout: 30_000 });
  // Every About chunk the page loaded, not just one: the scene and three.js are separate files, and
  // the cache stores each after its response is passed on, so one could still be missing (Firefox on
  // CI, run 40843953981: the offline reload failed on the second chunk).
  if ((await page.locator(".about-scene").getAttribute("data-scene")) !== "still") {
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const loaded = performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.startsWith("/assets/a/"));
            const cached = new Set((await (await caches.open("codeeditor-about")).keys()).map((r) => new URL(r.url).pathname));
            return loaded.length > 0 && loaded.every((p) => cached.has(p)) ? "all" : `${loaded.filter((p) => !cached.has(p)).length} of ${loaded.length} missing`;
          }),
        { timeout: 15_000 },
      )
      .toBe("all");
  }
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#changelog .release")).toHaveCount(CHANGELOG.length);
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await context.setOffline(false);
});
