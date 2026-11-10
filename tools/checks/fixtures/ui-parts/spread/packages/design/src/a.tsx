// Parts passed as spread props: an object literal's "data-cap-part" key is checked like the
// attribute (an undeclared literal, a computed value), and a literal one counts as rendered.
const named = { "data-cap-part": "x.nope" };
export const A = () => <div {...named} />;
export const B = (p: { n: string }) => <div {...{ "data-cap-part": p.n }} />;
export const C = () => <div {...{ "data-cap-part": "x.one" }} />;
