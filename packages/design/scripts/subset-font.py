#!/usr/bin/env python3
"""把更纱等宽黑体 SC 子集化为 woff2，自托管。

来源：Sarasa Gothic v1.0.42，发行包 SarasaMonoSC-TTF-Unhinted（OFL-1.1，许可证见 src/fonts/OFL.txt）。
依赖：pip install fonttools brotli

用法：
  python3 scripts/subset-font.py --build-charset          # 重新生成 scripts/charset.txt
  python3 scripts/subset-font.py <Sarasa 解压目录>          # 子集化，产物写到 src/fonts/
                                                          # （目录内需有 SarasaMonoSC-Regular.ttf / -Bold.ttf）

charset 构成：ASCII 0x20-0x7E + GB2312 一级汉字 3755 字 + apps/web/messages/*.json 与
src/i18n.ts 中出现的全部字符 + 符号表。
"""

import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
ROOT = PKG.parent.parent
CHARSET = HERE / "charset.txt"
OUT = PKG / "src" / "fonts"

SYMBOLS = "▲▼▾▴●✓✗‖▌¥·…→←↑↓↵↻↗↕─│└⋯⌘⌕☰▦⚙∅⊘○⠿✕‹›–−"
WEIGHTS = ["Regular", "Bold"]


def gb2312_level1() -> str:
    chars = []
    for hi in range(0xB0, 0xD8):  # 区 16-55 = 一级汉字
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


def main() -> None:
    args = sys.argv[1:]
    if args == ["--build-charset"]:
        text = build_charset()
        CHARSET.write_text(text + "\n", encoding="utf-8")
        print(f"charset: {len(text)} 字符 -> {CHARSET}")
        return
    if len(args) != 1:
        sys.exit(__doc__)
    src = Path(args[0])
    OUT.mkdir(parents=True, exist_ok=True)
    CHARSET.write_text(build_charset() + "\n", encoding="utf-8")
    for w in WEIGHTS:
        out = OUT / f"SarasaMonoSC-{w}.subset.woff2"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "fontTools.subset",
                str(src / f"SarasaMonoSC-{w}.ttf"),
                "--flavor=woff2",
                "--layout-features=*",
                f"--text-file={CHARSET}",
                f"--output-file={out}",
            ],
            check=True,
        )
        print(f"{out.name}: {out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
