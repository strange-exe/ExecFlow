// The C/C++ runner with its two workers. Kept apart from cpp-runner.ts so unit tests can give the
// runner fake workers. The `new Worker(new URL(...), { type: "module" })` form is what Vite
// recognises and bundles (emitted under assets/w/, where the worker-only CSP applies).
import { CppRunner } from "./cpp-runner";

export function createCppRunner(): CppRunner {
  return new CppRunner(
    () => new Worker(new URL("../workers/clang.worker.ts", import.meta.url), { type: "module" }),
    () => new Worker(new URL("../workers/c-runner.worker.ts", import.meta.url), { type: "module" }),
  );
}
