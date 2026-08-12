import { request, type ListResult } from './client';
import { REPAIR_STATUS_FLOW, type RepairStatus } from './repairs';

/**
 * 고객 진행 단계 API (개발설계서 05 G-11).
 *
 * 진행 단계는 사람이 관리하는 표시 레이어다. 제작 상태(order_items.status)와
 * 자동 연동하지 않으며, 단계 변경이 곧 고객 연락 트리거가 된다.
 * 코드값·응답 형태는 백엔드(`journeys.service.ts`)가 기준이다.
 */

/** 진행 트랙 — CUSTOM/RENTAL은 상담 용도(usageType)와 대응, REPAIR는 수선 접수에서 시작(설계서 v2 02 §2.2) */
export type TrackType = 'CUSTOM' | 'RENTAL' | 'REPAIR';

export const TRACK_TYPES: TrackType[] = ['CUSTOM', 'RENTAL', 'REPAIR'];

export const TRACK_TYPE_LABELS: Record<TrackType, string> = {
  CUSTOM: '비즈니스 맞춤',
  RENTAL: '웨딩패키지 렌탈',
  REPAIR: '수선',
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

/**
 * 시점에 붙은 연락 문구. 문구는 시점 하나에만 붙으므로(2026-07-29) 단계 조회에 본문까지 실려 온다 —
 * 관리 화면이 문구 목록을 따로 받지 않는다.
 */
export interface StageMessage {
  id: string;
  code: string;
  name: string;
  channel: 'ALIMTALK' | 'SMS';
  body: string;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
}

export interface JourneyStage {
  id: string;
  trackType: string;
  code: string;
  name: string;
  sequenceNo: number;
  /** 이 단계에 진입하면 고객 연락을 제안한다 */
  templateId: string | null;
  template?: StageMessage | null;
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

/** 단계 완료 방식 — AUTO(자동완료·수동버튼 없음) | GATED(품목 전수완료 후 [전체 완료] 활성) */
export type StageCompletionMode = 'AUTO' | 'GATED';

/**
 * GET /journeys/:id 의 stages 항목 (설계서 v2 02 §6.2).
 * 게이팅(품목 완료 집계)과 완료 이력(상태·완료일·비고 3종)을 함께 내려준다.
 */
export interface JourneyStageView {
  code: string;
  name: string;
  sequenceNo: number;
  hasTemplate: boolean;
  completionMode: StageCompletionMode;
  /** 대상 품목 수 */
  targetCount: number;
  /** 완료(revoke 안 된) 품목 수 */
  completedCount: number;
  /** [전체 완료] 활성 여부(전 품목 완료 시 true) */
  canComplete: boolean;
  /** 이 단계를 완료(떠남)했는지 */
  completed: boolean;
  /** 완료일 = 그 단계를 떠난 최신 이벤트의 changedAt */
  completedAt: string | null;
  /** 비고 = 그 단계를 떠난 최신 이벤트의 notes */
  notes: string | null;
}

export interface JourneyDetail extends Journey {
  stages: JourneyStageView[];
  events: JourneyEvent[];
  /** 현재 단계가 연락 단계이고 아직 발송 전이면 실려 온다 (상시 [고객 연락] 버튼용) */
  currentSuggestion: SuggestedNotification | null;
}

/** 품목별 완료의 대상 종류 (다형 참조) */
export type CompletionTargetType = 'ORDER_ITEM' | 'REPAIR_ITEM';

/** 단계 게이팅 현황 — 품목 완료 클릭·전진 응답에 실려 온다 */
export interface StageGating {
  stageCode: string;
  targetCount: number;
  completedCount: number;
  canComplete: boolean;
}

/** 단계 대상 품목 1건 (완료 체크리스트의 행) */
export interface StageItem {
  targetId: string;
  targetType: CompletionTargetType;
  displayName: string;
  productCategory: string | null;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  /**
   * 품목 상태 힌트(읽기 전용, 완료를 자동 생성하지 않음).
   * 원천은 대상 유형에 따라 다르다 — ORDER_ITEM은 제작 상태, REPAIR_ITEM은 수선 상태.
   */
  productionHint: { status: string | null } | null;
}

/**
 * REPAIR 트랙 단계에 대응하는 수선 상태(통합설계서 §12.1 6단계) — **화면 힌트 전용**.
 *
 * 두 레이어는 자동 연동하지 않는다(설계서 v2 02 §3.3 — 완료 원천은 담당자가 누른 기록).
 * 다만 수선 상태가 이미 그 단계를 지났는데 진행 카드의 품목 완료가 비어 있으면
 * 담당자가 누락한 것이므로, "누를 차례"임을 표시해 이중 입력의 부담을 줄인다.
 */
const REPAIR_STAGE_REACHED_AT: Record<string, RepairStatus> = {
  REPAIR_REQUESTED: 'REQUESTED',
  REPAIR_CHECKED_IN: 'RETURNED_TO_SHOP',
  REPAIR_RELEASED: 'RELEASED',
};

/** 수선 상태가 이 단계에 도달했는가. 취소·미등록 코드는 흐름 밖이므로 false. */
export function repairStageReached(stageCode: string, repairStatus: string | null): boolean {
  const need = REPAIR_STAGE_REACHED_AT[stageCode];
  if (!need || !repairStatus) return false;
  const at = REPAIR_STATUS_FLOW.indexOf(repairStatus as RepairStatus);
  return at >= 0 && at >= REPAIR_STATUS_FLOW.indexOf(need);
}

/** GET /journeys/:id/stages/:stageCode/items */
export interface StageItemsResult {
  stageCode: string;
  completionMode: StageCompletionMode;
  items: StageItem[];
  gating: StageGating;
}

/** POST .../complete 응답 */
export interface CompleteItemResult {
  completion: {
    targetId: string;
    targetType: CompletionTargetType;
    completedAt: string;
    completedBy: string;
  };
  gating: StageGating;
}

/**
 * 단계 변경 응답에 실려 오는 발송 제안.
 * 화면은 이것으로 확인창을 띄우고, 담당자가 [발송]을 누를 때만 실제로 보낸다.
 */
export interface SuggestedNotification {
  eventId: string;
  /** 이 문구가 어느 단계의 완료를 알리는지 — 확인창 제목용 (예: '가봉 입고') */
  stageName: string;
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
 * PUT /journey-stages/{id}/message — 그 시점에 보낼 문구를 쓴다.
 * 없으면 만들어 붙이고, 있으면 본문·채널·승인을 고친다(코드·이름은 서버가 단계에서 만든다).
 */
export function putStageMessage(
  id: string,
  input: { body: string; channel: 'ALIMTALK' | 'SMS'; approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' },
): Promise<JourneyStage> {
  return request<JourneyStage>({ url: `/journey-stages/${id}/message`, method: 'PUT', data: input });
}

/** DELETE /journey-stages/{id}/message — 그 시점의 연락을 끄고 문구를 지운다(발송 이력은 남는다). */
export function deleteStageMessage(id: string): Promise<JourneyStage> {
  return request<JourneyStage>({ url: `/journey-stages/${id}/message`, method: 'DELETE' });
}

/**
 * PATCH /journey-stages/{id} — 단계에 붙일 문구를 기존 문구로 바꾼다.
 * null이면 그 단계에서는 연락을 제안하지 않는다. 관리 화면은 위 message 경로를 쓴다.
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

/** GET /journeys/{id}/stages/{stageCode}/items — 단계 대상 품목 + 완료상태 + 게이팅 */
export function getStageItems(id: string, stageCode: string): Promise<StageItemsResult> {
  return request<StageItemsResult>({
    url: `/journeys/${id}/stages/${encodeURIComponent(stageCode)}/items`,
  });
}

/** POST /journeys/{id}/stages/{stageCode}/items/{targetId}/complete — 품목 완료(멱등) */
export function completeStageItem(
  id: string,
  stageCode: string,
  targetId: string,
  body?: { notes?: string },
): Promise<CompleteItemResult> {
  return request<CompleteItemResult>({
    url: `/journeys/${id}/stages/${encodeURIComponent(stageCode)}/items/${targetId}/complete`,
    method: 'POST',
    data: body ?? {},
  });
}

/** POST /journeys/{id}/stages/{stageCode}/items/{targetId}/uncomplete — 완료 취소 */
export function uncompleteStageItem(
  id: string,
  stageCode: string,
  targetId: string,
): Promise<{ gating: StageGating }> {
  return request<{ gating: StageGating }>({
    url: `/journeys/${id}/stages/${encodeURIComponent(stageCode)}/items/${targetId}/uncomplete`,
    method: 'POST',
  });
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
