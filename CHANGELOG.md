# Changelog

Every change to CodeEditor that reached the site, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is written from `src/about/changelog.ts` by `node scripts/write-changelog.mjs`: edit the data, not this file.

## [0.7.0] - 2026-10-27

A calmer workspace, a new Settings, and an About page

### Added

- The version number in Settings, and a one-time What's new note after an update.
- An About page: what CodeEditor does, and this list of changes.

### Changed

- A calmer workspace: a full-height side bar with quick actions, quieter tabs, and a command field in the top bar.
- Settings is now a two-pane dialog with sections, switches and a font-size stepper.

## [0.6.2] - 2026-10-27

Phone tabs fit small screens

### Fixed

- On 320 px wide phones the four view tabs fit again, so the page no longer scrolls sideways.

## [0.6.1] - 2026-10-27

Privacy, terms and a sturdier flowchart

### Added

- Privacy and Terms pages, linked from Settings, and every open-source licence at /licenses.txt.
- If part of the app fails to load, the page says so and offers Reload instead of loading forever.

### Fixed

- A function with hundreds of break and continue lines no longer freezes the page: the chart says it is too big.
- Functions that share a name (C++ overloads) can each be picked in the Flowchart.
- Flowchart images keep non-English function names in their file names.

## [0.6.0] - 2026-10-26

Flowcharts

### Added

- A Flowchart tab that draws how your C, C++ or Python code runs, with click-to-line and a step list.
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

### Changed

- Signal is the new default theme, with the Geist typeface.
- Runs, output, the file list, sync and dialogs restyled to match the new look.

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

- A button's colour and its label now change together.

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

- Problems that showed up only in Safari and other WebKit browsers.

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
