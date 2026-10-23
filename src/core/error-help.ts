// Plain-language help for the errors beginners meet most (DESIGN.md, error help): a bundled table,
// no network and no AI. Each entry matches the first line of one message shape exactly as the real
// runtime prints it (Pyodide 314's CPython, clang and wasm-ld 8, this app's crash words; every entry
// has a captured message in __fixtures__/error-help.json and a unit test), says what it means with
// the specifics filled in from that message, and names one or two things to check. Pure and loaded
// lazily with the view that draws it (ui/error-help-view.ts), so a first visit never carries it.
//
// The message is untrusted (a program can raise any text): fill-in values are cut to a short,
// single-line piece and are only ever drawn as text.

import type { DiagSeverity, DiagSource } from "./types";

/** What the help reads from a diagnostic (a ToolDiagnostic has all of it). */
export interface HelpSubject {
  source: DiagSource;
  severity: DiagSeverity;
  message: string;
  code?: string;
  notes?: readonly { message: string }[];
  role?: "call-site";
}

/** A piece of help text: words, or code (a name, a value or a snippet) drawn in the code font. */
export type HelpPart = { text: string } | { code: string };

export interface ErrorHelp {
  /** The table entry (stable: tests and the Problems list's once-per-kind rule use it). */
  id: string;
  /** What the message means, with its specifics. */
  means: HelpPart[];
  /** One or two things to check or try. */
  tips: HelpPart[];
}

type Fill = Record<string, string>;

interface Entry {
  id: string;
  sources: readonly DiagSource[];
  /** Tested against the message's first line; its named groups are the fill-in values. */
  match: RegExp;
  /** Further conditions (null skips the entry) and computed values. `rest` is every other line. */
  more?: (fill: Fill, rest: readonly string[]) => Fill | null;
  /**
   * Templates: `code` is a literal snippet in the code font, {key} a value from the message in
   * the code font, {~key} a value from the message as plain words.
   */
  means: string;
  tips: string;
}

const PY: readonly DiagSource[] = ["python"];
const CC: readonly DiagSource[] = ["clang"];

/** The other lines (Python's added notes, clang's notes) that contain `re`, as its match. */
const findIn = (rest: readonly string[], re: RegExp) => rest.map((l) => re.exec(l)).find((m) => m !== null) ?? null;

/** clang's notes name exactly one candidate function (none, or several overloads, say less). */
const oneCandidate = (rest: readonly string[]) => rest.filter((l) => /\bcandidate (?:function|template|constructor)\b/.test(l)).length === 1;

const CLOSE: Fill ={ "(": ")", "[": "]", "{": "}" };
const OPEN: Fill = { ")": "(", "]": "[", "}": "{" };

