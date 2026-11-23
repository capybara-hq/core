import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Finding, isParseError, type Node, parseFile } from "./source.js";

/**
 * The sandbox image pin of `capybara-device` (`packages/device/src/exec/docker-image.ts`): the
 * docker-mode device runs the image only by these digests and attests a container against them at
 * bind. The offline check (every PR, in `pnpm check`) verifies the pin's shape; `--network` (CI on
 * PRs that touch the pin or this check, and release.yml before `@capybara-hq/device` is published)
 * verifies that the digests exist in the registry and agree with each other and the version tag.
 * `pnpm gen:device-image-pin <version>` writes the pin from the registry.
 */
export const DEVICE_IMAGE_PIN_FILE = "packages/device/src/exec/docker-image.ts";
/** The device sources, scanned for an image reference by tag. */
export const DEVICE_SOURCE_DIR = "packages/device/src";
export const OFFICIAL_SANDBOX_REPOSITORY = "ghcr.io/capybara-hq/capybara-sandbox";
export const PIN_PLATFORMS = ["amd64", "arm64"] as const;
export type PinPlatform = (typeof PIN_PLATFORMS)[number];

export interface DeviceImagePin {
  repository: string;
  version: string;
  index: string;
  platforms: Record<PinPlatform, { manifest: string; config: string }>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PIN_NAME = "SANDBOX_IMAGE_PIN";

type Literal = string | { [key: string]: Literal };

/** A plain object literal of string values, or a reason it is not one. */
function literalOf(n: Node): Literal | string {
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression")
    return literalOf(n.expression as Node);
  if (n.type !== "ObjectExpression") return `a ${n.type} is not a literal`;
  const out: { [key: string]: Literal } = {};
  for (const p of n.properties as Node[]) {
    if (p.type !== "Property" || p.computed || p.kind !== "init")
      return "only plain properties are allowed";
    const k = p.key as Node;
    const key =
      k.type === "Identifier"
        ? (k.name as string)
        : k.type === "Literal" && typeof k.value === "string"
          ? k.value
          : undefined;
    if (key === undefined) return "a property key is not a name";
    const v = literalOf(p.value as Node);
    if (typeof v === "string" && (p.value as Node).type !== "Literal") return v;
    out[key] = v;
  }
  return out;
}

/** The pin's declaration: its literal, the line and the source range of the object. */
export function readPin(
  file: string,
):
  | { pin: Literal; line: number; start: number; end: number; source: string }
  | { finding: Finding } {
  const parsed = parseFile(file);
  if (isParseError(parsed)) return { finding: parsed };
  for (const stmt of parsed.program.body as Node[]) {
    if (stmt.type !== "ExportNamedDeclaration") continue;
    const decl = stmt.declaration as Node | null;
    if (decl?.type !== "VariableDeclaration" || decl.kind !== "const") continue;
    for (const d of decl.declarations as Node[]) {
      const id = d.id as Node;
      if (id.type !== "Identifier" || id.name !== PIN_NAME || !d.init) continue;
      const init = d.init as Node;
      const line = parsed.lineOf(init.start);
      const pin = literalOf(init);
      if (typeof pin === "string" && init.type !== "Literal")
        return {
          finding: {
            file,
            line,
            rule: "device-image-pin-literal",
            message: `${PIN_NAME} must be a plain object literal of strings (${pin})`,
          },
        };
      const object = init.type === "ObjectExpression" ? init : (init.expression as Node);
      return { pin, line, start: object.start, end: object.end, source: parsed.source };
    }
  }
  return {
    finding: {
      file,
      line: 1,
      rule: "device-image-pin-missing",
      message: `${file} exports no const ${PIN_NAME}`,
    },
  };
}

const keysAre = (o: Literal, keys: readonly string[]): o is { [key: string]: Literal } =>
  typeof o === "object" && Object.keys(o).sort().join() === [...keys].sort().join();

/** The pin's shape problems (offline). */
export function pinProblems(pin: Literal): { rule: string; message: string }[] {
  const out: { rule: string; message: string }[] = [];
  if (!keysAre(pin, ["repository", "version", "index", "platforms"]))
    return [
      {
        rule: "device-image-pin-shape",
        message: "the pin has exactly repository, version, index and platforms",
      },
    ];
  if (pin.repository !== OFFICIAL_SANDBOX_REPOSITORY)
    out.push({
      rule: "device-image-pin-repository",
      message: `repository is ${JSON.stringify(pin.repository)}, not the official ${OFFICIAL_SANDBOX_REPOSITORY} (a mirror is a runtime override, CAPYBARA_DEVICE_IMAGE_REPOSITORY)`,
    });
  if (typeof pin.version !== "string" || !VERSION.test(pin.version))
    out.push({
      rule: "device-image-pin-version",
      message: `version ${JSON.stringify(pin.version)} is not a release version`,
    });
  const digests: [string, Literal | undefined][] = [["index", pin.index]];
  const platforms = pin.platforms as Literal;
  if (!keysAre(platforms, PIN_PLATFORMS)) {
    out.push({
      rule: "device-image-pin-shape",
      message: `platforms has exactly ${PIN_PLATFORMS.join(" and ")}`,
    });
  } else {
    for (const p of PIN_PLATFORMS) {
      const entry = platforms[p] as Literal;
      if (!keysAre(entry, ["manifest", "config"])) {
        out.push({
          rule: "device-image-pin-shape",
          message: `platforms.${p} has exactly manifest and config`,
        });
        continue;
      }
      digests.push([`platforms.${p}.manifest`, entry.manifest]);
      digests.push([`platforms.${p}.config`, entry.config]);
    }
  }
  const seen = new Map<string, string>();
  for (const [where, value] of digests) {
    if (typeof value !== "string" || !DIGEST.test(value)) {
      out.push({
        rule: "device-image-pin-digest",
        message: `${where} is ${JSON.stringify(value)}, not a sha256 digest (an image is pinned by content, never by tag)`,
      });
      continue;
    }
    const other = seen.get(value);
    if (other !== undefined)
      out.push({
        rule: "device-image-pin-digest",
        message: `${where} repeats the digest of ${other}`,
      });
    seen.set(value, where);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The offline check: the pin is a well-formed digest pin of the official repository, and no
 * device source names the sandbox image by tag (`capybara-sandbox:`).
 */
export function checkDeviceImagePin(file: string, sourceDir?: string): Finding[] {
  const read = readPin(file);
  if ("finding" in read) return [read.finding];
  const out: Finding[] = pinProblems(read.pin).map((p) => ({ file, line: read.line, ...p }));
  if (sourceDir !== undefined)
    for (const f of sourceFiles(sourceDir)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (/capybara-sandbox:[\w${]/.test(text))
          out.push({
            file: f,
            line: i + 1,
            rule: "device-image-pin-tag",
            message:
              "the device names the sandbox image by tag; use the digest pin of docker-image.ts",
          });
      });
    }
  return out;
}

/** The pin as checked data, or the reason it is not one. */
export function loadPin(file: string): DeviceImagePin {
  const read = readPin(file);
  if ("finding" in read) throw new Error(read.finding.message);
  const problems = pinProblems(read.pin);
  if (problems.length > 0) throw new Error(problems.map((p) => p.message).join("; "));
  return read.pin as unknown as DeviceImagePin;
}

// ---- registry access (network half and the generator) ----

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

function splitRepository(repository: string): { host: string; path: string } {
  const slash = repository.indexOf("/");
  const host = repository.slice(0, slash);
  if (slash < 0 || !/[.:]/.test(host))
    throw new Error(`${repository} does not name its registry host`);
  return { host, path: repository.slice(slash + 1) };
}

/** A bearer token from the registry's `WWW-Authenticate` challenge (anonymous pull). */
async function bearer(challenge: string, fetchFn: FetchLike): Promise<string> {
  const params = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1] as string, m[2] as string]),
  );
  if (!/^Bearer\s/i.test(challenge) || !params.realm?.startsWith("https://"))
    throw new Error(`unsupported registry challenge: ${challenge}`);
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);
  const r = await fetchFn(url.toString());
  if (r.status !== 200) throw new Error(`registry token request failed: HTTP ${r.status}`);
  const body = (await r.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) throw new Error("registry token response has no token");
  return token;
}

