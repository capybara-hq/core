import { type Density, useDensity } from "./density";

/**
 * A toggle for one filter value (spec §6.15): selected = the `selected` ground + an `ink` border,
 * never the accent. The accessible name is the label and the count.
 */
export function FilterChip({
  label,
  count,
  selected,
  onSelect,
  density,
}: {
  label: string;
  count?: number | string;
  selected: boolean;
  onSelect: () => void;
  density?: Density;
}) {
  const step = useDensity(density);
  return (
    <button
      type="button"
      className="cb-chip"
      data-part="filter-chip"
      data-density={step}
      aria-pressed={selected}
      aria-label={count === undefined ? undefined : `${label} ${count}`}
      onClick={onSelect}
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span className="cb-chip-count" data-part="filter-chip-count">
          {count}
        </span>
      ) : null}
    </button>
  );
}
