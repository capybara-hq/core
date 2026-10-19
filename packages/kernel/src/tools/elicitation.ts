import type {
  ElicitationRequest,
  ElicitationResponse,
  FormAnswer,
  InputForm,
  ParamSchema,
} from "@capybara-hq/plugin-sdk";
import { validateInputForm } from "@capybara-hq/plugin-sdk";
import { specHash } from "./registry.js";

/**
 * MCP elicitation（D4，仿 Claude Code：表单 + URL 两种模式）映射到通用输入请求（Task 9 的 `InputRequired`）。
 *
 * 设计（为什么不是「真正挂起」）：官方 SDK 的 elicitation 答复只能在原 `tools/call` 还挂着时送回同一个会话；
 * 而内核等人回答时运行会暂停、worker 释放、连接器会话关闭（多副本下续跑可能在另一副本），原调用不可能保持。
 * 所以采用「可续的连接器调用」：
 *
 * 1. 调用途中远端发起 elicitation → 连接器调用 `onElicit` → 本会话（{@link ElicitationSession}）把请求映射成
 *    `InputForm`，记下待问的表单与 state，并**中止本次调用**（`onSuspend`，经 `callTool` 的 signal），`onElicit` 以
 *    {@link ElicitationSuspended} 拒绝；管线据此
 *    把这次执行当作 `input_required`（写 `question_asked`、运行进入等待）。
 * 2. 用户回答（或超时 / 取消）后，管线照常用同一 input 再次调用该工具，带 `ctx.resume = { state, answer }`；
 *    远端再次发起**同样的** elicitation（按指纹匹配：表单模式看 `requestedSchema` 与文案，URL 模式看地址的 origin + path 与文案）
 *    时，本会话立即用用户的答案答复，远端继续执行。一次调用里有多个 elicitation 时，state 带上之前的全部答复，
 *    每次续跑整条重放；最多 3 轮（管线的输入轮次上限）。
 *
 * 限制（写进报告与 skills/writing-tools）：远端第二次没有发起同样的 elicitation（换了 schema / 不再问）时，答案
 * 不会被使用——前者会再问一次用户，后者远端按自己的逻辑继续；远端在 elicitation 之前做过的副作用会随重新发起
 * 的调用再做一次（大多数服务在动手之前先问）；URL 模式的完成通知（`notifications/elicitation/complete`）收不到
 * （会话已关闭），以用户在卡片上确认「已完成」为准。
 *
 * 超出 InputForm 子集的表单（嵌套对象、`minLength > 1`、`minItems > 1` 等）不展示：立即答复 `decline`，并在工具
 * 结果末尾附一条给模型的英文说明。
 */

/** 本次调用为问用户而被中止（`onElicit` 以它拒绝；管线按 pending 的输入请求处理，不当作失败）。 */
export class ElicitationSuspended extends Error {
  constructor() {
    super("The call was suspended to ask the user for input");
    this.name = "ElicitationSuspended";
  }
}

/** 不能展示的 elicitation 被拒绝时附在工具结果后的说明（模型可见，英文）。 */
export const UNSUPPORTED_ELICITATION_NOTE =
  "The app asked the user for input that cannot be shown in this client, so the request was declined";

const unsupportedNote = (why: string) =>
  `[${UNSUPPORTED_ELICITATION_NOTE} (${why}). If the call needs that input, ask the user for it with ask_user and pass it as tool arguments, or try another approach.]`;

/** URL 模式表单里「已完成」开关的字段名。 */
export const URL_COMPLETED_FIELD = "completed";

/** 表单标题（远端给的 message）最多字符数。 */
const MAX_TITLE = 2000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

type Field = InputForm["fields"][number];

