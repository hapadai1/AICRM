/**
 * MSG-001 고객 연락·발송 이력 API
 * 백엔드(notifications 모듈)는 DB 컬럼 형태(code/body/approvalStatus/recipientPhone …)를
 * 그대로 반환하므로, 이 파일에서 화면용 형태로 매핑한다.
 */
import { request } from './client';
import { toDateTime } from './transform';
import type { ListResult } from './client';
import type { StatusMeta } from '../shared/status-meta';

export interface CustomerSearchItem {
  id: string;
  name: string;
  phone: string;
  customerStatus: 'PROSPECT' | 'CONTRACTED' | 'INACTIVE';
}

export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED';
export type NotificationChannel = 'ALIMTALK' | 'SMS';
/** 발송 이력 상태 — 백엔드 notification_history.status */
export type NotificationStatus = 'REQUESTED' | 'SENT' | 'FAILED';

export const TEMPLATE_STATUS_META: Record<string, StatusMeta> = {
  APPROVED: { label: '승인', color: 'green' },
  PENDING: { label: '검수중', color: 'gold' },
  REJECTED: { label: '반려', color: 'red' },
};

export const NOTIFICATION_STATUS_META: Record<string, StatusMeta> = {
  REQUESTED: { label: '발송 요청', color: 'blue' },
  SENT: { label: '성공', color: 'green' },
  FAILED: { label: '실패', color: 'red' },
};

export const NOTIFICATION_CHANNEL_META: Record<string, StatusMeta> = {
  ALIMTALK: { label: '알림톡', color: 'gold' },
  SMS: { label: 'SMS', color: 'blue' },
};

export interface NotificationTemplate {
  id: string;
  code: string;
  name: string;
  channel: NotificationChannel;
  status: TemplateStatus;
  content: string;
  variables: string[];
}

export interface NotificationRecord {
  id: string;
  customerId: string;
  phone: string;
  channel: NotificationChannel;
  templateId?: string;
  templateName: string;
  content: string;
  status: NotificationStatus;
  failReason?: string;
  /** 발송 성공 시각(YYYY-MM-DD HH:mm). 미발송 건은 undefined. */
  sentAt?: string;
  /** 이력 생성 시각(YYYY-MM-DD HH:mm). */
  createdAt?: string;
  /** 재시도·대체 발송인 경우 원본 이력 id. */
  retryOfId?: string;
}

export interface SendNotificationInput {
  customerId: string;
  phone: string;
  templateId: string;
  variables: Record<string, string>;
  fallbackSms: boolean;
  orderId?: string;
  /**
   * 중복 발송 방지 키. 같은 키로 재요청하면 백엔드가 최초 발송 결과를 그대로 돌려준다.
   * 진행 단계 발송은 `journey:{journeyId}:{stageCode}`를 쓴다 (개발설계서 05 G-06).
   */
  triggerKey?: string;
}

// --- 백엔드 원본 응답 타입 -----------------------------------------------------

interface RawTemplate {
  id: string;
  code: string;
  name: string;
  channel: string;
  body: string;
  approvalStatus: string;
}

interface RawHistory {
  id: string;
  customerId: string;
  templateId: string | null;
  recipientPhone: string;
  channel: string;
  body: string | null;
  status: string; // SENT | FAILED
  errorMessage: string | null;
  sentAt: string | null;
  retryOfId: string | null;
  createdAt: string;
  template?: { code: string; name: string; channel: string } | null;
}

/** 발송 API 응답의 개별 결과 항목. */
interface RawSendResult {
  id: string;
  templateId: string;
  templateCode: string;
  templateName: string;
  channel: string;
  customerId: string;
  recipientPhone: string;
  status: string;
  errorMessage: string | null;
  sentAt: string | null;
  retryOfId: string | null;
  renderedBody: string;
}

