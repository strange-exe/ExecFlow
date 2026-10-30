// The Connect GitHub dialog, in reading order: first what connecting does and where the
// token is kept, then the repository and token fields, then Connect; below them the steps to make
// a fine-grained token and "Remember on this device" (off by default on both paths, with the
// shared-computer note). The network checks are the controller's (check/save); this file is the form.
//
// The token: a password field (no autocomplete, no spellcheck) with no `name`, inside a form whose
// submit is always cancelled, so it can't end up in a URL. It is read once per attempt and the
// field is cleared once it has been used or the dialog closes; it never goes into an attribute,
// a message or the log. The dialog is built fresh for every opening and removed when it closes.
//
// The error state (DESIGN.md decision 13) leads with the error. A field's message sits right under
// it, before its hint, on the error band with a danger bar; the field gets aria-invalid and
// aria-describedby (message first). Focus moves to the first field in error (W3C WAI forms
// tutorial, "User Notifications"), which reads that description; when focus is already there, the
// dialog's live region says the message instead, so it is heard once either way. A failure that
// belongs to no field (offline, a missing repository, a rate limit...) is the result line above
// Connect, said by the same live region; focus stays where it was.
import { validateTokenShape } from "../sync/token-store";
import { h } from "./dom";
import { openModal } from "./dialogs";
import { createAnnouncer } from "./notice";
import { branchProblem, ownerProblem, parseRepoInput, repoProblem, tokenPageUrl } from "./sync-form";
import { syncIcon } from "./sync-icons";

export interface ConnectInput {
  owner: string;
  repo: string;
  /** Empty: the repository's default branch. */
  branch: string;
  token: string;
  remember: boolean;
}

export type ConnectField = "owner" | "repo" | "branch" | "token";

export type CheckResult =
  | { ok: true; private: boolean; branch: string }
  | { ok: false; message: string; field?: ConnectField; clearToken?: boolean };

export interface ConnectDeps {
  /** Pre-filled when the workspace is already connected (a token is needed again). */
  initial: { owner: string; repo: string; branch: string } | null;
  /** Reads the repository with the token: one plain sentence when it can't. */
  check(input: ConnectInput): Promise<CheckResult>;
  /** Keeps the connection (after a successful check). Returns a sentence if that failed. */
  save(input: ConnectInput): Promise<string | null>;
  returnFocus?: HTMLElement | null;
  /** "Sign in with GitHub": absent when this site has no sign-in relay (then only the token form shows). */
  signIn?: SignInDeps;
}

/** A repository the GitHub App can reach for the signed-in student. */
export interface PickRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
}

export interface ReachView {
  login: string;
  repos: PickRepo[];
  /** Where the student changes which repositories ExecFlow can reach (one installation), if known. */
  settingsUrl: string | null;
  /** github.com/apps/<slug>/installations/new */
  installUrl: string;
}

export type ReachResult = { ok: true; reach: ReachView } | { ok: false; message: string; openToken?: boolean };

export interface SignInDeps {
  /** The sentence to lead with when the dialog opens (a sign-in that was ignored, cancelled or ended). */
  message?: string;
  /** This device was offline when the dialog opened. */
  offline: boolean;
  /** Open the token form at once (a connection made with a pasted token needs one again). */
  openToken: boolean;
  /** Leaves for GitHub (after saving the files). Resolves only when it couldn't, with why. */
  start(remember: boolean): Promise<{ message: string; openToken?: boolean }>;
  /** Set when GitHub has just sent the student back: finishes signing in and lists the repositories. */
  resume: (() => Promise<ReachResult>) | null;
  /** Lists the repositories again ("Check again", and when the window regains focus). */
  reach(): Promise<ReachResult>;
  check(repo: PickRepo, branch: string): Promise<CheckResult>;
  save(repo: PickRepo, branch: string): Promise<string | null>;
  /** The connected repository: chosen already in the list after signing in again. */
  current: { owner: string; repo: string } | null;
  /** The dialog closed after signing in but without connecting: the unused token is revoked. */
  abandon(): void;
}

