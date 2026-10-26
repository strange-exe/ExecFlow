// Test helper (unit tests only): the few DOM calls the flowchart renderer makes (createElementNS,
// createTextNode, setAttribute, appendChild, textContent), recorded as a tree, plus an XML
// serializer that escapes text and attribute values the way XMLSerializer does. The project's unit
// tests run in Node with no DOM library; the real browser rendering is checked end to end once the
// Flowchart view exists.

export class FakeText {
  readonly nodeType = 3;
  constructor(public data: string) {}
}

export class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  children: (FakeElement | FakeText)[] = [];
  constructor(
    readonly namespaceURI: string | null,
    readonly tagName: string,
  ) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.children.push(child);
    return child;
  }
  append(...nodes: (FakeElement | FakeText | string)[]) {
    for (const n of nodes) this.children.push(typeof n === "string" ? new FakeText(n) : n);
  }
  set textContent(text: string) {
    this.children = [new FakeText(text)];
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join("");
  }
  /** Every element below this one (depth-first), itself first. */
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => (c instanceof FakeElement ? c.all() : []))];
  }
  /** Every text node below this one. */
  texts(): FakeText[] {
    return this.children.flatMap((c) => (c instanceof FakeText ? [c] : c.texts()));
  }
}

export const fakeDocument = {
  createElementNS: (ns: string | null, tag: string) => new FakeElement(ns, tag),
  createTextNode: (text: string) => new FakeText(text),
};

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

export function serialize(node: FakeElement | FakeText): string {
  if (node instanceof FakeText) return escapeText(node.data);
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  return `<${node.tagName}${attrs}>${node.children.map(serialize).join("")}</${node.tagName}>`;
}
