// A framed echo device service for kernel tests (the device service socket protocol of
// `@capybara-hq/plugin-sdk`'s device-service.ts, written out here so the script runs alone from
// the service's state directory). It listens on $CAPYBARA_SERVICE_SOCKET, writes `started` into
// $CAPYBARA_SERVICE_STATE, answers a `request` connection with its body unchanged and echoes every
// message of a `stream` connection.
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const socket = process.env.CAPYBARA_SERVICE_SOCKET;
const state = process.env.CAPYBARA_SERVICE_STATE;
if (!socket || !state) {
  process.stderr.write("CAPYBARA_SERVICE_SOCKET and CAPYBARA_SERVICE_STATE are required\n");
  process.exit(2);
}

const frame = (body) => {
  const out = Buffer.alloc(4 + body.byteLength);
  out.writeUInt32BE(body.byteLength, 0);
  Buffer.from(body).copy(out, 4);
  return out;
};

const server = createServer((conn) => {
  let buf = Buffer.alloc(0);
  let kind = null;
  conn.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.byteLength < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.byteLength < 4 + len) return;
      const msg = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      if (kind === null) {
        kind = JSON.parse(msg.toString("utf8")).kind;
        continue;
      }
      if (kind === "request") {
        conn.end(frame(msg));
        return;
      }
      conn.write(frame(msg));
    }
  });
  conn.on("error", () => {});
});

server.listen(socket, () => {
  writeFileSync(join(state, "started"), String(process.pid));
});
