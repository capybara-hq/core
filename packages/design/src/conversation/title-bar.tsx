import { type JSX, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../controls/button";
import { Input } from "../controls/inputs";
import { Avatar, type AvatarValue } from "../display/avatar";
import { SkeletonText } from "../display/skeleton";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Dialog } from "../overlays/dialog";
import { useDesignLink, useDesignT } from "../provider";
import { useMediaQuery } from "../shell/use-media-query";
import { ConvMenu, type ConvMenuEntry } from "./menu";

// The conversation title bar (spec §6.16.1): the middle column's own 48-high bar with the title
// (rename / copy link / delete), the properties toggle, a separator, Files and the extensions'
// panel icons, and More for the icons that don't fit (only when two or more don't).

export type TitleBarMenuItem = {
  id: string;
  label: string;
  icon: IconName;
  tone?: "fail";
  /** Drawn dimmed and not activatable (e.g. an action a running conversation refuses). */
  disabled?: boolean;
  onSelect(): void;
};

export type TitleBarPanel = {
  id: string;
  label: string;
  icon: IconName;
  pressed: boolean;
  onOpen(): void;
};

export type TitleBarProps = {
  /**
   * The path before the title, `<org> / <agent> /` (mono, faint); a segment with `href` links. A
   * segment with `avatar` (the agent's) leads with its `Avatar` at 16 (§6.30; `null`: the initial).
   */
  path?: { label: string; href?: string; avatar?: AvatarValue }[];
  /** The title; null until one is generated or given. */
  title: string | null;
  /** Shown while `title` is null: "未命名会话 · 10-26 14:02" (`untitledLabel`). */
  untitled: string;
  /** The title menu; a `separator` id draws a line (rename, copy link, separator, delete). */
  menu: (TitleBarMenuItem | "separator")[];
  properties: { pressed: boolean; onToggle(): void };
  /** Files, then the extensions' panels in contribution order. */
  panels: TitleBarPanel[];
  /**
   * The title is not known yet (the conversation is loading): a bar 30% of the bar's width in the
   * title's box in place of the title menu; the path and every icon stay real.
   */
  loading?: boolean;
  /** The reference set only: menus drawn open and a fixed number of visible panel icons. */
  reference?: { titleMenu?: boolean; moreMenu?: boolean; visiblePanels?: number };
};

/** A path segment's content: the label, led by the avatar when it has one. */
function pathSegment(c: { label: string; avatar?: AvatarValue }) {
  if (c.avatar === undefined) return c.label;
  return (
    <>
      <Avatar value={c.avatar} name={c.label} size={16} />
      <span className="cb-title-path-label">{c.label}</span>
    </>
  );
}

/** Width of one title-bar icon button plus the bar's gap. */
const SLOT = 28 + 4;
/** What the bar keeps besides group 2: paddings, a readable title, the toggle, separator, More. */
const RESERVED = 20 + 12 + 200 + SLOT + 9 + 4 + SLOT;
/** Below 640 (spec §6.16.1): 40 px tap targets, 16 + 4 paddings and a shorter readable title. */
const TOUCH_SLOT = 40 + 4;
const TOUCH_RESERVED = 16 + 4 + 160 + TOUCH_SLOT + 9 + 4 + TOUCH_SLOT;

/**
 * How many of `count` panel icons fit in a title bar `width` wide (the rest go into More);
 * `touch` is the phone form (below 640), whose buttons are 40 px tap targets.
 */
export function titleBarFit(width: number, count: number, touch = false): number {
  if (width <= 0) return count;
  const slot = touch ? TOUCH_SLOT : SLOT;
  const room = Math.floor((width - (touch ? TOUCH_RESERVED : RESERVED)) / slot);
  return Math.max(0, Math.min(count, room));
}

