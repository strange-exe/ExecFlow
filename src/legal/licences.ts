// The Licences page (licenses.html) and /licenses.txt are written from one list at build time
// (vite.config.ts thirdPartyLicenses). Pure and Node-safe: no DOM here, and every text that came
// from a licence file goes into the page escaped, never as markup.

export interface LicenceEntry {
  /** What it is, as the plain-text file names it ("@codemirror/view 6.38.6", "LLVM 22: clang and lld, ..."). */
  name: string;
  /** The licence text itself, trimmed, LF line ends. */
  text: string;
}

/**
 * The licence a text is under, in words, read from its wording (first match wins: the LLVM
 * exception before plain Apache, the BSD clauses by whether the name clause is there). A text no
 * rule knows is "Other licence": the page still shows it in full.
 */
export function licenceKind(text: string): string {
  const t = text.replace(/\s+/g, " ");
  if (/Apache License.{0,40}with LLVM Exceptions|LLVM Exceptions to the Apache 2\.0 License/i.test(t)) return "Apache 2.0 with LLVM exceptions";
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache 2.0";
  if (/Mozilla Public License,? (version|v\.?) ?2\.0/i.test(t)) return "MPL 2.0";
  if (/SIL OPEN FONT LICENSE/i.test(t)) return "SIL Open Font 1.1";
  if (/PYTHON SOFTWARE FOUNDATION LICENSE/i.test(t)) return "Python (PSF)";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name|names of (its|the) contributors may be used/i.test(t) ? "BSD 3-clause" : "BSD 2-clause";
  // Any quote mark round as-is (straight or curly): "." stands for it, so this file stays ASCII.
  if (/provided .as-is.*altered source versions/i.test(t)) return "zlib";
  return "Other licence";
}

/** The plain-text file: its heading, the notes, ExecFlow's licence and then every other one. */
export function licencesText(intro: readonly string[], notes: readonly string[], entries: readonly LicenceEntry[]): string {
  const rule = "=".repeat(78);
  return [...intro, "", ...notes.map((n) => `- ${n}`), "", ...entries.flatMap(({ name, text }, i) => [...(i ? [""] : []), rule, name, rule, text]), ""].join("\n");
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** "@codemirror/view 6.38.6" into its name and version; a descriptive name has no version. */
export function splitName(name: string): { name: string; version: string | null } {
  const m = /^((?:@[\w.-]+\/)?[\w.-]+) (\d+\.\d+[\w.+-]*)$/.exec(name);
  return m ? { name: m[1]!, version: m[2]! } : { name, version: null };
}

/** How many entries each licence covers, most first (ties by name), e.g. [["MIT", 30], ...]. */
export function kindCounts(entries: readonly LicenceEntry[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(licenceKind(e.text), (counts.get(licenceKind(e.text)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The summary line: "41 licences: 30 MIT, 5 Apache 2.0 and 1 zlib." */
export function summaryLine(entries: readonly LicenceEntry[]): string {
  const parts = kindCounts(entries).map(([k, n]) => `${n} ${k}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  return `${entries.length} licence texts: ${list}.`;
}

/**
 * The page's list: one item per entry, each a native disclosure (works with no script) whose
 * summary names it, its version and its licence, and whose body is the full text. ids are
 * lic-<n>, so a link can open one. data-filter holds what the find box matches against.
 */
export function licencesListHtml(entries: readonly LicenceEntry[]): string {
  return entries
    .map((e, i) => {
      const { name, version } = splitName(e.name);
      const kind = licenceKind(e.text);
      const filter = `${e.name} ${kind}`.toLowerCase();
      return [
        `<li class="lic" id="lic-${i + 1}" data-filter="${escapeHtml(filter)}">`,
        `<details><summary>`,
        `<span class="lic-name">${escapeHtml(name)}</span>`,
        version ? `<span class="lic-ver">${escapeHtml(version)}</span>` : "",
        `<span class="lic-kind">${escapeHtml(kind)}</span>`,
        `</summary><pre class="lic-text">${escapeHtml(e.text)}</pre></details></li>`,
      ].join("");
    })
    .join("\n");
}
