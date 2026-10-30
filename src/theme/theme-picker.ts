// The colour theme picker (Workbench Pro S4, from the redesign4 picker study; first adapted from
// Pocket Run's src/theme-picker.ts, same author, MIT): Settings > Appearance itself (owner,
// 2026-10-30: "Inside Settings"), so the themes are on show as Settings opens. The editor options
// follow it; the sections list goes straight to them.
//
// The 45 built-in themes are 22 family tiles (families.ts): the family's name and schemes, a preview
// of six lines of C in the shown variant's own colours (every syntax colour, the failed line on its
// error band, a Run button; plain spans hidden from assistive technology, never an editor), then its
// variants as native radio buttons. All variants are one radio group (name=theme, the theme id as
// value, as stored): one Tab stop, arrow keys move through every theme and apply each at once.
// Above the tiles, held at the top of Settings while they scroll past: a search field, a Light/Dark/All filter (native radios
// too) and a count of the families shown. "Start here" (families.ts CURATED) leads; the other
// families follow A to Z; themes loaded from a file come last under "Yours".
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { isTokenValue, type ColorVar, type Palette } from "./contrast";
import {
  curatedFamilies, customFamily, familyMatches, otherFamilies, PREVIEW_COLORS, PREVIEW_LINES, schemesText, variantName, variantShown,
  type Family, type SchemeFilter,
} from "./families";
import {
  activeScheme, allThemes, chooseTheme, chosenTheme, DEFAULT_THEME_ID, defaultTheme, deleteCustomTheme, MAX_THEME_BYTES, parseThemeFile,
  saveCustomTheme, themePalette, themeTemplate, type Theme,
} from "./themes";

/** The preview's colours: custom properties on the preview (app.css paints only var(--tile-*)). */
const TILE_VARS: Record<string, ColorVar> = {
  "--tile-bg": "bg",
  "--tile-border": "border",
  "--tile-band": "error-band",
  "--tile-danger": "danger",
  "--tile-action": "action",
  "--tile-on-action": "on-action",
  ...Object.fromEntries(Object.entries(PREVIEW_COLORS).map(([role, v]) => [`--tile-${role}`, v])),
};

/** Six lines of C in a theme's colours, the fifth on its error band, and Run (aria-hidden). */
function preview(theme: Theme): HTMLElement {
  const scheme = activeScheme(theme);
  const colors: Palette = themePalette(theme, scheme).palette;
  const el = h(
    "span",
    { class: "tile-prev", "aria-hidden": "true", "data-variant": theme.id, "data-scheme": scheme },
    ...PREVIEW_LINES.map((line, i) =>
      h(
        "span",
        { class: line.failed ? "tp-ln is-band" : "tp-ln" },
        h("span", { class: "tp-num", "data-role": "gutter" }, String(i + 1)),
        ...line.parts.map(([role, text]) => (role === "text" ? text : h("span", { "data-role": role }, text))),
      ),
    ),
    h("span", { class: "tp-run" }, icon("play-fill"), "Run"),
  );
  for (const [prop, name] of Object.entries(TILE_VARS)) {
    if (isTokenValue(name, colors[name])) el.style.setProperty(prop, colors[name]); // a validated colour only
  }
  return el;
}

interface Tile {
  family: Family;
  el: HTMLElement;
  options: { theme: Theme; label: HTMLElement; radio: HTMLInputElement }[];
  hovered: string | null;
}

export interface ThemePicker {
  /** The picker: the tools, the tiles and the foot, placed in Settings > Appearance. */
  el: HTMLElement;
  /**
   * Re-reads the saved themes and the choice, clears the search, the filter and the message (each
   * time Settings opens), and returns what takes the focus: the chosen theme's radio.
   */
  reset(): HTMLElement;
  /** Brings the chosen theme's tile into view (after Settings has opened and is laid out). */
  reveal(): void;
}

