import type { ReactNode } from "react";
import { Text } from "../layout";
import { ItemList, ItemListItem } from "./item-list";
import { Subsection } from "./subsection";

/** One line under an impact row's title: muted by default; `warn` / `fail` carry their icon. */
export type ImpactPreviewNote = { text: string; tone?: "muted" | "warn" | "fail" };

/** One thing a change touches: an org, an agent, a component. */
export type ImpactPreviewItem = {
  id: string;
  /** Its name (`body` 500). */
  title: string;
  /** A mono kind or id after the title (`small`, `muted`): 技能, a connector's id. */
  code?: string;
  /** Marks after the title (a `Badge`). */
  marks?: ReactNode;
  /** Lines under the title: what happens to it, a warning about it. */
  notes?: ImpactPreviewNote[];
};

/** One titled group of an impact preview: 会变化, 保持不变, 受影响的组织 … */
export type ImpactPreviewGroup = {
  id: string;
  title: string;
  /** One help line under the heading (`small`, `muted`). */
  description?: string;
  /** The rows. */
  items?: ImpactPreviewItem[];
  /** Content before the rows (a component table). */
  content?: ReactNode;
  /**
   * The group's line when it holds nothing ("没有组件会被移除"); without it, an empty group is
   * left out, heading included.
   */
  empty?: string;
};

export type ImpactPreviewProps = {
  groups: ImpactPreviewGroup[];
  /** The one line drawn instead of the groups when none of them holds anything. */
  empty: string;
};

const has = (g: ImpactPreviewGroup) => (g.items?.length ?? 0) > 0 || Boolean(g.content);

/**
 * What a change would do, before it is confirmed (spec §6.35): an update, a switch-off, a scope
 * change or a disable. Titled groups split by hairlines (divided `Subsection`s, §6.32), each a real
 * list (`ItemList` rows, §6.33) whose rows carry their notes (a warning per org as a line under
 * that org). A group with nothing in it shows its own `empty` line or is left out; when no group
 * holds anything the preview is the single `empty` line, said once.
 */
export function ImpactPreview({ groups, empty }: ImpactPreviewProps) {
  if (!groups.some(has)) {
    return (
      <div className="cb-impact-preview" data-part="impact-preview" data-state="empty">
        <p className="cb-impact-preview-empty" data-part="impact-preview-empty">
          {empty}
        </p>
      </div>
    );
  }
  return (
    <div className="cb-impact-preview" data-part="impact-preview">
      {groups
        .filter((g) => has(g) || g.empty !== undefined)
        .map((g) => {
          const items = g.items ?? [];
          return (
            <Subsection
              key={g.id}
              title={g.title}
              variant="divided"
              {...(items.length > 0 ? { count: items.length } : {})}
              {...(g.description !== undefined ? { description: g.description } : {})}
            >
              {g.content}
              {items.length > 0 ? (
                <ItemList label={g.title}>
                  {items.map((i) => (
                    <ItemListItem
                      key={i.id}
                      title={i.title}
                      {...(i.code !== undefined ? { code: i.code } : {})}
                      {...(i.marks !== undefined ? { marks: i.marks } : {})}
                      meta={(i.notes ?? []).map((n) => (
                        <Text
                          key={n.text}
                          variant="small"
                          tone={n.tone ?? "muted"}
                          {...(n.tone === "warn" || n.tone === "fail"
                            ? { icon: "circle-alert" as const }
                            : {})}
                        >
                          {n.text}
                        </Text>
                      ))}
                    />
                  ))}
                </ItemList>
              ) : g.content ? null : (
                <p className="cb-impact-preview-empty" data-part="impact-preview-empty">
                  {g.empty}
                </p>
              )}
            </Subsection>
          );
        })}
    </div>
  );
}
