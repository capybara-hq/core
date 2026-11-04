import type { JSX } from "react";
import { IconButton } from "../controls/button";
import { CodeBlock } from "../display/chat";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import type { BackgroundTaskStatus } from "./subagents";
import { fillCopy } from "./tool-copy";

export type TaskOutputPanelProps = {
  /** The task's description: names the region and its stop button. */
  description: string;
  command: string;
  status: BackgroundTaskStatus;
  /** The formatted elapsed time. */
  elapsed: string;
  /** The last lines of the output. */
  text: string;
  /**
   * `sandbox`: read from the sandbox now. `event`: the sandbox is suspended and the text is the
   * tail the finish event carried, so a note says the full output is unavailable.
   */
  source: "sandbox" | "event";
  /**
   * A stop is under way (the task view's `stopping`, or this page's stop in flight): the task still
   * runs, the stop button gives way to "正在停止…" / "Stopping…", announced politely.
   */
  stopping?: boolean;
  onStop(): void;
};

const STATUS_COPY = {
  running: "conv.running",
  completed: "background.done",
  failed: "background.failed",
  stopped: "background.stopped",
  timed_out: "background.timedOut",
  lost: "background.lost",
} as const;

/**
 * A background task's output in the right panel's body: the command in the design's monospace,
 * the status and elapsed time with a stop button while it runs ("Stopping…" once a stop is under
 * way), the unavailable note when only the
 * finish event's tail is left, and the last lines in a `CodeBlock`.
 */
export function TaskOutputPanel({
  description,
  command,
  status,
  elapsed,
  text,
  source,
  stopping,
  onStop,
}: TaskOutputPanelProps): JSX.Element {
  const t = useDesignT();
  const failed = status === "failed" || status === "timed_out";
  return (
    <section className="cb-task-output" data-part="task-output" aria-label={description}>
      <div className="cb-task-output-head">
        <span className={failed ? "cb-fail-word" : "cb-muted"} data-part="task-output-status">
          {t(STATUS_COPY[status])}
        </span>
        <span className="cb-faint">{elapsed}</span>
        {status === "running" && stopping === true ? (
          <span
            className="cb-muted cb-task-output-stopping"
            data-part="task-output-stopping"
            role="status"
            aria-live="polite"
          >
            {t("background.stopping")}
          </span>
        ) : null}
        {status === "running" && stopping !== true ? (
          <IconButton
            density="dense"
            label={fillCopy(t("background.stop"), { name: description })}
            icon={<Icon name="square" size={12} />}
            onClick={onStop}
          />
        ) : null}
      </div>
      <div className="cb-task-command" data-part="task-command">
        {command}
      </div>
      {source === "event" ? (
        <div className="cb-muted cb-task-output-note" data-part="task-output-note">
          {t("background.unavailable")}
        </div>
      ) : null}
      <CodeBlock text={text} />
    </section>
  );
}
