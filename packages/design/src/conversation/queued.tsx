import { type JSX, useEffect, useState } from "react";
import { Button, IconButton } from "../controls/button";
import { Textarea } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { BubbleSkill } from "./bubble";
import { fillCopy } from "./tool-copy";

export type QueuedMessageProps = {
  text: string;
  /** A queued skill invocation (phase D): the chip before the text (its arguments). */
  skill?: string;
  /** Edit in place: a prose textarea with Cancel / Save. */
  editing?: boolean;
  /** The queue is paused (the run failed or stopped): the bubble without its actions. */
  paused?: boolean;
  /** Disables the actions while a change is in flight. */
  busy?: boolean;
  onCopy(): void;
  onEdit(): void;
  onSave?(text: string): void;
  onCancelEdit?(): void;
  onDelete(): void;
  onSendNow(): void;
};

/**
 * A message queued with ⌘↵ while a run is going (§6.16.14): a translucent dashed user bubble and,
 * under it, "Queued", copy / edit / delete and "Send now". Not in the event log until it is sent.
 */
export function QueuedMessage(p: QueuedMessageProps): JSX.Element {
  const t = useDesignT();
  const [draft, setDraft] = useState(p.text);
  // A fresh edit starts from the current text (another tab may have changed it).
  useEffect(() => {
    if (p.editing) setDraft(p.text);
  }, [p.editing, p.text]);

  if (p.editing) {
    const save = () => {
      if (draft.trim() !== "") p.onSave?.(draft);
    };
    return (
      <div className="cb-user-msg" data-part="queued-message" data-state="editing">
        <div className="cb-queued-edit">
          <Textarea
            aria-label={t("queue.editLabel")}
            rows={2}
            value={draft}
            disabled={p.busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                p.onCancelEdit?.();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="cb-queued-actions" data-part="queued-actions">
            <Button variant="ghost" density="dense" disabled={p.busy} onClick={p.onCancelEdit}>
              {t("queue.cancel")}
            </Button>
            <Button
              variant="primary"
              density="dense"
              disabled={p.busy || draft.trim() === ""}
              onClick={save}
            >
              {t("queue.save")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="cb-user-msg" data-part="queued-message">
      <div className="cb-bubble" data-part="bubble" data-queued="true">
        {p.skill !== undefined ? <BubbleSkill label={p.skill} /> : null}
        {p.text}
      </div>
      {p.paused ? null : (
        <div className="cb-queued-actions" data-part="queued-actions">
          <span className="cb-faint cb-queued-label" data-part="queued-label">
            {t("queue.queued")}
          </span>
          <IconButton
            density="dense"
            icon={<Icon name="copy" size={14} />}
            label={t("queue.copy")}
            onClick={p.onCopy}
          />
          <IconButton
            density="dense"
            icon={<Icon name="square-pen" size={14} />}
            label={t("queue.edit")}
            disabled={p.busy}
            onClick={p.onEdit}
          />
          <IconButton
            density="dense"
            icon={<Icon name="trash-2" size={14} />}
            label={t("queue.delete")}
            disabled={p.busy}
            onClick={p.onDelete}
          />
          <Button density="dense" disabled={p.busy} onClick={p.onSendNow}>
            {t("queue.sendNow")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The paused queue (§6.16.14): "Run stopped; queue paused (N)" (or the caller's `text`, which says
 * why it paused) and "Continue sending".
 */
export function QueuePaused({
  count,
  busy,
  text,
  onContinue,
}: {
  count: number;
  busy?: boolean;
  /** Replaces the default line (another pause reason than a stopped run). */
  text?: string;
  onContinue(): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-queued-actions cb-queued-paused-row">
      <span className="cb-muted" data-part="queued-paused">
        {text ?? fillCopy(t("queue.paused"), { n: count })}
      </span>
      <Button density="dense" disabled={busy} onClick={onContinue}>
        {t("queue.continue")}
      </Button>
    </div>
  );
}
