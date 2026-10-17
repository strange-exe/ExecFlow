// The colour theme list inside Settings (adapted from Pocket Run's src/theme-picker.ts, same author,
// MIT). Native radio buttons: one Tab stop, arrow keys move through the themes and apply each at
// once. "More themes" starts folded unless one of them is chosen.
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import type { ColorVar } from "./contrast";
import {
  activeScheme, allThemes, BUILT_IN, chooseTheme, chosenTheme, DEFAULT_THEME_ID, defaultTheme, deleteCustomTheme,
  MAX_THEME_BYTES, parseThemeFile, saveCustomTheme, themePalette, themeTemplate, type Theme,
} from "./themes";

const SWATCH: ColorVar[] = ["bg", "text", "accent", "syn-keyword", "syn-string"];

export interface ThemePicker {
  element: HTMLElement;
  /** Re-reads the saved themes and the current choice (call before showing it). */
  render(): void;
}

export function createThemePicker(options: { download(name: string, text: string): void }): ThemePicker {
  const list = h("div", { class: "theme-list", role: "radiogroup", "aria-labelledby": "theme-title" });
  const message = h("p", { class: "field-note", role: "status", "data-tone": "info" });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const say = (text: string, tone: "info" | "error" = "info") => {
    message.textContent = text;
    message.dataset.tone = tone;
  };

  function option(theme: Theme, current: string): HTMLElement {
    const radio = h("input", { type: "radio", name: "theme", value: theme.id });
    radio.checked = theme.id === current;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      chooseTheme(theme);
      say("");
    });
    const colors = themePalette(theme, activeScheme(theme)).palette;
    const swatches = h("span", { class: "swatches", "aria-hidden": "true" });
    for (const v of SWATCH) {
      const s = h("span");
      s.style.background = colors[v]; // validated #rrggbb only (themes.ts)
      swatches.append(s);
    }
    const name = h("span", { class: "theme-name" }, theme.name);
    if (theme.id === DEFAULT_THEME_ID) name.append(" ", h("span", { class: "tag" }, "Default"));
    const row = h("label", { class: "theme-option", "data-theme-option": theme.id }, radio, swatches, name);
    if (theme.custom) {
      const remove = h("button", { type: "button", class: "btn ghost small", "aria-label": `Delete ${theme.name}` }, icon("trash"), "Delete");
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        deleteCustomTheme(theme.id);
        if (chosenTheme().id === theme.id || current === theme.id) chooseTheme(defaultTheme());
        render();
        say(`Deleted "${theme.name}".`);
      });
      row.append(remove);
    }
    return row;
  }

  function render(): void {
    const current = chosenTheme().id;
    const heading = (text: string) => h("p", { class: "theme-group" }, text);
    const of = (group: Theme["group"]) => BUILT_IN.filter((t) => t.group === group);
    const more = of("more");
    const folded = h("details", { class: "theme-more" });
    folded.open = more.some((t) => t.id === current);
    const summary = h("summary", null, `More themes (${more.length})`);
    folded.append(summary, ...more.map((t) => option(t, current)));
    const yours = allThemes().filter((t) => t.custom);
    list.replaceChildren(
      heading("CodeEditor"),
      ...of("codeeditor").map((t) => option(t, current)),
      heading("Popular editor themes"),
      ...of("popular").map((t) => option(t, current)),
      folded,
      ...(yours.length ? [heading("Yours"), ...yours.map((t) => option(t, current))] : []),
    );
  }

  const load = h("button", { type: "button", class: "btn" }, icon("upload-simple"), "Load theme file");
  load.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const chosen = fileInput.files?.[0];
    fileInput.value = "";
    if (!chosen) return;
    if (chosen.size > MAX_THEME_BYTES) return say(`A theme file is at most ${MAX_THEME_BYTES / 1024} KB; this one is bigger.`, "error");
    const parsed = parseThemeFile(new Uint8Array(await chosen.arrayBuffer()));
    if (!parsed.ok) return say(parsed.error, "error");
    const saved = saveCustomTheme(parsed.theme);
    if (!saved.ok) return say(saved.error, "error");
    chooseTheme(parsed.theme);
    render();
    const n = parsed.adjusted.length;
    say(`Loaded "${parsed.theme.name}".${n ? ` ${n} colour${n === 1 ? " was" : "s were"} made easier to read (${parsed.adjusted.join(", ")}).` : ""}`);
  });

  const template = h("button", { type: "button", class: "btn" }, icon("download-simple"), "Get template");
  template.addEventListener("click", () => {
    const theme = chosenTheme();
    const scheme = activeScheme(theme);
    options.download("codeeditor-theme.json", themeTemplate(`My ${theme.name}`.slice(0, 40), scheme, themePalette(theme, scheme).palette));
    say("Saved codeeditor-theme.json. Change the colours, rename it, then load it here.");
  });

  const element = h(
    "div",
    { class: "theme-picker" },
    list,
    h("div", { class: "row-actions" }, load, template, fileInput),
    message,
  );
  return { element, render };
}
