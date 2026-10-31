import * as RM from "@radix-ui/react-dropdown-menu";
import * as RP from "@radix-ui/react-popover";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { Icon } from "../icons/icon";
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

export function Popover({
  trigger,
  active,
  children,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <RP.Root>
      <RP.Trigger asChild>
        {cloneElement(trigger, {
          "data-active": active ? "true" : undefined,
          "data-cb-trigger": "popover",
        })}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content className="cb-popover" sideOffset={4} align="start">
          {children}
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
          sideOffset={sideOffset}
          align="start"
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

/** One level of items; danger items go last, after a separator. */
function MenuItems({ items }: { items: MenuItem[] }) {
  const Link = useDesignLink();
  const normal = items.filter((i) => i === "separator" || !i.danger);
  const danger = items.filter((i) => i !== "separator" && i.danger);
  const ordered: MenuItem[] = danger.length > 0 ? [...normal, "separator", ...danger] : normal;
  return ordered.map((item, i) => {
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
            <RM.SubContent className="cb-menu" sideOffset={4} alignOffset={-5}>
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
            {item.shortcut ? <span className="cb-menu-shortcut">{item.shortcut}</span> : null}
          </>
        )}
      </RM.Item>
    );
  });
}

function MenuLabel({ item }: { item: { label: string; checked?: boolean } }) {
  return (
    <span className="cb-menu-label">
      {item.checked !== undefined ? (
        <span className="cb-menu-check" aria-hidden="true">
          {item.checked ? <Icon name="check" size={14} /> : null}
        </span>
      ) : null}
      {item.label}
    </span>
  );
}
