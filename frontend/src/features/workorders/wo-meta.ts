import type { StatusMeta } from '../../shared/status-meta';

/**
 * 작업지시서 상태 배지 메타 (WO-001).
 * 백엔드가 보내는 상태는 4종이지만 필터로 보낼 수 있는 값은 3종뿐이다(api/workorders.ts 참고).
 * 조회는 반드시 `metaOf(WORK_ORDER_STATUS_META, code)`로 한다.
 */
export const WORK_ORDER_STATUS_META: Record<string, StatusMeta> = {
  WAITING: { label: '준비 미완', color: 'default' },
  UNORDERED: { label: '미주문', color: 'red' },
  REPRINT_NEEDED: { label: '재출력 필요', color: 'orange' },
  CURRENT: { label: '최신', color: 'green' },
};

/** 출력 버전 상태 (work_order_versions.status) */
export const WORK_ORDER_VERSION_STATUS_META: Record<string, StatusMeta> = {
  ISSUED: { label: '유효', color: 'green' },
  SENT: { label: '발송', color: 'blue' },
  SUPERSEDED: { label: '이전본', color: 'default' },
};

/** 채촌 유형 (measurement_sessions.measurement_type) */
export const MEASUREMENT_TYPE_META: Record<string, StatusMeta> = {
  INITIAL: { label: '스타일 컨설팅', color: 'blue' },
  FITTING: { label: '가봉', color: 'gold' },
  REMEASURE: { label: '수선', color: 'purple' },
  OTHER: { label: '기타', color: 'default' },
};
