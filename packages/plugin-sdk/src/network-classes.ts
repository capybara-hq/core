/**
 * The address classes of the sandbox network (approval-only profiles design, "Open network"): pure
 * data plus {@link classifyAddress}. The device workers (macOS SRT, the Linux forwarder) and the
 * cloud providers' egress proxies decide every sandboxed connection on the resolved address with
 * this one table, so the classes cannot drift between them.
 *
 * W0 interface stub: the types and the closed-class list are frozen; the classifier is filled in by
 * the SDK contract task (T1).
 */

/**
 * The class of one IP address.
 *
 * - `public`: globally routable; the only class open in `open-public` mode.
 * - `private`: `10/8`, `172.16/12`, `192.168/16`.
 * - `cgnat`: `100.64/10`.
 * - `ula`: IPv6 unique local `fc00::/7` (except the metadata address).
 * - `link-local`: `169.254/16` and `fe80::/10` (except the metadata addresses).
 * - `metadata`: cloud metadata endpoints (`169.254.169.254`, `fd00:ec2::254`).
 * - `loopback`: `127/8`, `::1`.
 * - `multicast`, `broadcast`, `unspecified` (`0/8`, `::`), `nat64` (the NAT64 prefixes),
 *   `reserved` (every other special-purpose range).
 *
 * The host's own interface addresses are not a class of the table: the worker that knows them
 * closes them in addition (a placeholder in the table test).
 */
export type AddressClass =
  | "public"
  | "private"
  | "cgnat"
  | "ula"
  | "link-local"
  | "metadata"
  | "loopback"
  | "multicast"
  | "broadcast"
  | "unspecified"
  | "nat64"
  | "reserved";

/** Every class closed in `open-public` mode: reachable only by running outside the sandbox. */
export const OPEN_PUBLIC_DENIED_CLASSES: readonly AddressClass[] = Object.freeze([
  "private",
  "cgnat",
  "ula",
  "link-local",
  "metadata",
  "loopback",
  "multicast",
  "broadcast",
  "unspecified",
  "nat64",
  "reserved",
]);

/**
 * Classifies one IPv4 or IPv6 address literal (v4-mapped IPv6 classifies as its IPv4 address).
 * Throws on a string that is not an IP address.
 */
export function classifyAddress(ip: string): AddressClass {
  void ip;
  throw new Error("classifyAddress: not implemented in W0");
}
