# Changelog

Every change to CodeEditor that reached the site, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is written from `src/about/changelog.ts` by `node scripts/write-changelog.mjs`: edit the data, not this file.

## [0.11.0] - 2026-10-29

Guides for Python, C, C++ and flowcharts, and a clearer Capture snippet

### Added

- Guide pages for Python, C, C++ and turning code into a flowchart, each with real examples, their output and a link that opens the code here.
- An About link in the editor, and titles, descriptions and a preview picture for search results and shared links.

### Changed

- Capture snippet: a large preview, colour choices as pictures, switches for line numbers and the file name, and Copy image always at the bottom.
- What's new: each kind of change has its own colour, and the current release has a light running round its edge.

### Fixed

- An address that doesn't exist shows a Page not found page instead of opening the editor.

## [0.10.0] - 2026-10-29

New colours, a What's new timeline, and easier Privacy and Terms

### Changed

- The Signal look: your code sits on a card inside a soft frame, the console is dark in light mode too, and the syntax colours are easier to tell apart.
- What's new on the About page is a timeline: each release with its date and what changed, long ones folded, and a list of releases to jump to.
- Privacy and Terms show where you are in a list of sections, let you copy a link to any section, and print as dark text on paper.

## [0.9.2] - 2026-10-29

Clearing a shared computer clears every tab

### Fixed

- Sign out and clear this computer now also empties CodeEditor in the browser's other open tabs, and ends their GitHub sign-in.
- A GitHub sign-in renewing itself at the moment you sign out can no longer be saved again afterwards.

## [0.9.1] - 2026-10-29

Opens in Brave and with ad blockers

### Fixed

- With Brave or an ad blocker, the site no longer says it couldn't start: a blocked visit counter isn't part of the app.

## [0.9.0] - 2026-10-29

Enter picks the top suggestion, and fixes across the app

### Added

- Settings: "Enter accepts the top suggestion" can be turned off, so nothing is picked until you press Down or Up.
- The About page's 3D scene has a Pause button, and stops if you turn on reduced motion.

### Changed

- Enter accepts the top suggestion, with no arrow key needed. If the top suggestion is just the word you typed, Enter makes a new line.
- Capture snippet previews update faster.

### Fixed

- Picking the main suggestion after typing int or void writes the rest of main, instead of a second type.
- Flowcharts: a goto into a block shown as one step, and statements under a case inside a nested block, are drawn instead of dropped. PNG and Copy image now look like the chart on screen.
- Flowcharts: Retry after a slow chart draws the function you picked, not the first one.
- Code links: Windows line endings are accepted, a long name that is already taken still gets a free one, and a failed Add keeps the dialog open.
- Settings: clearing a number field keeps its value instead of dropping to the smallest.
- The launch video's button reads Pause while the video starts and goes away if the video can't play, and Licences opens the licence file even with the app installed.
- Flowcharts: if a picked function times out again on Retry, the next Retry charts the program's entry point.
- Adding an example in a read-only tab, or when storage is full, says why instead of failing quietly.
- Screen readers announce Cmd, not Ctrl, for shortcuts on a Mac.
- Signing out with a second tab open no longer leaves an error in that tab.

## [0.8.0] - 2026-10-28

Code links

### Added

- Share a file as a code link: the code is inside the link itself, so it opens in CodeEditor for anyone, with no account and nothing uploaded.
- Opening a code link shows the code first. It's added to your files only when you choose, and it never runs by itself.
- Copy a code link with a title ("Open main.py in CodeEditor") for documents and mail, or show it as a QR code to scan from a screen.

### Changed

- Share link starts with the code link, so sharing works without GitHub. A file too long for a link says so.

### Fixed

- The Share dialog no longer leaves a gap under the code link while it's being made.

## [0.7.0] - 2026-10-27

A calmer workspace, a new Settings, and an About page

### Added

- The version number in Settings, and a one-time What's new note after an update.
- An About page: what CodeEditor does, a 20-second video, and this list of changes.

### Changed

