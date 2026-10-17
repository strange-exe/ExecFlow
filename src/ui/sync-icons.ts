// Icons only the sync screens use (Phosphor 2.1.1, MIT, inlined at build time like icons.ts). They
// live in the sync chunk, so the first visit doesn't carry them.
import arrowSquareOut from "@phosphor-icons/core/assets/regular/arrow-square-out.svg?raw";
import clockCountdown from "@phosphor-icons/core/assets/regular/clock-countdown.svg?raw";
import gitMerge from "@phosphor-icons/core/assets/regular/git-merge.svg?raw";
import key from "@phosphor-icons/core/assets/regular/key.svg?raw";
import wifiSlash from "@phosphor-icons/core/assets/regular/wifi-slash.svg?raw";
import { svg } from "./dom";
import { icon, pathData, type IconName } from "./icons";

const SOURCES = { "arrow-square-out": arrowSquareOut, "clock-countdown": clockCountdown, "git-merge": gitMerge, key, "wifi-slash": wifiSlash } as const;

export type SyncIconName = keyof typeof SOURCES;
export const SYNC_ICON_NAMES = Object.keys(SOURCES) as SyncIconName[];
export const syncIconSource = (name: SyncIconName): string => SOURCES[name];

const isSyncIcon = (name: string): name is SyncIconName => Object.hasOwn(SOURCES, name);

/** A decorative icon, drawn exactly like icons.ts icon(): path data only, aria-hidden. */
export function syncIcon(name: SyncIconName | IconName, className = ""): SVGSVGElement {
  if (!isSyncIcon(name)) return icon(name, className);
  return svg(
    "svg",
    { class: `icon ${className}`.trim(), viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": "true", focusable: "false", "data-icon": name },
    ...pathData(SOURCES[name]).map((d) => svg("path", { d })),
  );
}
