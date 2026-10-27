/// <reference types="node" />
// The About page's images and video live in public/media/ and are served immutable and cached
// CacheFirst by the service worker (vite.config.ts), so a file whose bytes change must change its
// name too, or visitors keep the old one. Each name ends in the first 8 hex digits of its sha256.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "public/media";
const files = readdirSync(DIR);
const html = readFileSync("about.html", "utf8");

describe("the About page's media files", () => {
  it.each(files)("%s is named after its content", (name) => {
    const hash = createHash("sha256").update(readFileSync(`${DIR}/${name}`)).digest("hex");
    const match = /^[a-z0-9.-]+\.([0-9a-f]{8})\.(webp|mp4)$/.exec(name);
    expect(match, `${name}: rename it to <name>.${hash.slice(0, 8)}.<ext>`).not.toBeNull();
    expect(match![1], `${name}: its bytes changed; rename it to <name>.${hash.slice(0, 8)}.<ext>`).toBe(hash.slice(0, 8));
  });

  it("every file about.html names exists, and every file is used", () => {
    const named = new Set([...html.matchAll(/\/media\/([^"\s]+)/g)].map((m) => m[1]));
    expect([...named].filter((name) => !files.includes(name))).toEqual([]);
    expect(files.filter((name) => !named.has(name))).toEqual([]);
  });
});
