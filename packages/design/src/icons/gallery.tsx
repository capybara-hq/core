import { Icon, type IconSize } from "./icon";
import { ICON_NAMES } from "./paths";

/** Every icon of the set with its name, in an 11-column grid (spec §6.12; catalog pages only). */
export function IconGallery({ size = 16 }: { size?: IconSize }) {
  return (
    <div className="cb-icon-gallery">
      {ICON_NAMES.map((n) => (
        <div key={n} className="cb-icon-gallery-cell">
          <Icon name={n} size={size} />
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}
