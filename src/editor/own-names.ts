// The names a file declares, read from its syntax tree (no types and no scopes, only file level):
// - C and C++ (@lezer/cpp 1.1.6 node names): functions, structs, unions, classes, enums and their
//   enumerators, typedefs and `using` aliases, globals and #define macros, at file level and inside
//   extern "C" blocks and templates; and the file's quoted #include spellings, which the include
//   closure follows (own-completion.ts). Names inside namespaces, members and locals stay out.
// - Python (lang-python 6.2.1's grammar): a module's top-level defs, classes and assignments, which
//   `import helpers` then `helpers.` lists.
// Each walk is a generator that yields once per top-level item (null when the item declares
// nothing), so workspace-index.ts can stop it at the end of an idle slice and go on later.
// This file is in the completion chunk (completion-code.ts).

import type { Completion } from "@codemirror/autocomplete";
import type { syntaxTree } from "@codemirror/language";
import { BIDI_CONTROL, CONTROL, HIDDEN } from "../core/safety";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** Reads the file's text between two offsets. */
export type Slice = (from: number, to: number) => string;

/** CodeMirror icon kinds own names use. */
export type OwnKind = "function" | "class" | "enum" | "constant" | "variable" | "type";

export interface OwnName {
  label: string;
  type: OwnKind;
  /** What the name is, in words ("Function", "Struct", "Enum constant", "Macro"): the info line says it. */
  what: string;
  /** The declaration up to its body, on one line, capped (DETAIL_MAX). */
  detail: string;
  /** Where the name itself is: the word being typed is left out by its position. */
  from: number;
  to: number;
}

/** The longest detail, in characters, before it is cut with "...". */
export const DETAIL_MAX = 60;

/**
 * Direction controls, hidden characters and control characters (core/safety.ts). Imports refuse
 * files with the first, but text typed or pasted into a file can hold any of them, and in a
 * suggestion nothing marks them (the editor shows them as a red dot): they would reorder or hide
 * what the list shows (review finding S1, 2026-10-19). A detail drops them; a name holding one is
 * left out, because accepting it would type the hidden character.
 */
const UNSAFE_SOURCE = `${BIDI_CONTROL.source}|${HIDDEN.source}|${CONTROL.source}`;
const UNSAFE_ALL = new RegExp(UNSAFE_SOURCE, "g");
const UNSAFE = new RegExp(UNSAFE_SOURCE);

/** Whether a label can be offered: it holds no character UNSAFE matches. */
export function safeLabel(label: string): boolean {
  return !UNSAFE.test(label);
}

function safeName(name: OwnName): boolean {
  return safeLabel(name.label);
}

/**
 * `from`..`to` as one line: unsafe characters dropped (UNSAFE), whitespace (newlines too)
 * collapsed, a closing `;` or `{` dropped (unless `whole`, for a macro's value), cut at
 * DETAIL_MAX. Only a bounded part of the text is read, so a long initializer costs nothing.
 */
