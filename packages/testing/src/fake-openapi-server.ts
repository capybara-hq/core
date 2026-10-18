import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenApiServerOptions {
  /** 设了就要求每个 API 请求带这个 API key（不符 → 401）；不设 = 无需认证。 */
  apiKey?: string;
  /** API key 的位置：请求头 `X-API-Key`（默认）或 query 参数 `api_key`。 */
  apiKeyIn?: "header" | "query";
  /** 错误正文（401 / 404 / 500）回显收到的 API key（测试内核打码用）。 */
  echoKey?: boolean;
  /** 规范地址（`/openapi.json`）以 302 重定向到别处，而不是给出文档。 */
  specRedirect?: boolean;
  /** 覆盖默认文档：参数为服务基址 `http://127.0.0.1:<port>`。 */
  spec?: (base: string) => unknown;
}

/** 服务收到的一次 API 请求（规范地址的请求也记录）。 */
export interface FakeOpenApiRequest {
  method: string;
  /** 路径（不含 query）。 */
  path: string;
  /** 原始 query 串（不含 `?`）。 */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakePet {
  id: number;
  name: string;
  tag?: string;
}

export interface FakeOpenApiServer {
  /** 服务基址 `http://127.0.0.1:<port>`。 */
  url: string;
  /** 规范地址 `<url>/openapi.json`。 */
  specUrl: string;
  /** 当前提供的文档（JSON）。 */
  spec: () => unknown;
  /** 运行中替换文档（漂移测试用）。 */
  setSpec: (spec: unknown) => void;
  requests: FakeOpenApiRequest[];
  pets: () => FakePet[];
  stop(): Promise<void>;
}

/** 1×1 透明 PNG。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * 默认文档（OpenAPI 3.0.3）：宠物 CRUD + 几个用于测试的操作。servers 用服务器变量给出端口（测试默认值替换），
 * 参数与模式用内部 `$ref`，认证为 API key。
 */
export function defaultFakeOpenApiSpec(
  base: string,
  apiKeyIn: "header" | "query" = "header",
): Record<string, unknown> {
  const port = new URL(base).port;
  return {
    openapi: "3.0.3",
    info: { title: "Fake Pet Store", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:{port}/v1", variables: { port: { default: port } } }],
    security: [{ apiKey: [] }],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List pets",
          description: "Returns all pets, optionally filtered by tag.",
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Maximum number of pets to return",
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "tags",
              in: "query",
              description: "Only pets with one of these tags",
              schema: { type: "array", items: { type: "string" } },
            },
          ],
          responses: { "200": { description: "Pets" } },
        },
        post: {
          operationId: "createPet",
          summary: "Create a pet",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/pets/{petId}": {
        parameters: [{ $ref: "#/components/parameters/PetId" }],
        get: { operationId: "getPet", summary: "Get a pet by id", responses: {} },
        patch: {
          operationId: "updatePet",
          summary: "Update a pet",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } },
          },
          responses: {},
        },
        delete: { operationId: "deletePet", summary: "Delete a pet", responses: {} },
      },
      "/pets/{petId}/photo": {
        parameters: [{ $ref: "#/components/parameters/PetId" }],
        get: { operationId: "getPetPhoto", summary: "Download the pet's photo", responses: {} },
      },
      "/echo": {
        get: {
          operationId: "echo",
          summary: "Echo the query string and trace header",
          parameters: [
            { name: "ids", in: "query", explode: false, schema: { type: "array", items: {} } },
            {
              name: "filter",
              in: "query",
              style: "deepObject",
              schema: { type: "object", additionalProperties: { type: "string" } },
            },
            { name: "X-Trace-Id", in: "header", schema: { type: "string" } },
          ],
          responses: {},
        },
      },
      "/notes": {
        post: {
          operationId: "createNote",
          summary: "Store a plain-text note",
          requestBody: {
            required: true,
            content: { "text/plain": { schema: { type: "string" } } },
          },
          responses: {},
        },
      },
      "/boom": { get: { operationId: "boom", summary: "Always fails", responses: {} } },
      "/moved": { get: { operationId: "moved", summary: "Always redirects", responses: {} } },
    },
    components: {
      parameters: {
        PetId: {
          name: "petId",
          in: "path",
          required: true,
          description: "The pet id",
          schema: { type: "integer" },
        },
      },
      schemas: {
        NewPet: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            tag: { type: "string", nullable: true },
          },
        },
      },
      securitySchemes: {
        apiKey:
          apiKeyIn === "header"
            ? { type: "apiKey", in: "header", name: "X-API-Key" }
            : { type: "apiKey", in: "query", name: "api_key" },
      },
    },
  };
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * 本地假 OpenAPI 服务（127.0.0.1 随机端口）：`/openapi.json` 给出文档（或按选项 302），`/v1/*` 实现文档里的
 * 宠物 CRUD（内存）、回显、纯文本、二进制、500 与 302 操作；可要求 API key（请求头或 query）。
 */
