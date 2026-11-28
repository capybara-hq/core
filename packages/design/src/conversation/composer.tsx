import {
  type JSX,
  type ReactNode,
  type Ref,
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
import { useHaptics } from "../native";
import { useDesignT } from "../provider";
import { isTouchPointer } from "../shell/pointer";
import { useMobileSizes } from "../shell/touch";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerSegment,
  type ComposerTrigger,
} from "./composer-editor/index";
import type { ComposerMenuCaret, ComposerMenuCombobox } from "./composer-menu";
import { ComposerOptions } from "./composer-options";
import { type ComposerPlace, ComposerPlaceStrip } from "./composer-place";
import { ContextMeter } from "./context-meter";
import { ConvMenu, type ConvMenuEntry } from "./menu";
import { ModeMenu, type ModeMenuProps, nextMode } from "./mode-menu";
import { arrangePickerGroups, LONG_PICKER_THRESHOLD } from "./picker-groups";
import {
  findTokenLikeSpans,
  removeSpans,
  type TokenLikeKind,
  type TokenLikeSpan,
} from "./token-like";

// The composer (spec §6.16.2): the place tray above the field, the floating box that holds the token
// warning, the attachment strip, the editor (text with inline tokens, composer inline tokens spec §2)
// and the control row with the pickers and send / stop.

/**
 * The composer (§6.16.2): what stands above the box (`top`: the open composer menu and the place
 * tray), then the box itself, the field (`raised`, 1px `line`, radius `md`, `shadow-float`, padding
 * `space.2`; accent + halo on focus). In the touch form the field draws nothing and its parts join
 * the frame's grid. `bare`: the same elements and parts without the box (no padding, border, ground
 * or shadow), for a plugin's frame drawn around the composer (client extensions spec §5.3).
 */
export function ComposerFrame({
  busy,
  bare,
  place,
  form,
  top,
  children,
}: {
  /** A send or stop is in flight: `aria-busy` on the field (UI part `composer`) for plugin CSS. */
  busy?: boolean;
  bare?: boolean;
  /** The frame holds the top strip (§6.16.2): the control row takes its `place` layout. */
  place?: boolean;
  /** The reference set and catalog only: draw the medium form in a wide window. */
  form?: "medium";
  /**
   * Drawn before the field, outside its box: the open composer menu and the place strip, which
   * from 600 up with a fine pointer is the tray the field overlaps.
   */
  top?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="cb-composer"
      data-part="composer"
      data-frame={bare ? "bare" : undefined}
      data-place={place ? "true" : undefined}
      data-form={form}
    >
      {top}
      {/* the UI part `composer` is the box a theme styles: the field, never the tray above it */}
      <div
        className="cb-composer-field"
        data-part="composer-field"
        data-cap-part="composer"
        aria-busy={busy ? true : undefined}
      >
        {children}
      </div>
    </div>
  );
}

// ── Pickers and the control row (§6.16.2, §6.16.3) ──────────────────────────

export type PickerItem = {
  id: string;
  label: string;
  /** A tag after the label ("agent 默认"). */
  tag?: string;
  checked?: boolean;
  /**
   * Kept at the top of a long list, after the checked item, in a group of its own (the agent's
   * default model; §6.16.2, §6.16.3).
   */
  pinned?: boolean;
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
   * An icon before the value on the button, in the chip's own muted ink (the device chip's
   * `cpu` while the conversation will run without a device: "No device").
   */
  icon?: IconName;
  /**
   * Locked (the agent after the first message): plain `muted` text with no chevron and this hint
   * as its tooltip.
   */
  locked?: { hint: string; warning?: { label: string; onInspect(): void } };
  disabled?: boolean;
  groups: { label?: string; items: PickerItem[] }[];
  /** The note that closes the menu ("从下一条消息起生效"). */
  note?: string;
  /** One muted line at the top of the mode menu (why something does not work now), not a choice. */
  notice?: string;
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

