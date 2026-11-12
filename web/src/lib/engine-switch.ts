// A conversation that moved between Claude Code and Codex (#5054). The first message the new engine got carries the
// handoff in a `<persona-context kind="engine-switch" …>` block (the chat draws the switch divider from it, never a
// context chip), and the row running the conversation now names the sessions that ran it before (Session.engine_history),
// whose transcripts the chat reads in order so the conversation reads as one (docs/protocol/protocol.md "Switching a
// running Agent to another engine").
import type { EngineLeg, Item, Session } from "./types";

/** The `kind` of the block the handoff is carried in (the node's handoffBlock). */
export const ENGINE_SWITCH_KIND = "engine-switch";

/** One switch as its block says it: the engines ("claude" / "codex"), the model the new engine runs (when known),
 *  whether the conversation went back to an earlier session of that engine (`resumed="1"`), and the handoff text. */
export interface EngineSwitch {
  from: string;
  to: string;
  model?: string;
  resumed: boolean;
  text: string;
}

/** The switch a parsed `<persona-context>` block stands for (lib/turns.ts Context, its attributes already unescaped);
 *  undefined for any other block. */
export function engineSwitchOf(c: { kind: string; text: string; attrs?: Record<string, string> }): EngineSwitch | undefined {
  if (c.kind !== ENGINE_SWITCH_KIND) return undefined;
  const a = c.attrs ?? {};
  return { from: a.from?.trim() ?? "", to: a.to?.trim() ?? "", model: a.model?.trim() || undefined, resumed: a.resumed === "1", text: c.text };
}

/** One stretch of the conversation: the session that ran it and the times it covers, (after, until] in ms (undefined:
 *  open on that side). The windows run oldest first; the last is the live session's, after the last switch. */
export interface StretchWindow {
  index: number;
  sid: string;
  agent?: string;
  after?: number;
  until?: number;
  live: boolean;
}

const ms = (s: string | undefined): number | undefined => {
  const v = Date.parse(s ?? "");
  return Number.isFinite(v) ? v : undefined;
};

/** The conversation's stretches: one for each leg of `history` (stretch i covers (until[i-1], until[i]], the first
 *  everything up to until[0]) and the live session's after the last `until`. None when it never switched. */
export function stretchWindows(history: readonly EngineLeg[] | undefined, live: string): StretchWindow[] {
  const legs = (history ?? []).filter((l) => l.session_id);
  if (!legs.length) return [];
  const out: StretchWindow[] = legs.map((leg, i) => ({ index: i, sid: leg.session_id, agent: leg.agent, after: i ? ms(legs[i - 1].until) : undefined, until: ms(leg.until), live: false }));
  out.push({ index: legs.length, sid: live, after: ms(legs[legs.length - 1].until), until: undefined, live: true });
  return out;
}

/** A key that changes only when the stretches do (the row's array is new with every push). */
export function stretchesKey(history: readonly EngineLeg[] | undefined): string {
  return (history ?? []).map((l) => `${l.session_id}@${l.until}`).join("|");
}

/** A session's items, each in the stretch of the conversation it belongs to (by stretch index): all of them in its
 *  stretch when the session ran only one; else each in the last of its stretches that began before it was written, the
 *  earliest for anything older. An item without a time goes with the one before it (the first ones with the first
 *  timed one). Every stretch of the session is in the map, empty when nothing loaded falls in it. */
export function splitStretches(items: readonly Item[], windows: readonly StretchWindow[], sid: string): Map<number, Item[]> {
  const own = windows.filter((w) => w.sid === sid);
  const out = new Map<number, Item[]>(own.map((w) => [w.index, []]));
  if (!own.length) return out;
  if (own.length === 1) {
    out.set(own[0].index, [...items]);
    return out;
  }
  const at = items.map((i) => ms(i.ts));
  let known = at.find((v) => v !== undefined);
  for (let k = 0; k < items.length; k++) {
    known = at[k] ?? known;
    let home = own[0];
    if (known !== undefined) for (const w of own) if (w.after === undefined || w.after < known) home = w;
    out.get(home.index)!.push(items[k]);
  }
  return out;
}

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

/** The listed row a session's conversation moved on to (#5054): a session named in another listed row's
 *  engine_history and not listed itself opens that row's chat (`rows`: one machine's). */
export function engineSwitchHome(rows: readonly Session[], sid: string): Session | undefined {
  if (!sid || rows.some((r) => r.session_id === sid)) return undefined;
  return rows.find((r) => r.session_id !== sid && r.engine_history?.some((l) => l.session_id === sid));
}
