// The earlier stretches of a conversation that moved between Claude Code and Codex (#5054, useEarlierStretches.ts),
// drawn above the live one: each its own session's lines (built apart, so no exchange crosses a switch, and each later
// stretch opens with its switch divider), read only. Their messages keep Copy; nothing goes to the composer, and
// nothing rewinds, branches or forwards from them: they belong to a session the conversation has left.
import { memo, useMemo } from "react";
import { buildTaskIndex } from "../../lib/tasks";
import { chatLines, type ChatLine } from "../../lib/turns";
import { NO_WORKFLOW_CALLS } from "../../lib/workflows";
import { Button } from "../../ui/atoms";
import { t } from "../../i18n";
import { ChatActionsContext, useChatActions, type ChatActions } from "./chat-actions";
import { ChatContext, useChatContext, type ChatContextValue } from "./chat-context";
import { ChatLineView } from "./Lines";
import type { EarlierStretch } from "./useEarlierStretches";

const NO_SUBAGENTS: never[] = [];

export function EarlierStretches({ mid, stretches, error, onRetry, offscreen }: {
  mid: string;
  stretches: EarlierStretch[];
  /** The last earlier page that failed: said above them, with Retry. */
  error?: string;
  onRetry?: () => void;
  /** ChatView's: an exchange off screen skips drawing (SegmentView `offscreen`). */
  offscreen?: (line: ChatLine) => ((section: HTMLElement) => () => void) | undefined;
}) {
  if (!stretches.length && !error) return null;
  return (
    <>
      {error && (
        <div role="alert" className="flex flex-col items-center gap-2 py-2 text-center" data-engine-stretch-error>
          <p className="text-[13px] text-ink-2 [overflow-wrap:anywhere]">{t("chat-lines.engine_earlier_failed", { error })}</p>
          {onRetry && <Button onClick={onRetry} icon="retry">{t("chat-chatview.retry")}</Button>}
        </div>
      )}
      {stretches.map((s) => <StretchLines key={s.key} mid={mid} stretch={s} offscreen={offscreen} />)}
    </>
  );
}

const StretchLines = memo(function StretchLines({ mid, stretch, offscreen }: { mid: string; stretch: EarlierStretch; offscreen?: (line: ChatLine) => ((section: HTMLElement) => () => void) | undefined }) {
  const base = useChatContext();
  const actions = useChatActions();
  const { items, key, sid } = stretch;
  // its own ids: an exchange of one stretch never takes another's place (the line's data-line, the open groups' keys)
  const lines = useMemo(() => chatLines(items).map((l) => ({ ...l, id: `${key}/${l.id}` })), [items, key]);
  const tasks = useMemo(() => buildTaskIndex(items), [items]);
  const ctx = useMemo<ChatContextValue>(
    () => ({ tasks, subagents: NO_SUBAGENTS, scope: `${mid}/${sid}:${key}:`, workflowCalls: NO_WORKFLOW_CALLS, lineStyle: base.lineStyle }),
    [tasks, mid, sid, key, base.lineStyle],
  );
  const readOnly = useMemo<ChatActions | null>(
    () => (actions ? { ...actions, canCompose: false, forward: undefined, fork: undefined, rewind: undefined, images: () => items.filter((i) => i.kind === "image") } : null),
    [actions, items],
  );
  if (!lines.length) return null;
  return (
    <ChatContext.Provider value={ctx}>
      <ChatActionsContext.Provider value={readOnly}>
        <div className="contents" data-engine-stretch={sid}>
          {lines.map((line) => (
            <ChatLineView key={line.id} line={line} mid={mid} sid={sid} expandFold={stretch.expandFold} offscreen={offscreen?.(line)} />
          ))}
        </div>
      </ChatActionsContext.Provider>
    </ChatContext.Provider>
  );
});
