// The About page (about.html): the changelog from the release data, the build's version, a strip of
// the built-in colour themes drawn from their own palettes, restrained reveals, and the hero's
// three.js scene, loaded only after the first paint and only where it can run. Every string from the
// data goes in as text (textContent / createTextNode), never as markup.
import { CHANGELOG, type Kind, type Release } from "./changelog";
import { BUILT_IN, themePalette } from "../theme/themes";
import type { SceneControl } from "./scene";
import {
  ITEMS_SHOWN,
  KIND_WORD,
  byKind,
  byMonth,
  countLine,
  longDate,
  olderLabel,
  olderRange,
  releaseId,
  shortDate,
  showAllLabel,
  splitReleases,
} from "./timeline";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The tag glyphs, drawn in a 10 px box: + Added, an arrow Changed, a check Fixed. */
const GLYPH: Record<Kind, string> = { added: "M5 1.5v7M1.5 5h7", changed: "M1.5 5h7M5.5 2l3 3-3 3", fixed: "M1.5 5.2 3.9 7.5 8.5 2.5" };

/** A decorative stroked SVG icon (hidden from screen readers: the words beside it say the same). */
function icon(className: string, size: number, viewBox: number, d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ class: className, width: size, height: size, viewBox: `0 0 ${viewBox} ${viewBox}`, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(k, String(v));
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const chevron = () => icon("release-chev", 14, 16, "m4 6 4 4 4-4");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One release on the timeline: a rail (version, date, Current), the axis's ring, and the body (title,
 * a count of its changes, then one row per change: a tag with a glyph and the kind's word, then the
 * sentence). Past ITEMS_SHOWN changes the rest wait behind "Show all N changes" (still in the page).
 */
function renderRelease(r: Release): HTMLLIElement {
  const id = releaseId(r.version);
  const current = r.version === __APP_VERSION__;
  const item = el("li", "release");
  item.dataset.version = r.version;
  if (current) item.dataset.current = "true";

  const meta = el("div", "release-meta");
  const time = el("time", "release-date", shortDate(r.date));
  time.dateTime = r.date;
  meta.append(el("span", "release-version", r.version), time);
  if (current) meta.append(el("span", "release-badge", "Current"));

  const axis = el("div", "release-axis");
  axis.setAttribute("aria-hidden", "true");
  axis.append(el("span", "release-node"));

  const body = el("div", "release-body");
  const title = el("h3", "release-title", r.title);
  title.id = id;
  // The index and deep links move focus here.
  title.tabIndex = -1;
  const list = el("ul", "release-items");
  list.id = `${id}-items`;
  const items = byKind(r.items);
  items.forEach((i, n) => {
    const row = el("li", "release-item");
    const tag = el("span", "release-tag");
    tag.dataset.kind = i.kind;
    tag.append(icon("release-glyph", 10, 10, GLYPH[i.kind]), KIND_WORD[i.kind]);
    // "Fixed: With Brave ..." for a screen reader; on screen the tag column separates them.
    row.append(tag, el("span", "about-sr", ": "), el("span", "release-text", i.text));
    row.hidden = n >= ITEMS_SHOWN;
    list.append(row);
  });
  body.append(title, el("p", "release-sum", countLine(r.items)), list);

  if (items.length > ITEMS_SHOWN) {
    const more = el("button", "release-more");
    more.type = "button";
    more.setAttribute("aria-controls", list.id);
    const label = el("span");
    const set = (open: boolean) => {
      more.setAttribute("aria-expanded", String(open));
      label.textContent = open ? "Show fewer changes" : showAllLabel(items.length);
      [...list.children].forEach((row, n) => ((row as HTMLElement).hidden = !open && n >= ITEMS_SHOWN));
    };
    more.append(chevron(), label);
    more.addEventListener("click", () => set(more.getAttribute("aria-expanded") !== "true"));
    set(false);
    body.append(more);
  }
  item.append(meta, axis, body);
  return item;
}

/**
 * What's new: the latest releases open on the timeline, the older ones behind one button that names
 * how many and their range, and (from 1080 px, about.css) an index of every version. A link in the
 * index, or a deep link (/about#v0-4-0), opens the fold its release is in and moves focus to its title.
 */
