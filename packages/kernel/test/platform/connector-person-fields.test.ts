import { describe, expect, it } from "vitest";
import { connectorPersonFields } from "../../src/platform/connector-person-fields.js";
import { checkPersonValue } from "../../src/platform/person-fields.js";

/**
 * The person fields of a connector come from its auth method (ruling R3): a token for bearer and
 * api_key, a username and a password for basic, the OAuth client's secret for both OAuth flows.
 * Labels are fixed, never from the auth preset or the model.
 */
describe("connectorPersonFields", () => {
  const none = new Set<string>();
  const brief = (fields: ReturnType<typeof connectorPersonFields>) =>
    fields.map((f) => ({ path: f.path, label: f.label, required: f.required, isSet: f.isSet }));

  it("asks a token for bearer and api_key", () => {
    for (const auth of [
      { type: "bearer", ownership: "org" },
      { type: "api_key", ownership: "personal", in: "header", name: "X-Api-Key" },
    ] as const) {
      expect(brief(connectorPersonFields(auth, none))).toEqual([
        { path: "credential.token", label: "Token", required: true, isSet: false },
      ]);
    }
  });

  it("asks a username and a password for basic", () => {
    expect(brief(connectorPersonFields({ type: "basic", ownership: "org" }, none))).toEqual([
      { path: "credential.username", label: "Username", required: true, isSet: false },
      { path: "credential.password", label: "Password", required: true, isSet: false },
    ]);
  });

  it("asks the client secret for oauth: required for client credentials, optional for a manual code client", () => {
    expect(
      brief(
        connectorPersonFields(
          { type: "oauth_client", ownership: "org", tokenUrl: "https://auth.example.com/token" },
          none,
        ),
      ),
    ).toEqual([
      { path: "client.clientSecret", label: "Client secret", required: true, isSet: false },
    ]);
    expect(
      brief(
        connectorPersonFields(
          { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "manual" },
          none,
        ),
      ),
    ).toEqual([
      { path: "client.clientSecret", label: "Client secret", required: false, isSet: false },
    ]);
  });

  it("asks nothing without a secret the card can name: none, a registered (dcr) client, custom headers", () => {
    expect(connectorPersonFields({ type: "none" }, none)).toEqual([]);
    expect(
      connectorPersonFields(
        { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
        none,
      ),
    ).toEqual([]);
    expect(
      connectorPersonFields({ type: "headers", ownership: "org", names: ["X-Secret"] }, none),
    ).toEqual([]);
  });

  it("marks stored paths as set and gives each field a non-empty string schema", () => {
    const [f] = connectorPersonFields(
      { type: "bearer", ownership: "org" },
      new Set(["credential.token"]),
    );
    expect(f).toMatchObject({ isSet: true, multiline: false });
    expect(f?.schema).toMatchObject({ type: "string", minLength: 1 });
    if (f === undefined) throw new Error("no field");
    expect(checkPersonValue(f, "")).toBe("Token is empty.");
    expect(checkPersonValue(f, "tok-1")).toBeNull();
  });
});
