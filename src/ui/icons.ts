// Phosphor icons (@phosphor-icons/core 2.1.1, MIT, dev dependency). Vite inlines each SVG file as a
// string at build time (?raw); only the path data is used, drawn with createElementNS, so no SVG
// markup is ever parsed and no icon font or runtime request is needed.
import arrowClockwise from "@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw";
import arrowRight from "@phosphor-icons/core/assets/regular/arrow-right.svg?raw";
import caretDown from "@phosphor-icons/core/assets/regular/caret-down.svg?raw";
import caretRight from "@phosphor-icons/core/assets/regular/caret-right.svg?raw";
import caretUp from "@phosphor-icons/core/assets/regular/caret-up.svg?raw";
import checkCircle from "@phosphor-icons/core/assets/regular/check-circle.svg?raw";
import cloudArrowUp from "@phosphor-icons/core/assets/regular/cloud-arrow-up.svg?raw";
import cloudCheck from "@phosphor-icons/core/assets/regular/cloud-check.svg?raw";
import cloudSlash from "@phosphor-icons/core/assets/regular/cloud-slash.svg?raw";
import codeSimple from "@phosphor-icons/core/assets/regular/code-simple.svg?raw";
import copy from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import cornersIn from "@phosphor-icons/core/assets/regular/corners-in.svg?raw";
import cornersOut from "@phosphor-icons/core/assets/regular/corners-out.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/regular/dots-three.svg?raw";
import downloadSimple from "@phosphor-icons/core/assets/regular/download-simple.svg?raw";
import eraser from "@phosphor-icons/core/assets/regular/eraser.svg?raw";
import file from "@phosphor-icons/core/assets/regular/file.svg?raw";
import fileC from "@phosphor-icons/core/assets/regular/file-c.svg?raw";
import fileCpp from "@phosphor-icons/core/assets/regular/file-cpp.svg?raw";
import filePlus from "@phosphor-icons/core/assets/regular/file-plus.svg?raw";
import filePy from "@phosphor-icons/core/assets/regular/file-py.svg?raw";
import fileText from "@phosphor-icons/core/assets/regular/file-text.svg?raw";
import folder from "@phosphor-icons/core/assets/regular/folder.svg?raw";
import folderOpen from "@phosphor-icons/core/assets/regular/folder-open.svg?raw";
import folderPlus from "@phosphor-icons/core/assets/regular/folder-plus.svg?raw";
import gear from "@phosphor-icons/core/assets/regular/gear.svg?raw";
import githubLogo from "@phosphor-icons/core/assets/regular/github-logo.svg?raw";
import image from "@phosphor-icons/core/assets/regular/image.svg?raw";
import info from "@phosphor-icons/core/assets/regular/info.svg?raw";
import keyboard from "@phosphor-icons/core/assets/regular/keyboard.svg?raw";
import linkSimple from "@phosphor-icons/core/assets/regular/link-simple.svg?raw";
import lock from "@phosphor-icons/core/assets/regular/lock.svg?raw";
import magnifyingGlass from "@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw";
import minus from "@phosphor-icons/core/assets/regular/minus.svg?raw";
import paperPlaneRight from "@phosphor-icons/core/assets/regular/paper-plane-right.svg?raw";
import pencilSimple from "@phosphor-icons/core/assets/regular/pencil-simple.svg?raw";
import plus from "@phosphor-icons/core/assets/regular/plus.svg?raw";
import printer from "@phosphor-icons/core/assets/regular/printer.svg?raw";
import scissors from "@phosphor-icons/core/assets/regular/scissors.svg?raw";
import selectionAll from "@phosphor-icons/core/assets/regular/selection-all.svg?raw";
import shieldCheck from "@phosphor-icons/core/assets/regular/shield-check.svg?raw";
import sidebarSimple from "@phosphor-icons/core/assets/regular/sidebar-simple.svg?raw";
import tabs from "@phosphor-icons/core/assets/regular/tabs.svg?raw";
import terminalWindow from "@phosphor-icons/core/assets/regular/terminal-window.svg?raw";
import trash from "@phosphor-icons/core/assets/regular/trash.svg?raw";
import treeStructure from "@phosphor-icons/core/assets/regular/tree-structure.svg?raw";
import uploadSimple from "@phosphor-icons/core/assets/regular/upload-simple.svg?raw";
import warning from "@phosphor-icons/core/assets/regular/warning.svg?raw";
import warningCircle from "@phosphor-icons/core/assets/regular/warning-circle.svg?raw";
import x from "@phosphor-icons/core/assets/regular/x.svg?raw";
import xCircle from "@phosphor-icons/core/assets/regular/x-circle.svg?raw";
import playFill from "@phosphor-icons/core/assets/fill/play-fill.svg?raw";
import stopFill from "@phosphor-icons/core/assets/fill/stop-fill.svg?raw";
import { svg } from "./dom";

const SOURCES = {
  "arrow-clockwise": arrowClockwise, "arrow-right": arrowRight, "caret-down": caretDown, "caret-right": caretRight,
  "caret-up": caretUp, "check-circle": checkCircle,
  "cloud-arrow-up": cloudArrowUp, "cloud-check": cloudCheck, "cloud-slash": cloudSlash, "code-simple": codeSimple,
  copy, "corners-in": cornersIn, "corners-out": cornersOut,
  "dots-three": dotsThree, "download-simple": downloadSimple, eraser, file, "file-c": fileC, "file-cpp": fileCpp,
  "file-plus": filePlus, "file-py": filePy, "file-text": fileText, folder, "folder-open": folderOpen,
  "folder-plus": folderPlus, gear, "github-logo": githubLogo, image, info, keyboard, "link-simple": linkSimple, lock, "magnifying-glass": magnifyingGlass, minus, "paper-plane-right": paperPlaneRight,
  "pencil-simple": pencilSimple, plus, printer, scissors, "selection-all": selectionAll, "shield-check": shieldCheck, "sidebar-simple": sidebarSimple, tabs,
  "terminal-window": terminalWindow, trash, "tree-structure": treeStructure, "upload-simple": uploadSimple, warning, "warning-circle": warningCircle,
  x, "x-circle": xCircle, "play-fill": playFill, "stop-fill": stopFill,
} as const;

export type IconName = keyof typeof SOURCES;

/** The `d` attribute of every <path> in a Phosphor SVG (they contain nothing else). */
export function pathData(source: string): string[] {
  return [...source.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
}

const cache = new Map<IconName, string[]>();

/** A decorative 1em icon (aria-hidden): give its control a visible label or an aria-label. */
export function icon(name: IconName, className = ""): SVGSVGElement {
  let paths = cache.get(name);
  if (!paths) cache.set(name, (paths = pathData(SOURCES[name])));
  return svg(
    "svg",
    { class: `icon ${className}`.trim(), viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": "true", focusable: "false", "data-icon": name },
    ...paths.map((d) => svg("path", { d })),
  );
}

export const ICON_NAMES = Object.keys(SOURCES) as IconName[];
export const iconSource = (name: IconName): string => SOURCES[name];
