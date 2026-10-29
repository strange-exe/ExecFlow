// The C and C++ adapter: tree-sitter-c and tree-sitter-cpp trees (C++'s grammar extends C's, so
// the statement shapes are the same) to flow models. One chart per function definition, main
// first. Input/output is recognised by call name (the spec's lists) and, in C++, by
// `std::cout << ...` / `std::cin >> ...` (or plain cout/cin after `using namespace std`).
import type { Node } from "web-tree-sitter";
import { FlowBuilder, ONE_STEP, TooBig, empty, type ChartResult, type ChartStub, type FlowFile, type Step, type SwitchCase } from "./model";
import { pickIndex, type Pick } from "./pick";
import { codeChildren, endLineOf, firstErrorLine, firstLine, forEachDescendant, lineOf, unparen, withoutSemicolon } from "./walk";

export interface CFamily {
  cpp: boolean;
}

const C_IO = new Set(["printf", "puts", "putchar", "scanf", "gets", "fgets", "getchar"]);
const CPP_IO = new Set([...C_IO, "getline"]);
/** A goto's note when its label exists but sits inside a box shown as one step. */
const FOLDED_LABEL = "label inside a step shown as one";

interface FnDef {
  name: string;
  simple: string;
  node: Node;
  body: Node;
}

/** The name a function_definition declares ("main", "A::g", "operator+"), or null. */
function declaredName(def: Node): string | null {
  let d = def.childForFieldName("declarator");
  for (let i = 0; d && i < 16; i++) {
    if (d.type === "function_declarator") {
      const name = d.childForFieldName("declarator");
      return name ? name.text.replace(/\s+/g, "") : null;
    }
    d = d.childForFieldName("declarator") ?? codeChildren(d)[0] ?? null;
  }
  return null;
}

const simpleName = (name: string) => name.split("::").at(-1)!;

/** Function definitions at the top level, in namespaces, classes, templates and extern "C" blocks. */
function collectFunctions(root: Node): FnDef[] {
  const out: FnDef[] = [];
  const stack: { node: Node; prefix: string }[] = [{ node: root, prefix: "" }];
  /** A named scope (namespace, class): its functions' names start with "Name::". */
  const scope = (n: Node, prefix: string) => {
    const body = n.childForFieldName("body");
    const name = n.childForFieldName("name")?.text;
    if (body) stack.push({ node: body, prefix: name ? `${prefix}${name}::` : prefix });
  };
  while (stack.length) {
    const { node, prefix } = stack.pop()!;
    for (const child of codeChildren(node)) {
      switch (child.type) {
        case "function_definition": {
          const body = child.childForFieldName("body");
          const name = declaredName(child);
          if (body && name) out.push({ name: prefix + name, simple: simpleName(name), node: child, body });
          break;
        }
        case "namespace_definition":
        case "class_specifier":
        case "struct_specifier":
        case "union_specifier":
          scope(child, prefix);
          break;
        case "declaration":
        case "type_definition": {
          // `struct S { ... } s;` carries its body in the type.
          const type = child.childForFieldName("type");
          if (type && ["class_specifier", "struct_specifier", "union_specifier"].includes(type.type)) scope(type, prefix);
          break;
        }
        case "template_declaration":
        case "linkage_specification":
        case "declaration_list":
        case "field_declaration_list":
        case "preproc_if":
        case "preproc_ifdef":
        case "preproc_else":
        case "preproc_elif":
          stack.push({ node: child, prefix });
          break;
      }
    }
  }
  // Source order (the stack walk can visit nested containers out of order), main first.
  out.sort((a, b) => a.node.startIndex - b.node.startIndex);
  const main = out.findIndex((f) => f.name === "main");
  if (main > 0) out.unshift(...out.splice(main, 1));
  return out;
}

/** Whether the file says `using namespace std;` (or `using std::cout;` and friends). */
function usesStd(root: Node): boolean {
  return codeChildren(root).some((c) => (c.type === "using_declaration" || c.type === "alias_declaration") && /^using\s+(namespace\s+std\s*;|std\s*::\s*(cout|cin)\s*;)/.test(c.text));
}

