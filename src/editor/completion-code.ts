// The completion chunk's entry: every suggestion source and the loaders that go with them
// (completion-loader.ts loads this module with import(); language-support.ts picks from it).
// Rolldown makes this module and everything only it reaches one lazy chunk: keywords and
// snippets, the library and own-name sources, the workspace index and the syntax-tree walks. The
// library data (library-data.ts) are lazy chunks of their own again.
//
// The completion code runs only inside the editor, and this import says so to the bundler: it
// depends on the editor chunk's entry, so every module the editor uses stays in the editor chunk.
// Without it Rolldown put the modules both chunks use (CodeMirror's core, the grammars) into a
// common chunk of their own, because it makes one for any module two entries import, import()
// entries included (rolldown.rs/in-depth/automatic-code-splitting): opening a file then loaded two
// editor chunks, 172.82 + 27.86 kB gzip (measured 2026-10-19). The module is already evaluated
// when this chunk loads, so the import runs nothing. completion-chunk.test.ts checks it is here.
import "./editor-manager";

export { C_KEYWORDS, cKeywords, CPP_KEYWORDS, cppKeywords, pythonGlobals, pythonLocalNames, wordSource } from "./keyword-completion";
export { cLibrarySource, includeLineSource, includeSource, libraryLoader, pythonMemberSource, pythonModuleSource, stdSource } from "./library-completion";
export { cOwnSource, ownNamesLoader } from "./own-completion";
