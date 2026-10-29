// The About page (about.html): the changelog from the release data, the build's version, a strip of
// the built-in colour themes drawn from their own palettes, restrained reveals, and the hero's
// three.js scene, loaded only after the first paint and only where it can run. Every string from the
// data goes in as text (textContent / createTextNode), never as markup.
import { CHANGELOG, KINDS, type Kind } from "./changelog";
import { BUILT_IN, themePalette } from "../theme/themes";
import type { SceneControl } from "./scene";

const KIND_WORD: Record<Kind, string> = { added: "Added", changed: "Changed", fixed: "Fixed" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "27 October 2026" from "2026-10-27" (no time zone shift: the date is a day, not an instant). */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Releases shown open; the older ones fold under "Earlier releases" (still in the page and found by search). */
const OPEN_RELEASES = 4;

function renderRelease(r: (typeof CHANGELOG)[number]): HTMLLIElement {
  const item = el("li", "release");
  const head = el("h3", "release-head");
  head.append(el("span", "release-version", r.version), " ", el("span", "release-title", r.title));
  const time = el("time", "release-date", longDate(r.date));
  time.dateTime = r.date;
  item.append(head, time);
  // One tag per kind over its own list: the word names it (the dot's colour only repeats it).
  for (const kind of KINDS) {
    const items = r.items.filter((i) => i.kind === kind);
    if (!items.length) continue;
    const id = `release-${r.version.replaceAll(".", "-")}-${kind}`;
    const group = el("div", "release-group");
    group.dataset.kind = kind;
    const tag = el("h4", "release-kind", KIND_WORD[kind]);
    tag.id = id;
    const list = el("ul", "release-items");
    list.setAttribute("aria-labelledby", id);
    for (const i of items) list.append(el("li", undefined, i.text));
    group.append(tag, list);
    item.append(group);
  }
  return item;
}

function renderChangelog(): void {
  const list = document.querySelector(".about-releases");
  if (!list) return;
  for (const r of CHANGELOG.slice(0, OPEN_RELEASES)) list.append(renderRelease(r));
  const older = CHANGELOG.slice(OPEN_RELEASES);
  if (older.length) {
    const fold = el("details", "release-older");
    const summary = el("summary", undefined, `Earlier releases (${older.length}), back to ${older[older.length - 1].version}`);
    const rest = el("ol", "about-releases about-releases-older");
    for (const r of older) rest.append(renderRelease(r));
    fold.append(summary, rest);
    const holder = el("li", "release-older-item");
    holder.append(fold);
    list.append(holder);
  }
  for (const v of document.querySelectorAll<HTMLElement>("[data-app-version]")) v.textContent = __APP_VERSION__;
}

function renderThemes(): void {
  const strip = document.querySelector(".about-swatches");
  if (!strip) return;
  // "Match device" entries repeat their light and dark themes: each look once.
  const themes = BUILT_IN.filter((t) => !t.system);
  for (const t of themes) {
    const { palette } = themePalette(t);
    const item = el("li", "swatch");
    const sample = el("span", "swatch-sample");
    sample.setAttribute("aria-hidden", "true");
    // Colours come from the app's own palette data (#rrggbb), set as style values, never as markup:
    // the theme's ground, and a line of code in its keyword, string and function colours.
    sample.style.backgroundColor = palette.bg;
    for (const key of ["syn-keyword", "syn-string", "syn-function"] as const) {
      const bar = el("span", "swatch-bar");
      bar.style.backgroundColor = palette[key];
      sample.append(bar);
    }
    item.append(sample, el("span", "swatch-name", t.name.replace(/^CodeEditor /, "")));
    strip.append(item);
  }
  for (const n of document.querySelectorAll<HTMLElement>("[data-theme-count]")) n.textContent = String(themes.length);
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Runs `stop` when the device turns reduced motion on during the visit (the page reads it once otherwise). */
function whenMotionIsReduced(stop: () => void): void {
  reducedMotion.addEventListener("change", (e) => {
    if (e.matches) stop();
  });
}

/** The flowchart screenshot in the theme the page shows: theme-boot.js's data-theme follows a saved theme, not only the device. */
function shot(): void {
  const dark = document.querySelector<HTMLSourceElement>(".about-shot source");
  if (dark) dark.media = document.documentElement.dataset.theme === "dark" ? "all" : "not all";
}

/** Secondary sections settle in as they arrive: they start readable (never from opacity 0) and nothing moves with reduced motion. */
function reveals(): void {
  // about.css moves them only under no-preference, so a change mid-visit needs nothing here.
  if (reducedMotion.matches || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const s of document.querySelectorAll("main > section:not(.about-hero)")) {
    s.classList.add("will-reveal");
    io.observe(s);
  }
}

/**
 * The hero scene, after the first paint: the poster stays where WebGL or motion isn't welcome. Its
 * button (shown by about.css only while it runs or is paused) pauses it (WCAG 2.2.2), and the pause
 * holds until the button plays it again. Reduced motion turned on during the visit stops it for good.
 */
function scene(): void {
  const host = document.querySelector<HTMLElement>(".about-scene");
  if (!host) return;
  if (reducedMotion.matches) {
    host.dataset.scene = "still";
    return;
  }
  let control: SceneControl | null = null;
  let stopped = false;
  const toggle = host.querySelector<HTMLButtonElement>(".about-scene-toggle");
  whenMotionIsReduced(() => {
    stopped = true;
    // The button goes with the motion: focus on it would fall to the page, so it moves to the hero's
    // title first (tabindex="-1"), and Tab goes on from there.
    if (toggle && document.activeElement === toggle) document.querySelector<HTMLElement>("#hero-title")?.focus();
    if (control) control.stop();
    else if (host.dataset.scene !== "unavailable") host.dataset.scene = "still";
  });
  let held = false;
  toggle?.addEventListener("click", () => {
    held = !held;
    control?.hold(held);
    toggle.textContent = held ? "Play animation" : "Pause animation";
  });
  const start = () => {
    if (stopped) return;
    host.dataset.scene = "loading";
    import("./scene")
      .then((m) => {
        // Reduced motion came on while the code was on its way.
        if (stopped) host.dataset.scene = "still";
        else control = m.mountScene(host);
      })
      .catch(() => {
        // The scene's code didn't arrive (offline before it was cached): the poster is the hero.
        host.dataset.scene = "unavailable";
      });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 1500 });
  else setTimeout(start, 300);
}

/**
 * The launch video plays like a hero video: muted and looping, while at least a third of it is on
 * screen. Its file is attached only when it first comes into view (some engines fetch a source even
 * with preload="none"). Nothing starts by itself with reduced motion. The button pauses it (WCAG
 * 2.2.2), and a pause by the button holds until the button plays it again. data-video on the stage
 * says the state: idle, loading (started, no frame yet: the button already offers Pause), playing,
 * paused, still (reduced motion, now or turned on during the visit, or a browser that refused to
 * play it) or unplayable (the file can't be decoded here).
 */
function video(): void {
  const stage = document.querySelector<HTMLElement>(".about-stage");
  const player = stage?.querySelector("video");
  const button = stage?.querySelector<HTMLButtonElement>(".about-play");
  if (!stage || !player || !button) return;
  const state = (s: string) => {
    stage.dataset.video = s;
    // From play() on, not from the first frame: a click while the file loads pauses it, so say so.
    button.textContent = s === "playing" || s === "loading" ? "Pause video" : "Play video";
    button.hidden = s === "unplayable";
  };
  let held = false;
  const attach = () => {
    if (player.src) return;
    player.preload = "auto";
    player.src = player.dataset.src ?? "";
  };
  const play = () => {
    attach();
    player.play().catch((e: unknown) => {
      // A pause before the first frame rejects the play with AbortError: the pause's state stands.
      if ((e as { name?: string } | null)?.name === "AbortError") return;
      if (stage.dataset.video !== "unplayable") state("still");
    });
  };
  player.addEventListener("play", () => {
    // A file that failed to decode still fires "play" when the page asks again (back in view): it stays unplayable.
    if (stage.dataset.video !== "playing" && stage.dataset.video !== "unplayable") state("loading");
  });
  player.addEventListener("playing", () => state("playing"));
  player.addEventListener("pause", () => {
    if (stage.dataset.video !== "unplayable") state("paused");
  });
  player.addEventListener("error", () => state("unplayable"));
  button.addEventListener("click", () => {
    if (player.paused) {
      held = false;
      play();
    } else {
      held = true;
      player.pause();
    }
  });
  let reduced = reducedMotion.matches;
  state(reduced ? "still" : "idle");
  if (reduced) return;
  whenMotionIsReduced(() => {
    reduced = true;
    if (stage.dataset.video === "unplayable") return;
    if (player.paused) state("still");
    else {
      // After the "pause" listener above, which would say paused.
      player.addEventListener("pause", () => state("still"), { once: true });
      player.pause();
    }
  });
  if (!("IntersectionObserver" in window)) {
    play();
    return;
  }
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !held && !reduced) play();
        else if (!e.isIntersecting && !player.paused) player.pause();
      }
    },
    { threshold: 0.35 },
  ).observe(player);
}

renderChangelog();
renderThemes();
shot();
reveals();
video();
if (document.readyState === "complete") scene();
else addEventListener("load", scene, { once: true });
