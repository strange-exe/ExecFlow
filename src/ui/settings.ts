// App preferences kept on this device (localStorage "codeeditor:settings"). Every value is checked
// on read, so an edited or old entry can't put the app in a bad state.
import type { BuildOptions } from "../core/types";

export const C_STANDARDS = ["c99", "c11", "c17", "gnu11", "gnu17"] as const;
export const CXX_STANDARDS = ["c++11", "c++14", "c++17", "c++2a"] as const;
export const OPT_LEVELS = ["0", "1", "2"] as const;

export interface Settings {
  /** Code font size in px, 12 to 20. */
  codeSize: number;
  lineWrapping: boolean;
  /** The suggestion list opens while typing; Ctrl+Space always opens it. */
  suggestOnTyping: boolean;
  /** The list opens with its top option picked, so Enter accepts it; off, Down or Up picks first (2026-10-28). */
  enterAcceptsTop: boolean;
  /** Running-time limit in seconds (time waiting for typed input doesn't count). */
  timeLimitS: number;
  /** Output kept before a run is stopped, in thousands of characters (1024 each). */
  outputLimitK: number;
  cStd: (typeof C_STANDARDS)[number];
  cxxStd: (typeof CXX_STANDARDS)[number];
  opt: (typeof OPT_LEVELS)[number];
  wall: boolean;
  wextra: boolean;
  /** Sync 60 s after the last edit while something is unsynced (used by the GitHub sync screens). */
  autoSync: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  // 15 px (the default since Deep Field, kept with JetBrains Mono in the Signal round: the approved
  // previews were drawn at 15). A saved size stays as saved.
  codeSize: 15,
  lineWrapping: false,
  suggestOnTyping: true,
  // On for everyone, settings saved before it existed too (cleanSettings): the owner's request.
  enterAcceptsTop: true,
  timeLimitS: 15,
  outputLimitK: 512,
  cStd: "gnu11",
  cxxStd: "c++17",
  opt: "2",
  wall: true,
  wextra: false,
  autoSync: true,
};

export const LIMITS = {
  codeSize: [12, 20],
  timeLimitS: [1, 120],
  outputLimitK: [16, 4096],
} as const;

export const SETTINGS_KEY = "codeeditor:settings";

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** A complete, valid Settings object from anything (stored JSON, a form). */
export function cleanSettings(input: unknown): Settings {
  const d = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const s = DEFAULT_SETTINGS;
  return {
    codeSize: clampInt(d.codeSize, LIMITS.codeSize, s.codeSize),
    lineWrapping: bool(d.lineWrapping, s.lineWrapping),
    suggestOnTyping: bool(d.suggestOnTyping, s.suggestOnTyping),
    enterAcceptsTop: bool(d.enterAcceptsTop, s.enterAcceptsTop),
    timeLimitS: clampInt(d.timeLimitS, LIMITS.timeLimitS, s.timeLimitS),
    outputLimitK: clampInt(d.outputLimitK, LIMITS.outputLimitK, s.outputLimitK),
    cStd: oneOf(C_STANDARDS, d.cStd, s.cStd),
    cxxStd: oneOf(CXX_STANDARDS, d.cxxStd, s.cxxStd),
    opt: oneOf(OPT_LEVELS, d.opt, s.opt),
    wall: bool(d.wall, s.wall),
    wextra: bool(d.wextra, s.wextra),
    autoSync: bool(d.autoSync, s.autoSync),
  };
}

export function buildOptions(s: Settings): BuildOptions {
  return {
    cStd: s.cStd,
    cxxStd: s.cxxStd,
    opt: s.opt,
    warnings: [...(s.wall ? ["-Wall"] : []), ...(s.wextra ? ["-Wextra"] : [])],
  };
}

export function runLimits(s: Settings): { timeoutMs: number; outputCap: number } {
  return { timeoutMs: s.timeLimitS * 1000, outputCap: s.outputLimitK * 1024 };
}

type Listener = (settings: Settings, previous: Settings) => void;

export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  onChange(listener: Listener): () => void;
}

export function createSettingsStore(storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): SettingsStore {
  let current = read();
  const listeners = new Set<Listener>();

  function read(): Settings {
    try {
      return cleanSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "{}"));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  return {
    get: () => ({ ...current }),
    update(patch) {
      const previous = current;
      current = cleanSettings({ ...current, ...patch });
      try {
        storage?.setItem(SETTINGS_KEY, JSON.stringify(current));
      } catch {
        // storage blocked: the change lasts for this visit
      }
      for (const listener of [...listeners]) listener({ ...current }, previous);
      return { ...current };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