/** 一个属性 → 表单字段；超出子集返回原因。 */
function fieldFor(key: string, p: unknown, required: boolean): Field | string {
  const at = `field "${key}"`;
  if (!isObj(p)) return `${at} is not an object schema`;
  const label = str(p.title) ?? key;
  const notes: string[] = [];
  const description = str(p.description);
  if (description !== undefined) notes.push(description);
  let schema: ParamSchema;
  let multiSelect = false;
  switch (p.type) {
    case "string": {
      if (typeof p.minLength === "number" && p.minLength > 1) return `${at} uses minLength`;
      if (Array.isArray(p.enum)) {
        const values = p.enum.filter((x): x is string => typeof x === "string");
        if (values.length !== p.enum.length || values.length === 0)
          return `${at} has a non-string enum`;
        const names = Array.isArray(p.enumNames) ? p.enumNames : undefined;
        if (names && names.length === values.length && names.every((n) => typeof n === "string")) {
          notes.push(`Options: ${values.map((v, i) => `${v} = ${names[i]}`).join("; ")}.`);
        }
        schema = { type: "string", enum: values };
      } else if (Array.isArray(p.oneOf)) {
        const opts = p.oneOf.filter(
          (o): o is { const: string; title?: unknown } => isObj(o) && typeof o.const === "string",
        );
        if (opts.length !== p.oneOf.length || opts.length === 0)
          return `${at} has unsupported oneOf`;
        notes.push(
          `Options: ${opts.map((o) => `${o.const} = ${str(o.title) ?? o.const}`).join("; ")}.`,
        );
        schema = { type: "string", enum: opts.map((o) => o.const) };
      } else {
        if (typeof p.format === "string") notes.push(`Format: ${p.format}.`);
        schema =
          typeof p.maxLength === "number" && Number.isInteger(p.maxLength) && p.maxLength >= 0
            ? { type: "string", maxLength: p.maxLength }
            : { type: "string" };
      }
      break;
    }
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "number":
    case "integer": {
      const s: { type: "number" | "integer"; minimum?: number; maximum?: number } = {
        type: p.type,
      };
      if (typeof p.minimum === "number" && Number.isFinite(p.minimum)) s.minimum = p.minimum;
      if (typeof p.maximum === "number" && Number.isFinite(p.maximum)) s.maximum = p.maximum;
      schema = s as ParamSchema;
      break;
    }
    case "array": {
      const items = isObj(p.items) ? p.items : undefined;
      let values: string[] | undefined;
      if (items && Array.isArray(items.enum)) {
        values = items.enum.filter((x): x is string => typeof x === "string");
        if (values.length !== items.enum.length) values = undefined;
      } else if (items && Array.isArray(items.anyOf)) {
        const opts = items.anyOf.filter(
          (o): o is { const: string; title?: unknown } => isObj(o) && typeof o.const === "string",
        );
        if (opts.length === items.anyOf.length) {
          values = opts.map((o) => o.const);
          notes.push(
            `Options: ${opts.map((o) => `${o.const} = ${str(o.title) ?? o.const}`).join("; ")}.`,
          );
        }
      }
      if (!values || values.length === 0) return `${at} is an array without string options`;
      if (typeof p.minItems === "number" && p.minItems > 1) return `${at} uses minItems`;
      if (typeof p.maxItems === "number" && p.maxItems < values.length)
        return `${at} uses maxItems`;
      schema = { type: "string", enum: values };
      multiSelect = true;
      break;
    }
    default:
      return `${at} has unsupported type ${JSON.stringify(p.type)}`;
  }
  if (p.default !== undefined && !multiSelect && !("enum" in schema)) {
    notes.push(`Default: ${JSON.stringify(p.default)}.`);
  }
  return {
    key,
    label,
    ...(notes.length > 0 && { description: notes.join(" ") }),
    schema,
    ...(multiSelect && { multiSelect: true }),
    ...(required && { required: true }),
  };
}

/** elicitation → 交互表单；超出子集 → `{ unsupported: 原因 }`（英文）。 */
export function elicitationForm(
  req: ElicitationRequest,
): { form: InputForm } | { unsupported: string } {
  const title = req.message.trim().slice(0, MAX_TITLE) || "Input requested";
  let form: InputForm;
  if (req.mode === "url") {
    form = {
      title,
      url: req.url,
      fields: [
        {
          key: URL_COMPLETED_FIELD,
          label: { en: "I have completed this step", zh: "我已完成这一步" },
          schema: { type: "boolean" },
          required: true,
        },
      ],
    };
  } else {
    const s = req.requestedSchema;
    if (s.type !== "object" || !isObj(s.properties)) {
      return { unsupported: "requestedSchema is not an object schema with properties" };
    }
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const fields: Field[] = [];
    for (const [key, p] of Object.entries(s.properties)) {
      const f = fieldFor(key, p, required.has(key));
      if (typeof f === "string") return { unsupported: f };
      fields.push(f);
    }
    if (fields.length === 0) return { unsupported: "the form has no fields" };
    form = { title, fields };
  }
  const problems = validateInputForm(form);
  return problems.length > 0 ? { unsupported: problems.join("; ") } : { form };
}

