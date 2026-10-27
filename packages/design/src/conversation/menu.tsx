import * as RM from "@radix-ui/react-dropdown-menu";
import { type JSX, type ReactElement, type ReactNode, useId } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";

// The menus of the conversation page (spec §6.7, §6.16.1, §6.16.3, §6.16.18): the title menu,
// More, the composer pickers and the right panel's switcher. Unlike the generic Menu they carry
// icons, group labels, tags and a closing note, and can be drawn open in place (the reference set).

export type ConvMenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      /** An icon before the label, or a node (a type badge). */
      icon?: IconName | ReactNode;
      /** A tag after the label ("agent 默认"). */
      tag?: string;
      /** A choice of a set: a `menuitemradio` with `aria-checked` and a `check` at its end. */
      checked?: boolean;
      /** Draw the `check` at the end of the checked item (default true; the panel switcher omits it). */
      checkMark?: boolean;
      tone?: "fail";
      disabled?: boolean;
      onSelect(): void;
    }
  | { kind: "label"; label: string }
  | { kind: "separator" }
  | { kind: "note"; text: string };

export type ConvMenuProps = {
  trigger: ReactElement<Record<string, unknown>>;
  entries: ConvMenuEntry[];
  /** Accessible name of the menu. */
  label?: string;
  side?: "top" | "bottom";
  /** Gap between the trigger and the menu (default 4, `space.1`). */
  sideOffset?: number;
  align?: "start" | "end";
  size?: "narrow" | "default" | "wide";
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /**
   * Draw the menu open in place (no portal, not modal, never closes): the reference set and the
   * catalog only.
   */
  inline?: boolean;
};

const isIconName = (x: unknown): x is IconName => typeof x === "string";

export function ConvMenu({
  trigger,
  entries,
  label,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  size = "default",
  open,
  onOpenChange,
  inline,
}: ConvMenuProps): JSX.Element {
  // Notes are not items, so screen readers skip them inside a menu: they describe the menu (m14).
  const noteId = useId();
  const notes = entries.flatMap((e, i) => (e.kind === "note" ? [`${noteId}-${i}`] : []));
  const content = (
    <RM.Content
      className="cb-cmenu"
      data-part="menu"
      data-size={size === "default" ? undefined : size}
      aria-label={label}
      {...(notes.length > 0 ? { "aria-describedby": notes.join(" ") } : {})}
      side={side}
      align={align}
      sideOffset={sideOffset}
      avoidCollisions={!inline}
    >
      {entries.map((e, i) => {
        switch (e.kind) {
          case "label":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
              <RM.Label key={`l${i}`} className="cb-cmenu-label" data-part="menu-label">
                {e.label}
              </RM.Label>
            );
          case "separator":
            // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
            return <RM.Separator key={`s${i}`} className="cb-cmenu-sep" />;
          case "note":
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
                key={`n${i}`}
                id={`${noteId}-${i}`}
                className="cb-cmenu-note"
                data-part="menu-note"
              >
                {e.text}
              </div>
            );
          default:
            return (
              <RM.Item
                key={e.id}
                className="cb-cmenu-item"
                data-part="menu-item"
                data-tone={e.tone}
                disabled={e.disabled}
                onSelect={() => e.onSelect()}
                {...(e.checked !== undefined
                  ? { role: "menuitemradio", "aria-checked": e.checked }
                  : {})}
              >
                {e.icon === undefined ? null : isIconName(e.icon) ? (
                  <Icon name={e.icon} size={14} />
                ) : (
                  e.icon
                )}
                <span className="cb-cmenu-text">{e.label}</span>
                {e.tag ? (
                  <span className="cb-cmenu-tag" data-part="menu-tag">
                    {e.tag}
                  </span>
                ) : null}
                {e.checked !== undefined ? (
                  <>
                    <span className="cb-cmenu-grow" />
                    {e.checked && e.checkMark !== false ? <Icon name="check" size={14} /> : null}
                  </>
                ) : null}
              </RM.Item>
            );
        }
      })}
    </RM.Content>
  );
  return (
    <RM.Root
      {...(inline
        ? { open: true, modal: false, onOpenChange: () => {} }
        : {
            ...(open !== undefined ? { open } : {}),
            ...(onOpenChange ? { onOpenChange } : {}),
          })}
    >
      <RM.Trigger asChild>{trigger}</RM.Trigger>
      {inline ? content : <RM.Portal>{content}</RM.Portal>}
    </RM.Root>
  );
}