export function chartCFamily(root: Node, options: CFamily, pick: Pick | null | "all" = "all"): FlowFile {
  const fns = collectFunctions(root);
  const names = new Map<string, string>();
  for (const f of fns) if (!names.has(f.simple)) names.set(f.simple, f.name);
  const std = options.cpp && usesStd(root);
  const only = pick === "all" ? -1 : pickIndex(fns, pick);
  const charts: (ChartResult | ChartStub)[] = fns.map((f, i) => {
    const from = lineOf(f.node);
    const to = endLineOf(f.node);
    if (only >= 0 && i !== only) return { ok: null, name: f.name, from, to };
    const b = new FlowBuilder(f.name, from, to);
    try {
      const walker = new CWalker(b, options, names, std);
      return { ok: true as const, ...b.finish(walker.function(f.body)) };
    } catch (e) {
      if (e instanceof TooBig) return { ok: false as const, name: f.name, from, to, tooBig: e.message };
      throw e;
    }
  });
  const file: FlowFile = { charts };
  const error = firstErrorLine(root);
  if (error !== undefined) file.syntaxError = error;
  return file;
}

class CWalker {
  /** Each label's connector, made before the body is read. */
  private labels = new Map<string, number>();
  /** Connectors already placed at their label. */
  private placed = new Set<number>();
  /** Each goto, resolved once the body is read: only then is it known which labels were placed. */
  private gotos: { step: Extract<Step, { t: "goto" }>; name: string; n: Node }[] = [];

  constructor(
    private readonly b: FlowBuilder,
    private readonly options: CFamily,
    private readonly names: Map<string, string>,
    private readonly std: boolean,
  ) {}

  function(body: Node): Step {
    // Every label gets its connector first, so a goto can point forward or back.
    forEachDescendant(
      body,
      (n) => {
        // Labels are statements: no need to look inside expressions. Nor inside a mistake: stmt()
        // draws an ERROR node as nothing, so a label in it is unknown ("no such label"), not folded.
        if (n.type === "expression_statement" || n.type === "declaration" || n.type === "return_statement" || n.type === "ERROR") return false;
        if (n.type === "labeled_statement") {
          const name = n.childForFieldName("label")?.text;
          if (name && !this.labels.has(name)) this.labels.set(name, this.b.node("connector", name, lineOf(n), lineOf(n)));
        }
        return true;
      },
      Number.POSITIVE_INFINITY,
    );
    const step = this.block(body);
    // A label inside a construct shown as one step (try, #ifdef) is never placed: its goto
    // carries on with a note instead of linking to a connector that isn't in the chart.
    for (const { step: g, name, n } of this.gotos) {
      const known = this.labels.get(name);
      const placed = known !== undefined && this.placed.has(known);
      const note = placed ? {} : { note: known === undefined ? "no such label" : FOLDED_LABEL };
      g.id = this.b.node("connector", name, lineOf(n), endLineOf(n), note);
      g.target = placed ? known : null;
    }
    return step;
  }

  private block(n: Node): Step {
    return { t: "seq", items: codeChildren(n).map((c) => this.stmt(c)) };
  }

  private nested(n: Node | null): Step {
    return n ? this.b.nest(() => this.stmt(n)) : empty();
  }

  private stmt(n: Node): Step {
    switch (n.type) {
      case "compound_statement":
        return this.b.nest(() => this.block(n));
      case "expression_statement":
        return codeChildren(n).length ? this.simple(n) : empty();
      case "declaration":
        return this.simple(n);
      case "if_statement":
        return this.ifChain(n);
      case "while_statement":
        return this.loop(n, false);
      case "do_statement":
        return this.loop(n, true);
      case "for_statement":
        return this.forLoop(n);
      case "for_range_loop":
        return this.rangeFor(n);
      case "switch_statement":
        return this.switchStmt(n);
      case "break_statement":
        return { t: "break" };
      case "continue_statement":
        return { t: "continue" };
      case "return_statement":
      case "throw_statement":
        return { t: "end", id: this.b.node("end", withoutSemicolon(n.text), lineOf(n), endLineOf(n)) };
      case "goto_statement": {
        // Its connector is made in function(), after the body: box ids follow reading order, not this.
        const step: Extract<Step, { t: "goto" }> = { t: "goto", id: -1, target: null };
        this.gotos.push({ step, name: n.childForFieldName("label")?.text ?? "", n });
        return step;
      }
      case "labeled_statement": {
        const name = n.childForFieldName("label")?.text ?? "";
        const inner = codeChildren(n).filter((c) => c.type !== "statement_identifier");
        const known = this.labels.get(name);
        // A second label with the same name is a compile error: it gets a connector nothing goes to.
        const id = known !== undefined && !this.placed.has(known) ? known : this.b.node("connector", name, lineOf(n), lineOf(n));
        this.placed.add(id);
        return { t: "seq", items: [{ t: "label", id }, ...inner.map((c) => this.stmt(c))] };
      }
      case "try_statement":
        return this.oneStep(n);
      case "case_statement":
        return this.strayCase(n);
      case "ERROR":
      case "statement_identifier":
      case ";":
        return empty();
      default:
        if (n.type.startsWith("preproc_")) return this.oneStep(n);
        return n.text.includes("\n") ? this.oneStep(n) : this.box("process", withoutSemicolon(n.text), n);
    }
  }

