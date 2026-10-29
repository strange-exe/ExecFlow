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
  }

  test("320 px: nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/about");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test("the changelog lists every release, newest first, with its items as text", async ({ page }) => {
    await page.goto("/about#changelog");
    const releases = page.locator("#changelog .release");
    await expect(releases).toHaveCount(CHANGELOG.length);
    await expect(releases.first().locator("h3")).toContainText(CHANGELOG[0].version);
    await expect(releases.last().locator("h3")).toContainText("0.1.0");
    await expect(page.locator("#changelog")).toBeInViewport();
    // The version shown is the build's.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    await expect(page.locator("[data-app-version]")).toHaveText(pkg.version);
  });

  test("each kind of change is one named list; the older releases fold away and open by keyboard", async ({ page }) => {
    await page.goto("/about#changelog");
    const latest = page.locator("#changelog .release").first();
    // One tag per kind, naming its own list (not a label repeated on every line).
    for (const kind of new Set(CHANGELOG[0].items.map((i) => i.kind))) {
      const word = kind[0].toUpperCase() + kind.slice(1);
      const list = latest.getByRole("list", { name: word });
      await expect(list).toHaveCount(1);
      await expect(list.getByRole("listitem")).toHaveCount(CHANGELOG[0].items.filter((i) => i.kind === kind).length);
    }
    // The first four are open; the rest wait under one disclosure that names how many and how far back.
    const fold = page.locator("#changelog details.release-older");
    const summary = fold.locator("summary");
    await expect(summary).toHaveText(`Earlier releases (${CHANGELOG.length - 4}), back to 0.1.0`);
    await expect(fold.locator(".release").first()).toBeHidden();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(fold).toHaveJSProperty("open", true);
    await expect(fold.locator(".release").last()).toBeVisible();
  });

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
      await page.keyboard.press("Tab");
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
