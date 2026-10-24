// Share link (.claude/design/batch5/share-link.md): one dialog, two clearly labelled links, chosen
// with a radio, then the primary action.
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
// ("not-connected", "ready", "pending", "syncing", "gist", "creating", "created"), data-choice,
// data-copy ("copied", "refused"), data-visibility ("private", "public", "unknown"; data-public
// too while public) and data-checked (the live visibility check has answered or failed).
// Who can open the repository link: the live answer (GET /repos) when there is one, else the
// answer stored when connecting; the sentence promising that only the repository's people can
// open it is shown only for a repository known to be private.
// Closing the dialog (Cancel, Escape, the close button) withdraws a gist that hasn't been sent:
// a request waiting behind a sync's writes is dropped, and nothing is said about it.
import { nameOf } from "../core/paths";
import type { GistBody } from "../sync/github";
// Types only: the rules come in through deps.rules (the controller's import), so this chunk never
// shares a module with the sync chunk and Connect GitHub still loads one chunk (sync.spec.ts).
import type * as ShareRules from "../sync/share";
import type { RepoLinkState } from "../sync/share";
import type { AuthKind } from "../sync/repo-check";
import { dialogShell, openModal } from "./dialogs";
import { h } from "./dom";
import { icon } from "./icons";
import type { Notice } from "./notice";

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
  readonly mac: boolean;
}

type Choice = "repo" | "gist";

let open = false;

function clipboardWrite(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) return Promise.reject(new Error("no clipboard"));
    return navigator.clipboard.writeText(text);
  } catch (e) {
    return Promise.reject(e);
  }
}

