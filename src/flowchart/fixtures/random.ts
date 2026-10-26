// Test helper (unit tests only): seeded random C programs that nest every construct the chart
// knows, for property tests of the model and the layout.

/** mulberry32: a small seeded generator (an LCG's low bits repeat too soon). */
function generator(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

export function randomProgram(seed: number): string {
  const rnd = generator(seed);
  let labels = 0;
  const stmts = (depth: number, inLoop: boolean, inSwitch: boolean): string => {
    const n = 1 + rnd(4);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const pick = rnd(depth > 3 ? 4 : 12);
      switch (pick) {
        case 0:
          out.push(`x = x + ${rnd(9)};`);
          break;
        case 1:
          out.push(`printf("%d", x);`);
          break;
        case 2:
          out.push(inLoop && rnd(2) ? "continue;" : inLoop || inSwitch ? "break;" : "y++;");
          break;
        case 3:
          out.push(rnd(3) ? "y--;" : "return y;");
          break;
        case 4:
          out.push(`if (x > ${rnd(9)}) {\n${stmts(depth + 1, inLoop, inSwitch)}\n}`);
          break;
        case 5:
          out.push(`if (x < ${rnd(9)}) {\n${stmts(depth + 1, inLoop, inSwitch)}\n} else {\n${stmts(depth + 1, inLoop, inSwitch)}\n}`);
          break;
        case 6:
          out.push(`while (x != ${rnd(9)}) {\n${stmts(depth + 1, true, false)}\n}`);
          break;
        case 7:
          out.push(`for (int i = 0; i < ${rnd(9)}; i++) {\n${stmts(depth + 1, true, false)}\n}`);
          break;
        case 8:
          out.push(`do {\n${stmts(depth + 1, true, false)}\n} while (x > ${rnd(9)});`);
          break;
        case 9:
          out.push(`switch (x) {\ncase 1:\n${stmts(depth + 1, inLoop, true)}\ncase 2:\n${stmts(depth + 1, inLoop, true)}\nbreak;\n${rnd(2) ? `default:\n${stmts(depth + 1, inLoop, true)}\n` : ""}}`);
          break;
        case 10:
          out.push(`for (;;) {\n${stmts(depth + 1, true, false)}\nif (x) break;\n}`);
          break;
        default: {
          const l = `L${labels++}`;
          out.push(`${l}:\ny = y * 2;\nif (y < 100) goto ${l};`);
        }
      }
    }
    return out.join("\n");
  };
  return `#include <stdio.h>\nint main(void) {\nint x = 3, y = 1;\n${stmts(0, false, false)}\nreturn 0;\n}\n`;
}
