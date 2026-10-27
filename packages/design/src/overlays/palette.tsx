import * as RD from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useState } from "react";
import { Kbd } from "../display/index";
import { useDesignT } from "../provider";
import { useFocusReturn } from "./focus-return";

/** One palette item (§6.7). */
export type CommandItem = {
  id: string;
  label: string;
  /** Muted text after the tags, one line with an ellipsis (a skill's description). */
  description?: string;
  /** Small tags after the hint ("manual", "sub-agent"). */
  tags?: string[];
  /** Faint text right after the label (a skill's argument hint "[issue-number]"). */
  hint?: string;
  /**
   * A secondary label at the end of the line, before the shortcut: the plugin a skill comes from
   * ("superpowers"). Shown only; the filter matches `search`.
   */
  source?: string;
  /** More text the filter matches like the label, not shown ("superpowers:brainstorming"). */
  search?: string;
  shortcut?: string;
  onSelect(): void;
};

export type CommandGroup = {
  label: string;
  items: CommandItem[];
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^\//, "");

/**
 * The palette's ranking (§6.7): a label prefix (a leading "/" ignored) before a `search` prefix
 * (or of a name after its "<plugin>:"), before a label substring, before a `search` substring,
 * before a description substring; anything else is filtered out. Pure, for the filter and tests.
 */
export function commandScore(
  item: Pick<CommandItem, "label" | "search" | "description">,
  query: string,
): number {
  const q = norm(query);
  if (q === "") return 1;
  const label = norm(item.label);
  const search = (item.search ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s !== "");
  if (label.startsWith(q)) return 1;
  if (search.some((s) => norm(s).startsWith(q) || norm(s.slice(s.indexOf(":") + 1)).startsWith(q)))
    return 0.9;
  if (label.includes(q)) return 0.8;
  if (search.some((s) => s.includes(q))) return 0.7;
  if ((item.description ?? "").toLowerCase().includes(q)) return 0.3;
  return 0;
}

/** cmdk's filter over the keywords each item passes: [label, search, description]. */
const filter = (_value: string, query: string, keywords?: string[]): number => {
  const [label = "", search = "", description = ""] = keywords ?? [];
  return commandScore({ label, search, description }, query);
};

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  inline,
  defaultSearch,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: CommandGroup[];
  /** The reference set and `/dev/ui` only: draw the palette in place, without the dialog. */
  inline?: boolean;
  /** The query the palette opens with (`/dev/ui` and the reference set). */
  defaultSearch?: string;
}) {
  const t = useDesignT();
  const focusReturn = useFocusReturn();
  const body = (
    <PaletteBody
      groups={groups}
      onOpenChange={onOpenChange}
      {...(defaultSearch !== undefined ? { defaultSearch } : {})}
    />
  );
  if (inline) {
    return (
      <div className="cb-palette" data-part="palette" data-inline="true">
        {body}
      </div>
    );
  }
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          className="cb-palette"
          data-part="palette"
          aria-describedby={undefined}
          onOpenAutoFocus={focusReturn.capture}
          onCloseAutoFocus={focusReturn.restore}
        >
          <RD.Title className="cb-sr-only">{t("palette.title")}</RD.Title>
          {body}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** The palette's content; mounted on each open, so the query starts empty (or `defaultSearch`). */
function PaletteBody({
  groups,
  onOpenChange,
  defaultSearch,
}: {
  groups: CommandGroup[];
  onOpenChange(open: boolean): void;
  defaultSearch?: string;
}) {
  const t = useDesignT();
  const [query, setQuery] = useState(defaultSearch ?? "");
  return (
    <Command className="cb-palette-cmd" label={t("palette.title")} loop filter={filter}>
      <div className="cb-palette-input" data-part="palette-input">
        <span aria-hidden="true">&gt;</span>
        <Command.Input
          placeholder={t("palette.placeholder")}
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <Command.List className="cb-palette-list">
        <Command.Empty className="cb-palette-empty">{t("palette.empty")}</Command.Empty>
        {groups.map((g) => (
          <Command.Group key={g.label} heading={g.label} className="cb-palette-group">
            {g.items.map((it) => (
              <Command.Item
                key={it.id}
                value={it.id}
                keywords={[it.label, it.search ?? "", it.description ?? ""]}
                className="cb-palette-item"
                data-part="palette-item"
                onSelect={() => {
                  it.onSelect();
                  onOpenChange(false);
                }}
              >
                <span className="cb-palette-label">{it.label}</span>
                {it.hint ? (
                  <span className="cb-palette-hint" data-part="palette-hint">
                    {it.hint}
                  </span>
                ) : null}
                {(it.tags ?? []).map((tag) => (
                  <span key={tag} className="cb-palette-tag" data-part="palette-tag">
                    {tag}
                  </span>
                ))}
                {it.description ? (
                  <span className="cb-palette-desc" data-part="palette-desc">
                    {it.description}
                  </span>
                ) : null}
                {it.source ? (
                  <span className="cb-palette-source" data-part="palette-source">
                    {it.source}
                  </span>
                ) : null}
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
  );
}
