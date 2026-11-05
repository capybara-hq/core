import type { core, z } from "zod";

/** 校验失败的单条原因：只含路径与按 issue 类型生成的说明，不回显字段值。 */
export interface ConfigIssue {
  /** The path joined with dots (`""` = the root); ambiguous when a key contains a dot. */
  path: string;
  /** The zod path unjoined (record keys such as endpoint names may contain dots). */
  segments: (string | number)[];
  message: string;
  /**
   * A custom issue whose `params.ui` names a key of the schema's root `x-ui.messages`: the form
   * shows that localized message (spec §4.4). Never zod's own custom text.
   */
  messageKey?: string;
}

/** 由 issue 类型与结构字段生成说明；不用 zod 的 message（自定义消息可能拼入输入值）。 */
function issueMessage(i: core.$ZodIssue): string {
  switch (i.code) {
    case "invalid_type":
      return `expected ${i.expected}`;
    case "too_small":
      return `too small (minimum ${String(i.minimum)})`;
    case "too_big":
      return `too big (maximum ${String(i.maximum)})`;
    case "invalid_format":
      return `invalid ${i.format}`;
    case "not_multiple_of":
      return `not a multiple of ${String(i.divisor)}`;
    case "unrecognized_keys":
      return "unrecognized keys";
    case "invalid_union":
      return "no union member matched";
    case "invalid_key":
      return "invalid key";
    case "invalid_element":
      return "invalid element";
    default:
      return "invalid value";
  }
}

/** The `params.ui` of a custom issue when it names one of `messages` (own keys only). */
function messageKeyOf(i: core.$ZodIssue, messages?: Record<string, unknown>): string | undefined {
  if (i.code !== "custom" || messages === undefined) return undefined;
  const key = (i.params as { ui?: unknown } | undefined)?.ui;
  return typeof key === "string" && Object.hasOwn(messages, key) ? key : undefined;
}

/**
 * The issues of a failed config parse. `messages` is the root `x-ui.messages` of the schema's
 * form JSON Schema (`configMessages`): custom issues naming one of its keys get `messageKey`.
 */
export function toIssues(error: z.ZodError, messages?: Record<string, unknown>): ConfigIssue[] {
  return error.issues.map((i) => {
    const segments = i.path.map((s) => (typeof s === "number" ? s : String(s)));
    const messageKey = messageKeyOf(i, messages);
    return {
      path: segments.join("."),
      segments,
      message: issueMessage(i),
      ...(messageKey !== undefined && { messageKey }),
    };
  });
}
