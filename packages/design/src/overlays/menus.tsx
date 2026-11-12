import * as RM from "@radix-ui/react-dropdown-menu";
import * as RP from "@radix-ui/react-popover";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "../layout/box";
import { useDesignLink } from "../provider";

export type MenuItem =
  | ({
      label: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /**
       * One choice of a single-choice set (such as the current org): `true` draws a `check` icon
       * before the label, `false` keeps the space for it; the item is a `menuitemradio` with
       * `aria-checked`, also when it is a link (`href`).
       */
      checked?: boolean;
      /** The current page (a navigation menu such as the sidebar's 更多): `aria-current="page"`. */
      current?: boolean;
      /** A leading 16 px icon (a navigation menu's items carry the main nav's icons). */
      icon?: IconName;
      /** One muted line of help after the label (a Repeater preset's help). */
      description?: string;
    } & (
      | { onSelect(): void; href?: undefined; submenu?: undefined }
      /** 导航项：以 DesignProvider 的 link 渲染。 */
      | { href: string; onSelect?(): void; submenu?: undefined }
      /**
       * A second-level menu (such as "Language" → the languages): opens to the side on hover,
       * click, or the right arrow key.
       */
      | { submenu: MenuItem[]; onSelect?: undefined; href?: undefined }
    ))
  | "separator";

/**
 * The items of a menu a person can act on: no separators, nothing disabled. A `more-horizontal`
 * menu with none of them is not drawn, and one with a single safe one is that action, drawn
 * directly (spec §6.7): a menu of one item only hides it. See {@link menuLone}.
 */
export function menuActions(items: readonly MenuItem[]): Exclude<MenuItem, "separator">[] {
  return items.filter(
    (i): i is Exclude<MenuItem, "separator"> => i !== "separator" && i.disabled !== true,
  );
}

/**
 * The menu's only action when it should be drawn directly instead of the menu (spec §6.7): exactly
 * one actionable item, not dangerous (a destructive action is never promoted out of its menu) and
 * not a submenu. `undefined` keeps the menu (or, with no actions, drops it).
 */
export function menuLone(items: readonly MenuItem[]): Exclude<MenuItem, "separator"> | undefined {
  const actions = menuActions(items);
  const only = actions.length === 1 ? actions[0] : undefined;
  return only && only.danger !== true && only.submenu === undefined ? only : undefined;
}

