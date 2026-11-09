import { preload } from "react-dom";
import type { ClientExtensionsResponse } from "../../lib/client-extensions";
import type { ClientHostInfo } from "../../lib/server/client-host";

/** Where the generated shims are served (`apps/web/scripts/gen-client-host.mjs`). */
export const CLIENT_HOST_PATH = "/_capybara/client-host";

/** The host shims of a web build, by the specifier a client bundle imports (spec §9.4). */
export function hostImports(host: ClientHostInfo): {
  imports: Record<string, string>;
  integrity: Record<string, string>;
} {
  const base = `${CLIENT_HOST_PATH}/${encodeURIComponent(host.build)}`;
  const files = {
    react: "react.mjs",
    "react/jsx-runtime": "react-jsx-runtime.mjs",
    "react-dom": "react-dom.mjs",
    "@capybara-hq/plugin-client": "plugin-client.mjs",
  } as const;
  const imports: Record<string, string> = {};
  const integrity: Record<string, string> = {};
  for (const [specifier, file] of Object.entries(files)) {
    imports[specifier] = `${base}/${file}`;
    integrity[`${base}/${file}`] = host.integrity[file];
  }
  return { imports, integrity };
}

/** JSON for an inline script: `<` escaped, so no `</script>` or `<!--` can appear in it. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * The document's client code, rendered by the workspace layout at the top of the body (client
 * extensions spec §9.4, §11), unless safe mode is on (then nothing at all):
 * - the import map (with the request's CSP nonce): the host shims for the externals, and the
 *   integrity of every entry (what the kernel recorded) and of every shim (what the generator
 *   wrote), so every module of the graph is verified;
 * - a preload per entry, fetched and verified in parallel with the page. A classic `preload`
 *   (`as: "script"`, `crossOrigin: "anonymous"`, the module fetch's mode and credentials), not
 *   `modulepreload`: React hoists every preload into `<head>`, before the import map, and a
 *   module preload that finishes before the map is parsed caches the module with its bare imports
 *   unresolved (Chromium), so the later `import()` would fail; the classic preload only warms the
 *   fetch, and `ClientHost`'s `import()` reuses it;
 * - each plugin stylesheet with `precedence="extensions"` and its integrity (none in the admin
 *   scope: the console takes no plugin CSS, spec §9.6).
 * `host` names the shims of this web build; without it no entry is loaded.
 */
export function ClientExtensionsHead({
  set,
  nonce,
  safe,
  host,
  scope,
}: {
  set: ClientExtensionsResponse | null;
  nonce: string;
  safe: boolean;
  host: ClientHostInfo | null;
  scope: "org" | "admin";
}) {
  if (safe || set === null || !set.enabled || set.items.length === 0) return null;
  const shims = host === null ? null : hostImports(host);
  const entries = host === null ? [] : set.items.flatMap((i) => (i.entry ? [i.entry] : []));
  const styles = scope === "admin" ? [] : set.items.flatMap((i) => i.styles);
  for (const e of entries) {
    preload(e.url, { as: "script", crossOrigin: "anonymous", integrity: e.integrity });
  }
  return (
    <>
      {entries.length > 0 && shims !== null ? (
        <script type="importmap" nonce={nonce === "" ? undefined : nonce}>
          {scriptJson({
            imports: shims.imports,
            integrity: {
              ...shims.integrity,
              ...Object.fromEntries(entries.map((e) => [e.url, e.integrity])),
            },
          })}
        </script>
      ) : null}
      {styles.map((s) => (
        <link
          key={s.url}
          rel="stylesheet"
          href={s.url}
          precedence="extensions"
          integrity={s.integrity}
        />
      ))}
    </>
  );
}
