// Checks for anything that enters CodeEditor from outside: files opened from disk, imported
// zips and files pulled from GitHub. (Adapted from Pocket Run, same author, MIT.) "Malicious"
// here means content that isn't what it claims to be, or that hides what the code really does:
//   - executables, archives and other binary files renamed to source extensions,
//   - text that isn't valid UTF-8, or that contains control characters,
//   - "Trojan Source" direction controls that make code display differently from how it runs
//     (CVE-2021-42574), and invisible characters that hide parts of names or strings,
//   - files too large to edit comfortably.
// Running code is contained separately (worker sandbox, time and output limits, lockdown.ts).

import { decodeFileBytes, type Eol } from "./bytes";

/** One workspace file. 1 MiB is also the largest file the GitHub sync sends inline. */
export const MAX_FILE_BYTES = 1024 * 1024;

export type Checked =
  | { ok: true; text: string; hidden: number; eol: Eol; bom: boolean }
  | { ok: false; reason: string };
export type CheckedText = { ok: true; text: string; hidden: number } | { ok: false; reason: string };

/** File signatures ("magic numbers") of formats that are never source code. */
const SIGNATURES: [string, number[]][] = [
  ["a Windows program (.exe/.dll)", [0x4d, 0x5a]],
  ["a Linux program (ELF)", [0x7f, 0x45, 0x4c, 0x46]],
  ["a macOS program (Mach-O)", [0xcf, 0xfa, 0xed, 0xfe]],
  ["a macOS program (Mach-O)", [0xce, 0xfa, 0xed, 0xfe]],
  ["a Java class or macOS universal program", [0xca, 0xfe, 0xba, 0xbe]],
  ["a ZIP archive (or .apk/.jar/.docx)", [0x50, 0x4b, 0x03, 0x04]],
  ["a RAR archive", [0x52, 0x61, 0x72, 0x21]],
  ["a 7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf]],
  ["a gzip archive", [0x1f, 0x8b]],
  ["a PDF document", [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ["an Office document", [0xd0, 0xcf, 0x11, 0xe0]],
  ["a WebAssembly binary", [0x00, 0x61, 0x73, 0x6d]],
  ["a PNG image", [0x89, 0x50, 0x4e, 0x47]],
  ["a JPEG image", [0xff, 0xd8, 0xff]],
  ["a GIF image", [0x47, 0x49, 0x46, 0x38]],
];

/** Names the binary format `bytes` starts with, or null if it doesn't look like one. */
export function binaryKind(bytes: Uint8Array): string | null {
  // Signatures made of printable letters ("MZ", "PK", "%PDF-", "GIF8") can also start real source
  // ("MZ = 3"). Real binaries of those formats have NUL bytes near the start; source never does.
  const nulNearStart = bytes.subarray(0, 1024).includes(0);
  for (const [kind, sig] of SIGNATURES) {
    const printable = sig.every((b) => b >= 0x20 && b < 0x7f);
    if (bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b) && (!printable || nulNearStart)) return kind;
  }
  return null;
}

// Control characters other than tab, line feed, form feed and carriage return.
export const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;
// Direction overrides, embeddings and isolates: the Trojan Source characters.
export const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/;
// Invisible characters that can hide inside names and strings. (Zero-width joiners U+200C and
// U+200D are left alone: Hindi and other Indic scripts need them.)
export const HIDDEN = /[\u00ad\u115f\u1160\u180e\u200b\u200e\u200f\u2060\u3164\uffa0\ufeff]/g;

/** Checks text that will become code in the editor. */
export function checkText(text: string): CheckedText {
  if (CONTROL.test(text)) return { ok: false, reason: "it contains control characters, so it is probably not a text file" };
  if (BIDI_CONTROL.test(text)) {
    return { ok: false, reason: "it contains hidden text-direction characters, which can make code look different from what it does (a \u201cTrojan Source\u201d trick)" };
  }
  return { ok: true, text, hidden: text.match(HIDDEN)?.length ?? 0 };
}

/**
 * Decodes and checks a file's bytes: rejects binaries, invalid UTF-8, mixed line endings and
 * control characters (NUL included). The text comes back with LF line endings; `eol` and `bom`
 * record the original form so saving or syncing can restore the exact bytes.
 */
export function checkBytes(bytes: Uint8Array): Checked {
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, reason: `it is ${Math.round(bytes.length / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB` };
  const kind = binaryKind(bytes);
  if (kind) return { ok: false, reason: `it is ${kind}, not source code` };
  const decoded = decodeFileBytes(bytes);
  if (!decoded.ok) return decoded;
  const checked = checkText(decoded.text);
  return checked.ok ? { ...checked, eol: decoded.eol, bom: decoded.bom } : checked;
}

/** Removes the invisible characters counted in `Checked.hidden`. */
export function removeHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Makes a file name safe to show and save: no path separators, reserved or control characters,
 * no direction tricks ("main\u202eyp.exe" shows as "mainexe.py"), and not a reserved Windows name.
 */
export function cleanFilename(name: string): string {
  const cleaned = name
    .replace(new RegExp(BIDI_CONTROL.source, "g"), "")
    .replace(HIDDEN, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100);
  if (!cleaned) return "untitled";
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}
