import type { ReactNode } from "react";
import { Dither, Logo } from "../display/index";
import { Card, Text } from "../layout/index";
import { PreferenceBar, type PreferenceBarProps } from "../shell/preference-bar";

/**
 * T10 auth: no shell, a centered 400-wide card between two dither columns (Dither is used only
 * here), the optional `footer` under the card. `preferences` (language and theme) sit in the
 * bottom-right corner, just inside the right dither column.
 */
export function AuthPage({
  title,
  subtitle,
  footer,
  preferences,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  preferences?: PreferenceBarProps;
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
      {preferences ? (
        <div className="cb-auth-prefs">
          <PreferenceBar {...preferences} />
        </div>
      ) : null}
      <div className="cb-auth-side" data-side="right">
        <Dither side="right" seed={2} />
      </div>
    </div>
  );
}
