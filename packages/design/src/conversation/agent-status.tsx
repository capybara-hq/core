import type { JSX } from "react";
import type { Locale } from "../i18n";
import { messages } from "../i18n";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

// The agent status pieces shared by the agent map (§6.16.28) and the Agent call block in the
// stream (§6.16.15): the six statuses, the status dot and the token count. A module of its own
// so the map and the sub-agent group can both use them without importing each other.

/**
 * `limit`: the run ended on a limit (its step or time limit, or its tree's token budget) after
 * handing back what it had: not a failure, drawn `warn` ("已达上限").
 */
export type AgentMapStatus = "running" | "waiting" | "completed" | "limit" | "failed" | "aborted";

/** "392.7k tokens", "950 tokens", "1.3M tokens". */
export function agentMapTokens(n: number, locale: Locale): string {
  const v = Math.max(0, Math.round(n));
  const short =
    v < 1000
      ? String(v)
      : v < 1_000_000
        ? `${(Math.round(v / 100) / 10).toFixed(1)}k`
        : `${(Math.round(v / 100_000) / 10).toFixed(1)}M`;
  return fillCopy(messages[locale]["agentMap.tokens"], { n: short });
}

/** The status dot (8, round, the status word as its label); a running dot pulses. */
export function StatusDot({ status }: { status: AgentMapStatus }): JSX.Element {
  const t = useDesignT();
  return (
    <span
      className="cb-amap-dot"
      data-part="agent-dot"
      data-status={status}
      role="img"
      aria-label={t(`agentMap.status.${status}`)}
    />
  );
}
