// Settings (native <dialog>; Escape closes and focus returns to the gear button). Changes apply at
// once and are kept on this device. Storage shows whether the browser may clear the workspace and
// offers "Protect local data" (persistent storage, asked from the click).
//
// 0.7.0: two panes from 700 px: the sections on the left (a list of in-page links as buttons, the
// one in view marked with aria-current), the settings on the right in one scroller; below that one
// column, the sections a row of buttons above it. Every setting is a row: its label and its note
// on the left, its control on the right (a stepper, a switch or a select), so a note always sits
// under its own field. The foot holds the version (#settings-version, filled by the versions unit)
// and the legal line.
import { createThemePicker } from "../theme/theme-picker";
import { ligaturesOn, setLigatures } from "../theme/ligatures";
import type { WorkspaceDb } from "../storage/db";
import { requestPersistence, storageStatus } from "../storage/persist";
import { downloadText, formatBytes, h } from "./dom";
import { dialogShell, openModal } from "./dialogs";
import { icon } from "./icons";
import { C_STANDARDS, CXX_STANDARDS, LIMITS, type Settings, type SettingsStore } from "./settings";
import type { SyncHooks } from "./sync-entry";

export interface SettingsDeps {
  settings: SettingsStore;
  db: WorkspaceDb;
  sync(): SyncHooks;
  exportWorkspace(): Promise<void>;
  signOut(): Promise<void>;
}

let seq = 0;

/** A link to a legal page, in a new tab. */
function legalLink(href: string, label: string): HTMLElement {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);
}

/** A setting's row: the label and its note on the left, the control on the right. */
function row(label: string, control: HTMLElement, note?: string, labelFor?: HTMLElement): HTMLElement {
  const target = labelFor ?? control;
  const id = target.id || `set-${++seq}`;
  target.id = id;
  const noteId = note ? `${id}-note` : null;
  if (noteId) target.setAttribute("aria-describedby", noteId);
  return h(
    "div",
    { class: "setting" },
    h("div", { class: "setting-text" }, h("label", { class: "setting-label", for: id }, label), note ? h("p", { class: "field-note", id: noteId }, note) : null),
    h("div", { class: "setting-control" }, control),
  );
}

/** An on/off setting: a checkbox drawn and announced as a switch (role=switch; Space toggles it). */
function toggle(label: string, checked: boolean, note: string | undefined, id: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id });
  input.checked = checked;
  return { row: row(label, input, note), input };
}

function select<T extends string>(id: string, options: readonly (readonly [T, string])[], value: T): HTMLSelectElement {
  const el = h("select", { id }, ...options.map(([v, label]) => h("option", { value: v }, label)));
  el.value = value;
  return el;
}

/** A number field (typable, clamped by the store on change). */
function numberField(id: string, [min, max]: readonly [number, number], step: number): HTMLInputElement {
  return h("input", { type: "number", id, min, max, step: String(step), inputmode: "numeric" });
}

/**
 * "Enter accepts the top suggestion" (extensions.ts EditorPrefs.enterAcceptsTop and ENTER_KEY):
 * Enter makes a new line only where the top option is the typed word itself (not a snippet such as
 * def or main, not True after "true", not nan after "int n"), and off, nothing is picked until an
 * arrow key. Students read the line as a promise, so it says no more than that (review, 2026-10-28).
 */
const ENTER_TOP_NOTE = "If the top suggestion is just the word you typed, Enter makes a new line. Off, Down or Up picks one first.";

const SECTIONS = [
  ["appearance", "Appearance"],
  ["editor", "Editor"],
  ["running", "Running programs"],
  ["storage", "Storage"],
  ["github", "GitHub"],
  ["danger", "Danger zone"],
] as const;
type SectionKey = (typeof SECTIONS)[number][0];