  private box(kind: "process" | "io" | "call", text: string, n: Node, options: { simple?: boolean; callee?: string; note?: string } = {}): Step {
    return { t: "node", id: this.b.node(kind, text, lineOf(n), endLineOf(n), options) };
  }

  /** A construct the chart doesn't open up: one box with its first line and the note. */
  private oneStep(n: Node): Step {
    return this.box("process", withoutSemicolon(firstLine(n.text)), n, { note: ONE_STEP });
  }

  /**
   * A case label inside a block or loop in the switch (Duff's device): the jump into it isn't drawn,
   * so its label is one box with the note, and its statements follow as usual (never dropped).
   */
  private strayCase(n: Node): Step {
    const value = n.childForFieldName("value");
    const head = this.b.node("process", value ? `case ${value.text.replace(/\s+/g, " ")}` : "default", lineOf(n), value ? endLineOf(value) : lineOf(n), { note: ONE_STEP });
    const stmts = codeChildren(n).filter((s) => s.id !== value?.id);
    return { t: "seq", items: [{ t: "node", id: head }, ...stmts.map((s) => this.stmt(s))] };
  }

  /** An expression statement or declaration: input/output, a call to this file's function, or a plain step. */
  private simple(n: Node): Step {
    const text = withoutSemicolon(n.text);
    const found = this.scan(n);
    if (found.lambda) return this.oneStep(n);
    if (found.callee !== undefined) return this.box("call", text, n, { callee: found.callee });
    if (found.io) return this.box("io", text, n);
    return this.box("process", text, n, { simple: true });
  }

  private scan(n: Node): { io: boolean; callee?: string; lambda: boolean } {
    const out: { io: boolean; callee?: string; lambda: boolean } = { io: false, lambda: false };
    const io = this.options.cpp ? CPP_IO : C_IO;
    forEachDescendant(n, (d) => {
      switch (d.type) {
        case "lambda_expression":
          out.lambda = true;
          return false;
        case "call_expression": {
          const name = calleeName(d.childForFieldName("function"));
          if (name !== null) {
            if (io.has(name)) out.io = true;
            const chart = this.names.get(name);
            if (chart !== undefined && out.callee === undefined) out.callee = chart;
          }
          return true;
        }
        case "binary_expression": {
          const op = d.childForFieldName("operator")?.type;
          if (this.options.cpp && (op === "<<" || op === ">>") && this.isStream(leftmost(d), op)) out.io = true;
          return true;
        }
        default:
          return true;
      }
    });
    return out;
  }

  private isStream(n: Node, op: string): boolean {
    const want = op === "<<" ? "cout" : "cin";
    const text = n.text.replace(/\s+/g, "");
    return text === `std::${want}` || (this.std && n.type === "identifier" && text === want);
  }

  private decision(cond: Node | null, at: Node): number {
    const text = cond ? unparen(cond.text) : "";
    return this.b.node("decision", text, lineOf(at), cond ? endLineOf(cond) : lineOf(at), { condition: true });
  }

  /** if / else if / else, read as a chain so a long else-if ladder doesn't count as nesting. */
  private ifChain(n: Node): Step {
    const chain: { cond: number; yes: Step }[] = [];
    let elseStep: Step = empty();
    let cur: Node | null = n;
    while (cur) {
      const cond = this.decision(cur.childForFieldName("condition"), cur);
      chain.push({ cond, yes: this.nested(cur.childForFieldName("consequence")) });
      const alt = cur.childForFieldName("alternative");
      const inner: Node | null = alt ? (codeChildren(alt)[0] ?? null) : null;
      if (inner?.type === "if_statement") {
        cur = inner;
      } else {
        elseStep = this.nested(inner);
        cur = null;
      }
    }
    let step = elseStep;
    for (let i = chain.length - 1; i >= 0; i--) step = { t: "if", cond: chain[i].cond, yes: chain[i].yes, no: step };
    return step;
  }

