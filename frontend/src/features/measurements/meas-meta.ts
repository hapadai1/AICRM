import type { StatusMeta } from '../../shared/status-meta';

/**
 * 채촌 배지 메타.
 * 백엔드가 카탈로그 밖 코드를 보내도 죽지 않도록 조회는 반드시 `metaOf()`를 쓴다.
 */

/** 채촌 구분 배지 메타 (measurementType) — 채촌을 하게 된 업무 단계로 표기한다. */
export const MEASUREMENT_TYPE_META: Record<string, StatusMeta> = {
  INITIAL: { label: '스타일 컨설팅', color: 'blue' },
  FITTING: { label: '가봉', color: 'purple' },
  REMEASURE: { label: '수선', color: 'orange' },
  OTHER: { label: '기타', color: 'default' },
};

/** 상태 배지 메타. 백엔드는 `completed: boolean`만 주므로 파생 코드로 조회한다. */
export const MEASUREMENT_STATUS_META: Record<string, StatusMeta> = {
  DRAFT: { label: '작성중', color: 'default' },
  COMPLETED: { label: '완료', color: 'green' },
};
