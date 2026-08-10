/**
 * 작업지시서·채촌 배지 메타 — 정본은 중앙 사전(api/status-catalog)이다 (2026-08-05).
 * 여기 있던 정의는 채촌 화면(meas-meta)의 사본과 색이 어긋나 있어 사전으로 모았다.
 * 기존 소비처의 import 경로를 지키기 위해 재노출한다.
 * 조회는 반드시 `metaOf(맵, code)`로 한다.
 */
export { MEASUREMENT_TYPE_META, WORK_ORDER_STATUS_META } from '../../api/status-catalog';
