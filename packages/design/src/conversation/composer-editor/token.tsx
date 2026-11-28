import type { JSX } from "react";
import { MarkImage } from "../../display/object-mark";
import { Icon } from "../../icons/icon";
import { useDesignT } from "../../provider";
import { typeBadge } from "../files";
import type { ComposerTokenData } from "./segments";

/** A skill token's visible label and plain form: "/name" (a label may already carry the slash). */
export function skillText(label: string): string {
  return label.startsWith("/") ? label : `/${label}`;
}

/** The token's accessible name (spec §1): 「连接器：Slack」, refused 「连接器：Slack，不可用」. */
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
  if (token.state === "refused") return <Icon name="circle-alert" size={14} />;
  if (token.icon?.name) return <Icon name={token.icon.name} size={14} />;
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
      return <Icon name="file-code" size={14} />;
    case "conversation":
      return <Icon name="chats" size={14} />;
    default:
      return null;
  }
}

/**
 * One inline token (composer inline tokens spec §1): an atomic box in the text flow with its lead
 * and label, the full label as its tooltip, `role="img"` named 「<kind>：<label>」. Presentational:
 * the composer's `TokenNode` and the bubble draw it. `selected` draws the accent outline;
 * `hidden` draws an invisible copy that only takes the token's room (the hint's ghost line).
 */
export function InlineToken({
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
            ...(token.state === "refused" && token.reason
              ? { "aria-description": token.reason }
              : {}),
          })}
    >
      <Lead token={token} />
      <span className="cb-inline-token-label" data-part="inline-token-label">
        {label}
      </span>
    </span>
  );
}
