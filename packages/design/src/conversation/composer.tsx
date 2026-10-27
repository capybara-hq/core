import {
  type ClipboardEvent,
  forwardRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { ConvMenu, type ConvMenuEntry } from "./menu";

// The composer (spec §6.16.2): the floating frame that holds the attachment strip, the textarea and
// the control row with the pickers and send / stop.

/** The composer box: `raised`, 1px `line`, radius `md`, `shadow-float`; accent + halo on focus. */
export function ComposerFrame({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="cb-composer" data-part="composer">
      {children}
    </div>
  );
}

/** The composer textarea: no border or ground, `prose` 15 / 26, placeholder `faint`. */
export const ComposerInput = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function ComposerInput({ rows = 1, ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      className="cb-composer-input"
      data-part="composer-input"
    />
  );
});

// ── Pickers and the control row (§6.16.2, §6.16.3) ──────────────────────────

export type PickerItem = {
  id: string;
  label: string;
  /** A tag after the label ("agent 默认"). */
  tag?: string;
  checked?: boolean;
};

export type PickerProps = {
  /** What the picker chooses, its accessible name ("切换模型"). */
  label: string;
  /** The current choice, shown on the button. */
  value: string;
  /**
   * Locked (the agent after the first message): plain `muted` text with no chevron and this hint
   * as its tooltip.
   */
  locked?: { hint: string };
  disabled?: boolean;
  groups: { label?: string; items: PickerItem[] }[];
  /** The note that closes the menu ("从下一条消息起生效"). */
  note?: string;
  onPick(id: string): void;
  /** The reference set only: the menu drawn open in place. */
  referenceOpen?: boolean;
};

/** A composer picker (§6.16.3): a ghost button opening a grouped menu above it. */
export function Picker({
  label,
  value,
  locked,
  disabled,
  groups,
  note,
  onPick,
  referenceOpen,
}: PickerProps): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(4);
  // The menu opens above the composer, `space.1` from its top edge (the signed reference), not
  // just above the picker: the offset is the picker's distance from the composer's top.
  const measure = () => {
    const el = trigger.current;
    const frame = el?.closest('[data-part="composer"]');
    if (el && frame)
      setOffset(el.getBoundingClientRect().top - frame.getBoundingClientRect().top + 4);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured once for the drawn-open menu
  useLayoutEffect(() => {
    if (referenceOpen) measure();
  }, [referenceOpen]);
  if (locked) {
    return (
      <span className="cb-picker" data-part="picker" data-locked="true" title={locked.hint}>
        {value}
      </span>
    );
  }
  const entries: ConvMenuEntry[] = [];
  for (const g of groups) {
    if (g.label) entries.push({ kind: "label", label: g.label });
    for (const it of g.items) {
      entries.push({
        kind: "item",
        id: it.id,
        label: it.label,
        ...(it.tag ? { tag: it.tag } : {}),
        checked: it.checked === true,
        onSelect: () => onPick(it.id),
      });
    }
  }
  if (note) entries.push({ kind: "note", text: note });
  return (
    <ConvMenu
      inline={referenceOpen === true}
      label={label}
      side="top"
      sideOffset={offset}
      align="start"
      open={open}
      onOpenChange={(o) => {
        if (o) measure();
        setOpen(o);
      }}
      trigger={
        <Button
          ref={trigger}
          variant="ghost"
          className="cb-picker"
          part="picker"
          aria-label={`${label}: ${value}`}
          disabled={disabled}
        >
          {value}
          <Icon name="chevron-down" size={12} />
        </Button>
      }
      entries={entries}
    />
  );
}

