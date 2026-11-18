// The run strip's stepper (Workbench stage 3, option A's mock): after a Python run, "step 07 / 19" in
// mono between Previous and Next (keycap arrows), a thin tick bar of where the step is (a tick per
// step after Start, up to TICK_CAP; past it, a proportional bar), and the variables row: the step's
// call's variables as `name = value`. Left and Right step, Home and End go to Start and the end,
// while the stepper has the focus (never from the code or a text field: those keep their arrows).
// A polite live region says the step once the keys rest, not on every repeat.
//
// The model (steps.ts) comes from the Flowchart view, which has the chart the steps are of; the
// stepper starts at the last step (the whole run, as the chart's trace shows it). C, C++ and the
// other "no steps" cases show the view's one quiet sentence instead.
//
// SECURITY: variable names and values are the student's program's text: they go into the page
// only as textContent (and a title), never as HTML.
import type { StepModel } from "../flowchart/steps";
import { h } from "./dom";

/** Ticks are drawn one per step (after Start) up to this many; a longer run gets a bar. */
export const TICK_CAP = 24;
/** The live region speaks this long after the last step change (held keys say only where they stop). */
export const SAY_AFTER_MS = 400;

/** A model with the chart it is of: `paint` shows step k on the chart drawn now. */
export interface StepSource {
  fileId: string;
  model: StepModel;
  paint(k: number): void;
}
/** What the stepper shows: steps, a sentence saying why there are none, or nothing. */
export type StepsShown = StepSource | { fileId: string; words: string } | null;

/** "step 07 / 19": the step against the last, zero-padded to the last's width. */
export function stepLabel(k: number, total: number): string {
  const last = String(Math.max(0, total - 1));
  return `step ${String(k).padStart(last.length, "0")} / ${last}`;
}

/** The live region's sentence for step k. */
export function stepWords(model: StepModel, k: number): string {
  const s = model.step(k);
  const where =
    s.kind === "start" ? "Start" : s.kind === "return" ? "the call returned" : s.kind === "raise" ? `line ${s.line} raised an exception` : `line ${s.line}`;
  return `Step ${s.k} of ${model.total - 1}, ${where}.`;
}