/**
 * GitHub's new-repository page with Private chosen. A fixed address: nothing typed goes into it.
 * `visibility=private` is documented under "Creating a new repository from a URL query":
 * https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository
 */
const NEW_REPO_URL = "https://github.com/new?visibility=private";

/** "No repository yet? Create a private one on GitHub." (both connect paths; a new tab, no opener or referrer). */
function newRepoNote(id: string): HTMLElement {
  return h(
    "p",
    { class: "field-note new-repo", id },
    "No repository yet? ",
    h("a", { href: NEW_REPO_URL, target: "_blank", rel: "noopener noreferrer", class: "ext-link" }, "Create a private one on GitHub", syncIcon("arrow-square-out", "ext-icon")),
    ", then come back.",
  );
}

interface TextField {
  row: HTMLElement;
  input: HTMLInputElement;
  setError(message: string | null): void;
  setNote(message: string, tone?: "warning"): void;
}

/** The dialog's live region: what a failed attempt found, said once (notice.ts's clear-then-say). */
function connectAnnouncer() {
  const announcer = createAnnouncer();
  announcer.element.id = "connect-announce";
  // The workbench's own announcer is the one [data-announcer] on the page.
  announcer.element.removeAttribute("data-announcer");
  return announcer;
}

function textField(id: string, label: string, options: { type?: "text" | "password"; hint?: string; placeholder?: string } = {}): TextField {
  const input = h("input", {
    type: options.type ?? "text",
    id,
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
    autocorrect: "off",
    placeholder: options.placeholder,
  });
  const note = h("p", { class: "field-note", id: `${id}-note` }, options.hint ?? "");
  note.hidden = !options.hint;
  const error = h("p", { class: "field-error", id: `${id}-error`, "data-tone": "error" });
  error.hidden = true;
  // The message leads: read first, and drawn first, right under the field (the hint follows it).
  const describe = () => {
    const ids = [!error.hidden && error.id, !note.hidden && note.id].filter(Boolean).join(" ");
    if (ids) input.setAttribute("aria-describedby", ids);
    else input.removeAttribute("aria-describedby");
  };
  describe();
  const row = h("div", { class: "field" }, h("label", { for: id }, label), input, error, note);
  return {
    row,
    input,
    setError(message) {
      error.replaceChildren(...(message ? [syncIcon("warning-circle", "error-icon"), h("span", null, message)] : []));
      error.hidden = !message;
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
      describe();
    },
    setNote(message, tone) {
      note.textContent = message;
      note.hidden = !message;
      if (tone) note.dataset.tone = tone;
      else delete note.dataset.tone;
      describe();
    },
  };
}

