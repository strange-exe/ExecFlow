// The compiler driver's own command lines, turned into templates (0.17.0, LLVM 22). At boot the worker
// asks the driver what it would run (`clang -### ...` for one probe file); everything the driver adds
// for this target (the triple, the exception model, the include order, the libraries and their
// order) is kept, and only the per-file parts are taken out, so units are compiled with exactly the
// driver's flags without starting the driver for each one. Pure: the worker runs these, the tests
// check them against output captured from the real driver (__fixtures__/clang22-driver.json).

/** Where the probe lives in the compiler's file tree. */
export const PROBE = { c: "/ce/probe.c", cpp: "/ce/probe.cpp", object: "/ce/probe.o", output: "/ce/probe.wasm" } as const;

/** The C/C++ library folder (wasi-sdk-33, wasm32-wasip1) and its exceptions build. */
export const SYSROOT = "/sysroot";
const EH = `${SYSROOT}/include/wasm32-wasip1/eh`;
/** ExecFlow's own headers (bits/stdc++.h), searched after the libraries' own. */
export const CE_INCLUDE = "/ce/include";

const TARGET = ["--target=wasm32-wasip1", `--sysroot=${SYSROOT}`];
/**
 * C++ exceptions (wasi-sdk's CppExceptions.md): the standard exception instructions, and the C++
 * library built with them. This driver doesn't switch to the eh/ folders by itself, so they are named.
 */
const CXX_EH = ["-fwasm-exceptions", "-mllvm", "-wasm-use-legacy-eh=false"];
const CXX_HEADERS = ["-nostdinc++", "-isystem", `${EH}/c++/v1`, "-isystem", EH];

/**
 * Plain diagnostic output, one parseable line per message plus fix-its (clang-diagnostics.ts), in the
 * driver's spelling: cc1 spells some of these differently (or not at all) in clang 22, so the
 * templates carry the driver's own translation.
 */
const DIAGNOSTICS = [
  "-fno-color-diagnostics", "-fdiagnostics-print-source-range-info", "-fdiagnostics-show-option",
  "-fdiagnostics-parseable-fixits", "-fmessage-length=0", "-ferror-limit=50",
  // Source snippets without clang 16+'s "  5 | code" gutter: the shape the parser reads.
  "-fno-diagnostics-show-line-numbers",
];

/** The driver runs (each with -###) whose jobs become the templates. */
export const PROBES = {
  c: ["clang", "-###", ...TARGET, ...DIAGNOSTICS, "-isystem", CE_INCLUDE, "-c", PROBE.c, "-o", PROBE.object],
  cpp: ["clang++", "-###", ...TARGET, ...CXX_EH, ...CXX_HEADERS, ...DIAGNOSTICS, "-isystem", CE_INCLUDE, "-c", PROBE.cpp, "-o", PROBE.object],
  link: ["clang++", "-###", ...TARGET, ...CXX_EH, `-L${SYSROOT}/lib/wasm32-wasip1/eh`, PROBE.object, "-lunwind", "-o", PROBE.output],
} as const;

/**
 * The job lines of `clang -###` output: each is one quoted command after the driver's banner
 * (" "/usr/bin/clang" "-cc1" ..."), ending at the first blank line. Same reading as the runtime's
 * own runClang wrapper. Throws when the driver printed an error instead.
 */
export function parseDriverJobs(output: string): string[][] {
  const jobs: string[][] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith(' "')) continue;
    const args = [...line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])+)")/g)].map((m) => m[1] ?? m[2].replace(/\\(["\\$])/g, "$1"));
    if (args[0] === "") args.shift(); // the runtime prints an empty program path first
    jobs.push(args);
  }
  if (!jobs.length) throw new Error(`the compiler driver printed no commands: ${output.trim().split("\n").slice(-3).join(" | ") || "nothing"}`);
  return jobs;
}

/** Flags the template must not carry: each unit sets its own (the diagnostics flags stay: PROBES chose them). */
const DROP_WITH_VALUE = new Set(["-o", "-main-file-name", "-x", "-dumpdir"]);
const DROP_ALONE = /^(?:-O.*|-emit-obj|-fcolor-diagnostics)$/;

/**
 * The cc1 arguments every unit of a language shares: the driver's cc1 job for the probe, without
 * the program name, "-cc1", the probe's file names, the output, and the flags units choose.
 */
export function cc1Template(jobs: string[][], probe: string): string[] {
  const job = jobs.find((j) => j[1] === "-cc1");
  if (!job) throw new Error("the compiler driver planned no compile step");
  const out: string[] = [];
  for (let i = 2; i < job.length; i++) {
    const arg = job[i];
    if (DROP_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (DROP_ALONE.test(arg) || arg === probe) continue;
    out.push(arg);
  }
  return out;
}

/**
 * The linker command: the driver's wasm-ld job for the probe object, as [program, ...args]. "{objects}"
 * stands where the probe object was (the start-up object and the units go there, in order) and "{output}"
 * where its output was.
 */
export function linkTemplate(jobs: string[][]): string[] {
  const job = jobs.find((j) => /(?:^|\/)wasm-ld$/.test(j[0]));
  if (!job) throw new Error("the compiler driver planned no link step");
  const out = [...job];
  out[0] = "wasm-ld";
  const obj = out.indexOf(PROBE.object);
  const o = out.indexOf("-o");
  if (obj < 0 || o < 0 || out[o + 1] !== PROBE.output) {
    throw new Error(`the link step has no place for the program's objects or output (${job.join(" ").slice(0, 400)})`);
  }
  out[obj] = "{objects}";
  out[o + 1] = "{output}";
  return out;
}

/** A link command from the template: the objects in order, the output, and the extra flags after the program name. */
export function linkArgs(template: readonly string[], objects: readonly string[], output: string, extra: readonly string[]): string[] {
  return template.flatMap((arg, i) => (arg === "{objects}" ? [...objects] : arg === "{output}" ? [output] : i === 0 ? [arg, ...extra] : [arg]));
}
