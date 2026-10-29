// The Privacy and Terms pages' script (privacy.html, terms.html). The pages read fully without it:
// the section lists are static HTML and the phone list is a native <details>. This adds what needs
// script: the scroll spy (aria-current="true" on the section being read, and its name on the phone
// bar), a copy-link button beside every numbered heading with a role=status toast, and closing the
// phone list once a section is chosen. html[data-legal="ready"] marks it wired (e2e/legal.spec.ts).
import { pinReleased, reachesLine, readingIndex } from "./spy";

const SVG = "http://www.w3.org/2000/svg";
const TOAST_MS = 2400;

type Section = { id: string; n: string; text: string; head: HTMLElement };

/** The address bar's #id; a malformed one (a broken or hand-edited link) names no section. */
function hashId(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
}

function linkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l.9-.9");
  svg.append(path);
  return svg;
}

function sections(): Section[] {
  return [...document.querySelectorAll<HTMLElement>(".legal-h > :is(h2, h3)[id]")].map((head) => ({
    id: head.id,
    n: head.querySelector(".legal-n")?.textContent?.trim() ?? "",
    text: head.querySelector(".legal-tx")?.textContent?.trim() ?? "",
    head,
  }));
}

function start() {
  const root = document.documentElement;
  const all = sections();
  const toast = document.querySelector<HTMLElement>(".legal-toast");
  const phone = document.querySelector<HTMLDetailsElement>("details.legal-toc-m");
  const phoneLabel = phone?.querySelector<HTMLElement>("[data-current-label]") ?? null;
  const shortLabel = phoneLabel?.textContent ?? "";
  const links = [...document.querySelectorAll<HTMLAnchorElement>("ol.legal-toc a[href^='#']")];

  // A chosen section whose heading can't scroll up to the reading line (the short ones at the end),
  // until its heading has been in the window and left it again (a smooth scroll or the browser's
  // jump to an old link's #id starts with the heading still out of the window). A heading that can
  // reach the line holds no pin: the spy finds it there, and scrolling back up reads what is above.
  let pinned = -1;
  let pinSeen = false;
  const pin = (id: string) => {
    pinned = all.findIndex((s) => s.id === id);
    pinSeen = false;
  };

  function spy() {
    const viewport = innerHeight;
    const line = Math.min(160, viewport * 0.2);
    const tops = all.map((s) => s.head.getBoundingClientRect().top);
    if (pinned >= 0) {
      const maxScroll = root.scrollHeight - viewport;
      if (reachesLine(scrollY + tops[pinned], line, maxScroll)) pinned = -1;
      else if (!pinReleased(tops[pinned], viewport)) pinSeen = true;
      else if (pinSeen) pinned = -1;
    }
    const at = readingIndex(tops, line, pinned, viewport);
    const id = at >= 0 ? all[at].id : "short";
    for (const a of links) {
      if (a.getAttribute("href") === `#${id}` && at >= 0) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
    if (phone && phone.dataset.current !== id) {
      phone.dataset.current = id;
      if (phoneLabel) phoneLabel.textContent = at >= 0 ? `${all[at].n} ${all[at].text}` : shortLabel;
    }
  }

  // Copy-link buttons, beside each heading (inside it, the button's name would join the heading's).
  let timer = 0;
  function announce(section: Section, copied: boolean) {
    if (!toast) return;
    toast.textContent = copied
      ? `Link to section ${section.n} copied`
      : `Couldn't copy: the link to section ${section.n} is in the address bar`;
    toast.dataset.state = copied ? "copied" : "failed";
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      toast.textContent = "";
      toast.dataset.state = "idle";
    }, TOAST_MS);
  }
  for (const section of all) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legal-anchor";
    button.setAttribute("aria-label", `Copy link to section ${section.n}, ${section.text}`);
    button.append(linkIcon());
    button.addEventListener("click", () => {
      const url = `${location.href.split("#")[0]}#${section.id}`;
      history.replaceState(history.state, "", `#${section.id}`);
      pin(section.id);
      spy();
      const write = navigator.clipboard?.writeText(url);
      if (!write) return announce(section, false);
      write.then(
        () => announce(section, true),
        () => announce(section, false),
      );
    });
    section.head.after(button);
  }

  // Choosing a section marks it (the last ones can't scroll up to the reading line) and closes the phone list.
  for (const a of links) {
    a.addEventListener("click", () => {
      pin((a.getAttribute("href") ?? "").slice(1));
      if (phone?.contains(a)) phone.open = false;
      schedule();
    });
  }
  addEventListener("hashchange", () => {
    pin(hashId());
    spy();
  });
  if (location.hash) {
    pin(hashId());
    landAgain();
  }

  // An old link's #id: the browser jumps to the heading before the fonts swap in, and the swap
  // reflows the text above it, which leaves the heading short of the top or cut off. Once the page
  // and its fonts have loaded, land it again, unless the reader has moved on meanwhile.
  // html[data-legal-hash="landed"] marks it done (e2e/legal.spec.ts).
  function landAgain() {
    let moved = false;
    const intents = ["wheel", "touchstart", "keydown", "pointerdown"];
    const stop = () => {
      moved = true;
    };
    for (const type of intents) addEventListener(type, stop, { passive: true });
    const loaded = document.readyState === "complete"
      ? Promise.resolve()
      : new Promise<void>((done) => addEventListener("load", () => done(), { once: true }));
    // The first swap can lay out text in another face (a weight, italic) that only then starts to
    // load, after fonts.ready has settled: wait until two frames pass with nothing loading.
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const fontsSettled = async () => {
      do {
        await document.fonts.ready;
        await frame();
      } while (document.fonts.status !== "loaded");
    };
    void loaded.then(fontsSettled).then(() => {
      for (const type of intents) removeEventListener(type, stop);
      const target = document.getElementById(hashId());
      if (!moved && target) target.scrollIntoView({ block: "start", behavior: "instant" });
      root.dataset.legalHash = "landed";
    });
  }

  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      spy();
    });
  };
  // Printing uses the default light tokens (dark text on paper) whichever theme is on screen, then
  // restores it. A palette theme's colours are inline custom properties on <html> (theme-boot.js),
  // which win over any token, so they come off for the print too (through the CSSOM, as theme-boot.js
  // set them: the Content-Security-Policy forbids writing a style attribute).
  type Inline = [name: string, value: string, priority: string];
  let screen: { theme?: string; palette?: string; inline: Inline[] } | undefined;
  addEventListener("beforeprint", () => {
    if (screen) return;
    const inline: Inline[] = [...root.style]
      .filter((name) => name.startsWith("--"))
      .map((name) => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]);
    screen = { theme: root.dataset.theme, palette: root.dataset.palette, inline };
    for (const [name] of inline) root.style.removeProperty(name);
    root.dataset.theme = "light";
    root.dataset.palette = "signal";
  });
  addEventListener("afterprint", () => {
    if (!screen) return;
    const { theme, palette, inline } = screen;
    screen = undefined;
    if (theme === undefined) delete root.dataset.theme;
    else root.dataset.theme = theme;
    if (palette === undefined) delete root.dataset.palette;
    else root.dataset.palette = palette;
    for (const [name, value, priority] of inline) root.style.setProperty(name, value, priority);
  });

  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  spy();
  root.dataset.legal = "ready";
}

start();
