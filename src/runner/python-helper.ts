// The Python side of a run, loaded into the worker's interpreter before the lockdown. Adapted from
// the ce_runner.py prototype (19 scenarios checked on CPython 3.14) and Pocket Run's RUNNER_PY.
//
// __ce_run(entry, cwd, unavailable_json, args_json) runs /workspace/<entry> as __main__ the way
// `cd <cwd> && python <entry> <args...>` would (sys.argv is the script's path, then the arguments: runpy
// sets argv[0] to "/workspace/<entry>"; sys.path[0] is the entry's folder; tracebacks show real file
// names and source lines), cleans up after it, and returns JSON:
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
import ast, functools, gc, importlib, io, itertools, json, linecache, os, runpy, signal, sys, time, traceback, types, warnings

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
        e.add_note(f"No {top}.py is next to the file you run, and ExecFlow can't install packages. "
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


# The run trace (the flowchart's "path of the last run"): the lines the run file's own functions and
# top level execute, one (call, line) pair per line event. Stops after TRACE_STEPS lines, so a long
# loop pays for the first part only; the trace then says it is partial.
TRACE_STEPS = 50000
_CO_OPTIMIZED = 0x1
_CO_SKIP = 0x20 | 0x80 | 0x100 | 0x200  # generators and coroutines: each resume would look like a fresh call
_TRACE = {}

# Variable values for stepping through a run: at each traced event, the call's simple variables
# (numbers, strings, None, and short lists, tuples, sets and dicts of them) as short one-line texts,
# recorded as changes only. Only built-in types are formatted, by their own C methods, so the
# program's own __repr__, __str__, __eq__, __hash__ or metaclass never runs here (it could print,
# loop or raise); any other object is "<ClassName>". Functions, classes, modules and names starting
# with "__" are left out. The texts stop at VALUE_BUDGET (the trace then says where: "cut").
# Cost: each event re-reads only the names already shown (a full scan only when the number of names
# changes or one went away), and numbers and strings are kept as they are and written out once,
# after the run (they can't change); only containers are written out at the event.
TRACE_VALUES = True
# Events with values: reading them costs more per line than the line trace itself (about 3 us an
# event in Pyodide), so a long run pays for its start only, as with TRACE_STEPS.
VALUE_STEPS = 10000
VALUE_BUDGET = 2000000  # characters of names and texts (+8 each) and 12 per change
VALUE_TEXT = 40
VALUE_RECORDS = 600000  # changes kept during the run (each holds its value until the run ends)
_ELL = chr(0x2026)
_BIG_INT = 1 << 128  # a longer int is described (str() of a huge int is slow, or refused)
_TYPE_NAME = type.__dict__["__name__"]
_MUT = object()  # prev's object for values compared by their text (containers, other objects)
_GONE = object()  # a record's value when the name went away


def _vtype(t):
    """<ClassName>, read past the metaclass (it could define __name__)."""
    try:
        name = _TYPE_NAME.__get__(t, type)
    except Exception:
        name = ""
    return "<" + (name[:30] if type(name) is str and name.isidentifier() else "object") + ">"


def _vtext(v, depth=0):
    f = _VFMT.get(id(type(v)))
    return f(v, depth) if f is not None else _vtype(type(v))


def _vitems(items, depth, pairs=False):
    """The items' texts, stopping once past VALUE_TEXT (the rest would be cut anyway)."""
    out, size = [], 0
    for x in items:
        s = _vtext(x[0], depth + 1) + ": " + _vtext(x[1], depth + 1) if pairs else _vtext(x, depth + 1)
        out.append(s)
        size += len(s) + 2
        if size > VALUE_TEXT:
            break
    return ", ".join(out)


def _vint(v, depth):
    if -_BIG_INT < v < _BIG_INT:
        return int.__repr__(v)
    return "<int, about " + str(int((int.bit_length(v) - 1) * 0.30103) + 1) + " digits>"


def _vseq(start, end, empty):
    def fmt(v, depth):
        if not v:
            return empty
        if depth >= 2:
            return start + _ELL + end
        return start + _vitems(dict.items(v) if type(v) is dict else v, depth, type(v) is dict) + end
    return fmt


_vtuple_items = _vseq("(", ")", "()")


def _vtuple(v, depth):
    if len(v) == 1 and depth < 2:
        return "(" + _vtext(v[0], depth + 1) + ",)"
    return _vtuple_items(v, depth)


def _vcut(text):
    return text if len(text) <= VALUE_TEXT else text[:VALUE_TEXT - 1] + _ELL


def _vput(name, v, t, e, at, rec):
    """Records v as name's value at event at when it differs from e (prev's entry, updated).
    Numbers and strings go in as they are (a long string cut, a huge int described); anything else
    as its text in a 1-tuple, and only when the text changed."""
    if id(t) in _VSAME:
        e[0] = v
        e[1] = None
        if t is str:
            if len(v) > VALUE_TEXT:
                v = v[:VALUE_TEXT + 1]
        elif t is int and not -_BIG_INT < v < _BIG_INT:
            v = (_vint(v, 0),)
        rec += (at, name, v)
        return
    look = None
    if id(t) in _VNEST:
        look = _vlook(v, t)
        if look is not None and e[0] is _MUT and look == e[3]:
            return  # the same items as last time: the same text
    f = _VFMT.get(id(t))
    text = _vcut(f(v, 0) if f is not None else _vtype(t))
    e[0] = _MUT
    e[3] = look
    if e[1] != text:
        e[1] = text
        rec += (at, name, (text,))


def _vids(v, t):
    """What a container's text can show, cheaply (C calls only): its type, size and the ids of its
    first items (and keys). An id is only compared, never kept as a reference."""
    if t is list or t is tuple:
        return (id(t), len(v), tuple(map(id, v[:_VLOOK])))
    if t is dict:
        return (id(t), len(v), tuple(map(id, itertools.islice(dict.keys(v), _VLOOK))),
                tuple(map(id, itertools.islice(dict.values(v), _VLOOK))))
    return (id(t), len(v), tuple(map(id, itertools.islice(v, _VLOOK))))


def _vlook(v, t):
    """_vids, or None when one of those first items is a container (its own items could change)."""
    items = itertools.islice(dict.values(v) if t is dict else v, _VLOOK)
    return _vids(v, t) if _VNEST.isdisjoint(map(id, map(type, items))) else None


def _vhidden(t):
    """Functions, classes, modules and the like: not variables to show."""
    return id(t) in _VSKIP or issubclass(t, type)


def _vscan(loc, st, at, rec):
    """Records the values in loc (a frame's f_locals) that changed at event at into rec, as (event,
    name, value) triples: every name, new ones in the frame's order, and names gone. The trace's
    snap() re-reads only the names already shown, and calls this when the number of names changed
    or one went away. st, per call: [prev {name: [object (_VSAME types) or _MUT, text or None, last
    full scan, _vlook of a container]}, names never shown, {name: function, class or module},
    number of names]. The
    objects kept are numbers and strings only: holding anything else could change when the
    program's objects are freed (a __del__ that prints)."""
    prev, never, objs = st[0], st[1], st[2]
    objs.clear()
    for name, v in loc.items():
        if type(name) is not str or name in never:  # hashing any other key could run the program's __hash__
            continue
        e = prev.get(name)
        if e is None and (name[:2] == "__" or not name.isidentifier()):
            never.add(name)
            continue
        t = type(v)
        if id(t) not in _VSAME and _vhidden(t):
            objs[name] = v
            continue  # a shown name that became a function goes away below
        if e is None:
            e = prev[name] = [_MUT, None, at, None]
            _vput(name, v, t, e, at, rec)
            continue
        e[2] = at
        old = e[0]
        if v is not old and not (t is type(old) and v == old):
            _vput(name, v, t, e, at, rec)
    for name in [n for n, e in prev.items() if e[2] != at]:
        del prev[name]
        rec += (at, name, _GONE)
    st[3] = len(loc)


def _vfinish(rec, cut):
    """The run's records as [names, texts, (event, name, text or -1) int32s, cut], within
    VALUE_BUDGET (past it, the values stop at that event: cut)."""
    from array import array
    names, texts, nix, tix, ni, ti = [], [], {}, {}, [], []
    budget = VALUE_BUDGET
    ats, keys, vals = rec[0::3], rec[1::3], rec[2::3]
    ints = int.__repr__  # ints in the records are short ones (_vput describes the others)
    n = len(vals)
    for k in range(n):
        v = vals[k]
        t = type(v)
        if t is int:
            text = ints(v)
        elif t is tuple:
            text = v[0]
        elif v is _GONE:
            text = None
        else:
            try:
                text = _vcut(_VFMT[id(t)](v, 0))
            except Exception:
                text, budget = None, -1  # stops here, as past the budget
        name = keys[k]
        i = nix.get(name)
        j = -1 if text is None else tix.get(text)
        cost = 12 + (len(name) + 8 if i is None else 0) + (len(text) + 8 if j is None else 0)
        if cost > budget:
            cut = ats[k]
            n = k
            while n and ats[n - 1] == cut:  # this event's changes would be part only
                n -= 1
            break
        budget -= cost
        if i is None:
            i = nix[name] = len(names)
            names.append(name)
        if j is None:
            j = tix[text] = len(texts)
            texts.append(text)
        ni.append(i)
        ti.append(j)
    flat = [0] * (3 * n)
    flat[0::3] = ats[:n]
    flat[1::3] = ni[:n]
    flat[2::3] = ti[:n]
    return names, texts, array("i", flat), cut


_VFMT = {
    id(int): _vint,
    id(bool): lambda v, depth: "True" if v is True else "False",
    id(float): lambda v, depth: float.__repr__(v),
    id(complex): lambda v, depth: complex.__repr__(v),
    id(type(None)): lambda v, depth: "None",
    id(str): lambda v, depth: str.__repr__(v[:VALUE_TEXT + 1]),
    id(list): _vseq("[", "]", "[]"),
    id(tuple): _vtuple,
    id(set): _vseq("{", "}", "set()"),
    id(frozenset): _vseq("frozenset({", "})", "frozenset()"),
    id(dict): _vseq("{", "}", "{}"),
}
# Values whose text can only change with the object: the same object means the same text.
_VSAME = {id(int), id(bool), id(float), id(complex), id(type(None)), id(str)}
# Containers, and how many of their first items _vlook checks (more than a VALUE_TEXT text can show).
_VNEST = {id(list), id(tuple), id(set), id(frozenset), id(dict)}
_VLOOK = 16
_VSKIP = {id(t) for t in (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType,
                          types.MethodWrapperType, types.WrapperDescriptorType, types.MethodDescriptorType,
                          staticmethod, classmethod, property, functools.partial)}


def _trace_start(path):
    from array import array
    events = array("i")
    calls = array("i")
    index = {}
    codes = []
    add = events.append
    left = TRACE_STEPS
    _TRACE.clear()
    _TRACE.update(codes=codes, calls=calls, events=events, partial=False)
    # Values: (event, name, value) triples, written out by __ce_trace (_vfinish).
    rec = []
    valued = TRACE_VALUES
    if valued:
        _TRACE.update(values=rec, vcut=None)

    def cut():
        _TRACE["partial"] = True
        sys.settrace(None)  # no more events at all: the rest of the run is as fast as untraced

    put = rec.extend
    most = 3 * VALUE_RECORDS

    def stop_values(at):
        """Values stop at event at (an error, or past VALUE_RECORDS); the line trace goes on."""
        nonlocal valued
        valued = False
        _TRACE["vcut"] = at
        while rec and rec[-3] == at:  # this event's changes are part only: dropped
            del rec[-3:]

    def on_call(frame, event, arg):
        code = frame.f_code
        if left <= 0 or code.co_filename != path:
            return None
        # The top level, and functions with a chart (no lambdas, comprehensions or nested functions).
        if code.co_name != "<module>" and not (code.co_flags & _CO_OPTIMIZED and "<" not in code.co_qualname):
            return None
        at = index.get(code)
        if at is None:
            at = index[code] = len(codes)
            # A generator or coroutine is named (it ran) but not traced: [name, first line, untraced].
            codes.append([code.co_qualname, code.co_firstlineno, bool(code.co_flags & _CO_SKIP)])
        if codes[at][2]:
            return None
        serial = len(calls)
        calls.append(at)
        raised = False
        st = [{}, set(), {}, -1]  # this call's values (_vscan)
        prev, objs = st[0], st[2]

        def on_event(frame, event, arg):
            nonlocal left, raised
            if event == "line":
                if left <= 0:
                    return cut()
                left -= 1
                n = len(events) >> 1
                add(serial)
                add(frame.f_lineno)
                raised = False
            elif event == "return":
                n = len(events) >> 1
                add(serial)
                add(-2 if raised else -1)
            else:
                if event == "exception":
                    raised = True
                return on_event
            if not valued:
                return on_event
            if n >= VALUE_STEPS:
                stop_values(n)
                return on_event
            # The values at this event. Written out here, as this runs on every line: only the
            # names already shown are read again; _vscan reads them all when the number of names
            # changed, a name went away or became a function, or a function's name changed.
            try:
                loc = frame.f_locals
                full = len(loc) != st[3]
                if not full:
                    get = loc.get
                    for name, e in prev.items():
                        v = get(name, _GONE)
                        old = e[0]
                        if v is old:
                            continue
                        t = type(v)
                        if t is int and -_BIG_INT < v < _BIG_INT:  # the common case
                            if type(old) is not int or v != old:
                                e[0] = v
                                e[1] = None
                                put((n, name, v))
                        elif id(t) in _VNEST:  # unchanged first items: the same text (_vlook)
                            look = e[3]
                            if look is None or old is not _MUT or _vids(v, t) != look:
                                _vput(name, v, t, e, n, rec)
                        elif v is _GONE or (id(t) not in _VSAME and _vhidden(t)):
                            full = True
                            break
                        elif not (t is type(old) and v == old):  # not equal numbers or strings
                            _vput(name, v, t, e, n, rec)
                    if not full:
                        for name, h in objs.items():
                            if get(name, _GONE) is not h:
                                full = True
                                break
                if full:
                    _vscan(loc, st, n, rec)
                if len(rec) > most:
                    stop_values(n)
            except Exception:
                stop_values(n)
            return on_event

        return on_event

    return on_call


def __ce_trace():
    """The last run's trace: [meta JSON, calls as int32 bytes, events as int32 bytes], then, when
    values were recorded, [values JSON {"names", "texts", "cut"}, (event, name, text) int32 bytes].
    None when there is none."""
    if not _TRACE:
        return None
    out = [json.dumps({"codes": _TRACE["codes"], "partial": _TRACE["partial"]}, ensure_ascii=False),
           _TRACE["calls"].tobytes(), _TRACE["events"].tobytes()]
    if "values" in _TRACE:
        names, texts, deltas, cut = _vfinish(_TRACE["values"], _TRACE["vcut"])
        out += [json.dumps({"names": names, "texts": texts, "cut": cut}, ensure_ascii=False), deltas.tobytes()]
    _TRACE.clear()
    return out


def __ce_run(entry, cwd, unavailable_json="[]", args_json="[]", trace=False):
    """unavailable_json: packages that failed to load this session (for the ModuleNotFoundError note).
    args_json: the command-line arguments, a JSON list of strings (anything else is left out).
    trace: record the run trace (__ce_trace reads it)."""
    _TRACE.clear()
    _config["unavailable"] = set(json.loads(unavailable_json))
    args = json.loads(args_json)
    args = [a for a in args if isinstance(a, str)] if isinstance(args, list) else []
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
    sys.argv[:] = [entry] + args
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
            tracer = _trace_start(entry_path) if trace else None
            if tracer:
                sys.settrace(tracer)
            try:
                runpy.run_path(entry_path, run_name="__main__")
            finally:
                sys.settrace(None)
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
