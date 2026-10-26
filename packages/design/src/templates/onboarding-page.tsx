import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/** T12 首次使用：Single 居中清单。 */
export function OnboardingPage({
  header,
  steps,
}: {
  header: PageHeaderProps;
  steps: { label: string; description: string; done: boolean; action?: ReactNode }[];
}) {
  const t = useDesignT();
  return (
    <div className="cb-template" data-template="OnboardingPage" data-width="full">
      <TemplateHead header={header} width="full" />
      <Body layout="single">
        <ol className="cb-checklist">
          {steps.map((s, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态步骤列表，标签可能重复，需带序号
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
      </Body>
    </div>
  );
}
