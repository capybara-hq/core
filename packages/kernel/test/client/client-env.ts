import { createHash } from "node:crypto";
import { request } from "node:http";
import { expect } from "vitest";
import { ExtensionHost } from "../../src/extensions/host.js";
import { importPlugin, type OrgEnv } from "../catalog/org-env.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, waitFor } from "../helpers/runs.js";

/**
 * Shared setup of the client delivery and shell tests (client extensions spec §9): plugin packages
 * with client code built in the test (any slots, a stylesheet, an svg asset), sessions whose cookie
 * a raw HTTP request can carry, and a raw GET that sends the path byte for byte (no URL
 * normalisation: `..`, `%2F` and backslashes reach the kernel as written).
 */

const enc = (s: string) => new TextEncoder().encode(s);

export const sha384 = (data: Uint8Array) =>
  `sha384-${createHash("sha384").update(data).digest("base64")}`;

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** One component of a test plugin. */
export interface TestComponent {
  id: string;
  slot: string;
}

/** A plugin with client code: a component per entry of `components`, plus a stylesheet and an svg. */
export async function clientPlugin(o: {
  name: string;
  version?: string;
  components: TestComponent[];
  /** Adds `styles/a.css` (which uses the svg) and `assets/logo.svg`. */
  decorated?: boolean;
}): Promise<Uint8Array> {
  const version = o.version ?? "1.0.0";
  const files: Record<string, Uint8Array> = {};
  const integrity: Record<string, string> = {};
  const add = (path: string, data: Uint8Array) => {
    files[`dist/client/${path}`] = data;
    integrity[`./dist/client/${path}`] = sha384(data);
  };
  add("client.mjs", enc(`export default { name: ${JSON.stringify(o.name)}, v: "${version}" };\n`));
  const styles: string[] = [];
  const assets: string[] = [];
  if (o.decorated) {
    add("assets/logo.svg", enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'));
    add(
      "styles/a.css",
      enc(
        '@layer extensions {\n[data-cap-part~="shell"] { background: url(../assets/logo.svg); }\n}\n',
      ),
    );
    styles.push("./dist/client/styles/a.css");
    assets.push("./dist/client/assets/logo.svg");
  }
  const ui = o.components.map((c) => ({
    id: c.id,
    title: { zh: c.id, en: c.id },
    slot: c.slot,
    kind: "component",
  }));
  const permissions = { client: true, ui: { components: o.components.map((c) => c.id) } };
  const base = { name: o.name, version, sdk: "^0.1.0-rc.0", provides: [], permissions, ui };
  return pluginTgz({
    manifest: { name: o.name, version },
    files,
    extension: {
      manifest: { permissions, ui },
      section: {
        client: {
          entry: "./dist/client/client.mjs",
          ...(styles.length > 0 && { styles }),
          ...(assets.length > 0 && { assets }),
          integrity,
          apiVersion: 1,
        },
      },
      entry: [
        'import { defineExtension } from "@capybara-hq/plugin-sdk";',
        `export default defineExtension({ ...${JSON.stringify(base)}, setup() {} });`,
      ].join("\n"),
    },
  });
}

/** Imports a client plugin as the super admin and waits until this replica runs `version`. */
export async function importClientPlugin(
  env: OrgEnv,
  bytes: Uint8Array,
  name: string,
  version = "1.0.0",
): Promise<string> {
  const itemId = await importPlugin(env, bytes);
  await waitFor(
    async () => env.k.app.get(ExtensionHost).current(name)?.version === version,
    15_000,
    `${name} ${version} loaded`,
  );
  // the replica's status row is what the access check reads
  await waitFor(
    async () =>
      (await env.db
        .selectFrom("extension_replica_status")
        .select("plugin")
        .where("plugin", "=", name)
        .where("sha256", "=", sha256(bytes))
        .where("state", "=", "loaded")
        .executeTakeFirst()) !== undefined,
    15_000,
    `${name} ${version} reported loaded`,
  );
  return itemId;
}

/** A signed-in person: the inject request function and the cookie header for raw requests. */
export interface Person {
  req: Req;
  cookie(): string;
}

export async function signIn(env: OrgEnv, login: string): Promise<Person> {
  const jar = cookieJar();
  const req = asUser(env.k.http, jar);
  const r = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(r.statusCode, r.body).toBe(200);
  return { req, cookie: () => jar.header() ?? "" };
}

/** A raw response: status, lower-case headers and body bytes. */
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** GET `path` over real HTTP on the kernel's port, the path sent exactly as given. */
export function rawGet(env: OrgEnv, path: string, cookie?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: "127.0.0.1",
        port: env.k.port,
        method: "GET",
        path,
        headers: cookie ? { cookie } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/** The error code of a raw response's JSON envelope. */
export const rawCode = (r: RawResponse): string | undefined => {
  try {
    return (JSON.parse(r.body.toString("utf8")) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

/** Writes the kill switch through the admin route (the super admin's session). */
export async function setKillSwitch(
  root: Req,
  value: { enabled?: boolean; disabled?: string[] },
): Promise<void> {
  const r = await root({
    method: "PUT",
    url: "/api/v1/admin/settings",
    payload: { clientExtensions: value },
  });
  expect(r.statusCode, r.body).toBe(200);
}