export async function openShareDialog(deps: ShareDeps): Promise<void> {
  if (open || document.querySelector("dialog[open], .menu")) return;
  open = true;
  const { rules } = deps;
  const name = nameOf(deps.path);
  const { dialog, body } = dialogShell("share-dialog", `Share ${name}`, { wide: true });
  dialog.classList.add("sync-dialog", "share-dialog");
  /** Aborted when the dialog closes: a gist not sent by then never is. */
  const wanted = new AbortController();
  dialog.addEventListener("close", () => {
    wanted.abort();
    dialog.remove();
    open = false;
  }, { once: true });

  const result = h("p", { class: "connect-result share-result", id: "share-result", role: "status" });
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
    result.replaceChildren(...(glyph ? [glyph] : []), h("span", null, message));
  }
  const setPrimary = (glyph: "copy" | "github-logo" | "link-simple", label: string) => primary.replaceChildren(icon(glyph), label);

  let state = await deps.state().catch((): ShareState => ({ kind: "missing" }));

  // ---------------------------------------------------------------- not connected
  if (state.kind !== "connected") {
    dialog.dataset.state = state.kind;
    body.append(
      h(
        "p",
        { class: "connect-lede", id: "share-lede" },
        state.kind === "missing"
          ? `${name} isn't in this workspace any more, so there is nothing to share.`
          : "Share links come from the GitHub repository this workspace syncs with, so connect GitHub first. Your files stay on this computer until you do.",
      ),
    );
    dialog.setAttribute("aria-describedby", "share-lede");
    if (state.kind === "missing") {
      primary.remove();
      cancel.textContent = "Close";
      openModal(dialog, cancel, deps.returnTo);
      return;
    }
    setPrimary("github-logo", "Connect GitHub...");
    primary.addEventListener("click", () => {
      dialog.close();
      deps.connect();
    });
    openModal(dialog, primary, deps.returnTo);
    return;
  }

  // ---------------------------------------------------------------- the choice
  const radio = (value: Choice, label: string, note: Node[]) => {
    const input = h("input", { type: "radio", name: "share-choice", id: `share-${value}`, value, "aria-describedby": `share-${value}-note` });
    input.checked = value === "repo";
    const row = h("div", { class: "choice", "data-choice": value }, input, h("label", { for: input.id }, label), h("div", { class: "field-note share-note", id: `share-${value}-note` }, ...note));
    return { input, row };
  };
  const repo = state.repo;
  const repoWho = h("p", { class: "share-who" });
  /** The note, its tone and the attributes for a visibility (stored first, then the live answer). */
  const showAudience = (isPrivate: boolean | null) => {
    const audience = rules.repoAudience(repo, isPrivate);
    repoWho.textContent = audience.text;
    repoWho.classList.toggle("share-warn", audience.visibility !== "private");
    dialog.dataset.visibility = audience.visibility;
    if (audience.visibility === "public") dialog.dataset.public = "";
    else delete dialog.dataset.public;
  };
  showAudience(state.private);
  const repoRadio = radio("repo", "People with access to the repository", [repoWho]);
  const gistRadio = radio("gist", "Anyone with the link (a secret gist)", [
    h("p", { class: "share-warn" }, "Secret gists aren't private: anyone with the link can open it, without signing in."),
    h("p", null, `CodeEditor makes a copy of ${name} as a secret gist on your GitHub account only when you press Create link. GitHub doesn't list it or show it in search.`),
  ]);
  const panel = h("div", { class: "share-panel", id: "share-panel" });
  body.append(
    h("h3", { class: "steps-title", id: "share-title" }, "Who can open the link"),
    h("fieldset", { class: "choice-list", id: "share-choices" }, h("legend", { class: "visually-hidden" }, "Who can open the link"), repoRadio.row, gistRadio.row),
    panel,
    result,
  );
  const choice = (): Choice => (gistRadio.input.checked ? "gist" : "repo");

  // The repository's visibility, asked once: a public repository's link opens for anyone. No answer
  // (no token here, offline, a rate limit, a server error) keeps the stored one.
  void deps
    .repoPrivate()
    .catch(() => null)
    .then((live) => {
      if (!dialog.open) return;
      if (live !== null) showAudience(live);
      dialog.dataset.checked = "";
    });

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
    if (choice() === "gist") return gist?.url ?? null;
    return state.kind === "connected" && state.link.kind === "ready" ? state.link.url : null;
  }

  const INVALID = `CodeEditor couldn't make a safe GitHub address for ${name} from this workspace's connection, so there is no repository link. Disconnect and connect again to repair it.`;
  const MISSING = `${name} isn't in this workspace any more, so there is nothing to share.`;

  function render() {
    if (state.kind !== "connected") {
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
    if (c === "repo") {
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
          : [h("p", { class: "share-pending" }, "GitHub made the gist, but its address didn't look like a GitHub page, so CodeEditor doesn't show it. Find it under Your gists on GitHub, where you can also delete it.")]),
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
        deps.notice.show(`Made a secret gist of ${name} after the dialog closed: anyone with its link can open it.${url ? "" : " Find it under Your gists on GitHub."}`, {
          tone: "warning",
          action: url ? { label: "Open the gist", run: () => void window.open(url, "_blank", "noopener,noreferrer") } : undefined,
        });
      } else if (outcome.tone === "error") deps.notice.show(`No gist of ${name} was made: ${outcome.message}`, { tone: "info" });
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
          ? "Your GitHub sign-in has ended on this device, so sign in again (Sync status in the top bar) to make a gist."
          : "This tab has no GitHub token, so enter it again (Sync status in the top bar) to make a gist.",
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
      say(`This browser didn't let CodeEditor copy. The link is selected in its field: press ${deps.mac ? "Cmd+C" : "Ctrl+C"} to copy it.`, "warning");
      field?.focus();
      field?.select();
    }
  }

  primary.addEventListener("click", (e) => {
    // The second click of a double click does nothing (the Run rule): one press, one gist.
    if (e.detail > 1) return;
    const url = currentUrl();
    if (url) return void copy(url);
    if (choice() === "gist") return void createGist();
    if (syncing) return;
    if (state.kind === "connected" && state.link.kind === "invalid") return say(INVALID, "error");
    say(`There is no link to copy yet: press Sync now first, so the repository has ${name} as you see it.`, "error");
    syncButton?.focus();
  });
  for (const input of [repoRadio.input, gistRadio.input]) {
    input.addEventListener("change", () => {
      say("");
      delete dialog.dataset.copy;
      render();
    });
  }

  render();
  openModal(dialog, repoRadio.input, deps.returnTo);
}
