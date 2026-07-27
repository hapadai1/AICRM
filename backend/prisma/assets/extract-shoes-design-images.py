#!/usr/bin/env python3
"""
구두 스타일 사진(docs/data/구두/*)을 시드용 자산으로 줄여 저장한다.

정장·셔츠는 상담 자료 한 장에서 선택지를 잘라 썼지만, 구두는 스타일마다 사진이
한 장씩 따로 있고 **파일명이 곧 스타일명**이다. 그래서 자를 것 없이 크기만 줄인다.
(원본은 4284x5712·6~10MB짜리 촬영본이라 그대로 쓰면 저장소·화면 모두 무겁다.)

- 실행: python3 backend/prisma/assets/extract-shoes-design-images.py
- 결과: backend/prisma/assets/shoes-design/{스타일명}.jpg
- 필요: Pillow

한 번 돌려 자산을 만들어 두면 시드(seed-shoes-design-options.ts)는 이 파일만 읽는다.
사진이 바뀌거나 스타일이 늘 때만 다시 실행하면 된다.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "docs" / "data" / "구두"
OUT = Path(__file__).resolve().parent / "shoes-design"

# 긴 변 기준 저장 크기. 화면에서 크게 보여주면서 저장소는 가볍게 유지한다.
MAX_LONG_EDGE = 1000
JPEG_QUALITY = 86

# 사진 둘레에 구워 넣는 여백(긴 변 대비 비율).
# CSS로만 주면 인쇄물·작업지시서처럼 이미지 파일을 그대로 쓰는 곳에서 사라지므로 파일에 넣는다.
# 구두 사진은 배경이 제각각이라 매트는 흰색으로 통일한다(정장·셔츠 자료와 같은 기준).
MARGIN_RATIO = 0.04
MARGIN_COLOR = "white"

SUFFIXES = (".jpg", ".jpeg", ".png")


def main() -> None:
    if not SRC.is_dir():
        sys.exit(f"원본 폴더가 없습니다: {SRC}")
    sources = sorted(p for p in SRC.iterdir() if p.suffix.lower() in SUFFIXES)
    if not sources:
        sys.exit(f"원본 사진이 없습니다: {SRC}")

    OUT.mkdir(parents=True, exist_ok=True)
    for path in sources:
        with Image.open(path) as raw:
            im = raw.convert("RGB")

        w, h = im.size
        scale = MAX_LONG_EDGE / max(w, h)
        if scale < 1:
            im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

        pad = round(max(im.size) * MARGIN_RATIO)
        matted = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), MARGIN_COLOR)
        matted.paste(im, (pad, pad))

        target = OUT / f"{path.stem}.jpg"
        matted.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True)
        print(f"  {target.name}  {matted.width}x{matted.height}  {target.stat().st_size // 1024}KB")

    print(f"\n완료 — {len(sources)}장 / {OUT}")


if __name__ == "__main__":
    main()
