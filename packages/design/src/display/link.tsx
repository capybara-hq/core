import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { useDesignLink } from "../provider";

/**
 * An in-site text link (spec §6.5): drawn through the DesignProvider's `link`, `ink` text with a
 * `line-strong` underline (the underline turns `ink` on hover), never the browser's link colors.
 */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  const Link = useDesignLink();
  return (
    <Link href={href} className="cb-text-link" data-part="text-link">
      {children}
    </Link>
  );
}

/**
 * A card that leads to another page (spec §6.5): on the `panel` ground, radius `md`; a title, a
 * one-paragraph description and one TextLink with a `chevron-right` icon.
 */
export function LinkCard({
  title,
  description,
  href,
  linkLabel,
}: {
  title: string;
  description?: ReactNode;
  href: string;
  linkLabel: string;
}) {
  return (
    <section className="cb-link-card" data-part="link-card">
      <h3 className="cb-link-card-title">{title}</h3>
      {description ? <p className="cb-link-card-description">{description}</p> : null}
      <span className="cb-link-card-link">
        <TextLink href={href}>
          {linkLabel}
          <Icon name="chevron-right" size={12} />
        </TextLink>
      </span>
    </section>
  );
}
