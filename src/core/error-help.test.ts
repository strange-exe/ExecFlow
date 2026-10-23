import { describe, expect, it } from "vitest";
import { cleanFill, HELP_IDS, helpFor, helpText, MAX_FILL, type HelpSubject } from "./error-help";
import captured from "./__fixtures__/error-help.json";

// Every message below was printed by the real runtimes: each program in the fixture ran through the
// app's own runners (Pyodide 314.0.7, clang and wasm-ld 8), see the fixture's "about".
interface Case {
  files: Record<string, string>;
  status: string;
  diagnostics: (Omit<HelpSubject, "notes"> & { notes?: string[] })[];
}
const cases = captured.cases as unknown as Record<string, Case>;

/** The diagnostics of a case, notes in the ToolDiagnostic shape. */
const diagnostics = (name: string): HelpSubject[] => {
  const c = cases[name];
  if (!c) throw new Error(`no captured case ${name}`);
  return c.diagnostics.map((d) => ({ ...d, notes: (d.notes ?? []).map((message) => ({ message })) }));
};

/** [entry id or null, what the help says it means] for each diagnostic of the case, in order. */
const EXPECTED: Record<string, [string | null, string?][]> = {
  // Python: names
  "py-name-module": [["py-name-import", "Python doesn't know math here. It is the name of a module, and a file has to import a module before using it."]],
  "py-name-suggest": [["py-name-suggest", "Python doesn't know a name totl at this point. It suggests total, a name it does know that is spelled alike."]],
  "py-name": [["py-name", "Python doesn't know a name answer at this point in the program."]],
  "py-unbound": [["py-unbound-local", "This function gives score a value somewhere, so Python treats score as the function's own (local) variable, but this line uses it before that happens."]],
  // Python: types and calls
  "py-concat": [["py-concat-str", "This line uses + to join text (a str) to a value of type int, but + only joins text to text."]],
  "py-operand-none": [["py-operand-none", "One side of + is None (no value), and Python can't use + with it. A function without a return statement gives None."]],
  "py-operand": [["py-operand-str", "Python can't use + between int and str values: text (str) and numbers don't mix."]],
  "py-operand-list": [["py-operand", "Python can't use - between list and int values."]],
  "py-method-self": [["py-args-self", "Dog.bark() gets one value more than its def line lists. When a method is called on an object, Python passes the object itself as the first value."]],
  "py-args-many": [["py-args-many", "This call gives greet() more values (2) than its def line takes (1)."]],
  "py-args-missing": [["py-args-missing", "This call to area() gives no value for 'height', which its def line asks for."]],
  "py-args-missing-two": [["py-args-missing", "This call to box() gives no value for 'h' and 'd', which its def line asks for."]],
  "py-not-callable": [["py-not-callable", "This line puts ( ) after a value of type int, as if it were a function."]],
  "py-str-index-type": [["py-index-type", "A position in a list must be a whole number (an int), but this one is a str."]],
  // Python: values
  "py-index-assign": [["py-index-assign", "The program stores a value at a position the list doesn't have yet. A list only grows when something is added to it."]],
  "py-index": [["py-index", "The program asks for a position the list doesn't have."]],
  "py-index-str": [["py-index", "The program asks for a position the string doesn't have."]],
  "py-key": [["py-key", "The program looks up the key 'bob', and the dictionary doesn't have it."]],
  "py-key-int": [["py-key", "The program looks up the key 1, and the dictionary doesn't have it."]],
  "py-int": [["py-int-literal", "int() was given the text 'abc', which isn't a whole number."]],
  "py-int-float": [["py-int-literal", "int() was given the text '3.5', which isn't a whole number."]],
  "py-float": [["py-float-literal", "float() was given the text 'ten', which isn't a number."]],
  "py-zero-div": [["py-zero-division", "The program divides by zero (with /, // or %), which has no answer."]],
  "py-zero-floordiv": [["py-zero-division"]],
  "py-zero-mod": [["py-zero-division"]],
  "py-zero-float": [["py-zero-division"]],
  "py-none-attr": [["py-none-attribute", "The value here is None (no value), so it has no append. A function without a return statement gives None, and so do list methods that change the list in place, like .sort()."]],
  "py-attr-suggest": [["py-attribute-suggest", "Values of type str have nothing called uper. Python suggests upper, which they do have."]],
  "py-attr": [["py-attribute", "Values of type str have no method or attribute called push."]],
  "py-recursion": [["py-recursion", "A function called itself (or functions called each other) so many times that Python stopped the program."]],
  "py-eof": [["py-input-eof", "input() asked for another line, but the input had already ended (End input, or Ctrl+D) before one was typed."]],
  // Python: modules
  "py-module": [["py-module-package", "Python can't find a module called requests. Packages that need installing (with pip) can't be used in this app; the message lists the ones that can."]],
  "py-module-importlib": [["py-module-not-loaded", "numpy is one of this app's packages, but it is loaded only for a program that imports it in a way the app can see before the run."]],
  "py-module-elsewhere": [["py-module", "Python can't find a module called helper from the folder of the file you run."]],
  // Python: layout and syntax (a run, and the idle check that reports the same message)
  "py-indent-expected": [["py-indent-expected", "The 'if' statement on line 2 needs at least one indented line under it, and this line isn't indented."]],
  "check:py-indent-expected": [["py-indent-expected", "The 'if' statement on line 2 needs at least one indented line under it, and this line isn't indented."]],
  "py-indent-expected-def": [["py-indent-expected", "The function definition on line 1 needs at least one indented line under it, and this line isn't indented."]],
  "py-indent-unexpected": [["py-indent-unexpected"]],
  "py-indent-unindent": [["py-indent-unindent"]],
  "py-tab": [["py-tab", "The indentation here mixes tab characters and spaces, so Python can't tell how far the line is indented."]],
  "check:py-tab": [["py-tab"]],
  "py-colon": [["py-colon", "Python expected a colon (:) here. A line that starts a block, such as if, elif, else, for, while, def or class, ends with a colon."]],
  "py-colon-for": [["py-colon"]],
  "check:py-colon": [["py-colon"]],
  "py-unclosed": [["py-never-closed", "A ( on this line has no matching ), so Python reads on into the next lines looking for it."]],
  "check:py-unclosed": [["py-never-closed"]],
  "py-unclosed-list": [["py-never-closed", "A [ on this line has no matching ], so Python reads on into the next lines looking for it."]],
  "py-unmatched": [["py-unmatched", "This line has a ) with no ( before it to match."]],
  "py-assign-if": [["py-assign-compare", "A single = gives a variable a value. Python found one where it expected a comparison, such as the condition of an if or a while."]],
  "py-unterminated": [["py-unterminated", "A piece of text starts with a quote on this line but never ends: its closing quote is missing."]],
  "py-unterminated-triple": [["py-unterminated-triple", "Text that starts with three quotes (\"\"\" or ''') is never closed, so Python reads the rest of the file as text."]],
  // C and C++: names
  "cpp-cout": [
    ["cpp-std-name", "cout belongs to the C++ standard library, so its full name is std::cout."],
    ["cpp-std-name", "endl belongs to the C++ standard library, so its full name is std::endl."],
  ],
  "cpp-string": [["cpp-std-name", "string belongs to the C++ standard library, so its full name is std::string."]],
  "c-undeclared": [["c-undeclared-suggest", "The compiler doesn't know a name totl here. It suggests total, a name it does know that is spelled alike."]],
  "c-undeclared-plain": [["c-undeclared", "The compiler doesn't know a name count at this point."]],
  "c-implicit-lib": [["c-implicit-library", "printf is a library function, but this file doesn't include the header that declares it, so the compiler has to guess how to call it."]],
  "c-implicit-lib-sqrt": [["c-implicit-library", "sqrt is a library function, but this file doesn't include the header that declares it, so the compiler has to guess how to call it."]],
  "c-implicit-fn": [["c-implicit-function", "twice is called before the compiler has seen it declared, so it doesn't know its parameters or what it returns."]],
  // C and C++: punctuation
  "c-semicolon": [["c-semicolon", "The compiler expected a ; here. In C and C++ each statement and declaration ends with a semicolon."]],
  "c-semicolon-decl": [["c-semicolon"]],
  "c-semicolon-return": [["c-semicolon"]],
  "cpp-semicolon-class": [["c-semicolon-type", "A struct definition ends with a semicolon after its closing }."]],
  // C and C++: printf and scanf
  "c-format": [["c-format", "The format string expects a value of type int here, but the value given has type double, so it is printed or read wrongly."]],
  "c-format-scanf": [
    ["c-format-address", "This conversion needs an address to store into (type int *), but it was given a value of type int."],
    ["c-uninitialized", "n is used before it gets a value, so its value can't be relied on (it may be 0, or anything else)."],
  ],
  "c-format-missing-arg": [["c-format-count", "The format string has more % conversions than there are values after it."]],
  // C and C++: values and functions
  "c-uninit": [["c-uninitialized", "sum is used before it gets a value, so its value can't be relied on (it may be 0, or anything else)."]],
  "c-uninit-loop": [["c-uninitialized"]],
  "c-return": [["c-return-some-paths", "This function promises to return a value, but on some paths it reaches its closing } without a return, and the caller then gets no defined value."]],
  "cpp-return": [["c-return-some-paths"]],
  // "unused variable" has no entry: no help is better than a guess.
  "c-return-none": [[null], ["c-return-missing", "This function promises to return a value (its type isn't void), but it reaches its closing } without a return."]],
  "c-few-args": [["c-call-arguments", "The number of values in this call (1) doesn't match the number of parameters the function is declared with (2)."]],
  "c-many-args": [["c-call-arguments", "The number of values in this call (3) doesn't match the number of parameters the function is declared with (2)."]],
  "cpp-no-match": [["cpp-no-matching-count", "No version of show takes the values in this call: it needs 2, and the call gives 1."]],
  "cpp-no-match-many": [["cpp-no-matching-count", "No version of add takes the values in this call: it needs 2, and the call gives 3."]],
  // Four candidates (one of them "requires 3 arguments"): no single candidate's reason is the reason.
  "cpp-no-match-max": [["cpp-no-matching", "No version of max accepts the values in this call: their number or their types don't fit its parameters."]],
  "cpp-no-match-type": [["cpp-no-matching-type", "No version of twice takes the values in this call: its 1st value has type std::string, and the function wants int."]],
  // C and C++: pointers and members
  "c-ptr": [["c-pointer-types", "A pointer to one type is used where a pointer to another is expected (double * and int *), so the data would be read as the wrong type."]],
  "c-ptr-pass": [["c-pointer-types", "A pointer to one type is used where a pointer to another is expected (double [3] and int *), so the data would be read as the wrong type."]],
  "c-int-ptr": [["c-int-to-pointer", "A plain int value is used where a pointer (int *, an address) is expected."]],
  "c-member-ptr": [["c-member-pointer", "The value before the dot is a pointer (struct point *), so its members are reached with -> instead of a dot."]],
  "cpp-member": [["c-no-member-suggest", "std::string has no member called lenght. The compiler suggests length, which it does have."]],
  "c-member": [["c-no-member", "struct point has no member called z."]],
  // Linking: the error gets the help; the runner's own hint (an info row) gets none.
  "c-link": [["link-undefined", "The program uses helper, but none of its files defines it (writes its body), so its parts can't be joined into one program."], [null]],
  "cpp-link": [["link-undefined", "The program uses helper, but none of its files defines it (writes its body), so its parts can't be joined into one program."], [null]],
  "c-link-typo": [["c-implicit-function"], ["link-undefined", "The program uses prinft, but none of its files defines it (writes its body), so its parts can't be joined into one program."]],
  // Crashes, as this app reports them (cpp-wasi.ts describeCrash): the same words in all three engines,
  // except deep recursion in WebKit, which reports an invalid memory access.
  "c-segv": [["crash-memory", "The program read or wrote memory outside what it owns (a segmentation fault, on most computers). Common causes: an array index past the end or below 0, a bad pointer, or recursion that never stops."]],
  "c-null": [["crash-abort"]],
  "c-stack": [["c-infinite-recursion", "Every way through this function calls the function again, so it can never finish: the program would run out of stack."], ["crash-stack", "A function called itself (or functions called each other) so many times that the program ran out of stack memory."]],
  "c-stack@webkit": [["c-infinite-recursion"], ["crash-memory"]],
  "c-div-zero": [["crash-division", "The program divided a whole number by zero (with / or %), which has no answer, so it was stopped."]],
};

