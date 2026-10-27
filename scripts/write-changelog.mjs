// Writes CHANGELOG.md from src/about/changelog.ts (Node 22.18+ reads the TypeScript module itself).
// Run it after editing the data: `node scripts/write-changelog.mjs`. A unit test checks the two match.
import { writeFileSync } from "node:fs";
import { changelogMarkdown } from "../src/about/changelog.ts";

writeFileSync(new URL("../CHANGELOG.md", import.meta.url), changelogMarkdown());
console.log("CHANGELOG.md written");
