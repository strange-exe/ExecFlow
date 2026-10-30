// Share link (.claude/design/batch5/share-link.md): one dialog, three clearly labelled links, chosen
// with a radio, then the primary action.
// 0. "Anyone with the link (the code is in the link)", the default: the file inside the link itself
//    (src/core/code-link.ts), opened by ExecFlow. Needs no GitHub, sends nothing, made as the
//    dialog opens; a file too long for a link (or not text) says why. Without a connection the
//    other two choices offer Connect GitHub (.claude/tasks/code-links.md).
// S. "Anyone with the link (a short link)" (owner's go-ahead 2026-10-30): the same content, encrypted
//    here and kept by ExecFlow's server for 1, 30 or 90 days (src/core/short-link.ts). Made only when
//    "Make short link" is pressed (one press, one link); needs a connection. A file too long for a
//    code link offers it ("Make a short link instead").
// 1. "People with access to the repository": the file on GitHub, pinned to the commit that holds
//    its synced content (src/sync/share.ts repoFileUrl). Nothing is sent to make it. A file with
//    changes that aren't on GitHub yet (or never synced) gets "Sync now" first: the link always
//    shows what the student sees.
// 2. "Anyone with the link (a secret gist)": says plainly, before anything exists, that a secret
//    gist isn't private. The gist is created only when "Create link" is pressed, once per press
//    (a press while one is being made, or the second click of a double click, does nothing), and
//    never again for the same opening once it exists.
// Copy uses the async clipboard API; when the browser refuses, the link is selected in its field
// for Ctrl+C. Every name and address goes in as text; the only links are github.com pages built
// here and the gist page GitHub answered with, after gistPageUrl checked it. A lazy chunk of the
// sync screens, built per opening and removed on close. State attributes for tests: data-state
// ("code-making", "code", "code-refused", "short-ready", "short-making", "short", "not-connected",
// "ready", "pending", "syncing", "gist", "creating", "created"), data-choice, data-qr,
// data-copy ("copied", "refused"), data-visibility ("private", "public", "unknown"; data-public
// too while public) and data-checked (the live visibility check has answered or failed).
// Who can open the repository link: the live answer (GET /repos) when there is one, else the
// answer stored when connecting; the sentence promising that only the repository's people can
// open it is shown only for a repository known to be private.
// Closing the dialog (Cancel, Escape, the close button) withdraws a gist that hasn't been sent:
// a request waiting behind a sync's writes is dropped, and nothing is said about it.
import type { MakeRefusal } from "../core/code-link";
import { nameOf } from "../core/paths";
import { shortMakeRefusalText, type ShortMakeRefusal } from "../core/short-link";
import type { GistBody } from "../sync/github";
// Types only: the rules come in through deps.rules (the controller's import), so this chunk never
// shares a module with the sync chunk and Connect GitHub still loads one chunk (sync.spec.ts).
import type * as ShareRules from "../sync/share";
import type { RepoLinkState } from "../sync/share";
import type { AuthKind } from "../sync/repo-check";
import { dialogShell, openModal } from "./dialogs";
import { h, shown, svg } from "./dom";
import { icon } from "./icons";
import type { Notice } from "./notice";
import { DEFAULT_TTL, expiryDay, expiryField, SHORT_NOTE, type LinkTtl } from "./short-link-ui";

export type ShareState =
  | { kind: "not-connected" }
  | { kind: "missing" }
  /** `private`: the repository's visibility stored when connecting (null: not recorded). */
  | { kind: "connected"; repo: string; link: RepoLinkState; opaque: boolean; private: boolean | null };

