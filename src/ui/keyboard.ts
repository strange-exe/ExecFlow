// Is the on-screen keyboard open? (phone layout, option A, 2026-11-03: .claude/design/redesign8/phone/options.html)
// No browser says so directly. index.html asks for interactive-widget=resizes-content, so where that
// is supported (Chromium on Android) the keyboard makes the window itself shorter; elsewhere (Safari)
// only the visual viewport shrinks. Either way the page is told by a height well under the full
// height seen at this width while the code has the focus. A new width (a turn of the phone) starts
// the count again; the browser's own bars coming and going move the height by far less than the
// threshold.

/** A keyboard takes 150 px or more; a browser's bars sliding away take well under 100. */
export const KEYBOARD_MIN = 150;

export interface ViewportSample {
  /** The layout viewport (innerWidth, innerHeight). */
  width: number;
  height: number;
  /** visualViewport.height where there is one. */
  visualHeight?: number;
}

export class KeyboardWatch {
  private width = -1;
  private full = 0;

  /**
   * Takes a sample and returns the keyboard's height in CSS px (0: none). `typing`: the code has the
   * focus (nothing else opens the keyboard over the dock).
   */
  inset(sample: ViewportSample, typing: boolean): number {
    const seen = Math.min(sample.height, sample.visualHeight ?? sample.height);
    if (sample.width !== this.width) {
      this.width = sample.width;
      this.full = sample.height;
    } else this.full = Math.max(this.full, sample.height);
    const inset = Math.max(0, this.full - seen);
    return typing && inset >= KEYBOARD_MIN ? inset : 0;
  }
}
