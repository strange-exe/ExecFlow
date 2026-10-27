// Python source to flow models (tree-sitter-python trees). The file's top level is the first chart
// ("Program"); every function and method gets its own ("area", "Shape.area"). Definitions are not
// steps of the code around them. Input/output is print() and input().
import type { Node } from "web-tree-sitter";
import { FlowBuilder, ONE_STEP, TooBig, empty, type ChartResult, type ChartStub, type FlowFile, type Step } from "./model";
import { pickIndex, type Pick } from "./pick";
import { codeChildren, endLineOf, firstErrorLine, firstLine, forEachDescendant, lineOf, withoutSemicolon } from "./walk";

const IO = new Set(["print", "input"]);
/** The top level's chart name. */
export const PROGRAM = "Program";

const DEFINITIONS = new Set(["function_definition", "class_definition", "decorated_definition"]);

interface FnDef {
  name: string;
  simple: string;
  node: Node;
  body: Node;
}

/** A decorated definition's own def or class. */
const definition = (n: Node): Node | null => (n.type === "decorated_definition" ? n.childForFieldName("definition") : n);

/** Functions at the top level and methods in classes (nested classes too), in source order. */
function collectFunctions(root: Node): FnDef[] {
  const out: FnDef[] = [];
  const stack: { node: Node; prefix: string }[] = [{ node: root, prefix: "" }];
  while (stack.length) {
    const { node, prefix } = stack.pop()!;
    for (const child of codeChildren(node)) {
      const def = definition(child);
      if (!def) continue;
      const name = def.childForFieldName("name")?.text;
      const body = def.childForFieldName("body");
      if (!name || !body) continue;
      if (def.type === "function_definition") out.push({ name: prefix + name, simple: name, node: child, body });
      else if (def.type === "class_definition") stack.push({ node: body, prefix: `${prefix}${name}.` });
    }
  }
  return out.sort((a, b) => a.node.startIndex - b.node.startIndex);
}

export function chartPython(root: Node, _source: string, pick: Pick | null | "all" = "all"): FlowFile {
  const fns = collectFunctions(root);
  const names = new Map<string, string>();
  for (const f of fns) if (!names.has(f.simple)) names.set(f.simple, f.name);
  const chart = (name: string, from: number, to: number, read: (w: PyWalker) => Step): ChartResult => {
    const b = new FlowBuilder(name, from, to);
    try {
      return { ok: true, ...b.finish(read(new PyWalker(b, names))) };
    } catch (e) {
      if (e instanceof TooBig) return { ok: false, name, from, to, tooBig: e.message };
      throw e;
    }
  };
  // The module body first, then each function; with a pick, only the picked one is charted.
  const list = [
    { name: PROGRAM, from: 1, to: Math.max(1, endLineOf(root)), read: (w: PyWalker) => w.block(root, true) },
    ...fns.map((f) => ({ name: f.name, from: lineOf(f.node), to: endLineOf(f.node), read: (w: PyWalker) => w.block(f.body, false) })),
  ];
  const only = pick === "all" ? -1 : pickIndex(list, pick);
  const charts: (ChartResult | ChartStub)[] = list.map((c, i) => (only >= 0 && i !== only ? { ok: null, name: c.name, from: c.from, to: c.to } : chart(c.name, c.from, c.to, c.read)));
  const file: FlowFile = { charts };
  const error = firstErrorLine(root);
  if (error !== undefined) file.syntaxError = error;
  return file;
}

class PyWalker {
  constructor(
    private readonly b: FlowBuilder,
    private readonly names: Map<string, string>,
  ) {}

  /** A block's statements; at the top level, definitions are left out (they have their own charts). */
  block(n: Node, topLevel: boolean): Step {
    const items = codeChildren(n)
      .filter((c) => !(topLevel && DEFINITIONS.has(c.type)))
      .map((c) => this.stmt(c));
    return { t: "seq", items };
  }

  private nested(n: Node | null): Step {
    return n ? this.b.nest(() => this.block(n, false)) : empty();
  }

