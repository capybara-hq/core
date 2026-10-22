import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** 假 registry 上的一个包版本。 */
export interface FakeNpmPackage {
  /** npm 包名（可带 scope）。 */
  name: string;
  version: string;
  tgz: Uint8Array;
  /** 元数据里的 `dist.integrity`；不给 = 按 tgz 算出的 sha512（可故意给错）。 */
  integrity?: string;
  /** 元数据里的 `dist.tarball`；不给 = 本服务上的地址（给别的源测「不同源」）。 */
  tarballUrl?: string;
  /** tarball 地址先 302 到真实地址（测「不跟随重定向」）。 */
  redirectTarball?: boolean;
  /** 打上的 dist-tag（如 `latest`）；同名包没有任何版本带 `latest` 时取最后一个版本。 */
  tags?: string[];
}

export interface FakeNpmRegistry {
  /** registry 基址 `http://127.0.0.1:<port>`。 */
  url: string;
  /** 收到的请求路径（含查询串），按到达顺序。 */
  requests: string[];
  /** 收到的 `authorization` 请求头（没有为 undefined），与 {@link requests} 一一对应。 */
  authorizations: (string | undefined)[];
  stop(): Promise<void>;
}

const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const tarballName = (p: FakeNpmPackage) => `${p.name.replace(/^@[^/]+\//, "")}-${p.version}.tgz`;

/**
 * 假 npm registry：`GET /<包名>`（scope 包按 npm 的写法 `@scope%2fname`，也接受未编码的 `/`）返回 packument
 * （`versions[v].dist.{tarball, integrity}` 与 `dist-tags`），`GET /<包名>/-/<文件>.tgz` 返回 tarball。
 * 未知包 404。
 */
export async function startFakeNpmRegistry(opts: {
  packages: FakeNpmPackage[];
}): Promise<FakeNpmRegistry> {
  const requests: string[] = [];
  const authorizations: (string | undefined)[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    authorizations.push(req.headers.authorization);
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const decoded = decodeURIComponent(path.split("?")[0] as string).slice(1);
    const tarAt = decoded.indexOf("/-/");
    if (tarAt >= 0) {
      const name = decoded.slice(0, tarAt);
      const rest = decoded.slice(tarAt + 3);
      const redirect = rest.startsWith("r/");
      const file = redirect ? rest.slice(2) : rest;
      const p = opts.packages.find((x) => x.name === name && tarballName(x) === file);
      if (!p) {
        res.writeHead(404).end();
        return;
      }
      if (redirect) {
        res.writeHead(302, { location: `${base}/${name}/-/${file}` }).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(p.tgz.byteLength),
        })
        .end(Buffer.from(p.tgz));
      return;
    }
    const versions = opts.packages.filter((x) => x.name === decoded);
    if (versions.length === 0) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
      return;
    }
    const distTags: Record<string, string> = {};
    for (const v of versions) for (const t of v.tags ?? []) distTags[t] = v.version;
    distTags.latest ??= (versions.at(-1) as FakeNpmPackage).version;
    const doc = {
      name: decoded,
      "dist-tags": distTags,
      versions: Object.fromEntries(
        versions.map((v) => [
          v.version,
          {
            name: v.name,
            version: v.version,
            dist: {
              tarball:
                v.tarballUrl ??
                `${base}/${v.name}/-/${v.redirectTarball ? "r/" : ""}${tarballName(v)}`,
              integrity: v.integrity ?? sri(v.tgz),
            },
          },
        ]),
      ),
    };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    authorizations,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
