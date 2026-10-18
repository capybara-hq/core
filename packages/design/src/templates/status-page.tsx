import type { ReactNode } from "react";
import { Logo } from "../display/index";
import { Text } from "../layout/index";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index";

const CODE = { "404": "404", "403": "403", maintenance: "503", disabled: "—" } as const;

/** T11 系统状态：Single 居中（404 / 403 / 维护中 / 未开通）。 */
export function StatusPage({
  header,
  kind,
  title,
  description,
  action,
}: {
  header: PageHeaderProps;
  kind: "404" | "403" | "maintenance" | "disabled";
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="StatusPage" data-kind={kind}>
      <PageHeader {...header} />
      <Body layout="single">
        <div className="cb-status-page">
          <Logo scale={3} tone="muted" />
          <Text variant="h1" tone="faint" as="p">
            {CODE[kind]}
          </Text>
          <Text variant="h2">{title}</Text>
          <Text tone="muted">{description}</Text>
          {action ? <div className="cb-status-page-action">{action}</div> : null}
        </div>
      </Body>
    </div>
  );
}
