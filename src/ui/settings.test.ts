import { describe, expect, it } from "vitest";
import { buildOptions, cleanSettings, createSettingsStore, DEFAULT_SETTINGS, runLimits, SETTINGS_KEY } from "./settings";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("settings", () => {
  it("defaults are 15 px code, 15 s, 512 Ki characters, gnu11, c++17, -O2 and -Wall", () => {
    expect(DEFAULT_SETTINGS.codeSize).toBe(15);
    expect(runLimits(DEFAULT_SETTINGS)).toEqual({ timeoutMs: 15_000, outputCap: 512 * 1024 });
    expect(buildOptions(DEFAULT_SETTINGS)).toEqual({ cStd: "gnu11", cxxStd: "c++17", opt: "2", warnings: ["-Wall"] });
  });

  it("reads settings stored with an old defines key (plan-v2 P4): it is dropped, the rest kept, no -D built", () => {
    const old = { codeSize: 17, cStd: "c99", wextra: true, defines: ["DEBUG=1"], buildDefines: "N=3" };
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify(old) });
    const s = createSettingsStore(storage).get();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, codeSize: 17, cStd: "c99", wextra: true });
    expect(s).not.toHaveProperty("defines");
    expect(buildOptions(s)).toEqual({ cStd: "c99", cxxStd: "c++17", opt: "2", warnings: ["-Wall", "-Wextra"] });
    expect(buildOptions(s)).not.toHaveProperty("defines");
  });

  it("clamps numbers and drops values it doesn't know", () => {
    const s = cleanSettings({ codeSize: 99, timeLimitS: "0", outputLimitK: -5, cStd: "c23", opt: "3", wall: "yes", extra: true });
    expect(s.codeSize).toBe(20);
    expect(s.timeLimitS).toBe(1);
    expect(s.outputLimitK).toBe(16);
    expect(s.cStd).toBe("gnu11");
    expect(s.opt).toBe("2");
    expect(s.wall).toBe(true);
    expect(s).not.toHaveProperty("extra");
  });

  it("keeps suggestions while typing on unless a stored false says otherwise", () => {
    expect(DEFAULT_SETTINGS.suggestOnTyping).toBe(true);
    expect(cleanSettings({}).suggestOnTyping).toBe(true);
    expect(cleanSettings({ suggestOnTyping: false }).suggestOnTyping).toBe(false);
    for (const odd of ["false", 0, null, "off"]) expect(cleanSettings({ suggestOnTyping: odd }).suggestOnTyping, String(odd)).toBe(true);
    const storage = memoryStorage();
    createSettingsStore(storage).update({ suggestOnTyping: false });
    expect(createSettingsStore(storage).get().suggestOnTyping).toBe(false);
  });

  it("survives broken stored data and keeps updates", () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: "{not json" });
    const store = createSettingsStore(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    let seen = 0;
    store.onChange((now, before) => {
      seen++;
      expect(before.codeSize).toBe(15);
      expect(now.codeSize).toBe(16);
    });
    store.update({ codeSize: 16, wextra: true });
    expect(seen).toBe(1);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!)).toMatchObject({ codeSize: 16, wextra: true });
    expect(buildOptions(store.get()).warnings).toEqual(["-Wall", "-Wextra"]);
  });
});
