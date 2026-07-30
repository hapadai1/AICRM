#!/usr/bin/env python3
"""
'해당 없음'처럼 상담 자료에 사진이 없는 선택지의 대체 이미지를 만든다.

OptionChoice.image_file_id는 NOT NULL이라 사진 없는 선택지를 넣을 수 없다.
그렇다고 옆 선택지 사진을 빌려 쓰면(예: 안감 등판 사진) 고객이 오해한다.
그래서 옷 사진이 아님이 한눈에 보이는 중립 이미지를 만들어 붙인다.
글자를 넣지 않는 이유 — 선택지 이름은 화면에서 사진 아래에 따로 나오고,
글자를 그리면 한글 폰트 경로에 의존해 실행 환경마다 결과가 달라진다.

실행: python3 prisma/assets/make-placeholder-images.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ASSET_DIR = Path(__file__).resolve().parent

# 같은 단계의 다른 사진과 크기를 맞춘다 (확인서 카드가 세로 비율을 그대로 쓴다).
TARGETS = [
    ("suit-design/VEST_BACK_C.jpg", (769, 1008)),
]

BACKGROUND = (250, 250, 250)
STROKE = (191, 191, 191)


def draw_none_mark(size: tuple[int, int]) -> Image.Image:
    """옅은 배경에 금지 표시(원 + 사선) 하나 — '해당 없음'을 뜻한다."""
    image = Image.new("RGB", size, BACKGROUND)
    draw = ImageDraw.Draw(image)

    width, height = size
    radius = min(width, height) // 5
    cx, cy = width // 2, height // 2
    thickness = max(4, radius // 12)

    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        outline=STROKE,
        width=thickness,
    )
    # 원 안을 가로지르는 45도 사선 (원 둘레에 정확히 닿게 반지름/√2 만큼)
    offset = int(radius * 0.7071)
    draw.line([cx - offset, cy + offset, cx + offset, cy - offset], fill=STROKE, width=thickness)
    return image


def main() -> None:
    for relative, size in TARGETS:
        path = ASSET_DIR / relative
        draw_none_mark(size).save(path, "JPEG", quality=92)
        print(f"생성: {path.relative_to(ASSET_DIR)} {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
