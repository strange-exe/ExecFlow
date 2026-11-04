/// <reference types="node" />
// Claims on the About page that the app has moved past. Since 0.8.0 a share is first a code link
// (the code inside the link, no account); the repository link and the secret gist come after.
import { readFileSync, statSync } from "node:fs";
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

  // The launch video (0.29.0) is 23 seconds: five beats of the current app, then the end card.
  it("describes the launch video as it is: its length, every beat in order, and the file's size", () => {
    expect(/<h2 id="video-title">([^<]*)<\/h2>/.exec(html)?.[1]).toBe("ExecFlow in 23 seconds");
    expect(html).not.toMatch(/20[- ]second/);
    const list = /<div class="about-note" id="video-text">[\s\S]*?<ol>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? "";
    const beats = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(beats).toHaveLength(6);
    for (const [i, start] of ["Write code.", "Run it.", "See how it flows.", "Every box is a line of your code.", "On your phone too.", "The ExecFlow mark"].entries()) {
      expect(beats[i], `beat ${i + 1}`).toMatch(new RegExp(`^${start.replace(/\./g, "[.]")}`));
    }
    expect(beats[1]).toMatch(/Hello, Abhinesh/);
    expect(beats[4]).toMatch(/Run sits in reach of your thumb/);
    expect(beats[5]).toMatch(/Open the editor/);
    expect(beats[5]).toMatch(/execflow\.abhinesh\.codes/);
  });

  it("gives the video file's real size beside its download link", () => {
    const m = /<a href="\/media\/([^"]+\.mp4)" download="execflow\.mp4">Download the video<\/a> \(MP4, ([0-9.]+) MB\)/.exec(html);
    expect(m).not.toBeNull();
    const mb = statSync(`public/media/${m![1]}`).size / 1_000_000;
    expect(m![2]).toBe(mb.toFixed(1));
  });
});
