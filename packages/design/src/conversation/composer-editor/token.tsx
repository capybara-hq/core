import { type JSX, useId } from "react";
import { MarkImage } from "../../display/object-mark";
import { Icon } from "../../icons/icon";
import { useDesignLink, useDesignT } from "../../provider";
import { typeBadge } from "../files";
import type { ComposerTokenData } from "./segments";

/**
 * What a bubble's token opens (composer inline tokens spec §6.16.6): a page (`href`, through the
 * DesignProvider's link: a referenced conversation) or the page's own action (`onOpen`: a library
 * file in the right panel). In the composer a token opens nothing.
 */
export type InlineTokenAction = { href: string } | { onOpen(): void };

/** A skill token's visible label and plain form: "/name" (a label may already carry the slash). */
export function skillText(label: string): string {
  return label.startsWith("/") ? label : `/${label}`;
}

/** The token's accessible name (spec §1): "<kind>: <label>", refused adds ", unavailable". */
export function useTokenName(): (token: ComposerTokenData) => string {
  const t = useDesignT();
  return (token) => {
    const label = token.kind === "skill" ? skillText(token.label) : token.label;
    const name = t(`composer.token.${token.kind}`).replace("{name}", () => label);
    return token.state === "refused"
      ? t("composer.token.unavailable").replace("{name}", () => name)
      : name;
  };
}

/** The lead before the label: the connector's mark, the file type, the kind's icon; none for a skill. */
function Lead({ token }: { token: ComposerTokenData }): JSX.Element | null {
  if (token.state === "refused") return <Icon name="circle-alert" size={16} />;
  if (token.icon?.name) return <Icon name={token.icon.name} size={16} />;
  switch (token.kind) {
    case "connector":
    case "resource":
      return (
        <span className="cb-inline-token-mark" data-part="inline-token-mark">
          <MarkImage
            {...(token.icon?.src ? { src: token.icon.src } : {})}
            text={token.icon?.initial ?? token.label}
            size={16}
          />
        </span>
      );
    case "file":
      return (
        <span className="cb-inline-token-type" data-part="inline-token-type">
          {token.icon?.fileType ?? typeBadge(token.label, "")}
        </span>
      );
    case "projectFile":
      return <Icon name="file-code" size={16} />;
    case "conversation":
      return <Icon name="chats" size={16} />;
    default:
      return null;
  }
}

/**
 * One inline token (composer inline tokens spec §1): an atomic box in the text flow with its lead
 * and label, the full label as its tooltip, `role="img"` named "<kind>: <label>". Presentational:
 * the composer's `TokenNode` and the bubble draw it. `selected` draws the accent outline;
 * `hidden` draws an invisible copy that only takes the token's room (the hint's ghost line).
 */
export function InlineToken({
  token,
  selected,
  hidden,
  action,
}: {
  token: ComposerTokenData;
  selected?: boolean;
  hidden?: boolean;
  /** The bubble's tokens that open something: a link or a button around the token. */
  action?: InlineTokenAction;
}): JSX.Element {
  const Link = useDesignLink();
  const box = (
    <TokenBox token={token} {...(selected ? { selected } : {})} {...(hidden ? { hidden } : {})} />
  );
  if (action === undefined || hidden) return box;
  return "href" in action ? (
    <Link href={action.href} className="cb-inline-token-link" data-part="inline-token-link">
      {box}
    </Link>
  ) : (
    <button
      type="button"
      className="cb-inline-token-link"
      data-part="inline-token-link"
      onClick={action.onOpen}
    >
      {box}
    </button>
  );
}

/** The token's box: its lead and label, named for assistive technology. */
function TokenBox({
  token,
  selected,
  hidden,
}: {
  token: ComposerTokenData;
  selected?: boolean;
  hidden?: boolean;
}): JSX.Element {
  const name = useTokenName()(token);
  const label = token.kind === "skill" ? skillText(token.label) : token.label;
  const reasonId = useId();
  const reason = !hidden && token.state === "refused" && token.reason ? token.reason : undefined;
  return (
    <span
      className="cb-inline-token"
      data-part="inline-token"
      data-kind={token.kind}
      data-state={token.state}
      data-selected={selected ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      {...(hidden
        ? { "aria-hidden": true }
        : {
            role: "img",
            "aria-label": name,
            title: label,
            ...(reason ? { "aria-describedby": reasonId } : {}),
          })}
    >
      <Lead token={token} />
      <span className="cb-inline-token-label" data-part="inline-token-label">
        {/* a path gives way at its start (the tooltip keeps it whole): the label runs right to
            left around a left-to-right run, so the ellipsis lands before the file name */}
        {token.kind === "projectFile" ? <span dir="ltr">{label}</span> : label}
      </span>
      {reason ? (
        <span id={reasonId} className="cb-sr-only">
          {reason}
        </span>
      ) : null}
    </span>
  );
}
