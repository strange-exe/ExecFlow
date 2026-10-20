// Typing responsiveness with suggestions (research doc section 3, "Speed and memory"). Lab data,
// Chromium only, at 4x CPU slowdown, in a workspace of 200 files, typing the same 200 characters of
// C in every session. Two gates:
// 1. Responsiveness, the budget the design standard binds: a lab estimate of INP of 200 ms or less
//    in every session with suggestions on ("An INP below or at 200 milliseconds means a page has good
//    responsiveness", web.dev/articles/inp).
// 2. The suggestions' own main-thread cost, in a paired control: sessions with "Suggestions while
//    typing" off, taken in turn with the ones that have it on, so the editor's own cost per key and
//    the machine's speed cancel out. While typing, suggestions may add at most EXTRA_LONG_TASKS long
//    tasks (over 50 ms, w3c.github.io/longtasks) and EXTRA_BLOCKING_MS of total blocking time (each
//    long task's time over 50 ms), comparing the median of the sessions with them on to the median
//    with them off. This is the research doc's "no long task" rule in a form the editor can meet:
//    CodeMirror's own typing costs about 40 ms a key at 4x on this PC with suggestions off, so a
//    long task now and then comes without suggestions too.
// Why INP alone is not enough: a query runs in a task of its own, 100 ms after a key
// (activateOnTypingDelay), so what it costs reaches INP only once it delays the next key. A 100 ms
// busy loop added to every query kept the INP estimate at 152 to 168 ms in 3 probe sessions
// (2026-10-21) but made about 130 long tasks and 7 s of blocking time; in this spec it failed both
// gates (one session's INP went to 440 ms as keys queued behind it), and a 40 ms loop failed gate 2
// only (24 more long tasks, INP 80 to 112 ms). The code from before the speed stage's rendering
// fixes (2026-10-20) met gate 1 too (INP 80 to 104 ms): these gates catch regressions, they don't
// measure those fixes.
//
// The method, so the numbers mean something:
// - Alone. This spec is its own Playwright project, "speed" (playwright.config.ts), which runs after
//   every test of the three engines' projects has finished, so no other test loads the machine.
//   Playwright skips it when a test in those projects fails; then run it by itself with
//   npm run e2e:speed (--project=speed --no-deps).
// - The slowdown is checked, not assumed: before each session a fixed loop is timed in the page at
//   rate 1 and at rate 4 (CDP Emulation.setCPUThrottlingRate), and must take at least
//   MIN_SLOWDOWN times as long at rate 4. Both times are in the annotations: a slow machine shows in
//   the rate-1 time, other load on it in a ratio far from 4.
// - Typing on the wall clock: one key down every 200 ms (five a second), held 90 ms, whatever the
//   page does, so every build gets the same input rate. A key whose time has passed because the page
//   was slow to take the last one goes at once and is counted as late (annotations).
// - Event Timing (w3c.github.io/event-timing): a PerformanceObserver for "event" entries with
//   durationThreshold 16 (the lowest allowed) and buffered true. Entries are grouped by
//   interactionId and each interaction's latency is its longest entry (keydown and keyup of one key
//   press share an id). INP is the longest interaction after ignoring one highest for every 50
//   interactions (web.dev/articles/inp: "we ignore one highest interaction for every 50
//   interactions"). The interaction count is the browser's own (performance.interactionCount) when
//   it has one, else the interactions observed; entries from before the session are left out.
// - A session counts only if it typed what it should: all 200 keys seen, at least MIN_INTERACTIONS
//   of them observed as interactions, and with suggestions on at least MIN_KEYS_WITH_LIST of them
//   pressed while the list was open (with them off, none).
// - Six sessions, each in a fresh page (a reload between them): on and off in turn, in the order
//   on off, off on, on off. Each starts with a short word typed, closed and taken back, which is
//   part of its interactions (the first keys of a page are the coldest) but not of gate 2, which
//   counts the long tasks that start once the 200 characters begin.
// Lab data, Chromium only (CDP throttling, Event Timing's interactionId, longtask entries), on
// whatever machine runs it. It is an indicator, not field INP (75th percentile of real visits).
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { expect, expectActive, importFiles, openApp, openFromTree, reloadApp, setCode, showView, test } from "./helpers";

test.use({ serviceWorkers: "block" });

