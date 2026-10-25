import { describe, expect, it } from "vitest";
import type { RunResult, ToolDiagnostic } from "../core/types";
import { mainToOffer, phaseLabel, showsExitCode } from "./run-words";

describe("phaseLabel", () => {
  it("names each phase as before", () => {
    expect(phaseLabel("booting", undefined, "python")).toBe("Starting Python");
    expect(phaseLabel("booting", undefined, "c")).toBe("Starting the C/C++ compiler");
    expect(phaseLabel("downloading", "numpy", "python")).toBe("Downloading numpy");
    expect(phaseLabel("downloading", undefined, "cpp")).toBe("Downloading the C/C++ compiler");
    expect(phaseLabel("compiling", "main.c", "c")).toBe("Compiling main.c");
    expect(phaseLabel("linking", undefined, "c")).toBe("Linking");
    expect(phaseLabel("running", undefined, "python")).toBe("Running");
  });

  it("says the first Python start downloads it once, how big it is and how far it got (B9)", () => {
    expect(phaseLabel("downloading", "Python", "python", { loaded: 3_400_000, total: 12_264_000 })).toBe("Downloading Python (one time, about 12 MB): 3.4 of 12.3 MB");
    expect(phaseLabel("downloading", "Python", "python", { loaded: 0, total: 12_264_000 })).toBe("Downloading Python (one time, about 12 MB): 0.0 of 12.3 MB");
    // Never more than the whole.
    expect(phaseLabel("downloading", "Python", "python", { loaded: 13_000_000, total: 12_264_000 })).toBe("Downloading Python (one time, about 12 MB): 12.3 of 12.3 MB");
    // A build that doesn't know the size says what has arrived.
    expect(phaseLabel("downloading", "Python", "python", { loaded: 5_120_000, total: 0 })).toBe("Downloading Python (one time): 5.1 MB so far");
  });
});

describe("showsExitCode (B13)", () => {
  it("shows the code of a program that ended on its own, never the 130 of one that was stopped", () => {
    expect(showsExitCode({ status: "ok", exitCode: 0 })).toBe(true);
    expect(showsExitCode({ status: "crashed", exitCode: 1 })).toBe(true);
    for (const status of ["stopped", "timeout", "output-limit"] as const) expect(showsExitCode({ status, exitCode: 130 }), status).toBe(false);
    // "error" names its code in the status words ("Exited with code 1").
    expect(showsExitCode({ status: "error", exitCode: 1 })).toBe(false);
    expect(showsExitCode({ status: "ok", exitCode: null })).toBe(false);
  });
});

describe("mainToOffer (B13)", () => {
  const noMain: ToolDiagnostic = { path: null, line: 1, unit: "utf16", base: 0, severity: "error", message: "undefined symbol: main", source: "wasm-ld" };
  const result = (extra: Partial<RunResult>): RunResult => ({ status: "build-failed", exitCode: null, diagnostics: [noMain], ms: {}, ...extra });

  it("offers the program's main.c when the file run has no main()", () => {
    expect(mainToOffer(result({ skipped: ["lab1/main.c"] }))).toBe("lab1/main.c");
    expect(mainToOffer(result({ skipped: ["lab1/hello.c", "lab1/main.cpp"] }))).toBe("lab1/main.cpp");
    expect(mainToOffer(result({ skipped: ["lab1/hello.c"] }))).toBe("lab1/hello.c");
  });

  it("offers nothing when it can't tell which program is meant, or main isn't what is missing", () => {
    expect(mainToOffer(result({ skipped: ["a.c", "b.c"] })), "two programs, neither called main").toBeNull();
    expect(mainToOffer(result({ skipped: [] }))).toBeNull();
    expect(mainToOffer(result({}))).toBeNull();
    expect(mainToOffer(result({ skipped: ["main.c"], diagnostics: [{ ...noMain, message: "undefined symbol: square" }] }))).toBeNull();
    expect(mainToOffer(result({ status: "ok", skipped: ["main.c"] }))).toBeNull();
    // A clang error that merely mentions main is not the linker's missing main.
    expect(mainToOffer(result({ skipped: ["main.c"], diagnostics: [{ ...noMain, source: "clang" }] }))).toBeNull();
  });
});