export async function startFakeOpenApiServer(
  opts: FakeOpenApiServerOptions = {},
): Promise<FakeOpenApiServer> {
  const keyIn = opts.apiKeyIn ?? "header";
  const requests: FakeOpenApiRequest[] = [];
  let pets: FakePet[] = [];
  let nextId = 1;
  let base = "";
  let spec: unknown;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", base);
    const body = await readBody(req);
    const method = (req.method ?? "GET").toUpperCase();
    requests.push({
      method,
      path: u.pathname,
      query: u.search.replace(/^\?/, ""),
      headers: { ...req.headers },
      body,
    });
    if (u.pathname === "/openapi.json") {
      if (opts.specRedirect) {
        res.writeHead(302, { location: `${base}/elsewhere.json` });
        res.end();
        return;
      }
      json(res, 200, spec);
      return;
    }
    if (!u.pathname.startsWith("/v1/")) {
      json(res, 404, { error: "not_found" });
      return;
    }
    const got =
      keyIn === "header" ? req.headers["x-api-key"] : (u.searchParams.get("api_key") ?? undefined);
    const echo = opts.echoKey ? { receivedKey: got ?? null } : {};
    if (opts.apiKey !== undefined && got !== opts.apiKey) {
      json(res, 401, { error: "unauthorized", ...echo });
      return;
    }
    const path = u.pathname.slice(3);
    const m = /^\/pets\/([^/]+)(\/photo)?$/.exec(path);
    if (path === "/pets" && method === "GET") {
      const tags = u.searchParams.getAll("tags");
      let out = tags.length > 0 ? pets.filter((p) => p.tag && tags.includes(p.tag)) : pets;
      const limit = u.searchParams.get("limit");
      if (limit !== null) out = out.slice(0, Number(limit));
      json(res, 200, out);
      return;
    }
    if (path === "/pets" && method === "POST") {
      const b = JSON.parse(body) as { name?: unknown; tag?: unknown };
      if (typeof b.name !== "string") {
        json(res, 400, { error: "name is required" });
        return;
      }
      const pet: FakePet = {
        id: nextId++,
        name: b.name,
        ...(typeof b.tag === "string" && { tag: b.tag }),
      };
      pets.push(pet);
      json(res, 201, pet);
      return;
    }
    if (m) {
      const id = Number(decodeURIComponent(m[1] as string));
      const pet = pets.find((p) => p.id === id);
      if (!pet) {
        json(res, 404, { error: `pet ${m[1]} not found`, ...echo });
        return;
      }
      if (m[2] && method === "GET") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
        return;
      }
      if (method === "GET") {
        json(res, 200, pet);
        return;
      }
      if (method === "PATCH") {
        const b = JSON.parse(body || "{}") as { name?: unknown; tag?: unknown };
        if (typeof b.name === "string") pet.name = b.name;
        if (typeof b.tag === "string") pet.tag = b.tag;
        json(res, 200, pet);
        return;
      }
      if (method === "DELETE") {
        pets = pets.filter((p) => p.id !== id);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (path === "/echo") {
      json(res, 200, { query: u.search.replace(/^\?/, ""), trace: req.headers["x-trace-id"] });
      return;
    }
    if (path === "/notes" && method === "POST") {
      res.writeHead(201, { "content-type": "text/plain; charset=utf-8" });
      res.end(`stored: ${body}`);
      return;
    }
    if (path === "/boom") {
      json(res, 500, { error: "boom", ...echo });
      return;
    }
    if (path === "/moved") {
      res.writeHead(302, { location: "https://example.invalid/elsewhere" });
      res.end();
      return;
    }
    json(res, 404, { error: "not_found" });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: "server_error", detail: String(e) });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  spec = opts.spec ? opts.spec(base) : defaultFakeOpenApiSpec(base, keyIn);
  return {
    url: base,
    specUrl: `${base}/openapi.json`,
    spec: () => spec,
    setSpec: (s) => {
      spec = s;
    },
    requests,
    pets: () => pets.map((p) => ({ ...p })),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
