import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../../src/net/public-address.js";
import {
  describeFetchError,
  NetBodyTooLargeError,
  pinnedAgent,
  safeFetch,
} from "../../src/net/safe-fetch.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let port: number;
let handler: Handler;
const seen: { remoteAddress: string | undefined; host: string | undefined; url: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({
      remoteAddress: req.socket.remoteAddress,
      host: req.headers.host,
      url: req.url ?? "",
    });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  seen.length = 0;
  handler = (_req, res) => res.end("ok");
});

const LOOPBACK: NetPolicy = {
  allowInsecureLoopback: true,
  allowPrivateHosts: [],
  trustedOrigins: [],
};
const STRICT: NetPolicy = { ...LOOPBACK, allowInsecureLoopback: false };
const init = () => ({ signal: AbortSignal.timeout(5_000) });

async function denied(p: Promise<unknown>): Promise<NetDeniedError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(NetDeniedError);
  return e as NetDeniedError;
}

describe("pinnedAgent", () => {
  it("connects to the pinned address without resolving the hostname", async () => {
    // `.invalid` never resolves (RFC 6761): the request can only arrive through the pin
    const agent = pinnedAgent(["127.0.0.1"]);
    try {
      const res = await undiciFetch(`http://rebind.invalid:${port}/p`, { dispatcher: agent });
      expect(await res.text()).toBe("ok");
    } finally {
      await agent.close();
    }
    expect(seen).toEqual([
      { remoteAddress: "127.0.0.1", host: `rebind.invalid:${port}`, url: "/p" },
    ]);
  });
});

describe("safeFetch", () => {
  it("fetches from a loopback server under allowInsecureLoopback", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/a`, init(), LOOPBACK);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen).toHaveLength(1);
  });

  it("connects to the checked address: a second (rebinding) answer is never used", async () => {
    // The first answer is the one checked; any later lookup would answer an address nothing
    // listens on. The request still reaches the server on the checked address, and the lookup
    // ran exactly once: the connection is pinned, there is no second DNS lookup.
    const answers = ["127.0.0.1", "10.255.255.1"];
    let calls = 0;
    const lookup: LookupFn = async () => {
      const address = answers[Math.min(calls, answers.length - 1)] as string;
      calls += 1;
      return [{ address, family: 4 }];
    };
    const res = await safeFetch(`http://localhost:${port}/pinned`, init(), LOOPBACK, { lookup });
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(1);
    expect(seen).toEqual([
      { remoteAddress: "127.0.0.1", host: `localhost:${port}`, url: "/pinned" },
    ]);
  });

  it("sends the request through the dispatcher pinned to the checked addresses", async () => {
    const lookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
    const built: string[][] = [];
    const dispatched: string[] = [];
    const dispatcherFor = (ips: string[]) => {
      built.push(ips);
      const agent = pinnedAgent(ips);
      const dispatch = agent.dispatch.bind(agent);
      agent.dispatch = (o, h) => {
        dispatched.push(`${String(o.origin)}${o.path}`);
        return dispatch(o, h);
      };
      return agent;
    };
    const res = await safeFetch(`http://localhost:${port}/seam`, init(), LOOPBACK, {
      lookup,
      dispatcherFor,
    });
    expect(await res.text()).toBe("ok");
    expect(built).toEqual([["127.0.0.1"]]);
    expect(dispatched).toEqual([`http://localhost:${port}/seam`]);
    expect(seen).toHaveLength(1);
  });

  it("refuses a host that resolves to a private address before connecting", async () => {
    const lookup: LookupFn = async () => [{ address: "10.0.0.1", family: 4 }];
    const e = await denied(
      safeFetch("https://rebind.example/marketplace.json", init(), STRICT, { lookup }),
    );
    expect(e).toMatchObject({ code: "net.private_address", host: "rebind.example" });
    expect((await denied(safeFetch("https://[::ffff:192.168.0.1]/x", init(), STRICT))).code).toBe(
      "net.private_address",
    );
    expect(seen).toHaveLength(0);
  });

  it("stops waiting for a hanging DNS lookup when the signal aborts", async () => {
    const hang: LookupFn = () => new Promise(() => {});
    const ac = new AbortController();
    const p = safeFetch("https://slow.example/", { signal: ac.signal }, STRICT, { lookup: hang });
    ac.abort(new Error("gave up"));
    await expect(p).rejects.toThrow("gave up");
  });

  it("refuses http except to loopback under allowInsecureLoopback", async () => {
    expect((await denied(safeFetch(`http://127.0.0.1:${port}/`, init(), STRICT))).code).toBe(
      "net.insecure_url",
    );
    expect((await denied(safeFetch("http://example.com/", init(), LOOPBACK))).code).toBe(
      "net.insecure_url",
    );
    expect((await denied(safeFetch("ftp://example.com/", init(), LOOPBACK))).code).toBe(
      "net.insecure_url",
    );
    expect(seen).toHaveLength(0);
  });

  it("allows http to exactly a trusted origin configured as http (an internal npm registry)", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const trusting: NetPolicy = { ...STRICT, trustedOrigins: [origin] };
    const res = await safeFetch(`${origin}/registry`, init(), trusting);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    // another port of the same host is another origin
    expect((await denied(safeFetch(`http://127.0.0.1:1/`, init(), trusting))).code).toBe(
      "net.insecure_url",
    );
    expect(seen).toHaveLength(1);
  });

  it("refuses a 3xx with net.redirect and never follows it", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` });
      res.end();
    };
    const e = await denied(safeFetch(`http://127.0.0.1:${port}/start`, init(), LOOPBACK));
    expect(e.code).toBe("net.redirect");
    expect(e.message).toMatch(/redirect \(302\)/);
    expect(seen.map((s) => s.url)).toEqual(["/start"]);
  });

  it("passes a 304 through (conditional requests are not redirects)", async () => {
    handler = (_req, res) => {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
    };
    const res = await safeFetch(`http://127.0.0.1:${port}/`, init(), LOOPBACK);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
  });

  it("maxBytes aborts a large streamed body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let n = 0;
      const pump = () => {
        while (n < 64) {
          n += 1;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    };
    const res = await safeFetch(`http://127.0.0.1:${port}/big`, init(), LOOPBACK, {
      maxBytes: 100_000,
    });
    await expect(res.arrayBuffer()).rejects.toBeInstanceOf(NetBodyTooLargeError);
  });

  it("maxBytes refuses a declared content-length over the limit before reading", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": "5000" });
      res.end(Buffer.alloc(5000));
    };
    await expect(
      safeFetch(`http://127.0.0.1:${port}/declared`, init(), LOOPBACK, { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(NetBodyTooLargeError);
  });

  it("a body within maxBytes reads in full", async () => {
    handler = (_req, res) => res.end(Buffer.alloc(1000, 7));
    const res = await safeFetch(`http://127.0.0.1:${port}/small`, init(), LOOPBACK, {
      maxBytes: 1000,
    });
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });
});

