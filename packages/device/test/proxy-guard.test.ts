import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  detectLocalProxy,
  isLoopbackHost,
  loopbackProxyEnv,
  PROXY_PORTS,
  parseScutilProxy,
  probeLoopbackPort,
} from "../src/proxy-guard.js";

// `scutil --proxy` on macOS with Clash's system proxy on.
const CLASH = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : localhost
}`;

const NONE = `<dictionary> {
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}`;

const nothing = {
  scutil: async () => NONE,
  probe: async () => false,
  env: {},
};

describe("proxy guard", () => {
  it("reads the enabled loopback proxies from scutil --proxy", () => {
    expect(parseScutilProxy(CLASH)).toEqual([
      "HTTP 127.0.0.1:7890",
      "HTTPS 127.0.0.1:7890",
      "SOCKS localhost:7891",
    ]);
    expect(parseScutilProxy(NONE)).toEqual([]);
    // a proxy elsewhere on the network is not a local one
    expect(
      parseScutilProxy("HTTPEnable : 1\nHTTPProxy : proxy.corp.example\nHTTPPort : 3128"),
    ).toEqual([]);
  });

  it("finds loopback proxy variables in any case, with or without a scheme", () => {
    expect(
      loopbackProxyEnv({
        HTTPS_PROXY: "http://127.0.0.1:7890",
        all_proxy: "socks5://localhost:7891",
        Http_Proxy: "127.0.0.1:8118",
        NO_PROXY: "127.0.0.1",
        HTTP_PROXY: "http://proxy.corp.example:3128",
      }).sort(),
    ).toEqual([
      "HTTPS_PROXY=http://127.0.0.1:7890",
      "Http_Proxy=127.0.0.1:8118",
      "all_proxy=socks5://localhost:7891",
    ]);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.8.0.1")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("probes the common proxy and Docker TCP ports", async () => {
    expect(PROXY_PORTS).toEqual([7890, 7891, 7897, 1080, 1087, 8118, 9050, 9150, 2375, 2376]);
    const probed: string[] = [];
    const r = await detectLocalProxy({
      ...nothing,
      platform: "darwin",
      probe: async (p, host) => {
        probed.push(`${host} ${p}`);
        return (p === 2375 && host === "127.0.0.1") || (p === 7890 && host === "::1");
      },
    });
    expect(probed).toEqual([
      ...PROXY_PORTS.map((p) => `127.0.0.1 ${p}`),
      ...PROXY_PORTS.map((p) => `::1 ${p}`),
    ]);
    expect(r).toEqual({
      detected: true,
      reasons: ["a listener on 127.0.0.1:2375", "a listener on [::1]:7890"],
    });
  });

  it("reports the system proxy and the environment, and nothing when all is quiet", async () => {
    expect(await detectLocalProxy({ ...nothing, platform: "darwin" })).toEqual({
      detected: false,
      reasons: [],
    });
    const r = await detectLocalProxy({
      ...nothing,
      platform: "darwin",
      scutil: async () => CLASH,
      env: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    });
    expect(r.detected).toBe(true);
    expect(r.reasons).toEqual([
      "system proxy HTTP 127.0.0.1:7890",
      "system proxy HTTPS 127.0.0.1:7890",
      "system proxy SOCKS localhost:7891",
      "environment HTTPS_PROXY=http://127.0.0.1:7890",
    ]);
  });

  it("asks scutil on macOS only; unreadable system settings count as a proxy", async () => {
    let asked = false;
    const scutil = async () => {
      asked = true;
      return CLASH;
    };
    expect((await detectLocalProxy({ ...nothing, platform: "linux", scutil })).detected).toBe(
      false,
    );
    expect(asked).toBe(false);
    const broken = await detectLocalProxy({
      platform: "darwin",
      env: {},
      scutil: async () => {
        throw new Error("no scutil");
      },
      probe: async () => {
        throw new Error("no socket");
      },
    });
    expect(broken).toEqual({
      detected: true,
      reasons: ["the system proxy settings could not be read"],
    });
    const failed = await detectLocalProxy({
      ...nothing,
      platform: "darwin",
      scutil: async () => undefined,
    });
    expect(failed.detected).toBe(true);
  });

  it("redacts a proxy URL's user and password", async () => {
    const r = await detectLocalProxy({
      ...nothing,
      platform: "linux",
      env: {
        HTTPS_PROXY: "http://me:s3cret@127.0.0.1:7890",
        all_proxy: "u:p@localhost:1080",
        http_proxy: "socks5://127.0.0.1:7891",
      },
    });
    expect(r.reasons).toEqual([
      "environment HTTPS_PROXY=http://***@127.0.0.1:7890",
      "environment all_proxy=***@localhost:1080",
      "environment http_proxy=socks5://127.0.0.1:7891",
    ]);
    expect(r.reasons.join(" ")).not.toContain("s3cret");
  });

  it("the TCP probe sees a listener and a closed port", async () => {
    const server: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probeLoopbackPort(port)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await probeLoopbackPort(port)).toBe(false);
  });
});
