// The earlier stretches of a conversation that moved between Claude Code and Codex (#5054, lib/engine-switch.ts): the
// sessions its row names (Session.engine_history) are read here, read only and lazily, so the chat reads as one
// conversation. Nothing loads until the live stretch is whole (its own pages come from useTranscript, untouched); then
// each "load earlier" goes to the newest stretch not yet whole: its session's newest page, then its older pages
// (`before_seq`), as scrolling up loads a session's own. A stretch shows only once every later one is whole, so nothing
// ever moves in between what is on screen. A session that ran several stretches (A → B → A) is split by their times.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, sessionPath } from "../../lib/api";
import { planStretches, splitStretches, stretchesKey, stretchWindows, type StretchSource } from "../../lib/engine-switch";
import { sessionLoadError } from "../../lib/session-link";
import { mergeItems } from "../../lib/turns";
import type { EngineLeg, Item, ItemsPage } from "../../lib/types";

const PAGE = "turns=2&fold_work=1&lazy_images=1";
/** After a page fails, loading waits this long before asking again (scrolling at the top asks on every tick), doubling up to the cap. */
const RETRY_MS = 3000;
const RETRY_MAX_MS = 30_000;

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

/** What the chat's own transcript (useTranscript, the live session's) gives this. */
export interface LiveTranscript {
  items: Item[];
  hasMore: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  expandFold: (fold: Item) => Promise<void>;
}

export interface Stitched {
  /** The live stretch's items: all the transcript's, unless the live session ran an earlier stretch too. */
  liveItems: Item[];
  /** The earlier stretches shown, oldest first. */
  stretches: EarlierStretch[];
  /** Anything older left to load, the live session's own pages included. */
  hasMore: boolean;
  loadingEarlier: boolean;
  /** Loads what comes next going back: the live session's older page, or the next stretch's. */
  loadEarlier: () => Promise<void>;
  /** The last earlier stretch's page that failed, in words ("" when none). */
  error: string;
  retry: () => void;
}

interface Store {
  items: Item[];
  hasMore: boolean;
  ready: boolean;
}

const NO_STORES: Record<string, Store> = {};
const NO_STRETCHES: EarlierStretch[] = [];

