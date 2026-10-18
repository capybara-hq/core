import * as RM from "@radix-ui/react-dropdown-menu";
import * as RP from "@radix-ui/react-popover";
import { cloneElement, type ReactElement, type ReactNode } from "react";

export type MenuItem =
  | {
      label: string;
      shortcut?: string;
      onSelect(): void;
      danger?: boolean;
      disabled?: boolean;
    }
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
        {cloneElement(trigger, { "data-active": active ? "true" : undefined })}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content className="cb-popover" sideOffset={4} align="start">
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

export function Menu({ trigger, items }: { trigger: ReactElement; items: MenuItem[] }) {
  const normal = items.filter((i) => i === "separator" || !i.danger);
  const danger = items.filter((i) => i !== "separator" && i.danger);
  const ordered: MenuItem[] = danger.length > 0 ? [...normal, "separator", ...danger] : normal;
  return (
    <RM.Root>
      <RM.Trigger asChild>{trigger}</RM.Trigger>
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
                onSelect={() => item.onSelect()}
              >
                <span>{item.label}</span>
                {item.shortcut ? <span className="cb-menu-shortcut">{item.shortcut}</span> : null}
              </RM.Item>
            ),
          )}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