/** 템플릿 본문의 치환 변수(`#{이름}` / `{{이름}}`)를 순서대로 중복 없이 추출한다. */
export function extractTemplateVariables(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(/#\{([^}]+)\}|\{\{([^}]+)\}\}/g)) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function toChannel(value?: string | null): NotificationChannel {
  return value === 'SMS' ? 'SMS' : 'ALIMTALK';
}

function toTemplateStatus(value?: string | null): TemplateStatus {
  return value === 'APPROVED' || value === 'REJECTED' ? value : 'PENDING';
}

function toNotificationStatus(value?: string | null): NotificationStatus {
  return value === 'SENT' || value === 'FAILED' ? value : 'REQUESTED';
}

function mapTemplate(raw: RawTemplate): NotificationTemplate {
  return {
    id: raw.id,
    code: raw.code,
    name: raw.name || raw.code,
    channel: toChannel(raw.channel),
    status: toTemplateStatus(raw.approvalStatus),
    content: raw.body,
    variables: extractTemplateVariables(raw.body ?? ''),
  };
}

function mapHistory(raw: RawHistory): NotificationRecord {
  return {
    id: raw.id,
    customerId: raw.customerId,
    phone: raw.recipientPhone,
    channel: toChannel(raw.channel ?? raw.template?.channel),
    templateId: raw.templateId ?? undefined,
    templateName: raw.template?.name ?? raw.template?.code ?? '-',
    content: raw.body ?? '',
    status: toNotificationStatus(raw.status),
    failReason: raw.errorMessage ?? undefined,
    sentAt: toDateTime(raw.sentAt),
    createdAt: toDateTime(raw.createdAt),
    retryOfId: raw.retryOfId ?? undefined,
  };
}

function mapSendResult(raw: RawSendResult): NotificationRecord {
  return {
    id: raw.id,
    customerId: raw.customerId,
    phone: raw.recipientPhone,
    channel: toChannel(raw.channel),
    templateId: raw.templateId,
    templateName: raw.templateName || raw.templateCode,
    content: raw.renderedBody,
    status: toNotificationStatus(raw.status),
    failReason: raw.errorMessage ?? undefined,
    sentAt: toDateTime(raw.sentAt),
    retryOfId: raw.retryOfId ?? undefined,
  };
}

/** 고객 검색 공통 파라미터: q + status=ALL (계약 문서 04 §2) */
export function searchCustomers(query: string): Promise<ListResult<CustomerSearchItem>> {
  return request<ListResult<CustomerSearchItem>>({
    url: '/customers',
    params: { q: query || undefined, status: 'ALL', page: 1, size: 30 },
  });
}

export async function fetchNotificationTemplates(): Promise<NotificationTemplate[]> {
  const raw = await request<RawTemplate[]>({ url: '/notification-templates' });
  return (raw ?? []).map(mapTemplate);
}

/** 미리보기 — 백엔드는 `renderedBody`(치환 완료 본문)를 돌려준다. */
export async function previewNotification(payload: {
  templateId: string;
  variables: Record<string, string>;
}): Promise<{ content: string; channel: NotificationChannel }> {
  const raw = await request<{
    templateId: string;
    templateCode: string;
    channel: string;
    body: string;
    renderedBody: string;
  }>({
    url: '/notifications/preview',
    method: 'POST',
    data: payload,
  });
  return { content: raw.renderedBody ?? raw.body ?? '', channel: toChannel(raw.channel) };
}

/** 알림톡 실패 → SMS 대체 발송 시 결과가 2건이므로 배열로 반환한다. */
export async function sendNotification(
  payload: SendNotificationInput,
): Promise<{ results: NotificationRecord[] }> {
  const raw = await request<RawSendResult & { results?: RawSendResult[] }>({
    url: '/notifications/send',
    method: 'POST',
    data: {
      customerId: payload.customerId,
      templateId: payload.templateId,
      recipientPhone: payload.phone,
      variables: payload.variables,
      fallbackSms: payload.fallbackSms,
      orderId: payload.orderId,
      triggerKey: payload.triggerKey,
    },
  });
  return { results: (raw.results ?? [raw]).map(mapSendResult) };
}

export async function retryNotification(id: string): Promise<NotificationRecord> {
  const raw = await request<RawHistory>({ url: `/notifications/${id}/retry`, method: 'POST' });
  return mapHistory(raw);
}

export async function fetchCustomerNotifications(customerId: string): Promise<NotificationRecord[]> {
  const raw = await request<RawHistory[]>({ url: `/customers/${customerId}/notifications` });
  return (raw ?? []).map(mapHistory);
}

/** 트리거별 문구 매핑 (수선 상태 등 진행 단계 밖의 연락 — 개발설계서 05 G-06) */
export interface NotificationRule {
  id: string;
  triggerType: string;
  templateId: string | null;
  active: boolean;
  template?: { id: string; code: string; name: string; channel: string } | null;
}

export function fetchNotificationRules(): Promise<NotificationRule[]> {
  return request<NotificationRule[]>({ url: '/notification-rules' });
}

export function updateNotificationRule(
  id: string,
  body: { templateId?: string; active?: boolean },
): Promise<NotificationRule> {
  return request<NotificationRule>({
    url: `/notification-rules/${id}`,
    method: 'PATCH',
    data: body,
  });
}