  private stmt(n: Node): Step {
    switch (n.type) {
      case "expression_statement": {
        const parts = codeChildren(n);
        // A bare string (a docstring) does nothing.
        if (parts.length === 1 && (parts[0].type === "string" || parts[0].type === "concatenated_string")) return empty();
        return this.simple(n);
      }
      case "if_statement":
        return this.ifChain(n);
      case "while_statement": {
        const cond = this.b.node("decision", n.childForFieldName("condition")?.text ?? "", lineOf(n), lineOf(n), { condition: true });
        return { t: "loop", post: false, cond, body: this.nested(n.childForFieldName("body")), update: null, orelse: this.orelse(n), line: lineOf(n) };
      }
      case "for_statement": {
        const left = n.childForFieldName("left")?.text ?? "";
        const right = n.childForFieldName("right")?.text ?? "";
        const cond = this.b.node("decision", `for ${left} in ${right}`, lineOf(n), lineOf(n), { condition: true });
        return { t: "loop", post: false, cond, body: this.nested(n.childForFieldName("body")), update: null, orelse: this.orelse(n), line: lineOf(n) };
      }
      case "break_statement":
        return { t: "break" };
      case "continue_statement":
        return { t: "continue" };
      case "pass_statement":
      case "ERROR":
        return empty();
      case "return_statement":
      case "raise_statement":
        return { t: "end", id: this.b.node("end", withoutSemicolon(n.text), lineOf(n), endLineOf(n)) };
      case "try_statement":
      case "with_statement":
      case "match_statement":
      case "function_definition":
      case "class_definition":
      case "decorated_definition":
        return this.oneStep(n);
      default:
        return n.text.includes("\n") && !n.type.endsWith("statement") ? this.oneStep(n) : this.simple(n);
    }
  }

  private orelse(n: Node): Step | null {
    const alt = n.childForFieldName("alternative");
    return alt ? this.nested(alt.childForFieldName("body")) : null;
  }

  private oneStep(n: Node): Step {
    return { t: "node", id: this.b.node("process", firstLine(n.text), lineOf(n), endLineOf(n), { note: ONE_STEP }) };
  }

  private simple(n: Node): Step {
    const text = withoutSemicolon(n.text);
    let io = false;
    let lambda = false;
    let callee: string | undefined;
    forEachDescendant(n, (d) => {
      if (d.type === "lambda") {
        lambda = true;
        return false;
      }
      if (d.type === "call") {
        const fn = d.childForFieldName("function");
        const name = fn?.type === "identifier" ? fn.text : fn?.type === "attribute" ? (fn.childForFieldName("attribute")?.text ?? null) : null;
        if (name !== null) {
          if (fn!.type === "identifier" && IO.has(name)) io = true;
          if (callee === undefined && this.names.has(name)) callee = this.names.get(name);
        }
      }
      return true;
    });
    if (lambda) return this.oneStep(n);
    const at = (kind: "process" | "io" | "call", options = {}) => ({ t: "node" as const, id: this.b.node(kind, text, lineOf(n), endLineOf(n), options) });
    if (callee !== undefined) return at("call", { callee });
    if (io) return at("io");
    return at("process", { simple: true });
  }

  /** if / elif / else as a chain, so a long elif ladder doesn't count as nesting. */
  private ifChain(n: Node): Step {
    const chain: { cond: number; yes: Step }[] = [];
    const arm = (clause: Node) => {
      const cond = this.b.node("decision", clause.childForFieldName("condition")?.text ?? "", lineOf(clause), lineOf(clause), { condition: true });
      chain.push({ cond, yes: this.nested(clause.childForFieldName("consequence")) });
    };
    arm(n);
    let elseStep: Step = empty();
    for (const c of codeChildren(n)) {
      if (c.type === "elif_clause") arm(c);
      else if (c.type === "else_clause") elseStep = this.nested(c.childForFieldName("body"));
    }
    let step = elseStep;
    for (let i = chain.length - 1; i >= 0; i--) step = { t: "if", cond: chain[i].cond, yes: chain[i].yes, no: step };
    return step;
  }
}
