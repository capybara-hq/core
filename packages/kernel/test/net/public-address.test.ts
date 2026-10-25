import { describe, expect, it } from "vitest";
import {
  isForbiddenAddress,
  isPrivateHostEntry,
  type LookupFn,
  NetDeniedError,
  type NetPolicy,
  resolvePublic,
} from "../../src/net/public-address.js";

const POLICY: NetPolicy = {
  allowInsecureLoopback: false,
  allowPrivateHosts: [],
  trustedOrigins: [],
};
const fixed =
  (...ips: string[]): LookupFn =>
  async () =>
    ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

async function denied(p: Promise<unknown>): Promise<NetDeniedError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(NetDeniedError);
  return e as NetDeniedError;
}

describe("isForbiddenAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "::10.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b::10.0.0.1",
    "2002:0a00::",
    "2002:c0a8:0101::1",
    "not-an-ip",
    "1.2.3",
  ])("refuses %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:0808:0808::1",
  ])("allows %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

describe("resolvePublic", () => {
  it("returns every checked address of a public host", async () => {
    await expect(
      resolvePublic("example.com", POLICY, fixed("8.8.8.8", "2606:4700::1111")),
    ).resolves.toEqual(["8.8.8.8", "2606:4700::1111"]);
  });

  it("refuses a host when any resolved address is private", async () => {
    const e = await denied(resolvePublic("mixed.example", POLICY, fixed("8.8.8.8", "10.0.0.1")));
    expect(e).toMatchObject({ code: "net.private_address", host: "mixed.example" });
    expect(e.message).toMatch(/private or reserved address/);
  });

  it("checks IP literals without a lookup, including bracketed IPv6", async () => {
    const never: LookupFn = async () => {
      throw new Error("lookup must not be called");
    };
    await expect(resolvePublic("8.8.8.8", POLICY, never)).resolves.toEqual(["8.8.8.8"]);
    expect((await denied(resolvePublic("[::ffff:10.0.0.1]", POLICY, never))).code).toBe(
      "net.private_address",
    );
    expect((await denied(resolvePublic("169.254.169.254", POLICY, never))).code).toBe(
      "net.private_address",
    );
  });

  it("reports a lookup failure or an empty answer as net.dns_failed", async () => {
    const failing: LookupFn = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await denied(resolvePublic("nowhere.example", POLICY, failing))).toMatchObject({
      code: "net.dns_failed",
      host: "nowhere.example",
    });
    expect((await denied(resolvePublic("empty.example", POLICY, fixed()))).code).toBe(
      "net.dns_failed",
    );
  });

  it("allowPrivateHosts lets a listed hostname or an address inside a listed CIDR through", async () => {
    const policy: NetPolicy = { ...POLICY, allowPrivateHosts: ["gitlab.internal", "10.1.0.0/16"] };
    await expect(resolvePublic("GitLab.Internal.", policy, fixed("192.168.5.5"))).resolves.toEqual([
      "192.168.5.5",
    ]);
    await expect(resolvePublic("mirror.corp", policy, fixed("10.1.2.3"))).resolves.toEqual([
      "10.1.2.3",
    ]);
    expect((await denied(resolvePublic("mirror.corp", policy, fixed("10.2.0.1")))).code).toBe(
      "net.private_address",
    );
    expect((await denied(resolvePublic("other.internal", policy, fixed("192.168.5.5")))).code).toBe(
      "net.private_address",
    );
  });

  it("a bare IP entry in allowPrivateHosts exempts that address only", async () => {
    const policy: NetPolicy = { ...POLICY, allowPrivateHosts: ["10.5.5.5", "fd00::7"] };
    await expect(resolvePublic("a.corp", policy, fixed("10.5.5.5", "fd00::7"))).resolves.toEqual([
      "10.5.5.5",
      "fd00::7",
    ]);
    expect((await denied(resolvePublic("a.corp", policy, fixed("10.5.5.6")))).code).toBe(
      "net.private_address",
    );
  });

  it("validates allowPrivateHosts entries", () => {
    for (const ok of [
      "gitlab.internal",
      "GitLab.Corp.",
      "10.1.0.0/16",
      "fd00::/8",
      "10.0.0.1",
      "[::1]",
    ]) {
      expect(isPrivateHostEntry(ok), ok).toBe(true);
    }
    for (const bad of ["", "10.0.0.0/33", "https://gitlab.internal", "*.corp", "a b", "x/8"]) {
      expect(isPrivateHostEntry(bad), bad).toBe(false);
    }
  });

  it("trusts the hosts of trustedOrigins (the configured npm registry)", async () => {
    const policy: NetPolicy = { ...POLICY, trustedOrigins: ["https://npm.corp:8443"] };
    await expect(resolvePublic("npm.corp", policy, fixed("10.9.9.9"))).resolves.toEqual([
      "10.9.9.9",
    ]);
  });

  it("allows loopback hosts only with allowInsecureLoopback", async () => {
    expect((await denied(resolvePublic("127.0.0.1", POLICY))).code).toBe("net.private_address");
    const loop = { ...POLICY, allowInsecureLoopback: true };
    await expect(resolvePublic("127.0.0.1", loop)).resolves.toEqual(["127.0.0.1"]);
    await expect(resolvePublic("[::1]", loop)).resolves.toEqual(["::1"]);
    // a non-loopback name resolving to loopback is still refused
    expect((await denied(resolvePublic("rebind.example", loop, fixed("127.0.0.1")))).code).toBe(
      "net.private_address",
    );
  });
});
