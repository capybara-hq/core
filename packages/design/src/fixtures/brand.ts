/**
 * The fixture brand (theme brand coverage spec §3; visual cases of PR 2): a made-up "BRAND KIT"
 * theme whose graphics are inline SVG data URIs, so `/dev/ui/brand/fixture` and the reference set
 * draw a theme's mark and illustration without a kernel. The built-in tokens stay; theme tokens
 * are covered by the e2e suite. The files carry their own colour, as a theme's file would (a named
 * one: the design's colours come only from tokens); the empty state uses only their shape (a mask).
 */
import type { Brand } from "../provider";

const svg = (viewBox: string, body: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`,
  )}`;

/** A 2:1 mark (a kite and two bars): wide enough to show the 3 × height cap is not reached. */
export const FIXTURE_BRAND_MARK = svg(
  "0 0 40 20",
  '<g fill="teal"><path d="M10 0 20 10 10 20 0 10z"/><rect x="23" y="3" width="17" height="5"/>' +
    '<rect x="23" y="12" width="12" height="5"/></g>',
);

/** A 8:5 illustration (a sun over two hills), the empty state's art. */
export const FIXTURE_BRAND_ILLUSTRATION = svg(
  "0 0 96 60",
  '<g fill="teal"><circle cx="66" cy="18" r="10"/><path d="M0 60 30 26 52 48 70 34 96 60z"/></g>',
);

/** The fixture theme's brand: mark, illustration, wordmark `BRAND KIT`, no sign-in decoration. */
export const FIXTURE_BRAND: Brand = {
  markUrl: FIXTURE_BRAND_MARK,
  wordmark: "BRAND KIT",
  illustrationUrl: FIXTURE_BRAND_ILLUSTRATION,
  decoration: "none",
  productName: "Brand Kit",
};
