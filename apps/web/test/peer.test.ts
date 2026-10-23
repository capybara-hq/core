import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IncomingLike,
  PEER_TOKEN_ENV,
  PEER_TOKEN_HEADER,
  parseTrustProxy,
  sanitizeIncoming,
  trustedPeer,
} from "../src/lib/peer";

// 包一层真实实现以便断言「用的是常量时间比较」。
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const TOKEN = "s3cr3t-peer-token";

const headers = (token: string | undefined) => {
  const h = new Headers({ "x-forwarded-for": "10.0.0.7" });
  if (token !== undefined) h.set(PEER_TOKEN_HEADER, token);
  return h;
};

describe("trustedPeer（可信标记的比较）", () => {
  afterEach(() => {
    delete process.env[PEER_TOKEN_ENV];
    vi.mocked(crypto.timingSafeEqual).mockClear();
  });

  it("标记一致 → 信任 x-forwarded-for，且用 timingSafeEqual 比较", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    expect(trustedPeer(headers(TOKEN))).toBe("10.0.0.7");
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("等长但不同 → 不信任（经常量时间比较）", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    const forged = `${TOKEN.slice(0, -1)}X`;
    expect(trustedPeer(headers(forged))).toBeUndefined();
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("长度不同 / 多字节字符 / 缺失 → 不信任，不抛错", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    expect(trustedPeer(headers("short"))).toBeUndefined();
    expect(trustedPeer(headers(`${TOKEN}-longer`))).toBeUndefined();
    expect(trustedPeer(headers(undefined))).toBeUndefined();
  });

  it("本进程没有标记（未经 server.mjs）→ 一律不信任", () => {
    expect(trustedPeer(headers(TOKEN))).toBeUndefined();
  });
});

describe("sanitizeIncoming with CAPYBARA_WEB_TRUST_PROXY", () => {
  /** Runs sanitizeIncoming on a request from `peer` carrying `xff`; returns the headers. */
  const sanitize = (trustRaw: string | undefined, peer: string, xff?: string) => {
    const req: IncomingLike = {
      headers: {
        ...(xff !== undefined && { "x-forwarded-for": xff }),
        "x-real-ip": "9.9.9.9",
        forwarded: "for=9.9.9.9",
        [PEER_TOKEN_HEADER]: "forged",
      },
      socket: { remoteAddress: peer },
    };
    sanitizeIncoming(req, TOKEN, parseTrustProxy(trustRaw));
    expect(req.headers["x-real-ip"]).toBeUndefined();
    expect(req.headers.forwarded).toBeUndefined();
    expect(req.headers[PEER_TOKEN_HEADER]).toBe(TOKEN);
    return req.headers;
  };

  it("unset: the socket peer replaces any client-sent x-forwarded-for", () => {
    expect(sanitize(undefined, "10.0.0.2", "1.2.3.4")["x-forwarded-for"]).toBe("10.0.0.2");
    expect(sanitize("", "10.0.0.2", "1.2.3.4")["x-forwarded-for"]).toBe("10.0.0.2");
    expect(sanitize("0", "10.0.0.2", "1.2.3.4")["x-forwarded-for"]).toBe("10.0.0.2");
  });

  it("hop count 1: the address the proxy appended, never what the client prepended", () => {
    const h = sanitize("1", "10.0.0.2", "6.6.6.6, 203.0.113.7");
    expect(h["x-forwarded-for"]).toBe("203.0.113.7");
    // No x-forwarded-for from the proxy: fall back to the peer.
    expect(sanitize("1", "10.0.0.2")["x-forwarded-for"]).toBe("10.0.0.2");
  });

  it("CIDR match: trusted proxies are skipped from the right", () => {
    const h = sanitize(
      "10.0.0.0/8, 192.168.1.5",
      "::ffff:10.0.0.2",
      "6.6.6.6, 203.0.113.7, 192.168.1.5",
    );
    expect(h["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("CIDR mismatch: an untrusted peer is the client, its x-forwarded-for is ignored", () => {
    expect(sanitize("10.0.0.0/8", "172.16.0.9", "1.2.3.4")["x-forwarded-for"]).toBe("172.16.0.9");
  });

  it("malformed x-forwarded-for: stops at the last address that can be vouched for", () => {
    expect(sanitize("1", "10.0.0.2", "not-an-ip")["x-forwarded-for"]).toBe("10.0.0.2");
    expect(sanitize("2", "10.0.0.2", "1.2.3.4, 203.0.113.7:443")["x-forwarded-for"]).toBe(
      "10.0.0.2",
    );
    expect(sanitize("10.0.0.0/8", "10.0.0.2", "1.2.3.4,, 10.0.0.3")["x-forwarded-for"]).toBe(
      "10.0.0.3",
    );
  });

  it("rejects a malformed CAPYBARA_WEB_TRUST_PROXY", () => {
    for (const bad of [
      "-1",
      "true",
      "10.0.0.0/33",
      "10.0.0.0/8/1",
      "10.0.0.0/x",
      "proxy.local",
      "1,",
    ]) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/CAPYBARA_WEB_TRUST_PROXY/);
    }
    expect(parseTrustProxy("fd00::/8, ::1").kind).toBe("cidrs");
  });

  it("accepts the kernel's trustProxy grammar: netmasks, named ranges, mapped ranges, JSON", () => {
    // Values that work for CAPYBARA_HTTP__TRUST_PROXY must not crash web at startup.
    expect(sanitize("10.0.0.0/255.0.0.0", "10.1.2.3", "1.2.3.4")["x-forwarded-for"]).toBe(
      "1.2.3.4",
    );
    expect(sanitize("10.0.0.0/255.0.0.0", "11.0.0.1", "1.2.3.4")["x-forwarded-for"]).toBe(
      "11.0.0.1",
    );
    expect(sanitize("loopback", "127.0.0.1", "1.2.3.4")["x-forwarded-for"]).toBe("1.2.3.4");
    expect(sanitize("uniquelocal", "172.20.0.1", "1.2.3.4")["x-forwarded-for"]).toBe("1.2.3.4");
    expect(sanitize("uniquelocal", "8.8.8.8", "1.2.3.4")["x-forwarded-for"]).toBe("8.8.8.8");
    expect(sanitize("linklocal", "fe80::1", "1.2.3.4")["x-forwarded-for"]).toBe("1.2.3.4");
    expect(sanitize("::ffff:10.0.0.0/104", "10.9.9.9", "1.2.3.4")["x-forwarded-for"]).toBe(
      "1.2.3.4",
    );
    expect(sanitize('["10.0.0.0/8", "loopback"]', "10.0.0.2", "1.2.3.4")["x-forwarded-for"]).toBe(
      "1.2.3.4",
    );
    for (const bad of ["10.0.0.0/255.0.255.0", "fd00::/255.0.0.0", '["10.0.0.1", 1]', "[x"]) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/CAPYBARA_WEB_TRUST_PROXY/);
    }
    for (const bad of ["10.0.0.0/0.0.0.0", "::ffff:10.0.0.0/96", '["0.0.0.0/0"]']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/trusts every address/);
    }
  });

  it("refuses a /0 prefix, which would trust every address", () => {
    for (const bad of ["0.0.0.0/0", "::/0", "10.0.0.1, 0.0.0.0/00", "::ffff:0.0.0.0/0"]) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/trusts every address/);
    }
    expect(parseTrustProxy("0.0.0.0/1").kind).toBe("cidrs");
  });
});
