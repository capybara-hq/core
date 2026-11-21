import { DEFAULT_PLATFORM_NAME } from "../lib/platform-icons";

/** The placeholder a message names the platform with (issue #452: one name, `platform.name`). */
export const PRODUCT_PLACEHOLDER = "{product}";

/**
 * `text` as literal ICU MessageFormat text: a doubled apostrophe for each `'`, and each run of
 * `{ } < >` quoted, so a platform name never opens an argument or a rich-text tag. A `#` stays as
 * is: a message keeps `{product}` out of plural branches (pinned by the web's messages test).
 */
export function icuLiteral(text: string): string {
  return text.replace(/'/g, "''").replace(/[{}<>]+/g, (run) => `'${run}'`);
}

type Messages = { [key: string]: string | Messages };

function fill(messages: Messages, literal: string): Messages {
  const out: Messages = {};
  for (const [key, value] of Object.entries(messages)) {
    out[key] =
      typeof value === "string"
        ? value.includes(PRODUCT_PLACEHOLDER)
          ? value.replaceAll(PRODUCT_PLACEHOLDER, () => literal)
          : value
        : fill(value, literal);
  }
  return out;
}

/** The latest filled catalog per source catalog: one name per deployment, so this rarely misses. */
const filled = new WeakMap<object, { name: string; messages: Messages }>();

/**
 * The catalog with every `{product}` replaced by the platform name (`platform.name`, else
 * {@link DEFAULT_PLATFORM_NAME}), so no call site passes it and the server render, the client
 * and every page outside the workspace say the same name. `messages` is not changed.
 */
export function withProductName<M extends object>(messages: M, name: string | null | undefined): M {
  const product = name ?? DEFAULT_PLATFORM_NAME;
  const hit = filled.get(messages);
  if (hit?.name === product) return hit.messages as M;
  const result = fill(messages as unknown as Messages, icuLiteral(product));
  filled.set(messages, { name: product, messages: result });
  return result as unknown as M;
}
