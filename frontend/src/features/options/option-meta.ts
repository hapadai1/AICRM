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
 * 선택지 사진을 담는 틀.
 *
 * 흰 여백은 이미지 파일 자체에 구워져 있다(assets/extract-suit-design-images.py의
 * MARGIN_RATIO). 인쇄물이나 작업지시서처럼 파일을 그대로 쓰는 곳에서도 여백이
 * 따라가야 하기 때문이다. 그래서 여기서는 여백을 더 주지 않고 테두리만 두른다.
 */
export function photoFrameStyle(): CSSProperties {
  return {
    background: '#ffffff',
    borderRadius: 8,
    border: '1px solid #e8e8e8',
    overflow: 'hidden',
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
