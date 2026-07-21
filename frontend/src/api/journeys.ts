import { request, type ListResult } from './client';

/**
 * 고객 진행 단계 API (개발설계서 05 G-11).
 *
 * 진행 단계는 사람이 관리하는 표시 레이어다. 제작 상태(order_items.status)와
 * 자동 연동하지 않으며, 단계 변경이 곧 고객 연락 트리거가 된다.
 * 코드값·응답 형태는 백엔드(`journeys.service.ts`)가 기준이다.
 */

/** 진행 트랙 — 상담 용도(usageType)와 1:1 대응 */
export type TrackType = 'CUSTOM' | 'RENTAL';

export const TRACK_TYPES: TrackType[] = ['CUSTOM', 'RENTAL'];

export const TRACK_TYPE_LABELS: Record<TrackType, string> = {
  CUSTOM: '비즈니스 맞춤',
  RENTAL: '웨딩패키지 렌탈',
};

export function trackTypeLabel(track: string): string {
  return TRACK_TYPE_LABELS[track as TrackType] ?? track;
}

export type JourneyStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export const JOURNEY_STATUS_META: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: '진행 중', color: 'blue' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export function journeyStatusMeta(status: string): { label: string; color: string } {
  return JOURNEY_STATUS_META[status] ?? { label: status, color: 'default' };
}

/** 단계 변경 시점의 고객 연락 처리 결과 */
export type NotificationOutcome = 'NONE' | 'SENT' | 'DEFERRED' | 'SKIPPED';

export const OUTCOME_META: Record<string, { label: string; color: string }> = {
  NONE: { label: '-', color: 'default' },
  SENT: { label: '발송', color: 'green' },
  DEFERRED: { label: '연락 대기', color: 'orange' },
  SKIPPED: { label: '생략', color: 'default' },
};

export interface JourneyStage {
  id: string;
  trackType: string;
  code: string;
  name: string;
  sequenceNo: number;
  /** 이 단계에 진입하면 고객 연락을 제안한다 */
  templateId: string | null;
  template?: { id: string; code: string; name: string; channel: string } | null;
}

/** 진행 요약 (고객 상세 카드·현황 보드 공용) */
export interface Journey {
  id: string;
  customerId: string;
  customerName: string;
  phone: string;
  orderId: string | null;
  orderNo: string | null;
  trackType: string;
  currentStageCode: string;
  currentStageName: string;
  currentStageSequenceNo: number | null;
  totalStages: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  version: number;
  updatedAt: string;
  /** 현재 단계에 머문 일수 (현황 보드에서만 내려온다) */
  daysInStage?: number;
}

export interface JourneyEvent {
  id: string;
  fromStageCode: string | null;
  toStageCode: string;
  reason: string | null;
  notes: string | null;
  notificationOutcome: NotificationOutcome;
  notificationHistoryId: string | null;
  changedAt: string;
  actor?: { id: string; displayName: string } | null;
}

export interface JourneyDetail extends Journey {
  stages: { code: string; name: string; sequenceNo: number; hasTemplate: boolean }[];
  events: JourneyEvent[];
}

/**
 * 단계 변경 응답에 실려 오는 발송 제안.
 * 화면은 이것으로 확인창을 띄우고, 담당자가 [발송]을 누를 때만 실제로 보낸다.
 */
export interface SuggestedNotification {
  eventId: string;
  templateId: string;
  templateCode: string;
  templateName: string;
  channel: string;
  recipientPhone: string;
  customerId: string;
  orderId: string | null;
  variables: Record<string, string>;
  renderedBody: string;
  /** 같은 진행의 같은 단계는 한 번만 발송된다 */
  triggerKey: string;
}

export interface ChangeStageResult {
  journey: Journey;
  event: JourneyEvent;
  suggestedNotification: SuggestedNotification | null;
}

/** GET /journey-stages */
export function fetchJourneyStages(trackType?: TrackType): Promise<JourneyStage[]> {
  return request<JourneyStage[]>({ url: '/journey-stages', params: { trackType } });
}

/**
 * PATCH /journey-stages/{id} — 단계에 붙일 연락 문구를 바꾼다.
 * null이면 그 단계에서는 연락을 제안하지 않는다.
 */
export function updateStageTemplate(id: string, templateId: string | null): Promise<JourneyStage> {
  return request<JourneyStage>({
    url: `/journey-stages/${id}`,
    method: 'PATCH',
    data: { templateId },
  });
}

/** GET /customers/{id}/journeys */
export function fetchCustomerJourneys(customerId: string): Promise<Journey[]> {
  return request<Journey[]>({ url: `/customers/${customerId}/journeys` });
}

/** POST /customers/{id}/journeys */
export function createJourney(
  customerId: string,
  body: { trackType: TrackType; orderId?: string; startStageCode?: string },
): Promise<Journey> {
  return request<Journey>({
    url: `/customers/${customerId}/journeys`,
    method: 'POST',
    data: body,
  });
}

/** GET /journeys/{id} */
export function fetchJourney(id: string): Promise<JourneyDetail> {
  return request<JourneyDetail>({ url: `/journeys/${id}` });
}

/** POST /journeys/{id}/stage — 되돌리기(후진)는 reason이 필수다. */
export function changeJourneyStage(
  id: string,
  body: { toStageCode: string; version: number; reason?: string; notes?: string },
): Promise<ChangeStageResult> {
  return request<ChangeStageResult>({
    url: `/journeys/${id}/stage`,
    method: 'POST',
    data: body,
  });
}

/** POST /journeys/{id}/events/{eventId}/notification-outcome */
export function setNotificationOutcome(
  journeyId: string,
  eventId: string,
  body: { outcome: NotificationOutcome; notificationHistoryId?: string },
): Promise<JourneyEvent> {
  return request<JourneyEvent>({
    url: `/journeys/${journeyId}/events/${eventId}/notification-outcome`,
    method: 'POST',
    data: body,
  });
}

export function completeJourney(id: string, version: number, reason?: string): Promise<Journey> {
  return request<Journey>({
    url: `/journeys/${id}/complete`,
    method: 'POST',
    data: { version, reason },
  });
}

export function cancelJourney(id: string, version: number, reason?: string): Promise<Journey> {
  return request<Journey>({
    url: `/journeys/${id}/cancel`,
    method: 'POST',
    data: { version, reason },
  });
}

export interface JourneyListParams {
  trackType?: TrackType;
  status?: JourneyStatus;
  /** 단계 코드 콤마 목록 */
  stageCodes?: string;
  customerId?: string;
  stalledDays?: number;
  page?: number;
  size?: number;
}

/** GET /journeys — 진행 현황 보드 */
export function fetchJourneys(params: JourneyListParams): Promise<ListResult<Journey>> {
  return request<ListResult<Journey>>({
    url: '/journeys',
    params: {
      trackType: params.trackType || undefined,
      status: params.status || undefined,
      stageCodes: params.stageCodes || undefined,
      customerId: params.customerId || undefined,
      stalledDays: params.stalledDays || undefined,
      page: params.page ?? 1,
      size: params.size ?? 100,
    },
  });
}
