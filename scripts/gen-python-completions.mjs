// Generates src/editor/data/python-stdlib.json, the Python completion data: the standard-library
// modules that import in the Pyodide CodeEditor ships, and the public members of the modules a
// beginner uses, each with a CodeMirror completion type and, for callables, the signature that
// inspect.signature gives. No docstrings: an option's detail is its signature, and any longer text is
// written by us in the editor code.
//
// It runs the pinned Pyodide from node_modules/pyodide in Node, with indexURL set to that folder, so
// the runtime and the standard library are read from disk (Node section of
// https://pyodide.org/en/stable/usage/index.html; loadPyodide options at
// https://pyodide.org/en/stable/usage/api/js-api.html). fetch is replaced by a function that throws
// before Pyodide loads, so a run cannot reach the network. Output is sorted, LF-only, ASCII and
// date-free, so a run on any machine gives the same bytes.
//
// Usage: node scripts/gen-python-completions.mjs           writes the file and prints sizes
//        node scripts/gen-python-completions.mjs --check   writes nothing; exits 1 if the file differs
//        node scripts/gen-python-completions.mjs --report  also prints each member module's gzip cost
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const PYODIDE_VERSION = "314.0.7";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pyodideDir = join(root, "node_modules", "pyodide");
const outFile = join(root, "src", "editor", "data", "python-stdlib.json");
const generator = relative(root, fileURLToPath(import.meta.url)).split("\\").join("/");
const check = process.argv.includes("--check");
const report = process.argv.includes("--report");

/** The longest signature kept; a longer one is left out (the option then shows no detail). */
const MAX_SIGNATURE = 120;

/**
 * Modules that import in Pyodide but whose purpose cannot work in CodeEditor's Python worker, or
 * that Pyodide leaves out (listed anyway, so the decision stays recorded if a later Pyodide ships
 * them). The facts in brackets were measured with Pyodide 314.0.7 under Node. Network clients fail
 * twice over: Pyodide lists sockets as "included but not working"
 * (https://pyodide.org/en/stable/usage/wasm-constraints.html), and the worker removes fetch,
 * XMLHttpRequest and WebSocket before user code runs (src/workers/lockdown.ts).
 * Also listed: internal helpers a program never imports itself (design decision 17, 2026-10-19:
 * Hick's law, fewer choices in the list).
 * Kept on purpose: http, urllib and wsgiref, whose network parts fail but whose pure-Python parts
 * (http.HTTPStatus, urllib.parse, wsgiref.util) work. Not listed: test (CPython's own test suite), because
 * sys.stdlib_module_names leaves test modules out
 * (https://docs.python.org/3.14/library/sys.html#sys.stdlib_module_names); the run fails if it appears.
 */
const EXCLUDED = {
  antigravity: "opens a web page through webbrowser, which cannot open one from the Python worker",
  concurrent: "its executors run work on threads or processes, and Pyodide can start neither [submit(): can't start new thread]",
  ensurepip: "installs pip into a Python environment; Pyodide leaves it out",
  ftplib: "an FTP client: needs network sockets, and the Python worker has no network",
  idlelib: "the IDLE desktop editor, built on tkinter; Pyodide leaves it out",
  imaplib: "an IMAP mail client: needs network sockets, and the Python worker has no network",
  multiprocessing: "starts processes, which Pyodide cannot [Process().start(): No module named '_multiprocessing']",
  nturl2path: "an internal helper of urllib.request for Windows paths, which a program never imports itself",
  poplib: "a POP3 mail client: needs network sockets, and the Python worker has no network",
  pty: "needs a pseudo-terminal [pty.openpty(): out of pty devices]",
  smtplib: "an SMTP mail client: needs network sockets, and the Python worker has no network",
  socket: "network sockets, and the Python worker has no network",
  socketserver: "network servers built on sockets, and the Python worker has no network",
  ssl: "TLS for network sockets; Pyodide's ssl is a stub, and the Python worker has no network",
  subprocess: "starts other programs [subprocess.run(): emscripten does not support processes]",
  termios: "controls a terminal, and a program's input and output here are not one [tcgetattr(0): Not a tty]",
  threading: "Pyodide cannot start threads [Thread().start(): can't start new thread]",
  tkinter: "a desktop GUI toolkit (Tk); Pyodide leaves it out",
  tty: "puts a terminal in raw mode, and a program's input and output here are not one [setraw(0): Not a tty]",
  turtle: "draws in a tkinter window; Pyodide leaves it out",
  turtledemo: "turtle demos, built on tkinter; Pyodide leaves it out",
  venv: "creates virtual environments by running programs; Pyodide leaves it out",
  webbrowser: "Pyodide's version opens tabs through js.window, and a Web Worker such as the Python worker has no window [open(): cannot import name 'window' from 'js']",
  xmlrpc: "remote calls over HTTP: needs network sockets, and the Python worker has no network",
};