/** Opens the dialog; resolves true once connected, false when it was closed without connecting. */
export function openConnectDialog(deps: ConnectDeps): Promise<boolean> {
  return new Promise((resolve) => {
    const id = "connect-dialog";
    document.getElementById(id)?.remove();
    const owner = textField("connect-owner", "Owner", { placeholder: "your-account" });
    const repo = textField("connect-repo", "Repository name", { placeholder: "my-code" });
    const branch = textField("connect-branch", "Branch (optional)", { hint: "Empty: the repository's default branch." });
    const tokenHint = "Fine-grained tokens start with github_pat_.";
    const token = textField("connect-token", "Fine-grained token", { type: "password", hint: tokenHint });
    // Not a login: ask password managers that read these hints not to offer to save it. (The
    // browsers' own managers ignore them, so the Remember note below says what to answer.)
    for (const name of ["data-1p-ignore", "data-lpignore", "data-bwignore"]) token.input.setAttribute(name, "true");
    token.input.setAttribute("data-form-type", "other");
    if (deps.initial) {
      owner.input.value = deps.initial.owner;
      repo.input.value = deps.initial.repo;
      branch.input.value = deps.initial.branch;
    }

    const remember = h("input", { type: "checkbox", id: "connect-remember", "aria-describedby": "connect-remember-note" });
    remember.checked = false;
    const rememberRow = h(
      "div",
      { class: "check" },
      remember,
      h("label", { for: "connect-remember" }, "Remember on this device"),
      h(
        "p",
        { class: "field-note", id: "connect-remember-note" },
        "Leave this off on shared computers (a college lab): the token is kept only until you close the tab. On: it is stored encrypted in this browser until you disconnect. If the browser offers to save the token as a password, choose Never on a shared computer.",
      ),
    );

    const pageLink = h("a", { href: tokenPageUrl("", ""), target: "_blank", rel: "noopener noreferrer", class: "ext-link" }, "GitHub's new fine-grained token page", syncIcon("arrow-square-out", "ext-icon"));
    const pickRepo = h("span", null, "this repository");
    const steps = h(
      "section",
      { class: "token-steps", "aria-labelledby": "token-steps-title" },
      h("h3", { class: "steps-title", id: "token-steps-title" }, "Make a token for this repository only"),
      h(
        "ol",
        null,
        h("li", null, "Open ", pageLink, " (a new tab; name, Contents and 90 days are filled in)."),
        h("li", null, "Repository access: choose Only select repositories, then pick ", pickRepo, "."),
        h("li", null, "Permissions: Contents is Read and write. Nothing else is needed."),
        h("li", null, "Expiration: 90 days. Generate the token, copy it and paste it above."),
      ),
    );
    const refreshSteps = () => {
      const o = owner.input.value.trim();
      const r = repo.input.value.trim();
      pageLink.href = tokenPageUrl(o, r);
      pickRepo.textContent = ownerProblem(o) === null && repoProblem(r) === null ? `${o}/${r}` : "this repository";
    };
    refreshSteps();

    // One line for what the check found when it belongs to no field (a failure, or the
    // public-repository warning). The live region below says it; this line only shows it.
    const result = h("p", { class: "result-line connect-result", id: "connect-result" });
    const announcer = connectAnnouncer();

    const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
    const submitLabel = h("span", null, "Connect");
    const submit = h("button", { type: "submit", class: "btn primary", id: "connect-submit" }, syncIcon("github-logo"), submitLabel);
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)" }, syncIcon("x"));

    // Today's token form, unchanged. With sign-in available it sits behind "Use a token instead".
    const tokenPanel = h(
      "div",
      { class: "token-panel", id: "connect-token-panel" },
      h(
        "p",
        { class: "connect-where" },
        syncIcon("lock", "where-icon"),
        h("span", null, "ExecFlow sends the token only to api.github.com, from this browser. It stays in this tab's memory and is forgotten when you close the tab, unless you choose Remember below."),
      ),
      h(
        "fieldset",
        { class: "repo-fields" },
        h("legend", { class: "steps-title" }, "GitHub repository"),
        h("div", { class: "repo-row" }, owner.row, h("span", { class: "repo-slash", "aria-hidden": "true" }, "/"), repo.row),
        branch.row,
        newRepoNote("connect-new-repo"),
      ),
      token.row,
      result,
      steps,
      rememberRow,
    );
    const body = h(
      "div",
      { class: "dialog-body" },
      h("p", { class: "connect-lede", id: "connect-lede" }, "Connecting keeps this workspace in a private GitHub repository. Each sync uploads your changes as one commit and brings in changes made on GitHub or on other computers."),
      tokenPanel,
    );
    const form = h("form", { class: "dialog-form", novalidate: true, autocomplete: "off" }, body, h("div", { class: "dialog-actions" }, cancel, submit));
    const dialog = h(
      "dialog",
      { class: "dialog wide sync-dialog", id, "aria-labelledby": `${id}-title`, "aria-describedby": "connect-lede", "data-state": "idle" },
      h("div", { class: "dialog-head" }, h("h2", { id: `${id}-title`, class: "dialog-title" }, "Connect GitHub"), close),
      form,
      announcer.element,
    );

    let busy = false;
    let closed = false;
    let connected = false;
    /** The repository answered as public and the user hasn't confirmed yet. */
    let publicConfirmed: string | null = null;

    const setState = (state: "idle" | "invalid" | "checking" | "failed" | "public" | "saving") => {
      dialog.dataset.state = state;
      busy = state === "checking" || state === "saving";
      submitLabel.textContent = state === "checking" ? "Checking access..." : state === "saving" ? "Connecting..." : state === "public" ? "Connect anyway" : "Connect";
    };
    const say = (message: string, tone?: "error" | "warning") => {
      result.replaceChildren(...(message && tone ? [syncIcon(tone === "error" ? "warning-circle" : "warning", "result-icon"), h("span", null, message)] : message ? [message] : []));
      if (tone) result.dataset.tone = tone;
      else delete result.dataset.tone;
      if (!message) {
        // A new attempt: the last spoken sentence is stale (emptying the region is not announced).
        announcer.say("");
        return;
      }
      result.scrollIntoView({ block: "nearest" });
      announcer.say(message);
      dialog.dataset.announce = "live";
    };
    const fields: Record<ConnectField, TextField> = { owner, repo, branch, token };
    // An edit makes the last spoken error stale too: empty the live region, so reading on through the
    // dialog never meets it. (The result line keeps showing what the last attempt found.)
    form.addEventListener("input", () => announcer.say(""));
    /** Shows a field's error and leads with it: focus on the field (its description reads the message), else the live region. */
    const fieldError = (name: ConnectField, message: string) => {
      const f = fields[name];
      f.setError(message);
      // data-announce says which of the two spoke (the tests wait on it, never on timing).
      if (document.activeElement === f.input) {
        announcer.say(message);
        dialog.dataset.announce = "live";
      } else {
        f.input.focus({ preventScroll: true });
        dialog.dataset.announce = "focus";
      }
      // The label, the field and its message in view (on a phone the body scrolls under the header).
      f.row.scrollIntoView({ block: "nearest" });
    };

    // Pasting "owner/repo" or a GitHub URL into either repository field fills both.
    for (const f of [owner, repo]) {
      f.input.addEventListener("input", () => {
        const parsed = parseRepoInput(f.input.value);
        if (parsed) {
          owner.input.value = parsed.owner;
          repo.input.value = parsed.repo;
        }
        f.setError(null);
        publicConfirmed = null;
        if (dialog.dataset.state === "public") setState("idle");
        refreshSteps();
      });
    }
    branch.input.addEventListener("input", () => branch.setError(null));
    // Token shape, as it is pasted: a classic token gets its warning at once; mistakes wait for Connect.
    token.input.addEventListener("input", () => {
      token.setError(null);
      const shape = validateTokenShape(token.input.value);
      token.setNote(shape.ok && shape.warning ? shape.warning : tokenHint, shape.ok && shape.warning ? "warning" : undefined);
    });

    // data-attempts counts finished attempts, so a test knows the next result is in.
    let attempts = 0;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (signIn?.picking()) {
        if (!signIn.busy()) void signIn.connect().finally(() => (dialog.dataset.attempts = String(++attempts)));
        return;
      }
      if (tokenPanel.hidden) return;
      if (!busy) void attempt().finally(() => (dialog.dataset.attempts = String(++attempts)));
    });
    cancel.addEventListener("click", () => dialog.close());
    close.addEventListener("click", () => dialog.close());

    async function attempt() {
      say("");
      delete dialog.dataset.announce;
      const input: ConnectInput = {
        owner: owner.input.value.trim(),
        repo: repo.input.value.trim(),
        branch: branch.input.value.trim(),
        token: "",
        remember: remember.checked,
      };
      const problems: [ConnectField, string | null][] = [
        ["owner", ownerProblem(input.owner)],
        ["repo", repoProblem(input.repo)],
        ["branch", branchProblem(input.branch)],
      ];
      const shape = validateTokenShape(token.input.value);
      problems.push(["token", shape.ok ? null : shape.reason]);
      for (const [name, message] of problems) fields[name].setError(message);
      const first = problems.find((p): p is [ConnectField, string] => p[1] !== null);
      if (first) {
        setState("invalid");
        fieldError(first[0], first[1]);
        return;
      }
      if (!shape.ok) return;
      input.token = shape.token;
      const target = `${input.owner}/${input.repo}`.toLowerCase();

      setState("checking");
      const checked = await deps.check(input);
      if (closed) return;
      if (!checked.ok) {
        setState("failed");
        if (checked.clearToken) token.input.value = "";
        if (checked.field) fieldError(checked.field, checked.message);
        else say(checked.message, "error");
        return;
      }
      if (!checked.private && publicConfirmed !== target) {
        publicConfirmed = target;
        setState("public");
        say("This repository is public: anyone can read the code in it. Make it private on GitHub (the repository's Settings, General, Danger Zone, Change visibility), or choose Connect anyway.", "warning");
        return;
      }
      setState("saving");
      const problem = await deps.save({ ...input, branch: checked.branch });
      if (closed) return;
      if (problem) {
        setState("failed");
        say(problem, "error");
        return;
      }
      connected = true;
      dialog.close();
    }

    const signIn = deps.signIn
      ? signInViews(deps.signIn, {
          dialog,
          body,
          tokenPanel,
          submit,
          submitLabel,
          announcer,
          onConnected: () => {
            connected = true;
            dialog.close();
          },
          isClosed: () => closed,
        })
      : null;

    dialog.addEventListener(
      "close",
      () => {
        closed = true;
        token.input.value = "";
        signIn?.closed(connected);
        dialog.remove();
        resolve(connected);
      },
      { once: true },
    );
    const first = deps.initial ? token.input : owner.input;
    openModal(dialog, signIn ? signIn.initialFocus(first) : first, deps.returnFocus);
    signIn?.opened();
  });
}

