// Settings (native <dialog>; Escape closes and focus returns to the gear button). Changes apply at
// once and are kept on this device. Storage shows whether the browser may clear the workspace and
// offers "Protect local data" (persistent storage, asked from the click).
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

function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  const id = control.id || `set-${++seq}`;
  control.id = id;
  const noteId = note ? `${id}-note` : null;
  if (noteId) control.setAttribute("aria-describedby", noteId);
  return h("div", { class: "field" }, h("label", { for: id }, label), control, note ? h("p", { class: "field-note", id: noteId }, note) : null);
}

function check(label: string, checked: boolean, note?: string, id?: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", id: id ?? `set-${++seq}` });
  input.checked = checked;
  const noteId = note ? `${input.id}-note` : null;
  if (noteId) input.setAttribute("aria-describedby", noteId);
  const row = h(
    "div",
    { class: "check" },
    input,
    h("label", { for: input.id }, label),
    note ? h("p", { class: "field-note", id: noteId }, note) : null,
  );
  return { row, input };
}

function select<T extends string>(id: string, options: readonly (readonly [T, string])[], value: T): HTMLSelectElement {
  const el = h("select", { id }, ...options.map(([v, label]) => h("option", { value: v }, label)));
  el.value = value;
  return el;
}

export function createSettingsDialog(deps: SettingsDeps): { open(opener?: HTMLElement): void } {
  const { dialog, body } = dialogShell("settings", "Settings", { wide: true });
  const s = () => deps.settings.get();
  const set = (patch: Partial<Settings>) => deps.settings.update(patch);

  // ---------------------------------------------------------------- appearance
  const picker = createThemePicker({ download: (name, text) => downloadText(name, text, "application/json") });
  const codeSize = h("input", { type: "number", id: "set-code-size", min: LIMITS.codeSize[0], max: LIMITS.codeSize[1], step: "1", inputmode: "numeric" });
  const wrap = check("Wrap long lines", s().lineWrapping, undefined, "set-wrap");
  const suggest = check("Suggestions while typing", s().suggestOnTyping, "Ctrl+Space always shows them.", "set-suggest");
  const ligatures = check("Joined symbols in code", ligaturesOn(), "Draws != == -> and similar pairs as single shapes. Off shows exactly what you type.", "set-ligatures");
  codeSize.addEventListener("change", () => (codeSize.value = String(set({ codeSize: Number(codeSize.value) }).codeSize)));
  wrap.input.addEventListener("change", () => set({ lineWrapping: wrap.input.checked }));
  suggest.input.addEventListener("change", () => set({ suggestOnTyping: suggest.input.checked }));
  ligatures.input.addEventListener("change", () => setLigatures(ligatures.input.checked));

  // ---------------------------------------------------------------- running programs
  const timeLimit = h("input", { type: "number", id: "set-time", min: LIMITS.timeLimitS[0], max: LIMITS.timeLimitS[1], step: "1", inputmode: "numeric" });
  const outputLimit = h("input", { type: "number", id: "set-output", min: LIMITS.outputLimitK[0], max: LIMITS.outputLimitK[1], step: "16", inputmode: "numeric" });
  timeLimit.addEventListener("change", () => (timeLimit.value = String(set({ timeLimitS: Number(timeLimit.value) }).timeLimitS)));
  outputLimit.addEventListener("change", () => (outputLimit.value = String(set({ outputLimitK: Number(outputLimit.value) }).outputLimitK)));
  const cStd = select("set-c-std", C_STANDARDS.map((v) => [v, v === "gnu11" ? "gnu11 (default)" : v] as const), s().cStd);
  const cxxStd = select("set-cxx-std", CXX_STANDARDS.map((v) => [v, v === "c++17" ? "c++17 (default)" : v === "c++2a" ? "c++2a (C++20, partly)" : v] as const), s().cxxStd);
  // -O0 lets a NULL write or a stray index pass silently where -O2 stops the program (audit t7c, B13).
  const opt = select("set-opt", [["0", "-O0 (none, quickest to build; makes memory bugs harder to see)"], ["1", "-O1"], ["2", "-O2 (default)"]] as const, s().opt);
  const wall = check("-Wall (common warnings)", s().wall, undefined, "set-wall");
  const wextra = check("-Wextra (more warnings)", s().wextra, undefined, "set-wextra");
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
  const autoSync = check("Sync automatically", s().autoSync, "A minute after your last change, while CodeEditor is open in front. Ctrl+S and the status in the top bar sync at once.", "set-autosync");
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

  // ---------------------------------------------------------------- clear this computer
  const clear = h("button", { type: "button", class: "btn danger", id: "sign-out-clear" }, icon("trash"), "Sign out and clear this computer");
  clear.addEventListener("click", () => void deps.signOut());

  const section = (title: string, ...children: (HTMLElement | null)[]) =>
    h("section", { class: "settings-section" }, h("h3", { class: "section-title" }, title), ...children);

  // Reading order (audit, Settings): the chosen theme, then the editor options, then run limits.
  // Two heading levels only: the dialog's title, then each section's, and "Colour theme" is both the
  // first section's heading and the theme radio group's name (no "Appearance" above it).
  const themeSection = section("Colour theme", picker.element);
  themeSection.querySelector("h3")!.id = "theme-title";
  body.append(
    themeSection,
    section("Editor", h("div", { class: "field-grid" }, field("Code font size (px)", codeSize)), wrap.row, suggest.row, ligatures.row),
    section(
      "Running programs",
      h("div", { class: "field-grid" }, field("Time limit (seconds)", timeLimit, "Time waiting for typed input doesn't count."), field("Output limit (thousands)", outputLimit, "Thousands of characters a run may print.")),
      h("div", { class: "field-grid" }, field("C standard", cStd), field("C++ standard", cxxStd), field("Optimisation", opt)),
      h("div", { class: "check-row" }, wall.row, wextra.row),
    ),
    section("Storage on this computer", storageLine, h("div", { class: "row-actions" }, protect, exportButton)),
    section("GitHub", githubLine, h("div", { class: "row-actions" }, connect, withMessage, disconnect), autoSync.row),
    section(
      "Clear this computer",
      h("p", { class: "field-note" }, "For shared computers: removes every file, setting and saved GitHub token CodeEditor keeps in this browser. Files already synced to GitHub stay there."),
      h("div", { class: "row-actions" }, clear),
    ),
  );

  return {
    open(opener) {
      const now = s();
      picker.render();
      codeSize.value = String(now.codeSize);
      wrap.input.checked = now.lineWrapping;
      suggest.input.checked = now.suggestOnTyping;
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
      openModal(dialog, dialog.querySelector<HTMLInputElement>("input[name=theme]:checked"), opener);
    },
  };
}