describe("error help, on messages the real runtimes printed", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(name, () => {
      const list = diagnostics(name);
      expect(list, "diagnostics in the captured case").toHaveLength(expected.length);
      list.forEach((d, i) => {
        const [id, means] = expected[i]!;
        const help = helpFor(d);
        expect(help?.id ?? null, `diagnostic ${i}: ${d.message}`).toBe(id);
        if (!help) return;
        if (means !== undefined) expect(helpText(help.means)).toBe(means);
        // Two short parts, no template left unfilled, never a question back at the student.
        for (const part of [help.means, help.tips]) {
          const text = helpText(part);
          expect(text.length).toBeGreaterThan(10);
          expect(text).not.toMatch(/[{}]~?\w+[}]|^\s|\s$/);
          expect(text).toMatch(/[.:)]$/);
        }
      });
    });
  }

  it("covers every entry of the table with at least one captured message", () => {
    const hit = new Set<string>();
    for (const name of Object.keys(cases)) for (const d of diagnostics(name)) { const h = helpFor(d); if (h) hit.add(h.id); }
    expect(HELP_IDS.filter((id) => !hit.has(id)), "entries with no captured message").toEqual([]);
  });

  it("tests every captured case", () => {
    expect(Object.keys(cases).filter((name) => !(name in EXPECTED)).sort(), "captured but not checked").toEqual([]);
  });

  it("fills in the specifics from the message", () => {
    const help = helpFor(diagnostics("c-implicit-lib-sqrt")[0]!)!;
    expect(help.tips).toContainEqual({ code: "#include <math.h>" });
    expect(helpFor(diagnostics("py-name-module")[0]!)!.tips).toContainEqual({ code: "import math" });
    expect(helpFor(diagnostics("py-method-self")[0]!)!.tips).toContainEqual({ code: "def bark(self):" });
    expect(helpFor(diagnostics("py-unclosed-list")[0]!)!.tips).toContainEqual({ code: "]" });
    expect(helpFor(diagnostics("py-module")[0]!)!.tips).toContainEqual({ code: "requests.py" });
    expect(helpFor(diagnostics("py-module-importlib")[0]!)!.tips).toContainEqual({ code: "import numpy" });
    // Names from the message are code, words from the message are words.
    expect(helpFor(diagnostics("py-name-suggest")[0]!)!.means).toContainEqual({ code: "totl" });
    expect(helpFor(diagnostics("py-indent-expected")[0]!)!.means).toContainEqual({ text: "The 'if' statement on line 2 needs at least one indented line under it, and this line isn't indented." });
  });
});

