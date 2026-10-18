import type { ReactNode } from "react";
import { Text } from "../layout/index.js";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index.js";

/** T12 首次使用：Single 居中清单。 */
export function OnboardingPage({
  header,
  steps,
}: {
  header: PageHeaderProps;
  steps: { label: string; description: string; done: boolean; action?: ReactNode }[];
}) {
  return (
    <div className="cb-template" data-template="OnboardingPage">
      <PageHeader {...header} />
      <Body layout="single">
        <ol className="cb-checklist">
          {steps.map((s, i) => (
            <li
              key={s.label}
              className="cb-checklist-item"
              data-step={i + 1}
              data-state={s.done ? "done" : "todo"}
            >
              <span className="cb-checklist-mark" aria-hidden="true">
                {s.done ? "✓" : "○"}
              </span>
              <span className="cb-checklist-text">
                <Text>{s.label}</Text>
                <Text variant="small" tone="muted">
                  {s.description}
                </Text>
              </span>
              {s.action ? <span className="cb-checklist-action">{s.action}</span> : null}
            </li>
          ))}
        </ol>
      </Body>
    </div>
  );
}
