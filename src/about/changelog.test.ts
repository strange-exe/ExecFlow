/// <reference types="node" />
// The release history (0.7.0 versions unit): one typed data module is the source; CHANGELOG.md at the
// repo root is written from it (scripts/write-changelog.mjs) and must match it, and its newest
// version is package.json's, which the build injects as __APP_VERSION__.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANGELOG, KINDS, changelogMarkdown } from "./changelog";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("the changelog data", () => {
  it("every release has a semantic version, a real date, a title and at least one item of a known kind", () => {
    expect(CHANGELOG.length).toBeGreaterThan(10);
    for (const r of CHANGELOG) {
      expect(r.version, r.version).toMatch(SEMVER);
      expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.date)), r.version).toBe(false);
      expect(r.title.trim().length, r.version).toBeGreaterThan(0);
      expect(r.items.length, r.version).toBeGreaterThan(0);
      for (const item of r.items) {
        expect(KINDS, `${r.version}: ${item.text}`).toContain(item.kind);
        expect(item.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("newest first: versions strictly descending, dates never going up, no version twice", () => {
    const key = (v: string) => v.split(".").map((n) => n.padStart(6, "0")).join(".");
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(key(CHANGELOG[i - 1].version) > key(CHANGELOG[i].version), `${CHANGELOG[i - 1].version} after ${CHANGELOG[i].version}`).toBe(true);
      expect(CHANGELOG[i - 1].date >= CHANGELOG[i].date, CHANGELOG[i].version).toBe(true);
    }
    expect(new Set(CHANGELOG.map((r) => r.version)).size).toBe(CHANGELOG.length);
  });

  it("the newest release is package.json's version; the first is 0.1.0", () => {
    expect(CHANGELOG[0].version).toBe(pkg.version);
    expect(CHANGELOG.at(-1)!.version).toBe("0.1.0");
  });

  it("CHANGELOG.md is what the data writes (run node scripts/write-changelog.mjs after editing the data)", () => {
    expect(readFileSync("CHANGELOG.md", "utf8").replace(/\r\n/g, "\n")).toBe(changelogMarkdown());
  });

  it("the markdown follows Keep a Changelog 1.1.0: a heading per release with its date, items under their kind", () => {
    const md = changelogMarkdown();
    expect(md.startsWith("# Changelog\n")).toBe(true);
    expect(md).toContain("https://keepachangelog.com/en/1.1.0/");
    expect(md).toContain(`## [${CHANGELOG[0].version}] - ${CHANGELOG[0].date}`);
    expect(md).toContain("## [0.1.0] - 2026-10-18");
    expect(md).toMatch(/\n### Added\n\n- /);
  });
});
