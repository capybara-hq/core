import type { JSX } from "react";
import { Markdown } from "../display/markdown";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

/** The streaming cursor (§6.16.4): an `accent` block after the text, steady under reduced motion. */
export function Cursor(): JSX.Element {
  return <span className="cb-cursor" data-part="cursor" aria-hidden="true" />;
}

/** The running spinner of the stream (12, `accent`, one turn per `motion.spin`). */
export function Spinner({ label }: { label?: string }): JSX.Element {
  const t = useDesignT();
  return (
    <span
      className="cb-conv-spin"
      data-part="spinner"
      role="img"
      aria-label={label ?? t("conv.running")}
    >
      <Icon name="spinner" size={12} />
    </span>
  );
}

export type ProseProps = {
  markdown: string;
  /** Shows the cursor at the end of the text. */
  streaming?: boolean;
  /** Paths of the conversation's file outputs: matching inline code or text renders as a chip. */
  paths?: ReadonlySet<string>;
  onOpenPath?(path: string): void;
};

/** Assistant text (§6.16.4): the prose face at `prose` 15 / 26, rendered Markdown. */
export function Prose({ markdown, streaming, paths, onOpenPath }: ProseProps): JSX.Element {
  return (
    <div className="cb-prose" data-part="prose">
      <Markdown
        text={markdown}
        {...(paths ? { paths } : {})}
        {...(onOpenPath ? { onOpenPath } : {})}
        {...(streaming ? { tail: <Cursor /> } : {})}
      />
    </div>
  );
}
