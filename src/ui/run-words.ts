// Words and choices about a run that the Output view and the workbench share, kept free of the DOM
// so they are unit-tested: the run header's phase words, which exit codes it shows, and the program
// to offer when the file that ran has no main().
import { splitExtension, nameOf } from "../core/paths";
import type { LanguageId, RunPhase, RunResult, WsPath } from "../core/types";

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

/**
 * The run header's words for a phase. Python's first start says it downloads once, about how much,
 * and how far it got (B9, 2026-10-24): "Downloading Python (one time, about 12 MB): 3.4 of 12.3 MB".
 */
export function phaseLabel(phase: RunPhase, detail: string | undefined, lang: LanguageId, progress?: { loaded: number; total: number }): string {
  switch (phase) {
    case "downloading":
      if (progress && detail === "Python") {
        const { loaded, total } = progress;
        return total > 0
          ? `Downloading Python (one time, about ${Math.round(total / 1e6)} MB): ${mb(Math.min(loaded, total))} of ${mb(total)} MB`
          : `Downloading Python (one time): ${mb(loaded)} MB so far`;
      }
      return detail ? `Downloading ${detail}` : lang === "python" ? "Downloading Python" : "Downloading the C/C++ compiler";
    case "booting":
      return lang === "python" ? "Starting Python" : "Starting the C/C++ compiler";
    case "compiling":
      return detail ? `Compiling ${detail}` : "Compiling";
    case "linking":
      return "Linking";
    case "running":
      return "Running";
  }
}

/**
 * Whether the header shows "exit code N" (B13). Not for a run that was stopped (Stop, the time or
 * output limit): its 130 is the interrupt, not the program's own answer. Not for "error" either,
 * whose status words already say "Exited with code N".
 */
export function showsExitCode(r: Pick<RunResult, "status" | "exitCode">): boolean {
  return r.exitCode !== null && (r.status === "ok" || r.status === "crashed");
}

/**
 * A C or C++ file without main() was run (the linker's "undefined symbol: main") while its folder
 * has a program that does have one (the runner skipped it as a separate program): the one to offer,
 * "This file has no main(). Run lab1/main.c?" (B13). A file called main wins; otherwise only a
 * single candidate is offered, since with several the student's intent isn't known.
 */
export function mainToOffer(r: Pick<RunResult, "status" | "diagnostics" | "skipped">): WsPath | null {
  if (r.status !== "build-failed" || !r.skipped?.length) return null;
  if (!r.diagnostics.some((d) => d.source === "wasm-ld" && /^undefined symbol: main\b/.test(d.message))) return null;
  return r.skipped.find((p) => splitExtension(nameOf(p)).stem === "main") ?? (r.skipped.length === 1 ? r.skipped[0] : null);
}
