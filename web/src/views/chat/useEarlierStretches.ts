// The earlier stretches of a conversation that moved between Claude Code and Codex (#5054, lib/engine-switch.ts), as
// the chat around them sees them. This part is on the first screen and small: the stretches' windows, the live
// stretch's items (all the transcript's, unless the live session ran an earlier stretch too: A → B → A), and what the
// stretches' own module (EarlierStretches.tsx, loaded only for a conversation that switched) last said. That module
// reads the other sessions, read only and lazily, draws the earlier stretches above the live one and says whether
// anything older is left and how to load it. Until it has, the live transcript's own pages load as in any chat.
import { useCallback, useMemo, useRef, useState } from "react";
import { splitStretches, stretchesKey, stretchWindows, type StretchWindow } from "../../lib/engine-switch";
import type { EngineLeg, Item } from "../../lib/types";

/** What the chat's own transcript (useTranscript, the live session's) gives the stretches. */
export interface LiveTranscript {
  items: Item[];
  hasMore: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  expandFold: (fold: Item) => Promise<void>;
}

/** One earlier stretch as the chat draws it: its session's items in it, and how its folds open. */
export interface EarlierStretch {
  /** Unique in the conversation: the stretch's index and session. */
  key: string;
  index: number;
  sid: string;
  /** Its engine ("claude" / "codex"), as the row's history says. */
  agent?: string;
  items: Item[];
  expandFold: (fold: Item) => Promise<void>;
}

/** What the stretches' module tells the chat, each time it changes. */
export interface StretchesReport {
  hasMore: boolean;
  loading: boolean;
  loadEarlier: () => Promise<void>;
  /** The earlier stretches drawn, oldest first: a new array whenever what they draw changes. */
  stretches: EarlierStretch[];
}

/** The stretches' module's props (EarlierStretches.tsx). */
export interface StretchesHost {
  mid: string;
  sid: string;
  /** Identifies the conversation's stretches: a report for another is not used. */
  scope: string;
  windows: StretchWindow[];
  live: LiveTranscript;
  /** The live session's items by stretch (splitStretches) when it ran several, the same arrays while they hold the same
   *  items; empty when it ran only the live one. */
  liveSplit: Map<number, Item[]>;
  report: (scope: string, r: StretchesReport) => void;
}

export interface Stitched {
  /** The live stretch's items. */
  liveItems: Item[];
  /** The earlier stretches drawn, oldest first. */
  stretches: EarlierStretch[];
  /** Anything older left to load, the live session's own pages included. */
  hasMore: boolean;
  loadingEarlier: boolean;
  /** Loads what comes next going back: the live session's older page, or the next stretch's. */
  loadEarlier: () => Promise<void>;
  /** The stretches' module's props; null for a conversation that never switched. */
  host: StretchesHost | null;
}

const NO_STRETCHES: EarlierStretch[] = [];

function sameItems(a: readonly Item[] | undefined, b: readonly Item[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

export function useEarlierStretches(mid: string, sid: string, history: readonly EngineLeg[] | undefined, live: LiveTranscript): Stitched {
  const key = stretchesKey(history);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const windows = useMemo(() => stretchWindows(history, sid), [key, sid]);
  const scope = `${mid}\u0000${sid}\u0000${key}`;
  const [said, setSaid] = useState<{ scope: string; r: StretchesReport } | null>(null);
  const report = said?.scope === scope ? said.r : undefined;
  const hear = useCallback((at: string, r: StretchesReport) => setSaid({ scope: at, r }), []);
  // The live session's items by stretch when it ran several (A → B → A); an array whose items did not change stays the
  // same, so its lines are not built again.
  const several = windows.filter((w) => w.sid === sid).length > 1;
  const lastSplit = useRef(new Map<number, Item[]>());
  const liveSplit = useMemo(() => {
    const out = new Map<number, Item[]>();
    if (!several) return out;
    for (const [i, items] of splitStretches(live.items, windows, sid)) {
      const was = lastSplit.current.get(i);
      out.set(i, sameItems(was, items) ? was! : items);
    }
    return out;
  }, [several, windows, live.items, sid]);
  lastSplit.current = liveSplit;
  const host = useMemo<StretchesHost | null>(
    () => (windows.length ? { mid, sid, scope, windows, live, liveSplit, report: hear } : null),
    // `live` is read through: its items, pages and loads are what the module plans with
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mid, sid, scope, windows, liveSplit, hear, live.items, live.hasMore, live.loading, live.loadEarlier, live.expandFold],
  );
  if (!windows.length) return { liveItems: live.items, stretches: NO_STRETCHES, hasMore: live.hasMore, loadingEarlier: live.loadingEarlier, loadEarlier: live.loadEarlier, host: null };
  const liveItems = several ? (liveSplit.get(windows.length - 1) ?? live.items) : live.items;
  // until the module has said (it loads with the chat): the live session's own pages, and something earlier is left
  if (!report) return { liveItems, stretches: NO_STRETCHES, hasMore: true, loadingEarlier: live.loadingEarlier, loadEarlier: live.loadEarlier, host };
  return { liveItems, stretches: report.stretches, hasMore: report.hasMore, loadingEarlier: live.loadingEarlier || report.loading, loadEarlier: report.loadEarlier, host };
}
