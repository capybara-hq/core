// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForgetPushRegistration, usePushRegistration } from "../src/lib/use-push-registration";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { pageElement, testQueryClient } from "./support/render";

const REGISTRATION = {
  platform: "ios",
  appId: "com.example.app",
  provider: "push-apns",
  token: "t1",
};

type Status = {
  permission: "granted" | "denied" | "prompt";
  registrationId: string | null;
  tokenChanged: boolean;
};

function installPush(status: Status, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const push = {
    status: vi.fn(async () => status),
    register: vi.fn(async () => {
      calls.push("register");
      return REGISTRATION;
    }),
    registered: vi.fn(async (id: string) => {
      calls.push(`registered:${id}`);
    }),
    unregister: vi.fn(async () => {
      calls.push("unregister");
    }),
    ...over,
  };
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    capabilities: { "push@1": push },
    on: () => () => {},
  };
  return { push, calls };
}

function mount<T>(hook: () => T) {
  const qc = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    pageElement(createElement("div", null, children), { client: qc });
  return renderHook(hook, { wrapper });
}

const POST = "POST /api/v1/me/push-registrations";

beforeEach(() => {
  stubApi({ [POST]: () => json(201, { id: "r1" }) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "capybaraShell");
});

describe("usePushRegistration", () => {
  it("is unavailable without a shell (the browser)", () => {
    const { result } = mount(usePushRegistration);
    expect(result.current.state).toBe("unavailable");
  });

  it("prompt: enable() registers, posts the registration and tells the shell its id", async () => {
    const { push, calls } = installPush({
      permission: "prompt",
      registrationId: null,
      tokenChanged: false,
    });
    const requests = stubApi({ [POST]: () => json(201, { id: "r1" }) });
    const { result } = mount(usePushRegistration);
    await waitFor(() => expect(result.current.state).toBe("prompt"));
    // nothing happens without a click
    expect(push.register).not.toHaveBeenCalled();
    await result.current.enable();
    expect(calls).toEqual(["register", "registered:r1"]);
    expect(bodyOf(requests.find((c) => c.method === "POST"))).toEqual({
      ...REGISTRATION,
      locale: "en",
      deviceName: "iOS device",
    });
    await waitFor(() => expect(result.current.state).toBe("granted"));
  });

  it("granted with a rotated token re-posts without a click", async () => {
    const { calls } = installPush({
      permission: "granted",
      registrationId: "r0",
      tokenChanged: true,
    });
    const { result } = mount(usePushRegistration);
    await waitFor(() => expect(calls).toEqual(["register", "registered:r1"]));
    expect(result.current.state).toBe("granted");
  });

  it("granted without a registration id registers silently on mount", async () => {
    const { calls } = installPush({
      permission: "granted",
      registrationId: null,
      tokenChanged: false,
    });
    mount(usePushRegistration);
    await waitFor(() => expect(calls).toEqual(["register", "registered:r1"]));
  });

  it("granted and registered does nothing", async () => {
    const { push } = installPush({
      permission: "granted",
      registrationId: "r0",
      tokenChanged: false,
    });
    const { result } = mount(usePushRegistration);
    await waitFor(() => expect(result.current.state).toBe("granted"));
    expect(push.register).not.toHaveBeenCalled();
  });

  it("denied is exposed and register() is never called", async () => {
    const { push } = installPush({
      permission: "denied",
      registrationId: null,
      tokenChanged: false,
    });
    const { result } = mount(usePushRegistration);
    await waitFor(() => expect(result.current.state).toBe("denied"));
    expect(push.register).not.toHaveBeenCalled();
  });

  it("disable() forgets the shell's registration only", async () => {
    const { push } = installPush({
      permission: "granted",
      registrationId: "r0",
      tokenChanged: false,
    });
    const { result } = mount(usePushRegistration);
    await waitFor(() => expect(result.current.state).toBe("granted"));
    await result.current.disable();
    expect(push.unregister).toHaveBeenCalledOnce();
  });
});

describe("useForgetPushRegistration (before sign-out)", () => {
  it("deletes the registration, then unregisters", async () => {
    const { calls } = installPush({
      permission: "granted",
      registrationId: "r 9",
      tokenChanged: false,
    });
    stubApi({
      "DELETE /api/v1/me/push-registrations/r%209": () => {
        calls.push("delete");
        return noContent();
      },
    });
    const { result } = mount(useForgetPushRegistration);
    await result.current();
    expect(calls).toEqual(["delete", "unregister"]);
  });

  it("still unregisters when DELETE fails", async () => {
    const { calls } = installPush({
      permission: "granted",
      registrationId: "r9",
      tokenChanged: false,
    });
    stubApi({ "DELETE /api/v1/me/push-registrations/r9": () => json(500, { code: "internal" }) });
    const { result } = mount(useForgetPushRegistration);
    await result.current();
    expect(calls).toEqual(["unregister"]);
  });

  it("with no registration id only the shell is told", async () => {
    const { calls } = installPush({
      permission: "prompt",
      registrationId: null,
      tokenChanged: false,
    });
    const requests = stubApi({});
    const { result } = mount(useForgetPushRegistration);
    await result.current();
    expect(requests).toEqual([]);
    expect(calls).toEqual(["unregister"]);
  });
});
