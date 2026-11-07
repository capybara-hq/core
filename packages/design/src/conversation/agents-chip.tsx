import type { JSX } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { StatusDot } from "./agent-status";
import { fillCopy } from "./tool-copy";

export type AgentsChipProps = {
  /** Every sub-agent of the conversation's tree (the root not counted). None: nothing. */
  count: number;
  /** How many of them run (queued included): the dot is the `accent` pulse while any does. */
  running: number;
  /** How many wait for a person: the dot is `warn` while any does and none runs. */
  waiting?: number;
  /** Opens the agent map at its root level. */
  onOpen(): void;
};

/** `text` with `{n}` drawn as the emphasized number (the copy keeps its own word order). */
function withNumber(text: string, n: number, part: string): JSX.Element {
  const [before = "", after = ""] = text.split("{n}");
  return (
    <>
      {before}
      <span className="cb-agents-chip-number" data-part={part}>
        {n}
      </span>
      {after}
    </>
  );
}

/**
 * The agent map's entry in the composer's control row (§6.16.29, acceptance item AC3), as Claude
 * Code's "0 agents": a ghost chip like the pickers, "N 个智能体" / "N agents", the number in `ink`
 * at weight 500 and the words `muted`. It always leads with a mark: the agent map's status dot
 * while a sub-agent runs (`accent`, pulsing) or waits for a person (`warn`), else the `agent`
 * icon. While some are active a short activity part follows ("· 1 个运行中", else "· 2 个等待中";
 * the dot carries the color, the text stays `muted` / `ink`). Its accessible name and tooltip add
 * the running count ("3 个智能体，1 个运行中"). Below 640 it shrinks to the mark and the count.
 */
export function AgentsChip({
  count,
  running,
  waiting = 0,
  onOpen,
}: AgentsChipProps): JSX.Element | null {
  const t = useDesignT();
  if (count <= 0) return null;
  const labelCopy = t(count === 1 ? "agentsChip.one" : "agentsChip.many");
  const label = fillCopy(labelCopy, { n: count });
  const name = [
    label,
    fillCopy(t("agentsChip.running"), { n: running }),
    ...(waiting > 0 ? [fillCopy(t("agentsChip.waiting"), { n: waiting })] : []),
  ].join(t("agentsChip.separator"));
  const status = running > 0 ? "running" : waiting > 0 ? "waiting" : undefined;
  return (
    <Button
      variant="ghost"
      className="cb-picker cb-agents-chip"
      part="agents-chip"
      aria-label={name}
      aria-haspopup="dialog"
      title={name}
      data-status={status}
      onClick={onOpen}
    >
      {status !== undefined ? (
        <StatusDot status={status} />
      ) : (
        <span className="cb-agents-chip-icon" data-part="agents-chip-icon" aria-hidden="true">
          <Icon name="agent" size={14} />
        </span>
      )}
      <span className="cb-agents-chip-label" data-part="agents-chip-label">
        {withNumber(labelCopy, count, "agents-chip-number")}
      </span>
      {status !== undefined ? (
        // the name already says it; the dot before the label carries the color
        <span
          className="cb-agents-chip-activity"
          data-part="agents-chip-activity"
          aria-hidden="true"
        >
          {"· "}
          {status === "running"
            ? withNumber(t("agentsChip.running"), running, "agents-chip-activity-number")
            : withNumber(t("agentsChip.waiting"), waiting, "agents-chip-activity-number")}
        </span>
      ) : null}
      {/* below 640: the count alone (the full label stays the name and the tooltip) */}
      <span className="cb-agents-chip-count" data-part="agents-chip-count" aria-hidden="true">
        {count}
      </span>
    </Button>
  );
}
