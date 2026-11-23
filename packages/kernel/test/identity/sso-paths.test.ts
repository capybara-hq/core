import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import { SsoController } from "../../src/identity/sso.controller.js";
import { SSO_PATH_PREFIX, ssoCallbackPath } from "../../src/identity/sso-paths.js";

// The SSO callback path lives in sso-paths.ts (the flow's redirect URI and the setup guides'
// `{{signInCallbackUrl}}`); the controller's decorators stay literals: this keeps them equal.

describe("ssoCallbackPath", () => {
  it("is the path the SSO controller serves the callback on", () => {
    const base = Reflect.getMetadata(PATH_METADATA, SsoController) as string;
    const route = Reflect.getMetadata(PATH_METADATA, SsoController.prototype.callback) as string;
    expect(`/${base}/${route}`.replace(":plugin", "google")).toBe(ssoCallbackPath("google"));
    expect(ssoCallbackPath("google").startsWith(`${SSO_PATH_PREFIX}/`)).toBe(true);
  });

  it("encodes the plugin name", () => {
    expect(ssoCallbackPath("a b")).toBe("/api/v1/auth/sso/a%20b/callback");
  });
});