const ENTRIES: readonly Entry[] = [
  // ---------------------------------------------------------------- Python: names
  {
    id: "py-name-import", sources: PY,
    match: /^NameError: name '(?<name>[^']+)' is not defined\. Did you forget to import '(?<module>[^']+)'\?$/,
    more: (f) => ({ importLine: `import ${f.module}` }),
    means: "Python doesn't know {name} here. It is the name of a module, and a file has to import a module before using it.",
    tips: "Add {importLine} at the top of the file, above the first line that uses it.",
  },
  {
    id: "py-name-suggest", sources: PY,
    match: /^NameError: name '(?<name>[^']+)' is not defined\. Did you mean: '(?<suggestion>[^']+)'\?$/,
    means: "Python doesn't know a name {name} at this point. It suggests {suggestion}, a name it does know that is spelled alike.",
    tips: "Check the spelling and the capital letters. If {name} is a new variable, give it a value on a line that runs before this one.",
  },
  {
    id: "py-name", sources: PY,
    match: /^NameError: name '(?<name>[^']+)' is not defined$/,
    means: "Python doesn't know a name {name} at this point in the program.",
    tips: "Check the spelling, and that {name} gets a value (or is imported) on a line that runs before this one. If you meant it as text, put it in quotes.",
  },
  {
    id: "py-unbound-local", sources: PY,
    match: /^UnboundLocalError: cannot access local variable '(?<name>[^']+)' where it is not associated with a value$/,
    means: "This function gives {name} a value somewhere, so Python treats {name} as the function's own (local) variable, but this line uses it before that happens.",
    tips: "Give {name} a value inside the function before using it, or pass it in as a parameter and return the new value.",
  },

  // ---------------------------------------------------------------- Python: types and calls
  {
    id: "py-concat-str", sources: PY,
    match: /^TypeError: can only concatenate str \(not "(?<type>[^"]+)"\) to str$/,
    means: "This line uses `+` to join text (a str) to a value of type {type}, but `+` only joins text to text.",
    tips: "Turn the value into text first with `str(...)`, or give print the values separated by commas, which needs no conversion.",
  },
  {
    id: "py-operand-none", sources: PY,
    match: /^TypeError: unsupported operand type\(s\) for (?<op>.+?): '(?<a>[^']+)' and '(?<b>[^']+)'$/,
    more: (f) => (f.a === "NoneType" || f.b === "NoneType" ? {} : null),
    means: "One side of {op} is None (no value), and Python can't use {op} with it. A function without a return statement gives None.",
    tips: "Check where that value came from. If it is a function's result, make the function end with `return` and the value.",
  },
  {
    id: "py-operand-str", sources: PY,
    match: /^TypeError: unsupported operand type\(s\) for (?<op>.+?): '(?<a>[^']+)' and '(?<b>[^']+)'$/,
    more: (f) => (f.a === "str" || f.b === "str" ? {} : null),
    means: "Python can't use {op} between {a} and {b} values: text (str) and numbers don't mix.",
    tips: "A number read with `input()` is still text: convert it with `int(...)` or `float(...)` first. To join text, turn the number into text with `str(...)`.",
  },
  {
    id: "py-operand", sources: PY,
    match: /^TypeError: unsupported operand type\(s\) for (?<op>.+?): '(?<a>[^']+)' and '(?<b>[^']+)'$/,
    means: "Python can't use {op} between {a} and {b} values.",
    tips: "Check what each side holds just before this line, for example with `print(type(...))`. One of them may not be the type you expect.",
  },
  {
    // A method defined without self: Python passes the object as one value more than the def lists.
    id: "py-args-self", sources: PY,
    match: /^TypeError: (?<fn>[A-Za-z_]\w*\.(?<method>[A-Za-z_]\w*))\(\) takes (?<want>\d+) positional arguments? but (?<got>\d+) (?:was|were) given$/,
    more: (f) => (Number(f.got) === Number(f.want) + 1 ? { defLine: `def ${f.method}(self${f.want === "0" ? "" : ", ..."}):` } : null),
    means: "{fn}() gets one value more than its def line lists. When a method is called on an object, Python passes the object itself as the first value.",
    tips: "Add self as the first parameter of the method in the class: {defLine}",
  },
  {
    id: "py-args-many", sources: PY,
    match: /^TypeError: (?<fn>.+?)\(\) takes (?<want>\d+|from \d+ to \d+) positional arguments? but (?<got>\d+) (?:was|were) given$/,
    means: "This call gives {fn}() more values ({~got}) than its def line takes ({~want}).",
    tips: "Compare the call with the def line: each value needs its own parameter. Remove the extra value, or add a parameter for it.",
  },
  {
    id: "py-args-missing", sources: PY,
    match: /^TypeError: (?<fn>.+?)\(\) missing \d+ required (?:positional|keyword-only) arguments?: (?<names>.+)$/,
    means: "This call to {fn}() gives no value for {names}, which its def line asks for.",
    tips: "Add the missing value to the call, in the order the def line lists the parameters, or give that parameter a default value in the def line.",
  },
  {
    id: "py-not-callable", sources: PY,
    match: /^TypeError: '(?<type>[^']+)' object is not callable$/,
    means: "This line puts `( )` after a value of type {type}, as if it were a function.",
    tips: "Check for a missing operator, like `2(x + 1)` where `2 * (x + 1)` was meant, or a variable that reuses a function's name (such as `sum = 0` or `list = [...]`).",
  },
  {
    id: "py-index-type", sources: PY,
    match: /^TypeError: (?<kind>list|tuple|string) indices must be integers(?: or slices)?, not (?<type>.+)$/,
    means: "A position in a {~kind} must be a whole number (an int), but this one is a {type}.",
    tips: "If the number came from `input()`, convert it with `int(...)` first. To look values up by a name, use a dictionary instead.",
  },

  // ---------------------------------------------------------------- Python: values
  {
    id: "py-index-assign", sources: PY,
    match: /^IndexError: list assignment index out of range$/,
    means: "The program stores a value at a position the list doesn't have yet. A list only grows when something is added to it.",
    tips: "To add an item at the end, use `.append(...)`. To change an item, its position must be below `len(...)`.",
  },
  {
    id: "py-index", sources: PY,
    match: /^IndexError: (?<kind>list|string|tuple|range object) index out of range$/,
    means: "The program asks for a position the {~kind} doesn't have.",
    tips: "Positions start at 0, so the last one is `len(...) - 1`. Check the loop's limits, or print the index and the length just before this line.",
  },
  {
    id: "py-key", sources: PY,
    match: /^KeyError: (?<key>.+)$/,
    means: "The program looks up the key {key}, and the dictionary doesn't have it.",
    tips: "Check the spelling and the type: `'1'` (text) and `1` (a number) are different keys. To check first, use `key in d`; `d.get(key)` gives None instead of an error.",
  },
  {
    id: "py-int-literal", sources: PY,
    match: /^ValueError: invalid literal for int\(\) with base \d+: (?<text>.+)$/,
    means: "`int()` was given the text {text}, which isn't a whole number.",
    tips: "If it came from `input()`, check what was typed: letters, inner spaces and empty answers don't convert. For a number with a decimal point, use `float(...)`.",
  },
  {
    id: "py-float-literal", sources: PY,
    match: /^ValueError: could not convert string to float: (?<text>.+)$/,
    means: "`float()` was given the text {text}, which isn't a number.",
    tips: "If it came from `input()`, check what was typed: digits with at most one decimal point, like `3.5`. Words don't convert.",
  },
  {
    id: "py-zero-division", sources: PY,
    match: /^ZeroDivisionError: .*\bby zero$/,
    means: "The program divides by zero (with `/`, `//` or `%`), which has no answer.",
    tips: "Check the value on the right of the operator just before this line. If it can be 0, test for that with an if before dividing.",
  },
  {
    id: "py-none-attribute", sources: PY,
    match: /^AttributeError: 'NoneType' object has no attribute '(?<attr>[^']+)'/,
    means: "The value here is None (no value), so it has no {attr}. A function without a return statement gives None, and so do list methods that change the list in place, like `.sort()`.",
    tips: "Check where the variable got its value. Call `.sort()` on its own line instead of keeping its result, or make the function return a value.",
  },
  {
    id: "py-attribute-suggest", sources: PY,
    match: /^AttributeError: '(?<type>[^']+)' object has no attribute '(?<attr>[^']+)'\. Did you mean: '(?<suggestion>[^']+)'\?$/,
    means: "Values of type {type} have nothing called {attr}. Python suggests {suggestion}, which they do have.",
    tips: "Check the spelling and the capital letters of the name after the dot.",
  },
  {
    id: "py-attribute", sources: PY,
    match: /^AttributeError: '(?<type>[^']+)' object has no attribute '(?<attr>[^']+)'$/,
    means: "Values of type {type} have no method or attribute called {attr}.",
    tips: "Check the spelling, and that the value is the type you expect: `print(type(...))` shows it. Each type has its own methods.",
  },
  {
    id: "py-recursion", sources: PY,
    match: /^RecursionError: maximum recursion depth exceeded/,
    means: "A function called itself (or functions called each other) so many times that Python stopped the program.",
    tips: "Check that the function has a base case that returns without calling itself again, and that each call moves closer to it.",
  },
  {
    id: "py-input-eof", sources: PY,
    match: /^EOFError: EOF when reading a line$/,
    means: "`input()` asked for another line, but the input had already ended (End input, or Ctrl+D) before one was typed.",
    tips: "Run the program again and type an answer each time it asks. End input tells the program there is nothing more to read.",
  },

  // ---------------------------------------------------------------- Python: modules
  {
    id: "py-module-package", sources: PY,
    match: /^ModuleNotFoundError: No module named '(?<module>[^']+)'$/,
    more: (f, rest) => (rest.some((l) => /can't install packages/.test(l)) ? { file: moduleFile(f.module) } : null),
    means: "Python can't find a module called {module}. Packages that need installing (with pip) can't be used in this app; the message lists the ones that can.",
    tips: "Check the spelling. If {module} is your own file, name it {file} and put it in the same folder as the file you run.",
  },
  {
    id: "py-module-not-loaded", sources: PY,
    match: /^ModuleNotFoundError: No module named '(?<module>[^']+)'$/,
    more: (f, rest) => (rest.some((l) => /is available, but it wasn't loaded for this run/.test(l)) ? { importLine: `import ${f.module.split(".")[0]}` } : null),
    means: "{module} is one of this app's packages, but it is loaded only for a program that imports it in a way the app can see before the run.",
    tips: "Write {importLine} at the top of a file of the program (not through importlib or __import__), then run it again.",
  },
  {
    id: "py-module", sources: PY,
    match: /^ModuleNotFoundError: No module named '(?<module>[^']+)'$/,
    more: (f) => ({ file: moduleFile(f.module) }),
    means: "Python can't find a module called {module} from the folder of the file you run.",
    tips: "Check the spelling. If {module} is your own file, it needs to be called {file} and sit in the same folder as the file you run.",
  },

  // ---------------------------------------------------------------- Python: layout and syntax
  {
    id: "py-indent-expected", sources: PY,
    match: /^IndentationError: expected an indented block after (?<what>.+) on line (?<line>\d+)$/,
    means: "The {~what} on line {~line} needs at least one indented line under it, and this line isn't indented.",
    tips: "Indent the lines that belong to it by 4 spaces. If it has no body yet, write `pass` there.",
  },
  {
    id: "py-indent-unexpected", sources: PY,
    match: /^IndentationError: unexpected indent$/,
    means: "This line is indented further than the line before it, but nothing above it starts a block (a line ending in a colon, like if or def).",
    tips: "Remove the extra spaces at the start of the line, so it lines up with the lines around it.",
  },
  {
    id: "py-indent-unindent", sources: PY,
    match: /^IndentationError: unindent does not match any outer indentation level$/,
    means: "This line moves back to the left, but not to the same place as any line above it, so Python can't tell which block it belongs to.",
    tips: "Line it up exactly with the block it belongs to, using the same number of spaces.",
  },
  {
    id: "py-tab", sources: PY,
    match: /^TabError: inconsistent use of tabs and spaces in indentation$/,
    means: "The indentation here mixes tab characters and spaces, so Python can't tell how far the line is indented.",
    tips: "Indent the lines of this block with spaces only, 4 per level: retype the indentation of this line and the lines around it.",
  },
  {
    id: "py-colon", sources: PY,
    match: /^SyntaxError: expected ':'$/,
    means: "Python expected a colon (`:`) here. A line that starts a block, such as if, elif, else, for, while, def or class, ends with a colon.",
    tips: "Add `:` at the end of that line, before the indented lines that belong to it.",
  },
  {
    id: "py-never-closed", sources: PY,
    match: /^SyntaxError: '(?<open>[([{])' was never closed$/,
    more: (f) => ({ close: CLOSE[f.open] }),
    means: "A {open} on this line has no matching {close}, so Python reads on into the next lines looking for it.",
    tips: "Add {close} where the expression should end. Counting the opening and closing brackets on the line helps.",
  },
  {
    id: "py-unmatched", sources: PY,
    match: /^SyntaxError: unmatched '(?<close>[)\]}])'$/,
    more: (f) => ({ open: OPEN[f.close] }),
    means: "This line has a {close} with no {open} before it to match.",
    tips: "Remove the extra {close}, or add the missing {open} where the expression starts.",
  },
  {
    id: "py-assign-compare", sources: PY,
    match: /^SyntaxError: invalid syntax\. Maybe you meant '==' or ':=' instead of '='\?$/,
    means: "A single `=` gives a variable a value. Python found one where it expected a comparison, such as the condition of an if or a while.",
    tips: "To compare two values, write `==` (two equals signs).",
  },
  {
    id: "py-unterminated-triple", sources: PY,
    match: /^SyntaxError: unterminated triple-quoted string literal \(detected at line \d+\)$/,
    means: "Text that starts with three quotes (`\"\"\"` or `'''`) is never closed, so Python reads the rest of the file as text.",
    tips: "Close it with the same three quotes where the text should end.",
  },
  {
    id: "py-unterminated", sources: PY,
    match: /^SyntaxError: unterminated string literal \(detected at line \d+\)$/,
    means: "A piece of text starts with a quote on this line but never ends: its closing quote is missing.",
    tips: "Add the closing quote where the text ends, the same kind as the opening one (`\"` or `'`).",
  },

  // ---------------------------------------------------------------- C and C++: names
  {
    id: "cpp-std-name", sources: CC,
    match: /^(?:use of undeclared identifier|unknown type name) '(?<name>[^']+)'; did you mean 'std::(?<std>[^']+)'\?$/,
    more: (f) => (f.std === f.name ? { full: `std::${f.name}` } : null),
    means: "{name} belongs to the C++ standard library, so its full name is {full}.",
    tips: "Write {full}, or put `using namespace std;` once after the #include lines.",
  },
  {
    id: "c-undeclared-suggest", sources: CC,
    match: /^use of undeclared identifier '(?<name>[^']+)'; did you mean '(?<suggestion>[^']+)'\?$/,
    means: "The compiler doesn't know a name {name} here. It suggests {suggestion}, a name it does know that is spelled alike.",
    tips: "Check the spelling and the capital letters. A new variable needs a declaration with its type, before this line and in the same `{ }` block or an outer one.",
  },
  {
    id: "c-undeclared", sources: CC,
    match: /^use of undeclared identifier '(?<name>[^']+)'$/,
    means: "The compiler doesn't know a name {name} at this point.",
    tips: "Declare it with its type before this line (for example `int count = 0;`), or check the spelling. A variable declared inside another `{ }` block isn't known here.",
  },
  {
    id: "c-implicit-library", sources: CC,
    match: /^implicitly declaring library function '(?<fn>[^']+)' with type/,
    more: (_f, rest) => {
      const m = findIn(rest, /include the header <(?<header>[^>]+)>/);
      return m?.groups ? { include: `#include <${m.groups.header}>` } : null;
    },
    means: "{fn} is a library function, but this file doesn't include the header that declares it, so the compiler has to guess how to call it.",
    tips: "Add {include} at the top of the file, with the other #include lines.",
  },
  {
    id: "c-implicit-function", sources: CC,
    match: /^implicit declaration of function '(?<fn>[^']+)' is invalid in C99$/,
    means: "{fn} is called before the compiler has seen it declared, so it doesn't know its parameters or what it returns.",
    tips: "If {fn} is your own function, move it above main, or put its prototype (its first line, ending in `;`) before the call. If not, check the spelling and the #include lines.",
  },

  // ---------------------------------------------------------------- C and C++: punctuation
  {
    id: "c-semicolon-type", sources: CC,
    match: /^expected ';' after (?<kind>struct|class|union|enum)$/,
    means: "A {~kind} definition ends with a semicolon after its closing `}`.",
    tips: "Add `;` right after the `}` that closes the {~kind}.",
  },
  {
    id: "c-semicolon", sources: CC,
    match: /^expected ';' (?:after|at end of|in) /,
    means: "The compiler expected a `;` here. In C and C++ each statement and declaration ends with a semicolon.",
    tips: "Add `;` at the end of the statement, where the message points (usually the end of the marked line).",
  },

  // ---------------------------------------------------------------- C and C++: printf and scanf
  {
    id: "c-format-address", sources: CC,
    match: /^format specifies type '(?<want>[^'*]+ \*)' but the argument has type '(?<got>[^'*[]+)'$/,
    means: "This conversion needs an address to store into (type {want}), but it was given a value of type {got}.",
    tips: "If this is scanf, put `&` before the variable's name. A char array read with `%s` needs no `&`.",
  },
  {
    id: "c-format", sources: CC,
    match: /^format specifies type '(?<want>[^']+)' but the argument has type '(?<got>[^']+)'$/,
    means: "The format string expects a value of type {want} here, but the value given has type {got}, so it is printed or read wrongly.",
    tips: "Use the conversion that fits the value: `%d` for int, `%f` for double, `%c` for char, `%s` for text in a char array. Or change the value to the type the format expects.",
  },
  {
    id: "c-format-count", sources: CC,
    match: /^more '%' conversions than data arguments$/,
    means: "The format string has more `%` conversions than there are values after it.",
    tips: "Give one value for each `%`, in the same order, or remove the extra conversion. A missing value can print anything.",
  },

  // ---------------------------------------------------------------- C and C++: values and functions
  {
    id: "c-uninitialized", sources: CC,
    match: /^variable '(?<name>[^']+)' is uninitialized when used here$/,
    means: "{name} is used before it gets a value, so its value can't be relied on (it may be 0, or anything else).",
    tips: "Give it a starting value where it is declared, such as `= 0` for a sum or a counter.",
  },
  {
    id: "c-return-some-paths", sources: CC,
    match: /^control may reach end of non-void function$/,
    means: "This function promises to return a value, but on some paths it reaches its closing `}` without a return, and the caller then gets no defined value.",
    tips: "Make every path end in a `return`, for example by adding one after the last if.",
  },
  {
    id: "c-return-missing", sources: CC,
    match: /^control reaches end of non-void function$/,
    means: "This function promises to return a value (its type isn't void), but it reaches its closing `}` without a return.",
    tips: "Add `return` with a value before the closing `}`, or make the function void if it shouldn't give anything back.",
  },
  {
    id: "c-infinite-recursion", sources: CC,
    match: /^all paths through this function will call itself$/,
    means: "Every way through this function calls the function again, so it can never finish: the program would run out of stack.",
    tips: "Add a base case: an if that returns without calling the function again, checked before the call.",
  },
  {
    id: "c-call-arguments", sources: CC,
    match: /^too (?:few|many) arguments to function call, expected (?:at least )?(?<want>\d+), have (?<got>\d+)$/,
    means: "The number of values in this call ({~got}) doesn't match the number of parameters the function is declared with ({~want}).",
    tips: "Give one value for each parameter, in the order the function lists them.",
  },
  {
    id: "cpp-no-matching-count", sources: CC,
    match: /^no matching function for call to '(?<fn>[^']+)'$/,
    more: (_f, rest) => {
      // Only with one candidate: with several (std::max has four), one candidate's count says nothing.
      const m = oneCandidate(rest) ? findIn(rest, /requires (?:at least |at most )?(?<want>\d+) arguments?, but (?<got>\d+) (?:was|were) provided/) : null;
      return m?.groups ? { want: m.groups.want, got: m.groups.got } : null;
    },
    means: "No version of {fn} takes the values in this call: it needs {~want}, and the call gives {~got}.",
    tips: "Give one value for each parameter, in the order the function lists them.",
  },
  {
    id: "cpp-no-matching-type", sources: CC,
    match: /^no matching function for call to '(?<fn>[^']+)'$/,
    more: (_f, rest) => {
      const m = oneCandidate(rest) ? findIn(rest, /no known conversion from '(?<from>[^']+)'(?: \(aka '[^']*'\))? to '(?<to>[^']+)' for (?<nth>\d+(?:st|nd|rd|th)) argument/) : null;
      return m?.groups ? { from: m.groups.from, to: m.groups.to, nth: m.groups.nth } : null;
    },
    means: "No version of {fn} takes the values in this call: its {~nth} value has type {from}, and the function wants {to}.",
    tips: "Pass a value of the type the function expects, or convert it first.",
  },
  {
    id: "cpp-no-matching", sources: CC,
    match: /^no matching function for call to '(?<fn>[^']+)'$/,
    means: "No version of {fn} accepts the values in this call: their number or their types don't fit its parameters.",
    tips: "Compare the values in the call with the function's parameters: how many there are, and their types. Two values of different types (like 1 and 2.5) can be enough.",
  },

  // ---------------------------------------------------------------- C and C++: pointers and members
  {
    id: "c-pointer-types", sources: CC,
    match: /^incompatible pointer types (?:initializing|assigning to|passing|returning|sending) '(?<a>[^']+)' (?:with an expression of type|from|to parameter of type|from a function with result type) '(?<b>[^']+)'$/,
    means: "A pointer to one type is used where a pointer to another is expected ({a} and {b}), so the data would be read as the wrong type.",
    tips: "Make the types match: declare the variable or the parameter with the type of the data it points to.",
  },
  {
    id: "c-int-to-pointer", sources: CC,
    match: /^incompatible integer to pointer conversion (?:initializing|assigning to|passing|returning) '(?<a>[^']+)' (?:with an expression of type|from|to parameter of type|from a function with result type) '(?<b>[^']+)'/,
    means: "A plain {b} value is used where a pointer ({a}, an address) is expected.",
    tips: "To point at a variable, use its address with `&`, like `&x`. If this is scanf, each variable needs `&` before it.",
  },
  {
    id: "c-member-pointer", sources: CC,
    match: /^member reference type '(?<type>[^']+)' is a pointer; did you mean to use '->'\?$/,
    means: "The value before the dot is a pointer ({type}), so its members are reached with `->` instead of a dot.",
    tips: "Write `->` instead of `.` here, like `p->x`.",
  },
  {
    id: "c-no-member-suggest", sources: CC,
    match: /^no member named '(?<member>[^']+)' in '(?<type>[^']+)'; did you mean '(?<suggestion>[^']+)'\?$/,
    means: "{type} has no member called {member}. The compiler suggests {suggestion}, which it does have.",
    tips: "Check the spelling and the capital letters of the name after the dot.",
  },
  {
    id: "c-no-member", sources: CC,
    match: /^no member named '(?<member>[^']+)' in '(?<type>[^']+)'$/,
    means: "{type} has no member called {member}.",
    tips: "Check the spelling against the definition of {type}, and that the variable is the type you expect.",
  },

  // ---------------------------------------------------------------- linking
  {
    id: "link-undefined", sources: ["wasm-ld"],
    match: /^undefined symbol: (?<symbol>.+?)(?: \(used in .+\))?$/,
    more: (f) => {
      // main, vtables and typeinfo have hints of their own (runner/hints.ts).
      const name = f.symbol.replace(/\(.*$/, "").trim();
      return /^(?:main|vtable for|typeinfo for)\b/.test(f.symbol) || !name ? null : { name };
    },
    means: "The program uses {name}, but none of its files defines it (writes its body), so its parts can't be joined into one program.",
    tips: "Check that the name is spelled the same in the call and in the definition. A body in another file only counts if that file is in the folder of the file you run, or a folder inside it.",
  },

  // ---------------------------------------------------------------- C and C++: crashes (cpp-wasi.ts describeCrash)
  {
    id: "crash-memory", sources: ["runtime"],
    match: /^The program crashed: invalid memory access\b/,
    means: "The program read or wrote memory outside what it owns (a segmentation fault, on most computers). Common causes: an array index past the end or below 0, a bad pointer, or recursion that never stops.",
    tips: "Check each array index against the array's size (the last index is size - 1), especially in loops, and that scanf has `&` before each variable.",
  },
  {
    id: "crash-stack", sources: ["runtime"],
    match: /^The program crashed: stack overflow\b/,
    means: "A function called itself (or functions called each other) so many times that the program ran out of stack memory.",
    tips: "Check that the recursion has a base case that returns without calling again, and that each call moves closer to it.",
  },
  {
    id: "crash-division", sources: ["runtime"],
    match: /^The program crashed: integer division by zero\b/,
    means: "The program divided a whole number by zero (with `/` or `%`), which has no answer, so it was stopped.",
    tips: "Check the value you divide by before the division. If it can be 0 (from input, or a count that is still 0), test it first.",
  },
  {
    id: "crash-abort", sources: ["runtime"],
    match: /^The program crashed: aborted\b/,
    means: "The program stopped itself. That happens when abort() is called or an assert(...) fails, and also when the program does something with no defined meaning that the compiler turned into a stop, such as writing through a NULL pointer.",
    tips: "Check that every pointer gets an address before it is used, and that each assert's condition holds where it runs.",
  },
];

/** A module's file name: requests -> requests.py, pkg.util -> pkg/util.py. */
function moduleFile(module: string): string {
  return `${module.split(".").join("/")}.py`;
}

/** Longest fill-in value, in characters: a program can put anything in its message. */
export const MAX_FILL = 48;

/**
 * A value from the message, made safe and short to show: no control characters, one line, at most
 * MAX_FILL characters (cut with "..."), and the C++ library's internal names tidied
 * ("std::__2::basic_string<char>" is shown as "std::string").
 */
export function cleanFill(value: string): string {
  // Control, format (zero-width, bidi) and line or paragraph separator characters become spaces.
  let v = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  v = v.replace(/std::__2::/g, "std::").replace(/std::basic_string<char>/g, "std::string");
  if ([...v].length > MAX_FILL) v = `${[...v].slice(0, MAX_FILL - 3).join("")}...`;
  return v;
}

const PIECE = /`([^`]+)`|\{(~?)(\w+)\}/g;

/** A template's parts, with its values filled in (an unknown key throws: the tests catch it). */
function render(template: string, fill: Fill): HelpPart[] {
  const parts: HelpPart[] = [];
  let at = 0;
  for (const m of template.matchAll(PIECE)) {
    if (m.index > at) parts.push({ text: template.slice(at, m.index) });
    if (m[1] !== undefined) parts.push({ code: m[1] });
    else {
      const value = fill[m[3]];
      if (value === undefined) throw new Error(`error help: no value for {${m[3]}}`);
      parts.push(m[2] ? { text: value } : { code: value });
    }
    at = m.index + m[0].length;
  }
  if (at < template.length) parts.push({ text: template.slice(at) });
  // Words next to each other join, so the help reads as plain sentences.
  return parts.reduce<HelpPart[]>((out, p) => {
    const last = out[out.length - 1];
    if (last && "text" in last && "text" in p) out[out.length - 1] = { text: last.text + p.text };
    else out.push(p);
    return out;
  }, []);
}

/** The help for one diagnostic, or null when the table has none (or it is not an error or warning). */
export function helpFor(d: HelpSubject): ErrorHelp | null {
  if ((d.severity !== "error" && d.severity !== "warning") || d.role === "call-site") return null;
  const [first = "", ...rest] = d.message.split("\n");
  const lines = [...rest, ...(d.notes ?? []).map((n) => n.message)];
  for (const entry of ENTRIES) {
    if (!entry.sources.includes(d.source)) continue;
    const m = entry.match.exec(first);
    if (!m) continue;
    const raw: Fill = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) raw[k] = v;
    const more = entry.more ? entry.more(raw, lines) : {};
    if (more === null) continue;
    const fill: Fill = {};
    for (const [k, v] of Object.entries({ ...raw, ...more })) fill[k] = cleanFill(v);
    return { id: entry.id, means: render(entry.means, fill), tips: render(entry.tips, fill) };
  }
  return null;
}

/** Every entry's id, in the table's order (tests check each one has a captured message). */
export const HELP_IDS: readonly string[] = ENTRIES.map((e) => e.id);

/** The help as plain text (for tests and for a tooltip-free reading). */
export const helpText = (parts: readonly HelpPart[]): string => parts.map((p) => ("text" in p ? p.text : p.code)).join("");
