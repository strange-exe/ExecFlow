// The About page's theme preview: which themes it lists and which one it shows first. Pure, so the
// rules are unit tested; page.ts themePreview() draws them.
import type { Scheme, Theme } from "../theme/themes";

/** Every built-in look once: a "match device" entry repeats its own light and dark themes. */
export function previewThemes(all: readonly Theme[]): Theme[] {
  return all.filter((t) => !t.system);
}

/** A theme's name without the product's own prefix ("ExecFlow Signal Light" reads "Signal Light"). */
export function shortName(t: Theme): string {
  return t.name.replace(/^ExecFlow /, "");
}

/**
 * The theme shown first: the one chosen in the editor (a "match device" choice as its variant in the
 * page's scheme), else Signal in the page's scheme. Anything unknown, such as a custom theme's id or
 * a damaged value, falls back to Signal.
 */
export function firstPreview(all: readonly Theme[], chosen: string | null, scheme: Scheme): string {
  const list = previewThemes(all);
  const fallback = `signal-${scheme}`;
  const t = all.find((x) => x.id === chosen);
  if (!t) return fallback;
  if (!t.system) return list.some((x) => x.id === t.id) ? t.id : fallback;
  return list.find((x) => x.own === t.own && x.scheme === scheme)?.id ?? fallback;
}
