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
       * A choice item (such as the current org): `true` draws a `check` icon before the label,
       * `false` keeps the space for it; the item is a `menuitemcheckbox` with `aria-checked`.
       */
      checked?: boolean;
    } & (
      | { onSelect(): void; href?: undefined }
      /** 导航项：以 DesignProvider 的 link 渲染。 */
      | { href: string; onSelect?(): void }
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
}: {
  trigger: ReactElement<Record<string, unknown>>;
  items: MenuItem[];
}) {
  const Link = useDesignLink();
  const normal = items.filter((i) => i === "separator" || !i.danger);
  const danger = items.filter((i) => i !== "separator" && i.danger);
  const ordered: MenuItem[] = danger.length > 0 ? [...normal, "separator", ...danger] : normal;
  return (
    <RM.Root>
      <RM.Trigger asChild>{cloneElement(trigger, { "data-cb-trigger": "menu" })}</RM.Trigger>
      <RM.Portal>
        <RM.Content className="cb-menu" sideOffset={4} align="start">
          {ordered.map((item, i) =>
            item === "separator" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: 分隔线无标识，顺序固定
              <RM.Separator key={`sep-${i}`} className="cb-menu-sep" />
            ) : (
              <RM.Item
                key={item.label}
                className="cb-menu-item"
                data-danger={item.danger ? "true" : undefined}
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
                // 禁用的导航项不渲染链接（否则原生 <a> 仍会跳转），由 Radix 标 aria-disabled
                asChild={item.href !== undefined && !item.disabled}
                {...(item.checked !== undefined
                  ? { role: "menuitemcheckbox", "aria-checked": item.checked }
                  : {})}
              >
                {item.href !== undefined && !item.disabled ? (
                  <Link href={item.href} className="cb-menu-item cb-menu-link">
                    {item.label}
                  </Link>
                ) : (
                  <>
                    <span className="cb-menu-label">
                      {item.checked !== undefined ? (
                        <span className="cb-menu-check" aria-hidden="true">
                          {item.checked ? <Icon name="check" size={14} /> : null}
                        </span>
                      ) : null}
                      {item.label}
                    </span>
                    {item.shortcut ? (
                      <span className="cb-menu-shortcut">{item.shortcut}</span>
                    ) : null}
                  </>
                )}
              </RM.Item>
            ),
          )}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
