import { isIP, type Socket } from "node:net";
import { Agent, buildConnector } from "undici";
import { NetDeniedError, normalizeHost } from "./public-address.js";

/**
 * Tunneling untrusted downloads through an HTTP(S) egress proxy with `CONNECT` (`net.httpsProxy`).
 *
 * Behind a proxy the kernel does not resolve the target: the proxy does, and the kernel's own DNS
 * may answer fake or internal addresses (e.g. a fake-IP resolver answering 198.18.0.0/15) that say
 * nothing about where the proxy connects. `safeFetch` therefore checks only the hostname rules
 * (IP-literal targets against the private ranges and `allowPrivateHosts`; `allowedHosts` is checked
 * by the callers on the hostname) and leaves SSRF protection for resolved addresses to the proxy.
 *
 * The proxy URL may carry credentials (`http://user:pass@proxy:3128`, sent as Basic
 * `Proxy-Authorization`); they never appear in errors or logs: messages name the proxy by host and
 * port only ({@link proxyLabel}).
 */

/** The egress proxy part of a `NetPolicy`. */
export type NetProxy = {
  /** `http://` or `https://` proxy URL, optionally with `user:password@`. */
  url: string;
  /** Hostnames that bypass the proxy (an entry also matches its subdomains). */
  noProxy: string[];
};

/**
 * How long opening the tunnel may take in total: connecting to the proxy plus its whole `CONNECT`
 * answer. One deadline, not an idle timeout, so a proxy trickling bytes cannot hold a download open.
 */
const TUNNEL_TIMEOUT_MS = 10_000;
/** The largest `CONNECT` response head accepted from the proxy. */
const MAX_RESPONSE_HEAD = 16 * 1024;

/** Why a `net.httpsProxy` value is refused (English, never echoing the value), or undefined. */
export function proxyUrlProblem(value: string): string | undefined {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "must be an http:// or https:// URL such as http://proxy.internal:3128";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "must be an http:// or https:// URL (other proxy protocols are not supported)";
  }
  if ((u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") {
    return "must not have a path, query or fragment";
  }
  try {
    // proxyAgent decodes them for Basic auth; a bad escape (`%zz`) would throw on every download
    decodeURIComponent(u.username);
    decodeURIComponent(u.password);
  } catch {
    return "the user name or password is not valid percent-encoding";
  }
  return undefined;
}

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Why a `net.noProxy` entry is refused, or undefined: a hostname (optionally `.`-prefixed) or IP. */
export function noProxyEntryProblem(entry: string): string | undefined {
  const e = entry.startsWith(".") ? entry.slice(1) : entry;
  if (isIP(e) !== 0 || HOSTNAME_RE.test(e)) return undefined;
  return `"${entry}" is not a hostname or an IP address (no scheme, port, path or wildcard)`;
}

/** Whether `host` bypasses the proxy: equal to a `noProxy` entry or a subdomain of one. */
export function bypassesProxy(host: string, noProxy: readonly string[]): boolean {
  const h = normalizeHost(host);
  return noProxy.some((entry) => {
    const e = normalizeHost(entry.startsWith(".") ? entry.slice(1) : entry);
    return e !== "" && (h === e || (isIP(h) === 0 && h.endsWith(`.${e}`)));
  });
}

/** The proxy as `host:port`, for messages: never its credentials. */
export function proxyLabel(proxy: URL): string {
  return `${proxy.hostname}:${proxy.port || (proxy.protocol === "https:" ? "443" : "80")}`;
}

/**
 * TLS trust overrides (tests): `ca` for the target, `proxyCa` for an https proxy; and the tunnel
 * deadline (tests; default 10 s).
 */
export type ProxyTls = {
  ca?: string | string[];
  proxyCa?: string | string[];
  tunnelTimeoutMs?: number;
};

type ConnectOpts = Parameters<ReturnType<typeof buildConnector>>[0];
type ConnectCallback = Parameters<ReturnType<typeof buildConnector>>[1];