/** The INP budget (ms): web.dev's "good" threshold, the design standard's responsiveness budget. */
const INP_BUDGET_MS = 200;
/**
 * Gate 2: long tasks and blocking time (ms) the suggestions may add while typing (median on minus
 * median off). Measured on this PC (probe, 2026-10-21, 3 sessions each): suggestions add 4 long
 * tasks and 50 ms (medians; 9 and 131 at most in one session). A wall-clock busy loop added to
 * every query at 4x adds, at 20 ms, 6 and 89; at 40 ms, 23 and 141; at 100 ms, 130 and 7.2 s. So
 * 15 fails a 40 ms cost per query and leaves about 3 times the median's room.
 */
const EXTRA_LONG_TASKS = 15;
const EXTRA_BLOCKING_MS = 500;
/** The fixed loop must take at least this many times as long at rate 4 as at rate 1. */
const MIN_SLOWDOWN = 2;
/** A session must see at least this many of the 200 key presses as interactions. */
const MIN_INTERACTIONS = 150;
/** ... and with suggestions on, at least this many keys pressed while the suggestion list was open. */
const MIN_KEYS_WITH_LIST = 50;
/** The typing rhythm (ms): a key down every KEY_EVERY_MS, held KEY_HOLD_MS. */
const KEY_EVERY_MS = 200;
const KEY_HOLD_MS = 90;

const editor = (page: Page) => page.locator(".cm-editor");

/** About 200 workspace files: the program, its headers, and many files it never includes. */
function bigWorkspace(): { name: string; text: string }[] {
  const files = [
    { name: "main.c", text: START },
    { name: "util.h", text: '#include "types.h"\n#define LIMIT 10\nint helper(int x);\nint add_values(int a, int b);\n' },
    { name: "geometry.h", text: '#include "types.h"\npoint_t make_point(int x, int y);\ndouble area_of(point_t p);\n' },
    { name: "types.h", text: "typedef struct { int x, y; } point_t;\nenum mode { MODE_FAST, MODE_SLOW };\n" },
  ];
  for (let i = 0; files.length < 200; i++) {
    const n = String(i).padStart(3, "0");
    const kind = i % 3;
    if (kind === 0) files.push({ name: `lib_${n}.h`, text: `int unused_${n}(int v);\n#define UNUSED_${n} ${i}\n` });
    else if (kind === 1) files.push({ name: `part_${n}.c`, text: `static int counter_${n} = ${i};\nint unused_${n}(int v) {\n    return v + counter_${n};\n}\n` });
    else files.push({ name: `mod_${n}.py`, text: `def unused_${n}(v):\n    return v + ${i}\n` });
  }
  return files;
}

/** The open file's text at the start of every session. */
const START = '#include <stdio.h>\n#include "util.h"\n#include "geometry.h"\n\nint main(void) {\n    int total = 0;\n    ';

/** 200 characters of C, mostly names from the included headers. */
const TYPED = (() => {
  const lines = [
    "total = helper(total) + add_values(total, LIMIT);\n",
    "point_t p = make_point(total, LIMIT);\n",
    "total = total + area_of(p) + MODE_FAST;\n",
    "total = add_values(helper(total), MODE_SLOW);\n",
    "total = helper(add_values(total, total));\n",
  ];
  const text = lines.join("");
  if (text.length < 200) throw new Error(`only ${text.length} characters to type`);
  return text.slice(0, 200);
})();

/** What the page records for one session (window.__speed). Times are performance.now() ms. */
interface Raw {
  t0: number;
  typingAt: number;
  count0: number;
  count1: number;
  /** Longest Event Timing entry per interaction: [interactionId, startTime, duration]. */
  interactions: [number, number, number][];
  longTasks: { start: number; duration: number }[];
  frames: { start: number; duration: number; scripts: string[] }[];
  keys: number;
  keysWithList: number;
  /** While typing: the list opened from closed, and the list was filled again by a new query (each pending to active). */
  listOpens: number;
  listQueries: number;
}

