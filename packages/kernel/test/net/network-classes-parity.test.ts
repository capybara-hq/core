import {
  ADDRESS_CLASS_RANGES,
  type AddressClass,
  classifyAddress,
  OPEN_PUBLIC_DENIED_CLASSES,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  isForbiddenAddress,
  isLinkLocalAddress,
  isLoopbackOrUnspecifiedAddress,
} from "../../src/net/public-address.js";

/**
 * The SDK's sandbox address classes (`network-classes.ts`) against the kernel's public-address
 * checks (approval-only profiles design, "Open network"): everything the kernel refuses stays
 * closed in open-public mode. The SDK is stricter only where the design says so, and only for IPv6:
 * the NAT64 prefixes are closed whatever they embed, and space outside `2000::/3` is reserved.
 */

const closed = (ip: string) => OPEN_PUBLIC_DENIED_CLASSES.includes(classifyAddress(ip));

function v6Value(ip: string): bigint {
  const [head = "", tail] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b];
  return groups.reduce((v, g) => (v << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}
const v6String = (v: bigint) =>
  Array.from({ length: 8 }, (_, i) => ((v >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(
    ":",
  );
const v4Value = (ip: string) => ip.split(".").reduce((v, o) => v * 256 + Number(o), 0);
const v4String = (v: number) => [24, 16, 8, 0].map((s) => Math.floor(v / 2 ** s) % 256).join(".");

/** The first, second, middle and last address of every SDK range, plus the neighbours outside. */
function corpus(): string[] {
  const out = new Set<string>();
  for (const range of ADDRESS_CLASS_RANGES) {
    const [base = "", bits = "0"] = range.cidr.split("/");
    const prefix = Number(bits);
    if (range.family === "ipv4") {
      const size = 2 ** (32 - prefix);
      const first = v4Value(base);
      for (const v of [
        first - 1,
        first,
        first + 1,
        first + size / 2,
        first + size - 1,
        first + size,
      ])
        if (v >= 0 && v < 2 ** 32) out.add(v4String(v));
    } else {
      const size = 1n << BigInt(128 - prefix);
      const first = v6Value(base);
      for (const v of [first - 1n, first, first + 1n, first + size / 2n, first + size - 1n])
        if (v >= 0n && v < 1n << 128n) out.add(v6String(v));
      if (first + size < 1n << 128n) out.add(v6String(first + size));
    }
  }
  for (const ip of [
    "8.8.8.8",
    "::ffff:10.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:0:192.168.1.1",
    "::127.0.0.1",
    "2002:a9fe:a9fe::1",
    "2002:808:808::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::808:808",
    "fd00:ec2::254",
    "100.100.100.200",
    "168.63.129.16",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "3fff::1",
    "fe80::1%eth0",
  ])
    out.add(ip);
  return [...out];
}

/** Where the SDK may be stricter than the kernel (never the other way round). */
const STRICTER: readonly AddressClass[] = ["nat64", "reserved"];

describe("sandbox address classes against the kernel's public-address checks", () => {
  const ips = corpus();

  it("closes every address the kernel forbids", () => {
    const open = ips.filter((ip) => isForbiddenAddress(ip) && !closed(ip));
    expect(open).toEqual([]);
  });

  it("opens every address the kernel allows, except the documented IPv6 strictness", () => {
    const extra = ips.filter((ip) => !isForbiddenAddress(ip) && closed(ip));
    for (const ip of extra) {
      expect(ip.includes(":"), ip).toBe(true);
      expect(STRICTER, ip).toContain(classifyAddress(ip));
    }
    // the strictness is real, not an empty exception list
    expect(extra).toContain("64:ff9b::808:808");
  });

  // The kernel unwraps all of `64:ff9b::/32` as NAT64; the SDK closes it as nat64 or reserved.
  it("forbids the Azure WireServer whatever the exemptions, like the other metadata endpoints", () => {
    expect(isForbiddenAddress("168.63.129.16")).toBe(true);
    expect(isLinkLocalAddress("168.63.129.16")).toBe(true);
    expect(isLinkLocalAddress("::ffff:168.63.129.16")).toBe(true);
    expect(classifyAddress("168.63.129.16")).toBe("metadata");
  });

  it("agrees on the never-allowed and loopback subsets", () => {
    const sixOnly = (ip: string) => (ip.includes(":") ? STRICTER : []);
    for (const ip of ips) {
      if (isLinkLocalAddress(ip))
        expect(["link-local", "metadata", ...sixOnly(ip)], ip).toContain(classifyAddress(ip));
      if (isLoopbackOrUnspecifiedAddress(ip))
        expect(["loopback", "unspecified", ...sixOnly(ip)], ip).toContain(classifyAddress(ip));
    }
  });
});
