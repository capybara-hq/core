import type { ReactNode } from "react";

export type KeyValueProps = {
  rows: { k: ReactNode; v: ReactNode }[];
  /** 键列宽，默认 8ch（spec §5.2）。 */
  keyWidth?: `${number}ch`;
};

/** 属性列表：键定宽 muted，值单行省略（spec §5.2 Inspector）。 */
export function KeyValue({ rows, keyWidth = "8ch" }: KeyValueProps) {
  return (
    <dl className="cb-kv">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行顺序由调用方给定
        <div key={i} className="cb-kv-row">
          <dt className="cb-kv-key" style={{ width: keyWidth }}>
            {r.k}
          </dt>
          <dd
            className="cb-kv-value"
            title={typeof r.v === "string" || typeof r.v === "number" ? String(r.v) : undefined}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
