# CodeEditor

A personal code editor for Python, C and C++ that runs programs in the browser. Files live in
folders in a workspace kept in the browser's storage (IndexedDB), and can be kept in a private
GitHub repository. Compiling and running happen on your own computer, in WebAssembly workers. The
only server-side piece is a small sign-in relay on the same site for "Sign in with GitHub"
(`functions/api/auth/`, see [Keeping the files on GitHub](#keeping-the-files-on-github)); it stores
and logs nothing, and syncing never goes through it.

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
- Share link... (a file's menu in the list, More file actions, and the search): with GitHub
  connected, choose who can open the link, then copy it. See [Sharing a file](#sharing-a-file).
- Search files and commands: Ctrl+P (Cmd+P on macOS) or Search in the top bar finds a file by its
  name, and any command; F1 or Ctrl+Shift+P lists the commands only (Firefox keeps Ctrl+Shift+P for
  a private window: use F1 there). Each command shows its keys. See [Keyboard](#keyboard).
- New from example... (in More file actions, the search, and the empty workspace): nine short
  programs, three each for Python, C and C++, added to your files under a free name and opened.
- New file (the file list): the name field suggests `name.py, name.c or name.cpp`. A name that won't
  run is said before the file is made; one with no extension at all needs Enter twice. A new
  Python, C or C++ file starts from the same short program as the empty workspace's starters,
  unless its folder already has a file of that language (then it is a helper and starts empty).

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
| `npm test` | Unit tests (Vitest): the app (`src/`), then the sign-in relay (`server/`) |
| `npm run typecheck` | TypeScript for the app, the workers, the tooling and the sign-in relay (`functions/`, `server/`) |
| `npm run dev:pages` | After `npm run build`: the built site plus the sign-in relay on http://127.0.0.1:8788 (Wrangler; needs a `.dev.vars`, see below) |
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

The Shortcuts list has every key: Shortcuts in the status bar, or Ctrl+/ (Cmd+/ on macOS)
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
You need a repository (private: a public one gets a warning first). Both ways of connecting link to
GitHub's new-repository page with Private chosen ("No repository yet? Create a private one on GitHub").

**Sign in with GitHub** (where the site owner has set it up, below). Once:

1. Connect GitHub, then Sign in with GitHub. GitHub asks you to pick an account and to authorize
   CodeEditor: choose Authorize.
2. Back in CodeEditor, if no repository is listed: choose "Choose a repository on GitHub", pick your
   account, choose **Only select repositories**, pick one repository (private; it can be empty),
   then Install. Come back to the CodeEditor tab: the repository shows up.
3. Pick it and choose Connect. A repository owned by an organisation may need the organisation's
   owner to approve CodeEditor first.

- CodeEditor is a GitHub App that asks only for **Contents: Read and write** (and the Metadata read
  GitHub adds). It reaches only the repositories you installed it on, and only if you can reach
  them too; the list warns when it can reach more than one.
- The sign-in lasts 8 hours and renews itself (GitHub's refresh token lasts 6 months and changes at
  every renewal). By default the sign-in is forgotten when the tab closes. "Remember on this
  device" (off by default; leave it off on a shared computer) keeps it encrypted (AES-GCM with a
  non-extractable key) in its own IndexedDB database, so the next visit syncs by itself. Disconnect asks GitHub to revoke
  this device's token and deletes it here; if GitHub can't be reached, the token stops working by
  itself within 8 hours, or you can revoke CodeEditor in your GitHub settings (Applications,
  Authorized GitHub Apps). On a shared computer, also sign out of github.com: your GitHub session in the browser
  isn't CodeEditor's.
- What the relay sees: to sign in and to renew, the browser sends the one-time code (with the PKCE
  verifier) or the refresh token to `/api/auth/*` on this same site, which adds the app's client
  secret, asks GitHub, and passes the tokens back. It stores and logs nothing. Syncing goes straight
  from the browser to `https://api.github.com`. GitHub lists CodeEditor under your Authorized
  GitHub Apps, and the app's owner can see which accounts installed it; the owner has no private
  key for the app, so they can't act on your repositories without your token. Install apps only
  from owners you trust.

**Use a token instead**: the Connect dialog's other path (and the only one where the relay isn't
set up, e.g. a fork or `npm run preview`). Make a fine-grained personal access token for that one
repository with **Contents: Read and write**. The Connect dialog links to GitHub's new-token page
with the name, Contents and a 90-day expiry filled in; you pick the repository there.

- The token goes only to `https://api.github.com`, in the Authorization header. By default it is
  kept in the tab's memory and forgotten when the tab closes. "Remember on this device" stores it
  encrypted (AES-GCM with a non-extractable key) in its own IndexedDB database; leave it off on
  shared computers. Disconnect, or "Sign out and clear this computer" in Settings, removes it.
- A sync downloads what changed on GitHub and uploads what changed here as one commit. Ctrl+S and
  the sync status sync at once; with "Sync automatically" (Settings, on by default) a sync also runs
  a minute after the last change while the tab is in front. Only the tab that edits the workspace
  syncs.
- Each commit is named after the files it changes, for example `Add lab3/q2.c, update main.py
  and 2 more` (at most 72 characters), with `Added:`, `Changed:` and `Deleted:` lists below (one
  file per line, up to 20 per list, then `and N more`) and a `From: <browser> (CodeEditor)` line
  last. A file name that could read as part of the title (one with a comma, "and" or quotes) is
  quoted there. To write your own title, choose "Sync now with a
  message..." in the command palette (F1) or "Sync with a message..." in Settings: what you type
  (one line, up to 72 characters) replaces the title of that one sync's commit, and the file lists
  stay. Ctrl+S and automatic syncs never ask. If there is nothing to upload, or the sync fails,
  no commit carries the message; CodeEditor says so and offers the text again next time.
- A file changed on both sides keeps GitHub's version under its name, and yours is saved next to
  it as `name.conflict-YYYYMMDD-HHMMSS.ext`, here and in the repository: nothing is lost. The same
  happens when a sync brings in a new version of a file while you are typing in it: the tab shows
  GitHub's version and your typing is saved as the conflict copy. Until you open the copy (or
  dismiss the notice about it), the sync status in the top bar reads "1 conflict" (a warning, not
  "Synced") and opens the copy; the notice stays until you act on it. In the file list a copy's name
  is cut in the middle, so the time it was made and its extension stay readable. On the first sync, if this
  computer and the repository have different versions of the same file, you choose: merge
  (conflict copies), the repository's versions, or this computer's.
- Offline, changes stay here and sync once the connection is back. When GitHub limits requests,
  CodeEditor waits as long as GitHub says, then twice as long, and stops after 3 tries.

### Sharing a file

Share link... asks who can open the link, then copies it. Nothing is shared until you choose.

- **People with access to the repository** (the default): the file's page on GitHub,
  `https://github.com/<owner>/<repo>/blob/<commit>/<path>`, pinned to the commit of the last sync.
  It opens only for you and the repository's collaborators while the repository is private. The
  dialog says so when it is public, and says when it couldn't check (offline, or GitHub didn't
  answer and the connection doesn't record it). Nothing is sent to make it and no new permission is needed. A
  file with changes that aren't on GitHub yet, or that never synced, shows Sync now first, so the
  link always shows what you see. A read-only tab doesn't share; the tab that edits does.
- **Anyone with the link (a secret gist)**: CodeEditor copies the file into a new secret gist on
  your GitHub account, only when you press Create link. GitHub's own words: "Secret gists aren't
  private" ([Creating gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists)):
  anyone with the link can open it without signing in; it just isn't listed or searchable. The
  gist holds the file's content under its name only (its folders stay private). Closing the dialog
  before the request goes out (it can wait behind a sync) sends nothing. To
  remove it, open the gist on GitHub (the dialog links to it) and delete it. Text files up to 512 KB;
  binary and empty files are refused. The token needs permission to create gists:
  - Sign in with GitHub: the site's owner adds the account permission "Gists" (below), and you sign
    in again once to approve it.
  - A fine-grained token: the account permission **Gists: Read and write**
    ([permissions for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
    "User permissions for Gists"). A classic token: the **gist** scope
    ([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
  - Either way this lets the token create, change and delete any of your gists, not only the ones
    CodeEditor made. Without it, the repository link still works and the dialog says what is missing.

### Setting up Sign in with GitHub (the site's owner, once)

Without these steps the site still works: the Connect dialog shows only the token path.

On GitHub: Settings, Developer settings, GitHub Apps, New GitHub App
([GitHub's guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).

1. **Name**: unique on GitHub, at most 34 characters (e.g. "CodeEditor Sync" and your name).
   **Description**: "Saves your CodeEditor workspace to a GitHub repository you choose and opens it again
   on any computer. Your code runs in your browser; the app reads and writes files only in the
   repositories you install it on." With Gists on (step 6), add: "Share link also makes secret gists
   when you ask it to." **Homepage URL**: the production site.
2. **Callback URL**: exactly `https://<production origin>/auth-callback`, one URL only. Leave any
   option that allows matching other URLs (wildcards, subdomains, paths) off.
3. **Expire user authorization tokens**: on (the default).
4. **Request user authorization (OAuth) during installation**: off. **Enable Device Flow**: off.
5. **Setup URL**: empty; **Redirect on update**: off. **Webhook**: untick Active.
6. **Permissions**: Repository, Contents: **Read and write**; check that Metadata shows Read-only.
   For Share link's public link (a secret gist), also Account permissions, **Gists: Read and
   write**; leave it at No access if students shouldn't make gists from CodeEditor (the repository
   link works without it). Everything else No access (no Organization permissions, no other Account
   permissions, no Workflows).
7. **Where can this GitHub App be installed**: **Any account** (classmates install it on their own
   repositories).
8. Create the app. Note its **Client ID** and its **slug** (the last part of its public page,
   `https://github.com/apps/<slug>`). Generate a **client secret** and paste it straight into
   Cloudflare (step 10), never into a file, a chat or the repository. Don't generate a private key:
   sign-in doesn't need one, and it would let its holder act on every repository the app is
   installed on.

On Cloudflare: Workers & Pages, the project, Settings, Variables and Secrets
([Cloudflare's guide](https://developers.cloudflare.com/pages/functions/bindings/)), in the
**Production** environment only:

9. `GITHUB_CLIENT_ID` (text), `GITHUB_APP_SLUG` (text), `ALLOWED_ORIGIN` (text): the exact production
   origin, `https://` and the custom domain, no trailing slash.
10. `GITHUB_CLIENT_SECRET`, type **Secret**. Not in Preview: preview deployments are public, and their
    origin differs from `ALLOWED_ORIGIN`, so they refuse sign-in anyway.
11. Check the build's root directory is the repository root (so `functions/` is deployed with the
    site), then redeploy: secrets apply from the next deployment.
12. Optional, with the custom domain on a Cloudflare zone: one WAF rate-limiting rule for paths
    starting with `/api/auth/` (for example more than 20 requests in 10 seconds from one IP: block).
13. If the secret may have leaked: generate a new one on GitHub, set it in Cloudflare, redeploy, then
    delete the old one on GitHub. After a security fix to the relay, delete old production
    deployments (their URLs stay reachable).

**Adding Gists to an app students already use.** In the app's settings (Permissions & events),
set Account permissions, Gists to **Read and write** and save. Nothing changes for anyone until
they approve it: GitHub says permission changes don't take effect for a user authorization "until
the new permissions are approved", and that for account permissions the app prompts users to
reauthorize ([Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration),
"Changing the permissions of a GitHub App";
[Approving updated permissions](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)).
In CodeEditor that means: a signed-in student who presses Create link gets a sentence saying the
sign-in can't create gists yet; Disconnect, then Sign in with GitHub again, and approve on GitHub's
page. Their sync keeps working meanwhile. A user access token only ever has what both the app and
the user allow ([Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).
GitHub lists POST /gists for user access tokens only, with Gists write
([Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps),
"User permissions for Gists"). Removing the permission later takes effect at once.

**Local testing with a separate dev app.** Register a second, private GitHub App the same way, with
the callback `http://127.0.0.1:8788/auth-callback`, so the production app keeps its one exact
callback. Put its values in a `.dev.vars` file at the repository root (ignored by git, never
committed):

```sh
GITHUB_CLIENT_ID=<the dev app's client ID>
GITHUB_CLIENT_SECRET=<the dev app's client secret>
GITHUB_APP_SLUG=<the dev app's slug>
ALLOWED_ORIGIN=http://127.0.0.1:8788
```

Then `npm run build` and `npm run dev:pages`, and open http://127.0.0.1:8788.

## How it is put together

| Folder | |
|---|---|
| `src/core` | Shared types, paths, byte and text checks, languages, the error help table (`error-help.ts`, checked against `__fixtures__/error-help.json`) |
| `src/storage` | The workspace in IndexedDB, one editing tab at a time, import, zip export |
| `src/sync` | GitHub sync (one commit per push, conflicts kept as copies), Sign in with GitHub (PKCE, the token source, the repository list) |
| `server`, `functions/api/auth` | The sign-in relay: its logic and tests (`server/github-auth.ts`), and the four Cloudflare Pages Function routes that call it |
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
| [Geist](https://github.com/vercel/geist-font) (`@fontsource-variable/geist`) | SIL Open Font License 1.1 | Font: the interface |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (`@fontsource/jetbrains-mono`) | SIL Open Font License 1.1 | Font: code, output and file names (its ligatures only with "Joined symbols" on) |
| [Phosphor Icons](https://phosphoricons.com/) (`@phosphor-icons/core`) | MIT | Icons |
| [Workbox](https://github.com/GoogleChrome/workbox) (through `vite-plugin-pwa`) | MIT | Offline service worker |
| Pocket Run (same author) | MIT | The runtimes, theme engine and console were adapted from it |

The colour themes in Settings use the published palettes of these themes, expanded onto
CodeEditor's colours and adjusted where a colour pair would be hard to read. The table lists all 36
palette themes; High contrast, like CodeEditor Signal (the default), CodeEditor Deep Field and CodeEditor
Slate, is CodeEditor's own:

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