function renderChangelog(): void {
  for (const v of document.querySelectorAll<HTMLElement>("[data-app-version]")) v.textContent = __APP_VERSION__;
  for (const n of document.querySelectorAll<HTMLElement>("[data-release-count]")) n.textContent = String(CHANGELOG.length);
  const first = CHANGELOG.at(-1);
  for (const n of document.querySelectorAll<HTMLElement>("[data-first-date]")) n.textContent = first ? longDate(first.date) : "";

  const recentList = document.querySelector<HTMLOListElement>("#releases-recent");
  const olderList = document.querySelector<HTMLOListElement>("#releases-older");
  const olderRow = document.querySelector<HTMLElement>(".release-older-row");
  const toggle = olderRow?.querySelector<HTMLButtonElement>(".release-older-toggle");
  if (!recentList || !olderList || !olderRow || !toggle) return;

  const { recent, older } = splitReleases(CHANGELOG);
  for (const r of recent) recentList.append(renderRelease(r));
  for (const r of older) olderList.append(renderRelease(r));

  const label = el("span", "release-older-label");
  toggle.append(chevron(), label);
  if (older.length) toggle.append(" ", el("span", "release-older-range", olderRange(older)));
  // The axis runs from the first ring to the last one shown.
  const markEnds = () => {
    const shown = [...recentList.children, ...(olderList.hidden ? [] : [...olderList.children])];
    for (const r of document.querySelectorAll(".release.is-first, .release.is-last")) r.classList.remove("is-first", "is-last");
    shown[0]?.classList.add("is-first");
    shown.at(-1)?.classList.add("is-last");
  };
  const setOlder = (open: boolean) => {
    olderList.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    label.textContent = open ? "Hide older releases" : olderLabel(older.length);
    markEnds();
  };
  toggle.addEventListener("click", () => setOlder(toggle.getAttribute("aria-expanded") !== "true"));
  olderRow.hidden = older.length === 0;
  setOlder(false);

  const index = document.querySelector<HTMLOListElement>(".release-index ol");
  if (index) {
    for (const group of byMonth(CHANGELOG)) {
      const month = el("li", "release-index-month", group.month);
      // The versions say it; the month is a visual group only.
      month.setAttribute("aria-hidden", "true");
      index.append(month);
      for (const r of group.releases) {
        const link = el("a");
        link.href = `#${releaseId(r.version)}`;
        link.append(el("span", "release-index-v", r.version), " ", el("span", "release-index-t", r.title));
        if (r.version === __APP_VERSION__) {
          link.setAttribute("aria-current", "true");
          link.append(el("span", "about-sr", " (current version)"));
        }
        const li = el("li");
        li.append(link);
        index.append(li);
      }
    }
    index.addEventListener("click", (e) => {
      const link = (e.target as Element).closest("a");
      // Modified or non-primary clicks open a new tab or window: the browser's, not ours.
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      history.replaceState(null, "", link.hash);
      show(link.hash);
    });
  }

  /** Opens the fold a release title is in, scrolls to it, and moves focus to it. */
  function show(hash: string): void {
    let target: HTMLElement | null = null;
    try {
      target = document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch {
      return;
    }
    if (!target?.matches(".release-title")) return;
    if (olderList!.contains(target) && olderList!.hidden) setOlder(true);
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }
  // A deep link, on load or later, does what the index does: the fold opens and focus goes to the
  // title (the browser can't focus it while the fold is still hidden).
  if (location.hash) show(location.hash);
  addEventListener("hashchange", () => show(location.hash));
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
  if (!dark) return;
  // Only when the page's theme and the device differ: changing a <source> restarts its picture's
  // selection, and Firefox aborts a fetch already under way (NS_BINDING_ABORTED in about.spec).
  const wantDark = document.documentElement.dataset.theme === "dark";
  if (matchMedia(dark.media).matches !== wantDark) dark.media = wantDark ? "all" : "not all";
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

// The picture first, before its lazy fetch can start.
shot();
renderChangelog();
renderThemes();
reveals();
video();
if (document.readyState === "complete") scene();
else addEventListener("load", scene, { once: true });