/** Modules whose members are listed, in the order a beginner meets them (the task's list). */
const MEMBER_MODULES = [
  "math", "random", "string", "statistics", "collections", "itertools", "functools", "operator", "datetime", "time",
  "calendar", "os", "os.path", "sys", "re", "json", "csv", "fractions", "decimal", "heapq", "bisect", "copy",
  "typing", "dataclasses", "enum", "pathlib", "textwrap", "array", "cmath",
];

/**
 * Member modules left out to keep the file near 6 KB gzip, and why. `--report` prints what each
 * module costs; for Pyodide 314.0.7 the file is 6,070 B gzip, and adding os back would add 1,890 B,
 * typing 834 B (the largest kept module, sys, costs 637 B).
 */
const CUT = {
  os:
    "the largest module by far: 282 names, 122 of them OS constants (O_*, EX_*, CLD_*) and most of the rest " +
    "POSIX calls; os.path, the part a beginner uses, keeps its own entry",
  typing:
    "105 names that matter only once a program has type hints, and inspect reports its special forms as " +
    "functions (Optional, List and Callable with the signature (*args, **kwds)), so their icons and details would mislead",
};

// ---------------------------------------------------------------- run Pyodide

const pkg = JSON.parse(await readFile(join(pyodideDir, "package.json"), "utf8"));
if (pkg.version !== PYODIDE_VERSION) {
  throw new Error(`node_modules/pyodide is ${pkg.version}, but this generator is for ${PYODIDE_VERSION}. Re-check its data and exclusions for the new version first.`);
}

globalThis.fetch = () => {
  throw new Error("gen-python-completions: network access is disabled");
};

const started = performance.now();
const { loadPyodide } = await import(pathToFileURL(join(pyodideDir, "pyodide.mjs")).href);
const py = await loadPyodide({
  indexURL: pyodideDir + "/",
  stdout: (line) => process.stderr.write(`[python] ${line}\n`),
  stderr: (line) => process.stderr.write(`[python] ${line}\n`),
});
if (py.version !== PYODIDE_VERSION) throw new Error(`loaded Pyodide ${py.version}, expected ${PYODIDE_VERSION}`);

const memberModules = MEMBER_MODULES.filter((m) => !Object.hasOwn(CUT, m));
// Cut modules are read too, so --report can price adding each one back.
py.globals.set("CONFIG", JSON.stringify({ excluded: Object.keys(EXCLUDED), memberModules: MEMBER_MODULES }));

