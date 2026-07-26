#!/usr/bin/env python3
"""
셔츠 디자인 상담 자료(1장짜리 이미지)에서 옵션 선택지 사진을 잘라 시드용 자산으로 저장한다.

정장은 PDF에 선택지 사진이 개별 임베디드 이미지로 들어 있어 원본을 그대로 썼지만
(extract-suit-design-images.py), 셔츠는 한 장에 22개 사진이 격자로 박혀 있어 좌표로 자른다.
좌표는 원본(3241x1841)에서 사진 테두리를 밝기 투영으로 찾아 확정한 값이다.

- 실행: python3 backend/prisma/assets/extract-shirt-design-images.py
- 결과: backend/prisma/assets/shirt-design/{stageCode}_{A~E}.jpg
- 필요: Pillow

한 번 돌려 자산을 만들어 두면 시드(seed-shirt-design-options.ts)는 이 파일만 읽는다.
원본 이미지가 바뀌었을 때만 다시 실행하면 된다.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "docs" / "data" / "셔츠디자인 상담_페이지_14.jpg"
OUT = Path(__file__).resolve().parent / "shirt-design"

# 좌표를 재는 기준 크기. 원본이 다른 해상도로 바뀌어도 같은 자리를 자르도록 비례 보정한다.
REF_W, REF_H = 3241, 1841

# 긴 변 기준 저장 크기. 화면에서 크게 보여주면서 저장소는 가볍게 유지한다.
MAX_LONG_EDGE = 900
JPEG_QUALITY = 88

# 사진 둘레에 구워 넣는 여백(긴 변 대비 비율) — A4 출력 기준 5mm 남짓.
# CSS로만 주면 인쇄물·작업지시서처럼 이미지 파일을 그대로 쓰는 곳에서 사라지므로 파일에 넣는다.
# 원본 자료가 검은 배경이라 매트 색도 검정으로 맞춘다.
MARGIN_RATIO = 0.06
MARGIN_COLOR = "black"

# (단계코드, [(선택지명, (left, top, right, bottom)) ...]) — 원본 픽셀 좌표
# 왼쪽 패널 3줄(카라) + 오른쪽 패널 커프스 1줄 + 더블 커프스 1줄.
COL_X = [(70, 320), (333, 582), (595, 843), (856, 1106), (1119, 1368)]
CUFF_X = [(1446, 1780), (1799, 2133), (2151, 2486), (2503, 2837), (2857, 3191)]


def row(names: list[str], top: int, bottom: int, xs: list[tuple[int, int]]) -> list[tuple[str, tuple[int, int, int, int]]]:
    return [(name, (x0, top, x1, bottom)) for name, (x0, x1) in zip(names, xs)]


STAGES: list[tuple[str, list[tuple[str, tuple[int, int, int, int]]]]] = [
    (
        "SHIRT_COLLAR_SPREAD",
        row(["레귤러 카라", "세미와이드", "와이드", "180도 와이드", "220도 와이드"], 366, 716, COL_X),
    ),
    (
        "SHIRT_COLLAR_DETAIL",
        row(["버튼다운", "투버튼 와이드 카라", "핀홀 카라", "탭 카라", "스냅 카라"], 876, 1211, COL_X),
    ),
    (
        "SHIRT_COLLAR_SPECIAL",
        row(["속고리 단추", "라운드 카라", "숏 칼라", "윙 카라", "차이나 카라"], 1396, 1697, COL_X),
    ),
    (
        "SHIRT_CUFF",
        row(
            ["라운드 커프스", "스퀘어 커프스", "앵글 커프스", "스퀘어 투버튼 커프스", "독일식 커프스"],
            362,
            843,
            CUFF_X,
        ),
    ),
    (
        "SHIRT_DOUBLE_CUFF",
        [
            ("더블소매 굴림", (1980, 1067, 2314, 1519)),
            ("더블소매 사각", (2417, 1067, 2749, 1517)),
        ],
    ),
]

CODES = "ABCDE"


def save(im: Image.Image, stage: str, code: str, name: str) -> None:
    w, h = im.size
    scale = MAX_LONG_EDGE / max(w, h)
    if scale < 1:
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

    # 여백을 사방에 같은 두께로 두른다.
    pad = round(max(im.size) * MARGIN_RATIO)
    matted = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), MARGIN_COLOR)
    matted.paste(im, (pad, pad))
    im = matted

    target = OUT / f"{stage}_{code}.jpg"
    im.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"  {target.name}  {im.width}x{im.height}  {name}")


def main() -> None:
    if not SRC.exists():
        sys.exit(f"원본 이미지가 없습니다: {SRC}")
    OUT.mkdir(parents=True, exist_ok=True)

    with Image.open(SRC) as raw:
        source = raw.convert("RGB")
    sx, sy = source.width / REF_W, source.height / REF_H
    if abs(sx - sy) > 0.02:
        sys.exit(f"원본 비율이 기준({REF_W}x{REF_H})과 다릅니다: {source.size} — 좌표를 다시 잡으세요.")

    for stage, choices in STAGES:
        print(stage)
        for i, (name, box) in enumerate(choices):
            left, top, right, bottom = box
            scaled = (round(left * sx), round(top * sy), round(right * sx), round(bottom * sy))
            save(source.crop(scaled), stage, CODES[i], name)

    print(f"\n완료 — {OUT}")


if __name__ == "__main__":
    main()
