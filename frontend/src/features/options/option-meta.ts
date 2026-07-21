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