describe("error help, what it leaves alone", () => {
  const base: HelpSubject = { source: "python", severity: "error", message: "NameError: name 'x' is not defined" };

  it("only explains errors and warnings, never notes, hints or the call that led to an error", () => {
    expect(helpFor(base)?.id).toBe("py-name");
    expect(helpFor({ ...base, severity: "warning" })?.id).toBe("py-name");
    expect(helpFor({ ...base, severity: "info" })).toBeNull();
    expect(helpFor({ ...base, severity: "hint" })).toBeNull();
    expect(helpFor({ ...base, role: "call-site" })).toBeNull();
    expect(helpFor({ ...base, source: "hint" })).toBeNull();
  });

  it("matches a message only from the tool that prints it", () => {
    expect(helpFor({ ...base, source: "clang" })).toBeNull();
    expect(helpFor({ source: "python", severity: "error", message: "use of undeclared identifier 'x'" })).toBeNull();
    expect(helpFor({ source: "clang", severity: "error", message: "use of undeclared identifier 'x'" })?.id).toBe("c-undeclared");
  });

  it("matches the first line only, so a program's own text after it can't choose the help", () => {
    expect(helpFor({ ...base, message: "ValueError: something else\nNameError: name 'x' is not defined" })).toBeNull();
    expect(helpFor({ source: "python", severity: "error", message: "KeyError: 'k'\nNo k.py is next to the file you run, and CodeEditor can't install packages." })?.id).toBe("py-key");
  });

  it("has no help for messages it doesn't know", () => {
    expect(helpFor({ source: "python", severity: "error", message: "OSError: [Errno 44] No such file or directory: 'a.txt'" })).toBeNull();
    expect(helpFor({ source: "clang", severity: "warning", message: "unused variable 'x'", code: "-Wunused-variable" })).toBeNull();
    expect(helpFor({ source: "runtime", severity: "error", message: "The program crashed: a call through a bad function pointer" })).toBeNull();
  });
});

