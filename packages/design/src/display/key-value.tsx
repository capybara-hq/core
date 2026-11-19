import type { ReactNode } from "react";

export type KeyValueProps = {
  /** `mono`: the value in the UI's mono face (a tool key) where the variant draws values in prose. */
  rows: { k: ReactNode; v: ReactNode; mono?: boolean }[];
  /** 键列宽，默认 8ch（spec §5.2）；`columns={2}` 时不用（键取自然宽度）。 */
  keyWidth?: `${number}ch`;
  /**
   * `2`: the pairs flow into two columns (an overview card's figures, an extension's facts): each
   * key `space.3` from its value, the second column `space.7` (32 px) from the first (spec §6.5).
   */
  columns?: 1 | 2;
  /**
   * `facts`: an open item's facts in a list-detail region (spec §6.47): `small` type, the keys in
   * the mono face (`muted`), the values in the prose face unless a row is `mono`.
   */
  variant?: "facts";
};

/** 属性列表：键定宽 muted，值单行省略（spec §5.2 Inspector）。 */
export function KeyValue({ rows, keyWidth = "8ch", columns = 1, variant }: KeyValueProps) {
  const grid = columns === 2;
  return (
    <dl
      className="cb-kv"
      data-part="key-value"
      data-columns={grid ? "2" : undefined}
      data-variant={variant}
    >
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行顺序由调用方给定
        <div key={i} className="cb-kv-row" data-part="key-value-row">
          <dt
            className="cb-kv-key"
            data-part={variant === "facts" ? "fact-key" : undefined}
            style={grid ? undefined : { width: keyWidth }}
          >
            {r.k}
          </dt>
          <dd
            className="cb-kv-value"
            data-mono={r.mono ? "true" : undefined}
            title={typeof r.v === "string" || typeof r.v === "number" ? String(r.v) : undefined}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