export type ComposerBoxProps = {
  value: string;
  onChange(v: string): void;
  onKeyDown?(e: KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste?(e: ClipboardEvent<HTMLTextAreaElement>): void;
  placeholder: string;
  /** Replaces the placeholder while a run is going ("按 ↵ 立即发送，按 ⌘↵ 加入队列"). */
  hint?: string;
  /** The attachment strip, above the textarea. */
  attachments?: ReactNode;
  onAttach(): void;
  attachDisabled?: boolean;
  pickers: { agent: PickerProps; model: PickerProps; effort?: PickerProps };
  send: { mode: "send" | "stop"; disabled?: boolean; busy?: boolean; onClick(): void };
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** The reference set only: draw the focused frame (`:focus-within` is forced there). */
  autoFocus?: boolean;
  /**
   * A chip before the text (phase D: the invoked skill, "/fix-issue"). Its `hint` (the skill's
   * argument hint) becomes the placeholder; Backspace with the caret at the start, or its ×,
   * calls `onRemove` and keeps the text.
   */
  token?: ComposerToken;
};

/** The composer's chip (§6.16.2, state `skill`). */
export type ComposerToken = { label: string; hint?: string; onRemove(): void };

/** The chip before the composer text: `accent` mono label on `accent-tint`, with a remove ×. */
function ComposerTokenChip({ token }: { token: ComposerToken }): JSX.Element {
  const t = useDesignT();
  return (
    <span className="cb-composer-token" data-part="composer-token">
      <span className="cb-composer-token-label">{token.label}</span>
      <button
        type="button"
        className="cb-composer-token-remove"
        data-part="composer-token-remove"
        aria-label={t("composer.removeToken").replace("{name}", token.label)}
        onClick={token.onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

/**
 * The composer (§6.16.2): the frame, the attachment strip, the textarea (grows to 8 lines) and the
 * control row: ＋ · agent · model · effort (hidden without efforts) · send / stop.
 */
export function ComposerBox({
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  hint,
  attachments,
  onAttach,
  attachDisabled,
  pickers,
  send,
  textareaRef,
  autoFocus,
  token,
}: ComposerBoxProps): JSX.Element {
  const t = useDesignT();
  const id = useId();
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (
      token &&
      e.key === "Backspace" &&
      !e.nativeEvent.isComposing &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0
    ) {
      e.preventDefault();
      token.onRemove();
      return;
    }
    onKeyDown?.(e);
  };
  const input = (
    <ComposerInput
      id={id}
      ref={textareaRef}
      value={value}
      placeholder={token?.hint ?? hint ?? placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      {...(onKeyDown || token ? { onKeyDown: keyDown } : {})}
      {...(onPaste ? { onPaste } : {})}
    />
  );
  return (
    <ComposerFrame>
      {attachments}
      <label className="cb-sr-only" htmlFor={id}>
        {t("composer.message")}
      </label>
      {token ? (
        <div className="cb-composer-line" data-part="composer-line">
          <ComposerTokenChip token={token} />
          {input}
        </div>
      ) : (
        input
      )}
      <div className="cb-composer-bar" data-part="composer-bar">
        <IconButton
          label={t("composer.attach")}
          icon={<Icon name="plus" size={16} />}
          disabled={attachDisabled}
          onClick={onAttach}
        />
        <Picker {...pickers.agent} />
        <Picker {...pickers.model} />
        {pickers.effort ? <Picker {...pickers.effort} /> : null}
        <span className="cb-grow" />
        {send.mode === "stop" ? (
          <IconButton
            className="cb-stop"
            part="stop"
            variant="ghost"
            label={t("composer.stop")}
            icon={<Icon name="square" size={14} />}
            disabled={send.busy}
            aria-busy={send.busy ? true : undefined}
            onClick={send.onClick}
          />
        ) : (
          <IconButton
            className="cb-send"
            part="send"
            variant="ghost"
            label={t("composer.send")}
            icon={<Icon name="arrow-up" size={16} />}
            disabled={send.disabled || send.busy}
            aria-busy={send.busy ? true : undefined}
            onClick={send.onClick}
          />
        )}
      </div>
    </ComposerFrame>
  );
}
