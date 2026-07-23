import type { CSSProperties } from 'react';
import type { StatusMeta } from '../../shared/status-meta';

/**
 * 옵션 진행상태 배지 메타 (텍스트+색상 병기 — 색상 단독 금지).
 * 백엔드가 미등록 코드를 보내도 죽지 않도록 조회는 반드시 `metaOf()`를 쓴다.
 */
export const OPTION_STATUS_META: Record<string, StatusMeta> = {
  NOT_STARTED: { label: '미시작', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  REVIEW: { label: '확인대기', color: 'orange' },
  CONFIRMED: { label: '확정', color: 'green' },
};

/**
 * 선택지 사진 둘레의 흰 여백(액자 매트).
 * 사진이 카드 끝까지 꽉 차면 인화물처럼 보이지 않아, 인쇄 기준 5mm 남짓을 띄운다.
 * 96dpi 기준 5mm ≈ 19px이며, 작은 썸네일은 아래 배율로 줄여 쓴다.
 */
export const PHOTO_MAT_PX = 19;

/** 사진 둘레에 흰 여백을 두르는 공통 스타일. scale로 썸네일 크기에 맞춰 줄인다. */
export function photoMatStyle(scale = 1): CSSProperties {
  return {
    background: '#ffffff',
    padding: Math.round(PHOTO_MAT_PX * scale),
    borderRadius: 8,
    border: '1px solid #e8e8e8',
    boxSizing: 'border-box',
  };
}

/**
 * 선택지 이미지 대체용 placeholder 색상.
 * 이미지가 없는 MVP에서 choiceId 기반으로 항상 같은 색을 반환한다.
 */
export function choiceColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100_000;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 42%, 58%)`;
}