/** Installs the observers into window.__speed; entries from before this call are ignored. */
function observe(page: Page) {
  return page.evaluate(() => {
    type Timing = PerformanceEntry & { interactionId: number };
    type Loaf = PerformanceEntry & { scripts?: { invoker: string; sourceFunctionName: string; sourceURL: string; duration: number }[] };
    const perf = performance as Performance & { interactionCount?: number };
    const t0 = performance.now();
    const byId = new Map<number, [number, number, number]>();
    const s = {
      t0, typingAt: Infinity, count0: perf.interactionCount ?? -1, count1: -1, interactions: [] as [number, number, number][],
      longTasks: [] as { start: number; duration: number }[], frames: [] as { start: number; duration: number; scripts: string[] }[],
      keys: 0, keysWithList: 0, listOpens: 0, listQueries: 0,
    };
    const onTiming = (entries: PerformanceEntryList) => {
      for (const e of entries as Timing[]) {
        if (!e.interactionId || e.startTime < t0) continue;
        const had = byId.get(e.interactionId);
        if (!had || e.duration > had[2]) byId.set(e.interactionId, [e.interactionId, e.startTime, e.duration]);
      }
    };
    const timing = new PerformanceObserver((list) => onTiming(list.getEntries()));
    timing.observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    const onLong = (entries: PerformanceEntryList) => {
      for (const e of entries) if (e.startTime >= t0) s.longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
    };
    const long = new PerformanceObserver((list) => onLong(list.getEntries()));
    long.observe({ type: "longtask" });
    // Which scripts a long frame ran (Chromium's long-animation-frame entries), to explain a slow key.
    const onFrames = (entries: PerformanceEntryList) => {
      for (const e of entries as Loaf[]) {
        if (e.duration < 50 || e.startTime < t0) continue;
        s.frames.push({
          start: Math.round(e.startTime), duration: Math.round(e.duration),
          scripts: (e.scripts ?? []).map((x) => `${x.invoker} ${x.sourceFunctionName}@${x.sourceURL.split("/").pop()} ${Math.round(x.duration)}ms`),
        });
      }
    };
    let frames: PerformanceObserver | null = null;
    try {
      frames = new PerformanceObserver((list) => onFrames(list.getEntries()));
      frames.observe({ type: "long-animation-frame" });
    } catch {
      frames = null; // no long-animation-frame entries in this browser
    }
    // Keys pressed while typing, and how many came while the list was open (capture: before the editor).
    const el = document.querySelector(".cm-editor")!;
    addEventListener("keydown", () => {
      if (performance.now() < s.typingAt) return;
      s.keys++;
      if (el.getAttribute("data-completion") === "active") s.keysWithList++;
    }, true);
    // data-completion goes closed, pending (a query runs), active (the list shows its result). A key
    // typed with the list open makes it pending again whenever a source had answered null there.
    let closed = true;
    new MutationObserver(() => {
      const state = el.getAttribute("data-completion");
      if (state === "closed") closed = true;
      if (state !== "active") return;
      if (performance.now() >= s.typingAt) {
        s.listQueries++;
        if (closed) s.listOpens++;
      }
      closed = false;
    }).observe(el, { attributes: true, attributeFilter: ["data-completion"] });
    const w = window as unknown as { __speed: typeof s; __speedTyping(): void; __speedCollect(): typeof s };
    w.__speed = s;
    w.__speedTyping = () => void (s.typingAt = performance.now());
    w.__speedCollect = () => {
      onTiming(timing.takeRecords());
      onLong(long.takeRecords());
      if (frames) onFrames(frames.takeRecords());
      s.interactions = [...byId.values()];
      s.count1 = perf.interactionCount ?? -1;
      return s;
    };
  });
}

/** The page's idle work is done: an idle callback ran, then a frame. */
const idle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => requestAnimationFrame(() => setTimeout(done, 0)), { timeout: 3000 })));

/**
 * A fixed integer loop timed in the page (ms) at rate 1, then at rate 4 (which it leaves on): the
 * middle of 3 runs each. One function serves both rates and is warmed first, so both run the same
 * compiled code: a fresh copy per measurement ran 43 ms instead of about 98 at rate 1 in 1 page of
 * 12, which would hide a missing slowdown at rate 4; one shared function took 98 to 99 ms in 12 of
 * 12 (probe, 2026-10-21).
 */
async function slowdownLoop(page: Page, cdp: CDPSession): Promise<[number, number]> {
  await page.evaluate(() => {
    const w = window as unknown as { __loop(): number };
    w.__loop = () => {
      const start = performance.now();
      let x = 0;
      for (let i = 0; i < 10_000_000; i++) x = (x * 31 + i) | 0;
      return x === 0.5 ? -1 : performance.now() - start; // x is read, so the loop stays
    };
    for (let i = 0; i < 4; i++) w.__loop();
  });
  const time = () =>
    page.evaluate(() => {
      const w = window as unknown as { __loop(): number };
      return [w.__loop(), w.__loop(), w.__loop()].sort((a, b) => a - b)[1];
    });
  const at1 = await time();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const at4 = await time();
  return [at1, at4];
}