- A calmer workspace: a full-height side bar with quick actions, quieter tabs, and a command field in the top bar.
- Settings is now grouped into sections, with switches and + and - buttons for the font size.
- Selected text is see-through in every theme, so your code's colours still show.
- Files your program writes are now saved to your files automatically, with a line in Output instead of a question. A program never writes over your code.
- Flowcharts in colour: start and end, decisions, input and output, and calls each have their own, and Yes and No branches are green and red, on connectors with rounded corners.
- The Privacy page now says the site uses Cloudflare Web Analytics to count visits.

### Fixed

- Flowchart arrows meet their boxes cleanly, with no line joining an arrow from the side.
- The About page opens correctly after an update, even offline, and never shows an old picture or video.

## [0.6.2] - 2026-10-27

Phone tabs fit small screens

### Fixed

- On 320 px wide phones the four view tabs fit again, so the page no longer scrolls sideways.

## [0.6.1] - 2026-10-27

Privacy, terms and a sturdier flowchart

### Added

- Privacy and Terms pages, linked from Settings, and every open-source licence at /licenses.txt.

### Fixed

- If part of the app fails to load, the page now says so and offers Reload, instead of loading forever.
- A function with hundreds of break and continue lines no longer freezes the page: the chart says it is too big.
- Functions that share a name (C++ overloads) can each be picked in the Flowchart.
- Flowchart images keep non-English function names in their file names.

## [0.6.0] - 2026-10-26

Flowcharts

### Added

- A Flowchart tab that draws how your C, C++ or Python code runs. Click a box to jump to its line, or read the steps as a list; it works on phones and full screen.
- Export a flowchart as a PNG or SVG image.

### Changed

- Capture snippet has a new dialog with a full preview.

## [0.5.1] - 2026-10-26

The app icon follows Signal

### Changed

- The app icon and the installed app use the Signal colours.
- Capture snippet and Save as PDF follow the default theme.

## [0.5.0] - 2026-10-25

The Signal look

### Added

- Python's first start shows its one-time download as it happens.
- When a run stops at the time or output limit, Output says which limit and what to do.
- A new file says before it's made when it won't run.

### Changed

- Signal, a new default look with the Geist typeface.
- Runs, output, the file list, sync and dialogs restyled to match the new look.
- A C or C++ crash is explained in one plain sentence.
- The Shortcuts list opens with Ctrl+/ only, so typing ? never opens it.
- Connecting GitHub can make a new private repository, and "Remember on this device" starts off.
- Sync warns in the top bar until you open a conflict copy, and an edit shows as unsynced at once.

### Fixed

- On short windows (a phone held sideways, 400% zoom) the page scrolls and nothing covers your code.

## [0.4.1] - 2026-10-24

One command palette at a time

### Fixed

- The command palette never opens twice.

## [0.4.0] - 2026-10-24

Share links

### Added

- Share a file: a link to it in your repository, or a secret gist.
- Sync with a message of your own.

### Changed

- Sync commits are named after the files they change.

## [0.3.1] - 2026-10-23

Buttons change colour cleanly

### Fixed

- Buttons no longer flash a hard-to-read colour when they change.

## [0.3.0] - 2026-10-23

Sign in with GitHub

### Added

- Sign in with GitHub, instead of pasting a token.
- 15 more colour themes.
- Save as PDF.
- Plain-language help for common Python, C and C++ errors.

## [0.2.1] - 2026-10-23

Safari fixes

### Fixed

- Fixes for Safari: Capture snippet images are the right width, and the file path above the editor no longer flickers.

## [0.2.0] - 2026-10-23

Command palette and Capture snippet

### Added

- A command palette, example programs and run arguments.
- Capture snippet: an image of your code to share.
- Suggestions that know the standard libraries and the names in your workspace.

### Changed

- The Deep Field look, a new icon, and clearer messages when connecting to GitHub fails.

## [0.1.1] - 2026-10-18

Problems keeps your place

### Fixed

- The Problems list keeps keyboard focus when it updates.

## [0.1.0] - 2026-10-18

First release

### Added

- Write and run Python, C and C++ in the browser, with nothing to install.
- Keep your files in a private GitHub repository.