interface ViewHost {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  tokenPanel: HTMLElement;
  submit: HTMLButtonElement;
  submitLabel: HTMLElement;
  announcer: { say(text: string): void };
  onConnected(): void;
  isClosed(): boolean;
}

/**
 * The sign-in views (design: .claude/design/signin.md section 4), drawn above the token form in
 * the same dialog. data-view says which one shows: "start" (Sign in with GitHub, Remember, Use a
 * token instead), "busy" (finishing sign-in after GitHub sent the student back), "pick" (the
 * repositories the app can reach) and "empty" (none yet: choose one on GitHub). data-state
 * carries the step tests wait on: redirecting, signing-in, pick, pick-empty, signin-failed.
 * Every sentence comes from the controller or fixed text here; no token ever reaches the DOM.
 */
function signInViews(deps: SignInDeps, host: ViewHost) {
  const { dialog, body, tokenPanel, submit, submitLabel, announcer } = host;
  type View = "start" | "busy" | "pick" | "empty";
  let view: View = "start";
  let busy = false;
  let reach: ReachView | null = null;
  let publicConfirmed: number | null = null;

  const section = h("section", { class: "signin", id: "connect-signin-section", "aria-label": "Sign in with GitHub" });
  const signInResult = h("p", { class: "result-line connect-result", id: "connect-signin-result" });
  const say = (message: string, tone?: "error" | "warning") => {
    signInResult.replaceChildren(...(message && tone ? [syncIcon(tone === "error" ? "warning-circle" : "warning", "result-icon"), h("span", null, message)] : message ? [message] : []));
    if (tone) signInResult.dataset.tone = tone;
    else delete signInResult.dataset.tone;
    announcer.say(message);
    if (message) {
      signInResult.scrollIntoView({ block: "nearest" });
      dialog.dataset.announce = "live";
    }
  };

  // ---- start
  const signInLabel = h("span", null, "Sign in with GitHub");
  const signInButton = h("button", { type: "button", class: "btn primary signin-btn", id: "connect-signin", "aria-describedby": "connect-signin-note" }, syncIcon("github-logo"), signInLabel);
  const remember = h("input", { type: "checkbox", id: "connect-signin-remember", "aria-describedby": "connect-signin-remember-note" });
  // The owner's choice (2026-10-24, replacing 2026-10-23's "on"): off by default, as on the token
  // path, since students sign in on lab computers. A sign-in remembered before stays remembered.
  remember.checked = false;
  const startView = h(
    "div",
    { class: "signin-start" },
    signInButton,
    h(
      "p",
      { class: "field-note", id: "connect-signin-note" },
      "You go to GitHub to allow ExecFlow, then come back here. Your files are saved first. What is sent to GitHub: ",
      h("a", { href: "/privacy#github", target: "_blank", rel: "noopener noreferrer" }, "Privacy"),
      ".",
    ),
    h(
      "div",
      { class: "check" },
      remember,
      h("label", { for: "connect-signin-remember" }, "Remember on this device"),
      h(
        "p",
        { class: "field-note", id: "connect-signin-remember-note" },
        "Leave this off on a shared computer (a college lab): the sign-in is kept only until you close the tab. On: it is stored encrypted in this browser until you disconnect, so the next visit syncs by itself.",
      ),
    ),
  );
  const toggle = h("button", { type: "button", class: "link-btn token-toggle", id: "connect-use-token", "aria-expanded": "false", "aria-controls": "connect-token-panel" }, "Use a token instead");
  const toggleRow = h("p", { class: "token-toggle-row" }, toggle);

  // ---- busy
  const busyView = h("p", { class: "signin-busy", id: "connect-signin-busy" }, "Finishing sign-in...");

  // ---- pick and empty
  const whoView = h("p", { class: "signin-who", id: "connect-signin-who" });
  const pickView = h("div", { class: "signin-pick" });
  const emptyView = h("div", { class: "signin-empty" });
  const pickBranch = textField("connect-pick-branch", "Branch (optional)", { hint: "Empty: the repository's default branch." });
  pickBranch.input.addEventListener("input", () => pickBranch.setError(null));

  section.append(startView, busyView, whoView, pickView, emptyView, signInResult);
  body.insertBefore(section, tokenPanel);
  body.insertBefore(toggleRow, tokenPanel);

  const setTokenOpen = (open: boolean) => {
    tokenPanel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    // One filled action at a time: with the token form open, Sign in steps back to the outline style.
    signInButton.classList.toggle("primary", !open);
    render();
  };
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    setTokenOpen(open);
    if (open) tokenPanel.querySelector<HTMLInputElement>("input")?.focus();
  });

  function render() {
    dialog.dataset.view = view;
    startView.hidden = view !== "start";
    busyView.hidden = view !== "busy";
    whoView.hidden = view !== "pick" && view !== "empty";
    pickView.hidden = view !== "pick";
    emptyView.hidden = view !== "empty";
    toggleRow.hidden = view !== "start";
    if (view !== "start") tokenPanel.hidden = true;
    // Connect is the footer's action for the token form and for the repository list.
    submit.hidden = !(view === "pick" || (view === "start" && !tokenPanel.hidden));
    if (view === "pick") submitLabel.textContent = busy ? "Connecting..." : dialog.dataset.state === "public" ? "Connect anyway" : "Connect";
  }

  const radios = () => [...pickView.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const chosen = (): PickRepo | null => {
    const id = Number(radios().find((r) => r.checked)?.value ?? NaN);
    return reach?.repos.find((r) => r.id === id) ?? null;
  };

  function showReach(next: ReachView) {
    reach = next;
    whoView.textContent = `Signed in as @${next.login}.`;
    if (next.repos.length === 0) {
      view = "empty";
      dialog.dataset.state = "pick-empty";
      const install = h("a", { href: next.installUrl, target: "_blank", rel: "noopener noreferrer", class: "btn primary", id: "connect-install" }, "Choose a repository on GitHub", syncIcon("arrow-square-out", "ext-icon"));
      const recheck = h("button", { type: "button", class: "btn", id: "connect-recheck" }, "Check again");
      recheck.addEventListener("click", () => void again());
      emptyView.replaceChildren(
        h("p", { class: "signin-empty-title" }, "ExecFlow can't reach any repository yet."),
        h(
          "ol",
          { class: "signin-steps" },
          h("li", null, "Choose a repository on GitHub (it opens in a new tab)."),
          h("li", null, "Pick your account, choose Only select repositories, pick one repository (private; it can be empty), then Install."),
          h("li", null, "Come back to this tab: the repository shows up here."),
        ),
        newRepoNote("connect-signin-new-repo"),
        h("div", { class: "signin-actions" }, install, recheck),
      );
      render();
      return;
    }
    view = "pick";
    dialog.dataset.state = "pick";
    const current = deps.current;
    const preset =
      next.repos.find((r) => current && r.owner.toLowerCase() === current.owner.toLowerCase() && r.name.toLowerCase() === current.repo.toLowerCase()) ??
      (next.repos.length === 1 ? next.repos[0] : null);
    const rows = next.repos.map((r, i) => {
      const input = h("input", { type: "radio", name: "connect-pick", id: `connect-pick-${i}`, value: String(r.id), "aria-describedby": `connect-pick-${i}-note` });
      input.checked = r === preset;
      input.addEventListener("change", () => {
        publicConfirmed = null;
        if (dialog.dataset.state === "public") dialog.dataset.state = "pick";
        say("");
        render();
      });
      return h(
        "div",
        { class: "choice", "data-repo": `${r.owner}/${r.name}` },
        input,
        h("label", { for: input.id, class: "repo-name" }, `${r.owner}/${r.name}`),
        h("p", { class: "field-note", id: `${input.id}-note` }, r.private ? "Private" : "Public: anyone can read the code in it"),
      );
    });
    const parts: HTMLElement[] = [
      h("h3", { class: "steps-title", id: "connect-pick-title" }, "Choose the repository for this workspace"),
      h("fieldset", { class: "choice-list", id: "connect-pick-list" }, h("legend", { class: "visually-hidden" }, "Repository for this workspace"), ...rows),
    ];
    if (next.repos.length > 1) {
      const where = next.settingsUrl ?? next.installUrl;
      parts.push(
        h(
          "p",
          { class: "field-note pick-many", id: "connect-pick-many", "data-tone": "warning" },
          `ExecFlow can reach ${next.repos.length} repositories for you. One is safer: let it reach only the repository you sync (`,
          h("a", { href: where, target: "_blank", rel: "noopener noreferrer", class: "ext-link" }, "change it on GitHub", syncIcon("arrow-square-out", "ext-icon")),
          ").",
        ),
      );
    }
    parts.push(pickBranch.row);
    pickView.replaceChildren(...parts);
    render();
  }

  async function again() {
    if (busy || host.isClosed()) return;
    busy = true;
    dialog.dataset.rechecks = String(Number(dialog.dataset.rechecks ?? 0) + 1);
    const result = await deps.reach();
    busy = false;
    if (host.isClosed()) return;
    if (!result.ok) return say(result.message, "error");
    const before = reach?.repos.length ?? 0;
    showReach(result.reach);
    if (view === "pick") {
      say(result.reach.repos.length === 1 ? `ExecFlow can reach ${result.reach.repos[0].owner}/${result.reach.repos[0].name} now.` : `ExecFlow can reach ${result.reach.repos.length} repositories now.`);
      (radios().find((r) => r.checked) ?? radios()[0])?.focus();
    } else if (before === 0) say("Still no repository: install ExecFlow on one on GitHub, then come back.", "warning");
  }
  // Back from GitHub's install page in the other tab: look again by itself.
  const onFocus = () => {
    if (view === "empty") void again();
  };
  addEventListener("focus", onFocus);

  async function connect() {
    say("");
    pickBranch.setError(null);
    const repo = chosen();
    if (!repo) {
      say("Choose the repository to sync with first.", "error");
      radios()[0]?.focus();
      return;
    }
    const branchText = pickBranch.input.value.trim();
    const branchError = branchProblem(branchText);
    if (branchError) {
      pickBranch.setError(branchError);
      pickBranch.input.focus();
      dialog.dataset.announce = "focus";
      return;
    }
    busy = true;
    render();
    const checked = await deps.check(repo, branchText);
    if (host.isClosed()) return;
    if (!checked.ok) {
      busy = false;
      dialog.dataset.state = "signin-failed";
      render();
      if (checked.field === "branch") {
        pickBranch.setError(checked.message);
        pickBranch.input.focus();
        dialog.dataset.announce = "focus";
      } else say(checked.message, "error");
      return;
    }
    if (!checked.private && publicConfirmed !== repo.id) {
      busy = false;
      publicConfirmed = repo.id;
      dialog.dataset.state = "public";
      render();
      say("This repository is public: anyone can read the code in it. Make it private on GitHub (the repository's Settings, General, Danger Zone, Change visibility), or choose Connect anyway.", "warning");
      return;
    }
    submitLabel.textContent = "Connecting...";
    const problem = await deps.save(repo, checked.branch);
    busy = false;
    if (host.isClosed()) return;
    if (problem) {
      dialog.dataset.state = "signin-failed";
      render();
      say(problem, "error");
      return;
    }
    host.onConnected();
  }

  signInButton.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    dialog.dataset.state = "redirecting";
    signInLabel.textContent = "Going to GitHub...";
    say("");
    void deps.start(remember.checked).then((failure) => {
      // Still here: the page didn't leave for GitHub.
      busy = false;
      signInLabel.textContent = "Sign in with GitHub";
      if (host.isClosed()) return;
      dialog.dataset.state = "signin-failed";
      say(failure.message, "error");
      if (failure.openToken) setTokenOpen(true);
    });
  });

  setTokenOpen(deps.openToken);
  if (deps.message) {
    dialog.dataset.state = "signin-failed";
    say(deps.message, "error");
  } else if (deps.offline && !deps.resume) say("This device is offline: sign in once you're online. Your files are saved here in the meantime.", "warning");

  return {
    picking: () => view === "pick",
    busy: () => busy,
    connect,
    initialFocus: (tokenFirst: HTMLElement) => (deps.resume ? null : deps.openToken ? tokenFirst : signInButton),
    opened() {
      if (!deps.resume) return;
      const resume = deps.resume;
      view = "busy";
      busy = true;
      dialog.dataset.state = "signing-in";
      render();
      announcer.say("Finishing sign-in...");
      void resume().then((result) => {
        busy = false;
        if (host.isClosed()) return;
        if (result.ok) {
          showReach(result.reach);
          if (view === "pick") (radios().find((r) => r.checked) ?? radios()[0])?.focus();
          else dialog.querySelector<HTMLElement>("#connect-install")?.focus();
          announcer.say(`Signed in as @${result.reach.login}.`);
          return;
        }
        view = "start";
        dialog.dataset.state = "signin-failed";
        render();
        signInButton.focus();
        say(result.message, "error");
        if (result.openToken) setTokenOpen(true);
      });
    },
    closed(connected: boolean) {
      removeEventListener("focus", onFocus);
      if (!connected && reach) deps.abandon();
    },
  };
}
