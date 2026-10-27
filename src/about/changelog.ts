// CodeEditor's releases, newest first: the one source for CHANGELOG.md (scripts/write-changelog.mjs
// writes it; a unit test keeps the two equal) and for the About page's "What's new". Every push to
// main deployed the site; pushes that shipped no change to the app (tests, CI) are not versions.
// Dates are the day the release went live (India time). No DOM code here: the About page renders it.

export const KINDS = ["added", "changed", "fixed"] as const;
export type Kind = (typeof KINDS)[number];

export interface Release {
  version: string;
  /** YYYY-MM-DD, the day it went live. */
  date: string;
  title: string;
  items: { kind: Kind; text: string }[];
}

export const CHANGELOG: readonly Release[] = [
  {
    version: "0.7.0",
    date: "2026-10-27",
    title: "A calmer workspace, a new Settings, and an About page",
    items: [
      { kind: "changed", text: "A calmer workspace: a full-height side bar with quick actions, quieter tabs, and a command field in the top bar." },
      { kind: "changed", text: "Settings is now a two-pane dialog with sections, switches and a font-size stepper." },
      { kind: "added", text: "The version number in Settings, and a one-time What's new note after an update." },
      { kind: "added", text: "An About page: what CodeEditor does, and this list of changes." },
    ],
  },
  {
    version: "0.6.2",
    date: "2026-10-27",
    title: "Phone tabs fit small screens",
    items: [{ kind: "fixed", text: "On 320 px wide phones the four view tabs fit again, so the page no longer scrolls sideways." }],
  },
  {
    version: "0.6.1",
    date: "2026-10-27",
    title: "Privacy, terms and a sturdier flowchart",
    items: [
      { kind: "added", text: "Privacy and Terms pages, linked from Settings, and every open-source licence at /licenses.txt." },
      { kind: "added", text: "If part of the app fails to load, the page says so and offers Reload instead of loading forever." },
      { kind: "fixed", text: "A function with hundreds of break and continue lines no longer freezes the page: the chart says it is too big." },
      { kind: "fixed", text: "Functions that share a name (C++ overloads) can each be picked in the Flowchart." },
      { kind: "fixed", text: "Flowchart images keep non-English function names in their file names." },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-10-26",
    title: "Flowcharts",
    items: [
      { kind: "added", text: "A Flowchart tab that draws how your C, C++ or Python code runs, with click-to-line and a step list." },
      { kind: "added", text: "Export a flowchart as a PNG or SVG image." },
      { kind: "changed", text: "Capture snippet has a new dialog with a full preview." },
    ],
  },
  {
    version: "0.5.1",
    date: "2026-10-26",
    title: "The app icon follows Signal",
    items: [
      { kind: "changed", text: "The app icon and the installed app use the Signal colours." },
      { kind: "changed", text: "Capture snippet and Save as PDF follow the default theme." },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-10-25",
    title: "The Signal look",
    items: [
      { kind: "changed", text: "Signal is the new default theme, with the Geist typeface." },
      { kind: "changed", text: "A polish pass on runs, output, files, sync and dialogs." },
    ],
  },
  {
    version: "0.4.1",
    date: "2026-10-24",
    title: "One command palette at a time",
    items: [{ kind: "fixed", text: "The command palette never opens twice." }],
  },
  {
    version: "0.4.0",
    date: "2026-10-24",
    title: "Share links",
    items: [
      { kind: "added", text: "Share a file: a link to it in your repository, or a secret gist." },
      { kind: "added", text: "Sync with a message of your own." },
      { kind: "changed", text: "Sync commits are named after the files they change." },
    ],
  },
  {
    version: "0.3.1",
    date: "2026-10-23",
    title: "Buttons change colour cleanly",
    items: [{ kind: "fixed", text: "A button's colour and its label now change together." }],
  },
  {
    version: "0.3.0",
    date: "2026-10-23",
    title: "Sign in with GitHub",
    items: [
      { kind: "added", text: "Sign in with GitHub, instead of pasting a token." },
      { kind: "added", text: "15 more colour themes." },
      { kind: "added", text: "Save as PDF." },
      { kind: "added", text: "Plain-language help for common Python, C and C++ errors." },
    ],
  },
  {
    version: "0.2.1",
    date: "2026-10-23",
    title: "Safari fixes",
    items: [{ kind: "fixed", text: "Problems seen in Safari's engine (WebKit)." }],
  },
  {
    version: "0.2.0",
    date: "2026-10-23",
    title: "Command palette and Capture snippet",
    items: [
      { kind: "added", text: "A command palette, example programs and run arguments." },
      { kind: "added", text: "Capture snippet: an image of your code to share." },
      { kind: "added", text: "Suggestions that know the standard libraries and the names in your workspace." },
      { kind: "changed", text: "The Deep Field look, a new icon, and clearer messages when connecting to GitHub fails." },
    ],
  },
  {
    version: "0.1.1",
    date: "2026-10-18",
    title: "Problems keeps your place",
    items: [{ kind: "fixed", text: "The Problems list keeps keyboard focus when it updates." }],
  },
  {
    version: "0.1.0",
    date: "2026-10-18",
    title: "First release",
    items: [
      { kind: "added", text: "Write and run Python, C and C++ in the browser, with nothing to install." },
      { kind: "added", text: "Keep your files in a private GitHub repository." },
    ],
  },
];

const HEADINGS: Record<Kind, string> = { added: "Added", changed: "Changed", fixed: "Fixed" };

/** CHANGELOG.md, in the Keep a Changelog 1.1.0 layout (https://keepachangelog.com/en/1.1.0/). */
export function changelogMarkdown(releases: readonly Release[] = CHANGELOG): string {
  const out = [
    "# Changelog",
    "",
    "Every change to CodeEditor that reached the site, newest first. The format is based on",
    "[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow",
    "[Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
    "",
    "This file is written from `src/about/changelog.ts` by `node scripts/write-changelog.mjs`: edit the data, not this file.",
  ];
  for (const r of releases) {
    out.push("", `## [${r.version}] - ${r.date}`, "", r.title);
    for (const kind of KINDS) {
      const items = r.items.filter((i) => i.kind === kind);
      if (!items.length) continue;
      out.push("", `### ${HEADINGS[kind]}`, "", ...items.map((i) => `- ${i.text}`));
    }
  }
  return `${out.join("\n")}\n`;
}
