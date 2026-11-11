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
  /** The last lines of the output; empty draws the muted "No output" line, never an empty box. */
  text: string;
  /**
   * `sandbox`: read from the environment now. `event`: the output cannot be read now and the text
   * is the tail the finish event carried. `none`: nothing could be read (no text).
   */
  source: "sandbox" | "event" | "none";
  /** Why the output cannot be read now (with `event` and `none`): the note above the text. */
  unavailable?: TaskOutputUnavailable;
  /**
   * A stop is under way (the task view's `stopping`, or this page's stop in flight): the task still
   * runs, the stop button gives way to "正在停止…" / "Stopping…", announced politely.
   */
  stopping?: boolean;
  onStop(): void;
};

/**
 * Why a task's output cannot be read now (the kernel's reason): `starting`, `not_started` (the
 * launch failed; `detail` says why), `device_offline`, `suspended`, `rebuilt` (the instance and
 * its files are gone), `output_missing`, `no_access`, `unavailable` (the provider is not loaded),
 * `read_failed`.
 */
export type TaskOutputUnavailableReason =
  | "starting"
  | "not_started"
  | "device_offline"
  | "suspended"
  | "rebuilt"
  | "output_missing"
  | "no_access"
  | "unavailable"
  | "read_failed";

export type TaskOutputUnavailable = {
  reason: TaskOutputUnavailableReason;
  /** Where the task ran: a local `device` (its machine) or a cloud `sandbox`; names it in the note. */
  environment: "device" | "sandbox";
  /** A diagnostic line under the note (the failed launch's reason, as the kernel wrote it). */
  detail?: string;
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
 * way), the note saying why the output cannot be read now (naming the device or the sandbox),
 * and the last lines in a `CodeBlock`, or the muted "No output" line when there are none. A task
 * that never started has no output line at all.
 */
export function TaskOutputPanel({
  description,
  command,
  status,
  elapsed,
  text,
  source,
  unavailable,
  stopping,
  onStop,
}: TaskOutputPanelProps): JSX.Element {
  const t = useDesignT();
  const failed = status === "failed" || status === "timed_out";
  const env = unavailable ? t(`background.env.${unavailable.environment}`) : "";
  const note =
    source === "sandbox"
      ? null
      : unavailable
        ? fillCopy(t(`background.unavailable.${unavailable.reason}`), { env }) +
          (source === "event" && text !== "" ? ` ${t("background.lastLines")}` : "")
        : t("background.unavailable.read_failed");
  const never = unavailable?.reason === "not_started" || unavailable?.reason === "starting";
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
      {note !== null ? (
        <div className="cb-muted cb-task-output-note" data-part="task-output-note">
          {note}
        </div>
      ) : null}
      {unavailable?.detail ? (
        <div className="cb-faint cb-task-output-detail" data-part="task-output-detail">
          {unavailable.detail}
        </div>
      ) : null}
      {text !== "" ? (
        <CodeBlock text={text} />
      ) : never ? null : (
        <div className="cb-muted cb-task-output-empty" data-part="task-output-empty">
          {t("background.noOutput")}
        </div>
      )}
    </section>
  );
}
