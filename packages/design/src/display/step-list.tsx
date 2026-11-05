import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";

export type Step = {
  label: string;
  description: string;
  done: boolean;
  /**
   * The one thing at the right of a step that is not done: the action this viewer can take (a
   * button), or why it waits (muted text). A done step shows 已完成 instead.
   */
  action?: ReactNode;
};

/**
 * Steps to finish, each done or to do (spec §6.12): OnboardingPage centers it on the page;
 * `inset="card"` fills a Card (the setup home's checklist). The right of each row holds one thing,
 * centered with the row: 已完成 when done, else the step's `action` (a button or the reason it
 * waits); there is no "to do" label (the mark and the action say it).
 */
export function StepList({ steps, inset = "page" }: { steps: Step[]; inset?: "page" | "card" }) {
  const t = useDesignT();
  return (
    <ol className="cb-checklist" data-inset={inset}>
      {steps.map((s, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list of steps whose labels may repeat
          key={`${i}-${s.label}`}
          className="cb-checklist-item"
          data-step={i + 1}
          data-state={s.done ? "done" : "todo"}
        >
          <span className="cb-checklist-mark" aria-hidden="true">
            <Icon name={s.done ? "check" : "circle"} size={14} />
          </span>
          <span className="cb-checklist-text">
            <Text>{s.label}</Text>
            <Text variant="small" tone="muted">
              {s.description}
            </Text>
          </span>
          {s.done ? (
            <span className="cb-checklist-end" data-part="checklist-end">
              <Text variant="small" tone="muted">
                {t("template.done")}
              </Text>
            </span>
          ) : s.action ? (
            <span className="cb-checklist-end" data-part="checklist-end">
              {s.action}
            </span>
          ) : (
            <span className="cb-sr-only">{t("template.todo")}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