describe("safeFetch retry", () => {
  const retry = { attempts: 3, backoffMs: 0 };
  const url = () => `http://127.0.0.1:${port}/r`;

  it("retries a 502 and returns the next answer", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls === 1) res.writeHead(502).end("error code: 502");
      else res.end("ok");
    };
    const res = await safeFetch(url(), init(), LOOPBACK, { retry });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a dropped connection", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (calls === 1) req.socket.destroy();
      else res.end("ok");
    };
    const res = await safeFetch(url(), init(), LOOPBACK, { retry });
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns the last 5xx after the attempts are used up", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(503).end("down");
    };
    const res = await safeFetch(url(), init(), LOOPBACK, { retry });
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("does not retry a 500, a 404, a redirect or a refusal", async () => {
    for (const status of [500, 404]) {
      let calls = 0;
      handler = (_req, res) => {
        calls += 1;
        res.writeHead(status).end();
      };
      expect((await safeFetch(url(), init(), LOOPBACK, { retry })).status).toBe(status);
      expect(calls).toBe(1);
    }
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(302, { location: "http://example.com/" }).end();
    };
    await denied(safeFetch(url(), init(), LOOPBACK, { retry }));
    await denied(safeFetch(url(), init(), STRICT, { retry }));
    expect(calls).toBe(1);
  });

  it("does not retry without the option", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(502).end();
    };
    expect((await safeFetch(url(), init(), LOOPBACK)).status).toBe(502);
    expect(calls).toBe(1);
  });

  it("stops waiting between tries when the caller aborts", async () => {
    handler = (_req, res) => res.writeHead(502).end();
    const ac = new AbortController();
    const p = safeFetch(url(), { signal: ac.signal }, LOOPBACK, {
      retry: { attempts: 3, backoffMs: 60_000 },
    });
    // the first answer is a 502, so the call is now in its backoff
    while (seen.length === 0) await new Promise((r) => setImmediate(r));
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe("describeFetchError", () => {
  it("names undici's cause and the proxy setting for a connection failure", () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT 20.205.243.166:443"), {
      code: "ETIMEDOUT",
    });
    const msg = describeFetchError(new TypeError("fetch failed", { cause }));
    expect(msg).toContain("ETIMEDOUT");
    expect(msg).toContain("net.httpsProxy");
  });

  it("leaves other errors as they are", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
    expect(describeFetchError("x")).toBe("x");
  });
});
