import { Avatar } from "./avatar";

/**
 * A person as the design components take one: the name and the avatar route (null: the initial).
 * `initialFrom` is the name the initial is drawn from when the label is not the person's name (the
 * viewer shown as "You" keeps their own initial).
 */
export type PersonLike = { name: string; avatarUrl: string | null; initialFrom?: string };

/**
 * PersonName (spec §6.50): a person as a circle avatar and the name on one line that never wraps;
 * the name is ellipsized (full text in `title`), the optional `secondary` follows it in `muted`.
 * `avatarUrl` null draws the initial of `initialFrom`, else of `name`.
 */
export function PersonName({
  name,
  avatarUrl,
  size,
  secondary,
  initialFrom,
}: {
  name: string;
  avatarUrl: string | null;
  size: 16 | 24;
  secondary?: string;
  /** The person's own name when `name` is a replacement word ("You"): the initial comes from it. */
  initialFrom?: string | undefined;
}) {
  return (
    <span className="cb-person-name" data-part="person-name" data-size={String(size)}>
      <Avatar
        shape="circle"
        size={size}
        name={initialFrom ?? name}
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
