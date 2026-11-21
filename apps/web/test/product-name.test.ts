// Issue #452: one product name, `platform.name`. The web's messages name the platform with
// `{product}`, which the request config fills from the public meta (the built-in name when it is
// unset or the kernel cannot be read), so no page says "Capybara" to a deployment named otherwise.

import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enCatalog from "../messages/en.json";
import zhCatalog from "../messages/zh.json";
import type { PlatformMeta } from "../src/lib/app-auth";

/** What the mocked meta read answers (set per test). */
let readMeta: () => Promise<PlatformMeta>;
vi.mock("../src/lib/server/register", () => ({}));
vi.mock("../src/lib/server/query", () => ({
  serverQueryClient: () => ({ fetchQuery: () => readMeta() }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: <F>(f: F) => f }));

const { default: requestConfig } = await import("../src/i18n/request");
const { icuLiteral, withProductName } = await import("../src/i18n/product");
const { attributionDefaults } = await import("../src/lib/admin");

type Catalog = typeof enCatalog;
const meta = (name: string | null): PlatformMeta => ({
  name,
  icons: { app: null, maskable: null, favicon: null },
});
const messagesFor = async (locale: "en" | "zh") =>
  (
    await (requestConfig as unknown as (p: { locale: string }) => Promise<{ messages: Catalog }>)({
      locale,
    })
  ).messages;

/** The dot paths of the messages that name the platform. */
function productKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return value.includes("{product}") ? [prefix] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) =>
    productKeys(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

describe("the request config fills {product}", () => {
  beforeEach(() => {
    readMeta = async () => meta(null);
  });

  it("with platform.name, in both languages", async () => {
    readMeta = async () => meta("Acme Agents");
    const en = await messagesFor("en");
    const zh = await messagesFor("zh");
    expect(en.bind.goHome).toBe("Go to Acme Agents");
    expect(zh.bind.goHome).toBe("进入 Acme Agents");
    expect(en.common.appName).toBe("Acme Agents");
    expect(JSON.stringify(en)).not.toContain("{product}");
    expect(JSON.stringify(zh)).not.toContain("{product}");
  });

  it("with the built-in name when platform.name is unset or the kernel cannot be read", async () => {
    expect((await messagesFor("en")).invite.goHome).toBe("Go to Capybara");
    readMeta = async () => {
      throw new Error("kernel starting");
    };
    expect((await messagesFor("zh")).common.appName).toBe("Capybara");
  });

  it("leaves the source catalog alone", () => {
    withProductName(enCatalog, "Acme Agents");
    expect(enCatalog.bind.goHome).toBe("Go to {product}");
  });
});

describe("a platform name is literal text in every message", () => {
  // ICU syntax a name may carry: an apostrophe, braces, a tag, a hash, and a `$&` pattern
  const NAME = "Acme's {Agents} <b>#1</b> $&";

  it("icuLiteral round-trips through the message format", () => {
    const t = createTranslator({ locale: "en", messages: { m: `Go to ${icuLiteral(NAME)}` } });
    expect(t("m")).toBe(`Go to ${NAME}`);
  });

  it.each([
    ["en", enCatalog],
    ["zh", zhCatalog],
  ] as const)("every %s message with {product} renders the name as written", (locale, catalog) => {
    const keys = productKeys(catalog);
    expect(keys.length).toBeGreaterThan(20);
    const messages = withProductName(catalog, NAME);
    const onError = vi.fn();
    const t = createTranslator({ locale, messages, onError });
    for (const key of keys) {
      // placeholder values for the other arguments these messages take
      const text = t.markup(
        key as never,
        {
          platform: "P",
          keys: "K",
          files: "F",
          tools: "T",
        } as never,
      );
      expect(text, key).toContain(NAME);
    }
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("the attribution defaults follow the platform name", () => {
  it("the built-in name links the upstream project; another name does not", () => {
    expect(attributionDefaults("Capybara")).toEqual({
      commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
      pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
      sessionUrl: false,
    });
    expect(attributionDefaults("Acme Agents")).toEqual({
      commit: "Co-Authored-By: Acme Agents <noreply@capybarahq.com>",
      pr: "🤖 Generated with Acme Agents",
      sessionUrl: false,
    });
  });
});
