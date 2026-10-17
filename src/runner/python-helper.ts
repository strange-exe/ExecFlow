// The Python side of a run, loaded into the worker's interpreter before the lockdown. Adapted from
// the ce_runner.py prototype (19 scenarios checked on CPython 3.14) and Pocket Run's RUNNER_PY.
//
// __ce_run(entry, cwd, unavailable_json) runs /workspace/<entry> as __main__ the way `cd <cwd> && python <entry>`
// would (sys.path[0] is the entry's folder; tracebacks show real file names and source lines),
// cleans up after it, and returns JSON:
//   {"exit", "interrupted", "recycle", "oom", "diagnostics": [...]}
// __ce_check(path, text) compiles text without running it and returns JSON diagnostics.
// __ce_imports(entry) lists the top-level non-standard imports of the entry and of the workspace
// modules it imports, by parsing only (no user code runs), so the runner can load packages first.
//
// Diagnostics: 1-based lines, 0-based UTF-16 columns (CodeMirror's unit), end exclusive,
// workspace-relative paths. Parser SyntaxErrors count code points, compiler-stage ones and
// co_positions count UTF-8 bytes; both are converted here with the source line in hand.
// Only "\n" splits lines (never str.splitlines, which also splits on form feeds and U+2028).
//
// String.raw keeps Python's backslashes as written; the code must not contain "${" or backticks.

