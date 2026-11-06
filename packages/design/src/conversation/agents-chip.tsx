import type { JSX } from "react";
import { Button } from "../controls/button";
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

/**
 * The agent map's entry in the composer's control row (§6.16.29, acceptance item AC3), as Claude
 * Code's "0 agents": a ghost chip like the pickers, "N 个智能体" / "N agents", led by the agent
 * map's status dot while a sub-agent runs (`accent`, pulsing) or waits for a person (`warn`).
 * Its accessible name and tooltip add the running count ("3 个智能体，1 个运行中").
 */
export function AgentsChip({
  count,
  running,
  waiting = 0,
  onOpen,
}: AgentsChipProps): JSX.Element | null {
  const t = useDesignT();
  if (count <= 0) return null;
  const label = fillCopy(t(count === 1 ? "agentsChip.one" : "agentsChip.many"), { n: count });
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
      {status !== undefined ? <StatusDot status={status} /> : null}
      {label}
    </Button>
  );
}
