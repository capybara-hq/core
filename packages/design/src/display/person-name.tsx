import { Avatar } from "./avatar";

/** A person as the design components take one: the name and the avatar route (null: the initial). */
export type PersonLike = { name: string; avatarUrl: string | null };

/**
 * PersonName (spec §6.50): a person as a circle avatar and the name on one line that never wraps;
 * the name is ellipsized (full text in `title`), the optional `secondary` follows it in `muted`.
 * `avatarUrl` null draws the initial of `name`.
 */
export function PersonName({
  name,
  avatarUrl,
  size,
  secondary,
}: {
  name: string;
  avatarUrl: string | null;
  size: 16 | 24;
  secondary?: string;
}) {
  return (
    <span className="cb-person-name" data-part="person-name" data-size={String(size)}>
      <Avatar
        shape="circle"
        size={size}
        name={name}
        value={avatarUrl ? { kind: "image", src: avatarUrl } : null}
      />
      <span className="cb-person-name-text" data-part="person-name-text" title={name}>
        {name}
      </span>
      {secondary ? (
        <span className="cb-person-name-secondary" data-part="person-name-secondary">
          {secondary}
        </span>
      ) : null}
    </span>
  );
}
