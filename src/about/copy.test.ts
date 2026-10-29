/// <reference types="node" />
// Claims on the About page that the app has moved past. Since 0.8.0 a share is first a code link
// (the code inside the link, no account); the repository link and the secret gist come after.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("about.html", "utf8");

describe("the About page's copy", () => {
  it("names the code link first among the ways to share", () => {
    const line = /<li><strong>Shared with one link\.<\/strong>([^<]*)<\/li>/.exec(html)?.[1] ?? "";
    expect(line).toMatch(/inside the link/);
    expect(line).toMatch(/no account/);
    expect(line.indexOf("inside the link")).toBeLessThan(line.indexOf("repository"));
    expect(line).toMatch(/secret gist/);
  });
});