const sleepUntil = async (at: number) => {
  const wait = at - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
};

/** Types `text` on the wall clock (KEY_EVERY_MS, KEY_HOLD_MS); returns how many keys went late. */
async function typeOnTheClock(page: Page, text: string): Promise<number> {
  let at = Date.now() + 20;
  let late = 0;
  for (const c of text) {
    if (Date.now() > at + 20) late++;
    await sleepUntil(at);
    await page.keyboard.down(c);
    await sleepUntil(at + KEY_HOLD_MS);
    await page.keyboard.up(c);
    at += KEY_EVERY_MS;
  }
  return late;
}

/** Sets "Suggestions while typing" for the next load (settings.ts keeps it in localStorage). */
const setSuggestions = (page: Page, on: boolean) =>
  page.evaluate((value) => {
    const key = "codeeditor:settings";
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), suggestOnTyping: value }));
  }, on);

interface Session {
  suggestions: boolean;
  inp: number;
  /** The interaction count the 1-in-50 rule used, and where it came from. */
  n: number;
  countSource: "performance.interactionCount" | "observed";
  /** Interactions observed during the 200 characters (not the warm-up). */
  typingInteractions: number;
  keys: number;
  lateKeys: number;
  keysWithList: number;
  listOpens: number;
  listQueries: number;
  /** The six longest interactions (ms), and the warm-up's longest. */
  top: number[];
  warmUpMax: number;
  /** Long tasks that started while the 200 characters were typed, and their blocking time (ms over 50 each). */
  typingLongTasks: number[];
  typingBlockingMs: number;
  /** The fixed loop at rate 1 and rate 4 (ms), and their ratio. */
  loopMs: [number, number];
  slowdown: number;
  frames: Raw["frames"];
}

/** The lab INP estimate and the long tasks from one session's raw record. */
function summarize(raw: Raw, extra: Pick<Session, "suggestions" | "lateKeys" | "loopMs">): Session {
  const latencies = raw.interactions.map((i) => i[2]).sort((a, b) => b - a);
  const counted = raw.count0 >= 0 && raw.count1 >= 0 ? raw.count1 - raw.count0 : -1;
  const n = Math.max(latencies.length, counted);
  const inp = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(n / 50))] : 0;
  const warmUp = raw.interactions.filter((i) => i[1] < raw.typingAt).map((i) => i[2]);
  const typingLong = raw.longTasks.filter((t) => t.start >= raw.typingAt);
  return {
    ...extra,
    inp, n, countSource: counted >= latencies.length ? "performance.interactionCount" : "observed",
    typingInteractions: raw.interactions.filter((i) => i[1] >= raw.typingAt).length,
    keys: raw.keys, keysWithList: raw.keysWithList, listOpens: raw.listOpens, listQueries: raw.listQueries,
    top: latencies.slice(0, 6), warmUpMax: Math.max(0, ...warmUp),
    typingLongTasks: typingLong.map((t) => t.duration),
    typingBlockingMs: typingLong.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
    slowdown: Math.round((extra.loopMs[1] / extra.loopMs[0]) * 100) / 100,
    frames: [...raw.frames].sort((a, b) => b.duration - a.duration).slice(0, 5),
  };
}

/** One session: the same start, then (at 4x) a warm-up word and the 200 characters. */
async function session(page: Page, suggestions: boolean): Promise<Session> {
  await expectActive(page, "main.c");
  await showView(page, "code");
  // Both loads that come with showing a C file are done: the library data and the headers' names.
  await expect(editor(page)).toHaveAttribute("data-library", "ready");
  await setCode(page, START);
  await expect(editor(page)).toHaveAttribute("data-index", "ready");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await idle(page);

  const cdp = await page.context().newCDPSession(page);
  try {
    const [at1, at4] = await slowdownLoop(page, cdp);
    await observe(page);
    // A word typed (with suggestions on, the list opens), closed and taken back: the page's first keys, in its INP.
    await page.keyboard.type("hel", { delay: 200 }); // helper, from util.h
    if (suggestions) await expect(editor(page)).toHaveAttribute("data-completion", "active");
    await page.keyboard.press("Escape");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 1000)))));

    await page.evaluate(() => (window as unknown as { __speedTyping(): void }).__speedTyping());
    // Five characters a second: the list opens 100 ms after typing stops (activateOnTypingDelay), so
    // faster typing would skip most queries and measure less than a student's typing causes.
    const lateKeys = await typeOnTheClock(page, TYPED);
    // The last keys' frames and their Event Timing entries arrive under the slowdown.
    await page.waitForTimeout(1500);
    const raw = await page.evaluate(() => (window as unknown as { __speedCollect(): Raw }).__speedCollect());
    return summarize(raw, { suggestions, lateKeys, loopMs: [Math.round(at1 * 10) / 10, Math.round(at4 * 10) / 10] });
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

