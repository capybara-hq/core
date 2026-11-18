import {
  type ClipboardEvent,
  forwardRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { Callout } from "../display/callout";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "../layout/box";
import { useDesignT } from "../provider";
import { isTouchPointer } from "../shell/pointer";
import { ComposerOptions } from "./composer-options";
import { ConvMenu, type ConvMenuEntry } from "./menu";
import { findTokenLikeSpans, removeSpans, type TokenLikeKind } from "./token-like";

// The composer (spec §6.16.2): the floating frame that holds the attachment strip, the textarea and
// the control row with the pickers and send / stop.

/**
 * The composer box: `raised`, 1px `line`, radius `md`, `shadow-float`; accent + halo on focus.
 * `bare`: the same element and part without the box (no padding, border, ground or shadow), for a
 * plugin's frame drawn around the composer (client extensions spec §5.3).
 */
export function ComposerFrame({
  busy,
  bare,
  children,
}: {
  /** A send or stop is in flight: `aria-busy` for plugin CSS. */
  busy?: boolean;
  bare?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="cb-composer"
      data-part="composer"
      data-cap-part="composer"
      data-frame={bare ? "bare" : undefined}
      aria-busy={busy ? true : undefined}
    >
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
  /** Not choosable; its `tag` then says why ("未配置"). */
  disabled?: boolean;
  /** An attention mark after the tag, as a `warn` Badge (a device's 「开放」). */
  badge?: string;
  /** The badge's tone: `fail` for a danger mark; default `warn`. */
  badgeTone?: "default" | "warn" | "fail";
  /** An icon before the label, in the item's own neutral color (a permission profile's). */
  icon?: IconName;
  /**
   * A sentence under the label explaining the choice (a permission profile's); the item's
   * accessible description, its name staying the label and tag.
   */
  description?: string;
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
  locked?: { hint: string; warning?: { label: string; onInspect(): void } };
  disabled?: boolean;
  groups: { label?: string; items: PickerItem[] }[];
  /** The note that closes the menu ("从下一条消息起生效"). */
  note?: string;
  /**
   * One plain action after the items, not a choice ("Set the review model" for an org admin): a menu item
   * that closes the menu, a ghost button in the phone sheet.
   */
  action?: { label: string; icon?: IconName; onSelect(): void };
  onPick(id: string): void;
  /** The reference set only: the menu drawn open in place. */
  referenceOpen?: boolean;
};

/**
 * A value this short (an effort, 「高」) never gives way in a short row: its button keeps its width
 * and the long labels (the model's) take the ellipsis, so one glyph is never cut in half.
 */
export function isShortPickerValue(value: string): boolean {
  return [...value].length <= 3;
}

/** A composer picker (§6.16.3): a ghost button opening a grouped menu above it. */
export function Picker({
  label,
  value,
  locked,
  disabled,
  groups,
  note,
  action,
  onPick,
  referenceOpen,
}: PickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  if (locked?.warning) {
    return (
      <Button
        variant="ghost"
        density="dense"
        className="cb-picker"
        aria-label={`${label}: ${value} · ${locked.warning.label}`}
        title={locked.hint}
        onClick={locked.warning.onInspect}
      >
        <span className="cb-picker-value" data-locked="true">
          {value}
        </span>
        <span className="cb-picker-warning" data-part="picker-warning">
          <Icon name="circle-alert" size={12} />
          {locked.warning.label}
        </span>
      </Button>
    );
  }
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
        ...(it.badge ? { badge: it.badge } : {}),
        ...(it.badgeTone ? { badgeTone: it.badgeTone } : {}),
        ...(it.icon ? { icon: it.icon } : {}),
        ...(it.description ? { description: it.description } : {}),
        checked: it.checked === true,
        ...(it.disabled ? { disabled: true } : {}),
        onSelect: () => onPick(it.id),
      });
    }
  }
  if (action)
    entries.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "picker-action",
        label: action.label,
        ...(action.icon ? { icon: action.icon } : {}),
        onSelect: action.onSelect,
      },
    );
  if (note) entries.push({ kind: "note", text: note });
  return (
    <ConvMenu
      inline={referenceOpen === true}
      label={label}
      anchored
      // drawn open in place (the reference set): above, as on the conversation page
      side="top"
      align="start"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="ghost"
          className="cb-picker"
          part="picker"
          aria-label={`${label}: ${value}`}
          title={value}
          disabled={disabled}
          data-short={isShortPickerValue(value) ? "true" : undefined}
        >
          {/* a long label (the model's) gives way with an ellipsis on a phone (AC3 fix round 1) */}
          <span className="cb-picker-value" data-part="picker-value">
            {value}
          </span>
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
  /** Replaces the placeholder while a run is going ("运行中发送的消息会在下一步交给智能体"). */
  hint?: string;
  /** The attachment strip, above the textarea. */
  attachments?: ReactNode;
  onAttach(): void;
  attachDisabled?: boolean;
  /**
   * The pickers. `agent` is absent on the new conversation page, whose agents row chooses the
   * agent (agent profile design §4.2); the model and effort pickers stay. `device` sits
   * after the agent and is `locked` after the first message. Optional `permission` follows
   * the device, before the model and effort.
   */
  pickers: {
    agent?: PickerProps;
    device?: PickerProps;
    permission?: PickerProps;
    model: PickerProps;
    effort?: PickerProps;
  };
  /**
   * The selected agent's quick actions (`QuickActions`, §6.16.27): a `zap` button right after the
   * effort picker, given only when the agent has some.
   */
  quickActions?: ReactNode;
  /**
   * The agent map's entry (`AgentsChip`, §6.16.29): "N 个智能体" after the effort picker and the
   * quick actions, given once the conversation has a sub-agent.
   */
  agents?: ReactNode;
  send: { mode: "send" | "stop"; disabled?: boolean; busy?: boolean; onClick(): void };
  /**
   * Sends the draft as ↵ does, for the token warning's 「仍然发送」 (setup guides v2 spec §12.1)
   * while a run is going and the button is Stop. Without it 「仍然发送」 uses `send.onClick` in
   * send mode, and in stop mode only dismisses the warning (the next ↵ sends).
   */
  onSend?(): void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** The reference set only: draw the focused frame (`:focus-within` is forced there). */
  autoFocus?: boolean;
  /**
   * `false`: the composer's inputs without the frame's box (`ComposerFrame bare`): what a plugin's
   * `conversation.composer.frame` replacement wraps in its own frame. Default `true`.
   */
  frame?: boolean;
  /**
   * A chip before the text (phase D: the invoked skill, "/fix-issue"). Its `hint` (the skill's
   * argument hint) becomes the placeholder; Backspace with the caret at the start, or its ×,
   * calls `onRemove` and keeps the text.
   */
  token?: ComposerToken;
  /**
   * A prompt suggestion (state `suggestion`): the person's likely next message after a completed
   * run. It is the placeholder while the draft is empty, no `token` is set and no `hint` shows;
   * Tab (no modifier) fills the draft with it, and on a touch device a "Use suggestion" button
   * before send does.
   */
  suggestion?: {
    text: string;
    /** Esc, typing, paste or attaching ended it for this run; the caller stops passing it. */
    onDismiss(): void;
  };
  /** The reference set and catalog only: draw the suggestion's touch button with a fine pointer. */
  referenceTouch?: boolean;
};

