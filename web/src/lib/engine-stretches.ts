// What the chat needs of a conversation's earlier stretches (#5054, lib/engine-switch.ts) only once it reads them: which
// stretch is whole and which loads next. Off the first screen: only the stretches' own module (views/chat/
// EarlierStretches.tsx, loaded for a conversation that switched) imports it.
import type { StretchWindow } from "./engine-switch";
import type { Item } from "./types";

const ms = (s: string | undefined): number | undefined => {
  const v = Date.parse(s ?? "");
  return Number.isFinite(v) ? v : undefined;
};

/** What is loaded of one session: its items so far (oldest first), whether older pages are left, and whether its
 *  first page came at all. */
export interface StretchSource {
  items: readonly Item[];
  hasMore: boolean;
  ready: boolean;
}

/** Everything stretch `w` holds is loaded: its session has no older page, or (when it ran an earlier stretch too) what
 *  is loaded already reaches back past this stretch's start. */
export function stretchComplete(w: StretchWindow, windows: readonly StretchWindow[], src: StretchSource | undefined): boolean {
  if (!src?.ready) return false;
  if (!src.hasMore) return true;
  const first = windows.find((x) => x.sid === w.sid);
  if (!first || first.index === w.index || w.after === undefined) return false;
  const oldest = src.items.map((i) => ms(i.ts)).find((v) => v !== undefined);
  return oldest !== undefined && oldest <= w.after;
}

/** Which earlier stretches the chat shows and which one loads next. Read from the live stretch back, a stretch shows
 *  only once every later one is whole, so nothing ever moves in between what is on screen: the newest incomplete one
 *  shows what it has and is `next` (its older page, or its session's first page, is what scrolling up loads), the ones
 *  before it wait. `shown`: the earlier stretches' indexes, oldest first (the live stretch is the chat itself). */
export function planStretches(windows: readonly StretchWindow[], sourceOf: (sid: string) => StretchSource | undefined): { shown: number[]; next?: number } {
  const shown: number[] = [];
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (!w.live) shown.unshift(i);
    if (!stretchComplete(w, windows, sourceOf(w.sid))) return { shown, next: i };
  }
  return { shown };
}
