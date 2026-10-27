import { type JSX, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../controls/button";
import { Input } from "../controls/inputs";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Dialog } from "../overlays/dialog";
import { useDesignT } from "../provider";
import { ConvMenu, type ConvMenuEntry } from "./menu";

// The conversation title bar (spec §6.16.1): the middle column's own 48-high bar with the title
// (rename / copy link / delete), the properties toggle, a separator, Files and the extensions'
// panel icons, and More for the icons that don't fit.

export type TitleBarMenuItem = {
  id: string;
  label: string;
  icon: IconName;
  tone?: "fail";
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
  /** The title; null until one is generated or given. */
  title: string | null;
  /** Shown while `title` is null: "未命名会话 · 10-26 14:02" (`untitledLabel`). */
  untitled: string;
  /** The title menu; a `separator` id draws a line (rename, copy link, separator, delete). */
  menu: (TitleBarMenuItem | "separator")[];
  properties: { pressed: boolean; onToggle(): void };
  /** Files, then the extensions' panels in contribution order. */
  panels: TitleBarPanel[];
  /** The reference set only: menus drawn open and a fixed number of visible panel icons. */
  reference?: { titleMenu?: boolean; moreMenu?: boolean; visiblePanels?: number };
};

/** Width of one title-bar icon button plus the bar's gap. */
const SLOT = 28 + 4;
/** What the bar keeps besides group 2: paddings, a readable title, the toggle, separator, More. */
const RESERVED = 20 + 12 + 200 + SLOT + 9 + 4 + SLOT;

/** How many of `count` panel icons fit in a title bar `width` wide (the rest go into More). */
export function titleBarFit(width: number, count: number): number {
  if (width <= 0) return count;
  const room = Math.floor((width - RESERVED) / SLOT);
  return Math.max(0, Math.min(count, room));
}

export function TitleBar({
  title,
  untitled,
  menu,
  properties,
  panels,
  reference,
}: TitleBarProps): JSX.Element {
  const t = useDesignT();
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
  const fit = reference?.visiblePanels ?? titleBarFit(width, panels.length);
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
          onSelect: m.onSelect,
        },
  );
  return (
    <header ref={ref} className="cb-title-bar" data-part="title-bar">
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
      <IconButton
        part="title-bar-button"
        label={t("titlebar.properties")}
        icon={<Icon name="panel-right" size={16} />}
        aria-pressed={properties.pressed}
        onClick={properties.onToggle}
      />
      <span className="cb-title-sep" data-part="title-bar-separator" aria-hidden="true" />
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
        // Icons that don't fit; with nothing hidden, every panel (a keyboard route to them).
        entries={(hidden.length > 0 ? hidden : panels).map((p) => ({
          kind: "item" as const,
          id: p.id,
          label: p.label,
          icon: p.icon,
          onSelect: p.onOpen,
        }))}
      />
    </header>
  );
}

/** The title bar of a new conversation: only the muted "新会话" label. */
export function NewTitleBar(): JSX.Element {
  const t = useDesignT();
  return (
    <header className="cb-title-bar" data-part="title-bar">
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
