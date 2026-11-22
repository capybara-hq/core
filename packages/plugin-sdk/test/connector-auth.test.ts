import { describe, expect, it } from "vitest";
import { ConnectorAuthSchema, OAUTH_RESERVED_AUTHORIZATION_PARAMS } from "../src/index.js";

const manual = {
  type: "oauth_code",
  ownership: "personal",
  discovery: "manual",
  authorizationUrl: "https://accounts.example.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.example.com/token",
  scopes: ["openid", "email"],
  client: "manual",
} as const;

const issuesOf = (input: unknown) => {
  const r = ConnectorAuthSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
};

describe("oauth_code authorizationParams", () => {
  it("accepts the Google set and keeps it in the parsed preset", () => {
    const params = {
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      hd: "example.com",
    };
    const r = ConnectorAuthSchema.parse({ ...manual, authorizationParams: params });
    expect(r).toMatchObject({ authorizationParams: params });
  });

  it("works with discovery mcp too", () => {
    const r = ConnectorAuthSchema.safeParse({
      type: "oauth_code",
      ownership: "personal",
      discovery: "mcp",
      client: "dcr",
      authorizationParams: { audience: "https://api.example.com" },
    });
    expect(r.success).toBe(true);
  });

  it.each(OAUTH_RESERVED_AUTHORIZATION_PARAMS)(
    "refuses the reserved name %s with its path and an actionable message",
    (name) => {
      expect(issuesOf({ ...manual, authorizationParams: { [name]: "x" } })).toEqual([
        {
          path: `authorizationParams.${name}`,
          message: `"${name}" is set by the kernel and cannot be an authorization parameter`,
        },
      ]);
    },
  );

  it("the reserved list covers the kernel's own names, JAR / PAR and token-endpoint names", () => {
    expect([...OAUTH_RESERVED_AUTHORIZATION_PARAMS].sort()).toEqual(
      [
        "response_type",
        "client_id",
        "redirect_uri",
        "state",
        "code_challenge",
        "code_challenge_method",
        "scope",
        "resource",
        "response_mode",
        "request",
        "request_uri",
        "nonce",
        "dpop_jkt",
        "authorization_details",
        "client_secret",
        "client_assertion",
        "client_assertion_type",
        "code",
        "code_verifier",
        "grant_type",
        "refresh_token",
      ].sort(),
    );
  });

  it.each([
    ["an uppercase name", { Access_type: "offline" }],
    ["a name starting with a digit", { "1prompt": "consent" }],
    ["a name with a dash", { "access-type": "offline" }],
    ["a 41-character name", { [`a${"b".repeat(40)}`]: "x" }],
    ["an empty value", { prompt: "" }],
    ["a non-printable value", { prompt: "consent\n" }],
    ["a non-ASCII value", { prompt: "consentë" }],
    ["a 201-character value", { prompt: "x".repeat(201) }],
    ["a non-string value", { prompt: 1 }],
  ])("refuses %s", (_label, params) => {
    expect(ConnectorAuthSchema.safeParse({ ...manual, authorizationParams: params }).success).toBe(
      false,
    );
  });

  it("accepts a 40-character name and a 200-character value", () => {
    const params = { [`a${"b".repeat(39)}`]: "x".repeat(200) };
    expect(ConnectorAuthSchema.safeParse({ ...manual, authorizationParams: params }).success).toBe(
      true,
    );
  });

  it("accepts 10 entries and refuses 11", () => {
    const params = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, "v"]));
    expect(
      ConnectorAuthSchema.safeParse({ ...manual, authorizationParams: params(10) }).success,
    ).toBe(true);
    expect(issuesOf({ ...manual, authorizationParams: params(11) })).toEqual([
      { path: "authorizationParams", message: "At most 10 authorization parameters" },
    ]);
  });

  it("is refused on oauth_client (the client-credentials flow has no authorize request)", () => {
    expect(
      ConnectorAuthSchema.safeParse({
        type: "oauth_client",
        ownership: "org",
        tokenUrl: "https://oauth2.example.com/token",
        authorizationParams: { audience: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("oauth_code manual authorizationUrl query", () => {
  it("keeps a query without reserved names", () => {
    const r = ConnectorAuthSchema.safeParse({
      ...manual,
      authorizationUrl: "https://accounts.example.com/auth?tenant=acme&access_type=offline",
    });
    expect(r.success).toBe(true);
  });

  it.each(["response_mode", "state", "request_uri", "scope"])(
    "refuses the reserved name %s in the query",
    (name) => {
      expect(
        issuesOf({ ...manual, authorizationUrl: `https://accounts.example.com/auth?${name}=x` }),
      ).toEqual([
        {
          path: "authorizationUrl",
          message: `"${name}" is set by the kernel and cannot be an authorization parameter`,
        },
      ]);
    },
  );

  it("compares query names without regard to case", () => {
    expect(
      issuesOf({
        ...manual,
        authorizationUrl: "https://accounts.example.com/auth?Response_Mode=x",
      }),
    ).toEqual([
      {
        path: "authorizationUrl",
        message: `"Response_Mode" is set by the kernel and cannot be an authorization parameter`,
      },
    ]);
  });
});
