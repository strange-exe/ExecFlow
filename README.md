# CodeEditor

A personal code editor for Python, C and C++ that runs programs in the browser. Files live in
folders in a workspace kept in the browser's storage (IndexedDB), and can be kept in a private
GitHub repository. There is no server: compiling and running happen on your own computer, in
WebAssembly workers.

- **Python 3.14** through [Pyodide](https://pyodide.org/) 314.0.7, with numpy and pandas (downloaded
  the first time a program imports them).
- **C and C++** through clang 8 and lld compiled to WebAssembly
  ([binji/wasm-clang](https://github.com/binji/wasm-clang)). Programs can have several files and
  headers in one folder, and can read and write files in that folder.
- Programs read typed input while they run (`input()`, `scanf`, `std::cin`), and Stop works at any
  point. Compiler and Python errors are marked on the line they belong to, in every file of the
  program, and listed under Problems.
- Error help in plain English for the errors beginners meet most (65 message shapes, such as
  a `NameError` with a suggested name, `str + int`, a missing colon or bracket, an undeclared
  identifier, a missing `#include` or `;`, a printf or scanf format mismatch, a crash): what the
  message means, with the names from it filled in, and one or two things to check. It shows under
  the failed run's error in Output and under the first Problems row of each kind. It comes from a
  table in the app, checked against messages the real Python and compiler printed; nothing is sent
  anywhere, and no AI writes it.
- Command-line arguments: the Input box (the Output panel's Input button) has an Arguments field
  beside the Input text, kept for each file (it follows a rename and goes with a delete). Words
  split at spaces; `"two words"` or `'two words'` in quotes stay one argument and `""` is an empty
  one. Nothing else is special: no backslash escapes, and `$HOME`, `*`, `;`, `|` and `>` are passed
  as text, since no shell runs. In Python `sys.argv[1:]` holds them (`sys.argv[0]` is the script's
  path, `/workspace/main.py`); in C and C++ `argv[0]` is the file's name without its extension
  (`main` for main.c) and the arguments follow. At most 100 arguments and 4,096 characters; an
  unclosed quote is shown at the field, and Run explains it instead of running.
- Works offline after the first visit (a service worker keeps the app and the Python runtime).
- Suggestions as you type: keywords and snippets, the standard library's names, and your own names
  (see [Suggestions](#suggestions)).
- Capture snippet: right-click selected code (or press Shift+F10) to make an image of those lines,
  with a preview: copy it or download a PNG. Shift+right-click gives the browser's own menu. The
  same command is in More file actions and, on wider screens, at the end of the editor head. The
  preview shows exactly what is exported. Options: colours (the editor's, light or dark), line
  numbers, the file name, a background in the theme's colours with small, medium or large padding
  (or none: the code card alone, with transparent corners), a plain or window frame (a title bar
  with the file name), the scale (1x, 2x or 3x; the exact pixel size is shown, and a scale too big
  for one image steps down and says so), and lines to highlight ("3-5, 8": a band behind those
  lines; nothing else is dimmed), and a small "Made with CodeEditor" line under the card (on by
  default; turn it off under Show). The options are remembered on this device; the highlighted
  lines are not. Nothing is sent anywhere: the image is made in the browser and works offline.
- Save as PDF... (in More file actions and the search): choose one or more files, then the
  browser's print dialog opens; choose "Save as PDF" as the printer there. The code keeps the
  editor's syntax colours, in print-safe dark ink on white by default (or the editor's own colours),
  with line numbers (optional); long lines wrap with a continuation mark, and each file starts on a
  new page under its path. A footer (on by default) gives the file, the date and "Made with
  CodeEditor" on every page, and in Chrome and Edge the page number ("Page 2 of 5"). Firefox and
  Safari can't number pages for a web page: there the footer has no page number and is printed
  with each file's code (their print dialog can add its own page numbers). Works offline; the PDF
  is made by the browser, so its text can be selected and searched.
- Search files and commands: Ctrl+P (Cmd+P on macOS) or Search in the top bar finds a file by its
  name, and any command; F1 or Ctrl+Shift+P lists the commands only (Firefox keeps Ctrl+Shift+P for
  a private window: use F1 there). Each command shows its keys. See [Keyboard](#keyboard).
- New from example... (in More file actions, the search, and the empty workspace): nine short
  programs, three each for Python, C and C++, added to your files under a free name and opened.

## Running it

Needs Node 24.18 (see `.node-version`) and npm 11.

```sh
npm ci --ignore-scripts
npm run dev
```

`npm run dev` first copies Pyodide out of `node_modules` and downloads, with a SHA-256 check for
every file, the numpy and pandas wheels (about 7.5 MB, from Pyodide's CDN) and the C/C++ pack
(about 19 MB, from the wasm-clang repository at a pinned commit) into `public/`. Later runs use a
cache in `node_modules/.cache/`. Then it serves the app on http://localhost:5173.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript for the app, the workers and the tooling |
| `npm run build` | Type check, then a production build in `dist/` with a Cloudflare Pages `_headers` file |
| `npx playwright install chromium firefox webkit` | Once, before the end-to-end tests |
| `npm run e2e` | End-to-end tests against the production build, in Chromium, Firefox and WebKit; the typing-speed test runs last, alone |
| `npm run e2e:speed` | Only the typing-speed test (`e2e/speed.spec.ts`, `--project=speed --no-deps`), which `npm run e2e` skips when an earlier test failed. Naming the spec file or the speed project without `--no-deps` runs every engine's tests first |
| `node scripts/contrast-check.mjs` | WCAG contrast of every colour pair the UI draws, for every theme |

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) checks every push to `main` and every pull request.
One job runs `npm ci --ignore-scripts`, the type check, the unit tests and `npm run build`; when
it passes, the end-to-end suite runs in Chromium, Firefox and WebKit, one job per browser (the
Chromium job also runs the typing-speed test, with one worker as every CI job). The
downloads in `node_modules/.cache/` are kept between runs, and a failed end-to-end job keeps its
`test-results/` folder as an artifact for 7 days. CI doesn't hold back deploys: Cloudflare Pages
builds every push to `main` on its own.

## Suggestions

A list of suggestions opens as you type. It offers keywords and snippets (`for`, `if`, `main`,
`printf`, `class`...), the standard library's names, and your own names:

- Python: module names after `import` and `from`, and a module's members after `math.` or
  `from math import`. Your own modules (`helpers.py` beside the file) and their top-level functions,
  classes and variables are offered too.
- C and C++: header names after `#include <` (and your headers after `#include "`), library
  functions and constants with their prototype or value, and `std::` names in C++. After your own
  `using namespace std;` the std names come without the prefix too (`vector`, `cout`), below your
  own names, wherever C++ lets you use them: after the line, and only inside the block or namespace
  it is in. They follow the C and C++ standard chosen in Settings, and a function that doesn't link
  here (`gets`, `system`) is never offered. Your own functions, types, globals and macros come from
  the open file and the headers it includes with quotes.

The library lists are generated from the C/C++ pack's sysroot and from Pyodide
(`scripts/gen-c-completions.mjs`, `scripts/gen-python-completions.mjs`), load the first time a file
of that language is shown, and work offline after the first visit. Keywords and snippets come with
the editor itself, so they are offered even if the rest can't load yet.

- Nothing is picked when the list opens, so Enter makes a new line. Down or Up picks a suggestion,
  then Enter accepts it. Tab never accepts one.
- Ctrl+Space shows the list at any time (on macOS also Alt+\`). "Suggestions while typing" in
  Settings stops the list from opening by itself.
- Esc closes the list, or ends a snippet. Inside a snippet, Tab and Shift+Tab move between its
  fields, except while Tab moves focus (Ctrl+M, or Shift+Alt+M on macOS): then Tab leaves the editor.

## Keyboard

The Shortcuts list has every key: Shortcuts in the status bar, or `?` or Ctrl+/ (Cmd+/ on macOS)
anywhere outside the code and text fields (inside the code, Ctrl+/ comments the line). The ones to
know first, with Cmd for Ctrl on macOS:

- Ctrl+Enter runs the open file, Ctrl+. stops it, Ctrl+S saves now (and syncs once connected).
- Ctrl+P searches the files and commands; F1 or Ctrl+Shift+P the commands only.
- Tab indents in the code, also right after Esc closes the suggestions. To move on, press Esc and
  then Tab (Esc first closes suggestions, ends a snippet or clears a selection, so press it again),
  or Ctrl+M (Shift+Alt+M on macOS) so that Tab moves the focus.
- In the code: Ctrl+F finds and replaces, Ctrl+Alt+G goes to a line, Ctrl+D selects the next match
  of the selection too, Ctrl+Alt+Up or Down adds a cursor (so does Ctrl+click), Ctrl+Shift+[ and ]
  fold and unfold a block (Cmd+Alt+[ and ] on macOS), F8 goes to the next problem.

## Keeping the files on GitHub

Connect from the sync status in the top bar ("Not connected"), the empty workspace, or Settings.
You need a repository (private: a public one gets a warning first) and a fine-grained personal
access token for that one repository with **Contents: Read and write**. The Connect dialog links to
GitHub's new-token page with the name, Contents and a 90-day expiry filled in; you pick the
repository there.

- The token goes only to `https://api.github.com`, in the Authorization header. By default it is
  kept in the tab's memory and forgotten when the tab closes. "Remember on this computer" stores it
  encrypted (AES-GCM with a non-extractable key) in its own IndexedDB database; leave it off on
  shared computers. Disconnect, or "Sign out and clear this computer" in Settings, removes it.
- A sync downloads what changed on GitHub and uploads what changed here as one commit. Ctrl+S and
  the sync status sync at once; with "Sync automatically" (Settings, on by default) a sync also runs
  a minute after the last change while the tab is in front. Only the tab that edits the workspace
  syncs.
- A file changed on both sides keeps GitHub's version under its name, and yours is saved next to
  it as `name.conflict-YYYYMMDD-HHMMSS.ext`, here and in the repository: nothing is lost. The same
  happens when a sync brings in a new version of a file while you are typing in it: the tab shows
  GitHub's version and your typing is saved as the conflict copy. On the first sync, if this
  computer and the repository have different versions of the same file, you choose: merge
  (conflict copies), the repository's versions, or this computer's.
- Offline, changes stay here and sync once the connection is back. When GitHub limits requests,
  CodeEditor waits as long as GitHub says, then twice as long, and stops after 3 tries.

## How it is put together

| Folder | |
|---|---|
| `src/core` | Shared types, paths, byte and text checks, languages, the error help table (`error-help.ts`, checked against `__fixtures__/error-help.json`) |
| `src/storage` | The workspace in IndexedDB, one editing tab at a time, import, zip export |
| `src/sync` | GitHub sync (one commit per push, conflicts kept as copies) |
| `src/editor` | CodeMirror 6 editor sessions, diagnostics and suggestions (`src/editor/data`: the generated library lists) |
| `src/runner`, `src/workers` | The Python and C/C++ runtimes and their workers |
| `src/ui`, `src/theme`, `src/styles` | The workbench, the colour themes, the styles |

The page is cross-origin isolated (COOP and COEP), so programs can wait for typed input. Its
Content-Security-Policy allows scripts only from the site itself (no `eval`), and network requests
only to the site and `https://api.github.com`. The workers that run code get a stricter policy
(the site only), and Python's worker has storage, network, locks, messaging to other tabs and its
own `postMessage` removed before any program starts (a program can't send the page messages).

## Limits

- Each file is at most 1 MiB; a workspace holds up to 2000 files and 50 MiB.
- A run stops after 15 seconds by default (time spent waiting for typed input doesn't count) or
  after 512 Ki characters of output. Both can be changed in Settings.
- Python has 512 MB of memory, C and C++ programs 256 MB. Compiling has 30 seconds per file plus
  30 seconds to link.
- C and C++ use clang 8: C up to C17, C++ up to C++17 (C++20 partly, as `c++2a`).
- C and C++ need a one-time 19.6 MB download, offered in the Output panel the first time.
- Not supported: matplotlib plots, programs that open network connections.
- Binary files, files with mixed line endings and other files that aren't plain UTF-8 text are kept
  read-only when they come from GitHub, and refused when imported.
- The browser may clear its storage when the disk is full (Safari: after 7 days without a visit).
  Settings has "Protect local data" (persistent storage) and Export to a .zip.
- Files save 400 ms after you stop typing. When the page is closed or reloaded sooner, the unsaved
  text is also kept in the browser's localStorage and saved on the next visit (as a conflict copy
  if the file changed meanwhile); "Sign out and clear this computer" removes it too.
- GitHub sync: an empty repository can only be started on its default branch; changes under
  `.github/workflows/` need a token with the Workflows permission, so they stay here; repository
  paths that can't be file names here (reserved or unsafe names) are left out and reported.

## Third-party software

CodeEditor bundles or downloads the following. Their licences apply to their parts.

| Software | Licence | Used for |
|---|---|---|
| [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/) (`@codemirror/*`, `@lezer/*`), with `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break` | MIT | The editor |
| [idb](https://github.com/jakearchibald/idb) | ISC | IndexedDB access |
| [Pyodide](https://github.com/pyodide/pyodide) 314.0.7 (includes CPython, PSF licence) | MPL-2.0 | Python |
| numpy 2.4.6 | BSD-3-Clause (with 0BSD, MIT, Zlib and CC0-1.0 parts) | Python package |
| pandas 3.0.2 | BSD-3-Clause | Python package |
| python-dateutil 2.9.0.post0 | Apache-2.0 or BSD-3-Clause | Python package (pandas) |
| pytz 2026.1.post1, six 1.17.0 | MIT | Python packages (pandas) |
| [wasm-clang](https://github.com/binji/wasm-clang) (Ben Smith), vendored in `src/vendor/wasm-clang` | Apache-2.0 | C and C++ runtime glue |
| LLVM: clang 8 and lld, in the C/C++ pack | Apache-2.0 WITH LLVM-exception, and the legacy University of Illinois/NCSA licence (`LICENSE.llvm.txt` in the pack) | C and C++: compiling and linking |
| libc++ 8 and libc++abi 8 (LLVM), in the C/C++ pack's sysroot | MIT or University of Illinois/NCSA, dual licensed (`licenses/libcxx-8-LICENSE.TXT`, `licenses/libcxxabi-8-LICENSE.TXT`; the pack has no copy) | C++ standard library, and the C++ names in suggestions |
| wasi-libc (built from musl and cloudlibc), in the C/C++ pack's sysroot | Not stated in the pack. Upstream wasi-libc today: Apache-2.0 WITH LLVM-exception, Apache-2.0 or MIT, with musl's parts MIT and cloudlibc's BSD-2-Clause; not checked for this 2019 build | C library, and the C names in suggestions |
| [Source Sans 3](https://github.com/adobe-fonts/source-sans) and [Source Code Pro](https://github.com/adobe-fonts/source-code-pro) (`@fontsource/source-sans-3`, `@fontsource/source-code-pro`) | SIL Open Font License 1.1 | Fonts: interface, and code and output |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (`@fontsource/jetbrains-mono`) | SIL Open Font License 1.1 | Font: code with "Joined symbols" on |
| [Phosphor Icons](https://phosphoricons.com/) (`@phosphor-icons/core`) | MIT | Icons |
| [Workbox](https://github.com/GoogleChrome/workbox) (through `vite-plugin-pwa`) | MIT | Offline service worker |
| Pocket Run (same author) | MIT | The runtimes, theme engine and console were adapted from it |

The colour themes in Settings use the published palettes of these themes, expanded onto
CodeEditor's colours and adjusted where a colour pair would be hard to read. The table lists all 36
palette themes; High contrast, like CodeEditor Deep Field and CodeEditor Slate, is CodeEditor's own:

| Theme | Source | Licence |
|---|---|---|
| Tokyo Night, Tokyo Night Storm, Tokyo Night Day | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) | Apache-2.0 |
| Catppuccin Mocha, Catppuccin Macchiato, Catppuccin Frappe, Catppuccin Latte | [catppuccin/palette](https://github.com/catppuccin/palette) | MIT |
| Dracula | [draculatheme.com/spec](https://draculatheme.com/spec) | MIT |
| GitHub-style Dark, GitHub-style Light | [primer/github-vscode-theme](https://github.com/primer/github-vscode-theme) | MIT |
| One Dark Pro | [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | MIT |
| Rose Pine, Rose Pine Moon, Rose Pine Dawn | [rose-pine/rose-pine-palette](https://github.com/rose-pine/rose-pine-palette) | MIT |
| Nord | [nordtheme/nord](https://github.com/nordtheme/nord) | MIT |
| Gruvbox Dark, Gruvbox Light | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT |
| Kanagawa, Kanagawa Dragon, Kanagawa Lotus | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | MIT |
| Everforest Dark, Everforest Light | [sainnhe/everforest](https://github.com/sainnhe/everforest) | MIT |
| Ayu Dark, Ayu Mirage, Ayu Light | [ayu-theme/vscode-ayu](https://github.com/ayu-theme/vscode-ayu) | MIT |
| Night Owl | [sdras/night-owl-vscode-theme](https://github.com/sdras/night-owl-vscode-theme) | MIT |
| Solarized Dark, Solarized Light | [altercation/vim-colors-solarized](https://github.com/altercation/vim-colors-solarized) | MIT |
| Vesper | [raunofreiberg/vesper](https://github.com/raunofreiberg/vesper) | MIT |
| Poimandres | [drcmda/poimandres-theme](https://github.com/drcmda/poimandres-theme) | MIT |
| Vitesse Dark, Vitesse Light | [antfu/vscode-theme-vitesse](https://github.com/antfu/vscode-theme-vitesse) | MIT |
| Flexoki Dark, Flexoki Light | [kepano/flexoki](https://github.com/kepano/flexoki) ([stephango.com/flexoki](https://stephango.com/flexoki)) | MIT |
| Nightfox | [EdenEast/nightfox.nvim](https://github.com/EdenEast/nightfox.nvim) | MIT |
| High contrast | CodeEditor (this repository) | MIT (`LICENSE`) |