function report(info: TestInfo, n: number, s: Session) {
  const kind = s.suggestions ? "on" : "off";
  info.annotations.push({ type: `session ${n} (suggestions ${kind}): lab INP estimate at 4x slowdown (ms)`, description: String(s.inp) });
  info.annotations.push({ type: `session ${n} (suggestions ${kind}): details`, description: JSON.stringify(s) });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test("typing 200 characters with suggestions in a 200-file workspace: lab INP estimate of 200 ms or less, and the suggestions add almost no long tasks, at 4x CPU slowdown", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "CPU throttling, Event Timing's interactionId and longtask entries are Chromium's");
  test.setTimeout(900_000);
  await openApp(page);
  await importFiles(page, bigWorkspace());
  await expect(page.locator(".tree [role=treeitem]")).toHaveCount(200);
  await openFromTree(page, "main.c");

  const sessions: Session[] = [];
  for (const [i, on] of [true, false, false, true, true, false].entries()) {
    const n = i + 1;
    await setSuggestions(page, on);
    await reloadApp(page); // a fresh page: the workspace and the open tab come back
    const s = await session(page, on);
    report(info, n, s);
    sessions.push(s);
    const what = `session ${n} (suggestions ${on ? "on" : "off"})`;
    // The slowdown was really on, and the session typed what it should.
    expect(s.slowdown, `${what}: the fixed loop at rate 4 against rate 1 (${s.loopMs.join(" ms, ")} ms)`).toBeGreaterThanOrEqual(MIN_SLOWDOWN);
    expect(await page.locator(".cm-content").textContent(), `${what}: the text typed`).toContain("make_point(total, LIMIT)");
    expect(s.keys, `${what}: keys pressed while typing`).toBe(TYPED.length);
    expect(s.typingInteractions, `${what}: interactions observed while typing`).toBeGreaterThanOrEqual(MIN_INTERACTIONS);
    if (on) expect(s.keysWithList, `${what}: keys pressed with the suggestion list open`).toBeGreaterThanOrEqual(MIN_KEYS_WITH_LIST);
    else expect(s.keysWithList, `${what}: keys pressed with a suggestion list open`).toBe(0);
  }
  const on = sessions.filter((s) => s.suggestions);
  const off = sessions.filter((s) => !s.suggestions);
  const longOn = median(on.map((s) => s.typingLongTasks.length));
  const longOff = median(off.map((s) => s.typingLongTasks.length));
  const blockingOn = median(on.map((s) => s.typingBlockingMs));
  const blockingOff = median(off.map((s) => s.typingBlockingMs));
  const machine = `fixed loop ${sessions.map((s) => `${s.loopMs[0]}/${s.loopMs[1]}`).join(", ")} ms at rate 1/4`;
  info.annotations.push({ type: "lab INP estimate per session with suggestions on (ms)", description: on.map((s) => s.inp).join(", ") });
  info.annotations.push({ type: "while typing: long tasks / blocking ms per session, on then off", description: `on ${on.map((s) => `${s.typingLongTasks.length} / ${s.typingBlockingMs}`).join(", ")}; off ${off.map((s) => `${s.typingLongTasks.length} / ${s.typingBlockingMs}`).join(", ")}` });
  info.annotations.push({ type: "the machine", description: machine });
  for (const [i, s] of on.entries()) {
    expect.soft(s.inp, `suggestions on, session ${i + 1}: lab INP estimate (ms) at 4x; longest interactions ${s.top.join(", ")}; ${machine}`).toBeLessThanOrEqual(INP_BUDGET_MS);
  }
  expect.soft(longOn - longOff, `long tasks while typing the suggestions add (median ${longOn} on, ${longOff} off); ${machine}`).toBeLessThanOrEqual(EXTRA_LONG_TASKS);
  expect.soft(blockingOn - blockingOff, `blocking ms while typing the suggestions add (median ${blockingOn} on, ${blockingOff} off); ${machine}`).toBeLessThanOrEqual(EXTRA_BLOCKING_MS);
});
