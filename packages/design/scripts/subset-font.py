#!/usr/bin/env python3
"""Subset the self-hosted fonts to woff2 (written to src/fonts/).

Families and their pinned sources (all SIL OFL-1.1; licenses next to the output in src/fonts/):

  sarasa           Sarasa Gothic v1.0.42, SarasaMonoSC-TTF-Unhinted-1.0.42.7z
                   (sha256 31a66b11f3d178aa35aedec8caf7988dbb0f08d01816130504ea8e510b8e8d98)
                     SarasaMonoSC-Regular.ttf  1be4cbf6e568b44fc83f1abe4c197884fb2b4a788a7c2eb78378b949680805b0
                     SarasaMonoSC-Bold.ttf     3f18d6f258f0814d6979a7da53499e0c12d548ae244c21bd630dfd2d08920dbe
                   license: src/fonts/OFL.txt
  inter            rsms/inter release v4.1, Inter-4.1.zip
                   (sha256 9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e)
                     extras/ttf/Inter-Regular.ttf  40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82
                     extras/ttf/Inter-Bold.ttf     288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f
                   license: src/fonts/OFL-Inter.txt
  source-han-sans  adobe-fonts/source-han-sans release 2.005R, 19_SourceHanSansCN.zip
                   (sha256 3a769d1b082ebd813cdb4c06ea57d29b340bce548edcc8e61976b78ca28e6236)
                     SubsetOTF/CN/SourceHanSansCN-Regular.otf  e2bc8a2e7f37474b774fff8db758681ece40bb6947a90d571bce9dd60671a8e4
                     SubsetOTF/CN/SourceHanSansCN-Bold.otf     62383707c086a32f3afd5e293f34c7eff64c7fea31f579fdc6cbe34d920519a6
                   served as the family "Source Han Sans SC" (fonts.css); license: src/fonts/OFL-SourceHanSans.txt

Requires: pip install fonttools brotli

Usage:
  python3 scripts/subset-font.py --build-charset            # regenerate charset.txt and charset-latin.txt
  python3 scripts/subset-font.py --family <name> <dir>      # subset one family from its unpacked
                                                            # source directory (the files above,
                                                            # flattened: Inter-Regular.ttf, ...)

charset.txt (Sarasa, Source Han Sans): ASCII 0x20-0x7E + the 3755 GB2312 level-1 hanzi + every
character in apps/web/messages/*.json and src/i18n.ts + the symbol table. Run --build-charset
first: new messages may have added characters, and both CJK families must cover the same set.
charset-latin.txt (Inter): 0x20-0x7E, 0xA0-0x17F, general punctuation 0x2010-0x206F, the
currency signs and the arrows.
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
ROOT = PKG.parent.parent
CHARSET = HERE / "charset.txt"
CHARSET_LATIN = HERE / "charset-latin.txt"
OUT = PKG / "src" / "fonts"

SYMBOLS = "▲▼▾▴●✓✗‖▌¥·…→←↑↓↵↻↗↕─│└⋯⌘⌕☰▦⚙∅⊘○⠿✕‹›–−"
LATIN_EXTRA = "₤€¥←↑→↓↵"

# family -> (source file pattern with {w}, output prefix, weights, charset, layout features)
FAMILIES = {
    "sarasa": ("SarasaMonoSC-{w}.ttf", "SarasaMonoSC", CHARSET, "*"),
    "inter": ("Inter-{w}.ttf", "Inter", CHARSET_LATIN, "kern,liga,calt,tnum"),
    "source-han-sans": ("SourceHanSansCN-{w}.otf", "SourceHanSansSC", CHARSET, "*"),
}
WEIGHTS = ["Regular", "Bold"]


def gb2312_level1() -> str:
    chars = []
    for hi in range(0xB0, 0xD8):  # rows 16-55 are the level-1 hanzi
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return "".join(chars)


def collect_ui_chars() -> str:
    files = sorted((ROOT / "apps" / "web" / "messages").glob("*.json"))
    files.append(PKG / "src" / "i18n.ts")
    return "".join(f.read_text(encoding="utf-8") for f in files)


def build_charset() -> str:
    chars = set(chr(c) for c in range(0x20, 0x7F))
    chars |= set(gb2312_level1())
    chars |= set(collect_ui_chars())
    chars |= set(SYMBOLS)
    chars -= set("\n\r\t")
    return "".join(sorted(chars))


def build_charset_latin() -> str:
    chars = set(chr(c) for c in range(0x20, 0x7F))
    chars |= set(chr(c) for c in range(0xA0, 0x180))
    chars |= set(chr(c) for c in range(0x2010, 0x2070))
    chars |= set(LATIN_EXTRA)
    return "".join(sorted(chars))


def write_charsets() -> None:
    for path, text in ((CHARSET, build_charset()), (CHARSET_LATIN, build_charset_latin())):
        path.write_text(text + "\n", encoding="utf-8")
        print(f"charset: {len(text)} characters -> {path}")


def subset(family: str, src: Path) -> None:
    pattern, prefix, charset, features = FAMILIES[family]
    OUT.mkdir(parents=True, exist_ok=True)
    for w in WEIGHTS:
        out = OUT / f"{prefix}-{w}.subset.woff2"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "fontTools.subset",
                str(src / pattern.format(w=w)),
                "--flavor=woff2",
                f"--layout-features={features}",
                f"--text-file={charset}",
                f"--output-file={out}",
            ],
            check=True,
        )
        print(f"{out.name}: {out.stat().st_size} bytes")


def main() -> None:
    args = sys.argv[1:]
    if args == ["--build-charset"]:
        write_charsets()
        return
    if len(args) == 3 and args[0] == "--family" and args[1] in FAMILIES:
        write_charsets()
        subset(args[1], Path(args[2]))
        return
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
