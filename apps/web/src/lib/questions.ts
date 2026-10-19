import { apiFetch } from "./api";
import type { FormAnswer, InputForm } from "./conversations";

/**
 * 内核输入请求 API（`packages/kernel/src/tools/questions.controller.ts`）与 `InputForm` 的纯函数
 * （与 plugin-sdk `validateAnswer` 同一套规则的子集；最终以内核校验为准）。
 */

export type QuestionStatus = "pending" | "answered" | "expired" | "cancelled";

export interface Question {
  id: string;
  conversationId: string;
  toolKey: string;
  form: InputForm;
  status: QuestionStatus;
  answer: FormAnswer | null;
  answeredBy: string | null;
  expiresAt: string;
}

type FormField = InputForm["fields"][number];
type FormText = InputForm["title"];

/** 表单文案：纯字符串原样；`{ zh, en }` 取当前语言，缺失时回退 en。 */
export function formText(t: FormText | undefined, locale: string): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return (t as Record<string, string | undefined>)[locale] || t.en;
}

/** 「其他」选项在草稿里的取值（不会与枚举值冲突：枚举值来自声明，界面只用这个哨兵）。 */
export const OTHER = "\u0000other";

export type DraftValue = string | number | boolean | string[] | undefined;

/** 表单草稿：每个字段的取值 + `allowOther` 字段的「其他」文本。 */
export interface FormDraft {
  values: Record<string, DraftValue>;
  other: Record<string, string>;
}

export type FieldKind = "enum" | "multi" | "boolean" | "number" | "string";

type Schema = { type?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown };

/** 字段的控件类别（子集之外的 schema 按文本处理）。 */
export function fieldKind(f: FormField): FieldKind {
  const s = f.schema as Schema;
  if (s.type === "string" && Array.isArray(s.enum)) return f.multiSelect ? "multi" : "enum";
  if (s.type === "boolean") return "boolean";
  if (s.type === "number" || s.type === "integer") return "number";
  return "string";
}

export const enumValues = (f: FormField): string[] => {
  const e = (f.schema as Schema).enum;
  return Array.isArray(e) ? e.filter((v): v is string => typeof v === "string") : [];
};

/** 初始草稿：布尔为 false，多选为空数组，其余未填。 */
export function initialDraft(form: InputForm): FormDraft {
  const values: Record<string, DraftValue> = {};
  for (const f of form.fields) {
    const kind = fieldKind(f);
    if (kind === "boolean") values[f.key] = false;
    else if (kind === "multi") values[f.key] = [];
  }
  return { values, other: {} };
}

/**
 * 由草稿生成答案：未填的字段不出现；「其他」换成用户填写的文本。
 * `missing` 为必填却没填（或选了「其他」但没写文本）的字段 key。
 */
export function buildAnswer(
  form: InputForm,
  draft: FormDraft,
): { answer: FormAnswer; missing: string[] } {
  const answer: FormAnswer = {};
  const missing: string[] = [];
  for (const f of form.fields) {
    const v = draft.values[f.key];
    const other = (draft.other[f.key] ?? "").trim();
    let out: FormAnswer[string] | undefined;
    let incomplete = false;
    switch (fieldKind(f)) {
      case "multi": {
        const picked = Array.isArray(v) ? v : [];
        const hasOther = picked.includes(OTHER);
        if (hasOther && other === "") incomplete = true;
        const items = picked.filter((x) => x !== OTHER);
        if (hasOther && other !== "") items.push(other);
        out = items;
        if (f.required && items.length === 0) incomplete = true;
        break;
      }
      case "enum":
        if (v === OTHER) {
          if (other === "") incomplete = true;
          else out = other;
        } else if (typeof v === "string" && v !== "") out = v;
        break;
      case "boolean":
        out = v === true;
        break;
      case "number":
        if (typeof v === "number" && Number.isFinite(v)) out = v;
        break;
      default:
        if (typeof v === "string" && v.trim() !== "") out = v;
    }
    if (out !== undefined) answer[f.key] = out;
    if (incomplete || (f.required && out === undefined)) missing.push(f.key);
  }
  return { answer, missing };
}

/** 答案的一行展示（多选用「、」/「, 」连接，布尔用本地化的是 / 否）。 */
export function answerText(
  v: FormAnswer[string] | undefined,
  yesNo: { yes: string; no: string },
  separator: string,
): string {
  if (v === undefined) return "—";
  if (Array.isArray(v)) return v.length === 0 ? "—" : v.join(separator);
  if (typeof v === "boolean") return v ? yesNo.yes : yesNo.no;
  return String(v);
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/questions`;

export const getQuestion = (orgId: string, id: string) =>
  apiFetch<{ question: Question }>(`${base(orgId)}/${encodeURIComponent(id)}`);

export const answerQuestion = (orgId: string, id: string, answer: FormAnswer) =>
  apiFetch<{ question: Question }>(`${base(orgId)}/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
