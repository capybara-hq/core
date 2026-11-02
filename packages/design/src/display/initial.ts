/**
 * The one avatar-tile rule (spec §6.17): the first grapheme of the display name, upper-cased (an
 * emoji or a CJK character stays whole). Org switcher, account row and object rows alike.
 */
export function initialOf(name: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next()
        .value?.segment
    : Array.from(name)[0];
  return (first ?? "").toUpperCase();
}
