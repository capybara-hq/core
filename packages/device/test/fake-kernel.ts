import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

/** A stand-in for the kernel's `/device/connect` gateway, as the program sees it. */
export class FakeKernel {
  readonly http: Server = createServer();
  readonly wss = new WebSocketServer({ noServer: true });
  readonly sockets: WebSocket[] = [];
  readonly headers: IncomingMessage["headers"][] = [];
  /** Every frame received, tagged with the connection index. */
  readonly frames: Array<{ conn: number; frame: any }> = [];
  /** When set, the next upgrade is answered with this HTTP status. */
  rejectWith: number | undefined;
  /** The JSON body sent with {@link rejectWith} (none when unset). */
  rejectBody: unknown;
  url = "";

  async start(): Promise<void> {
    this.http.on("upgrade", (req: IncomingMessage, socket: Duplex, head) => {
      this.headers.push(req.headers);
      // The server drops its own error listener from a socket it hands to 'upgrade': without one,
      // a client resetting the connection (it terminates right after reading a refusal) would be
      // an unhandled ECONNRESET in whatever test runs then.
      socket.on("error", () => socket.destroy());
      if (this.rejectWith !== undefined) {
        const body = this.rejectBody === undefined ? "" : JSON.stringify(this.rejectBody);
        socket.end(
          `HTTP/1.1 ${this.rejectWith} X\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = this.sockets.push(ws) - 1;
        ws.on("message", (d) => this.frames.push({ conn, frame: JSON.parse(String(d)) }));
      });
    });
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", r));
    this.url = `ws://127.0.0.1:${(this.http.address() as AddressInfo).port}/device/connect`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  send(conn: number, frame: unknown): void {
    this.sockets[conn]?.send(JSON.stringify(frame));
  }

  of(type: string, conn?: number): any[] {
    return this.frames
      .filter((f) => f.frame.type === type && (conn === undefined || f.conn === conn))
      .map((f) => f.frame);
  }

  async waitFor<T>(what: string, get: () => T | undefined | false, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
