import { describe, expect, it } from "vitest";
import { networkCardText } from "../../src/channels/cards.js";
import type { ApprovalRecord, LoopbackAskDetail } from "../../src/tools/approvals.service.js";
import {
  loopbackDeniedNote,
  loopbackExpiredNote,
  loopbackGrantedNote,
  loopbackPendingNote,
  loopbackRefusedNote,
  loopbackReviewDeniedNote,
  planLoopbackAsk,
  settledLoopbackNotes,
} from "../../src/tools/loopback-asks.js";
import { settledNetworkNotes } from "../../src/tools/network-asks.js";

/**
 * Loopback port asks (browser loopback port grants): the plan for a reported loopback refusal and
 * every model-visible note, worded exactly.
 */

const detail: LoopbackAskDetail = {
  kind: "loopback",
  deviceId: "d1",
  service: "browser",
  url: "http://127.0.0.1:3999/",
  port: 3999,
  database: false,
  attempt: 1,
  result: { content: "Could not load http://127.0.0.1:3999/.", isError: false },
};

const ask = (over: Partial<ApprovalRecord>): ApprovalRecord =>
  ({
    id: "a1",
    kind: "network",
    status: "pending",
    scope: null,
    scopes: ["session"],
    denyReason: null,
    detail,
    ...over,
  }) as ApprovalRecord;

describe("planLoopbackAsk", () => {
  it("plans none without a loopback entry", () => {
    expect(planLoopbackAsk(null, null, true)).toEqual({ kind: "none" });
    expect(planLoopbackAsk(null, "anything", false)).toEqual({ kind: "none" });
  });

  it("plans refused with the reason and the escalation sentence only when escalation is available", () => {
    const entry = { host: "127.0.0.1", port: 3999 };
    expect(planLoopbackAsk(entry, "the provider cannot", true)).toEqual({
      kind: "refused",
      note: '[network] 127.0.0.1:3999 is a local port on the device. Local ports stay closed to the browser because the provider cannot. A command run outside the sandbox (Bash with sandbox: "escalated") still reaches it.',
    });
    expect(planLoopbackAsk(entry, "the setting is off", false)).toEqual({
      kind: "refused",
      note: "[network] 127.0.0.1:3999 is a local port on the device. Local ports stay closed to the browser because the setting is off.",
    });
    expect(planLoopbackAsk(entry, null, true)).toEqual({
      kind: "decide",
      port: 3999,
      host: "127.0.0.1",
      database: false,
    });
    expect(planLoopbackAsk({ host: "localhost", port: 5432 }, null, true)).toEqual({
      kind: "decide",
      port: 5432,
      host: "localhost",
      database: true,
    });
  });

  it("words every note exactly", () => {
    expect(loopbackPendingNote("127.0.0.1", 3999)).toBe(
      "[network] 127.0.0.1:3999 is a local port on the device. The browser reaches local ports only after the port is approved for this conversation; an approval was requested.",
    );
    expect(loopbackPendingNote("::1", 3999)).toBe(
      "[network] [::1]:3999 is a local port on the device. The browser reaches local ports only after the port is approved for this conversation; an approval was requested.",
    );
    expect(loopbackPendingNote("localhost", 8080)).toBe(
      "[network] localhost:8080 is a local port on the device. The browser reaches local ports only after the port is approved for this conversation; an approval was requested.",
    );
    expect(loopbackGrantedNote(3999)).toBe(
      "Port 3999 on the device was approved for this conversation.",
    );
    expect(loopbackRefusedNote("::1", 3999, "why", true)).toBe(
      '[network] [::1]:3999 is a local port on the device. Local ports stay closed to the browser because why. A command run outside the sandbox (Bash with sandbox: "escalated") still reaches it.',
    );
    expect(loopbackRefusedNote("localhost", 3999, "why", false)).toBe(
      "[network] localhost:3999 is a local port on the device. Local ports stay closed to the browser because why.",
    );
    expect(loopbackDeniedNote(3999)).toBe(
      "[network] Port 3999 on the device was not approved for this conversation, so the browser cannot reach it.",
    );
    expect(loopbackDeniedNote(3999, "not now")).toBe(
      "[network] Port 3999 on the device was not approved for this conversation, so the browser cannot reach it. Reason: not now",
    );
    expect(loopbackExpiredNote(3999, 24)).toBe(
      "[network] The approval for port 3999 on the device expired after 24 hours without an answer, so the browser cannot reach it.",
    );
    expect(loopbackReviewDeniedNote(3999, "Not needed.")).toBe(
      "[network] The review declined port 3999 on the device for this conversation: Not needed.",
    );
  });
});

describe("settledLoopbackNotes", () => {
  it("settles an approved, denied and expired loopback ask", () => {
    expect(settledLoopbackNotes(ask({}), 24)).toBeNull();
    expect(settledLoopbackNotes(ask({ status: "approved", scope: "session" }), 24)).toEqual([
      loopbackGrantedNote(3999),
    ]);
    expect(settledLoopbackNotes(ask({ status: "denied", denyReason: "no" }), 24)).toEqual([
      loopbackDeniedNote(3999, "no"),
    ]);
    expect(settledLoopbackNotes(ask({ status: "expired" }), 12)).toEqual([
      loopbackExpiredNote(3999, 12),
    ]);
    // a network ask's settled notes delegate a loopback detail
    expect(settledNetworkNotes(ask({ status: "expired" }), 12)).toEqual([
      loopbackExpiredNote(3999, 12),
    ]);
    expect(settledLoopbackNotes(ask({ status: "cancelled" }), 24)?.[0]).toContain(
      "access stays blocked",
    );
  });
});

describe("networkCardText", () => {
  it("cards a loopback ask with the session label", () => {
    const en = networkCardText(detail, "en", (s) => s, ["session"]);
    expect(en.title).toBe("Allow the browser to reach port 3999 on this device?");
    expect(en.inputPreview).toBe("http://127.0.0.1:3999/");
    expect(en.scopeLabels).toEqual({ session: "Allow for this conversation" });
    const zh = networkCardText({ ...detail, port: 5432, database: true }, "zh", (s) => s, [
      "session",
    ]);
    expect(zh.title).toBe("允许浏览器访问本机端口 5432？");
    expect(zh.inputPreview).toBe("这是一个本地数据库端口。");
    expect(zh.scopeLabels).toEqual({ session: "允许本会话访问" });
  });
});
