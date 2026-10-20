// The lazy library data (library-data.ts): one load per library, shared by every caller; a failed
// load (offline before the chunk was ever cached) falls back quietly, logs nothing, and is tried
// again only after RETRY_MS.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./data/python-stdlib.json");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("loadLibrary", () => {
  it("loads each library once; every caller shares the one load", async () => {
    vi.resetModules();
    const data = await import("./library-data");
    expect(data.libraryStatus("python")).toBe("idle");
    const [a, b] = [data.loadLibrary("python"), data.loadLibrary("python")];
    expect(a).toBe(b);
    expect(data.libraryStatus("python")).toBe("loading");
    expect(await a).toBe(true);
    expect(data.libraryStatus("python")).toBe("ready");
    const lib = data.library("python")!;
    expect(lib.modules).toContain("math");
    expect(lib.members.math.function?.sqrt).toBe("(x, /)");
    // The C library loads on its own, only when asked.
    expect(data.libraryStatus("c")).toBe("idle");
    expect(await data.loadLibrary("c")).toBe(true);
    expect(data.library("c")!.headers.c).toContain("stdio.h");
  });

  it("falls back quietly when the chunk can't load, and tries again only after RETRY_MS", async () => {
    vi.resetModules();
    let fail = true;
    let calls = 0;
    vi.doMock("./data/python-stdlib.json", () => {
      calls++;
      if (fail) throw new Error("Failed to fetch dynamically imported module (offline)");
      return { default: { modules: ["math"], members: {} } };
    });
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    const data = await import("./library-data");
    let clock = 1_000;
    const now = () => clock;

    expect(await data.loadLibrary("python", now)).toBe(false);
    expect(data.libraryStatus("python")).toBe("failed");
    expect(data.library("python")).toBeNull();
    expect(calls).toBe(1);

    // Within RETRY_MS nothing is requested again (no stream of failing requests while offline).
    clock += data.RETRY_MS - 1;
    expect(await data.loadLibrary("python", now)).toBe(false);
    expect(calls).toBe(1);

    // After it, the next request tries again, and this time the chunk arrives.
    fail = false;
    vi.resetModules();
    clock += 1;
    const retried = data.loadLibrary("python", now);
    expect(data.libraryStatus("python")).toBe("loading");
    expect(await retried).toBe(true);
    expect(data.library("python")!.modules).toEqual(["math"]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it("refuses data of the wrong shape as a failed load", async () => {
    vi.resetModules();
    vi.doMock("./data/python-stdlib.json", () => ({ default: { modules: "math" } }));
    const data = await import("./library-data");
    expect(await data.loadLibrary("python")).toBe(false);
    expect(data.libraryStatus("python")).toBe("failed");
    expect(data.library("python")).toBeNull();
  });
});
