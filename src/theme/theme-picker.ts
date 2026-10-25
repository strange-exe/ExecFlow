// The colour theme list inside Settings (adapted from Pocket Run's src/theme-picker.ts, same author,
// MIT). Native radio buttons: one Tab stop, arrow keys move through the themes and apply each at
// once. Each theme is a tile round its radio: the name, and a preview drawn in that theme's own
// colours (two lines of calc.py, the second on its error band, and a small Run), hidden from
// assistive technology, so the radio's name stays the theme's name. Signal and High contrast lead;
// "More themes" (Deep Field, Slate, the popular editor themes and the others) starts folded unless one of
// them is chosen, so Settings' editor options stay on its first screen (review D, 2026-10-18: with
// every group open they were about 1,300 px down). The list is not a scroll box of its own: the
// dialog scrolls once.
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { isTokenValue, type ColorVar, type Palette } from "./contrast";
import {
  activeScheme, allThemes, BUILT_IN, chooseTheme, chosenTheme, DEFAULT_THEME_ID, defaultTheme, deleteCustomTheme,
  MAX_THEME_BYTES, parseThemeFile, saveCustomTheme, themePalette, themeTemplate, type Theme,
} from "./themes";

/** The preview's colours: custom properties on the tile (app.css paints only var(--tile-*)). */
const TILE_VARS: Record<string, ColorVar> = {
  "--tile-bg": "bg",
  "--tile-border": "border",
  "--tile-text": "text",
  "--tile-gutter": "gutter-text",
  "--tile-keyword": "syn-keyword",
  "--tile-function": "syn-function",
  "--tile-punctuation": "syn-punctuation",
  "--tile-band": "error-band",
  "--tile-danger": "danger",
  "--tile-action": "action",
  "--tile-on-action": "on-action",
};

/** Two lines of calc.py in the theme's colours, the second on its error band (aria-hidden). */
function preview(colors: Palette): HTMLElement {
  const el = h(
    "span",
    { class: "tile-prev", "aria-hidden": "true" },
    h("span", { class: "tp-ln" }, h("span", { class: "tp-num" }, "1"), h("span", { class: "tp-kw" }, "def"), " ", h("span", { class: "tp-fn" }, "ratio"), h("span", { class: "tp-pu" }, "("), "a, b", h("span", { class: "tp-pu" }, "):")),
    h("span", { class: "tp-ln is-band" }, h("span", { class: "tp-num" }, "2"), "    ", h("span", { class: "tp-kw" }, "return"), " a / b"),
    h("span", { class: "tp-run" }, icon("play-fill"), "Run"),
  );
  for (const [prop, name] of Object.entries(TILE_VARS)) {
    if (isTokenValue(name, colors[name])) el.style.setProperty(prop, colors[name]); // a validated colour only
  }
  return el;
}

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
    const name = h("span", { class: "theme-name" }, theme.name);
    if (theme.id === DEFAULT_THEME_ID) name.append(" ", h("span", { class: "tag" }, "Default"));
    const tile = h("label", { class: "theme-option", "data-theme-option": theme.id }, radio, name);
    if (theme.custom) {
      const remove = h("button", { type: "button", class: "btn ghost small", "aria-label": `Delete ${theme.name}` }, icon("trash"), "Delete");
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        deleteCustomTheme(theme.id);
        if (chosenTheme().id === theme.id || current === theme.id) chooseTheme(defaultTheme());
        render();
        say(`Deleted "${theme.name}".`);
      });
      tile.append(remove);
    }
    tile.append(preview(themePalette(theme, activeScheme(theme)).palette));
    return tile;
  }

  function render(): void {
    const current = chosenTheme().id;
    const heading = (text: string) => h("p", { class: "theme-group" }, text);
    const tiles = (themes: Theme[]) => h("div", { class: "theme-grid" }, ...themes.map((t) => option(t, current)));
    const of = (group: Theme["group"]) => BUILT_IN.filter((t) => t.group === group);
    // Up front: Signal (the default, in its three forms) and High contrast. Folded: Deep Field (the
    // default before Signal), Slate (v1's palette), the popular editor themes and the others; the
    // fold opens when the chosen theme is in it.
    const own = of("codeeditor");
    const deepField = own.filter((t) => t.own === "deep-field");
    const slate = own.filter((t) => t.own === "slate");
    const popular = of("popular");
    const others = of("more");
    const folded = h("details", { class: "theme-more" });
    folded.open = [...deepField, ...slate, ...popular, ...others].some((t) => t.id === current);
    const summary = h("summary", null, `More themes (${deepField.length + slate.length + popular.length + others.length})`);
    folded.append(
      summary,
      heading("CodeEditor Deep Field"), tiles(deepField),
      heading("CodeEditor Slate"), tiles(slate),
      heading("Popular editor themes"), tiles(popular),
      heading("Other editor themes"), tiles(others),
    );
    const yours = allThemes().filter((t) => t.custom);
    // The section's heading ("Colour theme") names the group, so the first tiles need no title of their own.
    list.replaceChildren(tiles(own.filter((t) => t.own !== "slate" && t.own !== "deep-field")), folded, ...(yours.length ? [heading("Yours"), tiles(yours)] : []));
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
