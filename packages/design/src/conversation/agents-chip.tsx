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
  /** How many wait for a person: the dot is `warn` while any does and none runs (else `faint`). */
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
 * Code's "● 3 agents": a ghost chip like the pickers, the label "N agents" alone, the number in
 * `ink` at weight 500 and the words `muted`. A dot leads it and carries the state: the agent map's
 * running dot (`accent`, pulsing) while a sub-agent runs, `warn` while one waits for a person and
 * none runs, else `faint` (all settled). Its accessible name and tooltip add the counts ("3 agents,
 * 1 running" in the locale's words). Below 600 it shrinks to the dot and the count.
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
        // settled: the plain `faint` dot (the name says it)
        <span className="cb-amap-dot" data-part="agent-dot" aria-hidden="true" />
      )}
      <span className="cb-agents-chip-label" data-part="agents-chip-label">
        {withNumber(labelCopy, count, "agents-chip-number")}
      </span>
      {/* below 600: the count alone (the full label stays the name and the tooltip) */}
      <span className="cb-agents-chip-count" data-part="agents-chip-count" aria-hidden="true">
        {count}
      </span>
    </Button>
  );
}