export function Popover({
  trigger,
  active,
  children,
  open,
  onOpenChange,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  active?: boolean;
  children: ReactNode;
  /** Controlled open state: a choice inside closes the popover (the calendar's 「+N」 list). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RP.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <RP.Trigger asChild>
        {cloneElement(trigger, {
          "data-active": active ? "true" : undefined,
          "data-cb-trigger": "popover",
        })}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          className="cb-popover"
          data-cap-part="menu"
          sideOffset={4}
          align="start"
          collisionPadding={COLLISION_PADDING}
        >
          <BoxScope kind="popover">{children}</BoxScope>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

export function Menu({
  trigger,
  items,
  onCloseAutoFocus,
  side,
  sideOffset = 4,
  open,
  onOpenChange,
  label,
  modal,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  items: MenuItem[];
  /** Called before focus returns to the trigger; `preventDefault()` keeps focus where an item put it. */
  onCloseAutoFocus?: (e: Event) => void;
  /** Where the menu opens (default below the trigger); `right` for a flyout beside a sidebar row. */
  side?: "bottom" | "right";
  sideOffset?: number;
  /** Controlled open state (a trigger that also opens on → ). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The menu's accessible name. */
  label?: string;
  /** Default true; false leaves the page usable while it is open (drawn open in the catalog). */
  modal?: boolean;
}) {
  return (
    <RM.Root
      {...(modal !== undefined ? { modal } : {})}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RM.Trigger asChild>{cloneElement(trigger, { "data-cb-trigger": "menu" })}</RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="cb-menu"
          data-cap-part="menu"
          sideOffset={sideOffset}
          align="start"
          collisionPadding={COLLISION_PADDING}
          // Opening below its trigger, a menu is at least as wide as it (the org switcher, the
          // account row); a flyout beside a sidebar row keeps its own width.
          data-match-trigger={side === "right" ? undefined : "true"}
          {...(side ? { side } : {})}
          {...(label ? { "aria-label": label } : {})}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        >
          <MenuItems items={items} />
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

/** Menus keep this far from the viewport's edges (spec §6.7). */
export const COLLISION_PADDING = 8;

/**
 * The order a menu draws its items in (spec §6.7): danger items last, after a separator, and no
 * empty group: a separator never leads, trails or follows another separator, so a menu whose
 * only item is dangerous (a row's ⋯ → 停用) draws no line above it.
 */
export function menuOrder(items: readonly MenuItem[]): MenuItem[] {
  const normal = items.filter((i) => i === "separator" || !i.danger);
  const danger = items.filter((i) => i !== "separator" && i.danger);
  const ordered: MenuItem[] = [...normal, "separator", ...danger];
  const out: MenuItem[] = [];
  for (const item of ordered) {
    if (item === "separator" && (out.length === 0 || out[out.length - 1] === "separator")) continue;
    out.push(item);
  }
  if (out[out.length - 1] === "separator") out.pop();
  return out;
}

/** One level of items; danger items go last, after a separator. */
function MenuItems({ items }: { items: MenuItem[] }) {
  const Link = useDesignLink();
  return menuOrder(items).map((item, i) => {
    if (item === "separator") {
      // biome-ignore lint/suspicious/noArrayIndexKey: 分隔线无标识，顺序固定
      return <RM.Separator key={`sep-${i}`} className="cb-menu-sep" />;
    }
    if (item.submenu !== undefined) {
      return (
        <RM.Sub key={item.label}>
          <RM.SubTrigger className="cb-menu-item" disabled={item.disabled}>
            <MenuLabel item={item} />
            <span className="cb-menu-sub-mark" aria-hidden="true">
              <Icon name="chevron-right" size={14} />
            </span>
          </RM.SubTrigger>
          <RM.Portal>
            <RM.SubContent
              className="cb-menu"
              data-cap-part="menu"
              sideOffset={4}
              alignOffset={-5}
              collisionPadding={COLLISION_PADDING}
            >
              <MenuItems items={item.submenu} />
            </RM.SubContent>
          </RM.Portal>
        </RM.Sub>
      );
    }
    return (
      <RM.Item
        key={item.label}
        className="cb-menu-item"
        data-danger={item.danger ? "true" : undefined}
        disabled={item.disabled}
        onSelect={() => item.onSelect?.()}
        // 禁用的导航项不渲染链接（否则原生 <a> 仍会跳转），由 Radix 标 aria-disabled
        asChild={item.href !== undefined && !item.disabled}
        {...(item.checked !== undefined
          ? { role: "menuitemradio", "aria-checked": item.checked }
          : {})}
        {...(item.current ? { "aria-current": "page" as const, "data-current": "true" } : {})}
      >
        {item.href !== undefined && !item.disabled ? (
          <Link href={item.href} className="cb-menu-item cb-menu-link">
            <MenuLabel item={item} />
          </Link>
        ) : (
          <>
            <MenuLabel item={item} />
            {item.description ? (
              <span className="cb-menu-description">{item.description}</span>
            ) : null}
            {item.shortcut ? <span className="cb-menu-shortcut">{item.shortcut}</span> : null}
          </>
        )}
      </RM.Item>
    );
  });
}

function MenuLabel({
  item,
}: {
  item: { label: string; checked?: boolean; icon?: IconName | undefined };
}) {
  return (
    <span className="cb-menu-label">
      {item.checked !== undefined ? (
        <span className="cb-menu-check" aria-hidden="true">
          {item.checked ? <Icon name="check" size={14} /> : null}
        </span>
      ) : null}
      {item.icon ? <Icon name={item.icon} size={16} /> : null}
      {item.label}
    </span>
  );
}
