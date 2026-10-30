import type { core, z } from "zod";

/** 校验失败的单条原因：只含路径与按 issue 类型生成的说明，不回显字段值。 */
export interface ConfigIssue {
  path: string;
  message: string;
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

export function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: issueMessage(i),
  }));
}
