// The Connect GitHub dialog, in reading order: first what connecting does and where the
// token is kept, then the repository and token fields, then Connect; below them the steps to make
// a fine-grained token and "Remember on this computer" (off by default, with the shared-computer
// warning). The network checks are the controller's (check/save); this file is the form.
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
      h("label", { for: "connect-remember" }, "Remember on this computer"),
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
    const result = h("p", { class: "connect-result", id: "connect-result" });
    const announcer = connectAnnouncer();

    const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
    const submitLabel = h("span", null, "Connect");
    const submit = h("button", { type: "submit", class: "btn primary", id: "connect-submit" }, syncIcon("github-logo"), submitLabel);
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)" }, syncIcon("x"));

    const form = h(
      "form",
      { class: "dialog-form", novalidate: true, autocomplete: "off" },
      h(
        "div",
        { class: "dialog-body" },
        h("p", { class: "connect-lede", id: "connect-lede" }, "Connecting keeps this workspace in a private GitHub repository. Each sync uploads your changes as one commit and brings in changes made on GitHub or on other computers."),
        h(
          "p",
          { class: "connect-where" },
          syncIcon("lock", "where-icon"),
          h("span", null, "CodeEditor sends the token only to api.github.com, from this browser. It stays in this tab's memory and is forgotten when you close the tab, unless you choose Remember below."),
        ),
        h(
          "fieldset",
          { class: "repo-fields" },
          h("legend", { class: "steps-title" }, "GitHub repository"),
          h("div", { class: "repo-row" }, owner.row, h("span", { class: "repo-slash", "aria-hidden": "true" }, "/"), repo.row),
          branch.row,
        ),
        token.row,
        result,
        steps,
        rememberRow,
      ),
      h("div", { class: "dialog-actions" }, cancel, submit),
    );
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

    dialog.addEventListener(
      "close",
      () => {
        closed = true;
        token.input.value = "";
        dialog.remove();
        resolve(connected);
      },
      { once: true },
    );
    openModal(dialog, deps.initial ? token.input : owner.input, deps.returnFocus);
  });
}