/** The last step whose values were recorded (-1: none were). Values stop at one step and stay stopped. */
export function lastKnownStep(model: StepModel): number {
  if (model.values === "none" || !model.valuesKnownAt(0)) return -1;
  let lo = 0;
  let hi = model.total - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (model.valuesKnownAt(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Why step k shows no values (the recording stopped before it), or null. */
export function cutWords(model: StepModel, k: number): string | null {
  if (model.values === "none" || model.valuesKnownAt(k)) return null;
  const last = lastKnownStep(model);
  return last < 0 ? "Values weren't recorded for this run." : `Values stopped being recorded after step ${last}.`;
}

/** The step a stepping key goes to (clamped), or null for any other key. */
export function keyStep(key: string, k: number, total: number): number | null {
  const last = Math.max(0, total - 1);
  const to = key === "ArrowLeft" ? k - 1 : key === "ArrowRight" ? k + 1 : key === "Home" ? 0 : key === "End" ? last : null;
  return to === null ? null : Math.min(last, Math.max(0, to));
}

/** The tick bar at step k: a tick per step after Start ("done" before k, "cur" at k), or a bar's fraction. */
export function ticksOf(total: number, k: number): { kind: "ticks"; ticks: ("" | "done" | "cur")[] } | { kind: "bar"; fraction: number } {
  if (total - 1 > TICK_CAP) return { kind: "bar", fraction: total > 1 ? k / (total - 1) : 0 };
  return { kind: "ticks", ticks: Array.from({ length: Math.max(0, total - 1) }, (_, j) => (j + 1 < k ? "done" : j + 1 === k ? "cur" : "")) };
}

export interface RunStepper {
  show(shown: StepsShown): void;
  /** The file whose steps (or sentence) are shown, or null. */
  fileId(): string | null;
  /** Steps are shown (not a sentence, not nothing). */
  hasSteps(): boolean;
}

export interface StepperHooks {
  /** Step k of `src` is now the one shown (`user`: a key or a button, not a new model). */
  step(src: StepSource, k: number, user: boolean): void;
  /** The steps of `fileId` are no longer shown. */
  cleared(fileId: string): void;
}

const ARROW_LEFT = String.fromCodePoint(0x2190);
const ARROW_RIGHT = String.fromCodePoint(0x2192);

/** Fills `host` (the strip's slot: the stepper or the sentence) and `varsHost` (the variables row). */
export function createRunStepper(host: HTMLElement, varsHost: HTMLElement, hooks: StepperHooks): RunStepper {
  const words = h("p", { class: "run-steps-words" });
  const key = (id: string, label: string, shortcut: string, arrow: string) =>
    h(
      "button",
      { type: "button", class: "step-key", id, "aria-label": label, "aria-keyshortcuts": shortcut, title: `${label} (${shortcut === "ArrowLeft" ? "Left" : "Right"} arrow)` },
      h("kbd", { class: "keycap", "aria-hidden": "true" }, arrow),
    );
  const prev = key("step-prev", "Previous step", "ArrowLeft", ARROW_LEFT);
  const next = key("step-next", "Next step", "ArrowRight", ARROW_RIGHT);
  const count = h("span", { class: "step-count", id: "step-count" });
  const ticks = h("span", { class: "step-ticks", "aria-hidden": "true" });
  const stepper = h("div", { class: "run-stepper", role: "group", "aria-label": "Step through the run (Left and Right arrows, Home, End)" }, prev, count, next, ticks);
  const said = h("p", { class: "visually-hidden", id: "step-said", role: "status" });
  host.append(words, stepper, said);

  const varsList = h("ul", { class: "run-vars-list", "aria-label": "Variables" });
  const varsNote = h("p", { class: "run-vars-note" });
  varsHost.append(h("span", { class: "run-vars-label", "aria-hidden": "true" }, "Variables"), varsList, varsNote);

  let src: StepSource | null = null;
  let shownFile: string | null = null;
  let k = 0;
  let sayTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(state: "none" | "words" | "steps") {
    host.dataset.state = state;
    host.hidden = state === "none";
    words.hidden = state !== "words";
    stepper.hidden = state !== "steps";
    if (state !== "steps") {
      varsHost.hidden = true;
      delete host.dataset.step;
      delete host.dataset.total;
      clearTimeout(sayTimer);
      said.textContent = "";
    }
  }

  function renderTicks(model: StepModel) {
    const t = ticksOf(model.total, k);
    if (t.kind === "bar") {
      let fill = ticks.querySelector<HTMLElement>(".step-fill");
      if (!fill || ticks.dataset.kind !== "bar") {
        fill = h("span", { class: "step-fill" });
        ticks.replaceChildren(h("span", { class: "step-track" }, fill));
        ticks.dataset.kind = "bar";
      }
      fill.style.transform = `scaleX(${t.fraction})`;
      return;
    }
    if (ticks.dataset.kind !== "ticks" || ticks.childElementCount !== t.ticks.length) {
      ticks.replaceChildren(...t.ticks.map(() => h("i", null)));
      ticks.dataset.kind = "ticks";
    }
    t.ticks.forEach((state, j) => {
      const tick = ticks.children[j] as HTMLElement;
      if (state) tick.dataset.tick = state;
      else delete tick.dataset.tick;
    });
  }

  function renderVars(model: StepModel) {
    if (model.values === "none") return void (varsHost.hidden = true);
    varsHost.hidden = false;
    varsHost.dataset.values = model.values;
    const cut = cutWords(model, k);
    const pairs = cut ? [] : model.varsAt(k);
    // textContent only: names and values are the program's own text.
    varsList.replaceChildren(
      ...pairs.map(([name, value]) => {
        const n = h("span", { class: "run-var-name" });
        n.textContent = name;
        const v = h("span", { class: "run-var-value" });
        v.textContent = value;
        const li = h("li", { class: "run-var" }, n, h("span", { class: "run-var-eq" }, " = "), v);
        li.title = `${name} = ${value}`;
        return li;
      }),
    );
    varsList.hidden = pairs.length === 0;
    varsNote.textContent = cut ?? (pairs.length ? "" : "No variables yet.");
    varsNote.hidden = !varsNote.textContent;
    varsHost.dataset.known = cut ? "false" : "true";
    // A long list scrolls inside its row (app.css): then it takes the focus, so keys can scroll it.
    if (varsList.scrollHeight > varsList.clientHeight + 1 || varsList.scrollWidth > varsList.clientWidth + 1) varsList.tabIndex = 0;
    else varsList.removeAttribute("tabindex");
  }

  function render() {
    if (!src) return;
    const { model } = src;
    host.dataset.step = String(k);
    host.dataset.total = String(model.total);
    count.textContent = stepLabel(k, model.total);
    prev.setAttribute("aria-disabled", String(k === 0));
    next.setAttribute("aria-disabled", String(k === model.total - 1));
    renderTicks(model);
    renderVars(model);
  }

  function go(to: number, user: boolean) {
    if (!src) return;
    const last = src.model.total - 1;
    to = Math.min(last, Math.max(0, to));
    if (to === k) return;
    k = to;
    render();
    hooks.step(src, k, user);
    // The words once the keys rest: a held key says only the step it stops on.
    clearTimeout(sayTimer);
    const now = src;
    sayTimer = setTimeout(() => {
      if (now === src) said.textContent = stepWords(now.model, k);
    }, SAY_AFTER_MS);
  }

  prev.addEventListener("click", () => go(k - 1, true));
  next.addEventListener("click", () => go(k + 1, true));
  stepper.addEventListener("keydown", (e) => {
    if (!src || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = keyStep(e.key, k, src.model.total);
    if (to === null) return;
    e.preventDefault();
    go(to, true);
  });

  function drop() {
    if (shownFile !== null) hooks.cleared(shownFile);
    src = null;
    shownFile = null;
  }

  setState("none");
  return {
    show(shown) {
      if (!shown) {
        drop();
        return setState("none");
      }
      if (!("model" in shown)) {
        drop();
        shownFile = shown.fileId;
        words.textContent = shown.words;
        return setState("words");
      }
      // The same run redrawn (a new chart drawing, a theme change): the step stays, painted anew.
      const same = src !== null && src.fileId === shown.fileId && src.model === shown.model;
      if (!same && shownFile !== null && shownFile !== shown.fileId) hooks.cleared(shownFile);
      src = shown;
      shownFile = shown.fileId;
      if (!same) k = shown.model.total - 1;
      setState("steps");
      render();
      hooks.step(src, k, false);
    },
    fileId: () => shownFile,
    hasSteps: () => src !== null,
  };
}
