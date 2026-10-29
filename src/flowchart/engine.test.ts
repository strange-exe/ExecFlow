/// <reference types="node" />
// The engine with the real runtime and grammars (read from public/flowchart/): every grammar loads
// and parses, and the spec's limits come back as "too big" quickly instead of hanging.
import { describe, expect, it } from "vitest";
import { FlowEngine } from "./engine";
import { NODE_LIMIT } from "./model";
import { diskLoader, engine, withPack } from "./fixtures/harness";
import type { FlowLanguage } from "./pack";

const test = withPack ? it : it.skip;

const HELLO: Record<FlowLanguage, string> = {
  c: '#include <stdio.h>\nint main(void) {\n  printf("hi");\n  return 0;\n}\n',
  cpp: '#include <iostream>\nint main() {\n  std::cout << "hi";\n}\n',
  python: 'print("hi")\n',
};

/** Runs `fn` and returns its result with the time it took. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

describe("flowchart engine (real wasm, in Node)", () => {
  for (const language of ["c", "cpp", "python"] as const) {
    test(`loads the ${language} grammar with the runtime and charts a program`, async () => {
      const e = engine();
      await e.prepare(language);
      const abi = e.abiVersion(language)!;
      expect(abi).toBeGreaterThanOrEqual(13);
      expect(abi).toBeLessThanOrEqual(15);
      const outcome = e.chart(language, HELLO[language]);
      expect(outcome.type).toBe("charts");
      if (outcome.type !== "charts") return;
      expect(outcome.file.syntaxError).toBeUndefined();
      const first = outcome.file.charts[0];
      expect(first.ok && first.nodes.some((n) => n.kind === "io")).toBe(true);
    });
  }

  test("the grammars' ABI versions are 15, 14 and 15", async () => {
    const e = engine();
    for (const l of ["c", "cpp", "python"] as const) await e.prepare(l);
    expect([e.abiVersion("c"), e.abiVersion("cpp"), e.abiVersion("python")]).toEqual([15, 14, 15]);
  });

  test("an empty file has a Start-to-End chart (Python) or no charts (C)", async () => {
    const e = engine();
    await e.prepare("python");
    await e.prepare("c");
    const py = e.chart("python", "");
    expect(py.type === "charts" && py.file.charts.length).toBe(1);
    const c = e.chart("c", "");
    expect(c.type === "charts" && c.file.charts.length).toBe(0);
  });

  test("200-deep nesting is too big, quickly", async () => {
    const e = engine();
    await e.prepare("c");
    const deep = `int main(void) {\n${"if (1) {\n".repeat(200)}x++;\n${"}\n".repeat(200)}return 0;\n}\n`;
    const { value, ms } = timed(() => e.chart("c", deep));
    expect(value.type).toBe("charts");
    if (value.type !== "charts") return;
    const main = value.file.charts[0];
    expect(main.ok).toBe(false);
    expect(main.ok === false && main.tooBig).toMatch(/nested more than 40 levels/);
    expect(ms).toBeLessThan(2000);
    // Python too.
    await e.prepare("python");
    const py = Array.from({ length: 200 }, (_, i) => `${"    ".repeat(i)}if x:`).join("\n") + `\n${"    ".repeat(200)}pass\n`;
    const p = timed(() => e.chart("python", py));
    expect(p.value.type === "charts" && !p.value.file.charts[0].ok).toBe(true);
    expect(p.ms).toBeLessThan(2000);
  });

  test(`a 50 000-statement function is too big (more than ${NODE_LIMIT} steps), quickly`, async () => {
    const e = engine();
    await e.prepare("c");
    const big = `int main(void) {\n  int x = 0;\n${"  x++; printf(\"%d\", x);\n".repeat(25_000)}  return 0;\n}\n`;
    const { value, ms } = timed(() => e.chart("c", big));
    expect(value.type).toBe("charts");
    if (value.type !== "charts") return;
    expect(value.file.charts[0].ok).toBe(false);
    const first = value.file.charts[0];
    expect(first.ok === false && first.tooBig).toMatch(/more than 400 steps/);
    expect(ms).toBeLessThan(2000);
  });

  test("with a pick, only that function is charted: the others are listed by name and lines (10 000 functions, quickly)", async () => {
    // Attack pass finding 3: charting every function of a 1 MB file took 2.7 s (past the page's 2 s
    // clock) and sent 14.8 MB back to the page.
    const e = engine();
    await e.prepare("c");
    const fns = Array.from({ length: 10_000 }, (_, i) => `int f${i}(int x){ while(x){ if(x>${i}){x--;continue;} x-=2;} return x;}`).join("\n");
    const src = `${fns}\nint main(void) { return f7(3); }\n`;
    const { value, ms } = timed(() => e.chart("c", src, { name: "f7", nth: 0 }));
    expect(value.type).toBe("charts");
    if (value.type !== "charts") return;
    const charts = value.file.charts;
    expect(charts.length).toBe(10_001);
    expect(charts[0]).toEqual({ ok: null, name: "main", from: 10_001, to: 10_001 });
    const f7 = charts[8];
    expect(f7.ok && f7.name === "f7" && f7.nodes.length > 3).toBe(true);
    expect(charts.filter((c) => c.ok !== null).length).toBe(1);
    expect(JSON.stringify(value.file).length, "the reply stays small").toBeLessThan(1_000_000);
    expect(ms).toBeLessThan(2000);
    // No pick: the entry point. And without the pick argument, every chart (as before).
    const entry = e.chart("c", "int g(void) { return 1; }\nint main(void) { return g(); }\n", null);
    expect(entry.type === "charts" && entry.file.charts.map((c) => [c.name, c.ok])).toEqual([["main", true], ["g", null]]);
    const all = e.chart("c", "int g(void) { return 1; }\nint main(void) { return g(); }\n");
    expect(all.type === "charts" && all.file.charts.map((c) => c.ok)).toEqual([true, true]);
  });

  test("a 10 000-line file is too big, quickly", async () => {
    const e = engine();
    await e.prepare("python");
    const lines = Array.from({ length: 10_000 }, (_, i) => `print(${i})`).join("\n");
    const { value, ms } = timed(() => e.chart("python", lines));
    expect(value.type === "charts" && !value.file.charts[0].ok).toBe(true);
    expect(ms).toBeLessThan(2000);
  });

  test("a file over the 1 MB file-size cap is too big without parsing", async () => {
    const e = engine();
    await e.prepare("c");
    const { value, ms } = timed(() => e.chart("c", `/*${"x".repeat(1024 * 1024)}*/`));
    expect(value).toEqual({ type: "too-big", detail: "the file is larger than 1024 KB" });
    expect(ms).toBeLessThan(500);
  });

  test("a parse that runs past its time budget is cancelled and reported too big", async () => {
    const e = new FlowEngine(diskLoader, { parseBudgetMs: 0 });
    await e.prepare("c");
    const source = `int main(void) {\n${"  x++;\n".repeat(5000)}}\n`;
    expect(e.chart("c", source)).toEqual({ type: "too-big", detail: "it took too long to read" });
  });

  test("a parse past the worker's job deadline is too big, though inside the engine's own budget", async () => {
    const e = engine();
    await e.prepare("c");
    const source = `int main(void) {\n${"  x++;\n".repeat(5000)}}\n`;
    expect(e.chart("c", source, null, performance.now() - 1)).toEqual({ type: "too-big", detail: "it took too long to read" });
    expect(e.chart("c", source, null, performance.now() + 60_000).type).toBe("charts");
  });

  test("odd input never throws: NUL, lone surrogates, bidi controls", async () => {
    const e = engine();
    await e.prepare("c");
    const odd = `int main(void) {\n  x = 1;${String.fromCharCode(0)}\n  y = "${String.fromCharCode(0xd800)}${String.fromCodePoint(0x202e)}";\n}\n`;
    const outcome = e.chart("c", odd);
    expect(outcome.type).toBe("charts");
  });
});