/** The order the warning names kinds in (the vendor ones before the entropy guess). */
const TOKEN_KINDS: TokenLikeKind[] = [
  "slack-token",
  "slack-app-token",
  "github-token",
  "api-key",
  "aws-key",
  "google-key",
  "private-key",
  "jwt",
  "high-entropy",
];

/** The composer's chip (§6.16.2, state `skill`). */
export type ComposerToken = { label: string; hint?: string; onRemove(): void };

/** The chip before the composer text: `accent` mono label on `accent-tint`, with a remove ×. */
function ComposerTokenChip({
  token,
  labelId,
  onRemove,
}: {
  token: ComposerToken;
  /** The label's id: the textarea is described by it (batch 5 review m2). */
  labelId: string;
  onRemove(): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <span className="cb-composer-token" data-part="composer-token">
      <span className="cb-composer-token-label" id={labelId}>
        {token.label}
      </span>
      <button
        type="button"
        className="cb-composer-token-remove"
        data-part="composer-token-remove"
        aria-label={t("composer.removeToken").replace("{name}", token.label)}
        onClick={onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

/**
 * The composer (§6.16.2): the frame, the attachment strip, the textarea (grows to 8 lines) and the
 * control row: ＋ · agent · device · model · effort (hidden without efforts) · quick actions
 * (only when the agent has some) · the agents chip (once the conversation has a sub-agent) · send /
 * stop. Below 640 the device, model and effort pickers are one options button
 * (`ComposerOptions`) opening a bottom sheet with the three groups.
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
  quickActions,
  agents,
  send,
  onSend,
  textareaRef,
  autoFocus,
  token,
  suggestion,
  referenceTouch,
  frame = true,
}: ComposerBoxProps): JSX.Element {
  const t = useDesignT();
  // The prompt suggestion shows only over an empty, idle draft without a skill chip.
  const suggested = suggestion && value === "" && !token && !hint ? suggestion : undefined;
  // A touch device has no Tab key: the suggestion gets a button. Read after mounting, never in
  // render, so the server render and hydration agree.
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchPointer()), []);
  // The token paste warning (setup guides v2 spec §12.1): raised by a paste holding token-like
  // text or by a send whose draft holds some; a guard against a slip, never a block. The draft is
  // scanned here in the browser only: nothing is logged or sent anywhere.
  const [warn, setWarn] = useState(false);
  const spans = useMemo(() => (warn ? findTokenLikeSpans(value) : []), [warn, value]);
  const warning = warn && spans.length > 0;
  // An edit that leaves no token-like text clears it (a paste raises it before its text arrives,
  // so only a change of the draft can clear it).
  const warnNow = useRef(warn);
  warnNow.current = warn;
  useEffect(() => {
    if (warnNow.current && findTokenLikeSpans(value).length === 0) setWarn(false);
  }, [value]);
  /** A send: the first one with token-like text shows the warning instead; one while it shows sends. */
  const gate = (): boolean => {
    if (warning) {
      setWarn(false);
      return true;
    }
    if (findTokenLikeSpans(value).length > 0) {
      setWarn(true);
      return false;
    }
    return true;
  };
  const id = useId();
  const tokenLabelId = `${id}-token`;
  const suggestionHintId = `${id}-suggestion`;
  const inner = useRef<HTMLTextAreaElement | null>(null);
  // the caller's ref and ours on the same textarea
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof textareaRef === "function") textareaRef(el);
      else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
    },
    [textareaRef],
  );
  // The × unmounts with the chip (and the textarea moves out of the chip's line): focus goes to
  // the text once the chip is gone, never to <body> (batch 5 review m1).
  const refocus = useRef(false);
  useEffect(() => {
    if (token || !refocus.current) return;
    refocus.current = false;
    inner.current?.focus();
  }, [token]);
  /** Fills the draft with the suggestion and ends it for this run. */
  const takeSuggestion = (text: string, caret: boolean) => {
    onChange(text);
    if (caret) {
      // the caret goes to the end once the draft holds the text
      requestAnimationFrame(() => inner.current?.setSelectionRange(text.length, text.length));
    }
    suggestion?.onDismiss();
  };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (suggested && !e.nativeEvent.isComposing) {
      // Tab is taken only here (an empty draft showing a suggestion), so focus navigation is
      // unchanged everywhere else; Shift+Tab and Tab with a modifier never are.
      if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        takeSuggestion(suggested.text, true);
        return;
      }
      if (e.key === "Escape") suggested.onDismiss();
    }
    if (onKeyDown && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !gate()) {
      e.preventDefault();
      return;
    }
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
      ref={setRef}
      value={value}
      placeholder={suggested ? suggested.text : (token?.hint ?? hint ?? placeholder)}
      {...(token ? { "aria-describedby": tokenLabelId } : {})}
      {...(suggested ? { "aria-describedby": suggestionHintId, "data-suggestion": "true" } : {})}
      autoFocus={autoFocus}
      onChange={(e) => {
        onChange(e.target.value);
        // any edit that leaves text ends the suggestion for this run
        if (suggestion && e.target.value !== "") suggestion.onDismiss();
      }}
      {...(onKeyDown || token || suggested ? { onKeyDown: keyDown } : {})}
      onPaste={(e) => {
        if (findTokenLikeSpans(e.clipboardData?.getData("text/plain") ?? "").length > 0) {
          setWarn(true);
        }
        // a paste counts as typing, a pasted file too (it changes no text)
        suggested?.onDismiss();
        onPaste?.(e);
      }}
    />
  );
  const refocusText = () => {
    // a tap on a touch device never pops the keyboard
    if (!isTouchPointer()) inner.current?.focus();
  };
  const sendAnyway = onSend ?? (send.mode === "send" ? send.onClick : undefined);
  const kinds = TOKEN_KINDS.filter((k) => spans.some((s) => s.kind === k));
  const tokenWarning = warning ? (
    <BoxScope kind="composer">
      <Callout
        tone="warn"
        actions={[
          {
            label: t("composer.tokenWarning.remove"),
            onSelect: () => {
              setWarn(false);
              onChange(removeSpans(value, spans));
              refocusText();
            },
          },
          {
            label: t("composer.tokenWarning.sendAnyway"),
            onSelect: () => {
              setWarn(false);
              if (sendAnyway) sendAnyway();
              else refocusText();
            },
          },
        ]}
      >
        {t("composer.tokenWarning").replace(
          "{kinds}",
          kinds
            .map((k) => t(`composer.tokenWarning.kind.${k}`))
            .join(t("composer.tokenWarning.join")),
        )}
        {t("composer.tokenHint")}
      </Callout>
    </BoxScope>
  ) : null;
  return (
    <ComposerFrame busy={send.busy === true} bare={!frame}>
      {tokenWarning}
      {attachments}
      <label className="cb-sr-only" htmlFor={id}>
        {t("composer.message")}
      </label>
      {token ? (
        <div className="cb-composer-line" data-part="composer-line">
          <ComposerTokenChip
            token={token}
            labelId={tokenLabelId}
            onRemove={() => {
              refocus.current = true;
              token.onRemove();
            }}
          />
          {input}
        </div>
      ) : (
        input
      )}
      {suggested ? (
        <span id={suggestionHintId} className="cb-sr-only" data-part="composer-suggestion-hint">
          {t("composer.suggestion.hint")}
        </span>
      ) : null}
      <div className="cb-composer-bar" data-part="composer-bar">
        <IconButton
          label={t("composer.attach")}
          icon={<Icon name="plus" size={16} />}
          disabled={attachDisabled}
          onClick={() => {
            // attaching a file counts as typing
            suggested?.onDismiss();
            onAttach();
          }}
        />
        {pickers.agent ? <Picker {...pickers.agent} /> : null}
        {/* 640 and up: individual pickers; phones: one options button and its bottom sheet (CSS). */}
        <span className="cb-composer-pickers" data-part="composer-pickers">
          {pickers.device ? <Picker {...pickers.device} /> : null}
          {pickers.permission ? <Picker {...pickers.permission} /> : null}
          <Picker {...pickers.model} />
          {pickers.effort ? <Picker {...pickers.effort} /> : null}
        </span>
        <ComposerOptions
          {...(pickers.device ? { device: pickers.device } : {})}
          {...(pickers.permission ? { permission: pickers.permission } : {})}
          model={pickers.model}
          {...(pickers.effort ? { effort: pickers.effort } : {})}
        />
        {quickActions ?? null}
        {agents ?? null}
        <span className="cb-grow" />
        {suggested && (touch || referenceTouch) ? (
          <Button
            variant="ghost"
            density="dense"
            part="composer-suggestion-use"
            className="cb-composer-suggestion-use"
            aria-label={t("composer.suggestion.useNamed").replace("{text}", () => suggested.text)}
            // fills the draft without focusing it: a tap never pops the keyboard
            onClick={() => takeSuggestion(suggested.text, false)}
          >
            <Icon name="corner-down-left" size={14} />
            {t("composer.suggestion.use")}
          </Button>
        ) : null}
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
            onClick={() => {
              if (gate()) send.onClick();
            }}
          />
        )}
      </div>
    </ComposerFrame>
  );
}
