import { type ChangeEvent, type KeyboardEvent, useState } from "react";

/**
 * 数值框的输入草稿：输入过程中不夹取（允许先输入「1」再输入「15」），
 * 在失焦或回车时按 `normalize`（夹取到 [min, max]、按步长小数位取整）提交；
 * 空或非法文本在失焦时恢复为上一次的有效值。
 * 输入中的值若已合法且在范围内，会按 `normalize` 取整后即时调用 `onCommit`，表单不必等失焦才拿到新值。
 */
export function useNumberDraft({
  value,
  min,
  max,
  normalize,
  onCommit,
}: {
  value: number | undefined;
  min: number | undefined;
  max: number | undefined;
  normalize(n: number): number;
  onCommit(n: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [seen, setSeen] = useState(value);

  const parse = (text: string): number | undefined => {
    if (text.trim() === "") return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  };
  // 外部改了值（如「恢复默认」、步进按钮）且与草稿不一致时，丢弃草稿以显示新值
  if (value !== seen) {
    setSeen(value);
    if (draft !== null && parse(draft) !== value) setDraft(null);
  }
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);

  const commit = () => {
    if (draft === null) return;
    const n = parse(draft);
    setDraft(null);
    if (n === undefined) return;
    const next = normalize(n);
    if (next !== value) onCommit(next);
  };

  return {
    value: draft ?? (value === undefined ? "" : String(value)),
    onChange(e: ChangeEvent<HTMLInputElement>) {
      const text = e.target.value;
      setDraft(text);
      const n = parse(text);
      if (n === undefined || !inRange(n)) return;
      const next = normalize(n);
      if (next !== value) onCommit(next);
    },
    onBlur() {
      commit();
    },
    onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Enter") commit();
    },
  };
}