/** 指纹：表单模式按 requestedSchema，URL 模式按地址的 origin + path（query 常带一次性 state）。 */
function fingerprint(req: ElicitationRequest): string {
  // 文案也计入：同一 schema 换了说明（问的是另一件事）要重新问用户
  const message = specHash(req.message);
  if (req.mode === "form") {
    return specHash({ mode: "form", schema: req.requestedSchema, message });
  }
  let target = req.url;
  try {
    const u = new URL(req.url);
    target = `${u.origin}${u.pathname}`;
  } catch {
    // 原样
  }
  return specHash({ mode: "url", target, message });
}

/** 用户答案 → 给远端的答复。 */
function responseFor(
  mode: ElicitationRequest["mode"],
  answer: FormAnswer | null,
): ElicitationResponse {
  if (answer === null) return { action: "cancel" };
  if (mode === "url") {
    return answer[URL_COMPLETED_FIELD] === true ? { action: "accept" } : { action: "decline" };
  }
  return { action: "accept", content: answer };
}

interface Answered {
  fp: string;
  response: ElicitationResponse;
}

/** 输入请求的 state（存 PG，续跑可能在另一副本）。 */
interface ElicitationState {
  elicitation: {
    /** 之前各轮的答复（按出现顺序）。 */
    answers: Answered[];
    /** 本轮问的那个 elicitation。 */
    pending: { fp: string; mode: ElicitationRequest["mode"] };
  };
}

function parseState(state: unknown): ElicitationState["elicitation"] | undefined {
  const e = isObj(state) ? state.elicitation : undefined;
  if (!isObj(e) || !Array.isArray(e.answers) || !isObj(e.pending)) return undefined;
  const p = e.pending;
  if (typeof p.fp !== "string" || (p.mode !== "form" && p.mode !== "url")) return undefined;
  const answers = e.answers.filter(
    (a): a is Answered => isObj(a) && typeof a.fp === "string" && isObj(a.response),
  );
  return { answers, pending: { fp: p.fp, mode: p.mode } };
}

/**
 * 一次应用工具调用里的 elicitation 处理（见文件头）。`onSuspend` 中止本次调用；`declineAll` 用于不能续跑的场景
 * （如 resources 工具），一律拒绝并附说明。
 */
export class ElicitationSession {
  /** 需要问用户的表单与 state（有值即本次执行按 `input_required` 处理）。 */
  pending: { form: InputForm; state: ElicitationState } | undefined;
  /** 附在工具结果后给模型的说明。 */
  readonly notes: string[] = [];
  private readonly answers: Answered[];
  private readonly used = new Set<number>();

  constructor(
    private readonly opts: {
      resume?: { state: unknown; answer: FormAnswer | null } | undefined;
      onSuspend: () => void;
      declineAll?: boolean;
    },
  ) {
    const prev = opts.resume ? parseState(opts.resume.state) : undefined;
    this.answers = prev
      ? [
          ...prev.answers,
          {
            fp: prev.pending.fp,
            response: responseFor(prev.pending.mode, opts.resume?.answer ?? null),
          },
        ]
      : [];
  }

  handle = async (req: ElicitationRequest): Promise<ElicitationResponse> => {
    if (this.opts.declineAll) {
      this.notes.push(unsupportedNote("this tool cannot pause for user input"));
      return { action: "decline" };
    }
    const fp = fingerprint(req);
    const i = this.answers.findIndex((a, idx) => a.fp === fp && !this.used.has(idx));
    if (i >= 0) {
      this.used.add(i);
      return (this.answers[i] as Answered).response;
    }
    const mapped = elicitationForm(req);
    if ("unsupported" in mapped) {
      this.notes.push(unsupportedNote(mapped.unsupported));
      return { action: "decline" };
    }
    if (!this.pending) {
      this.pending = {
        form: mapped.form,
        state: { elicitation: { answers: this.answers, pending: { fp, mode: req.mode } } },
      };
      this.opts.onSuspend();
    }
    // 调用已被中止：以错误结束（不让连接器等一个永不答复的 promise，如 -32042 路径里的 await），会话随后关闭
    throw new ElicitationSuspended();
  };
}