/**
 * A composer picker (§6.16.3): a ghost button opening a grouped menu above it. `searchable` (the
 * model picker): a long list (more than {@link LONG_PICKER_THRESHOLD} items) gets a search field
 * matching the item and group labels, and the checked and pinned items lead in a group of their
 * own.
 */
export function Picker({
  label,
  value,
  icon,
  locked,
  disabled,
  groups,
  note,
  action,
  onPick,
  referenceOpen,
  searchable,
  titled,
}: PickerProps & {
  searchable?: boolean;
  /**
   * The top strip's pickers (§6.16.2): a locked one's tooltip leads with its whole value, which a
   * long project name cuts with an ellipsis.
   */
  titled?: boolean;
}): JSX.Element {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  if (locked?.warning) {
    return (
      <Button
        variant="ghost"
        density="dense"
        className="cb-picker"
        // a locked value with a warning: plain muted text like any locked one (no hover pill)
        data-warning="true"
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
      <span
        className="cb-picker"
        data-part="picker"
        data-locked="true"
        title={titled ? `${value}: ${locked.hint}` : locked.hint}
      >
        <span className="cb-picker-value">{value}</span>
      </span>
    );
  }
  const entries: ConvMenuEntry[] = [];
  const shown = searchable ? arrangePickerGroups(groups, t("composer.models.pinned")) : groups;
  for (const g of shown) {
    if (g.label) entries.push({ kind: "label", label: g.label });
    for (const it of g.items) {
      const keywords = "keywords" in it && typeof it.keywords === "string" ? it.keywords : "";
      entries.push({
        kind: "item",
        id: it.id,
        label: it.label,
        ...(keywords ? { keywords } : {}),
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
      // the line parts the action from the items; with no items the action stands alone
      ...(entries.length > 0 ? [{ kind: "separator" as const }] : []),
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
      {...(searchable
        ? {
            filter: {
              // the action is an item too, but no model
              threshold: LONG_PICKER_THRESHOLD + (action ? 1 : 0),
              label: t("composer.models.search"),
              empty: t("composer.models.noMatch"),
            },
          }
        : {})}
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
          {icon ? <Icon name={icon} size={12} /> : null}
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
  /**
   * The draft (composer inline tokens spec §1): text and inline tokens in order; an invoked skill
   * is a `skill` token leading it. A draft the page sets (a restore, a quick action) replaces the
   * editor's content; echoing what `onChange` reported changes nothing.
   */
  segments: ComposerSegment[];
  onChange(segments: ComposerSegment[]): void;
  /**
   * The editor's handle: `value`, `focus`, `insertToken` (a menu pick), `replace` (one undo
   * step), `clear` (after a send) and `dismissTrigger` (the page closed its menu with Esc).
   */
  editorRef?: Ref<ComposerEditorHandle>;
  /** The open `@` / `/` trigger at the caret and its query; null when there is none. */
  onTrigger?(t: ComposerTrigger | null): void;
  /**
   * Files pasted into the text: the one route for pasted files (the page adds them to the
   * attachment strip). A drop goes to the page's `FileDrop` around the composer, never here.
   */
  onPasteFiles?(files: File[]): void;
  /**
   * Sends the draft: ↵ (no Shift, not composing, a fine pointer) and the token warning's "Send
   * anyway" (setup guides v2 spec §12.1), also while a run is going and the button is Stop.
   * A draft holding token-like text raises the warning first; the next ↵ sends.
   */
  onSubmit(): void;
  placeholder: string;
  /** Replaces the placeholder while a run is going (messages sent then reach the agent later). */
  hint?: string;
  /** The skill's argument hint: faint ghost text after a lone skill token (state `skill`). */
  skillHint?: string;
  /**
   * A send refused tokens of the draft (spec §3.4): one fail line at the top of the field, where
   * the token warning stands, "<label> can't be used: <reason>" with "Remove" (`onRemove` takes
   * the refused tokens out of the draft). The token warning, while it shows, stands in its place.
   */
  refused?: { label: string; reason: string; onRemove(): void };
  /** The attachment strip (uploads), above the text. */
  attachments?: ReactNode;
  /** The + button: the file picker, or (with `attachOpen`) the + menu (§6.16.30). */
  onAttach(): void;
  attachDisabled?: boolean;
  /**
   * The + menu is open: the + button then carries `aria-haspopup="menu"` and this as
   * `aria-expanded`. Absent: + is a plain button (the file picker).
   */
  attachOpen?: boolean;
  /**
   * The composer's menu host (§6.16.30): `node` is the open `ComposerMenu` (drawn above the frame;
   * absent while none is open), `combobox` the attributes the editor takes as its combobox, and
   * `onKeyDown` the menu's keys with where the caret stands, offered before the composer's own (a
   * `true` return stops them). Both from `useComposerMenu`.
   */
  menu?: {
    node?: ReactNode;
    combobox: ComposerMenuCombobox;
    onKeyDown(e: KeyboardEvent, caret: ComposerMenuCaret): boolean;
  };
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
   * The top strip (§6.16.2 "Top strip"): where the conversation runs, the device then its project
   * (absent when the device offers none): from 600 up with a fine pointer a tray above the field,
   * outside its box, which the field overlaps by `radius.md`; a `locked` picker is static text (a
   * conversation's). With it the control row draws no device picker
   * (`pickers.device` is ignored), the mode button follows + and the model picker stands at the
   * end before the context meter and send; below 600 the strip is one chip opening a sheet, the
   * mode an icon button and the settings chip the model's name (model and effort only).
   */
  place?: ComposerPlace;
  /** The reference set and catalog only: draw the medium form (600 to 840) in a wide window. */
  referenceForm?: "medium";
  /**
   * The mode menu (§6.16.3a): from 640 up one button at the end of the row (before send) holds the
   * permission profiles and the effort, so the row draws neither `pickers.permission` nor
   * `pickers.effort` and the model picker reads "<model> · <effort>". Shift+Tab in the text
   * moves to the next choosable mode. Phones keep both pickers in the options sheet.
   */
  mode?: ModeMenuProps;
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
  /**
   * The context meter: a ring right before send / stop, `pct` of the context window used (0-100),
   * `over` once past the compaction threshold. Absent: no ring.
   */
  context?: { pct: number; over: boolean };
  send: { mode: "send" | "stop"; disabled?: boolean; busy?: boolean; onClick(): void };
  /** The reference set only: draw the focused frame (`:focus-within` is forced there). */
  autoFocus?: boolean;
  /**
   * `false`: the composer's inputs without the frame's box (`ComposerFrame bare`): what a plugin's
   * `conversation.composer.frame` replacement wraps in its own frame. Default `true`.
   */
  frame?: boolean;
  /**
   * A prompt suggestion (state `suggestion`): the person's likely next message after a completed
   * run. It is the placeholder while the draft is empty (no skill token either) and no `hint`
   * shows;
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

/** The mode menu without its effort segments (the effort is chosen elsewhere). */
function withoutEffort({ effort: _effort, ...rest }: ModeMenuProps): ModeMenuProps {
  return rest;
}

/** The token-like spans in the draft's text (a token holds none). */
function tokenLikeSpans(segments: readonly ComposerSegment[]): TokenLikeSpan[] {
  return segments.flatMap((s) => (typeof s === "string" ? findTokenLikeSpans(s) : []));
}

/** The draft without its token-like text; the tokens stay. */
function withoutTokenLike(segments: readonly ComposerSegment[]): ComposerSegment[] {
  return segments.map((s) => (typeof s === "string" ? removeSpans(s, findTokenLikeSpans(s)) : s));
}

const plainTab = (e: KeyboardEvent) =>
  e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

/**
 * The composer (§6.16.2): the frame, the attachment strip, the editor (text with inline tokens,
 * grows to 8 lines then scrolls) and the control row: + · agent · device · model · effort (hidden
 * without efforts) · quick actions (only when the agent has some) · the agents chip (once the
 * conversation has a sub-agent) · send / stop. Below 600 the device, model and effort pickers are
 * one options button (`ComposerOptions`) opening a bottom sheet with the three groups.
 */
export function ComposerBox({
  segments,
  onChange,
  editorRef,
  onTrigger,
  onPasteFiles,
  onSubmit,
  placeholder,
  hint,
  skillHint,
  refused,
  attachments,
  onAttach,
  attachDisabled,
  attachOpen,
  menu,
  pickers,
  mode,
  quickActions,
  agents,
  context,
  send,
  autoFocus,
  suggestion,
  referenceTouch,
  place,
  referenceForm,
  frame = true,
}: ComposerBoxProps): JSX.Element {
  const t = useDesignT();
  // The prompt suggestion shows only over an empty, idle draft (a skill token is not empty).
  const suggested = suggestion && segments.length === 0 && !hint ? suggestion : undefined;
  // A touch device has no Tab key: the suggestion gets a button. Read after mounting, never in
  // render, so the server render and hydration agree.
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchPointer()), []);
  // the touch form's condition (MOBILE_SIZE_QUERY: compact, or a touch device at any width), as
  // the CSS draws it; null on the server and before hydration
  const mobile = useMobileSizes() === true;
  // The token paste warning (setup guides v2 spec §12.1): raised by a paste holding token-like
  // text or by a send whose draft holds some; a guard against a slip, never a block. The draft is
  // scanned here in the browser only: nothing is logged or sent anywhere.
  const [warn, setWarn] = useState(false);
  const spans = useMemo(() => (warn ? tokenLikeSpans(segments) : []), [warn, segments]);
  const warning = warn && spans.length > 0;
  // An edit that leaves no token-like text clears it (a paste raises it before its text arrives,
  // so only a change of the draft can clear it).
  const warnNow = useRef(warn);
  warnNow.current = warn;
  useEffect(() => {
    if (warnNow.current && tokenLikeSpans(segments).length === 0) setWarn(false);
  }, [segments]);
  /** A send: the first one with token-like text shows the warning instead; one while it shows sends. */
  const gate = (): boolean => {
    if (warning) {
      setWarn(false);
      return true;
    }
    if (tokenLikeSpans(segments).length > 0) {
      setWarn(true);
      return false;
    }
    return true;
  };
  const id = useId();
  const suggestionHintId = `${id}-suggestion`;
  const inner = useRef<ComposerEditorHandle | null>(null);
  // the caller's ref and ours on the same editor
  const setRef = useCallback(
    (handle: ComposerEditorHandle | null) => {
      inner.current = handle;
      if (typeof editorRef === "function") editorRef(handle);
      else if (editorRef) (editorRef as { current: ComposerEditorHandle | null }).current = handle;
    },
    [editorRef],
  );
  // The suggestion ends once per offer: a fill, an edit and a paste may all report it (an edit
  // made inside a key's handling reaches onChange after the key).
  const dismissed = useRef<string | null>(null);
  useEffect(() => {
    if (!suggestion) dismissed.current = null;
  }, [suggestion]);
  const dismissSuggestion = () => {
    if (!suggestion || dismissed.current === suggestion.text) return;
    dismissed.current = suggestion.text;
    suggestion.onDismiss();
  };
  /**
   * Fills the draft with the suggestion (one undo step) and ends it for this run. The caret goes
   * to the end only while the editor has the focus (Tab); the touch button never focuses it.
   */
  const takeSuggestion = (text: string) => {
    inner.current?.replace([text]);
    dismissSuggestion();
  };
  const keyDown = (e: KeyboardEvent, caret: ComposerMenuCaret): boolean => {
    // an open menu takes its keys first (↑↓ ↵ Esc ← →): its ↵ picks, it never sends
    if (menu?.onKeyDown(e, caret)) return true;
    if (suggested) {
      // Tab is taken only here (an empty draft showing a suggestion), so focus navigation is
      // unchanged everywhere else; Shift+Tab and Tab with a modifier never are.
      if (plainTab(e)) {
        takeSuggestion(suggested.text);
        return true;
      }
      if (e.key === "Escape") dismissSuggestion();
    }
    // Shift+Tab moves to the next mode (§6.16.3a); with no other mode to choose it stays focus
    // navigation
    if (mode && e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const next = nextMode(mode);
      if (next !== undefined) {
        mode.onPickMode(next);
        return true;
      }
    }
    return false;
  };
  const input = (
    <ComposerEditor
      ref={setRef}
      segments={segments}
      onChange={(next) => {
        onChange(next);
        // any edit that leaves text ends the suggestion for this run
        if (next.length > 0) dismissSuggestion();
      }}
      placeholder={suggested ? suggested.text : (hint ?? placeholder)}
      {...(skillHint ? { hint: skillHint } : {})}
      {...(onTrigger ? { onTrigger } : {})}
      onKeyDown={keyDown}
      onPasteFiles={(files) => {
        // a pasted file counts as typing (it changes no text)
        if (suggested) dismissSuggestion();
        onPasteFiles?.(files);
      }}
      onPasteText={(text) => {
        if (findTokenLikeSpans(text).length > 0) setWarn(true);
        if (suggested) dismissSuggestion();
      }}
      onSubmit={() => {
        if (gate()) onSubmit();
      }}
      {...(menu ? { combobox: menu.combobox } : {})}
      {...(suggested ? { describedBy: suggestionHintId, suggestion: true } : {})}
      {...(autoFocus ? { autoFocus } : {})}
      {...(referenceForm ? { referenceForm } : {})}
    />
  );
  const refocusText = () => {
    // a tap on a touch device never pops the keyboard
    if (!isTouchPointer()) inner.current?.focus();
  };
  // a send plays the `light` haptic (a native shell's)
  const haptics = useHaptics();
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
              inner.current?.replace(withoutTokenLike(segments));
              refocusText();
            },
          },
          {
            label: t("composer.tokenWarning.sendAnyway"),
            onSelect: () => {
              setWarn(false);
              haptics("light");
              onSubmit();
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
  // The refusal line (inline tokens spec §1, §3.4): the fail Callout where the token warning
  // stands; the warning, a moment's question before a send, takes the line while it shows.
  const refusal =
    refused && !warning ? (
      <BoxScope kind="composer">
        <Callout
          tone="fail"
          actions={[
            {
              label: t("composer.refusedRemove"),
              onSelect: () => {
                refused.onRemove();
                refocusText();
              },
            },
          ]}
        >
          {t("composer.refused")
            .replace("{name}", () => refused.label)
            .replace("{reason}", () => refused.reason)}
        </Callout>
      </BoxScope>
    ) : null;
  // The settings chip (below 600, and on touch): with the top strip it holds no device, and no
  // permission while the mode button shows; it then reads the model's name alone.
  const options = (
    <ComposerOptions
      {...(pickers.device && !place ? { device: pickers.device } : {})}
      {...(pickers.permission && !(place && mode) ? { permission: pickers.permission } : {})}
      model={pickers.model}
      {...(pickers.effort ? { effort: pickers.effort } : {})}
      {...(place ? { nameOnly: true } : {})}
    />
  );
  // The touch form with the top strip: the effort moves into the model's sheet (the settings
  // chip), so the mode menu holds the profiles alone (§6.16.2 compact).
  const effortInSheet = place !== undefined && mobile && pickers.effort !== undefined;
  const shownMode = mode && effortInSheet ? withoutEffort(mode) : mode;
  const modeButton = shownMode ? (
    <span className="cb-composer-mode" data-part="composer-mode">
      <ModeMenu {...shownMode} {...(place ? { named: true } : {})} />
    </span>
  ) : null;
  return (
    <ComposerFrame
      busy={send.busy === true}
      bare={!frame}
      place={place !== undefined}
      {...(referenceForm ? { form: referenceForm } : {})}
      top={
        // the open menu, then the place strip (the tray above the field from 600 up with a fine
        // pointer; the chip row above the pill in the touch form)
        <>
          {menu?.node ?? null}
          {place ? <ComposerPlaceStrip {...place} /> : null}
        </>
      }
    >
      {tokenWarning ?? refusal}
      {attachments}
      {/* The text box (part composer.box): the text with + and send. In the mobile form it is the
          floating pill, the control row above and below it; 600 and up it draws no box of its own
          (the frame is the box) and the three join the control row's line. */}
      <div className="cb-composer-box" data-part="composer-box" data-cap-part="composer.box">
        {input}
        {suggested ? (
          <span id={suggestionHintId} className="cb-sr-only" data-part="composer-suggestion-hint">
            {t("composer.suggestion.hint")}
          </span>
        ) : null}
        <IconButton
          label={t("composer.attach")}
          className="cb-composer-attach"
          icon={<Icon name="plus" size={16} />}
          disabled={attachDisabled}
          {...(attachOpen === undefined
            ? {}
            : {
                "aria-haspopup": "menu" as const,
                "aria-expanded": attachOpen,
                // the open + menu's list (the editor's combobox controls the same one)
                ...(attachOpen && menu?.combobox["aria-controls"]
                  ? { "aria-controls": menu.combobox["aria-controls"] }
                  : {}),
              })}
          onClick={() => {
            // attaching a file counts as typing
            if (suggested) dismissSuggestion();
            onAttach();
          }}
        />
        {context ? <ContextMeter pct={context.pct} over={context.over} /> : null}
        {send.mode === "stop" ? (
          <IconButton
            className="cb-stop"
            part="stop"
            data-cap-part="button composer.send"
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
            data-cap-part="button composer.send"
            variant="ghost"
            label={t("composer.send")}
            icon={<Icon name="arrow-up" size={16} />}
            disabled={send.disabled || send.busy}
            aria-busy={send.busy ? true : undefined}
            onClick={() => {
              if (!gate()) return;
              haptics("light");
              send.onClick();
            }}
          />
        )}
      </div>
      <div className="cb-composer-bar" data-part="composer-bar">
        {pickers.agent ? <Picker {...pickers.agent} /> : null}
        {place ? (
          // The top strip's layout: the mode follows +; below 600 the mode (an icon button) and
          // the settings chip (the model and the effort) share the row above the pill (CSS).
          <span className="cb-composer-settings" data-part="composer-settings">
            {modeButton}
            {options}
          </span>
        ) : null}
        {place ? (
          <>
            {quickActions ?? null}
            {agents ?? null}
            <span className="cb-grow" />
          </>
        ) : null}
        {/* 600 and up: individual pickers; phones: one options button and its bottom sheet (CSS). */}
        <span className="cb-composer-pickers" data-part="composer-pickers">
          {pickers.device && !place ? <Picker {...pickers.device} /> : null}
          {mode ? (
            // the effort lives in the mode menu: the model picker names it ("<model> · <effort>")
            <Picker
              {...pickers.model}
              searchable
              {...(pickers.effort
                ? { value: `${pickers.model.value} · ${pickers.effort.value}` }
                : {})}
            />
          ) : (
            <>
              {pickers.permission ? <Picker {...pickers.permission} /> : null}
              <Picker {...pickers.model} searchable />
              {pickers.effort ? <Picker {...pickers.effort} /> : null}
            </>
          )}
        </span>
        {place ? null : (
          <>
            {options}
            {quickActions ?? null}
            {agents ?? null}
            <span className="cb-grow" />
            {modeButton}
          </>
        )}
        {suggested && (touch || referenceTouch) ? (
          <Button
            variant="ghost"
            density="dense"
            part="composer-suggestion-use"
            className="cb-composer-suggestion-use"
            aria-label={t("composer.suggestion.useNamed").replace("{text}", () => suggested.text)}
            // fills the draft without focusing it: a tap never pops the keyboard
            onClick={() => takeSuggestion(suggested.text)}
          >
            <Icon name="corner-down-left" size={14} />
            {t("composer.suggestion.use")}
          </Button>
        ) : null}
      </div>
    </ComposerFrame>
  );
}
