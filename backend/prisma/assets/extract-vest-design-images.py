#!/usr/bin/env python3
"""
베스트 상담 PDF에서 베스트 옵션 선택지 사진을 뽑아 시드용 자산으로 저장한다.

자켓·바지 자산(extract-suit-design-images.py)과 같은 규격으로 저장해
seed-suit-design-options.ts가 두 자산을 구분 없이 읽을 수 있게 한다.

PDF는 3페이지이고 페이지마다 두 선택지가 한 장에 합쳐진 사진 1장을 갖는다.
중앙에서 잘라 좌/우를 각각 쓴다.

- 실행: python3 backend/prisma/assets/extract-vest-design-images.py
- 결과: backend/prisma/assets/suit-design/VEST_{LAPEL|STITCH|BACK}_{A|B}.jpg
- 필요: poppler(pdfimages), Pillow

한 번 돌려 자산을 만들어 두면 시드는 이 파일만 읽는다.
PDF가 바뀌었을 때만 다시 실행하면 된다.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PDF = ROOT / "docs" / "data" / "베스트 상담 자료.pdf"
OUT = Path(__file__).resolve().parent / "suit-design"
WORK = OUT / ".work-vest"

# 자켓 자산과 같은 규격 — 화면에서 나란히 놓았을 때 크기·여백이 어긋나지 않게.
MAX_LONG_EDGE = 900
JPEG_QUALITY = 88
MARGIN_RATIO = 0.06

# 로고(357x357)·상단 검은 띠(2921x38)를 걸러내는 최소 크기
MIN_W, MIN_H = 250, 400

# (페이지, 좌/우, 단계코드, 선택지코드)
#
# 스티치 A(스티치 없음)는 1페이지 왼쪽을 다시 쓴다. 2페이지 두 장은 모두 스티치가
# 들어간 사진이라 '없음' 짝이 그 안에 없다. 같은 라펠없음 베스트의 무/유를 짝지어야
# 스티치 차이만 눈에 들어온다(2페이지 오른쪽은 라펠까지 달라 대조가 흐려진다).
CROPS = [
    (1, "L", "VEST_LAPEL", "A"),  # 라펠없음
    (1, "R", "VEST_LAPEL", "B"),  # 라펠있음
    (1, "L", "VEST_STITCH", "A"),  # 스티치 없음
    (2, "L", "VEST_STITCH", "B"),  # 스티치 추가
    (3, "L", "VEST_BACK", "A"),  # 안감 등판
    (3, "R", "VEST_BACK", "B"),  # 제원단 등판
]


def page_image(page: int) -> Image.Image:
    """한 페이지의 합본 사진 1장을 흰 배경에 눕혀 돌려준다."""
    prefix = WORK / f"p{page:02d}"
    subprocess.run(
        ["pdfimages", "-f", str(page), "-l", str(page), "-png", str(PDF), str(prefix)],
        check=True,
        capture_output=True,
    )

    kept = []
    for f in sorted(WORK.glob(f"p{page:02d}-*.png")):
        with Image.open(f) as im:
            if im.width < MIN_W or im.height < MIN_H:
                f.unlink()
                continue
        kept.append(f)

    # pdfimages는 이미지와 smask를 잇달아 뽑는다. 같은 크기로 붙어 나오면 짝으로 본다.
    if len(kept) != 2:
        sys.exit(f"p{page}: 사진 1장(+마스크)을 기대했는데 {len(kept)}개입니다.")
    photo, mask = kept

    im = Image.open(photo).convert("RGB")
    with Image.open(mask) as m:
        if m.size != im.size or m.mode not in ("L", "1", "P"):
            return im
        alpha = m.convert("L").resize(im.size)
    canvas = Image.new("RGB", im.size, "white")
    canvas.paste(im, (0, 0), alpha)
    return canvas


def save(im: Image.Image, stage: str, code: str) -> None:
    w, h = im.size
    scale = MAX_LONG_EDGE / max(w, h)
    if scale < 1:
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

    pad = round(max(im.size) * MARGIN_RATIO)
    matted = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), "white")
    matted.paste(im, (pad, pad))
    im = matted

    target = OUT / f"{stage}_{code}.jpg"
    im.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"  {target.name}  {im.width}x{im.height}")


def main() -> None:
    if not PDF.exists():
        sys.exit(f"PDF가 없습니다: {PDF}")
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    for stale in WORK.glob("*.png"):
        stale.unlink()

    # 같은 페이지를 여러 선택지가 쓰므로 한 번만 읽는다.
    pages: dict[int, Image.Image] = {}
    for page, side, stage, code in CROPS:
        if page not in pages:
            print(f"p{page}")
            pages[page] = page_image(page)
        whole = pages[page]
        w, h = whole.size
        mid = w // 2
        box = (0, 0, mid, h) if side == "L" else (mid, 0, w, h)
        save(whole.crop(box), stage, code)

    for stale in WORK.glob("*.png"):
        stale.unlink()
    WORK.rmdir()
    print(f"\n완료 — {OUT}")


if __name__ == "__main__":
    main()
