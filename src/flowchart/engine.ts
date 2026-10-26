// The flowchart engine: loads the tree-sitter runtime and a language's grammar on demand, checks
// each file's sha256 (src/flowchart/pack.ts) and the grammar's ABI before using it, parses with a
// time budget and turns the tree into flow models. The worker (src/workers/flowchart.worker.ts)
// gives it a loader that fetches from /flowchart/<dir>/; unit tests give it one that reads the same
// files from disk. Every loading problem comes back as a LoadError naming the part and the reason,
// and leaves nothing cached, so the next prepare() loads again.
import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION, Parser, type Node } from "web-tree-sitter";
import { MAX_FILE_BYTES } from "../core/safety";
import { chartC } from "./c";
import { chartCpp } from "./cpp";
import type { FlowFile } from "./model";
import { GRAMMARS, RUNTIME, type FlowLanguage, type PackFile } from "./pack";
import { chartPython } from "./python";

/** Gets one file of the pack by name; rejects when it can't (a 404, the network). */
export type LoadFile = (file: string) => Promise<Uint8Array>;

export interface LoadFailure {
  part: "runtime" | "grammar";
  /** missing: couldn't be fetched; checksum: not the pinned bytes; abi: a grammar the runtime can't use; broken: wouldn't start. */
  reason: "missing" | "checksum" | "abi" | "broken";
  detail: string;
}

export class LoadError extends Error {
  constructor(readonly failure: LoadFailure) {
    super(`${failure.part} ${failure.reason}: ${failure.detail}`);
  }
}

export type ChartOutcome = { type: "charts"; file: FlowFile } | { type: "too-big"; detail: string };

export interface EngineOptions {
  /** How long one parse may take before it is cancelled (the page's own timeout is 2 s). */
  parseBudgetMs?: number;
  /** The grammar ABI versions accepted; defaults to the runtime's own range. */
  abi?: { min: number; max: number };
}

const ADAPTERS: Record<FlowLanguage, (root: Node, source: string) => FlowFile> = { c: chartC, cpp: chartCpp, python: chartPython };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The verified bytes of one file. */
async function verified(load: LoadFile, spec: PackFile, part: LoadFailure["part"]): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await load(spec.file);
  } catch (e) {
    throw new LoadError({ part, reason: "missing", detail: `${spec.file}: ${message(e)}` });
  }
  const got = await sha256Hex(bytes);
  if (got !== spec.sha256) throw new LoadError({ part, reason: "checksum", detail: `${spec.file}: sha256 ${got}, expected ${spec.sha256}` });
  return bytes;
}

// The runtime is one WebAssembly instance per JavaScript realm (web-tree-sitter keeps it in module
// state), so it is shared by every engine; a failed start is forgotten so the next one tries again.
let runtime: Promise<void> | null = null;

function startRuntime(load: LoadFile): Promise<void> {
  runtime ??= (async () => {
    const bytes = await verified(load, RUNTIME, "runtime");
    try {
      // A copy: `bytes` may be a view into a larger buffer.
      await Parser.init({ wasmBinary: bytes.slice().buffer });
    } catch (e) {
      throw new LoadError({ part: "runtime", reason: "broken", detail: message(e) });
    }
  })().catch((e: unknown) => {
    runtime = null;
    throw e;
  });
  return runtime;
}

const UTF8 = new TextEncoder();

export class FlowEngine {
  private readonly parsers = new Map<FlowLanguage, Parser>();
  private readonly loading = new Map<FlowLanguage, Promise<void>>();
  private readonly parseBudgetMs: number;
  private readonly abi: { min: number; max: number };

  constructor(
    private readonly load: LoadFile,
    options: EngineOptions = {},
  ) {
    this.parseBudgetMs = options.parseBudgetMs ?? 1500;
    this.abi = options.abi ?? { min: MIN_COMPATIBLE_VERSION, max: LANGUAGE_VERSION };
  }

  /** Loads the runtime and `language`'s grammar (once). Rejects with a LoadError. */
  prepare(language: FlowLanguage): Promise<void> {
    if (this.parsers.has(language)) return Promise.resolve();
    let pending = this.loading.get(language);
    if (!pending) {
      pending = this.loadLanguage(language).finally(() => this.loading.delete(language));
      this.loading.set(language, pending);
    }
    return pending;
  }

  private async loadLanguage(language: FlowLanguage): Promise<void> {
    await startRuntime(this.load);
    const bytes = await verified(this.load, GRAMMARS[language], "grammar");
    let lang: Language;
    try {
      lang = await Language.load(bytes);
    } catch (e) {
      throw new LoadError({ part: "grammar", reason: "broken", detail: `${GRAMMARS[language].file}: ${message(e)}` });
    }
    const abi = lang.abiVersion;
    if (abi < this.abi.min || abi > this.abi.max) {
      throw new LoadError({ part: "grammar", reason: "abi", detail: `${GRAMMARS[language].file} is ABI ${abi}; the runtime accepts ${this.abi.min} to ${this.abi.max}` });
    }
    const parser = new Parser();
    try {
      parser.setLanguage(lang);
    } catch (e) {
      parser.delete();
      throw new LoadError({ part: "grammar", reason: "abi", detail: message(e) });
    }
    this.parsers.set(language, parser);
  }

  /** The loaded grammar's ABI version, or null before prepare(). */
  abiVersion(language: FlowLanguage): number | null {
    return this.parsers.get(language)?.language?.abiVersion ?? null;
  }

  /** Charts every function in `source`. Call prepare(language) first. */
  chart(language: FlowLanguage, source: string): ChartOutcome {
    const parser = this.parsers.get(language);
    if (!parser) throw new Error(`the ${language} grammar is not loaded`);
    if (source.length > MAX_FILE_BYTES || UTF8.encode(source).length > MAX_FILE_BYTES) {
      return { type: "too-big", detail: `the file is larger than ${MAX_FILE_BYTES / 1024} KB` };
    }
    const deadline = performance.now() + this.parseBudgetMs;
    const tree = parser.parse(source, null, { progressCallback: () => performance.now() > deadline });
    if (!tree) {
      parser.reset();
      return { type: "too-big", detail: "it took too long to read" };
    }
    try {
      return { type: "charts", file: ADAPTERS[language](tree.rootNode, source) };
    } finally {
      tree.delete();
    }
  }
}
