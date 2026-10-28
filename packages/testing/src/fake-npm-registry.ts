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
  /**
   * The body of `GET /-/npm/v1/attestations/<name>@<version>` (e.g. from
   * {@link npmProvenanceAttestations}); not given = 404, as for a package published without provenance.
   */
  attestations?: unknown;
}

export interface FakeNpmRegistry {
  /** registry 基址 `http://127.0.0.1:<port>`。 */
  url: string;
  /** 收到的请求路径（含查询串），按到达顺序。 */
  requests: string[];
  /** 收到的 `authorization` 请求头（没有为 undefined），与 {@link requests} 一一对应。 */
  authorizations: (string | undefined)[];
  /** The `accept` request header of each request (undefined when absent), as {@link requests}. */
  accepts: (string | undefined)[];
  stop(): Promise<void>;
}

const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * An attestations answer in the shape npm serves (`{ attestations: [...] }`): the npm publish
 * attestation and the SLSA v1 provenance, each a sigstore bundle with a DSSE envelope whose payload
 * is a base64 in-toto statement about `pkg:npm/<name>@<version>` (subject digest = the tgz's sha512,
 * or `subjectSha512` to make it about another tarball). The signatures are placeholders (the kernel
 * does not verify them). `predicate` replaces the SLSA predicate (to test missing fields).
 */
export function npmProvenanceAttestations(o: {
  name: string;
  version: string;
  tgz: Uint8Array;
  repository: string;
  commit: string;
  workflow?: string;
  ref?: string;
  subjectSha512?: string;
  predicate?: unknown;
}): unknown {
  const purl = `pkg:npm/${o.name.replace(/^@/, "%40")}@${o.version}`;
  const subject = [
    {
      name: purl,
      digest: { sha512: o.subjectSha512 ?? createHash("sha512").update(o.tgz).digest("hex") },
    },
  ];
  const ref = o.ref ?? "refs/heads/main";
  const predicate = o.predicate ?? {
    buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: {
        workflow: {
          ref,
          repository: o.repository,
          path: o.workflow ?? ".github/workflows/release.yml",
        },
      },
      internalParameters: {
        github: { event_name: "push", repository_id: "1", repository_owner_id: "2" },
      },
      resolvedDependencies: [
        { uri: `git+${o.repository}@${ref}`, digest: { gitCommit: o.commit } },
      ],
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: { invocationId: `${o.repository}/actions/runs/1/attempts/1` },
    },
  };
  const bundle = (predicateType: string, pred: unknown) => ({
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
    verificationMaterial: { tlogEntries: [], x509CertificateChain: { certificates: [] } },
    dsseEnvelope: {
      payload: Buffer.from(
        JSON.stringify({
          _type: "https://in-toto.io/Statement/v1",
          subject,
          predicateType,
          predicate: pred,
        }),
      ).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "MEUCIQ-placeholder", keyid: "" }],
    },
  });
  const publish = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
  return {
    attestations: [
      {
        predicateType: publish,
        bundle: bundle(publish, {
          name: o.name,
          version: o.version,
          registry: "https://registry.npmjs.org",
        }),
      },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: bundle("https://slsa.dev/provenance/v1", predicate),
      },
    ],
  };
}

const tarballName = (p: FakeNpmPackage) => `${p.name.replace(/^@[^/]+\//, "")}-${p.version}.tgz`;

/**
 * A fake npm registry: `GET /<name>` (a scoped package written as npm does, `@scope%2fname`; an
 * unencoded `/` is accepted too) returns the packument (`versions[v].dist.{tarball, integrity}` and
 * `dist-tags`), `GET /<name>/-/<file>.tgz` returns the tarball, and
 * `GET /-/npm/v1/attestations/<name>@<version>` returns that version's `attestations` (404 when it
 * has none). Unknown packages are 404.
 */
export async function startFakeNpmRegistry(opts: {
  packages: FakeNpmPackage[];
}): Promise<FakeNpmRegistry> {
  const requests: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const accepts: (string | undefined)[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    authorizations.push(req.headers.authorization);
    accepts.push(req.headers.accept);
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const decoded = decodeURIComponent(path.split("?")[0] as string).slice(1);
    const ATT = "-/npm/v1/attestations/";
    if (decoded.startsWith(ATT)) {
      const spec = decoded.slice(ATT.length);
      const at = spec.lastIndexOf("@");
      const p = opts.packages.find(
        (x) => at > 0 && x.name === spec.slice(0, at) && x.version === spec.slice(at + 1),
      );
      if (p?.attestations === undefined) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(p.attestations));
      return;
    }
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
    accepts,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
