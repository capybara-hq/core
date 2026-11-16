import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  type KernelReadyV3,
  parseDeviceFrameV3,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import type WebSocket from "ws";
import type { MacOperationBackend } from "./exec/mac-operation-backend.js";
import { serveOperationV3 } from "./server-ops.js";
import type { Credential } from "./state.js";

/** Dormant authenticated socket adapter. Production connect() remains v2 until paired activation. */
export function serveStagedSession(
  socket: WebSocket,
  report: Omit<DeviceHelloV3, "transport">,
  credential: Pick<Credential, "maxFrameBytes">,
  backend: MacOperationBackend,
  handle: SandboxHandle,
): { ready: () => KernelReadyV3 | undefined } {
  const hello: DeviceHelloV3 = {
    ...report,
    transport: { maxFrameBytes: credential.maxFrameBytes },
  };
  let ready: KernelReadyV3 | undefined;
  const running = new Map<string, AbortController>();
  const send = (value: unknown, cap: number) => {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > cap)
      throw new Error("Check device and deployment frame limits: control frame cannot fit");
    socket.send(raw);
  };
  const fail = (error: unknown) => socket.close(4400, String(error).slice(0, 100));
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("Use JSON text frames");
      const frame = parseDeviceFrameV3(
        data.toString(),
        "kernel",
        ready?.maxFrameBytes ?? hello.transport.maxFrameBytes,
      );
      if (frame.type === "ready") {
        if (ready || frame.maxFrameBytes > hello.transport.maxFrameBytes)
          throw new Error("Invalid ready capacity; reconnect");
        ready = frame;
        return;
      }
      if (!ready) throw new Error("Wait for ready before sending requests");
      if (frame.type === "cancel") {
        running.get(frame.id)?.abort();
        return;
      }
      if (frame.type !== "req") throw new Error("Expected request or cancellation");
      if (hello.instanceGeneration === null)
        throw new Error("Instance is unbound; complete authenticated binding before operations");
      if (running.has(frame.id)) throw new Error("Duplicate request; use a fresh request id");
      const ctl = new AbortController();
      running.set(frame.id, ctl);
      const timer = setTimeout(
        () => ctl.abort(new Error("Request deadline elapsed; retry the read")),
        frame.deadlineMs,
      );
      void serveOperationV3(backend, handle, frame, ctl.signal)
        .then((res) => {
          if (socket.readyState !== socket.OPEN || ctl.signal.aborted) return;
          const cap = ready?.maxFrameBytes;
          if (cap === undefined) return;
          const answer: DeviceResponseV3 =
            Buffer.byteLength(JSON.stringify(res)) <= cap
              ? res
              : {
                  type: "res",
                  id: res.id,
                  ok: false,
                  error: {
                    kind: "error",
                    message:
                      "Result exceeds negotiated capacity; check frame limits and retry the read",
                  },
                };
          send(answer, cap);
        })
        .catch(fail)
        .finally(() => {
          clearTimeout(timer);
          running.delete(frame.id);
        });
    } catch (error) {
      fail(error);
    }
  });
  socket.on("close", () => {
    ready = undefined;
    for (const ctl of running.values()) ctl.abort();
  });
  try {
    parseDeviceFrameV3(JSON.stringify(hello), "device", hello.transport.maxFrameBytes);
    send(hello, hello.transport.maxFrameBytes);
  } catch (error) {
    fail(error);
  }
  return { ready: () => ready };
}
