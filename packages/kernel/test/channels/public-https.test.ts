import { describe, expect, it } from "vitest";
import { isPublicHttpsUrl } from "../../src/channels/connections.service.js";

// Channel inbound mode fields spec §4: whether the webhook base URL is a public https address.
describe("isPublicHttpsUrl", () => {
  it("accepts https on a public name or IP", () => {
    expect(isPublicHttpsUrl("https://im.example.com")).toBe(true);
    expect(isPublicHttpsUrl("https://im.example.com:8443/base/")).toBe(true);
    expect(isPublicHttpsUrl("https://8.8.8.8")).toBe(true);
  });

  it("refuses http, loopback, private and local names", () => {
    for (const url of [
      "http://im.example.com",
      "https://localhost:3000",
      "https://app.localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.5",
      "https://192.168.1.20",
      "https://172.16.0.1",
      "https://169.254.169.254",
      "https://[fd00::1]",
      "https://capybara.local",
      "https://capybara.internal",
      "https://intranet",
      "not a url",
    ]) {
      expect(isPublicHttpsUrl(url), url).toBe(false);
    }
  });
});