export interface ShareDeps {
  readonly path: string;
  /** src/sync/share.ts: the link and gist rules. */
  readonly rules: Pick<typeof ShareRules, "explainGistError" | "gistPageUrl" | "gistRefusal" | "gistRequest" | "refusalText" | "repoAudience">;
  /** The sync screens' "opens in a new tab" icon (sync-icons.ts lives in their chunk). */
  externalIcon(): SVGSVGElement;
  /** Where the file stands now (asked again after a sync). */
  state(): Promise<ShareState>;
  /** Whether the repository is private (GET /repos), null when that can't be asked now. */
  repoPrivate(): Promise<boolean | null>;
  /** Syncs now; resolves with a sentence when the sync couldn't run or failed, else null. */
  syncNow(): Promise<string | null>;
  /** The file's text as saved; "opaque" for a file kept as read-only bytes; "missing" once it is gone. */
  readText(): Promise<{ text: string } | "opaque" | "missing">;
  /** src/core/code-link.ts makeCodeLink for this file's name, opening at this site. */
  codeLink(text: string): Promise<{ ok: true; url: string } | { ok: false; refusal: MakeRefusal }>;
  /** src/core/short-link.ts for this file's name: encrypted, stored for `ttl` seconds; `expires` in ms. */
  shortLink(text: string, ttl: LinkTtl): Promise<{ ok: true; url: string; expires: number } | { ok: false; refusal: ShortMakeRefusal }>;
  /**
   * POST /gists with this tab's GitHub client; null when there is no token in this tab. Aborted
   * `signal` before the request goes out: nothing is sent, and it rejects with `signal.reason`.
   */
  createGist: ((body: GistBody, signal: AbortSignal) => Promise<{ id: string; htmlUrl: string }>) | null;
  readonly auth: AuthKind;
  online(): boolean;
  /** A sentence while this tab can't write (another tab took over editing), else null. */
  readOnly(): string | null;
  /** The page's notice: what happened to a gist whose answer came after the dialog closed. */
  readonly notice: Pick<Notice, "show">;
  /** Opens Connect GitHub (this dialog is closed first). */
  connect(): void;
  readonly returnTo: HTMLElement | (() => HTMLElement | null) | null;
  /** navigator.clipboard.writeText, swappable in tests. */
  readonly writeText?: (text: string) => Promise<void>;
  /** The clipboard with a titled link (HTML) and its plain text; swappable in tests. */
  readonly writeRich?: (html: string, text: string) => Promise<void>;
  readonly mac: boolean;
}

type Choice = "code" | "short" | "repo" | "gist";

let open = false;

function clipboardWrite(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) return Promise.reject(new Error("no clipboard"));
    return navigator.clipboard.writeText(text);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * A titled link on the clipboard: HTML for documents, mail and chats that keep links (one <a>), and
 * plain text for the rest. Clipboard.write is Baseline 2024
 * (https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write); without it, the plain text.
 */
