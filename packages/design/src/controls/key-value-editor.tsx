import { useLayoutEffect, useRef } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { Button, IconButton } from "./button";
import { Input } from "./inputs";

/**
 * Rows of key / value inputs (spec §6.28): a record of scalars without form hints (headers,
 * labels). Column labels above the rows; each row has a remove button; "添加" / "Add" appends an
 * empty row and focuses its key. `maskValues` draws the values as password inputs (a secret
 * record: the values are typed, never shown).
 */
export function KeyValueEditor({
  label,
  value,
  onChange,
  disabled = false,
  keyLabel,
  valueLabel,
  maskValues = false,
}: {
  label: string;
  value: [string, string][];
  onChange(next: [string, string][]): void;
  disabled?: boolean;
  keyLabel: string;
  valueLabel: string;
  /** Values as password inputs (secret values). */
  maskValues?: boolean;
}) {
  const t = useDesignT();
  // Row identities that survive edits and removals (the keys themselves change as people type).
  const ids = useRef<number[]>([]);
  const nextId = useRef(0);
  while (ids.current.length < value.length) ids.current.push(nextId.current++);
  if (ids.current.length > value.length) ids.current.length = value.length;

  const rowsRef = useRef<HTMLUListElement>(null);
  const focusRow = useRef<number | null>(null);
  useLayoutEffect(() => {
    const i = focusRow.current;
    if (i === null) return;
    const input = rowsRef.current?.children[i]?.querySelector("input");
    if (!input) return;
    focusRow.current = null;
    input.focus();
  });

  const set = (i: number, part: 0 | 1, text: string) =>
    onChange(
      value.map((row, j) => (j === i ? (part === 0 ? [text, row[1]] : [row[0], text]) : row)),
    );

  const remove = (i: number) => {
    ids.current.splice(i, 1);
    onChange(value.filter((_, j) => j !== i));
  };

  const add = () => {
    focusRow.current = value.length;
    onChange([...value, ["", ""]]);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      className="cb-kv-editor"
      role="group"
      aria-label={label}
      data-part="kv-editor"
      data-disabled={disabled ? "true" : undefined}
    >
      {value.length > 0 ? (
        <>
          <div className="cb-kv-editor-head" data-part="kv-editor-head" aria-hidden="true">
            <span>{keyLabel}</span>
            <span>{valueLabel}</span>
          </div>
          <ul className="cb-kv-editor-rows" ref={rowsRef}>
            {value.map(([k, v], i) => (
              <li key={ids.current[i]} className="cb-kv-editor-row" data-part="kv-editor-row">
                <Input
                  density="dense"
                  aria-label={`${keyLabel} ${i + 1}`}
                  value={k}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(e) => set(i, 0, e.target.value)}
                />
                <Input
                  density="dense"
                  aria-label={`${valueLabel} ${i + 1}`}
                  {...(maskValues && { type: "password", autoComplete: "new-password" })}
                  value={v}
                  disabled={disabled}
                  onChange={(e) => set(i, 1, e.target.value)}
                />
                <IconButton
                  density="dense"
                  label={t("keyValue.remove").replace(
                    "{name}",
                    k.trim() || t("keyValue.row").replace("{n}", String(i + 1)),
                  )}
                  icon={<Icon name="trash-2" size={14} />}
                  disabled={disabled}
                  onClick={() => remove(i)}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="cb-kv-editor-foot">
        <Button density="dense" disabled={disabled} part="kv-editor-add" onClick={add}>
          <Icon name="plus" size={14} />
          {t("keyValue.add")}
        </Button>
      </div>
    </div>
  );
}