export function TitleBar({
  path,
  title,
  untitled,
  menu,
  properties,
  panels,
  loading,
  reference,
}: TitleBarProps): JSX.Element {
  const t = useDesignT();
  const Link = useDesignLink();
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const touch = useMediaQuery("(max-width: 639px)");
  const measured = reference?.visiblePanels ?? titleBarFit(width, panels.length, touch);
  // No menu of one (spec §6.7): a single icon that doesn't fit takes More's slot instead.
  const fit = panels.length - measured === 1 ? panels.length : measured;
  // The open panel stays visible: it takes the last visible slot when it would overflow.
  let shown = panels.slice(0, fit);
  const pressedIdx = panels.findIndex((p) => p.pressed);
  if (fit > 0 && pressedIdx >= fit) {
    const pressed = panels[pressedIdx];
    if (pressed) shown = [...panels.slice(0, fit - 1), pressed];
  }
  const hidden = panels.filter((p) => !shown.includes(p));
  const text = title ?? untitled;
  const entries: ConvMenuEntry[] = menu.map((m) =>
    m === "separator"
      ? { kind: "separator" }
      : {
          kind: "item",
          id: m.id,
          label: m.label,
          icon: m.icon,
          ...(m.tone ? { tone: m.tone } : {}),
          ...(m.disabled === true ? { disabled: true } : {}),
          onSelect: m.onSelect,
        },
  );
  return (
    <header ref={ref} className="cb-title-bar" data-part="title-bar" data-cap-part="title-bar">
      {path !== undefined && path.length > 0 ? (
        <nav className="cb-title-path" data-part="title-path" aria-label={t("shell.path")}>
          {path.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional (labels may repeat)
            <span key={`${i}-${c.label}`} className="cb-title-path-item">
              {c.href !== undefined ? (
                <Link
                  href={c.href}
                  className="cb-title-path-seg"
                  data-avatar={c.avatar !== undefined ? "true" : undefined}
                >
                  {pathSegment(c)}
                </Link>
              ) : (
                <span
                  className="cb-title-path-seg"
                  data-avatar={c.avatar !== undefined ? "true" : undefined}
                >
                  {pathSegment(c)}
                </span>
              )}
              <span className="cb-title-path-sep" aria-hidden="true">
                /
              </span>
            </span>
          ))}
        </nav>
      ) : null}
      {loading ? (
        <span className="cb-title-btn" data-part="title" data-loading="true">
          <span className="cb-title-text">
            <SkeletonText width="100%" />
          </span>
        </span>
      ) : (
        <ConvMenu
          inline={reference?.titleMenu === true}
          label={t("titlebar.menu")}
          // The reference hangs both menus `space.2` above the bar's bottom edge: 2 below the button.
          sideOffset={2}
          trigger={
            <button
              type="button"
              className="cb-title-btn"
              data-part="title"
              data-untitled={title === null ? "true" : undefined}
              title={text}
            >
              <span className="cb-title-text">{text}</span>
              <Icon name="chevron-down" size={14} />
            </button>
          }
          entries={entries}
        />
      )}
      <IconButton
        part="title-bar-button"
        label={t("titlebar.properties")}
        icon={<Icon name="panel-right" size={16} />}
        aria-pressed={properties.pressed}
        onClick={properties.onToggle}
      />
      {panels.length > 0 ? (
        <span className="cb-title-sep" data-part="title-bar-separator" aria-hidden="true" />
      ) : null}
      {shown.map((p) => (
        <IconButton
          key={p.id}
          part="title-bar-button"
          label={p.label}
          icon={<Icon name={p.icon} size={16} />}
          aria-pressed={p.pressed}
          onClick={p.onOpen}
        />
      ))}
      {hidden.length > 0 ? (
        <ConvMenu
          inline={reference?.moreMenu === true}
          label={t("titlebar.more")}
          align="end"
          size="narrow"
          sideOffset={2}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          trigger={
            <IconButton
              part="title-bar-button"
              label={t("titlebar.more")}
              icon={<Icon name="more-vertical" size={16} />}
              // More is pressed while its menu is open (§6.16.1).
              aria-pressed={reference?.moreMenu === true || moreOpen}
            />
          }
          // Only the icons that don't fit (two or more): the shown ones are buttons already.
          entries={hidden.map((p) => ({
            kind: "item" as const,
            id: p.id,
            label: p.label,
            icon: p.icon,
            onSelect: p.onOpen,
          }))}
        />
      ) : null}
    </header>
  );
}

/** The title bar of a new conversation: only the muted "新会话" label. */
export function NewTitleBar(): JSX.Element {
  const t = useDesignT();
  return (
    <header className="cb-title-bar" data-part="title-bar" data-cap-part="title-bar">
      <span className="cb-title-btn" data-part="title" data-untitled="true">
        <span className="cb-title-text">{t("titlebar.new")}</span>
      </span>
    </header>
  );
}

/** Rename (§6.16.1): a dialog with the title field; a manual rename stops title generation. */
export function RenameDialog({
  value,
  onSave,
  onCancel,
  busy,
}: {
  value: string;
  onSave(v: string): void;
  onCancel(): void;
  busy?: boolean;
}): JSX.Element {
  const t = useDesignT();
  const [draft, setDraft] = useState(value);
  const trimmed = draft.trim();
  const save = () => {
    if (trimmed !== "") onSave(trimmed);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title={t("rename.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("overlay.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={trimmed === ""}
            loading={busy === true}
            onClick={save}
          >
            {t("rename.save")}
          </Button>
        </>
      }
    >
      <Input
        aria-label={t("rename.label")}
        value={draft}
        maxLength={200}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
    </Dialog>
  );
}
