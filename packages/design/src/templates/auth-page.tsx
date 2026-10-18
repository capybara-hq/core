import type { ReactNode } from "react";
import { Dither, Logo } from "../display/index.js";
import { Card, Text } from "../layout/index.js";

/** T10 认证：无 Shell，居中卡片宽 400 + 两侧抖动点阵（Dither 仅此处使用）。 */
export function AuthPage({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template cb-auth" data-template="AuthPage">
      <div className="cb-auth-side" data-side="left">
        <Dither side="left" />
      </div>
      <main className="cb-auth-main">
        <div className="cb-auth-logo">
          <Logo scale={6} wordmark />
        </div>
        <div className="cb-auth-card">
          <Card>
            <div className="cb-auth-head">
              <Text variant="h1" as="h1">
                {title}
              </Text>
              {subtitle ? <Text tone="muted">{subtitle}</Text> : null}
            </div>
            {children}
          </Card>
        </div>
        {footer ? <div className="cb-auth-footer">{footer}</div> : null}
      </main>
      <div className="cb-auth-side" data-side="right">
        <Dither side="right" seed={2} />
      </div>
    </div>
  );
}
