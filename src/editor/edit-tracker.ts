// A build compiles a snapshot of each open file while the user keeps typing. The tracker keeps
// that snapshot (`doc`) and every change made since (`changes`), so diagnostics computed against
// the snapshot can be moved to where the same text is now (the approach @codemirror/lsp-client
// uses for its unsynced changes). The editor never has to be locked during a compile or a run.

import { ChangeSet, MapMode, type ChangeDesc, type Text } from "@codemirror/state";

export class EditTracker {
  /** Every change since `doc`, composed into one. */
  changes: ChangeSet;
  /**
   * Set when the file's content was replaced wholesale (a pull into a clean file) or a change
   * didn't fit: positions computed on `doc` no longer mean anything and are dropped.
   */
  stale = false;

  /** `doc` is the text the tool sees (send `doc.toString()`). */
  constructor(readonly doc: Text) {
    this.changes = ChangeSet.empty(doc.length);
  }

  /** Records a change made to the file after the snapshot (call in order, for every change). */
  add(change: ChangeSet): void {
    if (this.stale) return;
    if (change.length !== this.changes.newLength) {
      this.stale = true;
      return;
    }
    this.changes = this.changes.compose(change);
  }

  /** Where `pos` in the snapshot is now (`assoc` as in ChangeDesc.mapPos). */
  mapPos(pos: number, assoc: -1 | 1 = 1): number {
    return this.changes.mapPos(pos, assoc);
  }

  /**
   * Where the snapshot range [from, to] is now. Text typed at either edge stays outside the
   * range, text typed inside it widens it, and text that replaces the whole range becomes the
   * range. Returns null when everything the range covered was deleted with nothing in its place
   * (the lint state maps its own marks the same way and drops those), or when the tracker is stale.
   */
  mapRange(from: number, to: number): { from: number; to: number } | null {
    if (this.stale) return null;
    const desc: ChangeDesc = this.changes;
    if (from === to) {
      const at = desc.mapPos(from, 1, MapMode.TrackDel);
      return at === null ? null : { from: at, to: at };
    }
    const f = desc.mapPos(from, 1);
    const t = desc.mapPos(to, -1);
    return t <= f ? null : { from: f, to: t };
  }
}