  private loop(n: Node, post: boolean): Step {
    if (post) {
      const body = this.nested(n.childForFieldName("body"));
      const cond = this.decision(n.childForFieldName("condition"), n.childForFieldName("condition") ?? n);
      return { t: "loop", post: true, cond, body, update: null, orelse: null, line: lineOf(n) };
    }
    const cond = this.decision(n.childForFieldName("condition"), n);
    return { t: "loop", post: false, cond, body: this.nested(n.childForFieldName("body")), update: null, orelse: null, line: lineOf(n) };
  }

  /** for (init; test; update): init, test and update are their own boxes; no test loops forever. */
  private forLoop(n: Node): Step {
    const init = n.childForFieldName("initializer");
    const test = n.childForFieldName("condition");
    const update = n.childForFieldName("update");
    const items: Step[] = [];
    if (init) items.push(this.box("process", withoutSemicolon(init.text), init));
    const cond = test ? this.b.node("decision", test.text, lineOf(test), endLineOf(test), { condition: true }) : null;
    const body = this.nested(n.childForFieldName("body"));
    const upd = update ? this.box("process", update.text, update) : null;
    items.push({ t: "loop", post: false, cond, body, update: upd, orelse: null, line: lineOf(n) });
    return { t: "seq", items };
  }

  /** C++ `for (int x : v)`: a test "for (int x : v) ?" that is Yes while there is a next item. */
  private rangeFor(n: Node): Step {
    const body = n.childForFieldName("body");
    const header = body ? n.text.slice(0, n.text.length - body.text.length) : n.text;
    const cond = this.b.node("decision", header, lineOf(n), body ? lineOf(body) : lineOf(n), { condition: true });
    return { t: "loop", post: false, cond, body: this.nested(body), update: null, orelse: null, line: lineOf(n) };
  }

  private switchStmt(n: Node): Step {
    const cond = this.decision(n.childForFieldName("condition"), n);
    const raw = codeChildren(n.childForFieldName("body") ?? n).filter((c) => c.type === "case_statement");
    const cases: SwitchCase[] = [];
    let labels: string[] = [];
    raw.forEach((c, i) => {
      const value = c.childForFieldName("value");
      labels.push(value ? value.text.replace(/\s+/g, " ") : "default");
      const stmts = codeChildren(c).filter((s) => s.id !== value?.id);
      const last = i === raw.length - 1;
      // Stacked labels (case 1: case 2: ...) share the next body.
      if (stmts.length === 0 && !last) return;
      let exit: SwitchCase["exit"] = last ? "break" : "fall";
      if (stmts.at(-1)?.type === "break_statement") {
        stmts.pop();
        exit = "break";
      }
      const body: Step = this.b.nest(() => ({ t: "seq", items: stmts.map((s) => this.stmt(s)) }));
      cases.push({ label: labels.join(", "), body, exit });
      labels = [];
    });
    if (!cases.some((c) => c.label.split(", ").includes("default"))) cases.push({ label: "default", body: empty(), exit: "break" });
    return { t: "switch", cond, cases };
  }
}

/** The called function's own name: f, ns::f -> f, obj.f -> f, f<int> -> f. */
function calleeName(fn: Node | null): string | null {
  for (let n = fn, i = 0; n && i < 8; i++) {
    switch (n.type) {
      case "identifier":
      case "field_identifier":
        return n.text;
      case "qualified_identifier":
        n = n.childForFieldName("name");
        break;
      case "field_expression":
        n = n.childForFieldName("field");
        break;
      case "template_function":
        n = n.childForFieldName("name");
        break;
      case "parenthesized_expression":
        n = codeChildren(n)[0] ?? null;
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The leftmost operand of a chain like `a << b << c`. */
function leftmost(n: Node): Node {
  let cur = n;
  for (let i = 0; i < 10_000 && cur.type === "binary_expression"; i++) {
    const left = cur.childForFieldName("left");
    if (!left) break;
    cur = left;
  }
  return cur;
}