export function createThemePicker(options: { download(name: string, text: string): void }): ThemePicker {
  const panel = h("div", { class: "theme-picker", id: "theme-picker" });
  const list = h("div", { class: "theme-list", role: "radiogroup", "aria-label": "Colour theme" });
  const message = h("p", { class: "field-note", role: "status", "data-tone": "info" });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const say = (text: string, tone: "info" | "error" = "info") => {
    message.textContent = text;
    message.dataset.tone = tone;
  };

  // ---------------------------------------------------------------- search, filter, count
  const search = h("input", {
    type: "search", id: "theme-search", class: "theme-search-field", placeholder: "Search themes", autocomplete: "off", spellcheck: "false",
  });
  const filters = (["all", "light", "dark"] as const).map((value) => {
    const input = h("input", { type: "radio", name: "theme-scheme", value });
    input.checked = value === "all";
    return { value, input, label: h("label", { class: "seg-option" }, input, h("span", null, value === "all" ? "All" : value === "light" ? "Light" : "Dark")) };
  });
  const count = h("p", { class: "field-note theme-count", id: "theme-count", role: "status" });
  const tools = h(
    "div",
    { class: "theme-tools" },
    h("div", { class: "theme-search" }, h("label", { class: "visually-hidden", for: "theme-search" }, "Search themes"), icon("magnifying-glass"), search),
    h("fieldset", { class: "seg theme-filter" }, h("legend", { class: "visually-hidden" }, "Show"), ...filters.map((f) => f.label)),
    count,
  );
  const clearSearch = h("button", { type: "button", class: "btn" }, "Clear search");
  const emptyText = h("p", null);
  const empty = h("div", { class: "theme-empty", hidden: true }, emptyText, clearSearch);

  let query = "";
  let filter: SchemeFilter = "all";
  let tiles: Tile[] = [];
  let sections: { el: HTMLElement; tiles: Tile[] }[] = [];
  let byId = new Map<string, Theme>();

  /** The variant a tile's preview shows: the hovered one, else the chosen one, else the first offered. */
  function shownVariant(tile: Tile, current: string): Theme {
    const offered = tile.options.filter((o) => !o.label.hidden);
    const pick = offered.find((o) => o.theme.id === tile.hovered) ?? tile.options.find((o) => o.theme.id === current) ?? offered[0] ?? tile.options[0];
    return pick.theme;
  }

  function drawPreview(tile: Tile, current: string): void {
    const theme = shownVariant(tile, current);
    const old = tile.el.querySelector<HTMLElement>(".tile-prev");
    if (old && old.dataset.variant === theme.id && old.dataset.scheme === activeScheme(theme)) return;
    const fresh = preview(theme);
    if (old) old.replaceWith(fresh);
    else tile.el.querySelector(".theme-variants")!.before(fresh);
  }

  /** Shows what the search and filter offer, keeping the chosen variant on show. */
  function refresh(): void {
    const current = chosenTheme().id;
    let shown = 0;
    for (const tile of tiles) {
      for (const o of tile.options) o.label.hidden = !(variantShown(o.theme, filter) || o.theme.id === current);
      const visible = familyMatches(tile.family, byId, query) && tile.options.some((o) => !o.label.hidden);
      tile.el.hidden = !visible;
      if (visible) {
        shown++;
        drawPreview(tile, current);
      }
    }
    for (const s of sections) s.el.hidden = s.tiles.every((t) => t.el.hidden);
    count.textContent = `${shown} of ${tiles.length} families`;
    empty.hidden = shown > 0;
    emptyText.textContent = `No theme matches "${query.trim()}".`;
  }

  function makeTile(family: Family, current: string): Tile {
    const tile: Tile = { family, el: h("div", { class: "theme-family", "data-theme-family": family.id }), options: [], hovered: null };
    for (const v of family.variants) {
      const theme = byId.get(v.id);
      if (!theme) continue;
      const radio = h("input", { type: "radio", name: "theme", value: theme.id, "aria-label": variantName(theme, v.label) });
      radio.checked = theme.id === current;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        chooseTheme(theme);
        say("");
        refresh();
      });
      const label = h("label", { class: "theme-option", "data-theme-option": theme.id }, radio, h("span", { class: "variant-label" }, v.label));
      // Pointing at a variant shows it in the preview before it is chosen.
      label.addEventListener("pointerenter", () => {
        tile.hovered = theme.id;
        drawPreview(tile, chosenTheme().id);
      });
      label.addEventListener("pointerleave", () => {
        tile.hovered = null;
        drawPreview(tile, chosenTheme().id);
      });
      tile.options.push({ theme, label, radio });
    }
    const head = h("div", { class: "family-head" }, h("span", { class: "family-name" }, family.name));
    if (family.variants.some((v) => v.id === DEFAULT_THEME_ID)) head.append(h("span", { class: "tag" }, "Default"));
    const custom = family.custom ? tile.options[0]?.theme : undefined;
    if (custom) {
      const remove = h("button", { type: "button", class: "btn ghost small", "aria-label": `Delete ${custom.name}` }, icon("trash"), "Delete");
      remove.addEventListener("click", () => {
        deleteCustomTheme(custom.id);
        if (chosenTheme().id === custom.id) chooseTheme(defaultTheme());
        render();
        say(`Deleted "${custom.name}".`);
        (list.querySelector<HTMLInputElement>("input[name=theme]:checked") ?? search).focus();
      });
      head.append(remove);
    }
    const variants = h("div", { class: "theme-variants" }, ...tile.options.map((o) => o.label));
    tile.el.append(head, h("p", { class: "family-schemes" }, schemesText(tile.options.map((o) => o.theme))), variants);
    // The preview chooses the variant it shows (a pointer convenience: the radios are the control).
    tile.el.addEventListener("click", (e) => {
      const prev = (e.target as Element).closest(".tile-prev");
      if (!prev) return;
      const o = tile.options.find((x) => x.theme.id === (prev as HTMLElement).dataset.variant);
      if (o && !o.radio.checked) o.radio.click();
      o?.radio.focus({ preventScroll: true });
    });
    return tile;
  }

  /** Which themes the tiles were built for: the built-in ones and the saved custom ones. */
  let builtFor = "";

  /**
   * Re-reads the saved themes and the current choice, and clears the search and filter. The tiles
   * are built once and kept while the themes on offer stay the same (a loaded or deleted file
   * rebuilds them): building 22 previews took about half the opening time at 4x CPU slowdown.
   */
  function render(): void {
    const current = chosenTheme().id;
    const themes = allThemes();
    query = "";
    filter = "all";
    search.value = "";
    for (const f of filters) f.input.checked = f.value === "all";
    panel.removeAttribute("data-keys");
    const signature = themes.map((t) => `${t.id}:${t.custom ? JSON.stringify(t.base) : ""}`).join("|");
    if (signature === builtFor) {
      for (const tile of tiles) {
        tile.hovered = null;
        for (const o of tile.options) o.radio.checked = o.theme.id === current;
      }
      refresh();
      return;
    }
    builtFor = signature;
    byId = new Map(themes.map((t) => [t.id, t]));
    const heading = (text: string) => h("h4", { class: "theme-group" }, text);
    const grid = (ts: Tile[]) => h("div", { class: "theme-grid" }, ...ts.map((t) => t.el));
    const start = curatedFamilies().map((f) => makeTile(f, current));
    const rest = otherFamilies().map((f) => makeTile(f, current));
    const yours = allThemes().filter((t) => t.custom).map((t) => makeTile(customFamily(t), current));
    tiles = [...start, ...rest, ...yours];
    const section = (key: string, title: string, ts: Tile[]) => h("div", { class: "theme-section", "data-section": key }, heading(title), grid(ts));
    sections = [
      { el: section("start", "Start here", start), tiles: start },
      { el: section("all", "All families, A to Z", rest), tiles: rest },
      ...(yours.length ? [{ el: section("yours", "Yours", yours), tiles: yours }] : []),
    ];
    list.replaceChildren(...sections.map((s) => s.el));
    refresh();
  }

  search.addEventListener("input", () => {
    query = search.value;
    refresh();
  });
  // Escape in a filled search clears it and keeps Settings open; in an empty one it closes Settings.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !search.value) return;
    e.preventDefault();
    e.stopPropagation();
    search.value = "";
    query = "";
    refresh();
  });
  for (const f of filters) {
    f.input.addEventListener("change", () => {
      if (!f.input.checked) return;
      filter = f.value;
      refresh();
    });
  }
  clearSearch.addEventListener("click", () => {
    search.value = "";
    query = "";
    refresh();
    search.focus();
  });

  // A "match device" preview is drawn in the device's scheme, so it is redrawn when the device
  // switches, Settings open or not. Only the previews are replaced: the radios stay, and so does the focus.
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const current = chosenTheme().id;
      for (const tile of tiles) if (!tile.el.hidden) drawPreview(tile, current);
    });
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

  panel.append(tools, list, empty, h("div", { class: "theme-foot" }, h("div", { class: "row-actions" }, load, template, fileInput), message));

  // The focus ring follows the keyboard: WebKit stops matching :focus-visible on a radio reached by
  // an arrow key (measured 2026-10-30, Playwright's WebKit, opened by mouse or by Enter alike), so
  // a key press marks the picker (data-keys, app.css) until the next press of a pointer.
  panel.addEventListener("keydown", () => panel.setAttribute("data-keys", ""), true);
  panel.addEventListener("pointerdown", () => panel.removeAttribute("data-keys"), true);

  const checked = () => list.querySelector<HTMLInputElement>("input[name=theme]:checked");
  return {
    el: panel,
    reset() {
      render();
      say("");
      return checked() ?? search;
    },
    reveal() {
      checked()?.closest(".theme-family")?.scrollIntoView({ block: "nearest" });
    },
  };
}