/** Reads the proxy's answer to `CONNECT` and resolves its status once the head is complete. */
function readConnectResponse(socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const done = (err: Error | null, status?: number) => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (err) reject(err);
      else resolve(status as number);
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      // Checked before looking for the terminator, so a large chunk that holds it is refused too
      if (head.length > MAX_RESPONSE_HEAD) {
        done(new Error("the proxy response head is too large"));
        return;
      }
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.pause();
      const rest = head.subarray(end + 4);
      // Bytes after the head belong to the TLS stream: the socket is paused, so tls.connect over
      // it (targetConnect with httpSocket) reads them first
      if (rest.length > 0) socket.unshift(rest);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"));
      if (!m) done(new Error("the proxy sent an invalid response to CONNECT"));
      else done(null, Number(m[1]));
    };
    const onError = (e: Error) => done(e);
    const onClose = () => done(new Error("the proxy closed the connection during CONNECT"));
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

/**
 * An undici dispatcher that reaches every https origin through a `CONNECT` tunnel on `proxyUrl`,
 * then speaks TLS to the target over it (SNI and certificate checks for the target's hostname).
 * The target is never resolved locally. One agent per download, like `pinnedAgent`.
 */
export function proxyAgent(proxyUrl: string, tls: ProxyTls = {}): Agent {
  const proxy = new URL(proxyUrl);
  const label = proxyLabel(proxy);
  const auth =
    proxy.username !== "" || proxy.password !== ""
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}`
      : undefined;
  const tunnelTimeoutMs = tls.tunnelTimeoutMs ?? TUNNEL_TIMEOUT_MS;
  const proxyConnect = buildConnector({
    timeout: tunnelTimeoutMs,
    ...(tls.proxyCa !== undefined && { ca: tls.proxyCa }),
  } as buildConnector.BuildOptions);
  const targetConnect = buildConnector({
    ...(tls.ca !== undefined && { ca: tls.ca }),
  } as buildConnector.BuildOptions);
  const proxyPort = proxy.port || (proxy.protocol === "https:" ? "443" : "80");
  const proxyHost = normalizeHost(proxy.hostname);

  const connect = (opts: ConnectOpts, callback: ConnectCallback) => {
    const target = normalizeHost(opts.hostname);
    const port = opts.port || "443";
    const authority = `${isIP(target) === 6 ? `[${target}]` : target}:${port}`;
    const fail = (e: Error) => callback(e, null);
    if (opts.protocol !== "https:") {
      fail(new Error("only https targets are sent through the egress proxy"));
      return;
    }
    const deadline = Date.now() + tunnelTimeoutMs;
    proxyConnect(
      {
        protocol: proxy.protocol,
        hostname: proxyHost,
        host: `${proxy.hostname}:${proxyPort}`,
        port: proxyPort,
      } as ConnectOpts,
      (err, socket) => {
        if (err || socket === null) {
          fail(new Error(`cannot connect to the egress proxy ${label}: ${err?.message ?? ""}`));
          return;
        }
        const s = socket as Socket;
        // What is left of the one deadline that started before connecting to the proxy
        const timer = setTimeout(
          () => s.destroy(new Error("the proxy did not answer CONNECT in time")),
          Math.max(0, deadline - Date.now()),
        );
        const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
        if (auth !== undefined) lines.push(`Proxy-Authorization: ${auth}`);
        s.write(`${lines.join("\r\n")}\r\n\r\n`);
        readConnectResponse(s).then(
          (status) => {
            clearTimeout(timer);
            if (status < 200 || status > 299) {
              s.destroy();
              fail(
                new NetDeniedError(
                  "net.proxy_refused",
                  target,
                  `The egress proxy ${label} refused the connection to ${authority} (HTTP ${status}).`,
                ),
              );
              return;
            }
            targetConnect({ ...opts, httpSocket: s } as ConnectOpts, callback);
          },
          (e: Error) => {
            clearTimeout(timer);
            s.destroy();
            fail(new Error(`egress proxy ${label}: ${e.message}`));
          },
        );
      },
    );
  };
  return new Agent({ connect: connect as never });
}