export function createSettingsDialog(deps: SettingsDeps): { open(opener?: HTMLElement): void } {
  const { dialog, body } = dialogShell("settings", "Settings", { wide: true });
  dialog.classList.add("settings-dialog");
  const s = () => deps.settings.get();
  const set = (patch: Partial<Settings>) => deps.settings.update(patch);

  // ---------------------------------------------------------------- appearance
  const picker = createThemePicker({ download: (name, text) => downloadText(name, text, "application/json") });

  // ---------------------------------------------------------------- editor
  // The code font size: a stepper (- value +), still typable; the store clamps it to LIMITS.
  const codeSize = numberField("set-code-size", LIMITS.codeSize, 1);
  const smaller = h("button", { type: "button", class: "icon-btn step-btn", id: "set-code-size-down", "aria-label": "Smaller code font", title: "Smaller" }, icon("minus"));
  const larger = h("button", { type: "button", class: "icon-btn step-btn", id: "set-code-size-up", "aria-label": "Larger code font", title: "Larger" }, icon("plus"));
  const stepper = h("div", { class: "stepper" }, smaller, codeSize, larger);
  const showSize = (size: number) => {
    codeSize.value = String(size);
    smaller.disabled = size <= LIMITS.codeSize[0];
    larger.disabled = size >= LIMITS.codeSize[1];
  };
  // An emptied (or unreadable) field keeps the current value: Number("") is 0, which the store
  // would clamp to the minimum.
  codeSize.addEventListener("change", () => {
    const v = codeSize.valueAsNumber;
    showSize(Number.isFinite(v) ? set({ codeSize: v }).codeSize : s().codeSize);
  });
  for (const [button, by] of [[smaller, -1], [larger, 1]] as const) {
    button.addEventListener("click", () => {
      showSize(set({ codeSize: s().codeSize + by }).codeSize);
      // At a limit the button disables itself: focus moves to the field rather than to the page.
      if (button.disabled) codeSize.focus();
    });
  }
  const wrap = toggle("Wrap long lines", s().lineWrapping, undefined, "set-wrap");
  const suggest = toggle("Suggestions while typing", s().suggestOnTyping, "Ctrl+Space always shows them.", "set-suggest");
  const enterTop = toggle("Enter accepts the top suggestion", s().enterAcceptsTop, ENTER_TOP_NOTE, "set-enter-top");
  const ligatures = toggle("Joined symbols in code", ligaturesOn(), "Draws != == -> and similar pairs as single shapes. Off shows exactly what you type.", "set-ligatures");
  wrap.input.addEventListener("change", () => set({ lineWrapping: wrap.input.checked }));
  suggest.input.addEventListener("change", () => set({ suggestOnTyping: suggest.input.checked }));
  enterTop.input.addEventListener("change", () => set({ enterAcceptsTop: enterTop.input.checked }));
  ligatures.input.addEventListener("change", () => setLigatures(ligatures.input.checked));

  // ---------------------------------------------------------------- running programs
  const timeLimit = numberField("set-time", LIMITS.timeLimitS, 1);
  const outputLimit = numberField("set-output", LIMITS.outputLimitK, 16);
  // As for the code size: an emptied field shows the kept value again and saves nothing.
  timeLimit.addEventListener("change", () => {
    const v = timeLimit.valueAsNumber;
    timeLimit.value = String(Number.isFinite(v) ? set({ timeLimitS: v }).timeLimitS : s().timeLimitS);
  });
  outputLimit.addEventListener("change", () => {
    const v = outputLimit.valueAsNumber;
    outputLimit.value = String(Number.isFinite(v) ? set({ outputLimitK: v }).outputLimitK : s().outputLimitK);
  });
  const cStd = select("set-c-std", C_STANDARDS.map((v) => [v, v === "gnu11" ? "gnu11 (default)" : v] as const), s().cStd);
  const cxxStd = select("set-cxx-std", CXX_STANDARDS.map((v) => [v, v === "c++17" ? "c++17 (default)" : v === "c++2a" ? "c++2a (C++20, partly)" : v] as const), s().cxxStd);
  // -O0 lets a NULL write or a stray index pass silently where -O2 stops the program (audit t7c, B13).
  const opt = select("set-opt", [["0", "-O0 (none, quickest to build; makes memory bugs harder to see)"], ["1", "-O1"], ["2", "-O2 (default)"]] as const, s().opt);
  const wall = toggle("-Wall (common warnings)", s().wall, undefined, "set-wall");
  const wextra = toggle("-Wextra (more warnings)", s().wextra, undefined, "set-wextra");
  cStd.addEventListener("change", () => set({ cStd: cStd.value as Settings["cStd"] }));
  cxxStd.addEventListener("change", () => set({ cxxStd: cxxStd.value as Settings["cxxStd"] }));
  opt.addEventListener("change", () => set({ opt: opt.value as Settings["opt"] }));
  wall.input.addEventListener("change", () => set({ wall: wall.input.checked }));
  wextra.input.addEventListener("change", () => set({ wextra: wextra.input.checked }));

  // ---------------------------------------------------------------- storage
  const storageLine = h("p", { class: "field-note", id: "storage-status", "data-persisted": "unknown" }, "Checking...");
  const protect = h("button", { type: "button", class: "btn", id: "protect-data" }, icon("shield-check"), "Protect local data");
  const exportButton = h("button", { type: "button", class: "btn", id: "export-workspace" }, icon("download-simple"), "Export workspace (.zip)");
  async function refreshStorage() {
    const st = await storageStatus();
    storageLine.dataset.persisted = String(st.persisted);
    const usage = st.usage !== null ? `${formatBytes(st.usage)} used` : "Usage unknown";
    const quota = st.quota !== null ? ` of about ${formatBytes(st.quota)} this browser allows` : "";
    storageLine.textContent = !st.supported
      ? "This browser doesn't report storage. Export or GitHub sync are the backups."
      : `${usage}${quota}. ${st.persisted ? "Protected: the browser won't clear it to free space." : "Not protected: the browser may clear it when the disk is full, or (Safari) after 7 days without a visit."}`;
    protect.hidden = !st.supported || st.persisted;
  }
  protect.addEventListener("click", async () => {
    const result = await requestPersistence({ db: deps.db });
    await refreshStorage();
    if (!result.granted) storageLine.append(" The browser said no this time; it decides from how often you use the site. Export or GitHub sync keep a copy.");
  });
  exportButton.addEventListener("click", () => void deps.exportWorkspace());

  // ---------------------------------------------------------------- GitHub
  const githubLine = h("p", { class: "field-note", id: "github-status" });
  const connect = h("button", { type: "button", class: "btn", id: "settings-connect" }, icon("github-logo"), "Connect GitHub");
  const disconnect = h("button", { type: "button", class: "btn", id: "settings-disconnect" }, icon("cloud-slash"), "Disconnect GitHub");
  const withMessage = h("button", { type: "button", class: "btn", id: "settings-sync-message" }, icon("cloud-arrow-up"), "Sync with a message...");
  const autoSync = toggle("Sync automatically", s().autoSync, "A minute after your last change, while CodeEditor is open in front. Ctrl+S and the sync status sync at once.", "set-autosync");
  autoSync.input.addEventListener("change", () => set({ autoSync: autoSync.input.checked }));
  connect.addEventListener("click", () => {
    dialog.close();
    deps.sync().connect();
  });
  disconnect.addEventListener("click", () => {
    dialog.close();
    deps.sync().disconnect();
  });
  // Settings closes first, so focus is back on what opened it, which the message dialog returns to.
  withMessage.addEventListener("click", () => {
    dialog.close();
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    deps.sync().syncWithMessage(opener);
  });

  // ---------------------------------------------------------------- danger zone
  const clear = h("button", { type: "button", class: "btn danger", id: "sign-out-clear" }, icon("trash"), "Sign out and clear this computer");
  clear.addEventListener("click", () => void deps.signOut());

  // ---------------------------------------------------------------- the sections
  // Two heading levels only: the dialog's title, then each section's. Each heading takes focus when
  // its section is chosen from the list (tabindex -1: reached by the list, not by Tab).
  const headings = new Map<SectionKey, HTMLElement>();
  const sections = new Map<SectionKey, HTMLElement>();
  const section = (key: SectionKey, title: string, ...children: (HTMLElement | null)[]) => {
    const heading = h("h3", { class: "section-title", id: `settings-h-${key}`, tabindex: "-1" }, title);
    const el = h("section", { class: "settings-section", id: `settings-${key}`, "aria-labelledby": heading.id }, heading, ...children);
    headings.set(key, heading);
    sections.set(key, el);
    return el;
  };
  // Reading order (audit, Settings): the chosen theme, then the editor options, then run limits.
  // "Colour theme" names the theme radio group (theme-picker.ts: aria-labelledby="theme-title").
  body.append(
    section("appearance", "Appearance", h("p", { class: "field-label", id: "theme-title" }, "Colour theme"), picker.element),
    section("editor", "Editor", row("Code font size (px)", stepper, undefined, codeSize), wrap.row, suggest.row, enterTop.row, ligatures.row),
    section(
      "running",
      "Running programs",
      row("Time limit (seconds)", timeLimit, "Time waiting for typed input doesn't count."),
      row("Output limit (thousands)", outputLimit, "Thousands of characters a run may print."),
      row("C standard", cStd),
      row("C++ standard", cxxStd),
      row("Optimisation", opt),
      wall.row,
      wextra.row,
    ),
    section("storage", "Storage", storageLine, h("div", { class: "row-actions" }, protect, exportButton)),
    section("github", "GitHub", githubLine, h("div", { class: "row-actions" }, connect, withMessage, disconnect), autoSync.row),
    section(
      "danger",
      "Danger zone",
      h("div", { class: "danger-box" },
        h("p", { class: "danger-text" }, h("strong", null, "Clear this computer. "), "For shared computers: removes every file, setting and saved GitHub token CodeEditor keeps in this browser. Files already synced to GitHub stay there."),
        h("div", { class: "row-actions" }, clear),
      ),
    ),
  );

  // ---------------------------------------------------------------- the sections list
  const navButtons = new Map<SectionKey, HTMLButtonElement>();
  const nav = h(
    "nav",
    { class: "settings-nav", "aria-label": "Settings sections" },
    ...SECTIONS.map(([key, label]) => {
      const button = h("button", { type: "button", class: "settings-nav-btn", "data-section": key, "aria-controls": `settings-${key}` }, label);
      navButtons.set(key, button);
      return button;
    }),
  );
  let current: SectionKey = "appearance";
  function mark(key: SectionKey) {
    current = key;
    for (const [k, b] of navButtons) {
      if (k === key) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    // Phones: the row of sections scrolls sideways; the marked one stays in it.
    const button = navButtons.get(key);
    if (button && nav.scrollWidth > nav.clientWidth) {
      const r = button.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - 8;
    }
  }
  /** Where a jump from the list is going: its scroll event keeps the chosen mark. */
  let jumpTo: number | null = null;
  function go(key: SectionKey) {
    const el = sections.get(key)!;
    const max = body.scrollHeight - body.clientHeight;
    // The body is the sections' offset parent (position: relative, app.css).
    const top = Math.max(0, Math.min(max, el.offsetTop - parseFloat(getComputedStyle(body).paddingTop)));
    mark(key);
    if (Math.abs(body.scrollTop - top) >= 1) {
      jumpTo = top;
      body.scrollTo({ top });
    }
    headings.get(key)!.focus({ preventScroll: true });
  }
  /** The section in view: the last whose top has reached the pane's top; the last one at the end. */
  function spy() {
    if (jumpTo !== null) {
      const arrived = Math.abs(body.scrollTop - jumpTo) < 2;
      jumpTo = null;
      if (arrived) return;
    }
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
    let seen: SectionKey = "appearance";
    for (const [key] of SECTIONS) {
      if (sections.get(key)!.offsetTop <= body.scrollTop + 24) seen = key;
    }
    mark(atEnd && body.scrollTop > 0 ? "danger" : seen);
  }
  body.addEventListener("scroll", spy, { passive: true });
  for (const [key, button] of navButtons) button.addEventListener("click", () => go(key));
  // Arrows move along the list (wrapping), Home and End go to its ends; Enter or Space goes there.
  nav.addEventListener("keydown", (e) => {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const list = [...navButtons.values()];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const n = list.length;
    const i = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + n) % n;
    list[i].focus();
  });
  mark(current);

  // ---------------------------------------------------------------- the foot
  // The legal pages open in a new tab, so nothing typed here is left behind. Then the version (the
  // build injects it) and the About page's list of changes.
  const version = h("p", { class: "field-note settings-version", id: "settings-version" }, `CodeEditor ${__APP_VERSION__}. `, legalLink("/about#changelog", "What's new"));
  const foot = h(
    "div",
    { class: "settings-foot" },
    h("p", { class: "field-note settings-legal" }, "What CodeEditor keeps and sends: ", legalLink("/privacy", "Privacy"), ". The rules for using it: ", legalLink("/terms", "Terms"), ". Open-source parts: ", legalLink("/licenses.txt", "Licences"), "."),
    version,
  );
  body.before(nav);
  body.after(foot);

  return {
    open(opener) {
      const now = s();
      picker.render();
      showSize(now.codeSize);
      wrap.input.checked = now.lineWrapping;
      suggest.input.checked = now.suggestOnTyping;
      enterTop.input.checked = now.enterAcceptsTop;
      ligatures.input.checked = ligaturesOn();
      timeLimit.value = String(now.timeLimitS);
      outputLimit.value = String(now.outputLimitK);
      cStd.value = now.cStd;
      cxxStd.value = now.cxxStd;
      opt.value = now.opt;
      wall.input.checked = now.wall;
      wextra.input.checked = now.wextra;
      autoSync.input.checked = now.autoSync;
      const sync = deps.sync();
      githubLine.textContent = sync.describe();
      connect.hidden = sync.connected();
      disconnect.hidden = !sync.connected();
      withMessage.hidden = !sync.connected();
      void refreshStorage();
      body.scrollTop = 0;
      mark("appearance");
      openModal(dialog, dialog.querySelector<HTMLInputElement>("input[name=theme]:checked"), opener);
    },
  };
}
