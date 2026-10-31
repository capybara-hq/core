import type { ReactNode } from "react";
import { Logo } from "../display/index";
import { Icon } from "../icons/icon";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

const CODE = { "404": "404", "403": "403", maintenance: "503", disabled: "—" } as const;

/**
 * T11 系统状态：Single 居中（404 / 403 / 维护中 / 未开通 / 没有访问权限）。
 * `no-access` (role pass): a page the viewer's role may not open; a lock instead of the code, the
 * role it needs (`need`, "需要：组织管理员") and who to ask (`ask`); never a retry.
 */
export function StatusPage({
  header,
  kind,
  title,
  description,
  action,
  need,
  ask,
}: {
  header: PageHeaderProps;
  kind: "404" | "403" | "maintenance" | "disabled" | "no-access";
  title: string;
  description: string;
  action?: ReactNode;
  /** `no-access`: the role the page needs, already localized ("组织管理员"). */
  need?: string;
  /** `no-access`: who to ask for access. */
  ask?: string;
}) {
  const t = useDesignT();
  return (
    <div className="cb-template" data-template="StatusPage" data-kind={kind} data-width="full">
      <TemplateHead header={header} statsInHead width="full" />
      <Body layout="single">
        <div className="cb-status-page">
          <Logo scale={3} tone="muted" />
          {kind === "no-access" ? (
            <span className="cb-status-lock" data-part="status-lock" aria-hidden="true">
              <Icon name="lock" size={24} />
            </span>
          ) : (
            <Text variant="h1" tone="faint" as="p">
              {CODE[kind]}
            </Text>
          )}
          <Text variant="h2">{title}</Text>
          <Text tone="muted">{description}</Text>
          {need !== undefined ? (
            <span className="cb-status-need" data-part="status-need">
              {t("statusPage.need").replace("{role}", need)}
            </span>
          ) : null}
          {ask !== undefined ? <Text tone="muted">{ask}</Text> : null}
          {action ? <div className="cb-status-page-action">{action}</div> : null}
        </div>
      </Body>
    </div>
  );
}
