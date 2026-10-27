// The worker lays out one chart per reply: the one the page picked, named with its occurrence, since
// C++ overloads and Python redefinitions share a name (attack pass finding 4). A layout past its
// budget turns that chart into "too big" instead of drawing lines through boxes.
import { describe, expect, test } from "vitest";
import { layOutPicked, pickIndex, pickOf } from "./picked";
import { chartFile, ok } from "./fixtures/harness";

const OVERLOADS = "int f(int x) { return x; }\nint f(int x, int y) { if (x) return y; return x; }\nint main() { return f(1) + f(1, 2); }\n";

describe("picking a chart", () => {
  test("the nth function with a name, so overloads and redefinitions can each be picked", async () => {
    const file = await chartFile("cpp", OVERLOADS);
    expect(file.charts.map((c) => c.name)).toEqual(["main", "f", "f"]);
    expect(pickIndex(file.charts, { name: "f", nth: 0 })).toBe(1);
    expect(pickIndex(file.charts, { name: "f", nth: 1 })).toBe(2);
    expect(pickOf(file.charts, 2)).toEqual({ name: "f", nth: 1 });
    expect(pickOf(file.charts, 0)).toEqual({ name: "main", nth: 0 });
  });

  test("no pick, or one that is gone after an edit, is the entry point", async () => {
    const file = await chartFile("cpp", OVERLOADS);
    expect(pickIndex(file.charts, null)).toBe(0);
    expect(pickIndex(file.charts, { name: "g", nth: 0 })).toBe(0);
    expect(pickIndex(file.charts, { name: "f", nth: 2 })).toBe(0);
    expect(pickIndex([], null)).toBe(0);
  });

  test("the picked chart comes with its layout; the others don't", async () => {
    const file = await chartFile("cpp", OVERLOADS);
    const out = layOutPicked(file, { name: "f", nth: 1 });
    expect(out.picked).toBe(2);
    const chart = ok(out.file.charts[2]);
    expect(out.layout?.boxes.map((b) => b.id).sort((a, b) => a - b)).toEqual(chart.nodes.map((n) => n.id).sort((a, b) => a - b));
  });

  test("a chart past the layout budget becomes too big, with its name and lines kept", async () => {
    const ladder = Array.from({ length: 395 }, (_, i) => `${i ? "else " : ""}if (x == ${i}) ${i % 2 ? "continue" : "break"};`).join("\n");
    const file = await chartFile("c", `int main(void) {\n  int x = 99;\n  do {\n${ladder}\n  } while (x--);\n  return 0;\n}\n`);
    const before = ok(file.charts[0]);
    const out = layOutPicked(file, null);
    expect(out.layout).toBeNull();
    expect(out.file.charts[0]).toEqual({ ok: false, name: "main", from: before.from, to: before.to, tooBig: "it has too many break and continue lines to draw" });
  }, 30_000);

  test("a picked chart that is already too big has no layout and is left as it is", async () => {
    const body = Array.from({ length: 1300 }, (_, i) => `  x += ${i};`).join("\n");
    const file = await chartFile("c", `int main(void) {\n  int x = 0;\n${body}\n  return x;\n}\n`);
    expect(file.charts[0].ok).toBe(false);
    const out = layOutPicked(file, null);
    expect(out).toEqual({ file, picked: 0, layout: null });
  });

  test("an empty file has nothing to pick", () => {
    expect(layOutPicked({ charts: [] }, null)).toEqual({ file: { charts: [] }, picked: 0, layout: null });
  });
});
