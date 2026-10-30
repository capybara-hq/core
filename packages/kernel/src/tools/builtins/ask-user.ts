import { type FormAnswer, type InputForm, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import type { BuiltinTool } from "../registry.js";

const SPEC: ToolSpec = {
  name: "ask_user",
  description:
    "Ask the user one or more multiple-choice questions and wait for the answers. Use it when you " +
    "need the user's preference or decision to continue, or when a request is ambiguous; do not use " +
    "it for questions you can answer yourself. Each question has a short header, 2-4 options with a " +
    "label and a description, and can allow selecting several options (multiSelect). The user can " +
    "always choose Other and type their own answer instead. The run pauses until the user answers; " +
    "if they do not answer in time, the result says so.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        description: "Questions to ask (1-4).",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              minLength: 1,
              description: "The complete question, ending with a question mark.",
            },
            header: {
              type: "string",
              minLength: 1,
              maxLength: 12,
              description: 'A very short label for the question (max 12 chars), e.g. "Database".',
            },
            multiSelect: {
              type: "boolean",
              description: "Allow the user to select more than one option.",
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              description: "The choices (2-4). Do not add an Other option; it is always offered.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    minLength: 1,
                    description: "Short text of the choice (1-5 words).",
                  },
                  description: {
                    type: "string",
                    description: "What this choice means or implies.",
                  },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "header", "multiSelect", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** 续跑时带回的 state：提问时的等待小时数（`tools.approvalTimeoutHours`），用于超时说明。 */
interface AskState {
  hours: number;
}

/** 第 i 个问题的字段 key。 */
const fieldKey = (i: number): string => `q${i}`;

/**
 * 问题 → 表单（每个问题一个枚举字段）。InputForm 没有「选项说明」：header 与各选项说明写进字段说明，
 * 每个选项一行 `- <label>: <description>`。
 */
export function questionsForm(questions: Question[]): InputForm {
  return {
    title: questions.map((q) => q.header).join(" · "),
    fields: questions.map((q, i) => ({
      key: fieldKey(i),
      label: q.question,
      description: [
        q.header,
        ...q.options.map((o) =>
          o.description === "" ? `- ${o.label}` : `- ${o.label}: ${o.description}`,
        ),
      ].join("\n"),
      schema: { type: "string", enum: q.options.map((o) => o.label) },
      multiSelect: q.multiSelect,
      allowOther: true,
      required: true,
    })),
  };
}

/** 答案 → 给模型的结果文本：`User answered: "<question>" = "<answer>"; …`。 */
export function answerText(questions: Question[], answer: FormAnswer): string {
  const parts = questions.map((q, i) => {
    const v = answer[fieldKey(i)];
    const text = v === undefined ? "(no answer)" : Array.isArray(v) ? v.join(", ") : String(v);
    return `"${q.question}" = "${text}"`;
  });
  return `User answered: ${parts.join("; ")}`;
}

/** 给模型的结果文本 + 给界面的一句话说明（中英文，不进模型上下文）。 */
const text = (t: string, zh: string, en: string) => ({
  content: [{ type: "text" as const, text: t }],
  display: { summary: { zh, en } },
});

/**
 * 内置工具 `ask_user`：用通用的输入请求机制实现——首次调用返回 `input_required`，
 * 内核暂停运行并展示表单；用户回答（或超时）后用同一 input 再次调用，按 `ctx.resume` 生成结果。
 * 默认 allow（提问本身就是让用户参与，不再审批）。
 */
export function askUserTool(deps: { config: Pick<KernelConfigService, "get"> }): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    async run(input, ctx) {
      const { questions } = input as { questions: Question[] };
      if (ctx.resume) {
        const { answer, state } = ctx.resume;
        if (answer !== null) {
          const n = questions.length;
          return text(
            answerText(questions, answer),
            `用户回答了 ${n} 个问题`,
            `User answered ${n} question${n === 1 ? "" : "s"}`,
          );
        }
        const hours = (state as Partial<AskState> | null)?.hours;
        // 运行在等待中被中止时内核直接写取消说明，不会再调用工具；能走到这里的 null 只有超时
        // （以及未来的「用户关闭提问」，那时 state 不带小时数）。
        return typeof hours === "number"
          ? text(
              `The user did not answer within ${hours}h.`,
              `用户未在 ${hours} 小时内回答`,
              `No answer within ${hours}h`,
            )
          : text(
              "The user dismissed the question.",
              "用户关闭了提问",
              "User dismissed the question",
            );
      }
      for (const q of questions) {
        const labels = q.options.map((o) => o.label);
        if (new Set(labels).size !== labels.length) {
          throw new ToolError(
            `Option labels must be unique within a question; "${q.question}" has duplicates. Provide distinct labels.`,
          );
        }
      }
      const state: AskState = { hours: deps.config.get().tools.approvalTimeoutHours };
      return { kind: "input_required", form: questionsForm(questions), state };
    },
  };
}