describe("error help fill-ins are short, single-line text", () => {
  it("cuts a long value with ... at MAX_FILL characters", () => {
    const key = `'${"k".repeat(200)}'`;
    const help = helpFor({ source: "python", severity: "error", message: `KeyError: ${key}` })!;
    const code = help.means.find((p) => "code" in p) as { code: string };
    expect([...code.code]).toHaveLength(MAX_FILL);
    expect(code.code.endsWith("...")).toBe(true);
  });

  it("turns control, zero-width and bidi characters into spaces", () => {
    const cp = (n: number) => String.fromCodePoint(n);
    expect(cleanFill(`a${cp(0)}b${cp(0x1b)}[31mc`)).toBe("a b [31mc");
    expect(cleanFill(`x${cp(0x200b)}y${cp(0x202e)}z${cp(0x2028)}w`)).toBe("x y z w");
    expect(cleanFill("  two\n\nlines  ")).toBe("two lines");
  });

  it("keeps markup as plain characters (the view draws it as text)", () => {
    const help = helpFor({ source: "python", severity: "error", message: "KeyError: '<img src=x onerror=alert(1)>'" })!;
    expect(help.means).toContainEqual({ code: "'<img src=x onerror=alert(1)>'" });
  });

  it("shows the C++ library's string type by its usual name", () => {
    expect(cleanFill("std::__2::basic_string<char>")).toBe("std::string");
  });
});
