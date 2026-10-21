// The completion chunk's entry: the library and own-name sources and the loaders that go with them
// (completion-loader.ts loads this module with import(); language-support.ts picks from it).
// Rolldown makes this module and everything only it reaches one lazy chunk: the library and
// own-name sources, the workspace index and the syntax-tree walks. The library data
// (library-data.ts) are lazy chunks of their own again. Keywords and snippets
// (keyword-completion.ts) are the editor chunk's, so they are offered even when this chunk can't load.
//
// The completion code runs only inside the editor, and this import says so to the bundler: it
// depends on the editor chunk's entry, so every module the editor uses stays in the editor chunk.
// Without it Rolldown put the modules both chunks use (CodeMirror's core, the grammars) into a
// common chunk of their own, because it makes one for any module two entries import, import()
// entries included (rolldown.rs/in-depth/automatic-code-splitting): opening a file then loaded two
// editor chunks, 172.82 + 27.86 kB gzip (measured 2026-10-19). The module is already evaluated
// when this chunk loads, so the import runs nothing. completion-chunk.test.ts checks it is here.
import "./editor-manager";

export {
  cLibrarySource, includeSource, libraryLoader, pythonBuiltins, pythonMemberSource, pythonModuleSource, stdSource, usingStdSource,
} from "./library-completion";
export { cOwnSource, ownNamesLoader, pythonLocalNames } from "./own-completion";
