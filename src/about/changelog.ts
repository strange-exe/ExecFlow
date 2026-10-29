// CodeEditor's releases, newest first: the one source for CHANGELOG.md (scripts/write-changelog.mjs
// writes it; a unit test keeps the two equal) and for the About page's "What's new". Every push to
// main deployed the site; pushes that shipped no change to the app (tests, CI) are not versions.
// Up to 0.8.0, later pushes on a release's day were listed under that release. From 0.8.1 on, every
// push that changes what students get (src, public, functions, the HTML pages) is a new version, so
// What's new can announce it. Features bump the minor number, fixes the patch number; the Privacy
// and Terms pages count as fixes, not features.
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
    version: "0.10.0",
    date: "2026-10-29",
    title: "New colours, a What's new timeline, and easier Privacy and Terms",
    items: [
      { kind: "changed", text: "The Signal look: your code sits on a card inside a soft frame, the console is dark in light mode too, and the syntax colours are easier to tell apart." },
      { kind: "changed", text: "What's new on the About page is a timeline: each release with its date and what changed, long ones folded, and a list of releases to jump to." },
      { kind: "changed", text: "Privacy and Terms show where you are in a list of sections, let you copy a link to any section, and print as dark text on paper." },
    ],
  },
  {
    version: "0.9.2",
    date: "2026-10-29",
    title: "Clearing a shared computer clears every tab",
    items: [
      { kind: "fixed", text: "Sign out and clear this computer now also empties CodeEditor in the browser's other open tabs, and ends their GitHub sign-in." },
      { kind: "fixed", text: "A GitHub sign-in renewing itself at the moment you sign out can no longer be saved again afterwards." },
    ],
  },
  {
    version: "0.9.1",
    date: "2026-10-29",
    title: "Opens in Brave and with ad blockers",
    items: [{ kind: "fixed", text: "With Brave or an ad blocker, the site no longer says it couldn't start: a blocked visit counter isn't part of the app." }],
  },
  {
    version: "0.9.0",
    date: "2026-10-29",
    title: "Enter picks the top suggestion, and fixes across the app",
    items: [
      { kind: "changed", text: "Enter accepts the top suggestion, with no arrow key needed. If the top suggestion is just the word you typed, Enter makes a new line." },
      { kind: "added", text: "Settings: \"Enter accepts the top suggestion\" can be turned off, so nothing is picked until you press Down or Up." },
      { kind: "fixed", text: "Picking the main suggestion after typing int or void writes the rest of main, instead of a second type." },
      { kind: "added", text: "The About page's 3D scene has a Pause button, and stops if you turn on reduced motion." },
      { kind: "fixed", text: "Flowcharts: a goto into a block shown as one step, and statements under a case inside a nested block, are drawn instead of dropped. PNG and Copy image now look like the chart on screen." },
      { kind: "fixed", text: "Flowcharts: Retry after a slow chart draws the function you picked, not the first one." },
      { kind: "fixed", text: "Code links: Windows line endings are accepted, a long name that is already taken still gets a free one, and a failed Add keeps the dialog open." },
      { kind: "fixed", text: "Settings: clearing a number field keeps its value instead of dropping to the smallest." },
      { kind: "fixed", text: "The launch video's button reads Pause while the video starts and goes away if the video can't play, and Licences opens the licence file even with the app installed." },
      { kind: "fixed", text: "Flowcharts: if a picked function times out again on Retry, the next Retry charts the program's entry point." },
      { kind: "fixed", text: "Adding an example in a read-only tab, or when storage is full, says why instead of failing quietly." },
      { kind: "fixed", text: "Screen readers announce Cmd, not Ctrl, for shortcuts on a Mac." },
      { kind: "changed", text: "Capture snippet previews update faster." },
      { kind: "fixed", text: "Signing out with a second tab open no longer leaves an error in that tab." },
    ],
  },
  {
    version: "0.8.0",
    date: "2026-10-28",
    title: "Code links",
    items: [
      { kind: "added", text: "Share a file as a code link: the code is inside the link itself, so it opens in CodeEditor for anyone, with no account and nothing uploaded." },
      { kind: "added", text: "Opening a code link shows the code first. It's added to your files only when you choose, and it never runs by itself." },
      { kind: "added", text: "Copy a code link with a title (\"Open main.py in CodeEditor\") for documents and mail, or show it as a QR code to scan from a screen." },
      { kind: "changed", text: "Share link starts with the code link, so sharing works without GitHub. A file too long for a link says so." },
      { kind: "fixed", text: "The Share dialog no longer leaves a gap under the code link while it's being made." },
    ],
  },
  {
    version: "0.7.0",
    date: "2026-10-27",
    title: "A calmer workspace, a new Settings, and an About page",
    items: [
      { kind: "changed", text: "A calmer workspace: a full-height side bar with quick actions, quieter tabs, and a command field in the top bar." },
      { kind: "changed", text: "Settings is now grouped into sections, with switches and + and - buttons for the font size." },
      { kind: "changed", text: "Selected text is see-through in every theme, so your code's colours still show." },
      { kind: "changed", text: "Files your program writes are now saved to your files automatically, with a line in Output instead of a question. A program never writes over your code." },
      { kind: "changed", text: "Flowcharts in colour: start and end, decisions, input and output, and calls each have their own, and Yes and No branches are green and red, on connectors with rounded corners." },
      { kind: "fixed", text: "Flowchart arrows meet their boxes cleanly, with no line joining an arrow from the side." },
      { kind: "fixed", text: "The About page opens correctly after an update, even offline, and never shows an old picture or video." },
      { kind: "added", text: "The version number in Settings, and a one-time What's new note after an update." },
      { kind: "added", text: "An About page: what CodeEditor does, a 20-second video, and this list of changes." },
      { kind: "changed", text: "The Privacy page now says the site uses Cloudflare Web Analytics to count visits." },
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
      { kind: "fixed", text: "If part of the app fails to load, the page now says so and offers Reload, instead of loading forever." },
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
      { kind: "added", text: "A Flowchart tab that draws how your C, C++ or Python code runs. Click a box to jump to its line, or read the steps as a list; it works on phones and full screen." },
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
      { kind: "changed", text: "Signal, a new default look with the Geist typeface." },
      { kind: "changed", text: "Runs, output, the file list, sync and dialogs restyled to match the new look." },
      { kind: "added", text: "Python's first start shows its one-time download as it happens." },
      { kind: "added", text: "When a run stops at the time or output limit, Output says which limit and what to do." },
      { kind: "added", text: "A new file says before it's made when it won't run." },
      { kind: "changed", text: "A C or C++ crash is explained in one plain sentence." },
      { kind: "changed", text: "The Shortcuts list opens with Ctrl+/ only, so typing ? never opens it." },
      { kind: "changed", text: "Connecting GitHub can make a new private repository, and \"Remember on this device\" starts off." },
      { kind: "changed", text: "Sync warns in the top bar until you open a conflict copy, and an edit shows as unsynced at once." },
      { kind: "fixed", text: "On short windows (a phone held sideways, 400% zoom) the page scrolls and nothing covers your code." },
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
    items: [{ kind: "fixed", text: "Buttons no longer flash a hard-to-read colour when they change." }],
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
    items: [{ kind: "fixed", text: "Fixes for Safari: Capture snippet images are the right width, and the file path above the editor no longer flickers." }],
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
