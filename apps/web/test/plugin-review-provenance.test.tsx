// The provenance fact of a plugin review is labelled as an unverified attestation: the kernel
// does not verify the SLSA signatures (packages/kernel/src/packages/provenance.ts).
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginReviewBody } from "../src/components/PluginReviewBody";
import type { PluginReview } from "../src/lib/catalog";
import { renderPage } from "./support/render";

afterEach(cleanup);

const review: PluginReview = {
  name: "demo",
  version: "1.0.0",
  contentDigest: "sha256:abc",
  packageName: "@acme/plugin-demo",
  publisher: "acme",
  description: "Demo",
  skills: [],
  connectorTemplates: [],
  dependencies: [],
  source: { kind: "npm", ref: "@acme/plugin-demo@1.0.0" },
  provenance: {
    checked: true,
    repository: "https://github.com/acme/demo",
    commit: "0123456789abcdef0123456789abcdef01234567",
    workflow: ".github/workflows/release.yml",
    buildType: "slsa",
  },
  sensitive: false,
  reviewHash: "h",
};

describe("PluginReviewBody provenance", () => {
  for (const [locale, text] of [
    ["en", "Attestation (not verified): built from"],
    ["zh", "声明（未验证）：由"],
  ] as const) {
    it(`labels the attestation as unverified (${locale})`, () => {
      renderPage(<PluginReviewBody review={review} />, { locale });
      expect(document.body.textContent).toContain(text);
    });
  }
});