export function oneLine(slice: Slice, from: number, to: number, whole = false): string {
  let text = slice(from, Math.min(to, from + DETAIL_MAX * 4)).replace(UNSAFE_ALL, "").replace(/\s+/g, " ").trim();
  if (!whole) text = text.replace(/\s*[;{]$/, "");
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 3).trimEnd()}...` : text;
}

function name(slice: Slice, id: SyntaxNode, type: OwnKind, what: string, detail: string): OwnName {
  return { label: slice(id.from, id.to), type, what, detail, from: id.from, to: id.to };
}

const optionCache = new WeakMap<readonly OwnName[], { where: string; options: readonly Completion[] }>();

/**
 * Suggestions for `names` declared in `where` (a workspace path), one per name, in order: the
 * detail is the declaration, the info our own line ("Function in util.h"). Made once per list.
 */
export function ownOptions(names: readonly OwnName[], where: string): readonly Completion[] {
  const cached = optionCache.get(names);
  if (cached?.where === where) return cached.options;
  const options = names.map((n) => ({ label: n.label, type: n.type, detail: n.detail, info: `${n.what} in ${where}` }));
  optionCache.set(names, { where, options });
  return options;
}

// ---------------------------------------------------------------- C and C++

/** Nodes a declarator can be (the name, or a wrapper around the declarator inside it). */
const DECLARATORS = new Set([
  "Identifier", "TypeIdentifier", "PointerDeclarator", "FunctionDeclarator", "ArrayDeclarator", "ParenthesizedDeclarator",
  "ReferenceDeclarator", "ScopedIdentifier", "OperatorName", "DestructorName", "TemplateFunction", "StructuredBindingDeclarator",
]);
/** Declarators that wrap another declarator (its first DECLARATORS child). */
const WRAPPERS = new Set(["PointerDeclarator", "FunctionDeclarator", "ArrayDeclarator", "ParenthesizedDeclarator", "ReferenceDeclarator", "InitDeclarator"]);
/** Qualifiers a typedef can have before its type. */
const QUALIFIERS = new Set(["typedef", "const", "volatile", "restrict", "_Atomic", "mutable", "constexpr", "constinit", "consteval"]);
/** Type specifiers that can have a body, and the word for each. */
const TAGGED: Readonly<Record<string, { body: string; what: string; type: OwnKind }>> = {
  StructSpecifier: { body: "FieldDeclarationList", what: "Struct", type: "class" },
  UnionSpecifier: { body: "FieldDeclarationList", what: "Union", type: "class" },
  ClassSpecifier: { body: "FieldDeclarationList", what: "Class", type: "class" },
  EnumSpecifier: { body: "EnumeratorList", what: "Enum", type: "enum" },
};

function firstDeclarator(node: SyntaxNode): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (DECLARATORS.has(c.name)) return c;
  return null;
}

/**
 * The name a declarator declares, and whether it names a function: the name sits right inside a
 * FunctionDeclarator (`int *make(void)` is a function, `void (*handler)(int)` a pointer variable).
 * Null for a qualified name (`Dog::bark`), an operator or a destructor: none is a file-level name.
 */
function declared(declarator: SyntaxNode): { id: SyntaxNode; fn: boolean } | null {
  let wrapper = "";
  for (let n: SyntaxNode | null = declarator; n; n = firstDeclarator(n)) {
    if (n.name === "Identifier" || n.name === "TypeIdentifier") return { id: n, fn: wrapper === "FunctionDeclarator" };
    if (!WRAPPERS.has(n.name)) return null;
    wrapper = n.name;
  }
  return null;
}

/** A struct, union, class or enum with a body: its tag and, for an enum, its enumerators. */
function* tagged(spec: SyntaxNode, slice: Slice): Generator<OwnName> {
  const kind = TAGGED[spec.name];
  const body = kind && spec.getChild(kind.body);
  if (!body) return; // `struct point p;` uses a type, it doesn't define one
  const head = oneLine(slice, spec.from, body.from);
  const tag = spec.getChild("TypeIdentifier");
  if (tag) yield name(slice, tag, kind.type, kind.what, head);
  if (spec.name !== "EnumSpecifier") return;
  for (const e of body.getChildren("Enumerator")) {
    const id = e.getChild("Identifier");
    if (id) yield name(slice, id, "constant", "Enum constant", head);
  }
}

/** A #define's name (an empty one, like a header guard, names nothing to type), or a quoted #include. */
function directive(node: SyntaxNode, slice: Slice, includes: string[] | undefined): OwnName | null {
  const keyword = node.firstChild?.name;
  if (keyword === "#include") {
    const path = node.getChild("String");
    const text = path ? slice(path.from, path.to) : "";
    if (includes && /^"[^"\n]+"$/.test(text)) includes.push(text.slice(1, -1));
    return null;
  }
  if (keyword !== "#define") return null;
  const id = node.getChild("Identifier");
  if (!id) return null;
  const callable = slice(id.to, id.to + 1) === "(";
  if (!callable && !node.getChild("PreprocArg")) return null;
  return name(slice, id, callable ? "function" : "constant", "Macro", oneLine(slice, node.from, node.to, true));
}

/** One file-level item of a C or C++ file. */
function* cItem(item: SyntaxNode, slice: Slice, includes: string[] | undefined): Generator<OwnName> {
  switch (item.name) {
    case "PreprocDirective": {
      const found = directive(item, slice, includes);
      if (found) yield found;
      return;
    }
    case "FunctionDefinition": {
      let body: SyntaxNode | null = null;
      for (let c = item.firstChild; c; c = c.nextSibling) {
        if (TAGGED[c.name]) yield* tagged(c, slice);
        else if (c.name === "CompoundStatement" || c.name === "TryStatement") body = c;
      }
      // The return type can be a TypeIdentifier; the declarator is the first other one.
      let declarator: SyntaxNode | null = null;
      for (let c = item.firstChild; c && !declarator; c = c.nextSibling) if (DECLARATORS.has(c.name) && c.name !== "TypeIdentifier") declarator = c;
      const found = declarator && declared(declarator);
      if (found?.fn) yield name(slice, found.id, "function", "Function", oneLine(slice, item.from, body ? body.from : item.to));
      return;
    }
    case "Declaration": {
      const detail = oneLine(slice, item.from, item.to);
      for (let c = item.firstChild; c; c = c.nextSibling) {
        if (TAGGED[c.name]) yield* tagged(c, slice);
        // In a declaration a TypeIdentifier is the type: declarators name Identifiers.
        else if ((DECLARATORS.has(c.name) && c.name !== "TypeIdentifier") || c.name === "InitDeclarator") {
          const found = declared(c);
          if (found && found.id.name === "Identifier") {
            yield name(slice, found.id, found.fn ? "function" : "variable", found.fn ? "Function" : "Variable", detail);
          }
        }
      }
      return;
    }
    case "TypeDefinition": {
      const detail = oneLine(slice, item.from, item.to);
      let typeSeen = false;
      for (let c = item.firstChild; c; c = c.nextSibling) {
        if (QUALIFIERS.has(c.name)) continue;
        if (!typeSeen) {
          // The first thing after typedef and its qualifiers is the type, which may be defined here.
          typeSeen = true;
          if (TAGGED[c.name]) yield* tagged(c, slice);
          continue;
        }
        const found = DECLARATORS.has(c.name) ? declared(c) : null;
        if (found && found.id.name === "TypeIdentifier") yield name(slice, found.id, "type", "Type", detail);
      }
      return;
    }
    case "AliasDeclaration": {
      const id = item.getChild("TypeIdentifier");
      if (id) yield name(slice, id, "type", "Type", oneLine(slice, item.from, item.to));
      return;
    }
    case "LinkageSpecification":
    case "TemplateDeclaration":
    case "CompoundStatement": // the braces of extern "C" { ... }
      for (let c = item.firstChild; c; c = c.nextSibling) yield* cItem(c, slice, includes);
      return;
    default:
      if (TAGGED[item.name]) yield* tagged(item, slice); // `struct point { ... };`
  }
}

/**
 * The file-level names of a C or C++ syntax tree (`top`, its Program node), in order. When
 * `includes` is given, the quoted #include spellings found on the way are pushed onto it.
 */
export function* cFileNames(top: SyntaxNode, slice: Slice, includes?: string[]): Generator<OwnName | null> {
  for (let item = top.firstChild; item; item = item.nextSibling) {
    let any = false;
    for (const found of cItem(item, slice, includes)) {
      if (!safeName(found)) continue;
      any = true;
      yield found;
    }
    if (!any) yield null;
  }
}

// ---------------------------------------------------------------- Python

/** A Python module's top-level defs, classes (decorated ones too) and assigned names, in order. */
export function* pyModuleNames(top: SyntaxNode, slice: Slice): Generator<OwnName | null> {
  for (let item = top.firstChild; item; item = item.nextSibling) {
    const def = item.name === "DecoratedStatement" ? (item.getChild("FunctionDefinition") ?? item.getChild("ClassDefinition")) : item;
    if (def && (def.name === "FunctionDefinition" || def.name === "ClassDefinition")) {
      const id = def.getChild("VariableName");
      const body = def.getChild("Body");
      const fn = def.name === "FunctionDefinition";
      const found = id ? name(slice, id, fn ? "function" : "class", fn ? "Function" : "Class", oneLine(slice, def.from, body ? body.from : def.to)) : null;
      yield found && safeName(found) ? found : null;
    } else if (item.name === "AssignStatement") {
      // The targets: names before the last `=` (`a = b = 1`, `a, b = 1, 2`), or before the annotation.
      const children: SyntaxNode[] = [];
      for (let c = item.firstChild; c; c = c.nextSibling) children.push(c);
      let end = children.map((c) => c.name).lastIndexOf("AssignOp");
      if (end < 0) end = children.findIndex((c) => c.name === "TypeDef");
      const detail = oneLine(slice, item.from, item.to);
      let any = false;
      for (const c of children.slice(0, Math.max(0, end))) {
        if (c.name !== "VariableName") continue;
        const found = name(slice, c, "variable", "Variable", detail);
        if (!safeName(found)) continue;
        any = true;
        yield found;
      }
      if (!any) yield null;
    } else {
      yield null;
    }
  }
}
