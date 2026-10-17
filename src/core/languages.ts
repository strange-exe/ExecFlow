export type LanguageId = "python" | "c" | "cpp";

export interface Language {
  id: LanguageId;
  label: string;
  extensions: readonly string[];
  defaultFilename: string;
  sample: string;
}

export const LANGUAGES: readonly Language[] = [
  {
    id: "python",
    label: "Python",
    extensions: [".py", ".pyw"],
    defaultFilename: "main.py",
    sample: 'name = input("Your name: ")\nprint(f"Hello, {name}!")\n',
  },
  {
    id: "c",
    label: "C",
    extensions: [".c"],
    defaultFilename: "main.c",
    sample: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n',
  },
  {
    id: "cpp",
    label: "C++",
    extensions: [".cpp", ".cc", ".cxx", ".c++"],
    defaultFilename: "main.cpp",
    sample: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!\\n";\n}\n',
  },
];

/** Every extension the file picker should offer, e.g. ".py,.c,.cpp". */
export const ACCEPTED_EXTENSIONS = LANGUAGES.flatMap((l) => l.extensions).join(",");

export function extensionOf(filename: string): string {
  const name = filename.trim();
  const dot = name.lastIndexOf(".");
  // A leading dot (".bashrc") is a hidden-file name, not an extension.
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function detectLanguage(filename: string): Language | null {
  const ext = extensionOf(filename);
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}

export function languageById(id: LanguageId): Language {
  return LANGUAGES.find((l) => l.id === id)!;
}

/** C and C++ headers. They are sent to the compiler but never compiled on their own. */
export const HEADER_EXTENSIONS: readonly string[] = [".h", ".hh", ".hpp", ".hxx", ".inc"];

export function isHeader(filename: string): boolean {
  return HEADER_EXTENSIONS.includes(extensionOf(filename));
}

/** Grammar for highlighting: the file's own language, or C++ for headers (it also covers C). */
export function editorLanguage(filename: string): LanguageId | null {
  return detectLanguage(filename)?.id ?? (isHeader(filename) ? "cpp" : null);
}