export const RUNNER_PY = String.raw`
import ast, functools, gc, importlib, io, itertools, json, linecache, os, runpy, signal, sys, time, traceback, warnings

ROOT = "/workspace"
MAX_STACK = 50
MAX_SCAN = 2000
_config = {"imports": {}, "unavailable": set()}
_STDIN = {}


def _interruptible(sleep):
    """time.sleep waits inside C, where Stop and the time limit can't reach it (Pyodide only looks
    for an interrupt between bytecodes), so Python had to be restarted. This one sleeps in short
    slices. Odd or tiny values, and their errors, stay with the real sleep."""
    @functools.wraps(sleep)
    def interruptible_sleep(secs):
        if not isinstance(secs, (int, float)) or not 0.05 < secs < 1e9:
            return sleep(secs)
        end = time.monotonic() + secs
        while (left := end - time.monotonic()) > 0:
            sleep(min(left, 0.01))
    return interruptible_sleep


def __ce_configure(config_json):
    """imports: {top-level import name: package} for every package this build can load.
    Runs once per interpreter, before any user code."""
    _config.update(json.loads(config_json))
    _STDIN.update(encoding=sys.stdin.encoding, errors=sys.stdin.errors, line_buffering=sys.stdin.line_buffering)
    time.sleep = _interruptible(time.sleep)


def _fresh_stdin():
    """A new sys.stdin for each run, as a new python process would have: the last run's may still
    hold input it read ahead and never used (the next run would get it), or be closed. Same
    settings as the one Python started with (lines end at LF only, as in CPython on POSIX); fd 0
    stays open."""
    raw = io.FileIO(0, "r", closefd=False)
    raw.name = "<stdin>"
    stream = io.TextIOWrapper(io.BufferedReader(raw), newline="\n", **_STDIN)
    stream.mode = "r"
    return stream


def _quiet_parse(source, filename="<unknown>"):
    """ast.parse for our own scans, without the warnings it raises (invalid escapes...): the run
    reports those once, against the real file, and they must not print again as <unknown>."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return ast.parse(source, filename)


def _in_ws(path):
    if not isinstance(path, str) or not path or path.startswith("<"):
        return False
    full = os.path.abspath(path)
    return full == ROOT or full.startswith(ROOT + os.sep)


def _rel(path):
    if not _in_ws(path):
        return path
    return os.path.relpath(os.path.abspath(path), ROOT).replace(os.sep, "/")


def _fs_lines(path):
    return lambda n: linecache.getline(path, n).rstrip("\r\n") if n else ""


def _cp_to_utf16(line, cp):
    cp = max(0, min(cp, len(line)))
    return len(line[:cp].encode("utf-16-le", "surrogatepass")) // 2


def _bytes_to_utf16(line, b):
    head = line.encode("utf-8", "surrogatepass")[:max(0, b)]
    return _cp_to_utf16(line, len(head.decode("utf-8", "replace")))


def _whole_line(get, lineno):
    text = get(lineno)
    start = len(text) - len(text.lstrip())
    return _cp_to_utf16(text, start), _cp_to_utf16(text, len(text))


def _span(get, lineno, end_lineno, col, end_col, unit):
    """unit: "bytes" (co_positions, compiler-stage SyntaxError) or "chars" (parser SyntaxError)."""
    end_lineno = end_lineno or lineno
    line, end_line = get(lineno), get(end_lineno)
    conv = _bytes_to_utf16 if unit == "bytes" else _cp_to_utf16
    if col is None or col < 0:
        c0, c1 = _whole_line(get, lineno)
        return lineno, c0, lineno, c1
    c0 = conv(line, col)
    if end_col is None or end_col < 0 or (end_lineno, end_col) <= (lineno, col):
        # Unknown or empty end: mark one character, or a point at the end of the line.
        size = len(line.encode("utf-8", "surrogatepass")) if unit == "bytes" else len(line)
        c1 = conv(line, col + 1) if col < size else c0
        return lineno, c0, lineno, c1
    return lineno, c0, end_lineno, conv(end_line, end_col)


def _loc(path, span):
    l0, c0, l1, c1 = span
    return {"path": _rel(path), "line": l0, "col": c0, "endLine": l1, "endCol": c1}


def _diag(severity, path, span, message, code, stack=None):
    d = _loc(path, span)
    d.update(severity=severity, message=message, code=code)
    if stack:
        d["stack"] = stack
    return d


def _syntax_unit(e):
    """Parser errors carry code points; compiler-stage ones ('return' outside function...) carry
    UTF-8 bytes. If the file parses, the error came from the compiler."""
    try:
        with open(e.filename, "rb") as f:
            _quiet_parse(f.read(), e.filename)
    except Exception:
        return "chars"
    return "bytes"


def _syntax_diag(e, get, unit):
    lineno = e.lineno or 1
    if e.offset is None:
        c0, c1 = _whole_line(get, lineno)
        span = (lineno, c0, lineno, c1)
    else:
        end = None if e.end_offset is None or e.end_offset <= 0 else e.end_offset - 1
        span = _span(get, lineno, e.end_lineno, e.offset - 1, end, unit)
    return _diag("error", e.filename, span, f"{type(e).__name__}: {e.msg}", type(e).__name__)


def _strip_leading(tb):
    """Drops our own and runpy's frames: everything before the first workspace frame."""
    while tb is not None and not _in_ws(tb.tb_frame.f_code.co_filename):
        tb = tb.tb_next
    return tb


def _frames(tb):
    out = []
    while tb is not None:
        code = tb.tb_frame.f_code
        if _in_ws(code.co_filename):
            pos = (None, None, None, None)
            if tb.tb_lasti >= 0:
                pos = next(itertools.islice(code.co_positions(), tb.tb_lasti // 2, None), pos)
            lineno = pos[0] or tb.tb_lineno
            out.append(_loc(code.co_filename, _span(_fs_lines(code.co_filename), lineno, pos[1], pos[2], pos[3], "bytes")))
        tb = tb.tb_next
    return out[-MAX_STACK:]


def _relabel(te, seen=None):
    """Shows workspace files by their relative names, after loading their source lines."""
    seen = seen if seen is not None else set()
    if te is None or id(te) in seen:
        return
    seen.add(id(te))
    for fs in te.stack:
        fs.line  # loads the lines while the real path still resolves
        fs.filename = _rel(fs.filename)
    if getattr(te, "filename", None):
        te.filename = _rel(te.filename)
    _relabel(te.__cause__, seen)
    _relabel(te.__context__, seen)
    for sub in getattr(te, "exceptions", None) or ():
        _relabel(sub, seen)


def _find_in_workspace(top):
    """Workspace-relative paths of modules named top anywhere in the workspace."""
    found, scanned = [], 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames.sort()
        scanned += len(filenames) + len(dirnames)
        if top + ".py" in filenames:
            found.append(_rel(os.path.join(dirpath, top + ".py")))
        if top in dirnames:
            found.append(_rel(os.path.join(dirpath, top)) + "/")
        if found or scanned > MAX_SCAN:
            break
    return found


def _explain_missing(e):
    """Replaces Pyodide's micropip advice, which doesn't apply here, with what does."""
    top = (e.name or "").partition(".")[0]
    if not top or top in sys.stdlib_module_names or top in sys.modules:
        return  # a standard module Pyodide leaves out (its own note says so), or a missing submodule
    e.__notes__ = [n for n in (getattr(e, "__notes__", None) or []) if "micropip" not in n and "loadPackage" not in n]
    e._PYODIDE_ADDED_NOTE = True
    elsewhere = _find_in_workspace(top)
    here = _rel(sys.path[0]) if sys.path and _in_ws(sys.path[0]) else "."
    if elsewhere:
        folder = "the workspace's top folder" if here == "." else here + "/"
        e.add_note(f"The workspace has {elsewhere[0]}, but Python only finds modules in the folder of the file you run ({folder}).")
    elif _config["imports"].get(top) in _config["unavailable"]:
        e.add_note(f"{top} is available, but it couldn't be loaded this session. Check the connection, then restart Python and run again.")
    elif top in _config["imports"]:
        e.add_note(f"{top} is available, but it wasn't loaded for this run. It is loaded when a file of the program has 'import {top}' or 'from {top} import ...'; imports made through importlib or __import__ can't be seen ahead of time.")
    else:
        available = ", ".join(sorted(_config["imports"]))
        e.add_note(f"No {top}.py is next to the file you run, and CodeEditor can't install packages. "
                   + (f"Besides the standard library, programs can import: {available}." if available else "Programs can import the standard library."))


def _report(e):
    """Prints a CPython-style traceback without our frames; returns the diagnostics."""
    if isinstance(e, ModuleNotFoundError):
        _explain_missing(e)
    tb = _strip_leading(e.__traceback__)
    te = traceback.TracebackException(type(e), e, tb, compact=True)
    _relabel(te)
    sys.stderr.write("".join(te.format(colorize=False)))
    frames = _frames(tb)
    if isinstance(e, SyntaxError) and _in_ws(e.filename):
        d = _syntax_diag(e, _fs_lines(e.filename), _syntax_unit(e))
        if frames:  # an imported module failed to compile: the import chain, then the error
            d["stack"] = frames + [{k: d[k] for k in ("path", "line", "col", "endLine", "endCol")}]
        return [d]
    # From the same TracebackException: it keeps "Did you mean" suggestions and add_note() notes.
    message = "".join(te.format_exception_only(colorize=False)).rstrip()
    if not frames:
        return [{"severity": "error", "path": None, "line": 1, "message": message, "code": type(e).__name__}]
    last = dict(frames[-1])
    last.update(severity="error", message=message, code=type(e).__name__, stack=frames)
    return [last]


def _forget_workspace_modules():
    """Removes every module loaded from the workspace, and finders cached for its folders.
    Returns the removed names that shadow a standard or package module."""
    shadowed = []
    for name, mod in list(sys.modules.items()):
        files = [getattr(mod, "__file__", None)]
        try:
            files += list(getattr(mod, "__path__", None) or [])
        except Exception:
            pass
        if any(_in_ws(f) for f in files if isinstance(f, str)):
            top = name.partition(".")[0]
            if top in sys.stdlib_module_names or top in _config["imports"]:
                shadowed.append(name)
            del sys.modules[name]
    for key in list(sys.path_importer_cache):
        if _in_ws(key):
            del sys.path_importer_cache[key]
    importlib.invalidate_caches()
    return shadowed


def _imports_of(path):
    """Top-level names a file imports, by parsing it (like pyodide.code.find_imports)."""
    try:
        with open(path, "rb") as f:
            tree = _quiet_parse(f.read())
    except Exception:  # SyntaxError, null bytes, nesting too deep...: nothing to scan
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.partition(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module.partition(".")[0])
    return names


def _local_module(base, top):
    """The files of workspace module top next to the entry: [top.py], every .py in top/, or None."""
    f = os.path.join(base, top + ".py")
    if os.path.isfile(f):
        return [f]
    d = os.path.join(base, top)
    if not os.path.isdir(d):
        return None
    out = []
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames.sort()
        out += [os.path.join(dirpath, n) for n in sorted(filenames) if n.endswith(".py")]
        if len(out) > MAX_SCAN:
            break
    return out


def _program_imports(entry_path):
    """(names imported from outside the workspace, {workspace module: its files}) for the entry and
    the workspace modules it imports, transitively."""
    base = os.path.dirname(entry_path)
    todo, seen, outside, local = [entry_path], set(), set(), {}
    while todo and len(seen) < MAX_SCAN:
        path = todo.pop()
        if path in seen:
            continue
        seen.add(path)
        for top in sorted(_imports_of(path)):
            if top in outside or top in local:
                continue
            files = _local_module(base, top)
            if files is None:
                outside.add(top)
            else:
                local[top] = files
                todo.extend(files)
    return outside, local


def __ce_imports(entry):
    outside, _ = _program_imports(os.path.join(ROOT, *entry.split("/")))
    return json.dumps(sorted(n for n in outside if n not in sys.stdlib_module_names))


def _shadow_warnings(entry_path):
    """A workspace module named like a standard (or package) module behaves differently here than
    in a fresh python: if the real one is already imported, it wins."""
    out = []
    try:
        _, local = _program_imports(entry_path)
    except Exception:
        return out
    base = os.path.dirname(entry_path)
    for name, files in sorted(local.items()):
        if files and (name in sys.stdlib_module_names or name in _config["imports"]):
            label = f"{name}.py" if files[0] == os.path.join(base, name + ".py") else f"The folder {name}/"
            c0, c1 = _whole_line(_fs_lines(files[0]), 1)
            out.append(_diag("warning", files[0], (1, c0, 1, c1),
                             f"{label} has the same name as Python's {name} module, so 'import {name}' can load either one. Rename it.",
                             "shadowed-module"))
    return out


def __ce_run(entry, cwd, unavailable_json="[]"):
    """unavailable_json: packages that failed to load this session (for the ModuleNotFoundError note)."""
    _config["unavailable"] = set(json.loads(unavailable_json))
    entry_path = os.path.join(ROOT, *entry.split("/"))
    diagnostics = _shadow_warnings(entry_path)
    saved = (sys.path[:], sys.argv[:], os.getcwd(), sys.stdin, sys.stdout, sys.stderr,
             sys.getrecursionlimit(), dict(os.environ), sys.__stdin__)
    exit_code, interrupted, recycle, oom = 0, False, False, False
    signal.signal(signal.SIGINT, signal.default_int_handler)  # a previous run may have replaced it
    linecache.clearcache()  # it compares only size and mtime: a same-size edit would show stale lines
    _forget_workspace_modules()
    stdin = sys.stdin = sys.__stdin__ = _fresh_stdin()
    sys.dont_write_bytecode = True
    sys.path[:] = [os.path.dirname(entry_path)] + [p for p in saved[0] if p not in ("", ".")]
    sys.argv[:] = [entry]
    os.chdir(os.path.join(ROOT, *cwd.split("/")) if cwd else ROOT)
    with warnings.catch_warnings():
        shown = warnings.showwarning

        def showwarning(message, category, filename, lineno, file=None, line=None):
            if _in_ws(filename):
                diagnostics.append(_diag("warning", filename, _span(_fs_lines(filename), lineno, None, None, None, "chars"),
                                         f"{category.__name__}: {message}", category.__name__))
            # The relative name can't be looked up from every cwd: hand over the source line.
            shown(message, category, _rel(filename), lineno, file,
                  line if line is not None else _fs_lines(filename)(lineno).strip())

        warnings.showwarning = showwarning
        try:
            runpy.run_path(entry_path, run_name="__main__")
        except SystemExit as e:
            if e.code is None:
                exit_code = 0
            elif isinstance(e.code, int):
                exit_code = e.code
            else:
                print(e.code, file=sys.stderr)
                exit_code = 1
        except KeyboardInterrupt as e:
            exit_code, interrupted = 130, True
            frames = _frames(_strip_leading(e.__traceback__))
            if frames:
                last = dict(frames[-1])
                last.update(severity="info", message="The program was stopped here.", code="KeyboardInterrupt", stack=frames)
                diagnostics.append(last)
        except BaseException as e:
            exit_code = 1
            oom = recycle = isinstance(e, MemoryError)
            try:
                diagnostics += _report(e)
            except KeyboardInterrupt:  # Stop pressed while the error was being reported
                exit_code, interrupted = 130, True
            except MemoryError:
                oom = recycle = True
        finally:
            # A Stop or timeout landing now must not cut the clean-up short (Pyodide drops an ignored SIGINT).
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:
                    pass
            (sys.path[:], sys.argv[:], cwd0, sys.stdin, sys.stdout, sys.stderr, limit, env, sys.__stdin__) = saved
            try:
                stdin.close()  # this run's; fd 0 stays open (closefd=False)
            except Exception:
                pass
            os.chdir(cwd0)
            sys.setrecursionlimit(limit)
            os.environ.clear()
            os.environ.update(env)
            if _forget_workspace_modules():
                recycle = True  # a workspace file replaced a standard module that others may now hold
            gc.collect()  # closes (and flushes) files the program left open, so they can be reported
            if sys.__stdout__ is None or sys.__stdout__.closed or sys.__stderr__.closed:
                recycle = True  # the program closed the real streams: nothing would print next time
            signal.signal(signal.SIGINT, signal.default_int_handler)
    return json.dumps({"exit": exit_code, "interrupted": interrupted, "recycle": recycle, "oom": oom,
                       "diagnostics": diagnostics}, ensure_ascii=False)


def __ce_check(path, text):
    full = os.path.join(ROOT, *path.split("/"))
    lines = text.split("\n")
    get = lambda n: lines[n - 1] if 0 < n <= len(lines) else ""
    out = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        phase = "parse"
        try:
            tree = compile(text, full, "exec", ast.PyCF_ONLY_AST, dont_inherit=True)
            phase = "compile"
            compile(tree, full, "exec", dont_inherit=True)
        except SyntaxError as e:
            if e.filename == full:
                out.append(_syntax_diag(e, get, "chars" if phase == "parse" else "bytes"))
        except Exception:  # nesting too deep, null bytes, out of memory: nothing to mark
            pass
    seen = set()
    for w in caught:
        key = (w.lineno, str(w.message))
        if w.filename == full and w.lineno and key not in seen:
            seen.add(key)
            c0, c1 = _whole_line(get, w.lineno)
            out.append(_diag("warning", full, (w.lineno, c0, w.lineno, c1), f"{w.category.__name__}: {w.message}", w.category.__name__))
    return json.dumps(out, ensure_ascii=False)
`;
