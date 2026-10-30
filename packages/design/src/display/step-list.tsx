import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";

export type Step = {
  label: string;
  description: string;
  done: boolean;
  action?: ReactNode;
};

/**
 * Steps to finish, each done or to do, with its own action (spec §6.12): OnboardingPage centers it
 * on the page; `inset="card"` fills a Card (the overview's setup card).
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
          <Text variant="small" tone="muted">
            {s.done ? t("template.done") : t("template.todo")}
          </Text>
          {s.action ? <span className="cb-checklist-action">{s.action}</span> : null}
        </li>
      ))}
    </ol>
  );
}
