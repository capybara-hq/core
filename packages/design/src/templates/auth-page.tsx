import type { ReactNode } from "react";
import { Dither, Logo } from "../display/index";
import { SkeletonBox, SkeletonGroup, SkeletonText } from "../display/skeleton";
import { Card, Stack, Text } from "../layout/index";
import { useDesignT } from "../provider";
import { PreferenceBar, type PreferenceBarProps } from "../shell/preference-bar";
import { type FieldShape, LoadingFields } from "./frame";

/**
 * T10 auth: no shell, a centered 400-wide card between two dither columns (Dither is used only
 * here), the optional `footer` under the card. `preferences` (language and theme) sit in the
 * bottom-right corner, just inside the right dither column. `loading` keeps the frame, the dither
 * columns, the logo and the card, with what the page knows (the title, the subtitle) real, and
 * draws `fields` field placeholders and the prominent submit button's box in the card in place of
 * `children` (one busy announcement).
 * A title the page does not know yet (an empty string) is a bar. The loaded card's other parts:
 * `subtitle: true` is a subtitle slot (a muted `body` line, 70%) for a subtitle that comes with the
 * data; `note` is static content the page shows for real after the fields (a warning card);
 * `buttons` is how many prominent button boxes the card ends with (default 1), in a gap-8 stack
 * that opens with `hint` (a static muted prose line the page shows above them) when given.
 */
export function AuthPage({
  title,
  subtitle,
  footer,
  preferences,
  loading,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  preferences?: PreferenceBarProps;
  loading?: {
    fields: number | FieldShape[];
    /** The subtitle comes with the data: a slot where it will be. */
    subtitle?: boolean;
    /** Static content the page shows for real after the fields. */
    note?: ReactNode;
    /** Prominent button boxes the card ends with (default 1). */
    buttons?: number;
    /** A static muted prose line above the buttons, in their stack. */
    hint?: string;
  };
  children?: ReactNode;
}) {
  const t = useDesignT();
  const page = (
    <>
      <div className="cb-auth-side" data-side="left">
        <Dither side="left" />
      </div>
      <main className="cb-auth-main">
        <div className="cb-auth-logo">
          <Logo scale={6} wordmark />
        </div>
        <div className="cb-auth-card" data-part="auth-card">
          <Card>
            <div className="cb-auth-head">
              {loading && title === "" ? (
                <SkeletonText width="45%" size="title" />
              ) : (
                <Text variant="h1" as="h1">
                  {title}
                </Text>
              )}
              {subtitle ? (
                <Text tone="muted">{subtitle}</Text>
              ) : loading?.subtitle ? (
                <SkeletonText width="70%" />
              ) : null}
            </div>
            {loading ? (
              <Stack gap={16}>
                <LoadingFields fields={loading.fields} />
                {loading.note ?? null}
                <Stack gap={8}>
                  {loading.hint !== undefined ? (
                    <Text variant="prose" tone="muted">
                      {loading.hint}
                    </Text>
                  ) : null}
                  {Array.from({ length: Math.max(0, loading.buttons ?? 1) }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
                    <SkeletonBox key={i} part="prominent" />
                  ))}
                </Stack>
              </Stack>
            ) : (
              children
            )}
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
    </>
  );
  return (
    <div className="cb-template cb-auth" data-template="AuthPage">
      {loading ? <SkeletonGroup label={title || t("table.loading")}>{page}</SkeletonGroup> : page}
    </div>
  );
}