function sameItems(a: readonly Item[] | undefined, b: readonly Item[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

export function useEarlierStretches(mid: string, sid: string, history: readonly EngineLeg[] | undefined, live: LiveTranscript): Stitched {
  const key = stretchesKey(history);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const windows = useMemo(() => stretchWindows(history, sid), [key, sid]);
  const scope = `${mid}\u0000${sid}\u0000${key}`;
  const [state, setState] = useState<{ scope: string; stores: Record<string, Store> }>({ scope, stores: NO_STORES });
  const stores = state.scope === scope ? state.stores : NO_STORES;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const gen = useRef(0);
  const inFlight = useRef(false);
  const retryAt = useRef(0);
  const wait = useRef(0);
  useEffect(() => {
    gen.current++;
    inFlight.current = false;
    retryAt.current = 0;
    wait.current = 0;
    setLoading(false);
    setError("");
  }, [scope]);

  const liveSource = useMemo<StretchSource>(() => ({ items: live.items, hasMore: live.hasMore, ready: !live.loading }), [live.items, live.hasMore, live.loading]);
  const sourceOf = useCallback((s: string): StretchSource | undefined => (s === sid ? liveSource : stores[s]), [sid, liveSource, stores]);
  const plan = useMemo(() => planStretches(windows, sourceOf), [windows, sourceOf]);

  // Each session's items by stretch; an array whose items did not change stays the same, so its lines are not built again.
  const lastSplit = useRef(new Map<number, Item[]>());
  const split = useMemo(() => {
    const out = new Map<number, Item[]>();
    for (const s of new Set(windows.map((w) => w.sid))) {
      const src = sourceOf(s);
      for (const [i, items] of splitStretches(src?.items ?? [], windows, s)) {
        const was = lastSplit.current.get(i);
        out.set(i, sameItems(was, items) ? was! : items);
      }
    }
    return out;
  }, [windows, sourceOf]);
  lastSplit.current = split;

  const expandOther = useCallback(
    async (s: string, fold: Item) => {
      if (!fold.fold) return;
      const g = gen.current;
      let from = fold.seq;
      const out: Item[] = [];
      for (let n = 0; n < 20; n++) {
        const p = await api<ItemsPage>(`${sessionPath(mid, s)}/items?from_seq=${from}&through_seq=${fold.fold.through_seq}&lazy_images=1`);
        if (g !== gen.current) return;
        out.push(...(p.items ?? []));
        if (!p.more || !p.items?.length) break;
        from = p.items[p.items.length - 1].seq + 1;
      }
      setState((st) => {
        const base = st.scope === scope ? st.stores : NO_STORES;
        const cur = base[s];
        return cur ? { scope, stores: { ...base, [s]: { ...cur, items: mergeItems(cur.items, out) } } } : st;
      });
    },
    [mid, scope],
  );
  // one function per session, the same while the conversation is (a stretch's lines keep their memo)
  const folds = useMemo(() => {
    const out = new Map<string, (fold: Item) => Promise<void>>();
    for (const w of windows) if (w.sid !== sid && !out.has(w.sid)) out.set(w.sid, (fold) => expandOther(w.sid, fold));
    return out;
  }, [windows, sid, expandOther]);

  const lastStretches = useRef<EarlierStretch[]>(NO_STRETCHES);
  const stretches = useMemo(() => {
    const next = plan.shown.map((i): EarlierStretch => {
      const w = windows[i];
      return { key: `${i}:${w.sid}`, index: i, sid: w.sid, agent: w.agent, items: split.get(i) ?? [], expandFold: w.sid === sid ? live.expandFold : folds.get(w.sid)! };
    });
    const was = lastStretches.current;
    const same = was.length === next.length && was.every((x, k) => x.key === next[k].key && x.items === next[k].items && x.expandFold === next[k].expandFold);
    return same ? was : next.length ? next : NO_STRETCHES;
  }, [plan, windows, split, sid, live.expandFold, folds]);
  lastStretches.current = stretches;

  const liveWindow = windows.at(-1);
  const liveItems = !liveWindow || windows.filter((w) => w.sid === sid).length < 2 ? live.items : (split.get(liveWindow.index) ?? live.items);

  // read when loading, so the callback stays the same across pushes
  const now = useRef({ plan, windows, stores, live, scope });
  now.current = { plan, windows, stores, live, scope };

  const loadEarlier = useCallback(async () => {
    const { plan: p, windows: ws, stores: have, live: tr, scope: at } = now.current;
    if (!ws.length) return tr.loadEarlier();
    if (p.next === undefined) return;
    const w = ws[p.next];
    if (w.sid === sid) return tr.loadEarlier();
    if (inFlight.current || Date.now() < retryAt.current) return;
    const g = gen.current;
    const store = have[w.sid];
    const first = store?.ready ? store.items[0] : undefined;
    inFlight.current = true;
    setLoading(true);
    try {
      const page = await api<ItemsPage>(`${sessionPath(mid, w.sid)}/items?${PAGE}${first ? `&before_seq=${first.seq}` : ""}`);
      if (g !== gen.current) return;
      const got = page.items ?? [];
      setState((st) => {
        const base = st.scope === at ? st.stores : NO_STORES;
        const cur = base[w.sid];
        // an empty page ends it whatever it says: asking again from the same place would get the same
        return { scope: at, stores: { ...base, [w.sid]: { items: mergeItems(cur?.items ?? [], got), hasMore: Boolean(page.has_more) && got.length > 0, ready: true } } };
      });
      setError("");
      retryAt.current = 0;
      wait.current = 0;
    } catch (e) {
      if (g !== gen.current) return;
      wait.current = Math.min(wait.current ? wait.current * 2 : RETRY_MS, RETRY_MAX_MS);
      retryAt.current = Date.now() + wait.current;
      setError(sessionLoadError(errorText(e)));
    } finally {
      if (g === gen.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [mid, sid]);

  const retry = useCallback(() => {
    retryAt.current = 0;
    wait.current = 0;
    setError("");
    void loadEarlier();
  }, [loadEarlier]);

  if (!windows.length) return { liveItems: live.items, stretches: NO_STRETCHES, hasMore: live.hasMore, loadingEarlier: live.loadingEarlier, loadEarlier, error: "", retry };
  return { liveItems, stretches, hasMore: plan.next !== undefined, loadingEarlier: live.loadingEarlier || loading, loadEarlier, error, retry };
}