// Members are read first, in a fresh interpreter, so importing the rest of the library can't change
// what dir() shows. Then every other module is imported once, with its output swallowed.
const raw = JSON.parse(py.runPython(String.raw`
import annotationlib, contextlib, enum, importlib, importlib.util, inspect, io, json, sys, warnings

config = json.loads(CONFIG)
IMMUTABLE = (bool, int, float, complex, str, bytes, type(None))


def first_line(error):
    text = str(error).strip()
    return type(error).__name__ + (": " + text.splitlines()[0] if text else "")


def is_constant(name, value):
    if isinstance(value, (enum.Enum,) + IMMUTABLE):
        return True
    if isinstance(value, (tuple, frozenset)) and all(isinstance(item, IMMUTABLE) for item in value):
        return True
    return name.isupper()


def kind_of(name, value):
    if inspect.ismodule(value):
        return "namespace"
    if inspect.isclass(value):
        return "class"
    if callable(value):
        return "function"
    return "constant" if is_constant(name, value) else "variable"


def signature_of(value):
    try:
        signature = inspect.signature(value, annotation_format=annotationlib.Format.STRING)
    except (TypeError, ValueError):
        return None
    return signature.format(quote_annotation_strings=False)


members = {}
missing = []
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    for module_name in config["memberModules"]:
        module = importlib.import_module(module_name)
        listed = getattr(module, "__all__", None)
        names = sorted({n for n in (dir(module) if listed is None else listed) if not n.startswith("_")})
        entries = []
        for name in names:
            if not hasattr(module, name):
                missing.append(module_name + "." + name)
                continue
            value = getattr(module, name)
            kind = kind_of(name, value)
            entries.append([name, kind, signature_of(value) if kind in ("function", "class") else None])
        members[module_name] = {"all": listed is not None, "entries": entries}

modules = []
dropped = []
excluded = set(config["excluded"])
# For the log only: whether Pyodide has each hand-excluded module at all (never imported).
excluded_found = {name: importlib.util.find_spec(name) is not None for name in sorted(excluded)}
for name in sorted(sys.stdlib_module_names):
    if name.startswith("_") or name in excluded:
        continue
    try:
        spec = importlib.util.find_spec(name)
    except Exception as error:
        dropped.append([name, "find_spec fails in Pyodide: " + first_line(error)])
        continue
    if spec is None:
        dropped.append([name, "not in Pyodide (find_spec returns None)"])
        continue
    swallowed = io.StringIO()
    try:
        with contextlib.redirect_stdout(swallowed), contextlib.redirect_stderr(swallowed), warnings.catch_warnings():
            warnings.simplefilter("ignore")
            importlib.import_module(name)
    except BaseException as error:
        dropped.append([name, "import fails in Pyodide: " + first_line(error)])
        continue
    modules.append(name)

json.dumps({
    "python": sys.version.split()[0],
    "stdlib": sorted(sys.stdlib_module_names),
    "modules": modules,
    "dropped": dropped,
    "excluded_found": excluded_found,
    "members": members,
    "missing": missing,
})
`));
const seconds = ((performance.now() - started) / 1000).toFixed(1);

// ---------------------------------------------------------------- checks and output

/** Code-unit order: the same on every machine and locale (localeCompare is not). */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (message) => {
  throw new Error(`gen-python-completions: ${message}`);
};

const stdlib = new Set(raw.stdlib);
if (stdlib.has("test")) fail("sys.stdlib_module_names now lists test: add it to EXCLUDED");
for (const name of Object.keys(EXCLUDED)) if (!stdlib.has(name)) fail(`EXCLUDED names ${name}, which is not a standard-library module`);
for (const name of Object.keys(CUT)) if (!MEMBER_MODULES.includes(name)) fail(`CUT names ${name}, which is not in MEMBER_MODULES`);
if (raw.missing.length) fail(`names in __all__ that the module lacks: ${raw.missing.join(", ")}`);

const modules = [...raw.modules].sort(byCodeUnit);
for (const name of memberModules) if (!modules.includes(name.split(".")[0])) fail(`member module ${name} is not an importable module`);

/** CodeMirror completion types (https://codemirror.net/docs/ref/#autocomplete.Completion.type) the data may use. */
const KINDS = ["class", "constant", "function", "namespace", "variable"];
/** A default shown as an object address (`<object object at 0x1631018>`): meaningless to a reader. */
const ADDRESS = / at 0x[0-9a-fA-F]+>/;
const sortedObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => byCodeUnit(a, b)));

/**
 * Per module: kind -> name -> signature (null when there is none; always null for non-callables).
 * Signatures that are too long, span lines or show an object address are left out and listed in `leftOut`.
 */
function buildMembers(names, leftOut = []) {
  const keep = (module, label, signature) => {
    if (signature == null) return null;
    if (signature.includes("\n") || signature.length > MAX_SIGNATURE || ADDRESS.test(signature)) {
      leftOut.push(`${module}.${label}${signature}`);
      return null;
    }
    return signature;
  };
  const result = {};
  for (const name of [...names].sort(byCodeUnit)) {
    const groups = {};
    for (const [label, kind, signature] of raw.members[name].entries) {
      if (!KINDS.includes(kind)) fail(`${name}.${label} has kind ${kind}`);
      (groups[kind] ??= {})[label] = keep(name, label, signature);
    }
    result[name] = Object.fromEntries(Object.keys(groups).sort(byCodeUnit).map((kind) => [kind, sortedObject(groups[kind])]));
  }
  return result;
}