/** One manifest (index or image) by tag or digest, as bytes; a digest reference is verified. */
export async function fetchManifest(
  repository: string,
  reference: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<{ bytes: Buffer; digest: string; json: Record<string, unknown> }> {
  const { host, path } = splitRepository(repository);
  const url = `https://${host}/v2/${path}/manifests/${reference}`;
  const headers: Record<string, string> = { Accept: MANIFEST_TYPES.join(", ") };
  let r = await fetchFn(url, { headers });
  if (r.status === 401) {
    const challenge = r.headers.get("www-authenticate") ?? "";
    headers.Authorization = `Bearer ${await bearer(challenge, fetchFn)}`;
    r = await fetchFn(url, { headers });
  }
  if (r.status !== 200) throw new Error(`${repository}@${reference}: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new Error(`${repository}@${reference}: manifest too large`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (reference.startsWith("sha256:") && digest !== reference)
    throw new Error(`${repository}@${reference}: the registry served bytes of ${digest}`);
  return { bytes, digest, json: JSON.parse(bytes.toString("utf8")) as Record<string, unknown> };
}

interface IndexEntry {
  digest?: string;
  platform?: { os?: string; architecture?: string; variant?: string };
}

/** The pin of a published version, read from the registry. */
export async function resolvePin(
  version: string,
  repository: string = OFFICIAL_SANDBOX_REPOSITORY,
  fetchFn?: FetchLike,
): Promise<DeviceImagePin> {
  const index = await fetchManifest(repository, version, fetchFn);
  const manifests = (index.json.manifests ?? []) as IndexEntry[];
  if (!Array.isArray(index.json.manifests))
    throw new Error(`${repository}:${version} is not a multi-platform index`);
  const platforms = {} as DeviceImagePin["platforms"];
  for (const p of PIN_PLATFORMS) {
    const entries = manifests.filter(
      (m) => m.platform?.os === "linux" && m.platform.architecture === p,
    );
    if (entries.length !== 1 || !entries[0]?.digest)
      throw new Error(`${repository}:${version} has ${entries.length} linux/${p} manifests, not 1`);
    const manifest = await fetchManifest(repository, entries[0].digest, fetchFn);
    const config = (manifest.json.config as { digest?: string } | undefined)?.digest;
    if (!config || !DIGEST.test(config))
      throw new Error(`${repository}@${manifest.digest} has no config digest`);
    platforms[p] = { manifest: manifest.digest, config };
  }
  return { repository, version, index: index.digest, platforms };
}

/**
 * The network check: the version tag names the pinned index, the index lists the pinned manifest
 * of each platform, and each manifest names the pinned config. Every byte is verified against its
 * digest.
 */
export async function checkDeviceImagePinNetwork(
  file: string,
  fetchFn?: FetchLike,
): Promise<Finding[]> {
  let pin: DeviceImagePin;
  try {
    pin = loadPin(file);
  } catch (e) {
    return [{ file, line: 1, rule: "device-image-pin-shape", message: (e as Error).message }];
  }
  try {
    const actual = await resolvePin(pin.version, pin.repository, fetchFn);
    const out: Finding[] = [];
    const differ = (what: string, want: string, got: string) => {
      if (want !== got)
        out.push({
          file,
          line: 1,
          rule: "device-image-pin-registry",
          message: `${what}: the pin says ${want}, the registry has ${got} for ${pin.repository}:${pin.version}`,
        });
    };
    differ("index", pin.index, actual.index);
    for (const p of PIN_PLATFORMS) {
      differ(`platforms.${p}.manifest`, pin.platforms[p].manifest, actual.platforms[p].manifest);
      differ(`platforms.${p}.config`, pin.platforms[p].config, actual.platforms[p].config);
    }
    return out;
  } catch (e) {
    return [{ file, line: 1, rule: "device-image-pin-registry", message: (e as Error).message }];
  }
}

/** The pin as the TypeScript object literal the generator writes (biome's format). */
export function renderPin(pin: DeviceImagePin): string {
  const platform = (p: PinPlatform) =>
    `    ${p}: {\n      manifest: "${pin.platforms[p].manifest}",\n      config: "${pin.platforms[p].config}",\n    },\n`;
  return (
    "{\n" +
    `  repository: "${pin.repository}",\n` +
    `  version: "${pin.version}",\n` +
    `  index: "${pin.index}",\n` +
    "  platforms: {\n" +
    PIN_PLATFORMS.map(platform).join("") +
    "  },\n" +
    "}"
  );
}

/** Rewrites the pin's object literal in `file`; returns whether it changed. */
export function writePin(file: string, pin: DeviceImagePin): boolean {
  if (pinProblems(pin as unknown as Literal).length > 0) throw new Error("refusing an invalid pin");
  const read = readPin(file);
  if ("finding" in read) throw new Error(read.finding.message);
  const next = read.source.slice(0, read.start) + renderPin(pin) + read.source.slice(read.end);
  if (next === read.source) return false;
  writeFileSync(file, next);
  return true;
}
