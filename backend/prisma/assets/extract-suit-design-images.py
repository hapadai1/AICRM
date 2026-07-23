#!/usr/bin/env python3
"""
정장 디자인 상담 PDF에서 옵션 선택지 사진을 뽑아 시드용 자산으로 저장한다.

PDF가 선택지 사진을 개별 임베디드 이미지로 갖고 있어서 화면 캡처가 아니라
원본을 그대로 쓴다. 다만 4개 페이지는 두 선택지가 한 장에 합쳐져 있어 중앙에서 자른다.

- 실행: python3 backend/prisma/assets/extract-suit-design-images.py
- 결과: backend/prisma/assets/suit-design/{stageCode}_{A|B|C}.jpg
- 필요: poppler(pdfimages), Pillow

한 번 돌려 자산을 만들어 두면 시드(seed-suit-design-options.ts)는 이 파일만 읽는다.
PDF가 바뀌었을 때만 다시 실행하면 된다.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PDF = ROOT / "docs" / "디자인 상담.pdf"
OUT = Path(__file__).resolve().parent / "suit-design"
WORK = OUT / ".work"

# 긴 변 기준 저장 크기. 화면에서 크게 보여주면서 저장소는 가볍게 유지한다.
MAX_LONG_EDGE = 900
JPEG_QUALITY = 88

# 사진 둘레에 구워 넣는 흰 여백(긴 변 대비 비율).
# CSS로만 주면 인쇄물·작업지시서 등 이미지 파일을 그대로 쓰는 곳에서는 사라지므로
# 파일 자체에 넣는다. 인화물의 매트처럼 보이도록 A4 출력 기준 5mm 남짓을 잡았다.
MARGIN_RATIO = 0.06

# 로고(357x357)·상단 검은 띠(2921x38)를 걸러내는 최소 크기
MIN_W, MIN_H = 250, 400

# (페이지, 단계코드, 선택지 수, 한 장에 합쳐져 있는지)
PAGES = [
    (3, "JACKET_BUTTON", 2, True),
    (4, "LAPEL", 3, False),
    (5, "POCKET", 3, False),
    (6, "VENT", 3, False),
    (7, "SLEEVE_BUTTON", 3, False),
    (8, "LAPEL_HOLE", 3, False),
    (9, "STITCH", 2, True),
    (10, "LINING", 3, False),
    (11, "TROUSER_PLEAT", 3, False),
    (12, "TROUSER_HEM", 2, True),
    (13, "TROUSER_WAIST", 2, True),
]

CODES = "ABC"


def extract_page(page: int) -> list[Path]:
    """한 페이지의 사진 후보를 왼→오 순서(=PDF 내 등장 순서)로 돌려준다."""
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
    return kept


def load_flat(path: Path, mask: Path | None) -> Image.Image:
    """smask를 알파로 합성한 뒤 흰 배경에 눕힌다(투명 배경이 검게 나오는 것 방지)."""
    im = Image.open(path).convert("RGB")
    if mask is None:
        return im
    with Image.open(mask) as m:
        alpha = m.convert("L").resize(im.size)
    canvas = Image.new("RGB", im.size, "white")
    canvas.paste(im, (0, 0), alpha)
    return canvas


def save(im: Image.Image, stage: str, code: str) -> None:
    w, h = im.size
    scale = MAX_LONG_EDGE / max(w, h)
    if scale < 1:
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

    # 흰 여백을 사방에 같은 두께로 두른다.
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

    for page, stage, count, combined in PAGES:
        print(f"p{page} {stage}")
        files = extract_page(page)
        # pdfimages는 이미지와 smask를 잇달아 뽑는다. 같은 크기로 붙어 나오면 짝으로 본다.
        pairs: list[tuple[Path, Path | None]] = []
        i = 0
        while i < len(files):
            with Image.open(files[i]) as a:
                size_a = a.size
            nxt = files[i + 1] if i + 1 < len(files) else None
            is_mask = False
            if nxt is not None:
                with Image.open(nxt) as b:
                    is_mask = b.size == size_a and b.mode in ("L", "1", "P")
            pairs.append((files[i], nxt if is_mask else None))
            i += 2 if is_mask else 1

        if combined:
            if len(pairs) != 1:
                sys.exit(f"p{page}: 합본 1장을 기대했는데 {len(pairs)}장입니다.")
            whole = load_flat(*pairs[0])
            w, h = whole.size
            mid = w // 2
            save(whole.crop((0, 0, mid, h)), stage, CODES[0])
            save(whole.crop((mid, 0, w, h)), stage, CODES[1])
        else:
            if len(pairs) != count:
                sys.exit(f"p{page}: 선택지 {count}장을 기대했는데 {len(pairs)}장입니다.")
            for idx, pair in enumerate(pairs):
                save(load_flat(*pair), stage, CODES[idx])

    for stale in WORK.glob("*.png"):
        stale.unlink()
    WORK.rmdir()
    print(f"\n완료 — {OUT}")


if __name__ == "__main__":
    main()