const leftOut = [];
const members = buildMembers(memberModules, leftOut);

const data = {
  header: { generator, pyodide: py.version, python: raw.python, note: "generated, do not edit" },
  modules,
  members,
};

/** One module per line under "members", so a Pyodide update shows up as a readable diff. */
function serialize(value) {
  const lines = [
    "{",
    `  "header": ${JSON.stringify(value.header)},`,
    `  "modules": ${JSON.stringify(value.modules)},`,
    `  "members": {`,
  ];
  const names = Object.keys(value.members);
  names.forEach((name, i) => lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(value.members[name])}${i < names.length - 1 ? "," : ""}`));
  lines.push("  }", "}");
  return lines.join("\n") + "\n";
}

const text = serialize(data);
for (let i = 0; i < text.length; i++) {
  if (text.charCodeAt(i) > 0x7e || (text.charCodeAt(i) < 0x20 && text[i] !== "\n")) fail(`non-ASCII or control character at offset ${i}`);
}
if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(data)) fail("the serialized file does not parse back to the data");

const bytes = Buffer.from(text, "utf8");
const gzipSize = (buffer) => gzipSync(buffer, { level: 9 }).length;
/** [names, names with a signature] in one module's groups. */
const counts = (groups) => {
  const values = Object.values(groups).flatMap((group) => Object.values(group));
  return [values.length, values.filter((s) => s !== null).length];
};
const [entryCount, withSignature] = Object.values(members).map(counts).reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);

console.log(`Pyodide ${py.version} (Python ${raw.python}) in ${seconds} s`);
console.log(`modules: ${modules.length} kept of ${raw.stdlib.filter((n) => !n.startsWith("_")).length} public names (${raw.stdlib.length} with private ones)`);
console.log(`members: ${entryCount} in ${memberModules.length} modules, ${withSignature} with a signature`);
console.log(`size: ${bytes.length} B raw, ${gzipSize(bytes)} B gzip -9`);
console.log("excluded by this generator:");
for (const [name, reason] of Object.entries(EXCLUDED)) console.log(`  ${name}: ${reason}${raw.excluded_found[name] ? "" : " (not in Pyodide either)"}`);
console.log("dropped by the Pyodide check:");
for (const [name, reason] of raw.dropped) console.log(`  ${name}: ${reason}`);
console.log("cut from members:");
for (const [name, reason] of Object.entries(CUT)) console.log(`  ${name}: ${reason}`);
if (!Object.keys(CUT).length) console.log("  (none)");
console.log(`signatures left out (over ${MAX_SIGNATURE} characters, several lines, or an object address): ${leftOut.length}`);
for (const s of leftOut) console.log(`  ${s}`);

if (report) {
  // A kept module's cost is what removing it saves; a cut module's is what adding it back would add.
  const full = gzipSize(bytes);
  const sizeWith = (names) => gzipSize(Buffer.from(serialize({ ...data, members: buildMembers(names) }), "utf8"));
  const line = (name, cost, note) => {
    const [count, signatures] = counts(buildMembers([name])[name]);
    const source = raw.members[name].all ? "__all__" : "dir()";
    return `  ${name.padEnd(12)} ${String(cost).padStart(5)} B  ${String(count).padStart(4)} names  ${String(signatures).padStart(4)} signatures  ${source}${note}`;
  };
  console.log("member modules by gzip cost (kept: the file's gzip size minus its size without the module):");
  const kept = memberModules.map((name) => [name, full - sizeWith(memberModules.filter((n) => n !== name))]);
  for (const [name, cost] of kept.sort((a, b) => b[1] - a[1])) console.log(line(name, cost, ""));
  for (const name of Object.keys(CUT)) console.log(line(name, sizeWith([...memberModules, name]) - full, "  (cut: the cost of adding it back)"));
}

const target = relative(root, outFile).split("\\").join("/");
if (check) {
  const current = await readFile(outFile).catch(() => null);
  if (current && Buffer.compare(current, bytes) === 0) {
    console.log(`${target} is up to date (${bytes.length} B, same bytes as a fresh run)`);
  } else {
    console.log(`${target} differs from a fresh run: run npm run gen:completions:python`);
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, bytes);
  console.log(`wrote ${target}`);
}
