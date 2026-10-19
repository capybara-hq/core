import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../../config/schema.js";
import { outputNotFoundText, type ToolOutputs } from "../outputs.js";
import type { BuiltinTool } from "../registry.js";

/** 默认一次读的行数。 */
const DEFAULT_LIMIT = 200;
/**
 * 给尾部说明留的字符数：正文上限同时不超过 `outputSpillChars - FOOTER_RESERVE`，
 * 读取结果本身不会因超过转存阈值被再次转存。
 */
const FOOTER_RESERVE = 200;

const SPEC: ToolSpec = {
  name: "read_tool_output",
  description:
    "Read a saved tool output by its id, page by page. Large tool results are truncated in the " +
    "conversation and saved in full; the truncation notice gives the output id. Lines are numbered " +
    "from 0. Each call returns up to `limit` lines starting at line `offset`, capped at a maximum " +
    "number of characters, and ends with `[Lines <a>–<b> of <total>]`; continue with offset=<b+1>. " +
    "If a single line is too long, it is cut and the result says which offset and charOffset to " +
    "call again with. Outputs expire after a retention period.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "The output id from the truncation notice.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "First line to read (0-based). Default 0.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: `Maximum number of lines to read. Default ${DEFAULT_LIMIT}.`,
      },
      charOffset: {
        type: "integer",
        minimum: 0,
        description:
          "Character position to start from within the first line (only to continue a cut line). Default 0.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

interface ReadInput {
  id: string;
  offset?: number;
  limit?: number;
  charOffset?: number;
}

/**
 * 按行分页读取：从 `offset` 行（第一行从 `charOffset` 字符起）读最多 `limit` 行，正文不超过 `budget` 个字符。
 * 正文按整行截止；只有第一行本身就超过上限时按字符切，并写明续读位置。结尾写 `[Lines a–b of total]`（0 起）。
 */
export function readPage(
  id: string,
  content: string,
  opts: { offset: number; limit: number; charOffset: number; budget: number },
): string {
  const lines = content.split("\n");
  const total = lines.length;
  const { offset, limit, charOffset, budget } = opts;
  if (offset >= total) {
    throw new ToolError(
      `Offset ${offset} is past the end of output ${id} (${total} lines). Use an offset below ${total}.`,
    );
  }
  const first = lines[offset] as string;
  if (charOffset > 0 && charOffset >= first.length) {
    throw new ToolError(
      `charOffset ${charOffset} is past the end of line ${offset} (${first.length} characters). Use a charOffset below ${first.length}.`,
    );
  }
  const end = Math.min(total, offset + limit);
  const parts: string[] = [];
  let used = 0;
  let last = offset;
  let cut: string | null = null;
  for (let i = offset; i < end; i++) {
    const text = i === offset ? first.slice(charOffset) : (lines[i] as string);
    const cost = (parts.length > 0 ? 1 : 0) + text.length;
    if (used + cost <= budget) {
      parts.push(text);
      used += cost;
      last = i;
      continue;
    }
    if (parts.length === 0) {
      // 这一行本身就超过上限：按字符切
      parts.push(text.slice(0, budget));
      last = i;
      const next = charOffset + budget;
      cut = `[Line ${i} continues; call again with offset=${i} charOffset=${next}]`;
    }
    break;
  }
  const footer = `[Lines ${offset}–${last} of ${total}]`;
  return [parts.join("\n"), ...(cut === null ? [] : [cut]), footer].join("\n");
}

/** 内置工具 `read_tool_output`：读本会话未过期的输出存档（只读、默认 allow）。 */
export function readToolOutputTool(deps: {
  outputs: Pick<ToolOutputs, "load">;
  config: () => KernelConfig;
}): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    async run(input, ctx) {
      const { id, offset = 0, limit = DEFAULT_LIMIT, charOffset = 0 } = input as ReadInput;
      const content = await deps.outputs.load(
        { orgId: ctx.orgId, conversationId: ctx.conversationId },
        id,
      );
      if (content === null) throw new ToolError(outputNotFoundText(id));
      const cfg = deps.config().tools;
      const budget = Math.max(
        1,
        Math.min(cfg.maxResultReadChars, cfg.outputSpillChars - FOOTER_RESERVE),
      );
      return {
        content: [
          { type: "text", text: readPage(id, content, { offset, limit, charOffset, budget }) },
        ],
      };
    },
  };
}
