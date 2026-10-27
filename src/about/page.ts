// The About page (about.html): the changelog from the release data, the build's version, a strip of
// the built-in colour themes drawn from their own palettes, restrained reveals, and the hero's
// three.js scene, loaded only after the first paint and only where it can run. Every string from the
// data goes in as text (textContent / createTextNode), never as markup.
import { CHANGELOG, KINDS, type Kind } from "./changelog";
import { BUILT_IN, themePalette } from "../theme/themes";

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

function renderChangelog(): void {
  const list = document.querySelector(".about-releases");
  if (!list) return;
  for (const r of CHANGELOG) {
    const item = el("li", "release");
    const head = el("h3");
    head.append(el("span", "release-version", r.version), " ", el("span", "release-title", r.title));
    const time = el("time", "release-date", longDate(r.date));
    time.dateTime = r.date;
    item.append(head, time);
    for (const kind of KINDS) {
      const items = r.items.filter((i) => i.kind === kind);
      if (!items.length) continue;
      const group = el("ul", "release-items");
      group.dataset.kind = kind;
      group.setAttribute("aria-label", KIND_WORD[kind]);
      for (const i of items) {
        const li = el("li");
        li.append(el("span", "release-kind", KIND_WORD[kind]), " ", document.createTextNode(i.text));
        group.append(li);
      }
      item.append(group);
    }
    list.append(item);
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

/** Secondary sections settle in as they arrive: they start readable (never from opacity 0) and nothing moves with reduced motion. */
function reveals(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
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

/** The hero scene, after the first paint: the poster stays where WebGL or motion isn't welcome. */
function scene(): void {
  const host = document.querySelector<HTMLElement>(".about-scene");
  if (!host) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    host.dataset.scene = "still";
    return;
  }
  const start = () => {
    host.dataset.scene = "loading";
    import("./scene")
      .then((m) => m.mountScene(host))
      .catch(() => {
        // The scene's code didn't arrive (offline before it was cached): the poster is the hero.
        host.dataset.scene = "unavailable";
      });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 1500 });
  else setTimeout(start, 300);
}

renderChangelog();
renderThemes();
reveals();
if (document.readyState === "complete") scene();
else addEventListener("load", scene, { once: true });