function clipboardWriteRich(html: string, text: string): Promise<void> {
  try {
    if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      return navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    }
    return clipboardWrite(text);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * The QR code of `url` as an SVG drawn here (src/core/qr-plan.ts: uqr gives the modules only, no
 * markup from a library), dark on light whatever the theme, as scanners expect; null when the link
 * is too long for one. A link that fits at level H carries the ExecFlow mark in a cleared square at
 * the centre (src/editor/brand-mark.ts, its own fixed colours); a longer one is the plain level L
 * code. Each row's dark runs become one path segment, so a version-40 code stays a short string.
 * Shared with the Choose files dialog.
 */
export async function qrCode(url: string, label: string, id = "share-qr"): Promise<SVGSVGElement | null> {
  const [{ qrPlan, darkPath }, { brandMarkSvg }] = await Promise.all([import("../core/qr-plan"), import("../editor/brand-mark")]);
  const plan = qrPlan(url);
  if (!plan) return null;
  const n = plan.size;
  const code = svg(
    "svg",
    { class: "share-qr", id, viewBox: `0 0 ${n} ${n}`, width: String(n * 4), height: String(n * 4), role: "img", "aria-label": label, "data-ecc": plan.ecc, "shape-rendering": "crispEdges" },
    svg("rect", { class: "share-qr-light", width: String(n), height: String(n) }),
    svg("path", { class: "share-qr-dark", d: darkPath(plan.modules) }),
  );
  if (plan.mark) {
    // A nested <svg>: its width and height are in the code's units (modules); geometricPrecision so
    // the tile's corners and the chevrons stay smooth inside a crisp-edged code.
    const mark = brandMarkSvg(document, plan.mark.markSize);
    mark.setAttribute("x", String(plan.mark.markAt));
    mark.setAttribute("y", String(plan.mark.markAt));
    mark.setAttribute("class", "share-qr-mark");
    mark.setAttribute("shape-rendering", "geometricPrecision");
    code.append(mark);
  }
  return code;
}

export async function openShareDialog(deps: ShareDeps): Promise<void> {
  if (open || document.querySelector("dialog[open], .menu")) return;
  open = true;
  const { rules } = deps;
  // Drawn in the dialog's sentences, its title and the QR label with every unshown character tagged
  // (shown(), as the code-link dialog and the tree draw names). Only the file's own data (the link,
  // the gist, the titled copy) carries the real name.
  const fileName = nameOf(deps.path);
  const name = shown(fileName);
  const { dialog, body } = dialogShell("share-dialog", `Share ${name}`, { wide: true });
  dialog.classList.add("sync-dialog", "share-dialog");
  /** Aborted when the dialog closes: a gist not sent by then never is. */
  const wanted = new AbortController();
  dialog.addEventListener("close", () => {
    wanted.abort();
    dialog.remove();
    open = false;
  }, { once: true });

  const result = h("p", { class: "result-line connect-result share-result", id: "share-result", role: "status" });
  const cancel = h("button", { type: "button", class: "btn", id: "share-cancel" }, "Cancel");
  const primary = h("button", { type: "button", class: "btn primary", id: "share-primary" });
  cancel.addEventListener("click", () => dialog.close());
  dialog.append(h("div", { class: "dialog-actions share-actions" }, cancel, primary));

  /** One sentence in the result line: an error or a warning on the band, or a plain "done". */
  function say(message: string, tone?: "error" | "warning" | "done") {
    delete result.dataset.tone;
    delete result.dataset.done;
    if (!message) return result.replaceChildren();
    if (tone === "done") result.dataset.done = "";
    else if (tone) result.dataset.tone = tone;
    const glyph = tone === "done" ? icon("check-circle", "result-icon") : tone === "error" ? icon("warning-circle", "result-icon") : tone === "warning" ? icon("warning", "result-icon") : null;
    // Tagged here too: a sentence from the share rules (sync/share.ts) can quote the path.
    result.replaceChildren(...(glyph ? [glyph] : []), h("span", null, shown(message)));
  }
  const setPrimary = (glyph: "copy" | "github-logo" | "link-simple", label: string) => primary.replaceChildren(icon(glyph), label);

  let state = await deps.state().catch((): ShareState => ({ kind: "missing" }));

  // ---------------------------------------------------------------- missing
  if (state.kind === "missing") {
    dialog.dataset.state = state.kind;
    body.append(h("p", { class: "connect-lede", id: "share-lede" }, `${name} isn't in this workspace any more, so there is nothing to share.`));
    dialog.setAttribute("aria-describedby", "share-lede");
    primary.remove();
    cancel.textContent = "Close";
    openModal(dialog, cancel, deps.returnTo);
    return;
  }

  // ---------------------------------------------------------------- the choice
  const radio = (value: Choice, label: string, note: Node[]) => {
    const input = h("input", { type: "radio", name: "share-choice", id: `share-${value}`, value, "aria-describedby": `share-${value}-note` });
    input.checked = value === "code";
    const row = h("div", { class: "choice", "data-choice": value }, input, h("label", { for: input.id }, label), h("div", { class: "field-note share-note", id: `share-${value}-note` }, ...note));
    return { input, row };
  };
  const codeRadio = radio("code", "Anyone with the link (the code is in the link)", [
    h("p", null, "Opens a copy in ExecFlow, without an account. The code is inside the link itself: nothing is uploaded or stored."),
  ]);
  const shortRadio = radio("short", "Anyone with the link (a short link)", [h("p", null, `Opens a copy in ExecFlow, without an account. ${SHORT_NOTE}`)]);
  const repoWho = h("p", { class: "share-who" });
  /** The note, its tone and the attributes for a visibility (stored first, then the live answer). */
  const showAudience = (isPrivate: boolean | null) => {
    if (state.kind !== "connected") return;
    const audience = rules.repoAudience(state.repo, isPrivate);
    repoWho.textContent = audience.text;
    repoWho.classList.toggle("share-warn", audience.visibility !== "private");
    dialog.dataset.visibility = audience.visibility;
    if (audience.visibility === "public") dialog.dataset.public = "";
    else delete dialog.dataset.public;
  };
  if (state.kind === "connected") showAudience(state.private);
  else repoWho.textContent = "The file in your GitHub repository: connect GitHub first.";
  const repoRadio = radio("repo", "People with access to the repository", [repoWho]);
  const gistRadio = radio("gist", "Anyone with the link (a secret gist)", [
    h("p", { class: "share-warn" }, "Secret gists aren't private: anyone with the link can open it, without signing in."),
    h("p", null, `ExecFlow makes a copy of ${name} as a secret gist on your GitHub account only when you press Create link. GitHub doesn't list it or show it in search.`),
  ]);
  const panel = h("div", { class: "share-panel", id: "share-panel" });
  body.append(
    h("h3", { class: "steps-title", id: "share-title" }, "Who can open the link"),
    h("fieldset", { class: "choice-list", id: "share-choices" }, h("legend", { class: "visually-hidden" }, "Who can open the link"), codeRadio.row, shortRadio.row, repoRadio.row, gistRadio.row),
    panel,
    result,
  );
  const choice = (): Choice => (codeRadio.input.checked ? "code" : shortRadio.input.checked ? "short" : gistRadio.input.checked ? "gist" : "repo");

  // The repository's visibility, asked once: a public repository's link opens for anyone. No answer
  // (no token here, offline, a rate limit, a server error) keeps the stored one.
  if (state.kind === "connected") {
    void deps
      .repoPrivate()
      .catch(() => null)
      .then((live) => {
        if (!dialog.open) return;
        if (live !== null) showAudience(live);
        dialog.dataset.checked = "";
      });
  }

  // ---------------------------------------------------------------- the code link
  /** The code link, or why there is none; null while it is being made (once per opening). */
  let code: { url: string } | { problem: string; tooLong: boolean } | null = null;
  /** The short link once made (once per opening), and how long it is kept. */
  let short: { url: string; expires: number } | null = null;
  let shortMaking = false;
  let ttl: LinkTtl = DEFAULT_TTL;
  /** QR codes, drawn the first time each link's is asked for (null: too long for one); `qr` is the one open. */
  const qrSvgs = new Map<string, SVGSVGElement | null>();
  let qr: { url: string; state: "making" | "shown" | "too-long" } | null = null;
  const qrState = (url: string) => (qr && qr.url === url ? qr.state : "hidden");
  const focusQrToggle = () => dialog.querySelector<HTMLElement>("#share-qr-toggle")?.focus();
  async function toggleQr(url: string) {
    if (qrState(url) === "making") return;
    if (qrState(url) !== "hidden") {
      qr = null;
      render();
      return focusQrToggle();
    }
    if (!qrSvgs.has(url)) {
      qr = { url, state: "making" };
      render();
      focusQrToggle();
      let made: SVGSVGElement | null;
      try {
        made = await qrCode(url, `QR code of the link to ${name}`);
      } catch {
        qr = null;
        if (dialog.open) say("The QR code couldn't load. Check the connection, then try again.", "error");
        return dialog.open ? (render(), focusQrToggle()) : undefined;
      }
      qrSvgs.set(url, made);
    }
    qr = { url, state: qrSvgs.get(url) ? "shown" : "too-long" };
    if (!dialog.open) return;
    render();
    focusQrToggle();
  }
  /** "Copy with title": the link named "Open <file> in ExecFlow" where links can carry a title. */
  async function copyTitled(url: string) {
    // The real name: the title is pasted elsewhere as the link's label (the sentence below tags it).
    const title = `Open ${fileName} in ExecFlow`;
    // Built as an element, so the file name is escaped by the serializer, never pasted into markup.
    const html = h("a", { href: url }, title).outerHTML;
    try {
      await (deps.writeRich ?? clipboardWriteRich)(html, `${title}: ${url}`);
      dialog.dataset.copy = "titled";
      say(`Copied the link with the title "${shown(title)}". Documents, mail and Teams show the title; chat apps such as WhatsApp show the whole link.`, "done");
    } catch {
      dialog.dataset.copy = "refused";
      say(`This browser didn't let ExecFlow copy. The link is selected in its field: press ${deps.mac ? "Cmd+C" : "Ctrl+C"} to copy it.`, "warning");
      const field = panel.querySelector<HTMLInputElement>("#share-link");
      field?.focus();
      field?.select();
    }
  }
  const refusalText = (refusal: MakeRefusal): string => {
    const instead = state.kind === "connected" ? "Share it as a secret gist instead." : "Connect GitHub to share it as a secret gist, or export it.";
    if (refusal.kind === "unsupported") return "This browser can't make code links. Use a current Chrome, Edge, Firefox or Safari.";
    if (refusal.kind === "not-text") return `${name} can't go in a link: ${refusal.reason}.`;
    // "empty" and "too-many" are folder links' (makeFolderLink); one file never gets them.
    if (refusal.kind !== "too-long") return `${name} can't go in a link. ${instead}`;
    const size = refusal.chars === null ? "" : ` (it would be ${refusal.chars.toLocaleString("en")} characters)`;
    // A file too big for any link (chars null: over 256 KB) can't be a short link either.
    const offer = refusal.chars === null ? instead : "Make a short link instead: it holds the code however long the link would be.";
    return `${name} is too long for a code link${size}: a link holds at most 8,000 characters, so chat apps keep it whole. ${offer}`;
  };
  /** The file's text, or the sentence saying why there is none to put in a link. */
  async function textToShare(): Promise<{ text: string } | { problem: string }> {
    let read: Awaited<ReturnType<ShareDeps["readText"]>>;
    try {
      read = await deps.readText();
    } catch {
      return { problem: `${name} couldn't be read on this computer, so there is no link.` };
    }
    if (read === "missing") return { problem: MISSING };
    if (read === "opaque") return { problem: `${name} is kept as read-only bytes, not as text, so it can't go in a link.` };
    return read;
  }
  async function makeCode(): Promise<{ url: string } | { problem: string; tooLong: boolean }> {
    const read = await textToShare();
    if ("problem" in read) return { problem: read.problem, tooLong: false };
    const made = await deps.codeLink(read.text).catch(() => null);
    if (!made) return { problem: "ExecFlow couldn't make the link. Try again.", tooLong: false };
    return made.ok ? { url: made.url } : { problem: refusalText(made.refusal), tooLong: made.refusal.kind === "too-long" && made.refusal.chars !== null };
  }

  /** Make short link: taken at once, so a second press can't make a second link; refusals go in the result line. */
  async function makeShort() {
    if (shortMaking || short) return;
    shortMaking = true;
    say("");
    render();
    let problem: string | null = null;
    const read = await textToShare();
    if ("problem" in read) problem = read.problem;
    else {
      const made = await deps.shortLink(read.text, ttl).catch(() => null);
      if (!made) problem = "ExecFlow couldn't make the short link. Try again.";
      else if (made.ok) short = { url: made.url, expires: made.expires };
      else problem = made.refusal.kind === "too-long" ? `${name} is more than a short link can hold (256 KB of text). Export it instead.` : shortMakeRefusalText(made.refusal);
    }
    shortMaking = false;
    if (!dialog.open) return;
    render();
    if (short) {
      say(`Made a short link, kept until ${expiryDay(short.expires)}. Copy it to share it.`, "done");
      primary.focus();
    } else say(problem ?? "", "error");
  }

  // ---------------------------------------------------------------- the link field
  const linkField = (url: string) => {
    const input = h("input", { type: "text", id: "share-link", readonly: true, spellcheck: "false", autocomplete: "off", "aria-describedby": "share-link-note" });
    input.value = url;
    input.addEventListener("focus", () => input.select());
    return input;
  };
  const external = (href: string, label: string, id: string) =>
    h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "ext-link", id }, label, deps.externalIcon());

  /** The gist made in this opening: never made twice. */
  let gist: { url: string | null } | null = null;
  let syncing = false;
  let creating = false;
  let syncButton: HTMLButtonElement | null = null;

  function currentUrl(): string | null {
    if (choice() === "code") return code && "url" in code ? code.url : null;
    if (choice() === "short") return short?.url ?? null;
    if (choice() === "gist") return gist?.url ?? null;
    return state.kind === "connected" && state.link.kind === "ready" ? state.link.url : null;
  }

  const INVALID = `ExecFlow couldn't make a safe GitHub address for ${name} from this workspace's connection, so there is no repository link. Disconnect and connect again to repair it.`;
  const MISSING = `${name} isn't in this workspace any more, so there is nothing to share.`;

  function render() {
    if (state.kind === "missing") {
      // The file went away while the dialog was open (a sync deleted it): nothing to offer.
      dialog.dataset.state = "missing";
      panel.replaceChildren();
      primary.remove();
      cancel.textContent = "Close";
      return;
    }
    const c = choice();
    dialog.dataset.choice = c;
    syncButton = null;
    // One filled control: Sync now while the repository link waits for it, else the footer's action.
    primary.classList.add("primary");
    // Once a gist exists there is nothing left to cancel.
    cancel.textContent = gist ? "Close" : "Cancel";
    /** A made link (code or short): the field, what it means, Copy with title and its QR code. */
    const madePanel = (url: string, note: string) => {
      const titled = h("button", { type: "button", class: "btn", id: "share-titled" }, "Copy with title");
      titled.addEventListener("click", (e) => {
        if (e.detail > 1) return;
        void copyTitled(url);
      });
      const q = qrState(url);
      const qrToggle = h("button", { type: "button", class: "btn", id: "share-qr-toggle", "aria-expanded": String(q !== "hidden"), "aria-controls": "share-qr-box" }, q === "hidden" ? "Show QR code" : "Hide QR code");
      qrToggle.addEventListener("click", (e) => {
        if (e.detail > 1) return;
        void toggleQr(url);
      });
      const qrBox = h("div", { class: "share-qr-box", id: "share-qr-box" });
      qrBox.hidden = q === "hidden";
      const qrSvg = qrSvgs.get(url);
      if (q === "making") qrBox.append(h("p", { class: "field-note" }, "Making the QR code..."));
      else if (q === "too-long") qrBox.append(h("p", { class: "share-pending" }, `This link is too long for a QR code. ${c === "code" ? "Make a short link for a code a phone can read, or copy" : "Copy"} the link instead.`));
      else if (q === "shown" && qrSvg) {
        qrBox.append(qrSvg);
        if (url.length > 1200) qrBox.append(h("p", { class: "field-note" }, "A long link makes a dense code: if a phone can't read it, zoom the page in or hold the phone closer, or make a short link."));
      }
      dialog.dataset.qr = q;
      panel.replaceChildren(
        h("div", { class: "field" }, h("label", { for: "share-link" }, "Link"), linkField(url)),
        h("p", { class: "field-note", id: "share-link-note" }, note),
        h("div", { class: "share-more" }, titled, qrToggle),
        qrBox,
      );
    };
    if (c === "code") {
      if (!code) {
        dialog.dataset.state = "code-making";
        panel.replaceChildren(h("p", { class: "share-pending", id: "share-pending" }, "Making the link..."));
      } else if ("url" in code) {
        dialog.dataset.state = "code";
        madePanel(code.url, "Anyone with the link can read the code. It's a copy of the file as it is now: later changes need a new link.");
      } else {
        dialog.dataset.state = "code-refused";
        const pending = h("p", { class: "share-pending", id: "share-pending" }, code.problem);
        if (!code.tooLong) panel.replaceChildren(pending);
        else {
          const instead = h("button", { type: "button", class: "btn", id: "share-use-short" }, icon("link-simple"), "Make a short link instead");
          instead.addEventListener("click", () => {
            shortRadio.input.checked = true;
            say("");
            render();
            dialog.querySelector<HTMLElement>("#share-ttl")?.focus();
          });
          panel.replaceChildren(pending, h("div", { class: "share-more" }, instead));
        }
      }
      setPrimary("copy", "Copy link");
    } else if (c === "short") {
      if (short) {
        dialog.dataset.state = "short";
        madePanel(short.url, `Anyone with the link can read the code until ${expiryDay(short.expires)}, when ExecFlow's server deletes the encrypted copy. It's a copy of the file as it is now: later changes need a new link.`);
        setPrimary("copy", "Copy link");
      } else {
        dialog.dataset.state = shortMaking ? "short-making" : "short-ready";
        delete dialog.dataset.qr;
        const field = expiryField("share-ttl", ttl, (t) => (ttl = t));
        panel.replaceChildren(field, h("p", { class: "field-note", id: "share-ttl-note" }, "Making it sends the encrypted code to ExecFlow's server, so it needs a connection. Nothing is sent before you press Make short link."));
        field.querySelector("select")!.setAttribute("aria-describedby", "share-ttl-note");
        setPrimary("link-simple", shortMaking ? "Making short link..." : "Make short link");
      }
    } else if (state.kind !== "connected") {
      dialog.dataset.state = "not-connected";
      panel.replaceChildren(
        h(
          "p",
          { class: "share-pending", id: "share-pending" },
          c === "repo"
            ? "This link comes from the GitHub repository this workspace syncs with, so connect GitHub first. Your files stay on this computer until you do."
            : "The gist is made on your GitHub account, so connect GitHub first. Your files stay on this computer until you do.",
        ),
      );
      setPrimary("github-logo", "Connect GitHub...");
    } else if (c === "repo") {
      const link = state.link;
      if (link.kind === "ready") {
        dialog.dataset.state = "ready";
        panel.replaceChildren(
          h("div", { class: "field" }, h("label", { for: "share-link" }, "Link"), linkField(link.url)),
          h("p", { class: "field-note", id: "share-link-note" }, "Pinned to the commit of the last sync: later changes need a new link. ", external(link.url, "Open on GitHub", "share-open")),
        );
      } else if (link.kind === "invalid") {
        dialog.dataset.state = "invalid";
        panel.replaceChildren(h("p", { class: "share-pending", id: "share-pending" }, INVALID));
      } else {
        dialog.dataset.state = syncing ? "syncing" : "pending";
        syncButton = h("button", { type: "button", class: "btn primary", id: "share-sync" }, icon("cloud-arrow-up"), syncing ? "Syncing..." : "Sync now");
        primary.classList.remove("primary");
        syncButton.addEventListener("click", (e) => {
          if (e.detail > 1) return;
          void syncFirst();
        });
        panel.replaceChildren(
          h(
            "p",
            { class: "share-pending", id: "share-pending" },
            link.kind === "new"
              ? `${name} isn't on GitHub yet. Sync now to add it, then copy the link.`
              : `${name} has changes that aren't on GitHub yet. Sync now first, so the link shows what you see.`,
          ),
          syncButton,
        );
      }
      setPrimary("copy", "Copy link");
    } else if (gist) {
      dialog.dataset.state = "created";
      panel.replaceChildren(
        ...(gist.url
          ? [
              h("div", { class: "field" }, h("label", { for: "share-link" }, "Link"), linkField(gist.url)),
              h("p", { class: "field-note", id: "share-link-note" }, "To remove it, ", external(gist.url, "open the gist on GitHub", "share-open"), " and delete it there."),
            ]
          : [h("p", { class: "share-pending" }, "GitHub made the gist, but its address didn't look like a GitHub page, so ExecFlow doesn't show it. Find it under Your gists on GitHub, where you can also delete it.")]),
      );
      setPrimary("copy", "Copy link");
    } else {
      dialog.dataset.state = creating ? "creating" : "gist";
      panel.replaceChildren();
      setPrimary("link-simple", creating ? "Creating link..." : "Create link");
    }
  }

  async function syncFirst() {
    if (syncing) return;
    syncing = true;
    say("");
    render();
    syncButton?.focus();
    let problem: string | null;
    try {
      problem = await deps.syncNow();
    } catch {
      problem = "The sync couldn't start, so try again.";
    }
    const next = await deps.state().catch(() => state);
    syncing = false;
    if (!dialog.open) return;
    state = next;
    render();
    if (state.kind !== "connected") return say(MISSING, "error");
    if (state.link.kind === "ready") {
      say(`Synced. The link shows ${name} as it is now.`, "done");
      if (choice() === "repo") primary.focus();
    } else {
      say(problem ?? `${name} still isn't on GitHub as you see it, so there is no link yet. Sync again in a moment.`, "error");
      syncButton?.focus();
    }
  }

  /** Create link: taken at once (before anything is awaited), so a second press can't make a second gist. */
  async function createGist() {
    if (creating || gist) return;
    creating = true;
    say("");
    render();
    let outcome: { message: string; tone: "error" | "done" } | "withdrawn";
    try {
      outcome = await makeGist();
    } finally {
      creating = false;
    }
    // Closed before anything was sent: nothing was made, and there is nothing to say.
    if (outcome === "withdrawn") return;
    if (!dialog.open) {
      // Closed while GitHub was answering: the gist may exist, so the page's notice says where.
      const made = gist as { url: string | null } | null;
      if (made) {
        const url = made.url;
        // The notice tags unshown characters itself (notice.ts), so it gets the real name.
        deps.notice.show(`Made a secret gist of ${fileName} after the dialog closed: anyone with its link can open it.${url ? "" : " Find it under Your gists on GitHub."}`, {
          tone: "warning",
          action: url ? { label: "Open the gist", run: () => void window.open(url, "_blank", "noopener,noreferrer") } : undefined,
        });
      } else if (outcome.tone === "error") deps.notice.show(`No gist of ${fileName} was made: ${outcome.message}`, { tone: "info" });
      return;
    }
    render();
    say(outcome.message, outcome.tone);
    if (gist) primary.focus();
  }

  /** "withdrawn": the dialog closed before the request went out, so nothing was sent. */
  async function makeGist(): Promise<{ message: string; tone: "error" | "done" } | "withdrawn"> {
    const error = (message: string) => ({ message, tone: "error" as const });
    const readOnly = deps.readOnly();
    if (readOnly) return error(readOnly);
    let read: Awaited<ReturnType<ShareDeps["readText"]>>;
    try {
      read = await deps.readText();
    } catch {
      return wanted.signal.aborted ? "withdrawn" : error(`${name} couldn't be read on this computer, so no gist was made.`);
    }
    if (wanted.signal.aborted) return "withdrawn";
    if (read === "missing") return error(`${name} isn't in this workspace any more, so no gist was made.`);
    const text = read === "opaque" ? null : read.text;
    const refusal = rules.gistRefusal({ opaque: read === "opaque" || (state.kind === "connected" && state.opaque), text });
    if (refusal || text === null) return error(rules.refusalText(refusal ?? { kind: "opaque" }, deps.path));
    if (!deps.online()) return error("This device is offline, so the gist can't be made now. Try again once you're online.");
    if (!deps.createGist) {
      return error(
        deps.auth === "app"
          ? "Your GitHub sign-in has ended on this device, so sign in again (the sync status) to make a gist."
          : "This tab has no GitHub token, so enter it again (the sync status) to make a gist.",
      );
    }
    const signal = wanted.signal;
    try {
      const made = await deps.createGist(rules.gistRequest(deps.path, text), signal);
      gist = { url: rules.gistPageUrl(made.htmlUrl) };
      return { message: gist.url ? "Made a secret gist. Copy its link to share it." : "Made a secret gist.", tone: "done" };
    } catch (e) {
      // The client refused to send it (its turn came after the dialog closed): exactly the reason.
      if (signal.aborted && e === signal.reason) return "withdrawn";
      return error(rules.explainGistError(e, deps.auth));
    }
  }

  async function copy(url: string) {
    const field = panel.querySelector<HTMLInputElement>("#share-link");
    try {
      await (deps.writeText ?? clipboardWrite)(url);
      dialog.dataset.copy = "copied";
      say("Copied the link.", "done");
    } catch {
      dialog.dataset.copy = "refused";
      say(`This browser didn't let ExecFlow copy. The link is selected in its field: press ${deps.mac ? "Cmd+C" : "Ctrl+C"} to copy it.`, "warning");
      field?.focus();
      field?.select();
    }
  }

  primary.addEventListener("click", (e) => {
    // The second click of a double click does nothing (the Run rule): one press, one gist.
    if (e.detail > 1) return;
    const url = currentUrl();
    if (url) return void copy(url);
    if (choice() === "code") return code && "problem" in code ? say(code.problem, "error") : undefined;
    if (choice() === "short") return void makeShort();
    if (state.kind !== "connected") {
      dialog.close();
      return deps.connect();
    }
    if (choice() === "gist") return void createGist();
    if (syncing) return;
    if (state.link.kind === "invalid") return say(INVALID, "error");
    say(`There is no link to copy yet: press Sync now first, so the repository has ${name} as you see it.`, "error");
    syncButton?.focus();
  });
  for (const input of [codeRadio.input, shortRadio.input, repoRadio.input, gistRadio.input]) {
    input.addEventListener("change", () => {
      say("");
      delete dialog.dataset.copy;
      render();
    });
  }

  render();
  openModal(dialog, codeRadio.input, deps.returnTo);
  // The code link is made at once (nothing is sent): it is usually ready before the first look.
  code = await makeCode();
  if (dialog.open) render();
}
