import { describe, expect, it } from "vitest";
import {
  ADDRESS_CLASS_RANGES,
  type AddressClass,
  classifyAddress,
  OPEN_PUBLIC_DENIED_CLASSES,
} from "../src/index.js";

/** The table of the approval-only profiles design, section "Open network". */
const CASES: readonly [string, AddressClass][] = [
  // IPv4 public
  ["1.1.1.1", "public"],
  ["8.8.8.8", "public"],
  ["93.184.216.34", "public"],
  ["9.255.255.255", "public"],
  ["11.0.0.0", "public"],
  ["100.63.255.255", "public"],
  ["100.128.0.0", "public"],
  ["172.15.255.255", "public"],
  ["172.32.0.0", "public"],
  ["192.167.255.255", "public"],
  ["192.169.0.0", "public"],
  ["223.255.255.255", "public"],
  // IPv4 private and LAN
  ["10.0.0.1", "private"],
  ["10.255.255.255", "private"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.168.0.1", "private"],
  ["192.168.255.255", "private"],
  // CGNAT
  ["100.64.0.0", "cgnat"],
  ["100.127.255.255", "cgnat"],
  ["100.100.100.199", "cgnat"],
  // link-local and metadata
  ["169.254.0.1", "link-local"],
  ["169.254.255.255", "link-local"],
  ["169.254.169.254", "metadata"],
  ["100.100.100.200", "metadata"],
  // loopback and unspecified
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "unspecified"],
  // multicast, broadcast and the other special-purpose ranges
  ["224.0.0.1", "multicast"],
  ["239.255.255.250", "multicast"],
  ["255.255.255.255", "broadcast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.254", "reserved"],
  ["192.0.0.8", "reserved"],
  ["192.0.2.1", "reserved"],
  ["192.88.99.1", "reserved"],
  ["198.18.0.1", "reserved"],
  ["198.19.255.255", "reserved"],
  ["198.51.100.1", "reserved"],
  ["203.0.113.1", "reserved"],
  // IPv6 public
  ["2606:4700:4700::1111", "public"],
  ["2001:4860:4860::8888", "public"],
  ["2a00:1450:4001:82a::200e", "public"],
  ["2400:CB00:2048:1::C629:D7A2", "public"],
  // IPv6 loopback, unspecified, link-local, ULA, metadata, multicast
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback"],
  ["::", "unspecified"],
  ["fe80::1", "link-local"],
  ["fe80::1%en0", "link-local"],
  ["febf:ffff::1", "link-local"],
  ["fc00::1", "ula"],
  ["fd12:3456:789a::1", "ula"],
  ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ula"],
  ["fd00:ec2::254", "metadata"],
  ["fd00:ec2:0:0:0:0:0:254", "metadata"],
  ["fd00:ec2::253", "ula"],
  ["ff02::1", "multicast"],
  ["ff0e::101", "multicast"],
  // IPv6 special-purpose and unallocated space
  ["100::1", "reserved"],
  ["2001:db8::1", "reserved"],
  ["fec0::1", "reserved"],
  ["4000::1", "reserved"],
  ["::2", "unspecified"],
  // v4-mapped and the other forms that embed an IPv4 address: judged by that address
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:a00:1", "private"],
  ["::ffff:127.0.0.1", "loopback"],
  ["::ffff:169.254.169.254", "metadata"],
  ["::ffff:100.64.0.1", "cgnat"],
  ["::ffff:8.8.8.8", "public"],
  ["::FFFF:8.8.8.8", "public"],
  ["::ffff:0:10.0.0.1", "private"],
  ["::ffff:0:8.8.8.8", "public"],
  ["::10.0.0.1", "private"],
  ["::8.8.8.8", "public"],
  ["2002:a00:1::", "private"],
  ["2002:c0a8:101::1", "private"],
  ["2002:808:808::1", "public"],
  // NAT64: closed as a whole, whatever address it embeds
  ["64:ff9b::8.8.8.8", "nat64"],
  ["64:ff9b::808:808", "nat64"],
  ["64:ff9b::10.0.0.1", "nat64"],
  ["64:ff9b:1::1", "nat64"],
  ["64:ff9b:1:ffff::1", "nat64"],
];

describe("classifyAddress", () => {
  it.each(CASES)("classifies %s as %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("opens only public addresses in open-public mode", () => {
    for (const [ip, cls] of CASES)
      expect(OPEN_PUBLIC_DENIED_CLASSES.includes(classifyAddress(ip)), ip).toBe(cls !== "public");
    expect(new Set(OPEN_PUBLIC_DENIED_CLASSES)).toEqual(
      new Set(
        ADDRESS_CLASS_RANGES.flatMap((r) =>
          "class" in r && r.class !== "public" ? [r.class] : [],
        ),
      ),
    );
  });

  // The host's own interface addresses are not a class of the table: a public interface address
  // classifies as public here, and the device worker that knows its interfaces closes them in
  // addition (T7 macOS, T8 Linux). This case keeps that boundary visible.
  it("leaves the host's own interface addresses to the worker (placeholder)", () => {
    const ownInterface = "203.0.114.7";
    expect(classifyAddress(ownInterface)).toBe("public");
  });

  it.each([
    "",
    "localhost",
    "example.com",
    "1.2.3",
    "1.2.3.4.5",
    "256.0.0.1",
    "01.2.3.4",
    "1.2.3.04",
    "1.2.3.4%en0",
    " 1.2.3.4",
    "1.2.3.4 ",
    "0x7f.0.0.1",
    "127.1",
    "[::1]",
    ":::1",
    "1::2::3",
    "12345::",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "::ffff:1.2.3.256",
    "g::1",
    "fe80::1%",
  ])("refuses %j, which is not an IP address", (value) => {
    expect(() => classifyAddress(value)).toThrow(/not an IP address/);
  });

  it("is pure data: the ranges are frozen CIDRs, most specific first within a family", () => {
    expect(Object.isFrozen(ADDRESS_CLASS_RANGES)).toBe(true);
    for (const range of ADDRESS_CLASS_RANGES) {
      expect(Object.isFrozen(range)).toBe(true);
      expect(range.cidr).toMatch(/^[0-9a-f.:]+\/\d{1,3}$/);
    }
    for (const family of ["ipv4", "ipv6"] as const) {
      const prefixes = ADDRESS_CLASS_RANGES.filter((r) => r.family === family).map((r) =>
        Number(r.cidr.split("/")[1]),
      );
      expect(prefixes).toEqual([...prefixes].sort((a, b) => b - a));
    }
  });
});
