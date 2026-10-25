// Tiny DOM helpers. Every node is built with createElement; text only ever goes in as text nodes
// or textContent, attributes with setAttribute. Nothing here (or anywhere in the UI) parses HTML,
// so file names, program output and repository content can never become markup.
import { tagUnshown } from "../core/safety";

type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue | EventListener>;

function setAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else if (value !== false && value !== null && value !== undefined) {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/** h("button", { class: "tool", type: "button", onClick: fn }, "Label") */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Text that only screen readers get (", unsaved" in a tab name). */
export function srOnly(text: string): HTMLSpanElement {
  return h("span", { class: "visually-hidden" }, text);
}

/**
 * Saves a file to the device's Downloads folder. `parent`: where the hidden link goes (inside an
 * open modal dialog, since the rest of the page is inert then); `keepMs`: how long the blob URL
 * lives (iOS fetches it only after its download prompt).
 */
export function downloadBlob(name: string, blob: Blob, { keepMs = 1000, parent = document.body }: { keepMs?: number; parent?: ParentNode } = {}): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, rel: "noopener" });
  a.hidden = true;
  parent.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), keepMs);
}

export function downloadText(name: string, text: string, type = "text/plain;charset=utf-8"): void {
  downloadBlob(name, new Blob([text], { type }));
}

/** True when a key event comes from a place where typing goes into text (fields, the editor). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-editor")) return true;
  const el = target as HTMLElement;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ||
    (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(el.type));
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Untrusted text (a file name, a repository's name, a reason that quotes one) made safe to put in
 * a sentence: each direction, invisible, format or control character becomes a visible tag such as
 * "[U+202E]", so it can neither reorder nor hide the rest of the sentence. (A <bdi> wrapper is not
 * enough: an override inside it still reverses the text it covers.) The rule is core/safety.ts
 * tagUnshown, shared with the DOM-free snippet module.
 */
export const shown = tagUnshown;

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** "a.c, b.c and c.c"; long lists end with "and N more". */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
