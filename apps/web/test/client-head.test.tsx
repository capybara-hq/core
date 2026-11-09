// Client extensions spec §9.4, §10.1, §11: the workspace layout's head of the document's client
// code: the import map with the request's nonce and the entries' integrity, a preload per entry,
// the plugin stylesheets; nothing in safe mode, no stylesheet in the admin scope.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientExtensionsHead } from "../src/components/client-ext/ClientExtensionsHead";
import type { ClientExtensionsResponse } from "../src/lib/client-extensions";

const BUILD = "a".repeat(64);
const BASE = `/api/v1/client/fake-client/${BUILD}`;
const SET: ClientExtensionsResponse = {
  enabled: true,
  apiVersion: 1,
  items: [
    {
      plugin: "fake-client",
      build: BUILD,
      entry: { url: `${BASE}/client.mjs`, integrity: "sha384-entry" },
      styles: [{ url: `${BASE}/styles/hud.css`, integrity: "sha384-style" }],
      components: [{ id: "hud", slot: "conversation.properties.section" }],
    },
  ],
};

const HOST = {
  build: "0.1.0-abcdef012345",
  integrity: {
    "react.mjs": "sha384-r",
    "react-jsx-runtime.mjs": "sha384-j",
    "react-dom.mjs": "sha384-d",
    "plugin-client.mjs": "sha384-p",
  },
};

const render = (props: Partial<Parameters<typeof ClientExtensionsHead>[0]> = {}) =>
  renderToString(
    <ClientExtensionsHead
      set={SET}
      nonce="n0nce=="
      safe={false}
      host={HOST}
      scope="org"
      {...props}
    />,
  );

const importMapOf = (html: string) => {
  const m = /<script type="importmap" nonce="([^"]*)">([\s\S]*?)<\/script>/.exec(html);
  return m ? { nonce: m[1], map: JSON.parse(m[2] ?? "") } : null;
};

describe("ClientExtensionsHead", () => {
  it("the head renders the import map with the nonce and integrity", () => {
    const html = render();
    const im = importMapOf(html);
    expect(im?.nonce).toBe("n0nce==");
    const host = "/_capybara/client-host/0.1.0-abcdef012345";
    expect(im?.map).toEqual({
      imports: {
        react: `${host}/react.mjs`,
        "react/jsx-runtime": `${host}/react-jsx-runtime.mjs`,
        "react-dom": `${host}/react-dom.mjs`,
        "@capybara-hq/plugin-client": `${host}/plugin-client.mjs`,
      },
      // every module of the graph: the shims (generator) and the entries (kernel)
      integrity: {
        [`${host}/react.mjs`]: "sha384-r",
        [`${host}/react-jsx-runtime.mjs`]: "sha384-j",
        [`${host}/react-dom.mjs`]: "sha384-d",
        [`${host}/plugin-client.mjs`]: "sha384-p",
        [`${BASE}/client.mjs`]: "sha384-entry",
      },
    });
    // the entry is fetched and verified in parallel with the page
    const preload = /<link rel="preload"[^>]*>/.exec(html)?.[0] ?? "";
    expect(preload).toContain(`href="${BASE}/client.mjs"`);
    expect(preload).toContain('as="script"');
    // the module fetch's mode and credentials (an empty value is anonymous), so import() reuses it
    expect(preload).toContain('crossorigin=""');
    expect(preload).toContain('integrity="sha384-entry"');
    // the stylesheet, ordered after the theme's by its precedence, with its integrity
    const sheet = /<link rel="stylesheet"[^>]*>/.exec(html)?.[0] ?? "";
    expect(sheet).toContain(`href="${BASE}/styles/hud.css"`);
    expect(sheet).toContain('data-precedence="extensions"');
    expect(sheet).toContain('integrity="sha384-style"');
  });

  it("the import map cannot close its script", () => {
    const evil: ClientExtensionsResponse = {
      ...SET,
      items: [
        {
          ...(SET.items[0] as ClientExtensionsResponse["items"][number]),
          entry: { url: `${BASE}/client.mjs`, integrity: "</script><script>x()</script>" },
        },
      ],
    };
    const html = render({ set: evil });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(importMapOf(html)?.map.integrity[`${BASE}/client.mjs`]).toBe(
      "</script><script>x()</script>",
    );
  });

  it("safe mode renders no import map, preload or stylesheet", () => {
    expect(render({ safe: true })).toBe("");
  });

  it("admin scope renders no stylesheet", () => {
    const html = render({ scope: "admin" });
    expect(importMapOf(html)).not.toBeNull();
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("an empty set renders nothing", () => {
    expect(render({ set: { enabled: true, apiVersion: 1, items: [] } })).toBe("");
    expect(render({ set: { enabled: false, apiVersion: 1, items: [] } })).toBe("");
    expect(render({ set: null })).toBe("");
  });

  it("without the host shims no entry is loaded; stylesheets still apply", () => {
    const html = render({ host: null });
    expect(importMapOf(html)).toBeNull();
    expect(html).not.toContain('rel="preload"');
    expect(html).toContain('rel="stylesheet"');
  });
});
