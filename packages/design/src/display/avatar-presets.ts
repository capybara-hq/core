import type { TokenName } from "../tokens";

/** The ten preset ids, in the picker's order (agent profile design §2.3). */
export const AVATAR_PRESET_IDS = [
  "capybara",
  "black-bear",
  "panda",
  "elephant",
  "fox",
  "owl",
  "penguin",
  "rabbit",
  "turtle",
  "whale",
] as const;

export type PresetId = (typeof AVATAR_PRESET_IDS)[number];

/**
 * One pixel animal (spec §6.30): a 12×12 bitmap drawn like the logo (§3: solid squares,
 * `crispEdges`), its palette (a bitmap character to a color token) and its ground token. `.` and
 * `O` (an eye cut-out, as in the logo) are left to the ground.
 */
export type AvatarPreset = {
  bitmap: readonly string[];
  palette: Readonly<Record<string, TokenName>>;
  ground: TokenName;
};

/** The bitmaps are 12 cells square, all ten, so they align. */
export const AVATAR_GRID = 12;

export const AVATAR_PRESETS: Readonly<Record<PresetId, AvatarPreset>> = {
  // the logo's capybara (§3), facing right, in the brand accent
  capybara: {
    bitmap: [
      "............",
      "........X...",
      ".......XXX..",
      "..XXXXXXXXXX",
      ".XXXXXXXXOXX",
      ".XXXXXXXXXXX",
      ".XXXXXXXXXXX",
      ".XXXXXXXXXX.",
      "..XXXXXXXX..",
      "..XX.X..XX..",
      "..XX.X..XX..",
      "............",
    ],
    palette: { X: "accent" },
    ground: "avatar-capybara-ground",
  },
  // round ears, white eyes, a tan snout with a black nose
  "black-bear": {
    bitmap: [
      "............",
      ".XXX....XXX.",
      ".XSXXXXXXSX.",
      ".XXXXXXXXXX.",
      "XXXXXXXXXXXX",
      "XXXWXXXXWXXX",
      "XXXXXXXXXXXX",
      ".XXXSSSSXXX.",
      ".XXSSXXSSXX.",
      "..XSSSSSSX..",
      "...XXXXXX...",
      "............",
    ],
    palette: { X: "avatar-black", S: "avatar-black-bear-snout", W: "avatar-white" },
    ground: "avatar-black-bear-ground",
  },
  // a white face, black ears, eye patches and nose, on bamboo green
  panda: {
    bitmap: [
      "............",
      ".XXX....XXX.",
      ".XXWWWWWWXX.",
      ".XWWWWWWWWX.",
      "WWWWWWWWWWWW",
      "WWXXWWWWXXWW",
      "WXXWWWWWWXXW",
      "WWWWWWWWWWWW",
      ".WWWWXXWWWW.",
      "..WWWWWWWW..",
      "...WWWWWW...",
      "............",
    ],
    palette: { W: "avatar-white", X: "avatar-black" },
    ground: "avatar-panda-ground",
  },
  // side view: the ear, a tusk and the trunk hanging down
  elephant: {
    bitmap: [
      "............",
      "............",
      "....XXXXX...",
      "...XXXXXXXX.",
      "..XXXXXDXXXX",
      ".XXXXXXDXKXX",
      ".XXXXXXDXXXX",
      ".XXXXXXXXXWX",
      ".XXXXXXXXX.X",
      ".XX.XX.XX..X",
      ".XX.XX.XX...",
      "............",
    ],
    palette: {
      X: "avatar-elephant",
      D: "avatar-elephant-ear",
      K: "avatar-black",
      W: "avatar-white",
    },
    ground: "avatar-elephant-ground",
  },
  // pointed ears, white cheeks and a black nose at the tip of the muzzle
  fox: {
    bitmap: [
      "............",
      ".X........X.",
      ".XX......XX.",
      ".XDX....XDX.",
      ".XXXXXXXXXX.",
      "XXXXXXXXXXXX",
      "XXKXXXXXXKXX",
      "WXXXXXXXXXXW",
      ".WWXXXXXXWW.",
      "..WWWWWWWW..",
      "....WKKW....",
      "............",
    ],
    palette: { X: "avatar-fox", D: "avatar-fox-ear", W: "avatar-white", K: "avatar-black" },
    ground: "avatar-fox-ground",
  },
  // ear tufts, big yellow eyes, a beak, a pale belly and feet
  owl: {
    bitmap: [
      "............",
      ".X........X.",
      ".XXXXXXXXXX.",
      ".XYYYXXYYYX.",
      ".XYKYXXYKYX.",
      ".XYYYAAYYYX.",
      ".XXXXAAXXXX.",
      ".XBBBBBBBBX.",
      ".XBBBBBBBBX.",
      "..XBBBBBBX..",
      "...XXXXXX...",
      "...A....A...",
    ],
    palette: {
      X: "avatar-owl",
      Y: "avatar-owl-eye",
      K: "avatar-black",
      A: "avatar-beak",
      B: "avatar-owl-belly",
    },
    ground: "avatar-owl-ground",
  },
  // a black back and flippers, the white belly, a beak and feet
  penguin: {
    bitmap: [
      "............",
      "....XXXX....",
      "...XXXXXX...",
      "...XWXXWX...",
      "...XXAAXX...",
      "..XXWWWWXX..",
      ".XXWWWWWWXX.",
      ".XXWWWWWWXX.",
      "..XWWWWWWX..",
      "..XWWWWWWX..",
      "...XWWWWX...",
      "...AA..AA...",
    ],
    palette: { X: "avatar-black", W: "avatar-white", A: "avatar-beak" },
    ground: "avatar-penguin-ground",
  },
  // long ears with pink insides, a pink nose and a white muzzle
  rabbit: {
    bitmap: [
      "..XX....XX..",
      "..XP....PX..",
      "..XP....PX..",
      "..XP....PX..",
      "..XXXXXXXX..",
      ".XXXXXXXXXX.",
      ".XXKXXXXKXX.",
      ".XXXXXXXXXX.",
      ".XXXXPPXXXX.",
      "..XXWWWWXX..",
      "...XXXXXX...",
      "............",
    ],
    palette: { X: "avatar-rabbit", P: "avatar-rabbit-pink", K: "avatar-black", W: "avatar-white" },
    ground: "avatar-rabbit-ground",
  },
  // side view: a patterned shell, the head, tail and legs
  turtle: {
    bitmap: [
      "............",
      "............",
      "............",
      "...XXXXX....",
      "..XDXDXDX.LL",
      ".XXXXXXXXXLK",
      ".XDXDXDXDXLL",
      "LXXXXXXXXXL.",
      "..LL....LL..",
      "..LL....LL..",
      "............",
      "............",
    ],
    palette: {
      X: "avatar-turtle",
      D: "avatar-turtle-shell",
      L: "avatar-turtle-skin",
      K: "avatar-black",
    },
    ground: "avatar-turtle-ground",
  },
  // side view: the spout, the raised tail and a pale belly
  whale: {
    bitmap: [
      "............",
      "............",
      "......S.S...",
      ".......S....",
      "XX..XXXXXX..",
      ".XXXXXXXXXX.",
      "..XXXXXXXKXX",
      "..XXXXXXXXXX",
      "...XWWWWWWX.",
      "....XXXXXX..",
      "............",
      "............",
    ],
    palette: {
      X: "avatar-whale",
      W: "avatar-whale-belly",
      S: "avatar-whale-spout",
      K: "avatar-black",
    },
    ground: "avatar-whale-ground",
  },
};
