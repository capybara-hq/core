import * as RD from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Kbd } from "../display/index.js";
import { useDesignT } from "../provider.js";

export type CommandGroup = {
  label: string;
  items: { id: string; label: string; shortcut?: string; onSelect(): void }[];
};

export function CommandPalette({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: CommandGroup[];
}) {
  const t = useDesignT();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content className="cb-palette" aria-describedby={undefined}>
          <RD.Title className="cb-sr-only">{t("palette.title")}</RD.Title>
          <Command className="cb-palette-cmd" loop>
            <div className="cb-palette-input">
              <span aria-hidden="true">&gt;</span>
              <Command.Input placeholder={t("palette.placeholder")} />
            </div>
            <Command.List className="cb-palette-list">
              <Command.Empty className="cb-palette-empty">{t("palette.empty")}</Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g.label} heading={g.label} className="cb-palette-group">
                  {g.items.map((it) => (
                    <Command.Item
                      key={it.id}
                      value={it.label}
                      className="cb-palette-item"
                      onSelect={() => {
                        it.onSelect();
                        onOpenChange(false);
                      }}
                    >
                      <span>{it.label}</span>
                      {it.shortcut ? <Kbd>{it.shortcut}</Kbd> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
            <div className="cb-palette-hints">
              <span>
                <Kbd>↑↓</Kbd> {t("palette.hintMove")}
              </span>
              <span>
                <Kbd>↵</Kbd> {t("palette.hintRun")}
              </span>
              <span>
                <Kbd>esc</Kbd> {t("palette.hintClose")}
              </span>
            </div>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
