# Changelog

Every change to ExecFlow (CodeEditor before 0.16.0) that reached the site, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is written from `src/about/changelog.ts` by `node scripts/write-changelog.mjs`: edit the data, not this file.

## [0.18.1] - 2026-10-31

The editor arrives in smaller pieces

### Changed

- The colours, folding and suggestions for Python, and for C and C++, now load as their own small downloads with the first file of that language, so the editor's main download is about a third smaller. Files open looking and working as before.

## [0.18.0] - 2026-10-30

Download and share a few files, or a whole folder

### Added

- Download a file from its menu in the file list, exactly as it is saved, or a folder as a .zip that unpacks to that folder. The search has both for the open file.
- Choose files to download or share: tick files and whole folders, then download them as one .zip, or share them in one code link.
- A code link can carry a folder. Opening it shows each file first, and Add puts them in a new folder at the top, never mixed with your files.

### Changed

- New code a program writes (a .py, .c, .cpp or header file) waits for you to keep it, since later runs would build it. Data files are saved at once, as before.
- A Python program saves only the files it writes in its own folder, as C and C++ programs already did, and a program from another folder starts with a fresh Python. So a program from a shared folder can't change the files in your other folders.

## [0.17.0] - 2026-10-30

A new C and C++ compiler, with exceptions

### Added

- C++ exceptions work: throw, try and catch. An exception nobody catches stops the program, and ExecFlow says so.
- Settings offers C23 (c23, gnu23) and C++20 and C++23. A file set to c++2a is now built as C++20.

### Changed

- C and C++ now build with clang 22 and libc++ 22, up from clang 8. Messages read the way current compilers word them, and ExecFlow still explains the common ones in plain words.
- The one-time C/C++ download is now 29.3 MB, up from 19.6 MB. It needs Chrome or Edge 137, Firefox 131 or Safari 18.4, or newer; an older browser is told so, and Python still works in it.

### Fixed

- A program with no main() now says it needs one, instead of building and failing when it starts.
- The first program that includes <bits/stdc++.h> has more time to prepare it, so a slower computer doesn't stop it halfway.

## [0.16.0] - 2026-10-30

CodeEditor is now ExecFlow

### Added

- A new wordmark beside the mark at the top of every page: Exec in the code font, Flow in blue.
- Settings shows the wordmark beside the version, at the foot.

### Changed

- The editor has a new name, ExecFlow: you write code, run it, and see how it flows. Your files, settings and GitHub sync stay just as they were.
- The link preview picture shown when you share the site, and the 20-second video on the About page, carry the new name.

## [0.15.0] - 2026-10-30

Every theme on show in Settings

### Added

- Search the themes by name, or show only light or only dark ones. The search and the filter stay at the top while you scroll the themes.

### Changed

- Settings opens on the colour themes: 45 themes in 22 families, each with a small preview of code in its own colours, and its light and dark forms side by side.
- Six themes lead under Start here; the rest follow A to Z, and themes you loaded from a file come last.
- A theme applies the moment you choose it, with the mouse or the arrow keys, and Settings opens on the one you use.

## [0.14.0] - 2026-10-30

A flowchart that fits, with a key to its shapes

### Added

- A key under the flowchart names each shape it uses: start and end, step, input or output, decision, function call, and label.

### Changed

- The flowchart opens fitted whole in its panel, so you see from Start to the end without scrolling. A very long one stays readable and scrolls down.
- Its controls sit in one bar: the function, zoom out, zoom in, Fit, Steps as text, Export and Full screen.

### Fixed

- On medium-width screens, a C or C++ file waiting for its one-time download no longer pushes the Run button out of the window.

## [0.13.0] - 2026-10-30

A new editor layout

### Added

- On phones, a bar at the bottom switches between Files, Code, Output, Problems and Flowchart.

### Changed

- On wide screens (from 1100 px) the output sits beside your code, with a handle to make either side wider. Narrower screens keep it under the code.
- A rail at the left holds Files, Search, Flowchart, New file, Shortcuts and Settings, and the top bar shows where you are: workspace, folders and file.
- A failed run shows its error as one clear line above the output, and the output's tabs, full screen and hide buttons sit together at its top.
- With no file open, the start page offers one New file button and a short list of other ways to begin.

## [0.12.0] - 2026-10-30

A new address: execflow.abhinesh.codes

### Added

- A Move my files button at the old address that copies your files to the new one, after you say yes there. They stay at the old address too.

### Changed

- The site's new address is execflow.abhinesh.codes. The old address keeps working for now.
- Links to the source code and to issues point to the renamed GitHub repository.

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
