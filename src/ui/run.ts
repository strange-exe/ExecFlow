// One place that picks the runtime for a file and reports runtime state to the UI. Python is
// imported up front (it starts lazily, on warmUp() or the first run); the C/C++ runner and its
// workers are a separate chunk, loaded the first time a C or C++ file is opened or run.
import type { LanguageId, RunHooks, RunRequest, RunResult, ToolDiagnostic, WsPath } from "../core/types";
import type { CppRunner, CppState } from "../runner/cpp-runner";
import * as python from "../runner/python-runner";
import type { PythonState } from "../runner/python-runner";

export type RuntimeKind = "python" | "cpp";
export const runtimeOf = (lang: LanguageId): RuntimeKind => (lang === "python" ? "python" : "cpp");

/** What the status bar shows for a runtime (its data-state, for tests). */
export type RuntimeState = PythonState | CppState | "not-loaded";

interface CppModule {
  runner: CppRunner;
  summarize(d: readonly ToolDiagnostic[]): string;
}

export class Runtimes {
  private cpp: Promise<CppModule> | null = null;
  private cppLoaded: CppModule | null = null;
  private listeners = new Set<() => void>();
  private active: RuntimeKind | null = null;

  constructor() {
    python.onState(() => this.emit());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Loads the C/C++ runner (once). Its compiler worker checks for the pack straight away. */
  loadCpp(): Promise<CppModule> {
    this.cpp ??= Promise.all([import("../runner/cpp-workers"), import("../runner/cpp-runner")]).then(([workers, mod]) => {
      const runner = workers.createCppRunner();
      runner.subscribe(() => this.emit());
      this.cppLoaded = { runner, summarize: mod.summarize };
      this.emit();
      return this.cppLoaded;
    });
    return this.cpp;
  }

  /** A file of this language is open: get its runtime ready so Run doesn't wait. */
  prepare(lang: LanguageId | null): void {
    if (lang === "python") python.warmUp();
    else if (lang === "c" || lang === "cpp") void this.loadCpp().then((m) => m.runner.prepare());
  }

  state(kind: RuntimeKind): RuntimeState {
    if (kind === "python") return python.state();
    return this.cppLoaded?.runner.state ?? "not-loaded";
  }

  /** Python's first-start download while it is worth showing (python-runner.ts downloadShown), else null. */
  pythonDownload(): { loaded: number; total: number } | null {
    return python.downloadShown();
  }

  /** Python couldn't start: it was never downloaded on this device, which is offline. */
  pythonNeedsOnline(): boolean {
    return python.needsOnline();
  }

  /** The C/C++ runner if it is loaded (for the pack download offer). */
  get cppRunner(): CppRunner | null {
    return this.cppLoaded?.runner ?? null;
  }

  get running(): RuntimeKind | null {
    return this.active;
  }

  async run(req: RunRequest, hooks: RunHooks): Promise<{ result: RunResult; summary: string }> {
    const kind = runtimeOf(req.lang);
    this.active = kind;
    this.emit();
    try {
      if (kind === "python") {
        const result = await python.run(req, hooks);
        return { result, summary: pythonSummary(result.diagnostics) };
      }
      const cpp = await this.loadCpp();
      const result = await cpp.runner.run(req, hooks);
      return { result, summary: cpp.summarize(result.diagnostics) };
    } finally {
      this.active = null;
      this.emit();
    }
  }

  stop(): void {
    if (this.active === "python") python.stop();
    else if (this.active === "cpp") this.cppLoaded?.runner.stop();
  }

  provideInput(text: string | null): void {
    if (this.active === "python") python.provideInput(text);
    else if (this.active === "cpp") this.cppLoaded?.runner.provideInput(text);
  }

  restartPython(): void {
    python.restart();
  }

  /** Idle syntax check of a Python file; null = not checked (keep the old marks). */
  check(path: WsPath, text: string): Promise<ToolDiagnostic[] | null> {
    return python.check(path, text);
  }
}

/** "ZeroDivisionError in main.py, line 3", for the run announcement. */
export function pythonSummary(diagnostics: readonly ToolDiagnostic[]): string {
  const first = diagnostics.find((d) => d.severity === "error");
  if (!first) return "";
  const where = first.path ? ` in ${first.path}, line ${first.line}` : "";
  return `${first.code ?? "Error"}${where}`;
}
